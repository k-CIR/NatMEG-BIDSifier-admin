#!/usr/bin/env python3
"""
Small FastAPI server to run bidsify.py from a remote host and serve a minimal static
frontend. This is the "fast path" for converting the Electron UI into a simple
web-accessible UI.

Endpoints:
 - POST /api/analyze  -> runs bidsify --analyse --config <tempfile>
 - POST /api/run      -> runs bidsify --run --config <tempfile>
 - POST /api/report   -> runs bidsify --report --config <tempfile>

This file expects the repository root layout: bidsify.py at the project root.
Run with: uvicorn server.app:app --host 0.0.0.0 --port 8080
"""
from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import tempfile
import subprocess
import asyncio
from uuid import uuid4
from typing import Dict, Any, Tuple
import os
import yaml
from typing import Optional
import shutil
import sys

app = FastAPI(title="NatMEG-BIDSifier Server")

# Root path for server-side file operations — keep inside repo root to avoid
# exposing arbitrary system files. All read/write/list operations will be
# constrained under this directory for safety.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# User home directory for all runtime files (temp configs, job logs, etc.)
USER_HOME = os.path.expanduser('~')
USER_RUNTIME_DIR = os.path.join(USER_HOME, '.connect_logs')
os.makedirs(USER_RUNTIME_DIR, exist_ok=True)
USER_TEMP_DIR = os.path.join(USER_RUNTIME_DIR, 'temp')
os.makedirs(USER_TEMP_DIR, exist_ok=True)
USER_JOBS_DIR = os.path.join(USER_RUNTIME_DIR, 'logs', 'jobs')
os.makedirs(USER_JOBS_DIR, exist_ok=True)

# Deployment mode: set LOCAL_MODE=1 for local single-user mode,
# unset/0 for server mode with /data/ multi-user storage
LOCAL_MODE = os.environ.get('LOCAL_MODE', '0').lower() in ('1', 'true', 'yes')


class RawConfig(BaseModel):
    config_yaml: Optional[str] = None
    config_path: Optional[str] = None


def _write_temp_config(contents: str) -> str:
    # Attempt to parse and normalise YAML contents before writing so temporary
    # configs used by the server follow the expected shapes (e.g., Tasks as list).
    fd, path = tempfile.mkstemp(suffix='.yml', prefix='natmeg_config_', dir=USER_TEMP_DIR)
    try:
        # try parsing YAML
        obj = None
        try:
            obj = yaml.safe_load(contents)
        except Exception:
            obj = None

        if isinstance(obj, dict):
            # normalise tasks to list if present as a string and promote
            # Project.Tasks into top-level Tasks if needed
            def _ensure_tasks_list(cfg):
                # Normalize Tasks both at top-level and inside Project so downstream
                # tools always find Tasks as a list. Accept comma-separated strings
                # and convert them into lists.
                def _to_list(val):
                    if isinstance(val, list):
                        return [p for p in val if p is not None]
                    if isinstance(val, str):
                        return [s.strip() for s in val.split(',') if s.strip()]
                    return []

                # top-level
                t = cfg.get('Tasks')
                if t is None:
                    # try Project.Tasks
                    proj = cfg.get('Project') if isinstance(cfg.get('Project'), dict) else None
                    pt = proj.get('Tasks') if proj and proj.get('Tasks') is not None else None
                    cfg['Tasks'] = _to_list(pt)
                else:
                    cfg['Tasks'] = _to_list(t)

                # Ensure Project.Tasks is also a list if present
                proj = cfg.get('Project') if isinstance(cfg.get('Project'), dict) else None
                if proj is not None and proj.get('Tasks') is not None:
                    proj['Tasks'] = _to_list(proj.get('Tasks'))

            _ensure_tasks_list(obj)

            with os.fdopen(fd, 'w') as f:
                f.write(yaml.safe_dump(obj))
        else:
            # Not a dict — write raw content
            with os.fdopen(fd, 'w') as f:
                f.write(contents)
    except Exception:
        # On any error, write raw content to temp file
        with os.fdopen(fd, 'w') as f:
            f.write(contents)
    return path


