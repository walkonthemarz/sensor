//! Web Push delivery with VAPID authentication.
//!
//! `web-push-native` does the RFC 8291 encryption and RFC 8292 signing; this
//! module only owns the configuration, endpoint validation, and the HTTP send.
//! It deliberately does not log endpoints or keys: those are bearer secrets.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64ct::{Base64UrlUnpadded, Encoding};
use reqwest::Url;
use sqlx::PgPool;
use web_push_native::{
    Auth, WebPushBuilder,
    jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair},
    p256::PublicKey,
};

use crate::alert::Alert;

/// How long the push service may hold the message while the phone is offline.
const PUSH_TTL: Duration = Duration::from_secs(60 * 60);
/// Push services must answer quickly; do not let a stuck endpoint block the
/// alert fan-out for long.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// Push endpoints are short, but cap the stored value to keep abuse cheap.
const MAX_ENDPOINT_LEN: usize = 2048;

pub(crate) struct PushConfig {
    key_pair: ES256KeyPair,
    subject: String,
    pub(crate) public_key: String,
    http: reqwest::Client,
}

impl std::fmt::Debug for PushConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PushConfig")
            .field("subject", &self.subject)
            .field("public_key", &self.public_key)
            .finish_non_exhaustive()
    }
}

impl PushConfig {
    /// Build the configuration from the environment.
    ///
    /// Returns `Ok(None)` when VAPID is not configured, so the rest of the
    /// server keeps working. A partial or invalid configuration is an error;
    /// `main` logs it and disables push rather than failing sensor ingestion.
    pub(crate) fn from_env() -> Result<Option<Self>> {
        let private = non_empty_env("VAPID_PRIVATE_KEY");
        let subject = non_empty_env("VAPID_SUBJECT");
        let configured_public = non_empty_env("VAPID_PUBLIC_KEY");

        let Some(private) = private else {
            if configured_public.is_some() {
                tracing::warn!("VAPID_PRIVATE_KEY is missing; web push alerts stay disabled");
            }
            return Ok(None);
        };

        let subject = subject.ok_or_else(|| {
            anyhow!("VAPID_SUBJECT must be set (for example mailto:you@example.com)")
        })?;
        if !(subject.starts_with("mailto:") || subject.starts_with("https://")) {
            bail!("VAPID_SUBJECT must start with mailto: or https://");
        }

        let key_bytes = Base64UrlUnpadded::decode_vec(&private)
            .context("VAPID_PRIVATE_KEY must be URL-safe base64 without padding")?;
        let key_pair = ES256KeyPair::from_bytes(&key_bytes)
            .map_err(|error| anyhow!("VAPID_PRIVATE_KEY is not a valid P-256 key: {error}"))?;

        let public_key = Base64UrlUnpadded::encode_string(
            &key_pair.public_key().public_key().to_bytes_uncompressed(),
        );

        if let Some(configured_public) = configured_public
            && configured_public != public_key
        {
            bail!("VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY");
        }

        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            // Push services do not redirect, and following one would bypass
            // the endpoint allowlist.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("could not build the push HTTP client")?;

        Ok(Some(Self {
            key_pair,
            subject,
            public_key,
            http,
        }))
    }

    async fn send(
        &self,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        payload: &[u8],
    ) -> Result<Delivery> {
        let uri: http::Uri = endpoint.parse().context("invalid push endpoint")?;
        let ua_public = decode_public_key(p256dh)?;
        let ua_auth = decode_auth(auth)?;

        let request = WebPushBuilder::new(uri, ua_public, ua_auth)
            .with_valid_duration(PUSH_TTL)
            .with_vapid(&self.key_pair, &self.subject)
            .build(payload.to_vec())
            .map_err(|error| anyhow!("could not build the push request: {error}"))?;

        let (parts, body) = request.into_parts();
        let response = self
            .http
            .request(parts.method, parts.uri.to_string())
            .headers(parts.headers)
            .body(body)
            .send()
            .await
            .context("push request failed")?;

        let status = response.status();
        if status.is_success() {
            return Ok(Delivery::Sent);
        }
        if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
            return Ok(Delivery::Gone);
        }

        let detail = response.text().await.unwrap_or_default();
        let detail: String = detail.chars().take(200).collect();
        Ok(Delivery::Failed(format!("HTTP {status}: {detail}")))
    }
}

enum Delivery {
    Sent,
    Gone,
    Failed(String),
}

#[derive(Debug, sqlx::FromRow)]
struct PushSubscriptionRow {
    id: i32,
    endpoint: String,
    p256dh: String,
    auth: String,
}

