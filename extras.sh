#!/usr/bin/env bash
# ============================================================
#  StarlingAI — optional services manager
#
#  Usage:
#    ./extras.sh status              Show status of all optional services
#    ./extras.sh pentest on          Start kali-pentest service
#    ./extras.sh pentest off         Stop kali-pentest service
#    ./extras.sh image on            Start image-generation service
#    ./extras.sh image off           Stop image-generation service
#    ./extras.sh all on              Start ALL optional services
#    ./extras.sh all off             Stop ALL optional services
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

COMPOSE_FILES=(-f docker-compose.yml)
[[ -f docker-compose.strix-halo.yml ]] && COMPOSE_FILES+=(-f docker-compose.strix-halo.yml)

dc() { docker compose "${COMPOSE_FILES[@]}" "$@"; }

service_status() {
  local name="$1"
  local state
  state=$(docker compose "${COMPOSE_FILES[@]}" ps --format json "$name" 2>/dev/null \
    | grep -o '"Health":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  local running
  running=$(docker compose "${COMPOSE_FILES[@]}" ps --format json "$name" 2>/dev/null \
    | grep -o '"State":"[^"]*"' | head -1 | cut -d'"' -f4 || true)

  if [[ "$running" == "running" ]]; then
    if [[ "$state" == "healthy" ]]; then
      echo -e "  ${GREEN}●${RESET} $name  ${GREEN}healthy${RESET}"
    elif [[ "$state" == "starting" ]]; then
      echo -e "  ${YELLOW}●${RESET} $name  ${YELLOW}starting${RESET}"
    else
      echo -e "  ${GREEN}●${RESET} $name  running"
    fi
  else
    echo -e "  ${RED}○${RESET} $name  stopped"
  fi
}

show_status() {
  echo -e "\n${BOLD}Optional services:${RESET}"
  service_status "kali-pentest"
  service_status "image-generation-service"
  echo ""
}

start_pentest() {
  echo "Starting kali-pentest..."
  dc --profile pentest up -d kali-pentest
  ok "kali-pentest started"
  info "Set PENTEST_SCOPE before scanning, e.g.:"
  info "  PENTEST_SCOPE=192.168.1.0/24 docker compose up -d kali-pentest"
}

stop_pentest() {
  echo "Stopping kali-pentest..."
  dc stop kali-pentest 2>/dev/null && dc rm -f kali-pentest 2>/dev/null || true
  ok "kali-pentest stopped"
}

start_image() {
  echo "Starting image-generation-service..."
  dc --profile image up -d image-generation-service
  ok "image-generation-service started (model loading — may take several minutes)"
}

stop_image() {
  echo "Stopping image-generation-service..."
  dc stop image-generation-service 2>/dev/null && dc rm -f image-generation-service 2>/dev/null || true
  ok "image-generation-service stopped"
}

# ── Argument parsing ──────────────────────────────────────────────────────────
SERVICE="${1:-status}"
ACTION="${2:-}"

case "$SERVICE" in
  status)
    show_status
    ;;

  pentest)
    [[ "$ACTION" == "on" || "$ACTION" == "off" ]] || fail "Usage: ./extras.sh pentest on|off"
    [[ "$ACTION" == "on" ]] && start_pentest || stop_pentest
    show_status
    ;;

  image)
    [[ "$ACTION" == "on" || "$ACTION" == "off" ]] || fail "Usage: ./extras.sh image on|off"
    [[ "$ACTION" == "on" ]] && start_image || stop_image
    show_status
    ;;

  all)
    [[ "$ACTION" == "on" || "$ACTION" == "off" ]] || fail "Usage: ./extras.sh all on|off"
    if [[ "$ACTION" == "on" ]]; then
      start_pentest
      start_image
    else
      stop_pentest
      stop_image
    fi
    show_status
    ;;

  --help|-h)
    grep "^#  " "$0" | sed 's/^#  //'
    ;;

  *)
    fail "Unknown service '$SERVICE'. Use: pentest | image | all | status"
    ;;
esac