def _normalize_config_file(path: str) -> None:
    """Parse YAML at `path` and normalise common fields (Tasks -> list).
    This updates the file in place when possible.
    """
    try:
        with open(path, 'r', encoding='utf8') as f:
            txt = f.read()
        obj = None
        try:
            obj = yaml.safe_load(txt)
        except Exception:
            obj = None
        if not isinstance(obj, dict):
            return

        def _ensure_tasks_list(cfg):
            # same robust normalisation as _write_temp_config: make sure
            # Tasks is always a list and keep Project.Tasks in a normalized form
            def _to_list(val):
                if isinstance(val, list):
                    return [p for p in val if p is not None]
                if isinstance(val, str):
                    return [s.strip() for s in val.split(',') if s.strip()]
                return []

            t = cfg.get('Tasks')
            if t is None:
                proj = cfg.get('Project') if isinstance(cfg.get('Project'), dict) else None
                pt = proj.get('Tasks') if proj and proj.get('Tasks') is not None else None
                cfg['Tasks'] = _to_list(pt)
            else:
                cfg['Tasks'] = _to_list(t)

            proj = cfg.get('Project') if isinstance(cfg.get('Project'), dict) else None
            if proj is not None and proj.get('Tasks') is not None:
                proj['Tasks'] = _to_list(proj.get('Tasks'))

        _ensure_tasks_list(obj)

        with open(path, 'w', encoding='utf8') as f:
            f.write(yaml.safe_dump(obj))
    except Exception:
        # Do not raise — best effort normalization
        return


def _load_config_dict(path: str) -> Optional[dict]:
    try:
        with open(path, 'r', encoding='utf8') as f:
            obj = yaml.safe_load(f)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _cleanup_paths(paths) -> None:
    for p in paths:
        try:
            if p and os.path.exists(p):
                os.unlink(p)
        except Exception:
            pass


def _resolve_config_source(config_path: Optional[str], config_yaml: Optional[str]) -> Tuple[Optional[str], Optional[str], Optional[JSONResponse]]:
    if config_path:
        safe = _safe_path(config_path)
        if not safe or not os.path.exists(safe):
            return None, None, JSONResponse({ 'error': 'invalid or missing config_path' }, status_code=400)
        fd, cfg_tmp = tempfile.mkstemp(suffix='.yml', prefix='natmeg_config_', dir=USER_TEMP_DIR)
        os.close(fd)
        shutil.copy2(safe, cfg_tmp)
        try:
            _normalize_config_file(cfg_tmp)
        except Exception:
            pass
        return cfg_tmp, cfg_tmp, None
    if config_yaml:
        return _write_temp_config(config_yaml), None, None
    return None, None, JSONResponse({ 'error': 'no config provided' }, status_code=400)


def _find_bidsify():
    # Try local repository first, then packaged resources
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    candidate = os.path.join(repo_root, 'bidsify.py')
    if os.path.exists(candidate):
        return candidate
    # Fall back to resources path (bundled app)
    # Many packagers place resources near the application binary
    candidate2 = os.path.join(repo_root, 'electron', 'bidsify.py')
    if os.path.exists(candidate2):
        return candidate2
    # Last resort: hope it's on PATH
    return 'bidsify.py'


def _run_bidsify(args, config_path) -> dict:
    bidsify_path = _find_bidsify()
    # If bidsify_path is a standalone executable, run it directly.
    if os.path.exists(bidsify_path) and not bidsify_path.lower().endswith('.py') and os.access(bidsify_path, os.X_OK):
        cmd = [bidsify_path, '--config', config_path] + args
    else:
        # Prefer an explicit PYTHON override, otherwise use the interpreter running this server
        python = os.environ.get('PYTHON', sys.executable)
        cmd = [python, bidsify_path, '--config', config_path] + args
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False, stdin=subprocess.DEVNULL)
        return {
            'success': result.returncode == 0,
            'returncode': result.returncode,
            'stdout': result.stdout,
            'stderr': result.stderr,
            'cmd': cmd
        }
    except Exception as exc:
        return { 'success': False, 'error': str(exc), 'cmd': cmd }


