//! Poor-air detection and the hysteresis used to turn a stream of readings into
//! at most one push notification per episode.
//!
//! The thresholds mirror the "bad" bands in `assets/script.js`:

use sqlx::{FromRow, PgPool};
use time::OffsetDateTime;

use crate::Reading;

/// Air has to stay bad for this long before a notification is sent.
const BAD_CONFIRM_SECS: i64 = 30;
/// Air has to stay good for this long before the episode is considered over.
const CLEAR_CONFIRM_SECS: i64 = 120;
/// Minimum time between notifications, so a flapping sensor cannot spam.
const COOLDOWN_SECS: i64 = 60 * 60;

const ALERT_TITLE: &str = "Air needs attention";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AlertLevel {
    Clear,
    Bad,
}

impl AlertLevel {
    fn as_str(self) -> &'static str {
        match self {
            AlertLevel::Clear => "clear",
            AlertLevel::Bad => "bad",
        }
    }

    fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw {
            "clear" => Ok(AlertLevel::Clear),
            "bad" => Ok(AlertLevel::Bad),
            other => anyhow::bail!("unknown alert level {other:?}"),
        }
    }
}

#[derive(Debug, Clone)]
struct AlertState {
    level: AlertLevel,
    bad_since: Option<OffsetDateTime>,
    clear_since: Option<OffsetDateTime>,
    last_notified_at: Option<OffsetDateTime>,
}

impl Default for AlertState {
    fn default() -> Self {
        Self {
            level: AlertLevel::Clear,
            bad_since: None,
            clear_since: None,
            last_notified_at: None,
        }
    }
}

/// The notification body is built from the channels that crossed their bad
/// threshold. `threshold` is used only to pick the worst channel for the advice.
#[derive(Debug, Clone)]
struct BadMetric {
    label: &'static str,
    value: i32,
    unit: &'static str,
    threshold: i32,
    advice: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Alert {
    pub(crate) title: &'static str,
    pub(crate) body: String,
}

#[derive(Debug, FromRow)]
struct AlertStateRow {
    level: String,
    bad_since: Option<OffsetDateTime>,
    clear_since: Option<OffsetDateTime>,
    last_notified_at: Option<OffsetDateTime>,
}

/// Evaluate a reading and persist the updated state in one transaction.
///
/// The row lock makes the decision safe if several server instances share the
/// database, and keeps concurrent readings from sending duplicate alerts.
pub(crate) async fn evaluate_and_store(
    pool: &PgPool,
    reading: &Reading,
) -> anyhow::Result<Option<Alert>> {
    // Do not advance the episode while nobody is listening. Otherwise a phone
    // enabled during a bad episode would wait for the next one.
    let has_subscriptions: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM push_subscriptions)")
            .fetch_one(pool)
            .await?;
    if !has_subscriptions {
        return Ok(None);
    }

    let mut tx = pool.begin().await?;

    let row = sqlx::query_as::<_, AlertStateRow>(
        r#"
        SELECT level, bad_since, clear_since, last_notified_at
        FROM alert_state
        WHERE id = 1
        FOR UPDATE
        "#,
    )
    .fetch_one(&mut *tx)
    .await?;

    let mut state = AlertState {
        level: AlertLevel::parse(&row.level)?,
        bad_since: row.bad_since,
        clear_since: row.clear_since,
        last_notified_at: row.last_notified_at,
    };

    let now = OffsetDateTime::now_utc();
    let alert = evaluate(reading, &mut state, now);

    sqlx::query(
        r#"
        UPDATE alert_state
        SET level = $1,
            bad_since = $2,
            clear_since = $3,
            last_notified_at = $4,
            updated_at = $5
        WHERE id = 1
        "#,
    )
    .bind(state.level.as_str())
    .bind(state.bad_since)
    .bind(state.clear_since)
    .bind(state.last_notified_at)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(alert)
}

/// Mutate the state with one reading and return an alert when this reading is
/// the one that confirms a new bad episode.
fn evaluate(reading: &Reading, state: &mut AlertState, now: OffsetDateTime) -> Option<Alert> {
    let bad = bad_metrics(reading);

    if !bad.is_empty() {
        state.clear_since = None;

        if state.level == AlertLevel::Bad {
            return None;
        }

        let bad_since = *state.bad_since.get_or_insert(now);
        let confirmed = (now - bad_since).whole_seconds() >= BAD_CONFIRM_SECS;
        let cooled = state
            .last_notified_at
            .is_none_or(|last| (now - last).whole_seconds() >= COOLDOWN_SECS);

        if confirmed && cooled {
            state.level = AlertLevel::Bad;
            state.bad_since = None;
            state.last_notified_at = Some(now);
            return Some(build_alert(&bad));
        }

        return None;
    }

    if state.level == AlertLevel::Bad {
        let clear_since = *state.clear_since.get_or_insert(now);
        if (now - clear_since).whole_seconds() >= CLEAR_CONFIRM_SECS {
            state.level = AlertLevel::Clear;
            state.bad_since = None;
            state.clear_since = None;
        }
    } else {
        state.bad_since = None;
        state.clear_since = None;
    }

    None
}

