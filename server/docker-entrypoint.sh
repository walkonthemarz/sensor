#!/bin/sh
set -e

echo "Running database migrations..."
sqlx migrate run

echo "Starting sensor server..."
exec "$@"