@app.post('/api/analyze')
async def api_analyze(config: RawConfig):
    # Accept either an inline YAML or a server-side config path. When a path is
    # provided we create a carbon copy (temp file) so the run is isolated and
    # traceable.
    cfg_src = None
    cfg_tmp = None
    try:
        cfg_src, cfg_tmp, err = _resolve_config_source(config.config_path, config.config_yaml)
        if err:
            return err

        # Early validation: config must be a dict at top level.
        if not _load_config_dict(cfg_src):
            _cleanup_paths([cfg_src, cfg_tmp])
            return JSONResponse({ 'error': 'invalid config (expected mapping at top level)' }, status_code=400)

        out = _run_bidsify(['--analyse'], cfg_src)
        return JSONResponse(out)
    finally:
        _cleanup_paths([cfg_tmp])




@app.post('/api/run')
async def api_run(config: RawConfig):
    cfg_src = None
    cfg_tmp = None
    try:
        cfg_src, cfg_tmp, err = _resolve_config_source(config.config_path, config.config_yaml)
        if err:
            return err

        # Early validation: config must be a dict at top level.
        if not _load_config_dict(cfg_src):
            _cleanup_paths([cfg_src, cfg_tmp])
            return JSONResponse({ 'error': 'invalid config (expected mapping at top level)' }, status_code=400)

        out = _run_bidsify(['--run'], cfg_src)
        return JSONResponse(out)
    finally:
        _cleanup_paths([cfg_tmp])


@app.post('/api/report')
async def api_report(config: RawConfig):
    cfg_src = None
    cfg_tmp = None
    try:
        cfg_src, cfg_tmp, err = _resolve_config_source(config.config_path, config.config_yaml)
        if err:
            return err

        # Early validation: config must be a dict at top level.
        if not _load_config_dict(cfg_src):
            _cleanup_paths([cfg_src, cfg_tmp])
            return JSONResponse({ 'error': 'invalid config (expected mapping at top level)' }, status_code=400)

        out = _run_bidsify(['--report'], cfg_src)
        return JSONResponse(out)
    finally:
        _cleanup_paths([cfg_tmp])


@app.get('/api/ping')
async def ping():
    return { 'ok': True }


@app.get('/api/config')
async def get_config():
    """Get server configuration info (deployment mode, etc.)"""
    return { 
        'local_mode': LOCAL_MODE,
        'repo_root': REPO_ROOT,
        'user_home': os.path.expanduser('~')
    }


def _get_dir_size(path: str, max_recursion_depth: int = 5) -> int:
    """Calculate total size of a directory recursively (with depth limit).
    Returns total bytes, or 0 if path doesn't exist or is not readable.
    Limited recursion depth to avoid expensive traversals of large directory trees.
    """
    try:
        total = 0
        level = 0
        for dirpath, dirnames, filenames in os.walk(path):
            # Calculate depth based on path
            current_depth = dirpath[len(path):].count(os.sep)
            if current_depth > max_recursion_depth:
                # Don't traverse deeper
                dirnames.clear()
                continue
            
            for filename in filenames:
                filepath = os.path.join(dirpath, filename)
                try:
                    total += os.path.getsize(filepath)
                except (OSError, IOError):
                    # Skip files we can't access
                    pass
        return total
    except (OSError, IOError):
        return 0


