mod alert;
mod push;

use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::IntoResponse;
use axum::{
    Router,
    extract::{Json, State},
    routing::{get, post},
};
use dotenvy::dotenv;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Postgres, postgres::PgPoolOptions};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tower::ServiceBuilder;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

/// Global budget for `GET /api/readings`: 120 requests per rolling minute.
const READ_RATE_LIMIT: f64 = 120.0;
const READ_RATE_WINDOW: Duration = Duration::from_secs(60);

/// Days of readings to keep when `RETENTION_DAYS` is unset or invalid.
const DEFAULT_RETENTION_DAYS: i32 = 7;
/// How often the retention task deletes expired readings.
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// `RETENTION_DAYS=0` disables automatic cleanup.
const RETENTION_DISABLED: i32 = 0;

#[derive(Debug, Serialize, Deserialize, FromRow)]
struct Reading {
    id: Option<i32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_timestamp",
        deserialize_with = "deserialize_timestamp"
    )]
    timestamp: Option<time::PrimitiveDateTime>,
    eco2: i16,
    ech2o: i16,
    tvoc: i16,
    pm2_5: i16,
    pm10: i16,
    temperature: f32,
    humidity: f32,
}

/// Postgres stores `timestamp` without a zone; keep the API's naive-UTC shape
/// (`2026-11-22T07:47:37.937082`) because the dashboard appends `Z` itself.
const TIMESTAMP_FORMAT: &[time::format_description::FormatItem<'static>] = time::macros::format_description!(
    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:6]"
);
const TIMESTAMP_FORMAT_SECONDS: &[time::format_description::FormatItem<'static>] =
    time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");

fn serialize_timestamp<S>(
    value: &Option<time::PrimitiveDateTime>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    use serde::ser::Error as _;

    match value {
        Some(timestamp) => serializer.serialize_str(
            &timestamp
                .format(TIMESTAMP_FORMAT)
                .map_err(S::Error::custom)?,
        ),
        None => serializer.serialize_none(),
    }
}

fn deserialize_timestamp<'de, D>(
    deserializer: D,
) -> Result<Option<time::PrimitiveDateTime>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error as _;

    let Some(raw) = Option::<String>::deserialize(deserializer)? else {
        return Ok(None);
    };

    time::PrimitiveDateTime::parse(&raw, TIMESTAMP_FORMAT)
        .or_else(|_| time::PrimitiveDateTime::parse(&raw, TIMESTAMP_FORMAT_SECONDS))
        .map(Some)
        .map_err(D::Error::custom)
}

/// Token bucket shared by every client, used to cap `GET /api/readings`.
struct RateLimiter {
    tokens: f64,
    updated: Instant,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            tokens: READ_RATE_LIMIT,
            updated: Instant::now(),
        }
    }

    /// Consume one token, or return how many seconds until one is available.
    fn check(&mut self) -> Result<(), u64> {
        let now = Instant::now();
        let elapsed = now.duration_since(self.updated).as_secs_f64();
        self.updated = now;

        let rate_per_sec = READ_RATE_LIMIT / READ_RATE_WINDOW.as_secs_f64();
        self.tokens = (self.tokens + elapsed * rate_per_sec).min(READ_RATE_LIMIT);

        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Ok(())
        } else {
            let wait = (1.0 - self.tokens) / rate_per_sec;
            Err(wait.ceil() as u64)
        }
    }
}

#[derive(Clone)]
struct AppState {
    pool: Pool<Postgres>,
    read_limiter: Arc<Mutex<RateLimiter>>,
    push: Option<Arc<push::PushConfig>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv().ok(); // Load .env file
    tracing_subscriber::fmt::init();

    // Database setup
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    let push = match push::PushConfig::from_env() {
        Ok(Some(config)) => {
            tracing::info!("web push air alerts enabled");
            Some(Arc::new(config))
        }
        Ok(None) => {
            tracing::info!(
                "web push air alerts disabled; set VAPID_PRIVATE_KEY and VAPID_SUBJECT to enable"
            );
            None
        }
        Err(error) => {
            tracing::error!(%error, "web push air alerts disabled");
            None
        }
    };

    let state = AppState {
        pool,
        read_limiter: Arc::new(Mutex::new(RateLimiter::new())),
        push,
    };

    // Prune expired readings in the background so the table has a fixed
    // ceiling. The task is idempotent, so running more than one server is safe.
    let retention_raw = std::env::var("RETENTION_DAYS").ok();
    let retention_days = parse_retention_days(retention_raw.as_deref());
    if retention_days > RETENTION_DISABLED {
        tracing::info!(retention_days, "pruning readings past the retention window");
        let cleanup_pool = state.pool.clone();
        tokio::spawn(run_retention_task(cleanup_pool, retention_days));
    } else {
        tracing::info!("RETENTION_DAYS=0; automatic reading cleanup is disabled");
    }

