# NatMEG-BIDSifier

## Overview

This is a toolkit for converting MEG/EEG data to BIDS (Brain Imaging Data Structure) format, developed at the NatMEG facility at Karolinska Institutet. The project supports a CLI and a web UI with remote connection, making it possible to edit your BIDS conversion and run it from a browser. It supports automated batch processing and includes features for data validation and quality checking.

## Features

- Convert MEG/EEG data to BIDS format
- Command-line interface for batch processing
- Automated metadata extraction and validation
- Web-based user interface for configuration and monitoring
- Remote job submission and real-time log streaming


## Quick start, connect and run from your laptop

1. Download [/scripts/localctl.sh](scripts/localctl.sh) to your laptop
2. Run localctl.sh with your server details:
3. Make executable

```bash
chmod +x localctl.sh
```
4. Connect and run
```bash
/scripts/localctl.sh start <user>@compute.kcir.se /data/users/natmeg/scripts/NatMEG-BIDSifier
```

5. Script automatically:
   - Starts the remote server with an available port
   - Checks server health via `/api/ping`
   - Creates an SSH tunnel to your laptop
   - Opens browser to `http://localhost:8080` (or auto-selected local port)
6. Edit configuration and run BIDS conversion jobs via the web UI










## Installation (on server)

### Prerequisites

- Python 3.10 or higher
- Git

### Setup

1. Clone the repository:
```bash
git clone git@github.com:k-CIR/NatMEG-BIDSifier.git
cd NatMEG-BIDSifier
```

2. Install Python dependencies:
```bash
# create a venv and activate
python3 -m venv .venv
source .venv/bin/activate

# install dependencies
pip install -r requirements.txt
```

## Usage

### Command Line (on server)

```bash
python bidsify.py --config config.yml [--analyse][--run][--report]
```

### Web UI with remote access (recommended)
1. Download [/scripts/localctl.sh](scripts/localctl.sh) to your laptop
2. Run localctl.sh with your server details:
```bash
/scripts/localctl.sh start <user>@compute.kcir.se /data/users/natmeg/scripts/NatMEG-BIDSifier
```

3. Script automatically:
   - Starts the remote server with an available port
   - Checks server health via `/api/ping`
   - Creates an SSH tunnel to your laptop
   - Opens browser to `http://localhost:8080` (or auto-selected local port)
4. Edit configuration and run BIDS conversion jobs via the web UI

#### Architecture highlights
- **FastAPI server** (`server/app.py`) runs `bidsify.py` for you and exposes REST + WebSocket endpoints
- **Static frontend** (`web/`) implements a browser UI that speaks to the server via REST + WebSocket for real-time job logs
- **Real-time logs** via WebSockets at `ws://<host>/ws/jobs/{job_id}/logs` for streaming stdout/stderr
- Web UI can submit jobs (analyse, run, report), stream logs, and fetch artifacts (e.g. `bids_results.json` or TSV tables)

#### Helper scripts for server management

Two control scripts are provided in `scripts/`:

##### `serverctl.sh` – Local server lifecycle management

**Features:**
- Prefers Python from `.venv/bin/python` if present
- Writes logs to `~/natmeg-server.log`
- Per-port isolation via `.server.<port>.pid` files
- Refuses to start if port is already bound (helps avoid collisions)
- Auto-opens browser on localhost (macOS/Linux/Windows)
- Customizable via flags: `./scripts/serverctl.sh start --port 18080 --host 127.0.0.1`

**Usage:**

If already SSH'd into the server, you can use this script to manage the server lifecycle.

```bash
./scripts/serverctl.sh {start|stop|status|restart} [--port N] [--host HOST]

Commands:
  start   - Start uvicorn server in background (auto-opens browser on localhost)
  stop    - Stop server
  status  - Check if server is running
  restart - Restart server

Flags:
  --port N    - Port to listen on (default: 8080, via $PORT env var)
  --host HOST - Host to bind to (default: 127.0.0.1, via $HOST env var)

Examples:
  ./scripts/serverctl.sh start                      # start on localhost:8080
  ./scripts/serverctl.sh start --port 18080         # start on localhost:18080
  PORT=9090 ./scripts/serverctl.sh start            # use env var for port
  ./scripts/serverctl.sh status                     # check status
  ./scripts/serverctl.sh stop                       # stop the server

Notes:
  - Uses .venv/bin/python if available, falls back to system python
  - Logs written to ~/natmeg-server-{PORT}.log
  - Writes pidfile to .server.{PORT}.pid in repo root
  - Browser auto-opens when binding to localhost (macOS/Linux/Windows)
  - Refuses to start if port is already in use

```

**Example**:

```bash
./scripts/serverctl.sh start
# test with: curl http://localhost:18080/api/ping
```

Then from your laptop, create a tunnel manually:
```bash
ssh -L 8080:localhost:18080 user@compute.kcir.se
```

