# Build stage
FROM rust:1.91.1-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy manifests
COPY Cargo.toml ./

# Create a dummy main.rs to build dependencies
# This layer will be cached unless Cargo.toml changes
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs && \
    cargo build --release && \
    rm -rf src

# Copy actual source code
COPY src ./src

# Build the application
# Touch main.rs to ensure it's rebuilt
RUN touch src/main.rs && \
    cargo build --release

# Runtime stage
FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN useradd -m -u 1000 appuser

WORKDIR /app

# Copy the binary from builder
COPY --from=builder /build/target/release/sensor_server /app/sensor_server

# Copy assets directory
COPY assets /app/assets

# Create directories for data and certs
RUN mkdir -p /app/data /app/certs && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose port (configurable via environment)
EXPOSE 3000

# Set default environment variables
ENV HOST=0.0.0.0 \
    PORT=3000 \
    SSL_CERT_PATH=/app/certs/cert.pem \
    SSL_KEY_PATH=/app/certs/key.pem

# Run the application
CMD ["/app/sensor_server"]