def _safe_path(path: str) -> Optional[str]:
    """Return an absolute path for `path` that is constrained by security boundaries.
    Returns None if the computed path would escape allowed boundaries or is not accessible.
    
    In LOCAL_MODE: paths can be under REPO_ROOT or user's home directory.
    In SERVER_MODE: paths can be under REPO_ROOT, /data/users/<username>, or /data/projects/.
    
    Security model:
    - Paths under REPO_ROOT are always allowed.
    - Paths starting with '~' are expanded to the current user's home directory (constrained there).
    - In SERVER_MODE: paths under /data/users/<username> or /data/projects/ are allowed.
    - In LOCAL_MODE: only REPO_ROOT and user home are allowed.
    - Other absolute paths are rejected (no arbitrary filesystem access).
    - For existing files/dirs: must be readable. For new files: parent directory must be writable.
    """
    if not path:
        return None
    
    user_home = os.path.expanduser('~')
    current_user = os.path.expanduser('~').split('/')[-1]
    
    def _is_accessible(candidate):
        """Check if a path is accessible for reading if it exists, or parent is writable if new."""
        if os.path.exists(candidate):
            return os.access(candidate, os.R_OK)
        else:
            # For new files, check if parent directory exists and is writable
            parent = os.path.dirname(candidate)
            if not parent:
                return False
            # If parent exists, check write access; if parent doesn't exist, allow (will be created)
            if os.path.exists(parent):
                return os.access(parent, os.W_OK)
            return True  # Parent will be created by os.makedirs()
    
    # Paths starting with '~' are expanded to current user's home directory
    if path.startswith('~'):
        abs_candidate = os.path.abspath(os.path.expanduser(path))
        # Ensure the resolved path stays within user's home directory
        try:
            if os.path.commonpath([user_home, abs_candidate]) != user_home:
                return None
        except ValueError:
            # Paths on different drives (Windows) or other issues
            return None
        # Check accessibility
        if not _is_accessible(abs_candidate):
            return None
        return abs_candidate

    # Reject absolute paths (except those under allowed locations)
    # This prevents arbitrary filesystem access outside allowed locations
    if os.path.isabs(path):
        abs_candidate = os.path.abspath(path)
        
        # Check if under REPO_ROOT (always allowed)
        try:
            if os.path.commonpath([REPO_ROOT, abs_candidate]) == REPO_ROOT:
                # Check accessibility
                if not _is_accessible(abs_candidate):
                    return None
                return abs_candidate
        except ValueError:
            pass
        
        # In LOCAL_MODE, also allow user home
        if LOCAL_MODE:
            try:
                if os.path.commonpath([user_home, abs_candidate]) == user_home:
                    # Check accessibility
                    if not _is_accessible(abs_candidate):
                        return None
                    return abs_candidate
            except ValueError:
                pass
            # Not in any allowed location for local mode
            return None
        
        # SERVER_MODE: additional /data/ directories allowed
        
        # Check if under /data/users/<current_user>
        user_data_dir = f'/data/users/{current_user}'
        try:
            if os.path.commonpath([user_data_dir, abs_candidate]) == user_data_dir:
                # Check accessibility
                if not _is_accessible(abs_candidate):
                    return None
                return abs_candidate
        except ValueError:
            pass
        
        # Check if under /data/users/ with any accessible user directory
        # Users can access other user directories if they have permissions
        data_users_dir = '/data/users'
        try:
            if os.path.commonpath([data_users_dir, abs_candidate]) == data_users_dir:
                # Check accessibility - rely on filesystem permissions
                if not _is_accessible(abs_candidate):
                    return None
                return abs_candidate
        except ValueError:
            pass
        
        # Check if it's /data/ itself (allow browsing to show safe paths)
        if abs_candidate == '/data':
            # Just return it; listdir will show user's accessible subdirs
            return abs_candidate
        
        # Check if under /data/projects/ (shared project directories)
        # Access is controlled by filesystem permissions - user must have read/write access
        projects_dir = '/data/projects'
        try:
            if os.path.commonpath([projects_dir, abs_candidate]) == projects_dir:
                # Check accessibility (relies on filesystem permissions)
                if not _is_accessible(abs_candidate):
                    return None
                return abs_candidate
        except ValueError:
            pass
        
        # Not in any allowed location
        return None

    # Relative paths are treated as repository-relative under REPO_ROOT
    abs_candidate = os.path.abspath(os.path.join(REPO_ROOT, os.path.normpath(path).lstrip('/')))
    try:
        if os.path.commonpath([REPO_ROOT, abs_candidate]) != REPO_ROOT:
            return None
    except ValueError:
        return None
    # Check accessibility
    if not _is_accessible(abs_candidate):
        return None
    return abs_candidate


@app.post('/api/read-file')
async def api_read_file(payload: Dict[str, Any]):
    p = payload.get('path', '')
    safe = _safe_path(p)
    if not safe:
        return JSONResponse({ 'error': 'invalid path (outside repo root or empty)' }, status_code=400)
    if not os.path.exists(safe):
        return JSONResponse({ 'error': 'file not found', 'path': p }, status_code=404)
    try:
        with open(safe, 'r', encoding='utf8') as f:
            content = f.read()
        return { 'path': p, 'abs_path': safe, 'content': content }
    except Exception as exc:
        return JSONResponse({ 'error': 'read error', 'details': str(exc) }, status_code=500)