    // Static assets are revalidated on every load so a stale dashboard script
    // can never outlive a deploy.
    let assets = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .service(ServeDir::new("assets"));

    // Router
    let app = Router::new()
        .route("/api/readings", post(add_reading).get(get_readings))
        .route("/api/push/key", get(push_key))
        .route(
            "/api/push/subscribe",
            post(subscribe_push).delete(unsubscribe_push),
        )
        .nest_service("/", assets)
        .with_state(state);

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr_str = format!("{}:{}", host, port);
    let addr: SocketAddr = addr_str.parse().expect("Invalid address format");

    println!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Parse `RETENTION_DAYS`, falling back to the default for missing or invalid
/// values. Zero is valid and disables cleanup.
fn parse_retention_days(raw: Option<&str>) -> i32 {
    match raw.map(str::trim) {
        None | Some("") => DEFAULT_RETENTION_DAYS,
        Some(value) => match value.parse::<i32>() {
            Ok(days) if days >= RETENTION_DISABLED => days,
            _ => {
                tracing::warn!(
                    value,
                    default = DEFAULT_RETENTION_DAYS,
                    "invalid RETENTION_DAYS; using the default"
                );
                DEFAULT_RETENTION_DAYS
            }
        },
    }
}

/// Delete readings older than the retention window and report how many rows
/// were removed.
async fn prune_old_readings(
    pool: &Pool<Postgres>,
    retention_days: i32,
) -> Result<u64, sqlx::Error> {
    // The column is naive UTC, so compare against UTC wall-clock time rather
    // than `now()` (which is timestamptz and depends on the session timezone).
    let result = sqlx::query(
        r#"
        DELETE FROM readings
        WHERE timestamp < (now() AT TIME ZONE 'UTC') - make_interval(days => $1)
        "#,
    )
    .bind(retention_days)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

/// Run the retention delete once on startup, then hourly.
async fn run_retention_task(pool: Pool<Postgres>, retention_days: i32) {
    loop {
        match prune_old_readings(&pool, retention_days).await {
            Ok(0) => tracing::debug!(retention_days, "no readings past the retention window"),
            Ok(deleted) => tracing::info!(deleted, retention_days, "pruned old readings"),
            Err(error) => tracing::error!(%error, "failed to prune old readings"),
        }

        tokio::time::sleep(CLEANUP_INTERVAL).await;
    }
}

async fn add_reading(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Reading>,
) -> impl IntoResponse {
    // Validate API key
    let expected = std::env::var("SENSOR_API_KEY").unwrap_or_default();
    if expected.is_empty() {
        eprintln!("SENSOR_API_KEY is not set on the server");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "status": "error", "message": "server misconfigured" })),
        );
    }

    let provided = headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if provided != expected {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "status": "error", "message": "unauthorized" })),
        );
    }

    let result = sqlx::query(
        r#"
        INSERT INTO readings (eco2, ech2o, tvoc, pm2_5, pm10, temperature, humidity)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(payload.eco2)
    .bind(payload.ech2o)
    .bind(payload.tvoc)
    .bind(payload.pm2_5)
    .bind(payload.pm10)
    .bind(payload.temperature)
    .bind(payload.humidity)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            // Evaluate the alert state off the request path so the sensor
            // client gets its acknowledgement without waiting on Apple.
            if let Some(push) = state.push.clone() {
                let pool = state.pool.clone();
                let reading = payload;
                tokio::spawn(async move {
                    match alert::evaluate_and_store(&pool, &reading).await {
                        Ok(Some(alert)) => {
                            if let Err(error) = push::send_to_all(&pool, &push, &alert).await {
                                tracing::error!(%error, "failed to deliver an air alert");
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tracing::error!(%error, "failed to evaluate the air alert state");
                        }
                    }
                });
            }

            (
                StatusCode::OK,
                Json(serde_json::json!({ "status": "success" })),
            )
        }
        Err(e) => {
            eprintln!("Database error: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "status": "error", "message": e.to_string() })),
            )
        }
    }
}

#[derive(Debug, Deserialize)]
struct PushSubscriptionBody {
    endpoint: String,
    keys: PushSubscriptionKeys,
}

#[derive(Debug, Deserialize)]
struct PushSubscriptionKeys {
    p256dh: String,
    auth: String,
}

#[derive(Debug, Deserialize)]
struct UnsubscribeBody {
    endpoint: String,
}