fn bad_metrics(reading: &Reading) -> Vec<BadMetric> {
    let candidates = [
        (
            "CO₂",
            reading.eco2 as i32,
            "ppm",
            1200,
            " Open a window or check ventilation.",
        ),
        (
            "PM2.5",
            reading.pm2_5 as i32,
            "µg/m³",
            35,
            " Ventilate or filter the air.",
        ),
        (
            "PM10",
            reading.pm10 as i32,
            "µg/m³",
            100,
            " Ventilate or filter the air.",
        ),
        (
            "TVOC",
            reading.tvoc as i32,
            "µg/m³",
            600,
            " Ventilate and check for sources.",
        ),
        (
            "HCHO",
            reading.ech2o as i32,
            "µg/m³",
            150,
            " Ventilate and check for new materials or finishes.",
        ),
    ];

    candidates
        .into_iter()
        .filter(|(_, value, _, threshold, _)| value >= threshold)
        .map(|(label, value, unit, threshold, advice)| BadMetric {
            label,
            value,
            unit,
            threshold,
            advice,
        })
        .collect()
}

fn build_alert(bad: &[BadMetric]) -> Alert {
    let summary = bad
        .iter()
        .map(|metric| {
            format!(
                "{} {} {}",
                metric.label,
                format_number(metric.value),
                metric.unit
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    let worst = bad
        .iter()
        .max_by(|a, b| {
            let a_ratio = a.value as f64 / a.threshold as f64;
            let b_ratio = b.value as f64 / b.threshold as f64;
            a_ratio
                .partial_cmp(&b_ratio)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .expect("build_alert is only called with at least one bad metric");

    Alert {
        title: ALERT_TITLE,
        body: format!("{summary}.{}", worst.advice),
    }
}

/// Thousands separators, matching how the dashboard shows larger values.
fn format_number(value: i32) -> String {
    let value = value as i64;
    let digits = value.abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);

    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }

    if value < 0 {
        out.insert(0, '-');
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Duration;

    fn reading(eco2: i16) -> Reading {
        Reading {
            id: None,
            timestamp: None,
            eco2,
            ech2o: 10,
            tvoc: 50,
            pm2_5: 5,
            pm10: 5,
            temperature: 22.0,
            humidity: 45.0,
        }
    }

    #[test]
    fn thresholds_match_the_dashboard_bad_bands() {
        assert!(bad_metrics(&reading(1199)).is_empty());

        let co2 = bad_metrics(&reading(1200));
        assert_eq!(co2.len(), 1);
        assert_eq!(co2[0].label, "CO₂");

        let mut all = reading(1200);
        all.pm2_5 = 35;
        all.pm10 = 100;
        all.tvoc = 600;
        all.ech2o = 150;

        let labels: Vec<_> = bad_metrics(&all).into_iter().map(|m| m.label).collect();
        assert_eq!(labels, ["CO₂", "PM2.5", "PM10", "TVOC", "HCHO"]);
    }

    #[test]
    fn notification_waits_for_confirmation_and_sends_once() {
        let mut state = AlertState::default();
        let start = OffsetDateTime::now_utc();
        let poor = reading(1340);

        assert!(evaluate(&poor, &mut state, start).is_none());
        assert!(
            evaluate(&poor, &mut state, start + Duration::seconds(29)).is_none(),
            "a short spike must not notify"
        );

        let alert = evaluate(&poor, &mut state, start + Duration::seconds(30))
            .expect("sustained poor air should notify");
        assert_eq!(alert.title, ALERT_TITLE);
        assert_eq!(
            alert.body,
            "CO₂ 1,340 ppm. Open a window or check ventilation."
        );

        assert!(
            evaluate(&poor, &mut state, start + Duration::seconds(120)).is_none(),
            "the same episode must not notify again"
        );
    }

    #[test]
    fn clear_state_needs_a_sustained_recovery() {
        let mut state = AlertState::default();
        let start = OffsetDateTime::now_utc();
        let poor = reading(1400);
        let good = reading(600);

        evaluate(&poor, &mut state, start);
        assert!(evaluate(&poor, &mut state, start + Duration::seconds(30)).is_some());

        assert!(evaluate(&good, &mut state, start + Duration::seconds(60)).is_none());
        assert_eq!(state.level, AlertLevel::Bad);

        assert!(
            evaluate(&good, &mut state, start + Duration::seconds(179)).is_none(),
            "a short recovery must not end the episode"
        );
        assert_eq!(state.level, AlertLevel::Bad);

        assert!(evaluate(&good, &mut state, start + Duration::seconds(180)).is_none());
        assert_eq!(state.level, AlertLevel::Clear);
    }

    #[test]
    fn cooldown_suppresses_a_new_episode() {
        let mut state = AlertState::default();
        let start = OffsetDateTime::now_utc();
        let poor = reading(1500);
        let good = reading(500);

        evaluate(&poor, &mut state, start);
        assert!(evaluate(&poor, &mut state, start + Duration::seconds(30)).is_some());

        // Recover, then go bad again ten minutes later.
        let recovered = start + Duration::seconds(180);
        evaluate(&good, &mut state, recovered);
        evaluate(&good, &mut state, recovered + Duration::seconds(120));
        assert_eq!(state.level, AlertLevel::Clear);

        let second = recovered + Duration::seconds(600);
        assert!(evaluate(&poor, &mut state, second).is_none());
        assert!(
            evaluate(&poor, &mut state, second + Duration::seconds(30)).is_none(),
            "a second episode inside the cooldown must stay quiet"
        );

        let after_cooldown = start + Duration::seconds(30 + COOLDOWN_SECS + 1);
        assert!(
            evaluate(&poor, &mut state, after_cooldown).is_some(),
            "the episode should notify once the cooldown expires"
        );
    }

    #[test]
    fn numbers_are_grouped() {
        assert_eq!(format_number(0), "0");
        assert_eq!(format_number(999), "999");
        assert_eq!(format_number(1000), "1,000");
        assert_eq!(format_number(1340), "1,340");
        assert_eq!(format_number(1234567), "1,234,567");
    }
}