@app.post('/api/save-file')
async def api_save_file(payload: Dict[str, Any]):
    p = payload.get('path', '')
    content = payload.get('content', '')
    safe = _safe_path(p)
    if not safe:
        return JSONResponse({ 'error': 'invalid path (outside repo root or empty)' }, status_code=400)
    d = os.path.dirname(safe)
    try:
        os.makedirs(d, exist_ok=True)
        with open(safe, 'w', encoding='utf8') as f:
            f.write(content)
        return { 'path': p, 'abs_path': safe, 'saved': True }
    except Exception as exc:
        return JSONResponse({ 'error': 'save error', 'details': str(exc) }, status_code=500)


@app.post('/api/list-dir')
async def api_list_dir(payload: Dict[str, Any]):
    """Return a listing of files/directories under the given repo-root relative path.
    payload: { path: <relative path>, calculate_size: <optional bool> }
    If calculate_size is True, directory sizes will be computed (for BIDS browser).
    Otherwise, only mtime is returned (for file browser performance).
    """
    p = payload.get('path', '.')
    calculate_size = payload.get('calculate_size', False)
    safe = _safe_path(p)
    if not safe:
        return JSONResponse({ 'error': 'invalid path (outside repo root or empty)' }, status_code=400)
    if not os.path.isdir(safe):
        return JSONResponse({ 'error': 'directory not found', 'path': p }, status_code=404)
    try:
        items = []
        current_user = os.path.expanduser('~').split('/')[-1]
        
        for name in sorted(os.listdir(safe)):
            ap = os.path.join(safe, name)
            item_path = os.path.join(p, name)
            
            # In SERVER_MODE: Special filtering for /data/ - only show user's accessible paths
            if not LOCAL_MODE:
                if safe == '/data':
                    # Only show /data/users and /data/projects (if accessible)
                    if name == 'users' or name == 'projects':
                        # Check if the item is accessible
                        if os.access(ap, os.R_OK):
                            try:
                                stat_info = os.stat(ap)
                                mtime = int(stat_info.st_mtime)
                            except:
                                mtime = None
                        item = { 'name': name, 'path': item_path, 'is_dir': True, 'mtime': mtime }
                        if calculate_size:
                            item['size'] = _get_dir_size(ap, max_recursion_depth=2)
                        items.append(item)
                    # Skip other items in /data/
                    continue
                
                # Special filtering for /data/users/ - show all user directories the user can access
                if safe == '/data/users':
                    # Try to access each user directory
                    if os.access(ap, os.R_OK):
                        try:
                            stat_info = os.stat(ap)
                            mtime = int(stat_info.st_mtime)
                        except:
                            mtime = None
                    item = { 'name': name, 'path': item_path, 'is_dir': True, 'mtime': mtime }
                    if calculate_size:
                        item['size'] = _get_dir_size(ap, max_recursion_depth=3)
                    items.append(item)
                    continue
            
            # For other directories: only include items that pass _safe_path check
            # This ensures users can't navigate to non-permitted paths
            if _safe_path(item_path):
                is_dir = os.path.isdir(ap)
                try:
                    stat_info = os.stat(ap)
                    mtime = int(stat_info.st_mtime)
                except:
                    mtime = None
                item = { 'name': name, 'path': item_path, 'is_dir': is_dir, 'mtime': mtime }
                if calculate_size:
                    if is_dir:
                        item['size'] = _get_dir_size(ap, max_recursion_depth=5)
                    else:
                        item['size'] = os.path.getsize(ap)
                items.append(item)
        
        return { 'path': p, 'abs_path': safe, 'items': items }
    except Exception as exc:
        return JSONResponse({ 'error': 'list error', 'details': str(exc) }, status_code=500)


# ----------------------------
# Async job queue + websocket log streaming
# ----------------------------

# In-memory job store (for demo / simple server). For production use a persistent
# queue like Redis/Celery/RQ.
JOBS: Dict[str, Dict[str, Any]] = {}


class JobRequest(BaseModel):
    config_yaml: Optional[str] = None
    config_path: Optional[str] = None
    action: Optional[str] = 'run'