/// The browser needs the public half of the VAPID key to subscribe.
async fn push_key(State(state): State<AppState>) -> impl IntoResponse {
    match state.push.as_ref() {
        Some(push) => (
            StatusCode::OK,
            Json(serde_json::json!({ "publicKey": push.public_key })),
        )
            .into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "status": "error",
                "message": "push notifications are not configured"
            })),
        )
            .into_response(),
    }
}

async fn subscribe_push(
    State(state): State<AppState>,
    Json(body): Json<PushSubscriptionBody>,
) -> impl IntoResponse {
    if state.push.is_none() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "status": "error",
                "message": "push notifications are not configured"
            })),
        )
            .into_response();
    }

    if let Err(error) =
        push::validate_subscription(&body.endpoint, &body.keys.p256dh, &body.keys.auth)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "status": "error",
                "message": error.to_string()
            })),
        )
            .into_response();
    }

    let result = sqlx::query(
        r#"
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, last_seen_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (endpoint) DO UPDATE
        SET p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            last_seen_at = now()
        "#,
    )
    .bind(&body.endpoint)
    .bind(&body.keys.p256dh)
    .bind(&body.keys.auth)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "subscribed" })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to store a push subscription");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "status": "error",
                    "message": "could not store the subscription"
                })),
            )
                .into_response()
        }
    }
}

async fn unsubscribe_push(
    State(state): State<AppState>,
    Json(body): Json<UnsubscribeBody>,
) -> impl IntoResponse {
    if body.endpoint.is_empty() || body.endpoint.len() > 2048 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "status": "error",
                "message": "invalid push endpoint"
            })),
        )
            .into_response();
    }

    match sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1")
        .bind(&body.endpoint)
        .execute(&state.pool)
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "unsubscribed" })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to delete a push subscription");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "status": "error",
                    "message": "could not remove the subscription"
                })),
            )
                .into_response()
        }
    }
}

async fn get_readings(State(state): State<AppState>) -> impl IntoResponse {
    let limit = {
        let mut limiter = state
            .read_limiter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        limiter.check()
    };

    if let Err(retry_after) = limit {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, retry_after.to_string())],
            Json(serde_json::json!({
                "status": "error",
                "message": "rate limit exceeded, try again shortly"
            })),
        )
            .into_response();
    }

    let readings =
        sqlx::query_as::<_, Reading>("SELECT * FROM readings ORDER BY id DESC LIMIT 100")
            .fetch_all(&state.pool)
            .await
            .unwrap_or_else(|e| {
                eprintln!("Error fetching readings: {:?}", e);
                vec![]
            });

    Json(readings).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_days_defaults_and_rejects_invalid_values() {
        assert_eq!(parse_retention_days(None), DEFAULT_RETENTION_DAYS);
        assert_eq!(parse_retention_days(Some("")), DEFAULT_RETENTION_DAYS);
        assert_eq!(parse_retention_days(Some(" 14 ")), 14);
        assert_eq!(parse_retention_days(Some("0")), RETENTION_DISABLED);
        assert_eq!(parse_retention_days(Some("-1")), DEFAULT_RETENTION_DAYS);
        assert_eq!(parse_retention_days(Some("seven")), DEFAULT_RETENTION_DAYS);
    }

    #[test]
    fn read_rate_limiter_allows_burst_then_rejects() {
        let mut limiter = RateLimiter::new();

        for _ in 0..READ_RATE_LIMIT as u32 {
            assert!(limiter.check().is_ok());
        }

        let retry_after = limiter
            .check()
            .expect_err("the request after the burst should be limited");
        assert!(
            retry_after >= 1,
            "Retry-After should be at least one second"
        );
    }

    #[test]
    fn timestamp_serializes_as_naive_utc() {
        let reading = Reading {
            id: Some(1),
            timestamp: Some(time::macros::datetime!(2026-11-22 07:47:37.937082)),
            eco2: 400,
            ech2o: 10,
            tvoc: 50,
            pm2_5: 5,
            pm10: 5,
            temperature: 22.0,
            humidity: 45.0,
        };

        let json = serde_json::to_string(&reading).expect("the reading should serialize");
        assert!(
            json.contains(r#""timestamp":"2026-11-22T07:47:37.937082""#),
            "unexpected timestamp format: {json}"
        );

        let decoded: Reading = serde_json::from_str(&json).expect("the reading should deserialize");
        assert_eq!(decoded.timestamp, reading.timestamp);
    }

    #[test]
    fn reading_accepts_the_client_payload_without_a_timestamp() {
        let json = r#"{"eco2":400,"ech2o":10,"tvoc":50,"pm2_5":5,"pm10":5,"temperature":22.0,"humidity":45.0}"#;
        let reading: Reading = serde_json::from_str(json).expect("the client payload should parse");
        assert!(reading.timestamp.is_none());
        assert_eq!(reading.eco2, 400);
    }
}
