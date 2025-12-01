# Sensor Server

A Rust-based web server built with [Axum](https://github.com/tokio-rs/axum) for collecting and serving environmental sensor data.

## Features

-   **Data Collection**: Accepts sensor readings (CO2, Temperature, Humidity, PM2.5, etc.) via a REST API.
-   **Data Storage**: Persists data in a SQLite database (`sensor_data.db`).
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
| `SSL_CERT_PATH` | Path to the SSL certificate file | `cert.pem` |
| `SSL_KEY_PATH` | Path to the SSL private key file | `key.pem` |

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

## Running the Server

### Prerequisites
-   Rust (latest stable)
-   OpenSSL (for `axum-server` with TLS)

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

To enable HTTPS, place your `cert.pem` and `key.pem` files in the project root (or specify their paths via environment variables). If certificates are found, the server will automatically start in HTTPS mode. Otherwise, it defaults to HTTP.

## TODO

- [ ] Add unit tests
- [ ] Add docker health checks
- [ ] Add taefik reverse proxy
- [ ] Optimize UI for chart
- [ ] Add authentication for UI
- [ ] Migrate to Postgres
- [ ] Migrate to K8S
- [ ] Use Terraform/OpenTofu for infrastructure
- [ ] Add alerting/monitoring for CO2 threshold
- [ ] Add MD doc linting