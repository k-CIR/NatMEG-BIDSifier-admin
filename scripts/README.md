Server control scripts
======================

This directory contains a small helper script to start/stop the local FastAPI / Uvicorn server used by the project.

serverctl.sh
-----------

Usage:

  ./serverctl.sh start    # start uvicorn in background using .venv python (writes .server.pid)
  ./serverctl.sh status   # check pidfile and whether server is running
  ./serverctl.sh stop     # stop server started via this script
  ./serverctl.sh restart  # restart

Notes:
- The script prefers the Python interpreter in `.venv/bin/python` if present.
- Server logs are written to `~/natmeg-server.log` by default.
- The script refuses to start if port 8080 is already bound (helps avoid collisions).
- You can override host/port per-user via environment or flags:
  - Example: `PORT=18080 ./scripts/serverctl.sh start`
  - Or: `./scripts/serverctl.sh start --port 18080 --host 127.0.0.1`


# Start remote server on a custom port per-user, and tunnel to local 8080
./scripts/cir-bidsify.sh start user@server /path/to/NatMEG-BIDSifier --remote-port 18080 --local-port 8080
cir-bidsify.sh
---------------

`cir-bidsify.sh` is a convenient helper that combines three common steps when you want to run the FastAPI server on a remote host and access it locally via a secure SSH tunnel:

- ensure the remote server is started (uses `./scripts/serverctl.sh start` on the remote repo)
- wait for the remote server to respond to `/api/ping` (sanity/health check)
- create a local SSH tunnel that forwards remote localhost:REMOTE_PORT to your laptop localhost:LOCAL_PORT

Behavior and files
- Writes the background tunnel PID to `.tunnel.pid` in the repository root on your local machine.
- By default it uses LOCAL_PORT=8080 and REMOTE_PORT=8080.
- The script supports password-less SSH (preferred). If a key is not available and `sshpass` is installed it will prompt once for a password and use `sshpass` to avoid multiple prompts. Otherwise it will fall back to interactive SSH.

Usage
```
./scripts/cir-bidsify.sh [start|stop|status] [user@host] [remote_repo] [--local-port N] [--remote-port N] [--autossh]
```

- `start` (default): starts remote server, waits for ping, then creates local tunnel
- `status`: print local tunnel state and query `serverctl.sh status` on the remote host
- `stop`: stop local tunnel (kills PID in `.tunnel.pid`) and optionally stop the remote server

Flags and common examples
- `--local-port N`: port on your laptop to listen on (defaults to 8080)
- `--remote-port N`: remote server's loopback port (defaults to 8080)
- `--autossh`: use `autossh` (recommended for auto-reconnect) instead of a plain `ssh` tunnel. `autossh` must be installed on your laptop.

Examples
```
# Interactive prompt for target and repo
./scripts/cir-bidsify.sh

# Start a tunnel to a remote host, auto-reconnect using autossh
./scripts/cir-bidsify.sh start user@server /path/to/NatMEG-BIDSifier --autossh

# Check status (reports local tunnel + remote serverctl status)
./scripts/cir-bidsify.sh status user@server /path/to/NatMEG-BIDSifier

# Stop the local tunnel and ask if you want to stop the remote server
./scripts/cir-bidsify.sh stop user@server /path/to/NatMEG-BIDSifier
```

Exit codes
- 0: success
- 1..6: heterogeneous failure codes (see script output). Typical failures include authentication issues, timeout waiting for remote `/api/ping`, missing `autossh` when requested, or local port conflicts.

Security / notes
- The script prefers the remote server to bind to the remote host's loopback (127.0.0.1). This is safer because the tunnel forwards the service back to your laptop instead of exposing the server to the public internet.
- Use SSH key authentication for unattended runs; otherwise consider `sshpass` if you want to automate password entry (it has security tradeoffs).
- The script writes a local `.tunnel.pid` file. If you remove or accidentally delete the pidfile you'll need to stop the background tunnel manually (kill the ssh/autossh PID).

If you want, we can add unit tests or a small integration test (using a local dummy server) to validate this helper on CI; open a follow-up issue or tell me to implement it.