async def _stream_subprocess(cmd, job_id: str):
    """Run the command and stream stdout/stderr lines into JOBS[job_id]['logs'] and connected queues."""
    # Ensure the child process has a valid stdin descriptor (DEVNULL) so Python
    # interpreters / frozen executables can initialize sys.stdin/out/err safely.
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    # Publish the running process into the job record so that other handlers
    # (e.g. a stop/abort endpoint) can locate and terminate it.
    try:
        JOBS[job_id]['proc'] = proc
        JOBS[job_id]['pid'] = getattr(proc, 'pid', None)
    except Exception:
        # Best effort: if job record goes away or is replaced, ignore
        pass

    async def read_stream(stream, name):
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode(errors='replace')
            JOBS[job_id].setdefault('logs', []).append({'stream': name, 'line': text})
            # forward to all connected client queues
            for q in list(JOBS[job_id].get('clients', [])):
                await q.put(text)

    readers = [read_stream(proc.stdout, 'stdout'), read_stream(proc.stderr, 'stderr')]
    await asyncio.gather(*readers)
    code = await proc.wait()
    # If a stop/abort was requested, prefer an 'aborted' status. Otherwise
    # mark success/failure based on the exit code.
    JOBS[job_id]['returncode'] = code
    if JOBS.get(job_id, {}).get('aborting') or JOBS.get(job_id, {}).get('cancel_requested'):
        JOBS[job_id]['status'] = 'aborted'
    else:
        JOBS[job_id]['status'] = 'completed' if code == 0 else 'failed'
    # Notify clients about completion
    done_msg = f"__JOB_DONE__ returncode={code}\n"
    for q in list(JOBS[job_id].get('clients', [])):
        await q.put(done_msg)
    # Remove the process handle — it is no longer running.
    try:
        JOBS[job_id].pop('proc', None)
    except Exception:
        pass


