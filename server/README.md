# Sensor Server

A Rust-based web server built with [Axum](https://github.com/tokio-rs/axum) for collecting and serving environmental sensor data.

## Features

-   **Data Collection**: Accepts sensor readings (CO2, Temperature, Humidity, PM2.5, etc.) via a REST API.
-   **Data Storage**: Persists data in a PostgreSQL database.
-   **API Access**: Provides endpoints to retrieve recent sensor readings.
-   **Static File Serving**: Serves a frontend dashboard from the `assets` directory.
-   **Security**: Supports HTTPS (TLS) and API Key authentication for data ingestion.

## Configuration

The server is configured via environment variables. You can set these in a `.env` file in the project root.

| Variable | Description | Default |
| :--- | :--- | :--- |
| `HOST` | The interface to bind to | `127.0.0.1` |
| `PORT` | The port to listen on | `3000` |
| `SENSOR_API_KEY` | **Required** for `POST` requests. The shared secret with the client. | *None* |
| `DATABASE_URL` | PostgreSQL connection string | *None* |
| `POSTGRES_USER` | PostgreSQL username (Docker only) | `sensor_user` |
| `POSTGRES_PASSWORD` | PostgreSQL password (Docker only) | *None* |
| `POSTGRES_DB` | PostgreSQL database name (Docker only) | `sensor_data` |

## API Endpoints

### `POST /api/readings`

Submit a new sensor reading.

**Headers:**
-   `Content-Type: application/json`
-   `x-api-key: <YOUR_SENSOR_API_KEY>`

**Body:**
```json
{
  "eco2": 400,
  "ech2o": 10,
  "tvoc": 50,
  "pm2_5": 12,
  "pm10": 15,
  "temperature": 25.5,
  "humidity": 60.0
}
```

### `GET /api/readings`

Retrieve the latest 100 readings.

**Response:**
```json
[
  {
    "id": 1,
    "timestamp": "2023-10-27T10:00:00",
    "eco2": 400,
    ...
  }
]
```

## Database Migrations

This project uses [sqlx-cli](https://github.com/launchbadge/sqlx/tree/main/sqlx-cli) for database migration management.

### Running Migrations

**Local Development:**
```bash
# Ensure DATABASE_URL is set in your .env file
sqlx migrate run
```

**Docker:**
Migrations run automatically when the container starts.

### Creating New Migrations

```bash
# Create a new migration file
sqlx migrate add <migration_name>

# Example:
sqlx migrate add add_location_column
```

### Reverting Migrations

```bash
# Revert the last migration
sqlx migrate revert
```

## Running the Server

### Prerequisites
-   Rust (latest stable)
-   PostgreSQL (for local development)
-   sqlx-cli: `cargo install sqlx-cli --no-default-features --features postgres`

### Development
```bash
# Run locally
cargo run
```

### Production
Build the release binary:
```bash
cargo build --release
./target/release/sensor_server
```

## Deployment

`docker-compose.yml` runs PostgreSQL, the API, and Caddy as a local reverse proxy.
Public HTTPS is terminated at the Cloudflare edge by the `sensor.boxcube.xyz`
tunnel, which forwards to Caddy on `127.0.0.1:8080`. No inbound application
ports need to be exposed.

The full runbook is in [DEPLOYMENT.md](DEPLOYMENT.md).

## TODO

- [ ] Add unit tests
- [x] Add docker health checks
- [x] Add reverse proxy (Caddy + Cloudflare Tunnel)
- [x] Migrate to Postgres
- [x] Build the live dashboard
- [ ] Add authentication for UI
- [ ] Migrate to K8S
- [ ] Use Terraform/OpenTofu for infrastructure
- [ ] Add alerting/monitoring for CO2 threshold
- [ ] Add MD doc linting
- [ ] Add renovate to upgrade dependencies weekly