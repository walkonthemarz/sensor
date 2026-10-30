use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::http::header;
use axum::response::IntoResponse;
use axum::{
    Router,
    extract::{Json, State},
    routing::post,
};
use dotenvy::dotenv;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Postgres, postgres::PgPoolOptions};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tower_http::services::ServeDir;

/// Global budget for `GET /api/readings`: 120 requests per rolling minute.
const READ_RATE_LIMIT: f64 = 120.0;
const READ_RATE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, Deserialize, FromRow)]
struct Reading {
    id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<chrono::NaiveDateTime>,
    eco2: i16,
    ech2o: i16,
    tvoc: i16,
    pm2_5: i16,
    pm10: i16,
    temperature: f32,
    humidity: f32,
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

    let state = AppState {
        pool,
        read_limiter: Arc::new(Mutex::new(RateLimiter::new())),
    };

    // Router
    let app = Router::new()
        .route("/api/readings", post(add_reading).get(get_readings))
        .nest_service("/", ServeDir::new("assets"))
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
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "success" })),
        ),
        Err(e) => {
            eprintln!("Database error: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "status": "error", "message": e.to_string() })),
            )
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
    fn read_rate_limiter_allows_burst_then_rejects() {
        let mut limiter = RateLimiter::new();

        for _ in 0..READ_RATE_LIMIT as u32 {
            assert!(limiter.check().is_ok());
        }

        let retry_after = limiter
            .check()
            .expect_err("the request after the burst should be limited");
        assert!(retry_after >= 1, "Retry-After should be at least one second");
    }
}
