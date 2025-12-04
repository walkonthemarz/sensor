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
| `SENSOR_API_KEY` | **Required** for `POST` requests. The secret key for authentication. | *None* |
| `DOMAIN` | Domain for Traefik routing | `sensor.localhost` |
| `ACME_EMAIL` | Email for Let's Encrypt certificate notifications | *None* |
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

## HTTPS Support

HTTPS is handled by the Traefik reverse proxy using Let's Encrypt for automatic certificate management.

### Configuration

1. Set `ACME_EMAIL` in your `.env` file to receive certificate expiration notifications.
2. Set `DOMAIN` to your actual domain (e.g., `sensor.yourdomain.com`).
3. Ensure ports 80 and 443 are accessible from the internet for Let's Encrypt validation.
4. Certificates are automatically obtained and renewed by Traefik.

The server itself listens on HTTP only. Traefik handles TLS termination.

## TODO

- [ ] Add unit tests
- [x] Add docker health checks
- [x] Add traefik reverse proxy
- [x] Migrate to Postgres
- [ ] Optimize UI for chart
- [ ] Add authentication for UI
- [ ] Migrate to K8S
- [ ] Use Terraform/OpenTofu for infrastructure
- [ ] Add alerting/monitoring for CO2 threshold
- [ ] Add MD doc linting
- [ ] Add renovate to upgrade dependencies weekly