#!/usr/bin/env bash
# Launch a remote natmeg server and forward it back to the local machine in a single command
# Usage: ./scripts/cir-bidsify.sh [user@host] [remote_repo] [--local-port 8080] [--remote-port 8080] [--autossh] [--auto-port]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$REPO_ROOT/.tunnel.pid"
PORTFILE="$REPO_ROOT/.tunnel.port"

LOCAL_PORT=8080
REMOTE_PORT=18080
AUTOSSH=0
AUTO_PORT=0

usage(){
  cat <<EOF
Usage: $0 [user@host] [remote_repo] [--local-port N] [--remote-port N] [--autossh] [--auto-port]

Simple helper that:
  - runs ./scripts/serverctl.sh start on the remote host
  - waits for the remote /api/ping to respond
  - sets up an SSH tunnel that forwards remote:LOCAL_PORT -> local:LOCAL_PORT
  - writes the tunnel PID to .tunnel.pid in the repo root
  - when --auto-port is used, picks a free remote port (range 18080-18150) and records it in .tunnel.port

If password-less SSH keys are not available you will be prompted for a password
and the helper will try to use sshpass automatically (if installed) to avoid
multiple prompts.
EOF
  exit 2
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then usage; fi

# Subcommand? accept start|stop|status as the first argument (defaults to start)
cmd="start"
if [[ ${1:-} =~ ^(start|stop|status)$ ]]; then
  cmd="$1"
  shift || true
fi

# parse args
POSITIONAL=()
REMOTE_PORT_SET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local-port)
      LOCAL_PORT="$2"; shift 2;;
    --remote-port)
      REMOTE_PORT="$2"; REMOTE_PORT_SET=1; AUTO_PORT=0; shift 2;;
    --autossh)
      AUTOSSH=1; shift;;
    --auto-port)
      AUTO_PORT=1; shift;;
    -*|--*)
      echo "Unknown flag: $1"; usage;;
    *)
      POSITIONAL+=("$1"); shift;;
  esac
done
set -- "${POSITIONAL[@]:-}"

# Default to auto-port if remote port was not explicitly set
if [[ $REMOTE_PORT_SET -eq 0 ]]; then
  AUTO_PORT=1
fi

SSH_TARGET=${1:-}
REMOTE_REPO=${2:-$REPO_ROOT}

if [[ -z "$SSH_TARGET" ]]; then
  read -rp "Enter remote ssh target (user@host): " SSH_TARGET
fi

if [[ -z "$REMOTE_REPO" ]]; then
  REMOTE_REPO="$REPO_ROOT"
fi

# If a previous run recorded a remote port and user didn't override, reuse it for status/stop
if [[ "$cmd" != "start" && $REMOTE_PORT_SET -eq 0 && -f "$PORTFILE" ]]; then
  if grep -Eq '^[0-9]+$' "$PORTFILE"; then
    REMOTE_PORT="$(cat "$PORTFILE")"
  fi
fi

echo "Command: $cmd"
echo "Target:  $SSH_TARGET"
echo "Repo:    $REMOTE_REPO"
echo "Tunnel:  http://localhost:${LOCAL_PORT}  <- tunnel -> remote:localhost:${REMOTE_PORT}"

# helper: run an ssh command, using sshpass if needed
run_ssh_cmd() {
  local cmd="$1"
  # Try batch mode first (no password prompt). If fails due to auth, fall back
  # to interactive or sshpass (if available)
  if ssh -o BatchMode=yes -o ConnectTimeout=6 "$SSH_TARGET" true >/dev/null 2>&1; then
    ssh "$SSH_TARGET" "$cmd"
    return $?
  fi

  # If we are here, BatchMode failed (no key). Prompt for password; if sshpass
  # exists, use it so the script can run multiple commands without re-prompting.
  if command -v sshpass >/dev/null 2>&1; then
    read -srp "SSH password for $SSH_TARGET (will not be echoed): " _PW
    echo
    # Use -p with sshpass (watch out: exposes password in process listing briefly)
    sshpass -p "$_PW" ssh "$SSH_TARGET" "$cmd"
    return $?
  fi

  # Fallback: run ssh interactively, letting ssh ask for password.
  echo "No passwordless key found and sshpass not available — falling back to interactive ssh (you will be prompted for a password)."
  ssh "$SSH_TARGET" "$cmd"
}

