#!/usr/bin/env bash
set -euo pipefail

# Live OTLP smoke for @mmstack/telemetry-otel.
#
# Boots grafana/otel-lgtm (OTLP collector + Tempo + Loki + Mimir + Grafana in one
# container), runs the OTLP_E2E-guarded spec against it, and tears the stack down.
#
#   bash scripts/telemetry-otlp-smoke.sh          # run + teardown
#   KEEP=1 bash scripts/telemetry-otlp-smoke.sh   # leave the stack up to browse
#                                                 # Grafana at http://localhost:3000
#
# The playground app (nx serve playground -> /telemetry) exports to the same
# endpoint, so KEEP=1 also serves as the manual close-the-loop environment.

NAME=mmstack-otel-lgtm

if ! docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then
  echo "starting ${NAME} (grafana/otel-lgtm)..."
  docker run -d --rm --name "$NAME" \
    -p 3000:3000 -p 4317:4317 -p 4318:4318 \
    grafana/otel-lgtm >/dev/null
fi

echo -n "waiting for OTLP readiness"
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' \
    http://localhost:4318/v1/traces; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 1
done

OTLP_E2E=1 npx nx test telemetry-otel --skip-nx-cache

if [ "${KEEP:-0}" = "1" ]; then
  echo "stack left running: Grafana http://localhost:3000 | OTLP http://localhost:4318"
  echo "stop it with: docker stop ${NAME}"
else
  docker stop "$NAME" >/dev/null
  echo "stack stopped"
fi
