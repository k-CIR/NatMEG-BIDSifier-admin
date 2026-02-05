#!/usr/bin/env bash
# Launch a remote natmeg server and forward it back to the local machine in a single command
# Usage: ./scripts/localctl.sh [start|stop|status|list|cleanup] [user@host] [remote_repo] [--local-port N] [--remote-port N] [--autossh]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_RUNTIME_DIR="$REPO_ROOT/.connect_logs"
mkdir -p "$USER_RUNTIME_DIR/connect"
PIDFILE="$USER_RUNTIME_DIR/.tunnel.pid"
PORTFILE="$USER_RUNTIME_DIR/.tunnel.port"
REPOFILE="$USER_RUNTIME_DIR/.tunnel.repo"

LOCAL_PORT=8080
REMOTE_PORT=18080
AUTOSSH=0
AUTO_PORT=0

usage(){
  cat <<EOF
Usage: $0 [start|stop|status|list|cleanup] [user@host] [remote_repo] [--local-port N] [--remote-port N] [--autossh] [--all]

Commands:
  start   - Start remote server and create tunnel (default)
  stop    - Stop tunnel (optionally stop remote server)
  status  - Check tunnel and remote server status
  list    - List all your running servers on the remote host
  cleanup - Stop a specific server by port number (use when pidfile is missing)

Flags:
  --local-port N    - Port on your laptop to listen on (defaults to 8080, auto-picks if busy)
  --remote-port N   - Remote server loopback port (disables auto-port, uses specified port)
  --autossh         - Use autossh for auto-reconnect
  --all             - With cleanup: kill all remote uvicorn processes and clean local files

Simple helper that:
  - runs ./scripts/serverctl.sh start on the remote host
  - waits for the remote /api/ping to respond
  - sets up an SSH tunnel that forwards remote:REMOTE_PORT -> local:LOCAL_PORT
  - writes the tunnel PID to .tunnel.pid in the repo root
  - by default, auto-selects a free remote port (range 18080-18150) and records it in .tunnel.port

If password-less SSH keys are not available you will be prompted for a password
and the helper will try to use sshpass automatically (if installed) to avoid
multiple prompts.
EOF
  exit 2
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then usage; fi

# Parse command first (matches serverctl.sh pattern)
cmd="start"
if [[ ${1:-} =~ ^(start|stop|status|list|cleanup)$ ]]; then
  cmd="$1"
  shift || true
fi

# parse args and flags
POSITIONAL=()
REMOTE_PORT_SET=0
ALL_FLAG=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local-port)
      LOCAL_PORT="$2"; shift 2;;
    --remote-port)
      REMOTE_PORT="$2"; REMOTE_PORT_SET=1; AUTO_PORT=0; shift 2;;
    --autossh)
      AUTOSSH=1; shift;;
    --all)
      ALL_FLAG=1; shift;;
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
REMOTE_REPO=${2:-}

# Try to restore from previous run if not provided
if [[ -z "$SSH_TARGET" && -f "$REPOFILE" ]]; then
  SSH_TARGET=$(head -n1 "$REPOFILE" 2>/dev/null || echo '')
fi

if [[ -z "$REMOTE_REPO" && -f "$REPOFILE" ]]; then
  REMOTE_REPO=$(tail -n1 "$REPOFILE" 2>/dev/null || echo '')
fi

if [[ -z "$SSH_TARGET" ]]; then
  read -rp "Enter remote ssh target (user@host): " SSH_TARGET
fi

if [[ -z "$REMOTE_REPO" ]]; then
  REMOTE_REPO="/data/users/natmeg/scripts/NatMEG-BIDSifier"
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
  # Stop any existing tunnel first to avoid accumulating ports
  if [[ -f "$PIDFILE" ]]; then
    old_pid=$(cat "$PIDFILE" 2>/dev/null || echo '')
    if [[ -n "$old_pid" ]] && ps -p "$old_pid" >/dev/null 2>&1; then
      echo "Stopping existing tunnel (pid=$old_pid) before starting new one..."
      kill "$old_pid" 2>/dev/null || true
      sleep 0.3
    fi
    rm -f "$PIDFILE"
  fi

  # Save SSH target and remote repo for later status/stop commands
  printf "%s\n%s\n" "$SSH_TARGET" "$REMOTE_REPO" > "$REPOFILE"

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

  # Helper: check if a local port is in use (cross-platform: Linux, macOS, Windows/Git Bash)
  is_local_port_in_use() {
    local port="$1"
    # Try lsof first (macOS, Linux)
    if command -v lsof >/dev/null 2>&1; then
      lsof -nP -iTCP:${port} -sTCP:LISTEN >/dev/null 2>&1 && return 0
    fi
    # Try ss (Linux)
    if command -v ss >/dev/null 2>&1; then
      ss -ltn 2>/dev/null | grep -q ":${port} " && return 0
    fi
    # Try netstat (Windows, fallback for Linux/macOS)
    if command -v netstat >/dev/null 2>&1; then
      netstat -an 2>/dev/null | grep -i "LISTEN" | grep -q ":${port} " && return 0
    fi
    return 1
  }

  # check local port availability; if busy and --auto-port, auto-pick a free local port
  if is_local_port_in_use "$LOCAL_PORT"; then
    if [[ $AUTO_PORT -eq 1 ]]; then
      echo "Local port ${LOCAL_PORT} is in use; auto-selecting..."
      for p in $(seq "$LOCAL_PORT" 18200); do
        if ! is_local_port_in_use "$p"; then
          LOCAL_PORT="$p"
          break
        fi
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
  # Start tunnel with -f flag (ssh backgrounds itself)
  ${TUN_CMD}
  tunnel_exit=$?
  if [[ $tunnel_exit -ne 0 ]]; then
    echo "Tunnel process failed to start (exit code: $tunnel_exit). Check SSH connection and credentials."
    exit 5
  fi

  # Find the SSH tunnel PID (since -f makes SSH fork, we can't capture $!)
  sleep 0.5
  
  # Use ps and grep as a more portable alternative to pgrep
  if command -v pgrep >/dev/null 2>&1; then
    tunnel_pid=$(pgrep -f "ssh.*-L ${LOCAL_PORT}:localhost:${REMOTE_PORT}" | head -1)
  else
    tunnel_pid=$(ps aux 2>/dev/null | grep -v grep | grep "ssh.*-L ${LOCAL_PORT}:localhost:${REMOTE_PORT}" | awk '{print $2}' | head -1)
  fi
  if [[ -n "$tunnel_pid" ]]; then
    echo "$tunnel_pid" > "$PIDFILE"
    echo "Tunnel established (pid=$tunnel_pid). Opening http://localhost:${LOCAL_PORT} in your browser..."
    
    # Auto-open browser (cross-platform: macOS, Linux, Windows/Git Bash)
    if command -v open >/dev/null 2>&1; then
      # macOS
      open "http://localhost:${LOCAL_PORT}"
    elif command -v xdg-open >/dev/null 2>&1; then
      # Linux
      xdg-open "http://localhost:${LOCAL_PORT}" >/dev/null 2>&1
    elif command -v start >/dev/null 2>&1; then
      # Windows/Git Bash
      start "http://localhost:${LOCAL_PORT}"
    else
      echo "Could not auto-open browser. Please open http://localhost:${LOCAL_PORT} manually."
    fi
    
    exit 0
  else
    echo "Tunnel started but couldn't find PID. It may still be running."
    exit 6
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