if [[ "$cmd" == "start" ]]; then
  # Auto-pick a free remote port if requested
  if [[ $AUTO_PORT -eq 1 ]]; then
    echo "Auto-selecting a free remote port (18080-18150)..."
    CANDIDATE="$(run_ssh_cmd "sh -lc 'if command -v ss >/dev/null 2>&1; then for p in \$(seq 18080 18150); do ss -ltn 2>/dev/null | grep -q \":\$p \" || { echo \$p; exit 0; }; done; elif command -v lsof >/dev/null 2>&1; then for p in \$(seq 18080 18150); do lsof -nP -iTCP:\$p -sTCP:LISTEN >/dev/null 2>&1 || { echo \$p; exit 0; }; done; elif command -v netstat >/dev/null 2>&1; then for p in \$(seq 18080 18150); do netstat -an 2>/dev/null | grep -q LISTEN | grep -q \":\$p \" || { echo \$p; exit 0; }; done; else echo 18080; fi'")"
    if [[ -n "$CANDIDATE" && "$CANDIDATE" =~ ^[0-9]+$ ]]; then
      REMOTE_PORT="$CANDIDATE"
      echo "Selected remote port: $REMOTE_PORT"
      echo "$REMOTE_PORT" > "$PORTFILE" || true
    else
      echo "Failed to auto-select a remote port; falling back to $REMOTE_PORT"
    fi
  fi

  # ensure remote server is started
  echo "Starting remote server (via serverctl.sh start)..."
  # pass --port to remote serverctl so multiple users can run concurrently
  run_ssh_cmd "cd \"${REMOTE_REPO}\" && ./scripts/serverctl.sh start --port ${REMOTE_PORT}" || {
    echo "Remote server start failed (check credentials or remote logs)"; exit 1
  }

  echo -n "Waiting for remote server to respond";
  attempts=0
  until run_ssh_cmd "curl -fsS http://127.0.0.1:${REMOTE_PORT}/api/ping" >/dev/null 2>&1; do
    attempts=$((attempts+1))
    echo -n ".";
    if [[ $attempts -ge 20 ]]; then
      echo
      echo "Timed out waiting for remote server to respond on port ${REMOTE_PORT}. Check server logs.";
      exit 2
    fi
    sleep 0.5
  done
  echo " OK"

  # check local port availability; if busy and --auto-port, auto-pick a free local port
  if ss -ltn 2>/dev/null | grep -q ":${LOCAL_PORT} "; then
    if [[ $AUTO_PORT -eq 1 ]]; then
      echo "Local port ${LOCAL_PORT} is in use; auto-selecting..."
      for p in $(seq "$LOCAL_PORT" 8100); do
        if ! ss -ltn 2>/dev/null | grep -q ":$p "; then LOCAL_PORT="$p"; break; fi
      done
      echo "Using local port $LOCAL_PORT"
    else
      echo "Local port ${LOCAL_PORT} appears to be in use. Pick a free port or stop the process currently listening on ${LOCAL_PORT}."
      read -rp "Use alternate local port (e.g. 18080) or press Ctrl-C to abort: " NEWPORT
      if [[ -n "$NEWPORT" ]]; then
        LOCAL_PORT="$NEWPORT"
        echo "Using local port $LOCAL_PORT"
      else
        echo "Aborting."; exit 3
      fi
    fi
  fi

  # build tunnel command
  if [[ $AUTOSSH -eq 1 ]]; then
    if ! command -v autossh >/dev/null 2>&1; then
      echo "autossh flag requested but autossh is not installed. Install autossh or run without --autossh."; exit 4
    fi
    TUN_CMD="autossh -f -M 0 -N -o ExitOnForwardFailure=yes -L ${LOCAL_PORT}:localhost:${REMOTE_PORT} ${SSH_TARGET}"
  else
    TUN_CMD="ssh -f -N -o ExitOnForwardFailure=yes -L ${LOCAL_PORT}:localhost:${REMOTE_PORT} ${SSH_TARGET}"
  fi

  echo "Starting tunnel: ${TUN_CMD}"
  # Start tunnel and save PID of the backgrounded ssh/autossh process
  bash -lc "${TUN_CMD} & echo \$! > \"${PIDFILE}\""

  sleep 0.3
  if [[ -f "$PIDFILE" ]]; then
    pid=$(cat "$PIDFILE")
    if ps -p "$pid" >/dev/null 2>&1; then
      echo "Tunnel established (pid=$pid). Open http://localhost:${LOCAL_PORT} in your browser. PID file: ${PIDFILE}"
      exit 0
    else
      echo "Tunnel process failed to start; see ssh output above for errors."; rm -f "$PIDFILE"; exit 5
    fi
  else
    echo "Failed to record tunnel pidfile ($PIDFILE)"; exit 6
  fi
