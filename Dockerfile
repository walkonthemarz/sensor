# Build stage
FROM rust:alpine AS builder

# Install build dependencies including sqlx-cli
RUN apk add --no-cache \
    build-base \
    musl-dev \
    postgresql-dev \
    git && \
    cargo install sqlx-cli --no-default-features --features postgres

WORKDIR /build

# Copy manifests
COPY Cargo.toml ./

# Detect architecture and set target
ARG TARGETARCH
RUN if [ -z "$TARGETARCH" ]; then \
    case "$(uname -m)" in \
    x86_64) TARGETARCH="amd64" ;; \
    aarch64) TARGETARCH="arm64" ;; \
    *) echo "Unsupported architecture: $(uname -m)" && exit 1 ;; \
    esac; \
    fi && \
    case "$TARGETARCH" in \
    "amd64") echo "x86_64-unknown-linux-musl" > /target_triple ;; \
    "arm64") echo "aarch64-unknown-linux-musl" > /target_triple ;; \
    *) echo "Unsupported architecture: $TARGETARCH" && exit 1 ;; \
    esac && \
    echo "Building for target: $(cat /target_triple)"

# Create a dummy main.rs to build dependencies
# This layer will be cached unless Cargo.toml changes
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs && \
    export TARGET=$(cat /target_triple) && \
    cargo build --release --target "$TARGET" && \
    rm -rf src

# Copy actual source code
COPY src ./src

# Build the application
# Touch main.rs to ensure it's rebuilt
RUN touch src/main.rs && \
    export TARGET=$(cat /target_triple) && \
    cargo build --release --target "$TARGET" && \
    cp "target/$TARGET/release/sensor_server" /sensor_server

# Runtime stage
FROM debian:trixie-slim

# Install curl for health checks and CA certificates for HTTPS
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN useradd -r -u 10001 -d /app appuser && \
    mkdir -p /app/data /app/certs /app/assets && \
    chown -R appuser:appuser /app

WORKDIR /app

# Copy the binary from builder
COPY --from=builder --chown=10001:10001 /sensor_server /app/sensor_server

# Copy sqlx-cli from builder
COPY --from=builder --chown=10001:10001 /usr/local/cargo/bin/sqlx /usr/local/bin/sqlx

# Copy migrations directory
COPY --chown=10001:10001 migrations /app/migrations

# Copy assets directory
COPY --chown=10001:10001 assets /app/assets

# Copy entrypoint script
COPY --chown=10001:10001 docker-entrypoint.sh /app/docker-entrypoint.sh

# Expose port (configurable via environment)
EXPOSE 3000

# Set default environment variables
ENV HOST=0.0.0.0 \
    PORT=3000

# Switch to non-root user
USER appuser

# Set entrypoint
ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Run the application
CMD ["/app/sensor_server"]
