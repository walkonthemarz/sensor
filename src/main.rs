use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{
    Router,
    extract::{Json, State},
    routing::post,
};
use axum_server::tls_rustls::RustlsConfig;
use dotenvy::dotenv;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Sqlite, sqlite::SqlitePoolOptions};
use std::net::SocketAddr;
use std::path::PathBuf;
use tower_http::services::ServeDir;

#[derive(Debug, Serialize, Deserialize, FromRow)]
struct Reading {
    id: Option<i64>,
    timestamp: Option<String>, // ISO8601 string
    eco2: u16,
    ech2o: u16,
    tvoc: u16,
    pm2_5: u16,
    pm10: u16,
    temperature: f32,
    humidity: f32,
}

#[derive(Clone)]
struct AppState {
    pool: Pool<Sqlite>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv().ok(); // Load .env file
    tracing_subscriber::fmt::init();

    // Database setup
    let database_url = "sqlite:sensor_data.db";

    // Create database file if it doesn't exist
    if !std::path::Path::new("sensor_data.db").exists() {
        std::fs::File::create("sensor_data.db")?;
    }

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await?;

    // Create table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            eco2 INTEGER,
            ech2o INTEGER,
            tvoc INTEGER,
            pm2_5 INTEGER,
            pm10 INTEGER,
            temperature REAL,
            humidity REAL
        )
        "#,
    )
    .execute(&pool)
    .await?;

    let state = AppState { pool };

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

    // Check for certificates
    let cert_path = std::env::var("SSL_CERT_PATH").unwrap_or_else(|_| "cert.pem".to_string());
    let key_path = std::env::var("SSL_KEY_PATH").unwrap_or_else(|_| "key.pem".to_string());

    if std::path::Path::new(&cert_path).exists() && std::path::Path::new(&key_path).exists() {
        println!(
            "SSL certificates found at {} and {}. Starting in HTTPS mode.",
            cert_path, key_path
        );
        let config =
            RustlsConfig::from_pem_file(PathBuf::from(cert_path), PathBuf::from(key_path)).await?;

        axum_server::bind_rustls(addr, config)
            .serve(app.into_make_service())
            .await?;
    } else {
        println!("SSL certificates not found. Starting in HTTP mode.");
        let listener = tokio::net::TcpListener::bind(addr).await?;
        axum::serve(listener, app).await?;
    }

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
        VALUES (?, ?, ?, ?, ?, ?, ?)
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

async fn get_readings(State(state): State<AppState>) -> Json<Vec<Reading>> {
    let readings =
        sqlx::query_as::<_, Reading>("SELECT * FROM readings ORDER BY id DESC LIMIT 100")
            .fetch_all(&state.pool)
            .await
            .unwrap_or_else(|_| vec![]);

    Json(readings)
}