/// Send one alert to every registered device. Dead subscriptions (404/410) are
/// removed; temporary failures stay in place for the next episode.
pub(crate) async fn send_to_all(pool: &PgPool, config: &PushConfig, alert: &Alert) -> Result<()> {
    let subscriptions = sqlx::query_as::<_, PushSubscriptionRow>(
        "SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id",
    )
    .fetch_all(pool)
    .await?;

    if subscriptions.is_empty() {
        tracing::debug!("air alert triggered but no push subscriptions are registered");
        return Ok(());
    }

    let payload = serde_json::to_vec(&serde_json::json!({
        "title": alert.title,
        "body": &alert.body,
        "url": "/",
    }))?;

    let mut sent = 0usize;
    let mut failed = 0usize;
    let mut gone = Vec::new();

    for subscription in subscriptions {
        match config
            .send(
                &subscription.endpoint,
                &subscription.p256dh,
                &subscription.auth,
                &payload,
            )
            .await
        {
            Ok(Delivery::Sent) => sent += 1,
            Ok(Delivery::Gone) => gone.push(subscription.id),
            Ok(Delivery::Failed(message)) => {
                failed += 1;
                tracing::warn!(id = subscription.id, %message, "push service rejected the alert");
            }
            Err(_) => {
                failed += 1;
                // Do not log the error text: it can contain the endpoint,
                // which is a bearer capability.
                tracing::warn!(id = subscription.id, "failed to send the alert");
            }
        }
    }

    if !gone.is_empty() {
        sqlx::query("DELETE FROM push_subscriptions WHERE id = ANY($1)")
            .bind(&gone)
            .execute(pool)
            .await?;
    }

    tracing::info!(
        sent,
        failed,
        removed = gone.len(),
        "air alert push finished"
    );

    Ok(())
}

/// Accept only endpoints belonging to the well-known browser push services.
/// The endpoint is user-supplied and the server POSTs to it, so an allowlist
/// keeps this from becoming an SSRF primitive.
pub(crate) fn validate_subscription(endpoint: &str, p256dh: &str, auth: &str) -> Result<()> {
    if endpoint.is_empty() || endpoint.len() > MAX_ENDPOINT_LEN {
        bail!("invalid push endpoint");
    }

    let url = Url::parse(endpoint).context("invalid push endpoint URL")?;
    if url.scheme() != "https" {
        bail!("push endpoint must use HTTPS");
    }

    let host = url.host_str().context("push endpoint has no host")?;
    if !is_push_service(host) {
        bail!("unsupported push service");
    }

    decode_public_key(p256dh)?;
    decode_auth(auth)?;

    Ok(())
}

fn is_push_service(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "web.push.apple.com"
        || host.ends_with(".push.apple.com")
        || host == "fcm.googleapis.com"
        || host == "android.googleapis.com"
        || host == "updates.push.services.mozilla.com"
        || host == "push.services.mozilla.com"
        || host.ends_with(".notify.windows.com")
}

fn decode_public_key(encoded: &str) -> Result<PublicKey> {
    let bytes = Base64UrlUnpadded::decode_vec(encoded)
        .context("p256dh must be URL-safe base64 without padding")?;
    PublicKey::from_sec1_bytes(&bytes).map_err(|_| anyhow!("p256dh is not a valid P-256 key"))
}

fn decode_auth(encoded: &str) -> Result<Auth> {
    let bytes = Base64UrlUnpadded::decode_vec(encoded)
        .context("auth must be URL-safe base64 without padding")?;
    if bytes.len() != 16 {
        bail!("auth must decode to 16 bytes");
    }
    Ok(Auth::clone_from_slice(&bytes))
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_the_common_push_services() {
        assert!(is_push_service("web.push.apple.com"));
        assert!(is_push_service("fcm.googleapis.com"));
        assert!(is_push_service("updates.push.services.mozilla.com"));
        assert!(is_push_service("wns2-abc.notify.windows.com"));
    }

    #[test]
    fn rejects_arbitrary_hosts() {
        assert!(!is_push_service("localhost"));
        assert!(!is_push_service("127.0.0.1"));
        assert!(!is_push_service("example.com"));
        assert!(!is_push_service("notify.windows.com.evil.test"));
    }

    // Throwaway pair generated with `pnpm vapid:keys` (the Node web-push
    // generator). It pins the private-key format and the derived public key.
    const TEST_VAPID_PRIVATE: &str = "rF-T0d-dTnNc6vCPfi-o0JryZEBol3UQwepPeJX6m_M";
    const TEST_VAPID_PUBLIC: &str =
        "BNjCKJ4tTgELwAFyQ8Xvx4v0sB9atUUbiW_U4uGp8znLw3n8rgYcr-bfxDCDmOa-3fux2eFwLp930JyDB5FXiI0";

    #[test]
    fn derives_the_public_key_from_the_private_key() {
        let key_bytes = Base64UrlUnpadded::decode_vec(TEST_VAPID_PRIVATE).unwrap();
        let key_pair = ES256KeyPair::from_bytes(&key_bytes).unwrap();
        let public = Base64UrlUnpadded::encode_string(
            &key_pair.public_key().public_key().to_bytes_uncompressed(),
        );
        assert_eq!(public, TEST_VAPID_PUBLIC);
    }

    // Public test vector from the web-push-native documentation: a valid
    // uncompressed P-256 point and a 16-byte authentication secret.
    const TEST_P256DH: &str =
        "BLn9b-VR0ca83knDNZ32dCHGyjJp-1riX9ZTN40MqV8K_LpQmLqxC_DoHvqvFXO_nGdAB4W9dogZb_sM-uV4JbY";
    const TEST_AUTH: &str = "_ordMnz7uTCmrpBTeUV4Bw";

    #[test]
    fn validates_an_apple_subscription() {
        assert!(
            validate_subscription("https://web.push.apple.com/QG123", TEST_P256DH, TEST_AUTH)
                .is_ok()
        );
    }

    #[test]
    fn rejects_plain_http_and_foreign_hosts() {
        assert!(
            validate_subscription("http://web.push.apple.com/x", TEST_P256DH, TEST_AUTH).is_err()
        );
        assert!(validate_subscription("https://example.com/x", TEST_P256DH, TEST_AUTH).is_err());
    }
}
