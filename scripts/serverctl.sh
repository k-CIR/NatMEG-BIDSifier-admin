#!/usr/bin/env bash
# Lightweight server control script for NatMEG-BIDSifier
# Usage: ./serverctl.sh {start|stop|status|restart} [--port N] [--host HOST]

set -euo pipefail

usage(){
  cat <<EOF
Usage: $0 {start|stop|status|restart} [--port N] [--host HOST]

Commands:
  start   - Start uvicorn server in background (auto-opens browser on localhost)
  stop    - Stop server
  status  - Check if server is running
  restart - Restart server

Flags:
  --port N    - Port to listen on (default: 8080, via \$PORT env var)
  --host HOST - Host to bind to (default: 127.0.0.1, via \$HOST env var)

Examples:
  ./scripts/serverctl.sh start                      # start on localhost:8080
  ./scripts/serverctl.sh start --port 18080         # start on localhost:18080
  PORT=9090 ./scripts/serverctl.sh start            # use env var for port
  ./scripts/serverctl.sh status                     # check status
  ./scripts/serverctl.sh stop                       # stop the server

Notes:
  - Uses .venv/bin/python if available, falls back to system python
  - Logs written to $HOME/.cache/natmeg/natmeg-server-{PORT}.log (or $XDG_RUNTIME_DIR if set)
  - Writes pidfile to $HOME/.cache/natmeg/.server.{PORT}.pid (or $XDG_RUNTIME_DIR if set)
  - Browser auto-opens when binding to localhost (macOS/Linux/Windows)
  - Refuses to start if port is already in use
EOF
  exit 2
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then usage; fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$HOME/.cache/natmeg}"
mkdir -p "$USER_RUNTIME_DIR/connect"
# Defaults (can be overridden via flags or environment)
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
PIDFILE="$USER_RUNTIME_DIR/.server.${PORT}.pid"
LOGFILE="$USER_RUNTIME_DIR/natmeg-server-${PORT}.log"
# Prefer the repo venv python, but fall back to system python
PY="$REPO_ROOT/.venv/bin/python"
if [ ! -x "$PY" ]; then
  PY="$(command -v python 2>/dev/null || true)"
fi

# Parse optional flags (allow anywhere after subcommand)
CMD="${1:-}"
case "$CMD" in
  start|stop|status|restart) shift || true ;;
  *) CMD="" ;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; PIDFILE="$USER_RUNTIME_DIR/.server.${PORT}.pid"; LOGFILE="$USER_RUNTIME_DIR/natmeg-server-${PORT}.log"; shift 2;;
    --host) HOST="$2"; shift 2;;
    *) break;;
  esac
done

# re-export so child processes (uvicorn) see overrides if needed
export HOST PORT

is_port_in_use(){
  # returns 0 if port bound, non-zero otherwise
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1 && return 0 || return 1
  fi
  # fallback: try netstat
  if command -v netstat >/dev/null 2>&1; then
    netstat -an | grep "LISTEN" | grep -q ":${PORT} " && return 0 || return 1
  fi
  return 1
}

start(){
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE" 2>/dev/null || echo '')
    if [ -n "$PID" ] && kill -0 "$PID" >/dev/null 2>&1; then
      echo "Server appears to already be running (pid=$PID)"; return 0
    else
      echo "Removing stale pidfile"; rm -f "$PIDFILE"
    fi
  fi

  if is_port_in_use; then
    echo "Port $PORT is already in use — aborting start"; return 1
  fi

  if [ -z "$PY" ]; then
    echo "No python runtime found; cannot start server"; return 2
  fi

  echo "Starting NatMEG server using $PY (host $HOST, port $PORT)";
  nohup "$PY" -m uvicorn server.app:app --host "$HOST" --port "$PORT" > "$LOGFILE" 2>&1 &
  NEWPID=$!
  echo "$NEWPID" > "$PIDFILE"
  echo "server started (pid=$NEWPID), logs -> $LOGFILE"
  
  # Auto-open browser if running locally (cross-platform: macOS, Linux, Windows/Git Bash)
  # Skip if $DISPLAY is not set (no X server, e.g., SSH session without X11 forwarding)
  if [[ "$HOST" == "127.0.0.1" || "$HOST" == "localhost" ]]; then
    if [[ -z "${DISPLAY:-}" ]]; then
      echo "No X server found (\$DISPLAY not set); skipping browser auto-open"
      echo "Access the server manually: curl http://localhost:${PORT}/api/ping"
    else
      sleep 1  # give server a moment to start
      if command -v open >/dev/null 2>&1; then
        # macOS
        open "http://localhost:${PORT}"
      elif command -v xdg-open >/dev/null 2>&1; then
        # Linux
        xdg-open "http://localhost:${PORT}" >/dev/null 2>&1
      elif command -v start >/dev/null 2>&1; then
        # Windows/Git Bash
        start "http://localhost:${PORT}"
      fi
    fi
  fi
}

stop(){
  if [ ! -f "$PIDFILE" ]; then
    echo "No pidfile found — server probably not started by this script"; return 0
  fi
  PID=$(cat "$PIDFILE" 2>/dev/null || echo '')
  if [ -z "$PID" ]; then
    echo "Empty pidfile; removing"; rm -f "$PIDFILE" "$LOGFILE"; return 0
  fi
  if kill -0 "$PID" >/dev/null 2>&1; then
    echo "Stopping server pid=$PID"; kill "$PID" || true
    sleep 0.5
    if kill -0 "$PID" >/dev/null 2>&1; then
      echo "Process still alive; sending TERM"; kill -TERM "$PID" || true
    fi
  else
    echo "No such process $PID (stale pidfile), cleaning up";
  fi
  rm -f "$PIDFILE" "$LOGFILE"
}

status(){
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE" 2>/dev/null || echo '')
    if [ -n "$PID" ] && kill -0 "$PID" >/dev/null 2>&1; then
      echo "NatMEG server running (pid=$PID)"; return 0
    else
      echo "Pidfile exists but process not running (pid=$PID)"; return 1
    fi
  fi
  if is_port_in_use; then
    echo "Port $PORT is in use by another process (server might've been started outside this script)"; return 0
  fi
  echo "NatMEG server not running"; return 3
}

case "$CMD" in
  start) start ;; 
  stop) stop ;; 
  restart) stop; sleep 0.4; start ;; 
  status) status ;; 
  *)
    usage
    ;;
esac
