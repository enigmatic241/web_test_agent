#!/usr/bin/env bash
# =============================================================================
# scripts/docker-up.sh
# Starts the Docker stack (TimescaleDB + Grafana), waits for the DB to be
# healthy, then optionally runs any npm command passed as arguments.
#
# Usage:
#   ./scripts/docker-up.sh                     # just start Docker services
#   ./scripts/docker-up.sh npm run smoke       # start + run smoke/unit tests
#   ./scripts/docker-up.sh npm run test:perf   # start + run full perf suite
#   ./scripts/docker-up.sh npm run e2e         # start + run full e2e suite
# =============================================================================
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${CYAN}[docker-up]${NC} $*"; }
ok()   { echo -e "${GREEN}[docker-up] ✔${NC} $*"; }
warn() { echo -e "${YELLOW}[docker-up] ⚠${NC}  $*"; }
err()  { echo -e "${RED}[docker-up] ✘${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Copy .env.docker → .env if no .env exists yet ────────────────────────────
ENV_FILE="$ROOT_DIR/.env"
ENV_DOCKER="$ROOT_DIR/.env.docker"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENV_DOCKER" ]]; then
    cp "$ENV_DOCKER" "$ENV_FILE"
    warn ".env not found — copied .env.docker → .env"
    warn "Edit .env to add SLACK, JIRA, and ANTHROPIC secrets before running Phase 3."
  else
    err ".env and .env.docker both missing. Cannot proceed."
    exit 1
  fi
fi

# ── Start Docker services ─────────────────────────────────────────────────────
log "Starting Docker services (db + grafana)…"
cd "$ROOT_DIR"
docker compose up -d --remove-orphans

# ── Wait for DB healthcheck ───────────────────────────────────────────────────
log "Waiting for TimescaleDB to be healthy…"
MAX_WAIT=60
WAITED=0
until docker compose exec -T db pg_isready -U perf_user -d perf_metrics > /dev/null 2>&1; do
  if [[ $WAITED -ge $MAX_WAIT ]]; then
    err "TimescaleDB did not become ready within ${MAX_WAIT}s."
    docker compose logs db | tail -30
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done
ok "TimescaleDB is ready (waited ${WAITED}s)"

# Print connection info
echo ""
echo -e "  ${CYAN}DB URL   :${NC} postgresql://perf_user:perf_pass@localhost:5432/perf_metrics"
echo -e "  ${CYAN}Grafana  :${NC} http://localhost:3001  (admin / admin)"
echo ""

# ── Run extra command if provided ─────────────────────────────────────────────
if [[ $# -gt 0 ]]; then
  log "Running: $*"
  cd "$ROOT_DIR"
  exec "$@"
fi
