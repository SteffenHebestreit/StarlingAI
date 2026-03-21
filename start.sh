#!/usr/bin/env bash
# ============================================================
#  StarlingAI — one-command start script
#
#  Usage:
#    ./start.sh                   # build (if needed) + start core services
#    ./start.sh --build           # force rebuild, then start
#    ./start.sh --no-cache        # force rebuild with no Docker cache
#    ./start.sh --fresh           # wipe volumes + rebuild + start (clean slate)
#    ./start.sh --pentest         # also start the kali-pentest service
#    ./start.sh --image           # also start the image-generation service
#    ./start.sh --down            # stop all services
#    ./start.sh --down --volumes  # stop all services AND wipe all data volumes
#
#  Flags can be combined:
#    ./start.sh --no-cache --pentest
#    ./start.sh --fresh --pentest --image
#
# ── Hardware note (Strix Halo / Ryzen AI Max) ──────────────────────────────────
#  LM Studio on Windows (Vulkan) uses the iGPU via AMD Variable Graphics Memory
#  and is reached by the gateway via host.docker.internal:1234. No container GPU
#  access is needed for LLM inference.
#
#  Docker ML services (ASR, TTS, image-gen) run on CPU by default because
#  /dev/kfd is absent in WSL2 (AMD KFD not exposed by the Windows hypervisor).
#  When AMD ships a fix, uncomment the /dev/dxg device lines in
#  docker-compose.strix-halo.yml — ROCm env vars are already wired in.
#
#  Recommended ~/.wslconfig:
#    [wsl2]
#    memory=88GB    # leave ~8GB for Windows
#    processors=16  # match your core count
#    swap=0
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
fail() { echo -e "${RED}✗${RESET} $*"; exit 1; }
info() { echo -e "${CYAN}ℹ${RESET} $*"; }
hdr()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── Parse flags ───────────────────────────────────────────────────────────────
BUILD=false
NO_CACHE=false
FRESH=false
PENTEST=false
IMAGE_GEN=false
DOWN=false
WIPE_VOLUMES=false

for arg in "$@"; do
  case "$arg" in
    --build)     BUILD=true ;;
    --no-cache)  BUILD=true; NO_CACHE=true ;;
    --fresh)     BUILD=true; NO_CACHE=true; WIPE_VOLUMES=true ;;
    --pentest)   PENTEST=true ;;
    --image)     IMAGE_GEN=true ;;
    --down)      DOWN=true ;;
    --volumes)   WIPE_VOLUMES=true ;;
    --help|-h)
      grep "^#  " "$0" | sed 's/^#  //'
      exit 0
      ;;
    *) warn "Unknown flag: $arg" ;;
  esac
done

# ── Compose file stack ────────────────────────────────────────────────────────
# Include Strix Halo overlay if present (adds ROCm env vars, memory settings)
COMPOSE_FILES=(-f docker-compose.yml)
[[ -f docker-compose.strix-halo.yml ]] && COMPOSE_FILES+=(-f docker-compose.strix-halo.yml)

# Build profile args
PROFILE_ARGS=()
$PENTEST   && PROFILE_ARGS+=(--profile pentest)
$IMAGE_GEN && PROFILE_ARGS+=(--profile image)

dc() { docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" "$@"; }
dc_all() { docker compose "${COMPOSE_FILES[@]}" --profile pentest --profile image "$@"; }

# ── Down mode ─────────────────────────────────────────────────────────────────
if $DOWN; then
  hdr "Stopping StarlingAI..."
  if $WIPE_VOLUMES; then
    warn "This will permanently delete all data (Postgres, Redis, workspace, model cache)."
    read -r -p "Continue? [y/N] " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }
    dc_all down -v
    ok "All containers, networks, and volumes removed."
  else
    dc_all down
    ok "All containers and networks removed. Data volumes preserved."
  fi
  exit 0
fi

hdr "🦅 StarlingAI — Starting up"

# ── Prerequisites ─────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "Docker not found. Install Docker Desktop first."
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin not found."
ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)"

# First-run: generate .env if missing
if [[ ! -f .env ]]; then
  warn ".env not found — running first-time setup..."
  if command -v node >/dev/null 2>&1; then
    node scripts/setup.mjs
  else
    fail ".env missing and Node.js unavailable. Copy .env.example → .env and fill in the required secrets."
  fi
fi

# Validate required secrets are present
set -o allexport; source .env; set +o allexport
[[ -n "${SAI_JWT_SECRET:-}"   ]] || fail "SAI_JWT_SECRET missing from .env — run: node scripts/setup.mjs"
[[ -n "${SAI_MASTER_KEY:-}"   ]] || fail "SAI_MASTER_KEY missing from .env — run: node scripts/setup.mjs"
[[ -n "${POSTGRES_PASSWORD:-}" ]] || fail "POSTGRES_PASSWORD missing from .env — run: node scripts/setup.mjs"
ok ".env secrets present"

