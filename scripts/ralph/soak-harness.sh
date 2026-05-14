#!/bin/bash
#
# Soak harness: launch daemon + soak-story-supplier in detached mode for
# saturated autonomous-loop runs (Phase 1 #6 infrastructure; the actual 24h
# run is Phase 1 #7).
#
# Usage:
#
#   scripts/ralph/soak-harness.sh start [options]
#   scripts/ralph/soak-harness.sh status
#   scripts/ralph/soak-harness.sh tail [daemon|supplier]
#   scripts/ralph/soak-harness.sh stop
#
# start options:
#   --duration-hours N             (default 0 = unbounded; daemon stops at N hours)
#   --rate-per-hour N              (default 30 stories/hour from the supplier)
#   --supplier-max-stories N       (default 0 = unbounded)
#   --mode approval|fullauto       (default approval)
#   --interval-ms N                (daemon cycle interval, default 60000)
#   --limit N                      (daemon stories-per-cycle, default 25)
#   --ticks-per-story N            (daemon ticks per story per cycle, default 3)
#   --env-file PATH                (default /Users/hkobayashi/MCA/.env if present)
#   --dry-supplier                 (supplier runs in dry-run; daemon as usual)
#
# Required env (sourced from --env-file):
#   OPENROUTER_API_KEY
#
# Layout under .ralph/soak/:
#   daemon.pid       supplier.pid
#   daemon.log       supplier.log
#   harness-state.json (config snapshot)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SOAK_DIR="$ROOT_DIR/.ralph/soak"
mkdir -p "$SOAK_DIR" "$ROOT_DIR/.ralph/logs"

DAEMON_PID_FILE="$SOAK_DIR/daemon.pid"
SUPPLIER_PID_FILE="$SOAK_DIR/supplier.pid"
DAEMON_LOG="$SOAK_DIR/daemon.log"
SUPPLIER_LOG="$SOAK_DIR/supplier.log"
HARNESS_STATE="$SOAK_DIR/harness-state.json"

usage() {
  sed -n '2,30p' "$0"
}

# default values
DURATION_HOURS=0
RATE_PER_HOUR=30
SUPPLIER_MAX_STORIES=0
MODE=approval
INTERVAL_MS=60000
LIMIT=25
TICKS_PER_STORY=3
ENV_FILE="/Users/hkobayashi/MCA/.env"
DRY_SUPPLIER=0

parse_start_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --duration-hours) DURATION_HOURS="$2"; shift 2;;
      --rate-per-hour) RATE_PER_HOUR="$2"; shift 2;;
      --supplier-max-stories) SUPPLIER_MAX_STORIES="$2"; shift 2;;
      --mode) MODE="$2"; shift 2;;
      --interval-ms) INTERVAL_MS="$2"; shift 2;;
      --limit) LIMIT="$2"; shift 2;;
      --ticks-per-story) TICKS_PER_STORY="$2"; shift 2;;
      --env-file) ENV_FILE="$2"; shift 2;;
      --dry-supplier) DRY_SUPPLIER=1; shift;;
      *) echo "unknown option: $1"; usage; exit 2;;
    esac
  done
}

