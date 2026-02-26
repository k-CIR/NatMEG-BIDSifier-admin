// Config related UI helpers (file upload, load/save config, YAML <> form glue)
(function(){
  function sendClientLog(obj){ try { fetch('/api/client-log', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(obj) }); } catch(e){} }

  // Ensure deferred-report caches exist early so any part of the app can
  // safely populate them even if scripts load in an unexpected order.
  try { window._lastReportCandidates = window._lastReportCandidates || []; } catch(e){}
  try { window._lastReportPayloads = window._lastReportPayloads || {}; } catch(e){}

  // Deterministic YAML parsing for known keys. This is intentionally explicit —
  // we do not attempt to "guess" mappings. Accepts YAML-like text where
  // top-level sections (Project, Dataset_description, BIDS) are optionally
  // present and filled.
  function parseSimpleYaml(text) {
    const res = {
      project_name: '', cir_id: '', ssh_server: '', root: '', tasks: '', raw: '', bids: '', calibration: '', crosstalk: '', conversion_file: '',
      dataset_name: '', bids_version: '', dataset_type: '', license: '', authors: '', acknowledgements: '', how_to_acknowledge: '', funding: '', ethics_approvals: '', references_links: '', dataset_doi: '', code_url: ''
    };

    if (!text || !text.trim()) return res;

    // helper: extract indented block under a top-level key
    const getBlock = (name) => {
      const re = new RegExp('^' + name.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + ':\\s*\\n((?:\\s+.+\\n?)*)', 'm');
      const m = text.match(re);
      return m ? m[1] : '';
    };

    const getKey = (source, key) => {
      if (!source) return '';
      const re = new RegExp('^\\s*' + key.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + ':\\s*(.+)$', 'm');
      const m = source.match(re);
      return m ? m[1].trim() : '';
    };

    // Top-level simple keys
    const top = (k) => { const m = text.match(new RegExp('^' + k.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + ':\\s*(.+)$', 'm')); return m ? m[1].trim() : ''; };

    // Project block
    const projectBlock = getBlock('Project');
    res.project_name = getKey(projectBlock, 'Name') || top('Project\.?Name') || res.project_name;
    res.cir_id = getKey(projectBlock, 'CIR-ID') || top("CIR-ID") || res.cir_id;
    // Root is often in Project or at top-level
    res.root = getKey(projectBlock, 'Root') || top('Root') || res.root;
    // Raw/BIDS paths
    res.raw = getKey(projectBlock, 'Raw') || getKey(projectBlock, 'RawPath') || top('Raw') || top('RawPath') || res.raw;
    res.bids = getKey(projectBlock, 'BIDS') || getKey(projectBlock, 'BIDSPath') || top('BIDS') || top('BIDSPath') || res.bids;
    res.calibration = getKey(projectBlock, 'Calibration') || getKey(projectBlock, 'CalibrationPath') || res.calibration;
    res.crosstalk = getKey(projectBlock, 'Crosstalk') || getKey(projectBlock, 'CrosstalkPath') || res.crosstalk;

    // Tasks may be a list (YAML style with - item) or comma-separated; try extraction
    const tasksLine = getKey(projectBlock, 'Tasks') || top('Tasks') || '';
    // Try to capture an indented dash list under "Tasks:" inside the project block
    const getList = (source, key) => {
      if (!source) return [];
      const re = new RegExp('^\\s*' + key.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + ':\\s*\\n((?:\\s*-\\s+.*\\n?)*)', 'm');
      const m = source.match(re);
      if (!m || !m[1]) return [];
      return m[1].split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
        // remove leading dash/whitespace and any surrounding single/double quotes
        const item = l.replace(/^[-\s]+/, '').trim();
        return item.replace(/^['"]|['"]$/g, '').trim();
      });
    };

    const tasksList = getList(projectBlock, 'Tasks');
    if (tasksList.length) res.tasks = tasksList.join(', ');
    else res.tasks = Array.isArray(tasksLine) ? tasksLine.join(', ') : tasksLine;

    // Dataset description block
    const ddBlock = getBlock('Dataset_description') || getBlock('Dataset description') || getBlock('Dataset_description') || '';
    res.dataset_name = getKey(ddBlock, 'Name') || top('Dataset Name') || res.dataset_name;
    res.bids_version = getKey(ddBlock, 'BIDSVersion') || getKey(ddBlock, 'BIDS Version') || top('BIDS Version') || res.bids_version;
    res.dataset_type = getKey(ddBlock, 'DatasetType') || getKey(ddBlock, 'Dataset Type') || top('Dataset Type') || res.dataset_type;
    res.license = getKey(ddBlock, 'License') || getKey(ddBlock, 'data_license') || top('License') || res.license;
    res.authors = getKey(ddBlock, 'Authors') || getKey(ddBlock, 'authors') || res.authors;
    res.acknowledgements = getKey(ddBlock, 'Acknowledgements') || res.acknowledgements;
    res.how_to_acknowledge = getKey(ddBlock, 'HowToAcknowledge') || getKey(ddBlock, 'How to Acknowledge') || res.how_to_acknowledge;
    res.funding = getKey(ddBlock, 'Funding') || res.funding;
    res.ethics_approvals = getKey(ddBlock, 'EthicsApprovals') || getKey(ddBlock, 'Ethics Approvals') || res.ethics_approvals;
    res.references_links = getKey(ddBlock, 'ReferencesAndLinks') || getKey(ddBlock, 'References and Links') || res.references_links;
    res.dataset_doi = getKey(ddBlock, 'DatasetDOI') || getKey(ddBlock, 'doi') || res.dataset_doi;
    res.code_url = getKey(ddBlock, 'GeneratedBy') ? getKey(ddBlock, 'GeneratedBy') : res.code_url;

    // BIDS block
    const bidsBlock = getBlock('BIDS') || '';
    res.conversion_file = getKey(bidsBlock, 'Conversion_file') || getKey(bidsBlock, 'Conversion_file') || getKey(bidsBlock, 'Conversion_file') || top('Conversion_file') || res.conversion_file;
    // fallback: other conversion names
    res.conversion_file = res.conversion_file || top('Conversion_file') || top('Conversion File') || res.conversion_file;

    // dataset_description filename may be under BIDS block
    res.dataset_description = getKey(bidsBlock, 'Dataset_description') || getKey(bidsBlock, 'Dataset_description') || top('Dataset_description') || top('Dataset Description') || '';

    // SSH server top-level
    res.ssh_server = top('SSH Server') || top('SSH') || res.ssh_server;

    return res;
  }

  async function populateFormFromYaml(configSource) {
    if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] populateFormFromYaml invoked');
    try {
      // accept either a textarea element or a raw string
      const text = typeof configSource === 'string' ? configSource : (configSource?.value || '');
      const data = parseSimpleYaml(text);
      if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] parsed YAML summary', { project_name: data.project_name, root: data.root, bids: data.bids, conversion_file: data.conversion_file });
      const map = {
        project_name: 'config_project_name', root: 'config_root_path', tasks:'config_tasks', raw:'config_raw_path', bids:'config_bids_path',
        calibration:'config_calibration_path', crosstalk:'config_crosstalk_path', conversion_file:'config_conversion_file', dataset_name:'config_dataset_name',
        bids_version:'config_bids_version', dataset_type:'config_dataset_type', license:'config_license', authors:'config_authors'
      };
      // dataset_description filename + BIDS path
      map.dataset_description = 'config_dataset_description_file';
      // support cir id + ssh server in the mapping
      if (data.cir_id) map.cir_id = 'config_cir_id';
      if (data.ssh_server) map.ssh_server = 'config_ssh_server';
      // Populate known form fields deterministically (do NOT guess other mappings)
      // parsed YAML data (kept out of noisy logs in production)
      Object.entries(map).forEach(([k,id])=>{ const el = document.getElementById(id); if (el) {
        const v = data[k];
        // show blank for null or empty-string-like values (do not use 'empty' sentinel)
        if (v === null || v === '' || v === "''" || v === '""') el.value = '';
        else if (Array.isArray(v)) el.value = v.join(', ');
        else el.value = String(v);
      } });
      // additional dataset_description & misc fields
      const extras = {
        acknowledgements: 'config_acknowledgements', how_to_acknowledge: 'config_how_to_acknowledge', funding: 'config_funding', ethics_approvals: 'config_ethics_approvals', references_links: 'config_references_links', dataset_doi: 'config_dataset_doi', code_url: 'config_code_url'
      };
      Object.entries(extras).forEach(([k,id]) => { const el = document.getElementById(id); if (el) {
      const vv = data[k]; if (vv === null || vv === '' || vv === "''" || vv === '""') el.value = ''; else el.value = String(vv || '');
      } });

      // If Conversion_file is empty, compute a default path from Project Root + Project Name
      // Store in a hidden field that the Editor and YAML serialization can access
      let conversionFilePath = data.conversion_file || '';
      
      const root = (document.getElementById('config_root_path')?.value || '').trim();
      const projName = (document.getElementById('config_project_name')?.value || '').trim();
      
      if (!conversionFilePath && root && projName) {
        conversionFilePath = `${root.replace(/\/+$/, '')}/${projName.replace(/\/+$/, '')}/logs/bids_conversion.tsv`;
        console.log('[AppConfig] Computed default conversion_file:', conversionFilePath);
      }
      
      // Store conversion file path in a data attribute or hidden field for serialization
      // Create a hidden input if it doesn't exist
      let convFileEl = document.getElementById('config_conversion_file');
      if (!convFileEl) {
        convFileEl = document.createElement('input');
        convFileEl.id = 'config_conversion_file';
        convFileEl.type = 'hidden';
        document.body.appendChild(convFileEl);
        console.log('[AppConfig] Created hidden config_conversion_file field');
      }
      
      if (conversionFilePath) {
        convFileEl.value = conversionFilePath;
        console.log('[AppConfig] Set conversion_file to:', conversionFilePath);
      }

      // reflect the loaded state without guessing — no alert popup
      const saveState = document.getElementById('configSaveState'); if (saveState) saveState.textContent = 'loaded';
      
      // Notify listeners (e.g., AppEditor) that config has been loaded/changed
      // so they can update their dependent fields (with a small delay to ensure DOM is ready)
      try {
        setTimeout(() => {
          console.log('[AppConfig] Dispatching AppConfigChanged event');
          window.dispatchEvent(new CustomEvent('AppConfigChanged'));
        }, 100);
      } catch(e) { console.error('[AppConfig] Error dispatching event:', e); }

      // If the YAML included both a BIDS output path and a dataset_description filename
      // attempt to load the dataset_description.json from the server and populate the form.
      try {
        if (data.bids && data.dataset_description) {
          // attempting to load dataset_description (silent)
          // run and await the loader so callers can rely on the populated state
          try {
            const result = await loadDatasetDescription(data.bids, data.dataset_description);
            if (!result || result.ok === false) {
              // File not found or read failed — surface a friendly status (do not write a noisy console.warn)
              if (saveState) saveState.textContent = 'dataset_description missing';
              document.getElementById('status').textContent = `dataset_description not found: ${result && result.error ? result.error : 'missing'}`;
              try { sendClientLog({message: 'dataset_description-load-missing', path: (result && result.path) || data.dataset_description, error: (result && result.error) || 'not_found'}); } catch(e){}
            } else {
              document.getElementById('status').textContent = `Loaded ${data.bids.replace(/\/$/, '')}/${data.dataset_description}`;
            }
            // conversion auto-load intentionally handled outside the dataset_description branch
          } catch (err) {
            console.error('Failed to load dataset_description', err);
            if (saveState) saveState.textContent = 'dataset_description load failed';
            document.getElementById('status').textContent = 'Failed to load dataset_description: ' + (err && err.message ? err.message : String(err));
            try { sendClientLog({message: 'dataset_description-load-failed', error: (err && err.message) || String(err) }); } catch(e){}
          }
        }
      } catch(e) { /* ignore */ }

      // After parsing and attempting to load dataset_description, also attempt
      // to auto-load the conversion table into the editor when the config
      // provides a Conversion_file and a project root + Name (or BIDS fallback).
      try {
        const conv = data.conversion_file || '';
        if (conv) {
          const projectRoot = data.root && data.project_name ? `${data.root.replace(/\/$/, '')}/${data.project_name}` : null;
          const candidates = [];
          if (projectRoot) candidates.push(`${projectRoot}/logs/${conv}`);
          // Also try just root/logs if project_name not set
          if (data.root && !data.project_name) candidates.push(`${data.root.replace(/\/$/, '')}/logs/${conv}`);
          // only consider BIDS path fallback when it looks path-like (contains a slash or is relative/home-style)
          if (data.bids && (data.bids.includes('/') || data.bids.startsWith('.') || data.bids.startsWith('~'))) candidates.push(`${data.bids.replace(/\/$/, '')}/conversion_logs/${conv}`);
          
          console.log('[AppConfig] Auto-loading conversion table from candidates:', candidates);

          for (const candidate of candidates) {
            try {
              const resp = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: candidate }) });
              const j = await resp.json();
              if (resp.ok && j && (typeof j.content === 'string') && j.content.trim()) {
                if (window.AppEditor && typeof window.AppEditor.openTableEditor === 'function') {
                  const savePathEl = document.getElementById('saveTablePath');
                  const resolvedPath = j.path || candidate;
                  // Only set saveTablePath if it's not already set to avoid overwriting user-provided paths
                  if (savePathEl && !savePathEl.value.trim()) {
                    savePathEl.value = resolvedPath;
                  }
                  const fname = (resolvedPath && resolvedPath.split('/').pop()) || conv;
                  try { window.AppEditor.openTableEditor(j.content, fname); } catch(e) {}
                  document.getElementById('status').textContent = `Loaded conversion table: ${resolvedPath}`;
                  break;
                }
              }
            } catch (e) {
              // ignore and try next candidate
            }
          }
        }
        // After trying conversion table, attempt to load bids_results.json (if present)
        try {
          const projectRoot = data.root && data.project_name ? `${data.root.replace(/\/$/, '')}/${data.project_name}` : null;
          const resultsCandidates = [];
          if (projectRoot) resultsCandidates.push(`${projectRoot}/logs/bids_results.json`);
          if (data.bids && (data.bids.includes('/') || data.bids.startsWith('.') || data.bids.startsWith('~'))) {
            resultsCandidates.push(`${data.bids.replace(/\/$/, '')}/logs/bids_results.json`);
            resultsCandidates.push(`${data.bids.replace(/\/$/, '')}/bids_results.json`);
          }

          for (const candidate of resultsCandidates) {
            if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] probing for bids_results.json at', candidate);
            try {
              const resp = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: candidate }) });
              const j = await resp.json();
              if (resp.ok && j && typeof j.content === 'string' && j.content.trim()) {
                try {
                  if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] found candidate content', candidate.slice(0,120));
                  const obj = JSON.parse(j.content);
                  // render JSON into report view and update stats
                  // Cache the parsed payload and candidate path early so a
                  // later-loaded AppReport can pick this up even if scripts
                  // race — do this regardless of whether AppReport is present
                  // to make deferred-loading robust.
                  try {
                    window._lastReportCandidates = window._lastReportCandidates || [];
                    if (!window._lastReportCandidates.includes(candidate)) window._lastReportCandidates.push(candidate);
                    window._lastReportPayloads = window._lastReportPayloads || {};
                    window._lastReportPayloads[candidate] = obj;
                    if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] early-cached payload candidate', candidate);
                  } catch(e) { if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] early cache failed', e); }
                  // Ensure AppReport exists — if not yet present, retry a couple of times
                  const callAppReport = async (obj) => {
                    if (window.AppReport && typeof window.AppReport.updateStats === 'function') {
                      try {
                        // attempt to compute counts similar to electron app heuristics
                        const rows = Array.isArray(obj) ? obj : (obj['Report Table'] || []);
                        const subjects = new Set(rows.map(r => r.Participant).filter(Boolean));
                        const sessions = new Set(rows.map(r => r.Session).filter(Boolean));
                        const successful = rows.filter(r => { const s = ((r['Conversion Status']||'')+'').toLowerCase(); return s === 'processed' || s === 'success'; }).length;
                        const failed = rows.filter(r => ((r['Conversion Status']||'')+'').toLowerCase() === 'error').length;
                        const taskSet = new Set(); rows.forEach(r => { if (r.Task) taskSet.add(r.Task); });
                        window.AppReport.updateStats({ subjects: subjects.size, sessions: sessions.size, tasks: taskSet.size });
                        return true;
                      } catch (e) { console.warn('AppReport updateStats failed', e); return false; }
                    }
                    return false;
                  };

                  // give AppReport a couple attempts if it's not loaded yet
                  if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] callAppReport: candidates', resultsCandidates, 'candidate', candidate, 'AppReportPresent', !!window.AppReport);
                  let called = false;
                  if (await callAppReport(obj)) called = true;
                  else {
                    for (let i=0; i<5 && !called; i++){
                      await new Promise(r=>setTimeout(r, 250));
                      if (await callAppReport(obj)) called = true;
                    }
                  }

                  if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] callAppReport loop finished, called=', called, 'AppReportPresent=', !!(window.AppReport && typeof window.AppReport.updateStats === 'function'));
                  if (!called && !(window.AppReport && typeof window.AppReport.updateStats === 'function')) {
                    console.warn('[AppConfig] AppReport not available after retries — deferring report load');
                    if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] now entering deferral block for candidate', candidate, 'resultsCandidates', resultsCandidates);
                    // give the user a visible hint inside the Report console so they
                    // can click 'Load report' manually (helps when scripts race)
                    try {
                      const out = document.getElementById('reportOutput');
                      if (out) out.textContent += '\n[AppConfig] AppReport not ready; report load deferred. Try clicking "Load report" in the Report view.';
                    } catch(e){}
                    // record last candidates and parsed payloads so a later-loaded
                    // AppReport module can pick them up and populate the UI without
                    // needing to re-fetch the files.
                    try { window._lastReportCandidates = resultsCandidates || []; if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] cached deferred candidates', window._lastReportCandidates); } catch(e){ if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] failed to set _lastReportCandidates', e); }
                    try { window._lastReportPayloads = window._lastReportPayloads || {}; window._lastReportPayloads[ candidate ] = obj; if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] cached deferred payload for', candidate); } catch(e){ if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] failed to set _lastReportPayloads', e); }
                    try { window.dispatchEvent(new CustomEvent('AppConfigDeferred', { detail: { candidates: resultsCandidates || [], candidate, payload: obj } })); } catch(e){}
                    // Watch for AppReport to become available and attempt to call its
                    // update methods. Try a short polling loop so auto-load works
                    // across script-load races without requiring manual user action.
                    try {
                      let tries = 0;
                      // Do not start a long-running polling interval inside Jest tests
                      // as it leaves scheduled timers that prevent the Node process
                      // from exiting cleanly. In test runs we skip starting this
                      // interval so the deferred cache must be picked up by
                      // event handlers or explicit calls in tests instead.
                      const shouldPoll = !(typeof process !== 'undefined' && process.env && process.env.JEST_WORKER_ID);
                      const t = shouldPoll ? setInterval(() => {
                        tries++;
                        try {
                          if (window.AppReport && typeof window.AppReport.updateStats === 'function'){
                            // apply cached payloads if present
                            try {
                              const keys = Object.keys(window._lastReportPayloads || {});
                              for (const k of keys) {
                                const cached = window._lastReportPayloads[k];
                                if (!cached) continue;
                                try { window.AppReport.updateStats({ subjects: new Set((Array.isArray(cached['Report Table']) ? cached['Report Table'].map(r=>r.Participant) : []).filter(Boolean)).size }); } catch(e){}
                                try { window.AppReport.renderTree(cached.bids_root || cached.bids_path || cached.root || cached.projectRoot || k, cached); } catch(e){}
                                try { if (window.AppReport && typeof window.AppReport.updateReportArea === 'function') window.AppReport.updateReportArea(window.AppReport.renderJSONPreview(cached)); } catch(e){}
                                // clear cache after use
                                try { delete window._lastReportPayloads[k]; } catch(e){}
                              }
                            } catch(e){}
                            clearInterval(t);
                          }
                        } catch (e) {}
                        if (tries > 40) clearInterval(t);
                      }, 250) : null;
                    } catch(e){}
                    try { if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppConfig] post-deferral caches', window._lastReportCandidates, Object.keys(window._lastReportPayloads || {})); } catch(e){}
                  }
                  if (window.AppReport && typeof window.AppReport.renderTree === 'function') {
                    try {
                      const rootPath = obj.bids_root || obj.bids_path || obj.root || obj.projectRoot || projectRoot || 'BIDS';
                      window.AppReport.renderTree(rootPath, obj);
                    } catch(e){}
                  }
                  if (window.AppReport && typeof window.AppReport.updateReportArea === 'function') {
                    try { window.AppReport.updateReportArea(window.AppReport.renderJSONPreview(obj)); } catch(e){}
                  }
                  // do not auto-open report view here — keep view switching manual
                  // stop after first successful candidate
                  break;
                } catch (err) {
                  // not valid JSON or parse failed, try next candidate
                }
              }
            } catch (e) {
              // ignore and try next candidate
            }
          }
        } catch(e) { /* ignore */ }
      } catch(e) { /* ignore */ }

      // notify other parts of the UI that a config was loaded/updated so
      // they can recompute derived fields (e.g., suggested conversion table path)
      try { if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.dispatchEvent(new CustomEvent('AppConfigChanged', { detail: { data } })); } catch(e){}
      // return parsed data for convenience
      return data;
    } catch (e) { alert('Failed to parse YAML: ' + e.message); }
  }

  function writeFormToYaml(template){
    // Construct a deterministic YAML template from DOM form fields. IMPORTANT:
    // Preserve known keys even when values are empty so saving does not drop
    // empty keys from configs (users expect keys to remain present).
    const cfgEl = document.getElementById('configText');

    const v = (id) => {
      const val = document.getElementById(id)?.value;
      if (typeof val === 'string') {
        const t = val.trim();
        // when writing, 'empty' sentinel means actual empty string value
        if (t === 'empty') return '';
        return t;
      }
      return '';
    };

    // Project block
    const projectName = v('config_project_name');
    const cirId = v('config_cir_id');
    const root = v('config_root_path');
    const rawPath = v('config_raw_path');
    const bidsPath = v('config_bids_path');
    const calibration = v('config_calibration_path');
    const crosstalk = v('config_crosstalk_path');
      const tasks = v('config_tasks') || '';

    // Dataset description block
    const datasetName = v('config_dataset_name');
    const bidsVersion = v('config_bids_version');
    const datasetType = v('config_dataset_type');
    const license = v('config_license');
    const authors = v('config_authors');
    const acknowledgements = v('config_acknowledgements');
    const howTo = v('config_how_to_acknowledge');
    const funding = v('config_funding');
    const ethics = v('config_ethics_approvals');
    const references = v('config_references_links');
    const doi = v('config_dataset_doi');
    const codeUrl = v('config_code_url');

    // BIDS block values
    const conversionFile = v('config_conversion_file');
    const datasetDescFile = v('config_dataset_description_file');
    
    // Debug logging
    if (typeof window !== 'undefined' && window.APP_DEBUG) {
      console.debug('[writeFormToYaml] conversion_file from form:', conversionFile);
    }

    // Build YAML lines — include keys even if values are empty
    const lines = [];
    lines.push('Project:');
    lines.push('  Name: ' + projectName);
    lines.push('  CIR-ID: ' + cirId);
    lines.push('  Root: ' + root);
    lines.push('  RawPath: ' + rawPath);
    lines.push('  BIDSPath: ' + bidsPath);
    lines.push('  CalibrationPath: ' + calibration);
    lines.push('  CrosstalkPath: ' + crosstalk);
    // Prepare tasks values; but do NOT write them inside the Project block.
    // We'll emit a top-level `Tasks:` block later so the YAML shape matches
    // configs that place tasks at the top-level (what bidsify expects).
    const tasksValues = tasks.split(',').map(s => s.trim()).filter(Boolean);

    lines.push('');
    lines.push('Dataset_description:');
    lines.push('  Name: ' + datasetName);
    lines.push('  BIDSVersion: ' + bidsVersion);
    lines.push('  DatasetType: ' + datasetType);
    lines.push('  License: ' + license);
    lines.push('  Authors: ' + authors);
    lines.push('  Acknowledgements: ' + acknowledgements);
    lines.push('  HowToAcknowledge: ' + howTo);
    lines.push('  Funding: ' + funding);
    lines.push('  EthicsApprovals: ' + ethics);
    lines.push('  ReferencesAndLinks: ' + references);
    lines.push('  DatasetDOI: ' + doi);
    lines.push('  GeneratedBy: ' + (codeUrl ? '[{ Name: "NatMEG-BIDSifier", CodeURL: "' + codeUrl + '" }]' : "''"));

    lines.push('');
    lines.push('BIDS:');
    lines.push('  Conversion_file: ' + conversionFile);
    lines.push('  Dataset_description: ' + datasetDescFile);

    // top-level SSH server if present (preserve even if empty)
    const ssh = v('config_ssh_server');
    if (ssh !== undefined) lines.push('SSH Server: ' + ssh);

    // Top-level Tasks (list or empty list) - placed after other top-level keys
    if (!tasksValues || tasksValues.length === 0) {
      lines.push('Tasks: []');
    } else {
      lines.push('Tasks:');
      tasksValues.forEach(t => lines.push('  - ' + t));
    }

    const yaml = lines.map(l => {
      // Preserve Tasks: when it is intentionally left as a block header for lists.
      if (/^\s*Tasks:\s*$/.test(l)) return l;
      // only convert nested key lines (indented) with empty values to explicit ''
      if (/^\s+[^:]+:\s*$/.test(l)) return l.replace(/:\s*$/, ": ''");
      return l;
    }).join('\n');
    if (cfgEl) cfgEl.value = yaml;
    const saveBtn = document.getElementById('saveConfigBtn'); if (saveBtn) saveBtn.disabled = false;
    // If a base template was provided, merge values into it so keys are preserved
    if (template && typeof template === 'string') {
      const values = {
        project_name: projectName, cir_id: cirId, root, raw: rawPath, bids: bidsPath, calibration, crosstalk, tasks,
        dataset_name: datasetName, bids_version: bidsVersion, dataset_type: datasetType, license, authors, acknowledgements, how_to_acknowledge: howTo, funding, ethics_approvals: ethics, references_links: references, dataset_doi: doi, code_url: codeUrl,
        conversion_file: conversionFile, dataset_description: datasetDescFile, ssh_server: ssh
      };
      function mergeValuesIntoYamlTemplate(templateStr, valuesObj) {
        if (typeof templateStr !== 'string' || !templateStr) return writeFormToYaml();
        const tmplLines = templateStr.split(/\r?\n/);

        // Find block boundaries for a top-level block (e.g., 'Project:')
        const findBlockRange = (blockName, linesArr) => {
          const start = linesArr.findIndex(l => l.match(new RegExp('^' + blockName.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + ':\s*$')));
          if (start === -1) return null;
          let end = start + 1;
          while (end < linesArr.length && linesArr[end].match(/^\s+/)) end++;
          return [start, end];
        };

        const replaceKeyInRange = (linesArr, start, end, key, value) => {
          for (let i = start + 1; i < end; i++) {
            const m = linesArr[i].match(/^(\s*)([^:]+):(.*)$/);
            if (m) {
              const keyName = m[2].trim();
              if (keyName === key) {
                const indent = m[1] || '  ';
                linesArr[i] = indent + key + ': ' + (value === '' ? "''" : value);
                return true;
              }
            }
          }
          return false;
        };

        const replaceTasksInRange = (linesArr, start, end, items) => {
          for (let i = start + 1; i < end; i++) {
            if (linesArr[i].match(/^\s*Tasks:\s*$/)) {
              let j = i + 1;
              while (j < end && linesArr[j].match(/^\s*-\s*/)) j++;
              const indentMatch = linesArr[i].match(/^(\s*)/);
              const indent = indentMatch ? indentMatch[1] + '  ' : '  ';
              const replLines = items.length ? items.map(t => indent + '- ' + (t.indexOf(' ') >= 0 ? ('\'' + t.replace(/'/g, "\\'") + '\'') : t)) : [indent + "- ''"];
              const before = linesArr.slice(0, i + 1);
              const after = linesArr.slice(j);
              const newLines = before.concat(replLines).concat(after);
              // replace content in place
              linesArr.splice(0, linesArr.length, ...newLines);
              return true;
            }
          }
          return false;
        };

        const replaceTopList = (linesArr, key, items) => {
          const re = new RegExp('^' + key.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + ':\s*$');
          for (let i = 0; i < linesArr.length; i++) {
            if (linesArr[i].match(re)) {
              // swallow following list items
              let j = i + 1;
              while (j < linesArr.length && linesArr[j].match(/^\s*-\s*/)) j++;
              const before = linesArr.slice(0, i + 1);
              const after = linesArr.slice(j);
              const replLines = items.length ? items.map(t => '  - ' + (t.indexOf(' ') >= 0 ? ('\'' + t.replace(/'/g, "\\'") + '\'') : t)) : ['  - \'' + "" + '\''];
              const newLines = before.concat(replLines).concat(after);
              linesArr.splice(0, linesArr.length, ...newLines);
              return true;
            }
          }
          return false;
        };

        const replaceTopKey = (linesArr, key, value) => {
          const re = new RegExp('^' + key.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + ':');
          for (let i = 0; i < linesArr.length; i++) {
            if (linesArr[i].match(re)) {
              const m = linesArr[i].match(/^(\s*[^:]+:)(.*)$/);
              linesArr[i] = (m ? m[1] : key + ':') + ' ' + (value === '' ? "''" : value);
              return true;
            }
          }
          return false;
        };

        // Work on a copy of the lines for safety
        const linesCopy = tmplLines.slice();

        // Update Project block values (only when keys exist in the block)
        const projectRange = findBlockRange('Project', linesCopy);
        if (projectRange) {
          const [ps, pe] = projectRange;
          if (valuesObj.project_name !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'Name', valuesObj.project_name || '');
          if (valuesObj.cir_id !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'CIR-ID', valuesObj.cir_id || '');
          if (valuesObj.root !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'Root', valuesObj.root || '');
          if (valuesObj.raw !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'Raw', valuesObj.raw || '');
          if (valuesObj.raw !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'RawPath', valuesObj.raw || '');
          if (valuesObj.bids !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'BIDS', valuesObj.bids || '');
          if (valuesObj.bids !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'BIDSPath', valuesObj.bids || '');
          if (valuesObj.calibration !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'Calibration', valuesObj.calibration || '');
          if (valuesObj.calibration !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'CalibrationPath', valuesObj.calibration || '');
          if (valuesObj.crosstalk !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'Crosstalk', valuesObj.crosstalk || '');
          if (valuesObj.crosstalk !== undefined) replaceKeyInRange(linesCopy, ps, pe, 'CrosstalkPath', valuesObj.crosstalk || '');
          if ('tasks' in valuesObj) {
            const tasksValue = (valuesObj.tasks || '').split(',').map(s=>s.trim()).filter(Boolean);
            // prefer updating Project.Tasks if present, otherwise try top-level Tasks
            const updated = replaceTasksInRange(linesCopy, ps, pe, tasksValue);
            if (!updated) replaceTopList(linesCopy, 'Tasks', tasksValue);
          }
        }
        // If template has a top-level Tasks key (and Project block not present or didn't handle it),
        // ensure we update top-level Tasks as a list too.
        if (!projectRange && 'tasks' in valuesObj) {
          const tasksValue = (valuesObj.tasks || '').split(',').map(s=>s.trim()).filter(Boolean);
          replaceTopList(linesCopy, 'Tasks', tasksValue);
        }

        // Update Dataset_description block values
        const ddRange = findBlockRange('Dataset_description', linesCopy);
        if (ddRange) {
          const [ds, de] = ddRange;
          if (valuesObj.dataset_name !== undefined) replaceKeyInRange(linesCopy, ds, de, 'Name', valuesObj.dataset_name || '');
          if (valuesObj.bids_version !== undefined) replaceKeyInRange(linesCopy, ds, de, 'BIDSVersion', valuesObj.bids_version || '');
          if (valuesObj.dataset_type !== undefined) replaceKeyInRange(linesCopy, ds, de, 'DatasetType', valuesObj.dataset_type || '');
          if (valuesObj.license !== undefined) replaceKeyInRange(linesCopy, ds, de, 'License', valuesObj.license || '');
          if (valuesObj.authors !== undefined) replaceKeyInRange(linesCopy, ds, de, 'Authors', valuesObj.authors || '');
          if (valuesObj.acknowledgements !== undefined) replaceKeyInRange(linesCopy, ds, de, 'Acknowledgements', valuesObj.acknowledgements || '');
          if (valuesObj.how_to_acknowledge !== undefined) replaceKeyInRange(linesCopy, ds, de, 'HowToAcknowledge', valuesObj.how_to_acknowledge || '');
          if (valuesObj.funding !== undefined) replaceKeyInRange(linesCopy, ds, de, 'Funding', valuesObj.funding || '');
          if (valuesObj.ethics_approvals !== undefined) replaceKeyInRange(linesCopy, ds, de, 'EthicsApprovals', valuesObj.ethics_approvals || '');
          if (valuesObj.references_links !== undefined) replaceKeyInRange(linesCopy, ds, de, 'ReferencesAndLinks', valuesObj.references_links || '');
          if (valuesObj.dataset_doi !== undefined) replaceKeyInRange(linesCopy, ds, de, 'DatasetDOI', valuesObj.dataset_doi || '');
        }

        // Update BIDS block values
        const bidsRange = findBlockRange('BIDS', linesCopy);
        if (bidsRange) {
          const [bs, be] = bidsRange;
          if (valuesObj.conversion_file !== undefined) replaceKeyInRange(linesCopy, bs, be, 'Conversion_file', valuesObj.conversion_file || '');
          if (valuesObj.dataset_description !== undefined) replaceKeyInRange(linesCopy, bs, be, 'Dataset_description', valuesObj.dataset_description || '');
        }

        // top-level SSH Server
        if (valuesObj.ssh_server !== undefined) replaceTopKey(linesCopy, 'SSH Server', valuesObj.ssh_server || '');

        return linesCopy.join('\n');
      }

      // merge and return merged YAML
      try {
        return mergeValuesIntoYamlTemplate(template, values);
      } catch (e) {
        // fallback to generated YAML if merge fails for any reason
        return lines.join('\n');
      }
    }
    // if template was not provided (or merge fell through) return generated YAML
    return yaml;
  }

  // Build dataset_description.json from form fields (exposed at module scope)
  function buildDatasetDescription() {
    const name = document.getElementById('config_dataset_name')?.value.trim();
    const bidsVersion = document.getElementById('config_bids_version')?.value.trim();
    const datasetType = document.getElementById('config_dataset_type')?.value.trim();
    const license = document.getElementById('config_license')?.value.trim();
    const authors = (document.getElementById('config_authors')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    const acknowledgements = document.getElementById('config_acknowledgements')?.value.trim();
    const howTo = document.getElementById('config_how_to_acknowledge')?.value.trim();
    const funding = (document.getElementById('config_funding')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    const ethics = (document.getElementById('config_ethics_approvals')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    const references = (document.getElementById('config_references_links')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    const doi = document.getElementById('config_dataset_doi')?.value.trim();
    const codeUrl = document.getElementById('config_code_url')?.value.trim();

    const out = {};
    // Include keys even when empty — treat 'empty' sentinel as empty string
    out.Name = (name === 'empty' ? '' : name) || '';
    out.BIDSVersion = (bidsVersion === 'empty' ? '' : bidsVersion) || '';
    out.DatasetType = (datasetType === 'empty' ? '' : datasetType) || '';
    out.License = (license === 'empty' ? '' : license) || '';
    out.Authors = (Array.isArray(authors) && authors.length) ? authors : ((authors === 'empty' || authors === '') ? [] : authors);
    out.Acknowledgements = (acknowledgements === 'empty' ? '' : acknowledgements) || '';
    out.HowToAcknowledge = (howTo === 'empty' ? '' : howTo) || '';
    out.Funding = (Array.isArray(funding) && funding.length) ? funding : ((funding === 'empty' || funding === '') ? [] : funding);
    out.EthicsApprovals = (Array.isArray(ethics) && ethics.length) ? ethics : ((ethics === 'empty' || ethics === '') ? [] : ethics);
    out.ReferencesAndLinks = (Array.isArray(references) && references.length) ? references : ((references === 'empty' || references === '') ? [] : references);
    out.DatasetDOI = (doi === 'empty' ? '' : doi) || '';
    if (codeUrl) out.GeneratedBy = [{ Name: 'NatMEG-BIDSifier', CodeURL: codeUrl }];
    return out;
  }

  // DOM wiring
  // track last loaded or saved config path so save can fall back to it
  let originalConfigPath = '';
  // whether the currently-loaded configuration was read from a local upload
  // (true) or from an on-disk server path (false). When true we consider the
  // config 'unsaved' for the purposes of enabling Analyze until the user
  // explicitly saves it to the server.
  let originalConfigIsLocal = false;
  // last loaded/saved content for the config (shared across UI and saveConfig)
  let originalConfigText = '';

  function initConfigUI() {
    const fileInput = document.getElementById('fileInput');
    const configText = document.getElementById('configText');
    const configSaveState = document.getElementById('configSaveState');

      if (fileInput) fileInput.addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return; const text = await f.text(); // populate form from loaded file
        await populateFormFromYaml(text); originalConfigText = text; // mark as local upload (no server-side path yet)
        originalConfigPath = '';
        originalConfigIsLocal = true;
        if (configSaveState) configSaveState.textContent = 'loaded'; const saveBtn = document.getElementById('saveConfigBtn'); if (saveBtn) saveBtn.disabled = true; sendClientLog({message:'file-uploaded'});
        try { updateAnalyzeButtonState(); } catch(e) {}
        try { const analyzeBtn = document.getElementById('analyzeBtn'); if (analyzeBtn) analyzeBtn.disabled = true; } catch(e) {}
      });

    document.getElementById('loadConfigBtn')?.addEventListener('click', async () => {
      const p = document.getElementById('loadConfigPath')?.value.trim(); if (!p) { alert('Enter server path to load (relative or absolute)'); return; }
      try {
        const res = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path: p}) });
        const j = await res.json(); if (!res.ok) { alert('Read failed: ' + (j.error || JSON.stringify(j))); return; }
        // populate form directly from loaded content
        await populateFormFromYaml(j.content || ''); originalConfigText = j.content || ''; originalConfigPath = j.path || originalConfigPath; originalConfigIsLocal = false; if (configSaveState) configSaveState.textContent = 'loaded'; const saveBtn = document.getElementById('saveConfigBtn'); if (saveBtn) saveBtn.disabled = true; document.getElementById('status').textContent = `Loaded ${j.path}`; try { updateAnalyzeButtonState(); } catch(e){}
      } catch (err) { alert('Error reading file: ' + err.message); }
    });

    // Auto-load config when path is selected via FileBrowser
    const loadConfigPathInput = document.getElementById('loadConfigPath');
    if (loadConfigPathInput) {
      loadConfigPathInput.addEventListener('change', async () => {
        const p = loadConfigPathInput.value.trim();
        if (p && p.endsWith('.yml') || p.endsWith('.yaml')) {
          console.log('[AppConfig] Auto-loading config after FileBrowser selection:', p);
          const loadBtn = document.getElementById('loadConfigBtn');
          if (loadBtn) loadBtn.click();
        }
      });
    }

    // Improve UX: If the requested file is missing, prompt to load the project default_config.yml
    // so users can create a new config quickly.
    async function tryLoadOrCreateDefault(pathToTry) {
      try {
        const res = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path: pathToTry}) });
        const j = await res.json();
        if (!res.ok) return { ok: false, info: j };
        await populateFormFromYaml(j.content || ''); originalConfigText = j.content || ''; if (configSaveState) configSaveState.textContent = 'loaded'; const saveBtn = document.getElementById('saveConfigBtn'); if (saveBtn) saveBtn.disabled = true; document.getElementById('status').textContent = `Loaded ${j.path}`; return { ok: true };
      } catch (err) { return { ok: false, info: { error: err.message } }; }
    }

    // Wrap the error case so the UI can attempt default_config.yml if the file isn't found.
    // We intercept the load button and try to recover from missing files.
    const origLoadHandler = document.getElementById('loadConfigBtn')?.onclick;
    // We already attached a click handler above; enhance it by wrapping network error messages
    // Instead of replacing the handler, we add a global listener to reduce code duplication.
    document.getElementById('loadConfigBtn')?.addEventListener('click', async () => {
      const p = document.getElementById('loadConfigPath')?.value.trim(); if (!p) return;
      // small debounce / allow earlier handler first
      await new Promise(r => setTimeout(r, 0));
      // If prior handler set status to an error by using alert, we can't intercept it, so we check server for existence first
      try {
        // Probe the path
        const probe = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path: p}) });
        const probeJson = await probe.json();
        if (!probe.ok && probeJson && probeJson.error) {
          const errLower = String(probeJson.error).toLowerCase();
          if (errLower.includes('file not found')) {
            // Ask user if they want a default
            const createDefault = confirm(`${p} not found on server. Would you like to create/populate from default_config.yml instead?`);
              if (createDefault) {
              const result = await tryLoadOrCreateDefault('default_config.yml');
              if (!result.ok) alert('Failed to load default_config.yml: ' + JSON.stringify(result.info || {}));
              else { originalConfigPath = 'default_config.yml'; originalConfigIsLocal = false; try { updateAnalyzeButtonState(); } catch(e){} }
            }
          } else if (errLower.includes('invalid path')) {
            // More explicit guidance for invalid-path errors (outside repo root)
            const tryDefault = confirm(`${p} is considered invalid by the server (outside allowed paths).\n\nNote: you can use ~ to reference the server user's home (e.g. ~/my/config.yml) or absolute paths beginning with / (e.g. /Users/.../my/config.yml).\n\nIf you are running the web app on a remote host and don't want to allow direct absolute reads, consider copying configs into the application repository and using a repo-relative path (e.g. configs/your-config.yml).\n\nWould you like to try loading the repository default_config.yml instead?`);
            if (tryDefault) {
              const result = await tryLoadOrCreateDefault('default_config.yml');
                if (!result.ok) alert('Failed to load default_config.yml: ' + JSON.stringify(result.info || {}));
                else { originalConfigPath = 'default_config.yml'; originalConfigIsLocal = false; try { updateAnalyzeButtonState(); } catch(e){} }
            }
          }
        }
      } catch (e) {
        // ignore - original handler will surface the error
      }
    });

    document.getElementById('saveConfigBtn')?.addEventListener('click', async () => {
      // delegate to shared save function
      try { await saveConfig(); } catch (err) { alert('Error saving file: ' + err.message); }
      return;
      // Save path resolution: explicit saveConfigPath -> loadConfigPath -> originalConfigPath
      let path = (document.getElementById('saveConfigPath')?.value || '').trim();
      if (!path) path = (document.getElementById('loadConfigPath')?.value || '').trim();
      if (!path) path = originalConfigPath || '';
      if (!path) { alert('Enter server path to save config to'); return; }
      try {
        // produce YAML either from a textarea (if present) or from the form
        let content = '';
        const cfgEl = document.getElementById('configText');
        if (cfgEl) content = cfgEl.value;
        else content = writeFormToYaml();
        let res = await fetch('/api/save-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path, content}) });
        let j = await res.json();
        if (!res.ok) {
          // Handle file exists error
          if (res.status === 409 && j.error === 'file_exists') {
            const okToOverwrite = confirm(`${path} already exists. Overwrite?`);
            if (!okToOverwrite) return;
            res = await fetch('/api/save-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path, content, force_overwrite: true}) });
            j = await res.json();
            if (!res.ok) { alert('Save failed: ' + (j.error || JSON.stringify(j))); return; }
          } else {
            alert('Save failed: ' + (j.error || JSON.stringify(j))); return;
          }
        }
        document.getElementById('status').textContent = `Saved ${j.path}`; originalConfigText = content; originalConfigPath = j.path || originalConfigPath; if (configSaveState) configSaveState.textContent = 'saved'; document.getElementById('saveConfigBtn').disabled = true
      } catch (err) { alert('Error saving file: ' + err.message); }
    });

  // Build dataset_description.json from form fields (exposed at module scope)
  function buildDatasetDescription() {
    const name = document.getElementById('config_dataset_name')?.value.trim();
    const bidsVersion = document.getElementById('config_bids_version')?.value.trim();
    const datasetType = document.getElementById('config_dataset_type')?.value.trim();
    const license = document.getElementById('config_license')?.value.trim();
    const authors = (document.getElementById('config_authors')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    const acknowledgements = document.getElementById('config_acknowledgements')?.value.trim();
    const howTo = document.getElementById('config_how_to_acknowledge')?.value.trim();
    const funding = (document.getElementById('config_funding')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    const ethics = (document.getElementById('config_ethics_approvals')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    const references = (document.getElementById('config_references_links')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    const doi = document.getElementById('config_dataset_doi')?.value.trim();
    const codeUrl = document.getElementById('config_code_url')?.value.trim();

    const out = {};
    // Include keys even when empty — treat 'empty' sentinel as empty string
    out.Name = (name === 'empty' ? '' : name) || '';
    out.BIDSVersion = (bidsVersion === 'empty' ? '' : bidsVersion) || '';
    out.DatasetType = (datasetType === 'empty' ? '' : datasetType) || '';
    out.License = (license === 'empty' ? '' : license) || '';
    out.Authors = (Array.isArray(authors) && authors.length) ? authors : ((authors === 'empty' || authors === '') ? [] : authors);
    out.Acknowledgements = (acknowledgements === 'empty' ? '' : acknowledgements) || '';
    out.HowToAcknowledge = (howTo === 'empty' ? '' : howTo) || '';
    out.Funding = (Array.isArray(funding) && funding.length) ? funding : ((funding === 'empty' || funding === '') ? [] : funding);
    out.EthicsApprovals = (Array.isArray(ethics) && ethics.length) ? ethics : ((ethics === 'empty' || ethics === '') ? [] : ethics);
    out.ReferencesAndLinks = (Array.isArray(references) && references.length) ? references : ((references === 'empty' || references === '') ? [] : references);
    out.DatasetDOI = (doi === 'empty' ? '' : doi) || '';
    if (codeUrl) out.GeneratedBy = [{ Name: 'NatMEG-BIDSifier', CodeURL: codeUrl }];
    return out;
  }

    document.getElementById('saveDatasetDescBtn')?.addEventListener('click', async () => {
      try { console.log('APP: saveDatasetDescBtn handler invoked'); } catch(e){}
      const bidsPath = document.getElementById('config_bids_path')?.value.trim();
      const filename = document.getElementById('config_dataset_description_file')?.value.trim() || 'dataset_description.json';
      if (!bidsPath) { alert('Set BIDS output path first (BIDS Output Path)'); return; }
      const path = (bidsPath.endsWith('/') ? bidsPath.slice(0,-1) : bidsPath) + '/' + filename;
      const contentObj = buildDatasetDescription();
      const content = JSON.stringify(contentObj, null, 2);
      try {
        try { console.log('APP: about to call fetch for dataset_description'); } catch(e){}
        let res = await fetch('/api/save-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path, content }) });
        let j = await res.json();
        if (!res.ok) {
          // Handle file exists error
          if (res.status === 409 && j.error === 'file_exists') {
            const okToOverwrite = confirm(`${path} already exists. Overwrite?`);
            if (!okToOverwrite) return;
            res = await fetch('/api/save-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path, content, force_overwrite: true }) });
            j = await res.json();
            if (!res.ok) { alert('Save failed: ' + (j.error || JSON.stringify(j))); return; }
          } else {
            alert('Save failed: ' + (j.error || JSON.stringify(j))); return;
          }
        }
        document.getElementById('status').textContent = `Saved ${j.path}`; if (configSaveState) configSaveState.textContent = 'saved';
      } catch (err) { alert('Error saving dataset description: ' + err.message); }
    });

    document.getElementById('reloadConfigBtn')?.addEventListener('click', async () => {
      const p = document.getElementById('loadConfigPath')?.value.trim(); if (!p) { alert('Enter server path to load (relative or absolute)'); return; }
      try { const res = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path: p}) }); const j = await res.json(); if (!res.ok) { alert('Read failed: ' + (j.error || JSON.stringify(j))); return; } await populateFormFromYaml(j.content || ''); originalConfigText = j.content || ''; if (configSaveState) configSaveState.textContent = 'loaded'; document.getElementById('saveConfigBtn').disabled = true } catch (err) { alert('Error reading file: ' + err.message); }
      originalConfigIsLocal = false; try { updateAnalyzeButtonState(); } catch(e) {}
    });

    // monitor form inputs to mark the config as modified — use event delegation
    // so newly added fields or edits are captured reliably in the browser
    const mainConfigEl = document.getElementById('main-config');
    const enableSaveForEdit = () => {
      const saveBtn = document.getElementById('saveConfigBtn'); if (saveBtn) saveBtn.disabled = false; if (configSaveState) configSaveState.textContent = 'modified';
      // clear saved UI state when user edits
      if (saveBtn) saveBtn.classList.remove('saved');
      const saveStateEl = document.getElementById('configSaveState'); if (saveStateEl) saveStateEl.classList.remove('visible');
    };
    if (mainConfigEl) {
      mainConfigEl.addEventListener('input', enableSaveForEdit);
      mainConfigEl.addEventListener('change', enableSaveForEdit);
    } else {
      const formInputs = Array.from(document.querySelectorAll('#main-config input, #main-config select, #main-config textarea'));
      formInputs.forEach(el => el.addEventListener('input', enableSaveForEdit));
    }

    // --- Automatic path updates: If not manually edited, update paths based on Root Path and Project Name
    // Track manual edits for all auto-fill paths to prevent overwriting them
    let rawPathManuallyEdited = false;
    let bidsPathManuallyEdited = false;
    let calibrationPathManuallyEdited = false;
    let crosstalkPathManuallyEdited = false;
    let conversionFileManuallyEdited = false;

    const rawPathEl = document.getElementById('config_raw_path');
    const bidsPathEl = document.getElementById('config_bids_path');
    const calibrationPathEl = document.getElementById('config_calibration_path');
    const crosstalkPathEl = document.getElementById('config_crosstalk_path');
    const conversionFileEl = document.getElementById('config_conversion_file');
    const rootPathEl = document.getElementById('config_root_path');
    const projectNameEl = document.getElementById('config_project_name');

    // Function to update paths automatically
    function updateAutomaticPaths() {
      if (!rootPathEl || !projectNameEl) return;
      
      const root = rootPathEl.value.trim();
      const projectName = projectNameEl.value.trim();

      // Remove trailing slashes for consistent path construction
      const cleanRoot = root.replace(/\/$/, '');

      // Update Raw Data Path if not manually edited
      if (!rawPathManuallyEdited && rawPathEl) {
        if (cleanRoot && projectName) {
          rawPathEl.value = cleanRoot + '/' + projectName + '/raw';
        } else {
          rawPathEl.value = '';
        }
      }

      // Update BIDS Output Path if not manually edited
      if (!bidsPathManuallyEdited && bidsPathEl) {
        if (cleanRoot && projectName) {
          bidsPathEl.value = cleanRoot + '/' + projectName + '/BIDS';
        } else {
          bidsPathEl.value = '';
        }
      }

      // Update Calibration Path if not manually edited
      if (!calibrationPathManuallyEdited && calibrationPathEl) {
        if (cleanRoot && projectName) {
          calibrationPathEl.value = cleanRoot + '/' + projectName + '/triux_files/sss/sss_cal.dat';
        } else {
          calibrationPathEl.value = '';
        }
      }

      // Update Crosstalk Path if not manually edited
      if (!crosstalkPathManuallyEdited && crosstalkPathEl) {
        if (cleanRoot && projectName) {
          crosstalkPathEl.value = cleanRoot + '/' + projectName + '/triux_files/ctc/ct_sparse.fif';
        } else {
          crosstalkPathEl.value = '';
        }
      }

      // Update Conversion File Path if not manually edited
      if (!conversionFileManuallyEdited && conversionFileEl) {
        if (cleanRoot && projectName) {
          const defaultFilename = 'bids_conversion.tsv';
          conversionFileEl.value = cleanRoot + '/' + projectName + '/logs/' + defaultFilename;
        } else {
          conversionFileEl.value = '';
        }
      }
    }

    // Mark paths as manually edited when user interacts with them
    if (rawPathEl) {
      rawPathEl.addEventListener('input', () => {
        if (rawPathEl.value.trim()) {
          rawPathManuallyEdited = true;
        }
      });
    }
    if (bidsPathEl) {
      bidsPathEl.addEventListener('input', () => {
        if (bidsPathEl.value.trim()) {
          bidsPathManuallyEdited = true;
        }
      });
    }
    if (calibrationPathEl) {
      calibrationPathEl.addEventListener('input', () => {
        if (calibrationPathEl.value.trim()) {
          calibrationPathManuallyEdited = true;
        }
      });
    }
    if (crosstalkPathEl) {
      crosstalkPathEl.addEventListener('input', () => {
        if (crosstalkPathEl.value.trim()) {
          crosstalkPathManuallyEdited = true;
        }
      });
    }
    if (conversionFileEl) {
      conversionFileEl.addEventListener('input', () => {
        if (conversionFileEl.value.trim()) {
          conversionFileManuallyEdited = true;
        }
      });
    }

    // Attach listeners to Root Path and Project Name fields
    if (rootPathEl) {
      rootPathEl.addEventListener('input', updateAutomaticPaths);
      rootPathEl.addEventListener('change', updateAutomaticPaths);
    }
    if (projectNameEl) {
      projectNameEl.addEventListener('input', updateAutomaticPaths);
      projectNameEl.addEventListener('change', updateAutomaticPaths);
    }

    // Store original populateFormFromYaml and wrap it to reset manual edit flags and trigger auto-update
    // This needs to be in window scope so it properly wraps the outer function
    const _originalPopulateFormFromYaml = window.populateFormFromYaml || populateFormFromYaml;
    const wrappedPopulate = async function(configSource) {
      rawPathManuallyEdited = false;
      bidsPathManuallyEdited = false;
      calibrationPathManuallyEdited = false;
      crosstalkPathManuallyEdited = false;
      conversionFileManuallyEdited = false;
      const result = await _originalPopulateFormFromYaml(configSource);
      // After populating form, trigger automatic path update since direct value assignment
      // doesn't fire input events
      try {
        updateAutomaticPaths();
      } catch (e) {
        if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AutoPaths] updateAutomaticPaths after populate failed', e);
      }
      return result;
    };
    window.populateFormFromYaml = wrappedPopulate;

    // --- Analyse gating: Only allow running/analyzing when there's a saved server-side
    // config available. This disambiguates local-file edits (uploads) vs server-resident
    // configs. Local uploads must be saved to the server before the Analyze button is
    // enabled.
    function isConfigRunnable() {
      try {
        const stateEl = document.getElementById('configSaveState');
        const state = stateEl ? stateEl.textContent && stateEl.textContent.trim().toLowerCase() : '';
        // allow if we have an originalConfigPath and the state is 'saved' or 'loaded'
        return !!originalConfigPath && (state === 'saved' || state === 'loaded');
      } catch (e) { return false; }
    }

    function updateAnalyzeButtonState() {
      const btn = document.getElementById('analyzeBtn'); if (!btn) return; btn.disabled = !isConfigRunnable();
    }

    // Ensure edit events make the Analyze button inactive (until saved again).
    const disableAnalyzeOnEdit = () => { const btn = document.getElementById('analyzeBtn'); if (btn) btn.disabled = true; };
    if (mainConfigEl) {
      mainConfigEl.addEventListener('input', disableAnalyzeOnEdit);
      mainConfigEl.addEventListener('change', disableAnalyzeOnEdit);
    }

    // After saving we mark the config saved and allow Analyze
    const origSave = window.AppConfig && window.AppConfig.saveConfig ? null : null;
    // update initial state
    updateAnalyzeButtonState();

    // Ensure Save button is interactive by default so the UI responds to clicks
    // (saveConfig handles prompting for a path when none is set). The button may
    // still be disabled after a successful save until a subsequent edit.
    const maybeSaveBtn = document.getElementById('saveConfigBtn');
    if (maybeSaveBtn) maybeSaveBtn.disabled = false;

    // helpers and YAML <-> form buttons
    window.browseDirectory = function(inputId){ const el = document.getElementById(inputId); const cur = el ? el.value : '.'; const val = prompt('Enter directory path', cur || '.'); if (val !== null && el) el.value = val; };
    window.browseFile = function(inputId){ const el = document.getElementById(inputId); const cur = el ? el.value : ''; const val = prompt('Enter file path', cur || ''); if (val !== null && el) el.value = val; };

    document.getElementById('populateFormBtn')?.addEventListener('click', () => populateFormFromYaml(configText));
    document.getElementById('writeYamlBtn')?.addEventListener('click', writeFormToYaml);
  }

  // Ensure initialization runs whether DOMContentLoaded fires before or after this script runs
  if (typeof document !== 'undefined' && (document.readyState === 'complete' || document.readyState === 'interactive')) {
    initConfigUI();
  } else if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('DOMContentLoaded', initConfigUI);
  }

  // export some functions for tests / other code
  // Also expose helpers for dataset description handling so tests and other modules
  // can create and save dataset_description.json programmatically.
  async function saveDatasetDescription(bidsPath, filename) {
    const bp = bidsPath || document.getElementById('config_bids_path')?.value.trim();
    const fn = filename || document.getElementById('config_dataset_description_file')?.value.trim() || 'dataset_description.json';
    if (!bp) throw new Error('Missing BIDS path');
    const p = (bp.endsWith('/') ? bp.slice(0,-1) : bp) + '/' + fn;
    const contentObj = buildDatasetDescription();
    // If a dataset_description already exists, fetch it and merge values (preserve other keys)
    try {
      const probe = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: p }) });
      const probeJ = await probe.json();
      let base = {};
      if (probe.ok) {
        if (probeJ && probeJ.content) {
          if (typeof probeJ.content === 'string') {
            try { base = JSON.parse(probeJ.content); } catch(e) { base = {}; }
          } else if (typeof probeJ.content === 'object' && probeJ.content !== null) base = probeJ.content;
          // if the existing file had keys, only update those keys; otherwise write full contentObj
          if (Object.keys(base).length === 0) {
            base = contentObj;
          } else {
            Object.keys(contentObj).forEach(k => { if (Object.prototype.hasOwnProperty.call(base, k)) base[k] = contentObj[k]; });
          }
        } else {
          // file exists but no content — treat as new and write contentObj
          base = contentObj;
        }
      } else {
        // not ok (probably 404) - write new file
        base = contentObj;
      }
      const content = JSON.stringify(base, null, 2);
      return fetch('/api/save-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: p, content }) });
    } catch (e) {
      // on error, fallback to simple write
      const content = JSON.stringify(contentObj, null, 2);
      return fetch('/api/save-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: p, content }) });
    }
  }

  // Save config programmatically (path optional, forceOverwrite for auto-save scenarios)
  async function saveConfig(savePath, forceOverwrite = false) {
    // resolve path: explicit savePath param -> saveConfigPath input -> loadConfigPath input -> originalConfigPath
    let path = (savePath || '').trim();
    if (!path) path = (document.getElementById('saveConfigPath')?.value || '').trim();
    if (!path) path = (document.getElementById('loadConfigPath')?.value || '').trim();
    if (!path) path = originalConfigPath || '';
    // If still not found, try to parse the status text (e.g. 'Loaded /path' or 'Saved /path')
    if (!path) {
      const statusText = document.getElementById('status')?.textContent || '';
      const m = statusText.match(/(?:Loaded|Saved)\s+(.+)/);
      if (m && m[1]) path = m[1].trim();
    }
    if (!path) {
      // Ask user to provide a path if none is available. Prefer the in-page
      // Save As modal when present (better UX than native prompt/confirm).
      if (typeof window.showSaveAsModal === 'function') {
        const chosen = await window.showSaveAsModal('configs/myconfig.yml');
        if (!chosen) throw new Error('Enter server path to save config to');
        path = chosen.trim();
      } else {
        const ask = prompt('Enter path to save config (relative or absolute):', 'configs/myconfig.yml');
        if (!ask) throw new Error('Enter server path to save config to');
        path = ask.trim();
      }
    }

    // compute content (merge into template if available)
    let content = '';
    const cfgEl = document.getElementById('configText');
    if (cfgEl) content = cfgEl.value;
    else {
      // attempt to merge values into a template: prefer the currently loaded config
      // (originalConfigText) or fall back to the project's default_config.yml
      let template = originalConfigText || '';
      if (!template) {
        try {
          const defRes = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: 'default_config.yml' }) });
          const defJ = await defRes.json();
          if (defRes.ok && defJ && defJ.content) template = defJ.content;
        } catch (e) {
          // ignore and fallback to generated YAML
        }
      }
      if (template) content = writeFormToYaml(template);
      else content = writeFormToYaml();
    }

    // Try saving directly. If forceOverwrite is true (auto-save scenario), skip conflict handling.
    // Otherwise, if the server rejects due to existing file, let the user confirm or choose a different path.
    let res = await fetch('/api/save-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path, content, force_overwrite: forceOverwrite}) });
    let j = await res.json();
    if (!res.ok) {
      const errMsg = (j && j.error) ? String(j.error).toLowerCase() : '';
      const conflictLike = errMsg.includes('exist') || errMsg.includes('already exists') || res.status === 409 || res.status === 412;
      if (conflictLike && !forceOverwrite) {
        // Ask user to confirm/choose alternate path using Save As modal if available
        if (typeof window.showSaveAsModal === 'function') {
          const chosen = await window.showSaveAsModal(path);
          if (!chosen) return { path, saved: false, reason: 'cancelled' };
          path = chosen.trim();
          res = await fetch('/api/save-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path, content, force_overwrite: true}) });
          j = await res.json();
          if (!res.ok) throw new Error('Save failed: ' + (j.error || JSON.stringify(j)));
        } else {
          // fallback to native confirm behaviour
          const okToOverwrite = confirm(`${path} already exists on server. Overwrite?`);
          if (!okToOverwrite) return { path, saved: false, reason: 'cancelled' };
          // user accepted overwrite; try saving again with force_overwrite flag
          res = await fetch('/api/save-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path, content, force_overwrite: true}) });
          j = await res.json();
          if (!res.ok) throw new Error('Save failed: ' + (j.error || JSON.stringify(j)));
        }
      } else {
        // other errors — surface
        throw new Error('Save failed: ' + (j.error || JSON.stringify(j)));
      }
    }
      // update state
    document.getElementById('status').textContent = `Saved ${j.path}`;
    originalConfigText = content;
    originalConfigPath = j.path || originalConfigPath;
    originalConfigIsLocal = false;
    const configSaveState = document.getElementById('configSaveState'); if (configSaveState) configSaveState.textContent = 'saved';
    const saveBtnEl = document.getElementById('saveConfigBtn'); if (saveBtnEl) { saveBtnEl.disabled = true; saveBtnEl.classList.add('saved'); }
    const saveStateEl = document.getElementById('configSaveState'); if (saveStateEl) { saveStateEl.textContent = 'Saved'; saveStateEl.classList.add('visible'); }
      // saved -> analyze should be available
      try { const analyzeBtn = document.getElementById('analyzeBtn'); if (analyzeBtn) analyzeBtn.disabled = false; } catch (e) {}
    return j;
  }

  // Show Save As modal if present in the DOM. Returns a Promise that resolves
  // to the chosen path string, or null if user cancels. If no modal exists this
  // function falls back to window.prompt to get a path.
  async function showSaveAsModal(initialPath) {
    try {
      const modal = document.getElementById('saveAsModal');
      if (!modal) return Promise.resolve(prompt('Enter path to save config (relative or absolute):', initialPath || 'configs/myconfig.yml'));

      const input = document.getElementById('saveAsInput');
      const confirmBtn = document.getElementById('saveAsConfirm');
      const cancelBtn = document.getElementById('saveAsCancel');

      input.value = initialPath || '';
      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden', 'false');
      input.focus();

      return await new Promise((resolve) => {
        const cleanup = () => {
          modal.classList.add('hidden');
          modal.setAttribute('aria-hidden', 'true');
          confirmBtn.removeEventListener('click', onConfirm);
          cancelBtn.removeEventListener('click', onCancel);
        };
        const onConfirm = () => { const val = input.value && input.value.trim(); cleanup(); resolve(val || null); };
        const onCancel = () => { cleanup(); resolve(null); };
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // Load dataset_description.json from server (bidsPath + filename) and populate form fields
  async function loadDatasetDescription(bidsPath, filename) {
    const bp = bidsPath || document.getElementById('config_bids_path')?.value.trim();
    const fn = filename || document.getElementById('config_dataset_description_file')?.value.trim() || 'dataset_description.json';
    if (!bp) throw new Error('Missing BIDS path');
    const p = (bp.endsWith('/') ? bp.slice(0,-1) : bp) + '/' + fn;
    const res = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: p }) });
    const j = await res.json();
    if (!res.ok) {
      // return structured failure so callers can handle missing dataset_description
      return { ok: false, path: p, error: j && j.error ? j.error : JSON.stringify(j) };
    }
    // server returns raw content — accept either stringified JSON or already parsed objects
    let obj = {};
    if (typeof j.content === 'string') {
      try { obj = JSON.parse(j.content); } catch(e) { throw new Error('Invalid JSON in dataset_description: ' + e.message); }
    } else if (typeof j.content === 'object' && j.content !== null) {
      obj = j.content;
    } else {
      throw new Error('Empty dataset_description content');
    }

    // Populate form fields from the JSON content
    if (obj.Name) document.getElementById('config_dataset_name').value = obj.Name;
    if (obj.BIDSVersion) document.getElementById('config_bids_version').value = obj.BIDSVersion;
    if (obj.DatasetType) document.getElementById('config_dataset_type').value = obj.DatasetType;
    if (obj.License) document.getElementById('config_license').value = obj.License;
    if (obj.Authors) document.getElementById('config_authors').value = Array.isArray(obj.Authors) ? obj.Authors.join(', ') : String(obj.Authors || '');
    if (obj.Acknowledgements) document.getElementById('config_acknowledgements').value = obj.Acknowledgements;
    if (obj.HowToAcknowledge) document.getElementById('config_how_to_acknowledge').value = obj.HowToAcknowledge;
    if (obj.Funding) document.getElementById('config_funding').value = Array.isArray(obj.Funding) ? obj.Funding.join(', ') : String(obj.Funding || '');
    if (obj.EthicsApprovals) document.getElementById('config_ethics_approvals').value = Array.isArray(obj.EthicsApprovals) ? obj.EthicsApprovals.join(', ') : String(obj.EthicsApprovals || '');
    if (obj.ReferencesAndLinks) document.getElementById('config_references_links').value = Array.isArray(obj.ReferencesAndLinks) ? obj.ReferencesAndLinks.join(', ') : String(obj.ReferencesAndLinks || '');
    if (obj.DatasetDOI) document.getElementById('config_dataset_doi').value = obj.DatasetDOI;
    if (obj.GeneratedBy && Array.isArray(obj.GeneratedBy) && obj.GeneratedBy[0] && obj.GeneratedBy[0].CodeURL) document.getElementById('config_code_url').value = obj.GeneratedBy[0].CodeURL;
    return { ok: true, path: p, content: obj };
  }

  // Helper to indicate whether the current config has a saved server-side path
  function isConfigSaved() {
    try {
      const stateEl = document.getElementById('configSaveState');
      const state = stateEl ? (stateEl.textContent || '').trim().toLowerCase() : '';
      return !!originalConfigPath && !originalConfigIsLocal && (state === 'saved' || state === 'loaded');
    } catch (e) { return false; }
  }

  function getSavedConfigPath() { return (!originalConfigIsLocal && originalConfigPath) ? originalConfigPath : ''; }

  // Build a job payload to send to the server. Prefer using server-side path
  // when a saved config exists (so the server runs the actual file). Fall
  // back to inline YAML when no saved path is available.
  function buildJobPayload(action) {
    if (isConfigSaved()) return { config_path: originalConfigPath, action };
    // If we have an originalConfigText (e.g. user uploaded or loaded a template),
    // merge current form values into that template so the shape/keys match the
    // original YAML (this prevents type mismatches like Tasks being a string).
    if (originalConfigText && typeof originalConfigText === 'string' && originalConfigText.trim()) {
      return { config_yaml: writeFormToYaml(originalConfigText), action };
    }
    return { config_yaml: writeFormToYaml(), action };
  }

  window.AppConfig = { parseSimpleYaml, populateFormFromYaml, writeFormToYaml, buildDatasetDescription, saveDatasetDescription, loadDatasetDescription, saveConfig, showSaveAsModal, isConfigSaved, getSavedConfigPath, buildJobPayload };
})();