# Config file check
[[ -f starlingai.json ]] || fail "starlingai.json not found. Copy starlingai.example.json → starlingai.json and configure it."
ok "starlingai.json present"

# LM Studio check (non-fatal — agents degrade gracefully without it)
if curl -sf --max-time 3 "http://localhost:1234/v1/models" >/dev/null 2>&1; then
  MODEL_COUNT=$(curl -sf --max-time 3 "http://localhost:1234/v1/models" | grep -c '"id"' || echo 0)
  ok "LM Studio reachable — ${MODEL_COUNT} model(s) loaded"
else
  warn "LM Studio not reachable at localhost:1234. Start it and load a model."
  warn "Agents will reconnect automatically once LM Studio is running."
fi

# ── Fresh wipe (--fresh) ──────────────────────────────────────────────────────
if $WIPE_VOLUMES; then
  hdr "Wiping existing volumes..."
  dc_all down -v 2>/dev/null || true
  ok "Volumes wiped — starting with clean state"
fi

# ── Build ─────────────────────────────────────────────────────────────────────
BUILD_ARGS=()
$NO_CACHE && BUILD_ARGS+=(--no-cache)

if $BUILD; then
  hdr "Building images${NO_CACHE:+ (no cache)}..."
  dc build "${BUILD_ARGS[@]}"
  ok "Images built"
elif ! docker image inspect starlingai/gateway:dev >/dev/null 2>&1; then
  hdr "First run — building images..."
  dc build
  ok "Images built"
fi

# ── Start ─────────────────────────────────────────────────────────────────────
hdr "Starting services..."
dc up -d
ok "Containers started"

# ── Health checks ─────────────────────────────────────────────────────────────
hdr "Waiting for services to become healthy..."

ENDPOINTS=(
  "Gateway   http://localhost:8765/healthz"
  "Web UI    http://localhost:3001"
  "Tutorials http://localhost:3002"
)

check_endpoint() {
  curl -sf --max-time 3 "$1" >/dev/null 2>&1
}

all_healthy() {
  for entry in "${ENDPOINTS[@]}"; do
    url="${entry##* }"
    check_endpoint "$url" || return 1
  done
}

TIMEOUT=180
ELAPSED=0
INTERVAL=5
until all_healthy || [[ $ELAPSED -ge $TIMEOUT ]]; do
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
  echo -n "."
done
echo ""

HEALTHY=true
for entry in "${ENDPOINTS[@]}"; do
  name="${entry%% *}"
  url="${entry##* }"
  if check_endpoint "$url"; then
    ok "$name"
  else
    warn "$name not yet responding (may still be starting)"
    HEALTHY=false
  fi
done

if ! $HEALTHY; then
  info "Check status: docker compose ps"
  info "View logs:    docker compose logs --tail=50 <service>"
fi

# ── Dashboard token ───────────────────────────────────────────────────────────
hdr "Dashboard login token"
TOKEN=""
if command -v node >/dev/null 2>&1 && [[ -f scripts/gen-token.mjs ]]; then
  TOKEN=$(node scripts/gen-token.mjs 2>/dev/null || true)
fi

if [[ -n "$TOKEN" ]]; then
  echo ""
  echo -e "  ${BOLD}Copy this token into the dashboard login modal:${RESET}"
  echo -e "  ${CYAN}${TOKEN}${RESET}"
  echo ""
else
  info "Generate a token manually: node scripts/gen-token.mjs"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
hdr "StarlingAI is up"
echo ""
echo -e "  ${BOLD}Dashboard${RESET}     →  ${CYAN}http://localhost:3001${RESET}"
echo -e "  ${BOLD}Tutorials${RESET}     →  ${CYAN}http://localhost:3002${RESET}"
echo -e "  ${BOLD}Gateway API${RESET}   →  ${CYAN}http://localhost:8765/api${RESET}"
echo -e "  ${BOLD}Health${RESET}        →  ${CYAN}http://localhost:8765/healthz${RESET}"
echo ""

if $PENTEST; then
  echo -e "  ${BOLD}Kali Pentest${RESET}  →  running on port 5010"
  echo -e "                    Set PENTEST_SCOPE env var before scanning"
fi
if $IMAGE_GEN; then
  echo -e "  ${BOLD}Image Gen${RESET}     →  running on port 5005"
  echo -e "                    Loading model (may take several minutes)"
fi

echo ""
echo -e "  ${BOLD}Useful commands:${RESET}"
echo -e "    ./start.sh --down             Stop all services"
echo -e "    ./start.sh --down --volumes   Stop + wipe all data"
echo -e "    ./start.sh --build            Force rebuild"
echo -e "    ./start.sh --pentest          Start with Kali pentest service"
echo -e "    docker compose logs -f        Follow logs"
echo -e "    docker compose ps             Service status"
echo ""