is_alive() {
  local pid="$1"
  [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null
}

status_cmd() {
  echo "soak directory: $SOAK_DIR"
  if [ -f "$DAEMON_PID_FILE" ]; then
    local p; p=$(cat "$DAEMON_PID_FILE")
    if is_alive "$p"; then
      echo "daemon:   RUNNING (pid $p)"
    else
      echo "daemon:   DEAD (last pid $p, log $DAEMON_LOG)"
    fi
  else
    echo "daemon:   not started"
  fi
  if [ -f "$SUPPLIER_PID_FILE" ]; then
    local p; p=$(cat "$SUPPLIER_PID_FILE")
    if is_alive "$p"; then
      echo "supplier: RUNNING (pid $p)"
    else
      echo "supplier: DEAD (last pid $p, log $SUPPLIER_LOG)"
    fi
  else
    echo "supplier: not started"
  fi
  if [ -f "$HARNESS_STATE" ]; then
    echo "harness state:"
    cat "$HARNESS_STATE" | sed 's/^/  /'
  fi
  local daemon_cycles supplier_emits
  daemon_cycles=$(grep -c '"stage": "ralph_autonomous_daemon_cycle"' "$DAEMON_LOG" 2>/dev/null || echo 0)
  supplier_emits=$(grep -c '"event":"emit_ok"' "$SUPPLIER_LOG" 2>/dev/null || echo 0)
  echo "daemon cycles in log:  $daemon_cycles"
  echo "supplier emits in log: $supplier_emits"
}

stop_cmd() {
  local stopped=0
  if [ -f "$DAEMON_PID_FILE" ]; then
    local p; p=$(cat "$DAEMON_PID_FILE")
    if is_alive "$p"; then
      kill "$p" 2>/dev/null || true
      sleep 2
      if is_alive "$p"; then kill -9 "$p" 2>/dev/null || true; fi
      stopped=$((stopped+1))
    fi
  fi
  if [ -f "$SUPPLIER_PID_FILE" ]; then
    local p; p=$(cat "$SUPPLIER_PID_FILE")
    if is_alive "$p"; then
      kill "$p" 2>/dev/null || true
      sleep 2
      if is_alive "$p"; then kill -9 "$p" 2>/dev/null || true; fi
      stopped=$((stopped+1))
    fi
  fi
  echo "stopped: $stopped process(es)"
  echo "stopped_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

start_cmd() {
  parse_start_args "$@"
  if [ -f "$DAEMON_PID_FILE" ] && is_alive "$(cat "$DAEMON_PID_FILE")"; then
    echo "daemon already running (pid $(cat "$DAEMON_PID_FILE"))"
    exit 3
  fi
  if [ -f "$SUPPLIER_PID_FILE" ] && is_alive "$(cat "$SUPPLIER_PID_FILE")"; then
    echo "supplier already running (pid $(cat "$SUPPLIER_PID_FILE"))"
    exit 3
  fi

  if [ ! -f "$ENV_FILE" ]; then
    echo "env file not found: $ENV_FILE"
    exit 4
  fi

  # Snapshot config
  cat > "$HARNESS_STATE" <<EOF
{
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_hours": $DURATION_HOURS,
  "rate_per_hour": $RATE_PER_HOUR,
  "supplier_max_stories": $SUPPLIER_MAX_STORIES,
  "mode": "$MODE",
  "interval_ms": $INTERVAL_MS,
  "limit": $LIMIT,
  "ticks_per_story": $TICKS_PER_STORY,
  "env_file": "$ENV_FILE",
  "dry_supplier": $DRY_SUPPLIER
}
EOF

  # daemon wrapper
  cat > "$SOAK_DIR/run-daemon.sh" <<EOF
#!/bin/bash
set -a
source "$ENV_FILE"
set +a
cd "$ROOT_DIR"
DURATION_HOURS=$DURATION_HOURS
MAX_CYCLES=0
if [ "\$DURATION_HOURS" -gt 0 ]; then
  MAX_CYCLES=\$(( DURATION_HOURS * 3600 * 1000 / $INTERVAL_MS ))
fi
exec node scripts/ralph/autonomous-daemon.js \\
  --interval-ms $INTERVAL_MS \\
  --max-cycles \$MAX_CYCLES \\
  --limit $LIMIT \\
  --ticks-per-story $TICKS_PER_STORY \\
  --pre-secret-scan-ok
EOF
  chmod +x "$SOAK_DIR/run-daemon.sh"

  # supplier wrapper
  SUPPLIER_FLAGS="--rate-per-hour $RATE_PER_HOUR --max-stories $SUPPLIER_MAX_STORIES --mode $MODE"
  if [ "$DRY_SUPPLIER" -eq 1 ]; then SUPPLIER_FLAGS="$SUPPLIER_FLAGS --dry-run"; fi
  cat > "$SOAK_DIR/run-supplier.sh" <<EOF
#!/bin/bash
set -a
source "$ENV_FILE"
set +a
cd "$ROOT_DIR"
exec node scripts/ralph/soak-story-supplier.js $SUPPLIER_FLAGS
EOF
  chmod +x "$SOAK_DIR/run-supplier.sh"

  # truncate logs
  : > "$DAEMON_LOG"
  : > "$SUPPLIER_LOG"

  nohup "$SOAK_DIR/run-daemon.sh" >> "$DAEMON_LOG" 2>&1 &
  local DPID=$!
  echo "$DPID" > "$DAEMON_PID_FILE"
  disown "$DPID" 2>/dev/null || true

  sleep 2
  nohup "$SOAK_DIR/run-supplier.sh" >> "$SUPPLIER_LOG" 2>&1 &
  local SPID=$!
  echo "$SPID" > "$SUPPLIER_PID_FILE"
  disown "$SPID" 2>/dev/null || true

  echo "daemon   pid: $DPID  log: $DAEMON_LOG"
  echo "supplier pid: $SPID  log: $SUPPLIER_LOG"
  echo "started_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sleep 3
  if is_alive "$DPID"; then echo "daemon status:   RUNNING"; else echo "daemon status:   EXITED EARLY (check $DAEMON_LOG)"; fi
  if is_alive "$SPID"; then echo "supplier status: RUNNING"; else echo "supplier status: EXITED EARLY (check $SUPPLIER_LOG)"; fi
}

tail_cmd() {
  local which="${1:-both}"
  case "$which" in
    daemon)   exec tail -F "$DAEMON_LOG";;
    supplier) exec tail -F "$SUPPLIER_LOG";;
    both)     exec tail -F "$DAEMON_LOG" "$SUPPLIER_LOG";;
    *) echo "unknown: $which"; exit 2;;
  esac
}

main() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    start)  start_cmd "$@";;
    status) status_cmd;;
    tail)   tail_cmd "$@";;
    stop)   stop_cmd;;
    -h|--help|help) usage;;
    *) usage; exit 2;;
  esac
}

main "$@"
