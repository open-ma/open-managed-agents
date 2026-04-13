#!/bin/sh
set -euo pipefail

# Wait for dockerd to be ready
tries=0
until docker version >/dev/null 2>&1; do
  tries=$((tries+1))
  if [ "$tries" -gt 50 ]; then
    echo "dockerd did not become ready in time" >&2
    exit 1
  fi
  sleep 0.2
done

echo "Docker daemon ready"
exec node /opt/builder/server.js