@app.post('/api/jobs')
async def create_job(req: JobRequest):
    job_id = str(uuid4())
    # Determine the configuration source. Accept either an inline YAML payload
    # or a server-side config_path. When a server file is specified we create a
    # carbon-copy (temp file) so the execution uses an immutable snapshot.
    cfg_path = None
    cfg_temp_copy = None
    cfg_path, cfg_temp_copy, err = _resolve_config_source(req.config_path, req.config_yaml)
    if err:
        return err

    # Early validation: config must be a dict at top level.
    if not _load_config_dict(cfg_path):
        _cleanup_paths([cfg_path, cfg_temp_copy])
        return JSONResponse({ 'error': 'invalid config (expected mapping at top level)' }, status_code=400)

    JOBS[job_id] = {
        'id': job_id,
        'status': 'queued',
        'logs': [],
        'clients': [],
        'returncode': None,
        'action': req.action,
        'cfg_path': cfg_path,
        'original_config_path': req.config_path or None,
        'artifacts': []
    }

    # determine args
    args = []
    if req.action == 'analyse':
        args = ['--analyse']
    elif req.action == 'run':
        args = ['--run']
    elif req.action == 'report':
        args = ['--report']

    bidsify = _find_bidsify()
    # If bidsify is a standalone executable (e.g. a packaged binary), run it directly.
    # Otherwise prefer an explicit PYTHON override, otherwise use the interpreter running this server.
    if os.path.exists(bidsify) and not bidsify.lower().endswith('.py') and os.access(bidsify, os.X_OK):
        cmd = [bidsify, '--config', cfg_path] + args
    else:
        python = os.environ.get('PYTHON', sys.executable)
        cmd = [python, bidsify, '--config', cfg_path] + args

    # record the resolved command in the job payload for easier debugging
    JOBS[job_id]['cmd'] = cmd

    # Persist a copy of the exact config used to disk under user home logs/jobs/<job_id>/
    # for easy retrieval / traceability
    try:
        job_cfg_dir = os.path.join(USER_JOBS_DIR, job_id)
        os.makedirs(job_cfg_dir, exist_ok=True)
        persistent_config_path = os.path.join(job_cfg_dir, 'used_config.yml')
        if cfg_path and os.path.exists(cfg_path):
            shutil.copy2(cfg_path, persistent_config_path)
            JOBS[job_id].setdefault('artifacts', []).append(persistent_config_path)
    except Exception:
        pass

    JOBS[job_id]['status'] = 'running'

    async def _background():
        try:
            # parse config to determine expected artifacts
            cfg_obj = _load_config_dict(cfg_path)

            # Inform clients about the resolved command so they can see what will run
            try:
                cmd_text = ' '.join([str(x) for x in cmd])
            except Exception:
                cmd_text = str(cmd)
            JOBS[job_id].setdefault('logs', []).append({'stream': 'meta', 'line': f'[CMD] {cmd_text}\n'})
            for q in list(JOBS[job_id].get('clients', [])):
                try: await q.put(f'[CMD] {cmd_text}\n')
                except Exception:
                    pass

            await _stream_subprocess(cmd, job_id)

            # If no logs were captured during execution, provide a small hint to help debugging
            if not JOBS[job_id].get('logs') or all((entry.get('stream') == 'meta' for entry in JOBS[job_id].get('logs', []))):
                msg = '[INFO] no stdout/stderr output captured from job (check logs/artifacts)\n'
                JOBS[job_id].setdefault('logs', []).append({'stream': 'meta', 'line': msg})
                for q in list(JOBS[job_id].get('clients', [])):
                    try: await q.put(msg)
                    except Exception:
                        pass

            # after completion, try to find canonical artifacts (logs & results)
            if cfg_obj:
                projectRoot = None
                proj = cfg_obj.get('Project') if isinstance(cfg_obj, dict) else None
                if proj and proj.get('Root') and proj.get('Name'):
                    projectRoot = os.path.join(proj.get('Root'), proj.get('Name'))

                logs_dir = os.path.join(projectRoot, 'logs') if projectRoot else None
                conv_name = cfg_obj.get('BIDS', {}).get('Conversion_file') if isinstance(cfg_obj.get('BIDS', {}), dict) else None
                conv_name = conv_name or 'bids_conversion.tsv'
                # Probe a set of likely locations for conversion tables and results
                # (project logs, conversion_logs inside project, BIDS path fallbacks)
                candidates = []
                if logs_dir:
                    candidates.append(os.path.join(logs_dir, conv_name))
                    candidates.append(os.path.join(logs_dir, 'bids_results.json'))
                    candidates.append(os.path.join(os.path.dirname(logs_dir), 'conversion_logs', conv_name))

                # also look for a top-level BIDS path in the config (Project.BIDS or top-level BIDS)
                bids_path = None
                try:
                    # support config shapes: Project -> BIDS or top-level BIDS
                    if isinstance(cfg_obj.get('Project'), dict) and cfg_obj.get('Project').get('BIDS'):
                        bids_path = cfg_obj.get('Project').get('BIDS')
                    elif cfg_obj.get('BIDS') and isinstance(cfg_obj.get('BIDS'), str):
                        bids_path = cfg_obj.get('BIDS')
                except Exception:
                    bids_path = None

                if bids_path:
                    bids_path = os.path.expanduser(str(bids_path))
                    # bidsify.py saves to dirname(BIDS)/logs/ - this is the primary location
                    candidates.append(os.path.join(os.path.dirname(bids_path), 'logs', conv_name))
                    candidates.append(os.path.join(os.path.dirname(bids_path), 'logs', 'bids_results.json'))
                    # Also check inside BIDS directory as fallback
                    candidates.append(os.path.join(bids_path, 'logs', conv_name))
                    candidates.append(os.path.join(bids_path, 'conversion_logs', conv_name))
                    candidates.append(os.path.join(bids_path, conv_name))

                # As a final fallback probe the user home logs folder
                user_logs = os.path.join(USER_HOME, '.natmeg', 'logs')
                candidates.append(os.path.join(user_logs, conv_name))
                candidates.append(os.path.join(user_logs, 'bids_results.json'))

                found = []
                for p in candidates:
                    try:
                        if p and os.path.exists(p) and p not in found:
                            found.append(p)
                    except Exception:
                        # ignore inaccessible paths
                        pass

                JOBS[job_id]['artifacts'] = found
        finally:
            _cleanup_paths([cfg_path, cfg_temp_copy])

    asyncio.create_task(_background())
    return { 'job_id': job_id }


@app.get('/api/jobs')
async def jobs_list():
    return { 'jobs': [{ 'id': j['id'], 'status': j.get('status'), 'action': j.get('action') } for j in JOBS.values()] }


@app.get('/api/jobs/{job_id}')
async def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return JSONResponse({ 'error': 'not found' }, status_code=404)
    return { 'id': job_id, 'status': job.get('status'), 'returncode': job.get('returncode'), 'logs_count': len(job.get('logs', [])) }