fi

if [[ "$cmd" == "status" ]]; then
  echo "-- status --"
  if [[ -f "$PIDFILE" ]]; then
    pid=$(cat "$PIDFILE")
    if ps -p "$pid" >/dev/null 2>&1; then
      echo "Local tunnel running (pid=$pid)."; curl -sS "http://localhost:${LOCAL_PORT}/api/ping" || echo "local ping failed"
    else
      echo "PID file exists but process $pid not running. Removing pidfile."; rm -f "$PIDFILE"
    fi
  else
    echo "No local tunnel pidfile ($PIDFILE) found.";
  fi

  echo "Remote server status (serverctl.sh status):"
  run_ssh_cmd "cd \"${REMOTE_REPO}\" && ./scripts/serverctl.sh status --port ${REMOTE_PORT}" || echo "Failed to query remote server status"
  exit 0
fi

if [[ "$cmd" == "stop" ]]; then
  echo "-- stop --"
  if [[ -f "$PIDFILE" ]]; then
    pid=$(cat "$PIDFILE")
    if ps -p "$pid" >/dev/null 2>&1; then
      echo "Stopping local tunnel (pid=$pid)"; kill "$pid" || true; sleep 0.2
      if ps -p "$pid" >/dev/null 2>&1; then
        echo "Tunnel still alive, sending TERM"; kill -TERM "$pid" || true
      fi
    else
      echo "PID file exists but process $pid not running; cleaning up";
    fi
    rm -f "$PIDFILE"
  else
    echo "No local tunnel pidfile found; nothing to stop.";
  fi

  read -rp "Stop remote server as well? [y/N]: " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    run_ssh_cmd "cd \"${REMOTE_REPO}\" && ./scripts/serverctl.sh stop --port ${REMOTE_PORT}" || echo "Remote server stop failed"
  fi
  exit 0
fi

echo -n "Waiting for remote server to respond";
attempts=0
until run_ssh_cmd "curl -fsS http://127.0.0.1:${REMOTE_PORT}/api/ping" >/dev/null 2>&1; do
  attempts=$((attempts+1))
  echo -n ".";
  if [[ $attempts -ge 20 ]]; then
    echo
    echo "Timed out waiting for remote server to respond on port ${REMOTE_PORT}. Check server logs.";
    exit 2
  fi
  sleep 0.5
done
echo " OK"

# check local port availability
if ss -ltn | grep -q ":${LOCAL_PORT} "; then
  echo "Local port ${LOCAL_PORT} appears to be in use. Pick a free port or stop the process currently listening on ${LOCAL_PORT}."
  read -rp "Use alternate local port (e.g. 18080) or press Ctrl-C to abort: " NEWPORT
  if [[ -n "$NEWPORT" ]]; then
    LOCAL_PORT="$NEWPORT"
    echo "Using local port $LOCAL_PORT"
  else
    echo "Aborting."; exit 3
  fi
fi

# build tunnel command
if [[ $AUTOSSH -eq 1 ]]; then
  if ! command -v autossh >/dev/null 2>&1; then
    echo "autossh flag requested but autossh is not installed. Install autossh or run without --autossh."; exit 4
  fi
  TUN_CMD="autossh -f -M 0 -N -o ExitOnForwardFailure=yes -L ${LOCAL_PORT}:localhost:${REMOTE_PORT} ${SSH_TARGET}"
else
  TUN_CMD="ssh -f -N -o ExitOnForwardFailure=yes -L ${LOCAL_PORT}:localhost:${REMOTE_PORT} ${SSH_TARGET}"
fi

echo "Starting tunnel: ${TUN_CMD}"
# Start tunnel and save PID of the backgrounded ssh/autossh process
bash -lc "${TUN_CMD} & echo \$! > \"${PIDFILE}\""

sleep 0.3
if [[ -f "$PIDFILE" ]]; then
  pid=$(cat "$PIDFILE")
  if ps -p "$pid" >/dev/null 2>&1; then
    echo "Tunnel established (pid=$pid). Open http://localhost:${LOCAL_PORT} in your browser. PID file: ${PIDFILE}"
    exit 0
  else
    echo "Tunnel process failed to start; see ssh output above for errors."; rm -f "$PIDFILE"; exit 5
  fi
else
  echo "Failed to record tunnel pidfile ($PIDFILE)"; exit 6
fi
