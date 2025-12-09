// Job and execution related logic (create jobs, WebSocket fallback, job list)
// app-jobs loader
(function(){
  // job module loader — no top-level side effects
  function sendClientLog(obj){ try { fetch('/api/client-log', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(obj) }); } catch(e){} }

  // Helper that returns the output <pre> element inside the active main view
  function _getVisibleOutputElement(){
    try {
      const views = ['main-execute', 'main-editor', 'main-config', 'main-report'];
      for (const id of views){
        const el = document.getElementById(id);
        if (el && !el.classList.contains('view-hidden')){
            // Prefer reportOutput for the report page
            const out = el.querySelector('#output') || el.querySelector('#reportOutput');
          if (out) return out;
        }
      }
    } catch (e) { /* ignore */ }
    return document.getElementById('output');
  }

  // Generic progress state helper (zone = 'editor'|'execute')
  function _setProgressState(zoneOrAction, state, text){
    // allow calling with action name or zone
      const zone = (zoneOrAction === 'analyse' || zoneOrAction === 'editor') ? 'editor' : (zoneOrAction === 'report' ? 'report' : 'execute');
    const container = document.getElementById(zone + 'ProgressContainer');
    const bar = document.getElementById(zone + 'ProgressBar');
    const t = document.getElementById(zone + 'ProgressText');
    if (!container || !bar || !t) return;
    if (state === 'start'){
      container.style.display = 'block';
      bar.classList.remove('failed');
      bar.classList.remove('complete');
      bar.parentElement.classList.remove('complete');
      bar.parentElement.classList.add('indeterminate');
      t.textContent = text || 'Running...';
    } else if (state === 'complete'){
      bar.parentElement.classList.remove('indeterminate');
      bar.parentElement.classList.add('complete');
      bar.classList.remove('failed');
      t.textContent = text || 'Completed';
    } else if (state === 'failed'){
      bar.parentElement.classList.remove('indeterminate');
      bar.classList.add('failed');
      bar.parentElement.classList.add('complete');
      t.textContent = text || 'Failed';
    } else if (state === 'idle'){
      container.style.display = 'none';
      t.textContent = text || 'Idle';
    }
  }

  // Helper used to schedule UI 'idle' transitions without creating stray
  // timers in test runs. When running under Jest we avoid scheduling long
  // lived timeouts that keep the Node event loop alive; tests can rely on
  // immediate state checks instead of delayed UI transitions.
  function _scheduleIdle(action, delay){
    try {
      if (typeof process !== 'undefined' && process.env && process.env.JEST_WORKER_ID) return; // avoid creating timers in tests
      setTimeout(() => _setProgressState(action, 'idle'), delay);
    } catch(e) { /* ignore */ }
  }

  async function createJob(action) {
    const status = document.getElementById('status');
    // use top-level _getVisibleOutputElement()

    const output = _getVisibleOutputElement();
    try { sendClientLog({ message: 'createJob-click', action }); } catch(e){}
    // Prefer a saved server-side config path (if present) so the server runs the
    // same file CLI would use for traceability. Fall back to sending inline YAML
    // when no saved path exists.
    let payload = null;
    try {
      if (window.AppConfig && typeof window.AppConfig.buildJobPayload === 'function') {
        payload = window.AppConfig.buildJobPayload(action);
      }
    } catch (e) { payload = null; }
    if (!payload) {
      const cfgYaml = (window.AppConfig && typeof window.AppConfig.writeFormToYaml === 'function') ? window.AppConfig.writeFormToYaml() : (document.getElementById('configText')?.value || '');
      if (!cfgYaml || !String(cfgYaml).trim()) { alert('Please provide a configuration via the form or upload a YAML before running.'); return; }
      payload = { config_yaml: cfgYaml, action };
    }
      // rely on global _setProgressState(zoneOrAction, state, text)
    // Do NOT switch to the Execute view automatically — keep output in-place
    // (This allows the editor/table view to host console output and keeps context stable.)
    status.textContent = 'Queued…'; output.textContent = `Starting ${action}...\n`;

    try {
      const res = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const json = await res.json(); if (!res.ok) { const err = json?.error || JSON.stringify(json); output.textContent = 'Server error: ' + err; status.textContent = 'ERROR'; console.error('Job creation failed', res.status, json); return; }
      if (!json.job_id) throw new Error('No job_id returned by server');
        const jobId = json.job_id; sendClientLog({ message:'job-created', jobId, action }); status.textContent = `Running (job ${jobId})`;
        // Do not auto-open the report view; keep view switching under user control.
        // bind job id to the visible output and enable Stop button for the relevant zone
        try {
           const zone = (action === 'analyse') ? 'editor' : (action === 'report' ? 'report' : 'execute');
          const outputEl = _getVisibleOutputElement();
          if (outputEl) outputEl.dataset.jobId = jobId;
          const stopBtn = document.getElementById(zone + 'StopBtn');
          if (stopBtn) { stopBtn.disabled = false; stopBtn.dataset.jobId = jobId; }
        } catch (e) { /* ignore UI binding errors */ }

      const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/ws/jobs/${jobId}/logs`);
      
        ws.onopen = () => { const out = _getVisibleOutputElement(); if (out) out.textContent += `\n[ws] connected to job ${jobId}\n`; // show progress immediately
          _setProgressState(action, 'start', `Running (job ${jobId})`);
        };
      let jobDone = false; let pollTimer = null;
      function startPollingFallback(){
        if (pollTimer) return;
        let tries = 0;
        pollTimer = setInterval(async () => {
          tries++;
          try {
            const resp = await fetch(`/api/jobs/${jobId}/logs`);
            if (!resp.ok) return;
            const j = await resp.json();
            (j.logs || []).forEach(l => { const out = _getVisibleOutputElement(); if (out) out.textContent += (typeof l === 'string' ? l : l.line); });

            const sresp = await fetch(`/api/jobs/${jobId}`);
            if (sresp.ok) {
              const sj = await sresp.json();
              if (sj.status === 'completed' || sj.status === 'failed') {
                jobDone = true;
                clearInterval(pollTimer);
                pollTimer = null;
                status.textContent = sj.status === 'completed' ? 'Completed' : 'Failed (polled)';

                try {
                  const aresp = await fetch(`/api/jobs/${jobId}/artifacts`);
                  const aj = await aresp.json();
                  if (aj.artifacts && aj.artifacts.length) {
                    const artifactsDiv = (action === 'report') ? document.getElementById('reportArea') : document.getElementById('artifacts');
                    if (artifactsDiv) {
                      artifactsDiv.innerHTML = '';
                      // Do not auto-open report view when artifacts appear — keep UI navigation manual
                    }
                    aj.artifacts.forEach((p, i) => {
                      if (action === 'report' && p.toLowerCase().includes('bids_results')) { if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppJobs] polling detected bids_results artifact', p, 'for job', jobId); }
                      const link = `${location.origin}/api/jobs/${jobId}/artifact?index=${i}`;
                      const el = document.createElement('div');
                      el.innerHTML = `Artifact ${i}: <a href='${link}' target='_blank'>${p}</a>` + (p.toLowerCase().endsWith('.tsv') ? ` <button class='btn' onclick="loadArtifact('${jobId}', ${i})">Open in editor</button>` : '');
                      artifactsDiv.appendChild(el);
                      // If this seems to be a bids_results.json artifact and we are in report action,
                      // attempt to fetch and render it.
                      if (action === 'report' && p.toLowerCase().includes('bids_results')){
                        if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppJobs] detected bids_results artifact', p, 'for job', jobId);
                        (async () => {
                          try {
                            const r = await fetch(link);
                            if (!r.ok) return;
                            const obj = await r.json();
                            // If AppReport is not present yet, cache the parsed payload
                            // so a later-loaded AppReport module can pick it up.
                            try {
                              if (!window.AppReport || typeof window.AppReport.updateStats !== 'function'){
                                window._lastReportCandidates = window._lastReportCandidates || [];
                                if (!window._lastReportCandidates.includes(p)) window._lastReportCandidates.push(p);
                                window._lastReportPayloads = window._lastReportPayloads || {};
                                window._lastReportPayloads[p] = obj;
                                try { window.dispatchEvent(new CustomEvent('AppConfigDeferred', { detail: { candidates: [p], candidate: p, payload: obj } })); } catch(e){}
                                if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppJobs] cached bids_results payload for late AppReport', p);
                              }
                            } catch(e){}
                            if (window.AppReport && typeof window.AppReport.updateStats === 'function'){
                              const subjectsCount = obj.subjects && typeof obj.subjects === 'object' ? Object.keys(obj.subjects).length : (Array.isArray(obj.subjects) ? obj.subjects.length : (obj.summary?.subjects || obj.n_subjects || null));
                              let sessionsCount = null;
                              try {
                                if (obj.subjects && typeof obj.subjects === 'object'){
                                  const sset = new Set();
                                  Object.values(obj.subjects).forEach(sub => { if (sub.sessions && typeof sub.sessions === 'object') Object.keys(sub.sessions).forEach(k=>sset.add(k)); });
                                  sessionsCount = sset.size;
                                }
                              } catch(e){}
                              let tasksCount = null;
                              try {
                                const tset = new Set();
                                if (obj.subjects && typeof obj.subjects === 'object'){
                                  Object.values(obj.subjects).forEach(sub=>{ if (sub.sessions && typeof sub.sessions === 'object'){ Object.values(sub.sessions).forEach(sess=>{ if (Array.isArray(sess.tasks)){ sess.tasks.forEach(t=>tset.add(t)); } }); } });
                                  tasksCount = tset.size;
                                }
                              } catch(e){}
                              window.AppReport.updateStats({ subjects: subjectsCount, sessions: sessionsCount, tasks: tasksCount });
                              const rootPath = obj.bids_root || obj.bids_path || obj.root || obj.projectRoot || 'BIDS';
                              try { if (window.AppReport && typeof window.AppReport.renderTree === 'function') window.AppReport.renderTree(rootPath, obj); } catch(e){}
                            }
                          } catch (e) { console.warn('failed to fetch bids_results', e); }
                        })();
                      }
                    });
                  }
                  // update progress UI
                  if (sj.status === 'completed') {
                    _setProgressState(action, 'complete', 'Completed');
                    // disable stop button when finished
                    try { const zone = (action === 'analyse') ? 'editor' : (action === 'report' ? 'report' : 'execute'); const sb = document.getElementById(zone + 'StopBtn'); if (sb && sb.dataset.jobId === jobId) sb.disabled = true; } catch(e){}
                    // hide after a short delay
                    _scheduleIdle(action, 4000);
                  } else {
                    _setProgressState(action, 'failed', 'Failed (polled)');
                    try { const zone = (action === 'analyse') ? 'editor' : (action === 'report' ? 'report' : 'execute'); const sb = document.getElementById(zone + 'StopBtn'); if (sb && sb.dataset.jobId === jobId) sb.disabled = true; } catch(e){}
                    _scheduleIdle(action, 8000);
                  }
                } catch (e) {
                  console.warn('fetch artifacts failed', e);
                }
              }
            }

            if (tries > 600) {
              clearInterval(pollTimer);
              pollTimer = null;
            }
          } catch (e) {
            console.warn('poll fallback error', e);
          }
        }, 1000);
      }

      
            ws.onmessage = async (ev) => {
              const out = _getVisibleOutputElement();
              if (out) {
                out.textContent += ev.data;
                out.scrollTop = out.scrollHeight;
              }

              if (typeof ev.data === 'string' && ev.data.startsWith('__JOB_DONE__')) {
                // parse returncode from the message
                let rc = null;
                const m = ev.data.match(/returncode=(\d+)/);
                if (m) rc = parseInt(m[1], 10);

                if (rc === 0) {
                  status.textContent = 'Completed';
                  _setProgressState(action, 'complete', 'Completed');
                  try { const zone = (action === 'analyse') ? 'editor' : (action === 'report' ? 'report' : 'execute'); const sb = document.getElementById(zone + 'StopBtn'); if (sb && sb.dataset.jobId === jobId) sb.disabled = true; } catch(e){}
                    _scheduleIdle(action, 4000);
                } else {
                  status.textContent = 'Failed';
                  _setProgressState(action, 'failed', 'Failed');
                  try { const zone = (action === 'analyse') ? 'editor' : (action === 'report' ? 'report' : 'execute'); const sb = document.getElementById(zone + 'StopBtn'); if (sb && sb.dataset.jobId === jobId) sb.disabled = true; } catch(e){}
                  _scheduleIdle(action, 8000);
                }

                try {
                  const resp = await fetch(`/api/jobs/${jobId}/artifacts`);
                  const j = await resp.json();
                  if (j.artifacts && j.artifacts.length > 0) {
                    const out2 = _getVisibleOutputElement();
                    if (out2) out2.textContent += '\n\nArtifacts:\n';
                    // If we're in report action, populate reportArea instead
                    const artifactsDiv = (action === 'report') ? document.getElementById('reportArea') : document.getElementById('artifacts');
                    if (artifactsDiv) {
                      artifactsDiv.innerHTML = '';
                      // Do not auto-open report view when artifacts are fetched — keep navigation manual
                    }
                    j.artifacts.forEach((p, i) => {
                      const link = `${location.origin}/api/jobs/${jobId}/artifact?index=${i}`;
                      const out3 = _getVisibleOutputElement();
                      if (out3) out3.textContent += `${i}: ${p} -> ${link}\n`;
                      const el = document.createElement('div');
                      el.innerHTML = `Artifact ${i}: <a href="${link}" target="_blank">${p}</a>` + (p.toLowerCase().endsWith('.tsv') ? ` <button class="btn" onclick="loadArtifact('${jobId}', ${i})">Open in editor</button>` : '');
                      if (artifactsDiv) artifactsDiv.appendChild(el);
                      // If report action, and the artifact looks like JSON/HTML/TSV, try to render a nice preview
                      if (action === 'report') {
                        (async () => {
                          try {
                            if (p.toLowerCase().endsWith('.json')) {
                              const r = await fetch(link);
                                if (r.ok) {
                                const obj = await r.json();
                                // Cache for late-loaded AppReport if it's missing
                                try {
                                  if (!window.AppReport || typeof window.AppReport.updateStats !== 'function'){
                                    const k = p;
                                    window._lastReportCandidates = window._lastReportCandidates || [];
                                    if (!window._lastReportCandidates.includes(k)) window._lastReportCandidates.push(k);
                                    window._lastReportPayloads = window._lastReportPayloads || {};
                                    window._lastReportPayloads[k] = obj;
                                    try { window.dispatchEvent(new CustomEvent('AppConfigDeferred', { detail: { candidates: [k], candidate: k, payload: obj } })); } catch(e){}
                                    if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppJobs] cached bids_results payload (preview) for later pickup', k);
                                  }
                                } catch(e){}
                                const pretty = `<pre style="background:#fafafa;color:#111;padding:12px;border-radius:6px;overflow:auto;max-height:240px">${JSON.stringify(obj, null, 2)}</pre>`;
                                const s = document.createElement('div'); s.innerHTML = `<h4>${p.split('/').pop()}</h4>${pretty}`; artifactsDiv.appendChild(s);
                                // Special-case bids_results.json: populate summary and tree view
                                try {
                                  if (action === 'report' && p.toLowerCase().includes('bids_results')){
                                    if (window.AppReport && typeof window.AppReport.updateStats === 'function'){
                                      // derive counts
                                      const subjectsCount = obj.subjects && typeof obj.subjects === 'object' ? Object.keys(obj.subjects).length : (Array.isArray(obj.subjects) ? obj.subjects.length : (obj.summary?.subjects || obj.n_subjects || null));
                                      let sessionsCount = null; try { if (obj.subjects && typeof obj.subjects === 'object') { const sset = new Set(); Object.values(obj.subjects).forEach(sub => { if (sub.sessions && typeof sub.sessions === 'object') Object.keys(sub.sessions).forEach(k=>sset.add(k)); }); sessionsCount = sset.size; } } catch(e){}
                                      let tasksCount = null; try { const tset = new Set(); if (obj.subjects && typeof obj.subjects === 'object'){ Object.values(obj.subjects).forEach(sub=>{ if (sub.sessions && typeof sub.sessions === 'object'){ Object.values(sub.sessions).forEach(sess=>{ if (Array.isArray(sess.tasks)){ sess.tasks.forEach(t=>tset.add(t)); } }); } }); tasksCount = tset.size; } } catch(e){}
                                      window.AppReport.updateStats({ subjects: subjectsCount, sessions: sessionsCount, tasks: tasksCount });
                                      const rootPath = obj.bids_root || obj.bids_path || obj.root || obj.projectRoot || 'BIDS';
                                      try { if (window.AppReport && typeof window.AppReport.renderTree === 'function') window.AppReport.renderTree(rootPath, obj); } catch(e){}
                                    }
                                  }
                                } catch(e){ /* ignore */ }
                              }
                            } else if (p.toLowerCase().endsWith('.html')) {
                              const r = await fetch(link);
                              if (r.ok) {
                                const html = await r.text();
                                const frame = document.createElement('iframe'); frame.style.width='100%'; frame.style.height='320px'; frame.style.border='1px solid #ddd'; frame.srcdoc = html; artifactsDiv.appendChild(frame);
                              }
                            } else if (p.toLowerCase().endsWith('.tsv')) {
                              const r = await fetch(link);
                              if (r.ok) {
                                const text = await r.text();
                                const rows = text.split('\n').slice(0,8).map(r=>r.split('\t'));
                                const table = document.createElement('table'); table.style.width='100%'; table.style.borderCollapse='collapse'; table.style.fontSize='12px';
                                rows.forEach((row, ridx) => {
                                  const tr = document.createElement('tr'); row.forEach(c=>{ const td = document.createElement(ridx===0 ? 'th' : 'td'); td.textContent = c; td.style.border='1px solid #eee'; td.style.padding='6px'; tr.appendChild(td); }); table.appendChild(tr);
                                });
                                const wrap = document.createElement('div'); wrap.appendChild(table); artifactsDiv.appendChild(wrap);
                              }
                            }
                          } catch (e) { console.warn('render artifact preview failed', e); }
                        })();
                      }
                    });
                  }

                  if (action === 'analyse' && j.artifacts && j.artifacts.length > 0) {
                    const tsvIndex = j.artifacts.findIndex(a => a.toLowerCase().endsWith('.tsv'));
                    if (tsvIndex >= 0) {
                      try {
                        const resp = await fetch(`/api/jobs/${jobId}/artifact?index=${tsvIndex}`);
                        if (resp.ok) {
                          const tsvText = await resp.text();
                          openTableEditor(tsvText, j.artifacts[tsvIndex].split('/').pop());
                          document.getElementById('saveTablePath').value = j.artifacts[tsvIndex];
                          document.getElementById('tableEditor').style.display = 'block';
                        }
                      } catch (e) { console.warn('Failed to auto-open tsv', e); }
                    }
                  }
                } catch (e) { console.warn('Failed to fetch artifacts', e); }

                ws.close();
              }
            };
      ws.onclose = (e) => { if (!jobDone) startPollingFallback(); };
      ws.onerror = (e) => { startPollingFallback(); };
      setTimeout(()=>{ if (!jobDone && ws.readyState !== WebSocket.OPEN) startPollingFallback(); }, 1500);

    } catch (err) { console.error('Failed to create job', err); const out = _getVisibleOutputElement(); if (out) out.textContent = 'Client error: ' + String(err); document.getElementById('status').textContent = 'ERROR'; }
  }

  // Stop a running job (abort/terminate); server will attempt to terminate subprocess
  async function stopJob(jobId){
    if (!jobId) return;
    try {
      // Disable any stop buttons for this job to avoid double-requests
      document.querySelectorAll(`[data-job-id="${jobId}"]`).forEach(el => { try { el.disabled = true; } catch(e){} });
      const resp = await fetch(`/api/jobs/${jobId}/stop`, { method: 'POST' });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        console.warn('Stop request failed', j);
        // try to re-enable button if it still belongs to current job
        document.querySelectorAll(`[data-job-id="${jobId}"]`).forEach(el => { try { el.disabled = false; } catch(e){} });
        return;
      }
      // inform user in the relevant output console
      const out = document.querySelector(`[data-job-id="${jobId}"]`);
      if (out) {
        try { out.textContent += `\n[STOP] Job ${jobId} aborted by user\n`; out.scrollTop = out.scrollHeight; } catch(e){}
      }
      // mark status
      try { const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = 'Aborted'; } catch(e){}
    } catch (e) {
      console.warn('stopJob failed', e);
    }
  }

  async function refreshJobList(){ try { const res = await fetch('/api/jobs'); const j = await res.json(); const div = document.getElementById('jobList'); if (!div) return; div.innerHTML=''; (j.jobs||[]).slice().reverse().forEach(job=>{ const el = document.createElement('div'); el.style.padding='4px 6px'; el.innerHTML = `<div class="between"><div><small>${job.id}</small> <strong>${job.status}</strong></div><div><button class='btn' onclick="openJob('${job.id}')">Open</button></div></div>`; div.appendChild(el); }); } catch(e){ console.warn('Failed to refresh job list', e); } }

  async function openJob(id){
    try {
      const resp = await fetch(`/api/jobs/${id}`);
      const j = await resp.json();
                  // (removed stray returncode-parsing snippet)
      if (!resp.ok) { alert('Job not found'); return; }

      // Ensure the execute view is visible and pick the visible output box
      document.getElementById('main-execute')?.classList.remove('view-hidden');
      const output = _getVisibleOutputElement();
      if (output) output.textContent = `Job ${id}: status=${j.status} returncode=${j.returncode} logs=${j.logs_count}\n` + (output.textContent || '');
      // Update progress UI based on job status
      if (j.status === 'running' || j.status === 'queued') {
        _setProgressState(j.action || 'run', 'start', j.status === 'queued' ? 'Queued' : 'Running');
      } else if (j.status === 'completed') {
        _setProgressState(j.action || 'run', 'complete', 'Completed');
      } else if (j.status === 'failed') {
        _setProgressState(j.action || 'run', 'failed', 'Failed');
      } else {
        _setProgressState(j.action || 'run', 'idle', 'Idle');
      }

      try {
        const logsResp = await fetch(`/api/jobs/${id}/logs`);
        if (logsResp.ok){
          const logsJson = await logsResp.json();
          (logsJson.logs||[]).forEach(l => { if (output) output.textContent += `[${l.stream||'out'}] ${l.line}`; });
        }
      } catch(e){ console.warn('fetch logs failed', e); }

      const aresp = await fetch(`/api/jobs/${id}/artifacts`);
      const aj = await aresp.json();
      const artifactsDiv = document.getElementById('artifacts');
      artifactsDiv.innerHTML='';
      (aj.artifacts||[]).forEach((p,i)=>{ const link = `${location.origin}/api/jobs/${id}/artifact?index=${i}`; const el = document.createElement('div'); el.innerHTML = `Artifact ${i}: <a href='${link}' target='_blank'>${p}</a>` + (p.toLowerCase().endsWith('.tsv') ? ` <button class='btn' onclick="loadArtifact('${id}', ${i})">Open in editor</button>` : ''); artifactsDiv.appendChild(el);
        if (p.toLowerCase().includes('bids_results')){
          (async () => {
            try {
              const r = await fetch(link);
              if (!r.ok) return;
              const obj = await r.json();
              // Cache payload if AppReport isn't present so late-loaded AppReport
              // can pick it up via the deferred caches
              try {
                if (!window.AppReport || typeof window.AppReport.updateStats !== 'function'){
                  window._lastReportCandidates = window._lastReportCandidates || [];
                  if (!window._lastReportCandidates.includes(p)) window._lastReportCandidates.push(p);
                  window._lastReportPayloads = window._lastReportPayloads || {};
                  window._lastReportPayloads[p] = obj;
                  try { window.dispatchEvent(new CustomEvent('AppConfigDeferred', { detail: { candidates: [p], candidate: p, payload: obj } })); } catch(e){}
                  if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppJobs] cached bids_results payload (openJob) for later pickup', p);
                }
              } catch(e){}

              if (window.AppReport && typeof window.AppReport.updateStats === 'function'){
                const subjectsCount = obj.subjects && typeof obj.subjects === 'object' ? Object.keys(obj.subjects).length : (Array.isArray(obj.subjects) ? obj.subjects.length : (obj.summary?.subjects || obj.n_subjects || null));
                let sessionsCount = null;
                try { if (obj.subjects && typeof obj.subjects === 'object') { const sset = new Set(); Object.values(obj.subjects).forEach(sub => { if (sub.sessions && typeof sub.sessions === 'object') Object.keys(sub.sessions).forEach(k=>sset.add(k)); }); sessionsCount = sset.size; } } catch(e){}
                let tasksCount = null;
                try { const tset = new Set(); if (obj.subjects && typeof obj.subjects === 'object'){ Object.values(obj.subjects).forEach(sub=>{ if (sub.sessions && typeof sub.sessions === 'object'){ Object.values(sub.sessions).forEach(sess=>{ if (Array.isArray(sess.tasks)){ sess.tasks.forEach(t=>tset.add(t)); } }); } }); tasksCount = tset.size; } } catch(e){}
                window.AppReport.updateStats({ subjects: subjectsCount, sessions: sessionsCount, tasks: tasksCount });
                const rootPath = obj.bids_root || obj.bids_path || obj.root || obj.projectRoot || 'BIDS';
                try { if (window.AppReport && typeof window.AppReport.renderTree === 'function') window.AppReport.renderTree(rootPath, obj); } catch(e){}
              }
            } catch(e) { console.warn('fetch bids_results on openJob failed', e); }
          })();
        }
      });
    } catch(err){ alert('Failed to open job: ' + err.message); }
  }

  window.addEventListener('DOMContentLoaded', () => {
    // attach to execute view buttons (now placed inside main-execute)
    document.getElementById('analyzeBtn')?.addEventListener('click', () => createJob('analyse'));
    document.getElementById('runBtn')?.addEventListener('click', () => createJob('run'));
    document.getElementById('reportBtn')?.addEventListener('click', () => createJob('report'));
    document.getElementById('runBidsifyBtn')?.addEventListener('click', () => createJob('run'));
    // Stop buttons
    document.getElementById('editorStopBtn')?.addEventListener('click', (ev) => { ev.preventDefault(); const id = ev.currentTarget?.dataset?.jobId; if (id) stopJob(id); });
    document.getElementById('executeStopBtn')?.addEventListener('click', (ev) => { ev.preventDefault(); const id = ev.currentTarget?.dataset?.jobId; if (id) stopJob(id); });
    document.getElementById('reportStopBtn')?.addEventListener('click', (ev) => { ev.preventDefault(); const id = ev.currentTarget?.dataset?.jobId; if (id) stopJob(id); });
    try {
      // run once immediately to populate the UI
      refreshJobList();
      // In test runs (jest), avoid creating a long-lived interval which keeps
      // the Node process alive and prevents Jest from exiting.
      if (!(typeof process !== 'undefined' && process.env && process.env.JEST_WORKER_ID)) {
        setInterval(refreshJobList, 4000);
      }
    } catch(e) { /* ignore */ }
  });

  window.AppJobs = { createJob, refreshJobList, openJob, stopJob };
  // AppJobs API attached to window
})();