@app.get('/api/jobs/{job_id}/artifacts')
async def job_artifacts(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return JSONResponse({ 'error': 'not found' }, status_code=404)
    return { 'artifacts': job.get('artifacts', []) }


@app.get('/api/jobs/{job_id}/logs')
async def job_logs(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return JSONResponse({ 'error': 'not found' }, status_code=404)
    # return raw log lines (stream-like order)
    return { 'logs': job.get('logs', []) }


@app.post('/api/jobs/{job_id}/stop')
async def stop_job(job_id: str):
    """Request that the server terminate a running job's subprocess.

    This will attempt a graceful termination (SIGTERM) and escalate to
    a kill if the process does not exit after a short timeout.
    """
    job = JOBS.get(job_id)
    if not job:
        return JSONResponse({ 'error': 'job not found' }, status_code=404)

    proc = job.get('proc')
    if not proc:
        # No running process to stop; report current status
        return JSONResponse({ 'error': 'job not running', 'status': job.get('status') }, status_code=409)

    # mark as aborting so streaming logic can convert final state to 'aborted'
    job['aborting'] = True
    job.setdefault('logs', []).append({'stream': 'meta', 'line': f'[STOP] Job {job_id} abort requested by client\n'})
    for q in list(job.get('clients', [])):
        try: await q.put(f'[STOP] Job {job_id} abort requested by client\n')
        except Exception: pass

    try:
        # Try graceful termination first
        proc.terminate()
    except Exception:
        pass

    async def _ensure_terminate(p):
        # Give the process a short grace period to exit cleanly, then escalate.
        try:
            for _ in range(10):
                await asyncio.sleep(0.1)
                if p.returncode is not None:
                    return
            # Still alive — try killing
            try: p.kill()
            except Exception: pass
        except Exception:
            pass

    # don't block the request — let the background task handle escalation
    asyncio.create_task(_ensure_terminate(proc))

    return { 'ok': True, 'job_id': job_id }


@app.post('/api/client-log')
async def client_log(payload: Dict[str, Any]):
    """Receive client-side JS error reports for debugging (writes to server logs)."""
    try:
        # keep a concise server log entry
        msg = payload.get('message') or str(payload)
        import logging
        logging.getLogger('natmeg.client').warning('CLIENT-LOG: %s', msg)
        return { 'ok': True }
    except Exception as e:
        return JSONResponse({ 'error': 'failed to record client log', 'details': str(e) }, status_code=500)


@app.get('/api/jobs/{job_id}/artifact')
async def job_artifact_download(job_id: str, index: int = 0):
    job = JOBS.get(job_id)
    if not job:
        return JSONResponse({ 'error': 'not found' }, status_code=404)
    artifacts = job.get('artifacts', [])
    if index < 0 or index >= len(artifacts):
        return JSONResponse({ 'error': 'artifact index out of range' }, status_code=400)
    path = artifacts[index]
    if not os.path.exists(path):
        return JSONResponse({ 'error': 'file not found' }, status_code=404)
    return FileResponse(path, filename=os.path.basename(path))


@app.websocket('/ws/jobs/{job_id}/logs')
async def websocket_logs(ws: WebSocket, job_id: str):
    await ws.accept()
    job = JOBS.get(job_id)
    if not job:
        await ws.send_text('ERROR: job not found')
        await ws.close()
        return

    q = asyncio.Queue()
    job.setdefault('clients', []).append(q)

    try:
        # send backlog first
        for entry in job.get('logs', []):
            await ws.send_text(entry.get('line', ''))

        while True:
            try:
                line = await q.get()
                await ws.send_text(line)
                if isinstance(line, str) and line.startswith('__JOB_DONE__'):
                    break
            except asyncio.CancelledError:
                break
    except WebSocketDisconnect:
        pass
    finally:
        try:
            job['clients'].remove(q)
        except Exception:
            pass


# Serve the included lightweight web UI from / (see web/index.html)
# We mount static files after registering API routes to avoid the static
# file handler shadowing the /api/ endpoints (StaticFiles mounted at '/'
# can capture many paths if added early).
web_dir = os.path.join(os.path.dirname(__file__), '..', 'web')
if os.path.isdir(web_dir):
    app.mount('/', StaticFiles(directory=web_dir, html=True), name='web')