if [[ "$cmd" == "list" ]]; then
  echo "-- list your running servers --"
  if [[ -z "$SSH_TARGET" ]]; then
    read -rp "Enter remote ssh target (user@host): " SSH_TARGET
  fi
  echo "Querying servers on $SSH_TARGET..."
  run_ssh_cmd "ps aux | grep '[u]vicorn server.app:app' | grep \"\$(whoami)\" || echo 'No servers running'"
  exit 0
fi

if [[ "$cmd" == "cleanup" ]]; then
  echo "-- cleanup server by port --"
  if [[ $ALL_FLAG -eq 1 ]]; then
    echo "Killing all remote uvicorn server processes and cleaning up local files..."
    if [[ -z "$SSH_TARGET" ]]; then
      read -rp "Enter remote ssh target (user@host): " SSH_TARGET
    fi
    if [[ -z "$REMOTE_REPO" ]]; then
      read -rp "Enter remote repo path: " REMOTE_REPO
    fi
    
    # Find all running uvicorn processes owned by current user and extract their ports
    echo "Finding all running uvicorn servers for current user..."
    PORTS=$(run_ssh_cmd "ps aux | grep \"\$(whoami)\" | grep '[u]vicorn.*server.app:app' | grep -oE '\-\-port\s+[0-9]+' | awk '{print \$NF}' | sort -u" || echo "")
    
    if [[ -z "$PORTS" ]]; then
      echo "No uvicorn processes found running for current user."
    else
      echo "Found uvicorn processes owned by current user on ports: $PORTS"
      # Stop each port - kill by finding the PID and killing it directly
      while IFS= read -r port; do
        if [[ -n "$port" ]]; then
          echo "Killing process on port $port..."
          # Get PID of process listening on this port and kill it
          PID=$(run_ssh_cmd "ps aux | grep \"\$(whoami)\" | grep \"port $port\" | grep -v grep | awk '{print \$2}'" 2>/dev/null || echo "")
          if [[ -n "$PID" ]]; then
            run_ssh_cmd "kill -9 $PID" 2>/dev/null && echo "  Killed PID $PID" || echo "  Failed to kill PID $PID"
          else
            echo "  Could not find PID for port $port"
          fi
          sleep 0.2
        fi
      done <<< "$PORTS"
    fi
    
    # Remove all local tunnel files
    rm -f "$PIDFILE" "$PORTFILE" "$REPOFILE"
    echo "Local tunnel files removed."
    exit 0
  fi
  if [[ -z "$SSH_TARGET" ]]; then
    read -rp "Enter remote ssh target (user@host): " SSH_TARGET
  fi
  if [[ -z "$REMOTE_REPO" ]]; then
    read -rp "Enter remote repo path: " REMOTE_REPO
  fi
  read -rp "Enter port number to stop: " PORT_TO_STOP
  if [[ ! "$PORT_TO_STOP" =~ ^[0-9]+$ ]]; then
    echo "Invalid port number"; exit 1
  fi
  echo "Finding and stopping server on port $PORT_TO_STOP..."
  run_ssh_cmd "cd \"${REMOTE_REPO}\" && ./scripts/serverctl.sh stop --port ${PORT_TO_STOP}" || {
    echo "Failed to stop via serverctl, trying to find process directly..."
    run_ssh_cmd "pkill -f 'uvicorn.*:${PORT_TO_STOP}' && echo 'Process killed' || echo 'No process found on port ${PORT_TO_STOP}'"
  }
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
