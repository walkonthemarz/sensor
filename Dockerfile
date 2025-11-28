# Build stage
FROM rust:alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    build-base \
    musl-dev \
    sqlite-dev \
    sqlite-static

WORKDIR /build

# Copy manifests
COPY Cargo.toml ./

# Create a dummy main.rs to build dependencies
# This layer will be cached unless Cargo.toml changes
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs && \
    cargo build --release --target x86_64-unknown-linux-musl && \
    rm -rf src

# Copy actual source code
COPY src ./src

# Build the application
# Touch main.rs to ensure it's rebuilt
RUN touch src/main.rs && \
    cargo build --release --target x86_64-unknown-linux-musl

# Setup stage to prepare users and directories
FROM alpine:latest AS setup
RUN mkdir -p /app/data /app/certs /app/assets
# Create a non-root user
RUN adduser -D -H -h /app -u 10001 appuser
RUN chown -R appuser:appuser /app

# Runtime stage
FROM scratch

# Copy user information
COPY --from=setup /etc/passwd /etc/passwd
COPY --from=setup /etc/group /etc/group

# Copy directory structure and permissions
COPY --from=setup --chown=10001:10001 /app /app

WORKDIR /app

# Copy the binary from builder
COPY --from=builder --chown=10001:10001 /build/target/x86_64-unknown-linux-musl/release/sensor_server /app/sensor_server

# Copy assets directory
COPY --chown=10001:10001 assets /app/assets

# Expose port (configurable via environment)
EXPOSE 3000

# Set default environment variables
ENV HOST=0.0.0.0 \
    PORT=3000 \
    SSL_CERT_PATH=/app/certs/cert.pem \
    SSL_KEY_PATH=/app/certs/key.pem

# Switch to non-root user
USER appuser

# Run the application
CMD ["/app/sensor_server"]