Or run a text-based browser on the server (`lynx` or `w3m`).

##### `localctl.sh` – Remote server + SSH tunnel orchestration

Combines three operations: start remote server, check health, create SSH tunnel. Perfect for accessing a remote server from your laptop.

**Features:**
- **Auto-port selection** (default): automatically picks a free remote port (18080–18150) and local port (8080+)
- **Multi-user support**: allows concurrent servers on shared hosts without port conflicts
- **Saved connection details**: remembers SSH target and remote repo path (`.tunnel.repo`, `.tunnel.port`) for simplified repeat commands
- **Auto-browser opening** (macOS/Linux/Windows): opens browser after tunnel is ready
- Cross-platform local port detection (macOS/Linux/Windows/Git Bash)
- Supports passwordless SSH (preferred) or `sshpass` for password automation

**Usage:**
```bash
./scripts/localctl.sh [start|stop|status|list|cleanup] [user@host] [remote_repo] [--local-port N] [--remote-port N] [--autossh]

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

Simple helper that:
  - runs ./scripts/serverctl.sh start on the remote host
  - waits for the remote /api/ping to respond
  - sets up an SSH tunnel that forwards remote:REMOTE_PORT -> local:LOCAL_PORT
  - writes the tunnel PID to .tunnel.pid in the repo root
  - by default, auto-selects a free remote port (range 18080-18150) and records it in .tunnel.port

If password-less SSH keys are not available you will be prompted for a password
and the helper will try to use sshpass automatically (if installed) to avoid
multiple prompts.
```

```bash
# Full command with all arguments (simplest for first use)
./scripts/localctl.sh start user@compute.kcir.se /data/users/natmeg/scripts/NatMEG-BIDSifier

# After running start once, simplified commands work (no need to re-specify host/path)
./scripts/localctl.sh status    # show tunnel & remote server status
./scripts/localctl.sh list      # list running servers on remote host
./scripts/localctl.sh stop      # stop tunnel (and optionally remote server)

# Advanced: specific ports or auto-reconnect
./scripts/localctl.sh start user@compute.kcir.se /path --remote-port 18090
./scripts/localctl.sh start user@compute.kcir.se /path --autossh  # uses autossh for auto-reconnect

# Cleanup orphaned servers by port
./scripts/localctl.sh cleanup
```

**Recommended alias:**

Add this to your `~/.bashrc` / `~/.zshrc`:

```bash
alias cir-bidsify="./scripts/localctl.sh <user>@compute.kcir.se /data/users/natmeg/scripts/NatMEG-BIDSifier"
```

Now you can simply:
```bash
cir-bidsify
# Browser opens automatically to http://localhost:8080
```

#### Security note
- The bundled server is optimised for convenience and internal/trusted use. If you expose the server publicly, add TLS and authentication and restrict file read/write operations as appropriate.
- Server prefers binding to loopback (127.0.0.1) for security; SSH tunnel then forwards to your laptop instead of exposing to the internet.

### Quick local setup (development or single-host use)

#### macOS / Linux

```bash
# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies and start server
pip install -r requirements.txt
./scripts/serverctl.sh start
# Browser opens automatically to http://localhost:8080
```

#### Windows (PowerShell)

TBA


### Developer notes

- The `web/` folder contains a lightweight static UI which the server serves for convenience in development. In production you can serve this static UI separately.
- The server runs `bidsify.py` under the same repo; it will use the Python interpreter inside the active `.venv` unless overridden by `PYTHON` env var.

## Configuration

Copy `default_config.yml` and customize it for your parameters or start a webserver and save your edits.

## Project structure

Top-level layout you will interact with during development / server runs:

```
├── bidsify.py            # Main conversion CLI
├── requirements.txt      # Python dependencies (includes server deps)
├── default_config.yml    # Default conversion configuration
├── server/               # FastAPI app and server utilities
│   ├── app.py            # FastAPI app (REST + WebSocket + job runner)
│   └── ...
├── web/                  # Static frontend served by the FastAPI server
│   ├── index.html
│   ├── app-config.js
│   ├── app-jobs.js
│   ├── app-editor.js
│   └── styles.css
├── scripts/              # helper scripts for server / tunnelling
│   └── serverctl.sh      # start/stop/status helper (uses .server.pid + ~/natmeg-server.log)
│   └── localctl.sh    # helper to connect and start remote server with port forwarding
└── ...

## Dependencies

### Core Libraries
- MNE-Python (>=1.5.0) - MEG/EEG data processing
- MNE-BIDS (>=0.13.0) - BIDS conversion
- NumPy, SciPy, Pandas - Scientific computing
- PyQt6 - GUI components

See `requirements.txt` for complete list.

## License

MIT

## Authors

[Andreas Gerhardsson]([agerhardsson](https://github.com/agerhardsson)) - NatMEG - Karolinska Institutet

## Acknowledgments

This tool is built on top of MNE-Python and MNE-BIDS projects.
