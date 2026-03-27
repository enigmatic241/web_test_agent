#!/usr/bin/env bash
# =============================================================================
# scripts/e2e.sh
# Full end-to-end runner:
#   1. Ensure Docker stack is UP and DB is healthy
#   2. Install npm deps (if node_modules is stale)
#   3. Install Playwright Chromium browser
#   4. Run TypeScript compile check
#   5. Run unit tests (Vitest)
#   6. Run the performance orchestrator
#   7. Print a nice summary table
#
# Usage:
#   ./scripts/e2e.sh                    # defaults: RUN_PHASE=1, dry-run=false
#   RUN_PHASE=2 ./scripts/e2e.sh
#   RUN_PHASE=3 ./scripts/e2e.sh --dry-run
#   RUN_PHASE=1 ./scripts/e2e.sh --page homepage
# =============================================================================
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()    { echo -e "${CYAN}[e2e]${NC} $*"; }
step()   { echo -e "\n${BOLD}${CYAN}══ $* ${NC}"; }
ok()     { echo -e "${GREEN}[e2e] ✔${NC} $*"; }
warn()   { echo -e "${YELLOW}[e2e] ⚠${NC}  $*"; }
err()    { echo -e "${RED}[e2e] ✘${NC} $*"; }
divider(){ echo -e "${CYAN}────────────────────────────────────────────────${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Parse flags forwarded to the orchestrator ─────────────────────────────────
# Guard against unbound variable when no args are passed (bash set -u)
EXTRA_ARGS=()
if [[ $# -gt 0 ]]; then
  EXTRA_ARGS=("$@")
fi
RUN_PHASE="${RUN_PHASE:-1}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 0 — Banner
# ─────────────────────────────────────────────────────────────────────────────
divider
echo -e "  ${BOLD}IndiaMart Perf Test Suite — E2E Runner${NC}"
echo -e "  Phase  : ${YELLOW}${RUN_PHASE}${NC}"
echo -e "  Flags  : ${YELLOW}${EXTRA_ARGS[*]:-none}${NC}"
echo -e "  Time   : $(date '+%Y-%m-%d %H:%M:%S %Z')"
divider

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Start / verify Docker stack
# ─────────────────────────────────────────────────────────────────────────────
step "1/5  Docker stack"
if ! docker compose ps --status running 2>/dev/null | grep -q "perf_db"; then
  log "DB container not running — starting stack…"
  bash "$SCRIPT_DIR/docker-up.sh"
else
  ok "TimescaleDB container already running"
  echo -e "  ${CYAN}DB URL   :${NC} postgresql://perf_user:perf_pass@localhost:5432/perf_metrics"
  echo -e "  ${CYAN}Grafana  :${NC} http://localhost:3001"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — npm install (only if node_modules is missing or package.json changed)
# ─────────────────────────────────────────────────────────────────────────────
step "2/5  npm install"
if [[ ! -d node_modules ]] || [[ package.json -nt node_modules ]]; then
  log "Installing npm dependencies…"
  npm ci --prefer-offline 2>&1 | tail -5
  ok "npm install done"
else
  ok "node_modules up to date — skipping install"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Playwright browsers
# ─────────────────────────────────────────────────────────────────────────────
step "3/5  Playwright browsers"
if ! npx playwright show-browser-versions 2>/dev/null | grep -q chromium; then
  log "Installing Playwright Chromium…"
  npx playwright install chromium 2>&1 | tail -5
  ok "Playwright Chromium installed"
else
  ok "Playwright Chromium already installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — TypeScript compile check + unit tests
# ─────────────────────────────────────────────────────────────────────────────
step "4/5  Smoke check (tsc + vitest)"
log "Running tsc --noEmit…"
npx tsc --noEmit && ok "TypeScript: no type errors" || { err "TypeScript errors found — fix before continuing"; exit 1; }

log "Running vitest unit tests…"
npm run test 2>&1
ok "Unit tests passed"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Performance orchestrator
# ─────────────────────────────────────────────────────────────────────────────
step "5/5  Performance orchestrator (Phase ${RUN_PHASE})"
divider
START_TS=$(date +%s)

set +e
RUN_PHASE="$RUN_PHASE" npm run test:perf -- ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
ORCH_EXIT=$?
set -e

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

divider
echo ""
if [[ $ORCH_EXIT -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ✔  E2E run completed successfully in ${ELAPSED}s${NC}"
else
  echo -e "${RED}${BOLD}  ✘  Orchestrator exited with code ${ORCH_EXIT} (${ELAPSED}s)${NC}"
fi
echo ""
echo -e "  ${CYAN}Raw reports :${NC} ./raw-reports/"
echo -e "  ${CYAN}Screenshots :${NC} ./baselines/  ./diffs/"
echo -e "  ${CYAN}Recordings  :${NC} ./recordings/"
echo -e "  ${CYAN}Grafana     :${NC} http://localhost:3001  (admin / admin)"
divider

exit $ORCH_EXIT
