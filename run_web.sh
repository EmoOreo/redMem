#!/usr/bin/env bash
set -e

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"

echo "Starting Reddit Memory Web Server on http://${HOST}:${PORT}..."
exec uvicorn web.app:app --host "${HOST}" --port "${PORT}"
