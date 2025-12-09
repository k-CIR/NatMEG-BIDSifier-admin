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
from typing import Dict, Any
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


class RawConfig(BaseModel):
    config_yaml: Optional[str] = None
    config_path: Optional[str] = None


def _write_temp_config(contents: str) -> str:
    # Attempt to parse and normalise YAML contents before writing so temporary
    # configs used by the server follow the expected shapes (e.g., Tasks as list).
    fd, path = tempfile.mkstemp(suffix='.yml', prefix='natmeg_config_')
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
        if config.config_path:
            safe = _safe_path(config.config_path)
            if not safe or not os.path.exists(safe):
                return JSONResponse({ 'error': 'invalid or missing config_path' }, status_code=400)
            # copy to temp so execution uses a snapshot
            fd, cfg_tmp = tempfile.mkstemp(suffix='.yml', prefix='natmeg_config_')
            os.close(fd)
            import shutil
            shutil.copy2(safe, cfg_tmp)
            cfg_src = cfg_tmp
            # normalize the copied server file so fields like Tasks are represented
            # in the expected shapes (lists etc) before running
            try:
                _normalize_config_file(cfg_tmp)
            except Exception:
                pass
        elif config.config_yaml:
            cfg_src = _write_temp_config(config.config_yaml)
        else:
            return JSONResponse({ 'error': 'no config provided' }, status_code=400)

        out = _run_bidsify(['--analyse'], cfg_src)
        return JSONResponse(out)
    finally:
        try:
            if cfg_tmp and os.path.exists(cfg_tmp):
                os.unlink(cfg_tmp)
        except Exception:
            pass




@app.post('/api/run')
async def api_run(config: RawConfig):
    cfg_src = None
    cfg_tmp = None
    try:
        if config.config_path:
            safe = _safe_path(config.config_path)
            if not safe or not os.path.exists(safe):
                return JSONResponse({ 'error': 'invalid or missing config_path' }, status_code=400)
            fd, cfg_tmp = tempfile.mkstemp(suffix='.yml', prefix='natmeg_config_')
            os.close(fd)
            import shutil
            shutil.copy2(safe, cfg_tmp)
            cfg_src = cfg_tmp
            try:
                _normalize_config_file(cfg_tmp)
            except Exception:
                pass
        elif config.config_yaml:
            cfg_src = _write_temp_config(config.config_yaml)
        else:
            return JSONResponse({ 'error': 'no config provided' }, status_code=400)

        out = _run_bidsify(['--run'], cfg_src)
        return JSONResponse(out)
    finally:
        try:
            if cfg_tmp and os.path.exists(cfg_tmp):
                os.unlink(cfg_tmp)
        except Exception:
            pass


@app.post('/api/report')
async def api_report(config: RawConfig):
    cfg_src = None
    cfg_tmp = None
    try:
        if config.config_path:
            safe = _safe_path(config.config_path)
            if not safe or not os.path.exists(safe):
                return JSONResponse({ 'error': 'invalid or missing config_path' }, status_code=400)
            fd, cfg_tmp = tempfile.mkstemp(suffix='.yml', prefix='natmeg_config_')
            os.close(fd)
            import shutil
            shutil.copy2(safe, cfg_tmp)
            cfg_src = cfg_tmp
            try:
                _normalize_config_file(cfg_tmp)
            except Exception:
                pass
        elif config.config_yaml:
            cfg_src = _write_temp_config(config.config_yaml)
        else:
            return JSONResponse({ 'error': 'no config provided' }, status_code=400)

        out = _run_bidsify(['--report'], cfg_src)
        return JSONResponse(out)
    finally:
        try:
            if cfg_tmp and os.path.exists(cfg_tmp):
                os.unlink(cfg_tmp)
        except Exception:
            pass


@app.get('/api/ping')
async def ping():
    return { 'ok': True }


def _safe_path(path: str) -> Optional[str]:
    """Return an absolute path for `path` that is constrained under REPO_ROOT.
    Returns None if the computed path would escape REPO_ROOT.
    """
    if not path:
        return None
    # Support several path types for convenience:
    #  - Paths starting with '~' are expanded to the requesting user's home (os.path.expanduser) and accepted.
    #  - Absolute paths starting with '/' are accepted.
    #  - Otherwise paths are treated as repository-relative and resolved under REPO_ROOT.
    # NOTE: accepting user home / absolute paths gives broader file access — ensure you run the
    # server in a trusted environment when doing so.
    if path.startswith('~'):
        # expand tilde to home directory
        abs_candidate = os.path.abspath(os.path.expanduser(path))
        return abs_candidate

    if os.path.isabs(path):
        abs_candidate = os.path.abspath(path)
        return abs_candidate

    # allow user-specified relative paths under REPO_ROOT
    abs_candidate = os.path.abspath(os.path.join(REPO_ROOT, os.path.normpath(path).lstrip('/')))
    if os.path.commonpath([REPO_ROOT, abs_candidate]) != REPO_ROOT:
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
    payload: { path: <relative path> }
    """
    p = payload.get('path', '.')
    safe = _safe_path(p)
    if not safe:
        return JSONResponse({ 'error': 'invalid path (outside repo root or empty)' }, status_code=400)
    if not os.path.isdir(safe):
        return JSONResponse({ 'error': 'directory not found', 'path': p }, status_code=404)
    try:
        items = []
        for name in sorted(os.listdir(safe)):
            ap = os.path.join(safe, name)
            items.append({ 'name': name, 'path': os.path.join(p, name), 'is_dir': os.path.isdir(ap), 'size': os.path.getsize(ap) if os.path.isfile(ap) else None })
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
    if req.config_path:
        safe = _safe_path(req.config_path)
        if not safe or not os.path.exists(safe):
            return JSONResponse({ 'error': 'invalid or missing config_path' }, status_code=400)
        fd, cfg_temp_copy = tempfile.mkstemp(suffix='.yml', prefix='natmeg_config_')
        os.close(fd)
        shutil.copy2(safe, cfg_temp_copy)
        try:
            _normalize_config_file(cfg_temp_copy)
        except Exception:
            pass
        cfg_path = cfg_temp_copy
    elif req.config_yaml:
        cfg_path = _write_temp_config(req.config_yaml)
    else:
        return JSONResponse({ 'error': 'no config provided' }, status_code=400)

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

    # Persist a copy of the exact config used to disk under logs/jobs/<job_id>/
    # for easy retrieval / traceability
    try:
        job_cfg_dir = os.path.join(REPO_ROOT, 'logs', 'jobs', job_id)
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
            try:
                with open(cfg_path, 'r') as f:
                    cfg_obj = yaml.safe_load(f)
            except Exception:
                cfg_obj = None

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
                    candidates.append(os.path.join(bids_path, 'logs', conv_name))
                    candidates.append(os.path.join(bids_path, 'conversion_logs', conv_name))
                    candidates.append(os.path.join(bids_path, conv_name))

                # As a final fallback probe the repository-level logs folder
                candidates.append(os.path.join(REPO_ROOT, 'logs', conv_name))
                candidates.append(os.path.join(REPO_ROOT, 'logs', 'bids_results.json'))

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
            try:
                os.unlink(cfg_path)
            except Exception:
                pass
            try:
                if cfg_temp_copy and os.path.exists(cfg_temp_copy):
                    os.unlink(cfg_temp_copy)
            except Exception:
                pass

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

