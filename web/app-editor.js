// Editor / Analyse view helpers — responsible for opening TSV conversion table editor
(function(){
  function escapeHtml(str){ return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // helper: make header labels prettier across the module
  const pretty = (h) => {
    if (!h) return '';
    const key = String(h).toLowerCase();
    const map = {
      session_from: 'Scan date',
      status: 'Status',
      participant_to: 'Participant',
      session_to: 'Session',
      task: 'Task',
      split: 'Split',
      run: 'Run',
      acquisition: 'Acq.',
      processing: 'Processing',
      raw_name: 'Raw name',
      raw_file: 'Raw name',
      bids_name: 'BIDS name',
      bids_file: 'BIDS name'
    };
    return map[key] || String(h).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  // helper: safe CSS class name from column header / key
  const colClassName = (h) => {
    if (!h) return '';
    return String(h).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/g, '_').replace(/^_+|_+$/g, '');
  };

  // Estimate column widths in px from headers and rows using a simple heuristic.
  // Returns an array of widths (px) aligned with headers array.
  function estimateColumnWidths(headers, rows) {
    const avgCharPx = 8; // rough per-character width (UI font)
    const padding = 36; // cell padding to keep bits of space
    // sensible per-key min/max (px)
    const defaults = {
      session_from: [90, 140],
      status: [100, 140],
      participant_to: [20, 100],
      session_to: [60, 160],
      task: [120, 280],
      split: [20, 25],
      run: [20, 25],
      acquisition: [70, 180],
      processing: [80, 260],
      raw_name: [120, 520],
      bids_name: [160, 640]
    };

    const out = [];
    if (!Array.isArray(headers)) return out;
    for (let ci = 0; ci < headers.length; ci++) {
      const h = headers[ci] || '';
      const key = String(h).toLowerCase();
      let maxLen = String(pretty(h)).length;
      for (let r = 0; r < (rows || []).length; r++) {
        const val = rows[r] && rows[r][ci] !== undefined && rows[r][ci] !== null ? String(rows[r][ci]) : '';
        if (val.length > maxLen) maxLen = val.length;
      }
      // base width from characters
      let width = Math.round(maxLen * avgCharPx + padding);
      // clamp to defaults if we have them
      const def = Object.keys(defaults).find(k => key.includes(k));
      if (def) {
        const [mn, mx] = defaults[def];
        if (width < mn) width = mn;
        if (width > mx) width = mx;
      } else {
        // global clamp
        if (width < 48) width = 48; if (width > 800) width = 800;
      }
      out.push(width);
    }
    return out;
  }

  // NOTE: automatic sizing (fit-to-content) was removed — styles.css controls column widths.
  // to avoid thrashing while typing.
  let _reflowTimer = null;
  // automatic sizing disabled — JS won't inject inline widths so CSS can control layout
  let autoSizeEnabled = false;
  // scheduleReflow() intentionally disabled — automatic fitting removed.
  function scheduleReflow(headers, rows, delay = 120) { /* no-op */ }

  function applyEstimatedColWidths(headers, rows) {
    try {
      const container = document.getElementById('tableContainer'); if (!container) return;
      const colgroup = container.querySelector('colgroup'); if (!colgroup) return;
      const widths = estimateColumnWidths(headers, rows);
      // include a placeholder for the checkbox col
      // col elements are ordered: checkbox, then headers
      const cols = Array.from(colgroup.querySelectorAll('col'));
      // start at index 1 to map headers -> cols
      for (let i = 0; i < headers.length; i++) {
        const col = cols[i+1]; if (!col) continue;
        const w = widths[i]; if (typeof w === 'number') col.style.width = w + 'px';
      }
    } catch (e) { /* tolerate failures in DOM-less tests */ }
  }

  // Build a BIDS filename for a row using the pattern:
  // sub-<label>[_ses-<label>]_task-<label>[_acq-<label>][_run-<index>][_proc-<label>][_split-<index>]_meg.<ext>
  // We primarily derive pieces from participant_to, session_to, task, acquisition, run, processing, split.
  function buildBidsNameFromRow(headers, row) {
    if (!headers || !row) return '';
    const get = (key) => {
      const idx = headers.findIndex(h => (h||'').toLowerCase() === key);
      return idx >= 0 ? String(row[idx] || '').trim() : '';
    };
    let subj = get('participant_to'); if (!subj) subj = get('participant');
    if (subj.startsWith('sub-')) subj = subj.slice(4);
    const ses = get('session_to');
    const task = get('task');
    const acq = get('acquisition');
    const run = get('run');
    const proc = get('processing');
    const split = get('split');
    // determine extension: prefer existing bids_name ext, then raw_name ext
    const existingBids = get('bids_name');
    const raw = get('raw_name') || get('raw_file') || '';
    const extFrom = (s) => { const m = String(s).match(/\.([A-Za-z0-9]+)$/); return m ? m[1] : ''; };
    let ext = extFrom(existingBids) || extFrom(raw) || 'fif';

    const parts = [];
    if (subj) parts.push('sub-' + subj);
    if (ses) parts.push('ses-' + ses);
    // task is required in the pattern
    parts.push('task-' + (task || 'unknown'));
    if (acq) parts.push('acq-' + acq);
    // run and split zero-padded 2 digits if numeric-ish
    if (run) {
      const rstr = String(run);
      const rnum = (/^\d+$/.test(rstr)) ? rstr.padStart(2, '0') : rstr;
      parts.push('run-' + rnum);
    }
    if (proc) parts.push('proc-' + proc);
    if (split) {
      const sstr = String(split);
      const snum = (/^\d+$/.test(sstr)) ? sstr.padStart(2, '0') : sstr;
      parts.push('split-' + snum);
    }
    // join with underscores and add meg.<ext>
    const name = parts.join('_') + '_meg.' + ext;
    return name;
  }

  // Return numeric split count from the row, preferring the 'split' column if numeric,
  // otherwise try to parse split-(\d+) from bids_name. Returns integer or 0.
  function getSplitCountFromRow(headers, row) {
    if (!headers || !row) return 0;
    const lower = headers.map(h => (h||'').toLowerCase());
    const idxSplit = lower.indexOf('split');
    if (idxSplit >= 0) {
      const val = String(row[idxSplit] || '').trim();
      if (/^\d+$/.test(val)) return Number(val);
    }
    // parse from bids_name
    const idxBids = lower.indexOf('bids_name');
    if (idxBids >= 0) {
      const bids = String(row[idxBids] || '');
      const m = bids.match(/split-(0*[0-9]+)/i);
      if (m) return Number(m[1]);
    }
    return 0;
  }

  // setAutoSizeEnabled removed — auto-size functionality disabled in favor of CSS-only control

  // state
  let currentEditorData = null;
  // fullEditorData stores the complete (original) table as parsed from the TSV
  // currentEditorData contains the subset/ordering shown in the editor UI.
  let fullEditorData = null;
  let originalEditorData = null;
  const modifiedRows = new Set();
  const manualStatusChanges = new Set();

  async function loadArtifact(jobId, index) {
    try {
      // First get the artifact path from the job artifacts list
      const artifactsResp = await fetch(`/api/jobs/${jobId}/artifacts`);
      let artifactPath = null;
      if (artifactsResp.ok) {
        const artifactsData = await artifactsResp.json();
        const artifacts = artifactsData.artifacts || [];
        if (index >= 0 && index < artifacts.length) {
          artifactPath = artifacts[index];
        }
      }
      
      // Download the artifact content
      const resp = await fetch(`/api/jobs/${jobId}/artifact?index=${index}`);
      if (!resp.ok) throw new Error('Failed to download artifact');
      const text = await resp.text();
      
      // Use the actual artifact path as the filename if available
      const filename = artifactPath ? artifactPath.split('/').pop() : `${jobId}-artifact-${index}.tsv`;
      openTableEditor(text, filename);
      
      // Populate the saveTablePath with the actual artifact path for easy save-back
      if (artifactPath) {
        const savePathEl = document.getElementById('saveTablePath');
        if (savePathEl) {
          savePathEl.value = artifactPath;
          console.log('[AppEditor] Set saveTablePath from artifact:', artifactPath);
        }
      }
    } catch (err) {
      alert('Error loading artifact: ' + err.message);
    }
  }

  // Populate filter dropdowns for editor (subject/session/task/acquisition)
  function populateFilterDropdowns() {
    if (!currentEditorData) return;
    const { headers, rows } = currentEditorData;
    const lower = headers.map(h => (h||'').toLowerCase());
    const idx = (name) => lower.indexOf(name);

    const colValues = (colName) => {
      const i = idx(colName); if (i < 0) return [];
      const s = new Set(); rows.forEach(r => { const v = r[i]; if (v !== undefined && String(v).trim() !== '') s.add(String(v).trim()); }); return Array.from(s).sort();
    };

    const subjectEl = document.getElementById('subjectFilterSelect'); if (subjectEl) {
      const vals = colValues('participant_to'); subjectEl.innerHTML = '<option value="">All Subjects</option>' + vals.map(v => `<option value="${v}">${v}</option>`).join('');
    }
    const sessionEl = document.getElementById('sessionFilterSelect'); if (sessionEl) {
      const vals = colValues('session_to'); sessionEl.innerHTML = '<option value="">All Sessions</option>' + vals.map(v => `<option value="${v}">${v}</option>`).join('');
    }
    const taskEl = document.getElementById('taskFilterSelect'); if (taskEl) {
      const detectedTasks = colValues('task');
      // get tasks from the config form (comma-separated)
      const configTasksRaw = (document.getElementById('config_tasks')?.value || '').trim();
      const configTasks = configTasksRaw ? configTasksRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];

      // Build options: prefer config-defined tasks (and only if they appear in the detected set)
      const opts = [];
      opts.push('<option value="">All Tasks</option>');
      const seen = new Set();
      for (const t of configTasks) {
        if (!t) continue;
        // only include config tasks that exist in detectedTasks or include them anyway
        seen.add(t);
        opts.push(`<option value="${t}">${t}</option>`);
      }

      // Determine other tasks not listed in config
      const others = detectedTasks.filter(t => !seen.has(t));
      if (others.length > 0) {
        // Insert a visual separator (disabled) then an 'Other' option to show non-config tasks
        opts.push('<option disabled>──────────</option>');
        opts.push('<option value="__OTHER__">Other (non-config tasks)</option>');
      }

      taskEl.innerHTML = opts.join('');
    }
    const acqEl = document.getElementById('acquisitionFilterSelect'); if (acqEl) {
      const vals = colValues('acquisition'); acqEl.innerHTML = '<option value="">All Acquisitions</option>' + vals.map(v => `<option value="${v}">${v}</option>`).join('');
    }
    updateEditorRowCount();
  }

  function updateEditorRowCount() {
    try {
      const el = document.getElementById('editorRowCount'); if (!el) return;
      const total = currentEditorData ? currentEditorData.rows.length : 0;
      const visible = document.getElementById('tableContainer') ? document.getElementById('tableContainer').querySelectorAll('tbody tr').length : 0;
      const selected = document.getElementById('tableContainer') ? document.getElementById('tableContainer').querySelectorAll('input[data-select-row]:checked').length : 0;
      const mods = modifiedRows.size;
      el.textContent = `${visible} visible / ${total} total — ${selected} selected — ${mods} modified`;
    } catch (e) { }
  }

  function openTableEditor(tsvText, filename = 'conversion.tsv') {
    const editor = document.getElementById('tableEditor');
    const container = document.getElementById('tableContainer');
    // Do not switch the main view automatically. Only make the editor panel
    // visible so the user can open the editor manually without changing the
    // current active view. This avoids remote/automatic UI navigation.
    try { if (editor) editor.style.display = 'block'; } catch(e) {}

    // parse TSV using EditorModel if available
    let model = null; let headers = [], rows = [];
    try {
      if (window.EditorModel && typeof window.EditorModel.tsvToModel === 'function') {
        model = window.EditorModel.tsvToModel(tsvText);
        headers = model.headers; rows = model.rows;
      } else {
        const lines = tsvText.trim().split('\n');
        headers = lines[0].split('\t').map(h => h.trim());
        rows = lines.slice(1).map(line => line.split('\t'));
      }
    } catch (e) {
      const lines = tsvText.trim().split('\n');
      headers = lines[0].split('\t').map(h => h.trim());
      rows = lines.slice(1).map(line => line.split('\t'));
    }

    // Keep a copy of the full parsed table so we can preserve all columns
    // even when the editor displays only a subset of columns.
    const fullHeaders = headers.slice();
    const fullRows = rows.map(r => r.slice());

    const lower = headers.map(h => (h||'').toLowerCase());

    // Desired editor column order and fallbacks. We prefer existing header names
    // when present; otherwise we will add column placeholders so the editor can
    // show a consistent fixed column set for conversion tables.
    const desiredCols = [
      { key: 'status', fallbacks: ['status'] },
      { key: 'participant_to', fallbacks: ['participant_to','subject_to','participant'] },
      { key: 'session_to', fallbacks: ['session_to'] },
      { key: 'task', fallbacks: ['task'] },
      { key: 'split', fallbacks: ['split'] },
      { key: 'run', fallbacks: ['run'] },
      { key: 'acquisition', fallbacks: ['acquisition','acq'] },
      { key: 'processing', fallbacks: ['processing'] },
      { key: 'raw_name', fallbacks: ['raw_name','raw_file','raw'] },
      { key: 'bids_name', fallbacks: ['bids_name','bids_file','bids'] }
    ];

    // Detect if we have any of the desired conversion-like keys in incoming headers
    const anyDesiredPresent = desiredCols.some(dc => dc.fallbacks.some(f => lower.includes(f)));
    if (anyDesiredPresent) {
      // Build a reordered headers array that contains only the desired columns
      const newHeaders = [];
      const newRows = rows.map(r => []);

      for (const dc of desiredCols) {
        // find first matching header name in existing headers
        const foundIndex = lower.findIndex(h => dc.fallbacks.includes(h));
        if (foundIndex >= 0) {
          // Use the original header string (preserve case)
          newHeaders.push(headers[foundIndex]);
          // copy column values
          for (let i = 0; i < rows.length; i++) newRows[i].push(rows[i][foundIndex] || '');
        } else {
          // not present in source; add empty placeholder column with key as header
          newHeaders.push(dc.key);
          for (let i = 0; i < rows.length; i++) newRows[i].push('');
        }
      }

      headers = newHeaders;
      rows = newRows;
    }

    // render table
    let html = '<table class="editor-table">';
    // render headers with column classes and the global pretty helper
    // build colgroup with estimated widths
    const widths = estimateColumnWidths(headers, rows);
    // Do not inject inline widths here — prefer stylesheet control.
    const colgroup = '<colgroup>' + `<col class="col-checkbox">` + headers.map((h,i) => `<col class="col-${colClassName(h)}">`).join('') + '</colgroup>';
    html += colgroup;
    html += '<thead><tr>' + headers.map(h => `<th class="col-${colClassName(h)}">${pretty(h)}</th>`).join('') + '</tr></thead>';
    html += '<tbody>' + rows.map((r, ri) => {
      const cells = r.map((cell, ci) => {
        const cls = colClassName(headers[ci]);
        return `\n    <td class="col-${cls}">` + `<input data-row="${ri}" data-col="${ci}" value="${escapeHtml(cell)}">` + `</td>`;
      }).join('');
      return `\n  <tr data-row="${ri}">${cells}\n  </tr>`;
    }).join('') + '\n</tbody>';
    html += '\n</table>';
    container.innerHTML = html;

    // Ensure bids_name includes split tag from the start if split column exists
    try {
      const lower = headers.map(h => (h||'').toLowerCase());
      const splitIdx = lower.indexOf('split');
      const bidsIdx = lower.indexOf('bids_name');
      if (splitIdx >= 0 && bidsIdx >= 0) {
        for (let ri = 0; ri < rows.length; ri++) {
          const splitVal = String(rows[ri][splitIdx] || '').trim();
          const bidsVal = String(rows[ri][bidsIdx] || '');
          // if split present and bids_name does not already have a split tag, rebuild bids_name
          if (splitVal !== '' && !/split-\d+|split-[A-Za-z0-9_-]+/i.test(bidsVal)) {
            try {
              rows[ri][bidsIdx] = buildBidsNameFromRow(headers, rows[ri]);
            } catch (e) { /* ignore */ }
          }
        }
      }
    } catch (e) { /* tolerate in tests */ }

    // Store the full original table for merging on save/download.
    fullEditorData = { headers: JSON.parse(JSON.stringify(fullHeaders)), rows: JSON.parse(JSON.stringify(fullRows)), filename };
    // Keep an immutable copy of the original full table for change detection
    originalEditorData = { headers: JSON.parse(JSON.stringify(fullEditorData.headers)), rows: JSON.parse(JSON.stringify(fullEditorData.rows)), filename };
    modifiedRows.clear(); manualStatusChanges.clear();
    currentEditorData = { headers, rows, filename };
    // Populate filter dropdowns (best-effort)
    if (typeof populateFilterDropdowns === 'function') try { populateFilterDropdowns(); } catch(e) { /* ignore */ }

    if (document.getElementById('saveTableServer')) document.getElementById('saveTableServer').disabled = true;
    if (document.getElementById('saveTableCanonical')) document.getElementById('saveTableCanonical').disabled = true;
    if (document.getElementById('downloadTable')) document.getElementById('downloadTable').disabled = true;
    renderTableFromData();

    if (document.getElementById('downloadTable')) document.getElementById('downloadTable').onclick = downloadEditedTable;
    if (document.getElementById('closeEditor')) document.getElementById('closeEditor').onclick = () => {
      // Close editor UI panel but do NOT switch the active main view.
      try { if (editor) editor.style.display = 'none'; } catch(e) {}
      // Keep any existing navigation state unchanged.
    };

    // attach UI controls that may or may not exist
    // support both the legacy 'tableSearch' id and the current 'editorSearchInput'
    const searchEl = document.getElementById('tableSearch') || document.getElementById('editorSearchInput');
    if (searchEl) searchEl.oninput = () => renderTableFromData();
    // wire filter selects if present
    ['subjectFilterSelect','sessionFilterSelect','statusFilterSelect','taskFilterSelect','acquisitionFilterSelect'].forEach(id => { const el = document.getElementById(id); if (el) el.onchange = () => renderTableFromData(); });
    if (document.getElementById('findReplaceBtn')) document.getElementById('findReplaceBtn').onclick = findReplaceInTable;
    if (document.getElementById('addRowBtn')) document.getElementById('addRowBtn').onclick = () => addRowToTable();
    if (document.getElementById('deleteRowsBtn')) document.getElementById('deleteRowsBtn').onclick = () => deleteSelectedRows();
    if (document.getElementById('applyColBtn')) document.getElementById('applyColBtn').onclick = () => applyToColumn();
    if (document.getElementById('addColBtn')) document.getElementById('addColBtn').onclick = () => addColumnToTable();
    if (document.getElementById('delColBtn')) document.getElementById('delColBtn').onclick = () => deleteColumnFromTable();
    if (document.getElementById('sortAscBtn')) document.getElementById('sortAscBtn').onclick = () => sortTableByColumn(true);
    if (document.getElementById('sortDescBtn')) document.getElementById('sortDescBtn').onclick = () => sortTableByColumn(false);
    if (document.getElementById('moveUpBtn')) document.getElementById('moveUpBtn').onclick = () => moveSelectedRows(-1);
    if (document.getElementById('moveDownBtn')) document.getElementById('moveDownBtn').onclick = () => moveSelectedRows(1);
    if (document.getElementById('reloadEditorBtn')) document.getElementById('reloadEditorBtn').onclick = () => {
      // Reload from the full original table so the editor view is rebuilt
      // (preserving all columns and re-applying the desired subset view).
      if (!fullEditorData && !originalEditorData) return alert('Nothing to reload');
      try {
        const tsv = (window.EditorModel && typeof window.EditorModel.modelToTsv === 'function') ? window.EditorModel.modelToTsv(fullEditorData || originalEditorData) : [ (fullEditorData || originalEditorData).headers.join('\t') ].concat((fullEditorData || originalEditorData).rows.map(r=>r.join('\t'))).join('\n');
        openTableEditor(tsv, (fullEditorData || originalEditorData).filename);
      } catch(e) {
        // fallback to simple restore
        currentEditorData = { headers: JSON.parse(JSON.stringify(originalEditorData.headers)), rows: JSON.parse(JSON.stringify(originalEditorData.rows)), filename: originalEditorData.filename };
        modifiedRows.clear(); manualStatusChanges.clear(); renderTableFromData();
      }
      if (document.getElementById('saveTableServer')) document.getElementById('saveTableServer').disabled = true; if (document.getElementById('saveTableCanonical')) document.getElementById('saveTableCanonical').disabled = true; if (document.getElementById('downloadTable')) document.getElementById('downloadTable').disabled = true;
    };
  }

  // renderTableFromData and helpers
  function renderTableFromData() {
    const container = document.getElementById('tableContainer');
    if (!currentEditorData || !container) { if (container) container.innerHTML = ''; return; }
    // Support both search IDs (legacy tableSearch and editorSearchInput)
    const searchEl2 = document.getElementById('tableSearch') || document.getElementById('editorSearchInput');
    const search = (searchEl2?.value || '').toLowerCase().trim();
    // filter selects (possible values)
    const subjectFilter = (document.getElementById('subjectFilterSelect')?.value || '').toLowerCase().trim();
    const sessionFilter = (document.getElementById('sessionFilterSelect')?.value || '').toLowerCase().trim();
    const statusFilter = (document.getElementById('statusFilterSelect')?.value || '').toLowerCase().trim();
    const taskFilter = (document.getElementById('taskFilterSelect')?.value || '').toLowerCase().trim();
    const acqFilter = (document.getElementById('acquisitionFilterSelect')?.value || '').toLowerCase().trim();
    const { headers, rows } = currentEditorData;
    let html = '<table class="editor-table">';
    // include colgroup so applied widths also apply on subsequent render updates
    const widths2 = estimateColumnWidths(headers, rows);
    // Keep a colgroup but avoid inline width styles so CSS rules can take effect.
    const colgroup2 = '<colgroup>' + `<col class="col-checkbox">` + headers.map((h,i) => `<col class="col-${colClassName(h)}">`).join('') + '</colgroup>';
    html += colgroup2;
    html += '<thead><tr><th class="checkbox-cell">☑</th>' + headers.map(h => `<th class="col-${colClassName(h)}">${pretty(h)}</th>`).join('') + '</tr></thead>';
    html += '<tbody>' + rows.map((r, ri) => {
      const rowText = r.join('\t').toLowerCase(); if (search && rowText.indexOf(search) === -1) return '';
      // apply select filters: match canonical column names (case-insensitive)
      const lowerHeaders = headers.map(h => (h||'').toLowerCase());
      const getVal = (name) => { const idx = lowerHeaders.indexOf(name); return idx >= 0 ? String(r[idx] || '').toLowerCase() : ''; };
      if (subjectFilter) { const v = getVal('participant_to'); if (v !== subjectFilter) return ''; }
      if (sessionFilter) { const v = getVal('session_to'); if (v !== sessionFilter) return ''; }
      if (statusFilter) { const v = getVal('status'); if (v !== statusFilter) return ''; }
      if (taskFilter) {
        const v = getVal('task');
        // read config tasks from the config form and compare case-insensitively
        const cfgRaw = (document.getElementById('config_tasks')?.value || '').trim();
        const cfgTasks = cfgRaw ? cfgRaw.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean) : [];
        if (taskFilter === '__other__' || taskFilter === '__OTHER__') {
          // other: show rows with a task value that is not included in the config tasks
          if (!v) return '';
          if (cfgTasks.includes(v)) return '';
        } else {
          if (v !== taskFilter) return '';
        }
      }
      if (acqFilter) { const v = getVal('acquisition'); if (v !== acqFilter) return ''; }
      // Only a subset of columns are editable. Render others as text.
      const editableSet = { status: 'select', task: 'text', run: 'text' };
      const cells = r.map((cell, ci) => {
        const key = (headers[ci]||'').toLowerCase();
        const cls = colClassName(headers[ci]);
        if (key === 'status') {
          return `\n    <td class="col-${cls}"><select data-row="${ri}" data-col="${ci}"><option value="">--</option><option value="run">run</option><option value="check">check</option><option value="processed">processed</option><option value="skip">skip</option><option value="missing">missing</option></select></td>`;
        }
        if (key === 'task' || key === 'run' || key === 'split') {
          return `\n    <td class="col-${cls}"><input data-row="${ri}" data-col="${ci}" value="${escapeHtml(cell)}"></td>`;
        }
        // readonly for other columns — add title so full content is visible on hover
        const titleAttr = escapeHtml(cell || '');
        // If this is raw_name, optionally append a visual split suffix when numeric > 1
        if ((headers[ci]||'').toLowerCase() === 'raw_name' || (headers[ci]||'').toLowerCase() === 'raw_file') {
          const splitCount = getSplitCountFromRow(headers, r);
          const suffix = (typeof splitCount === 'number' && splitCount >= 1) ? ` <span class="split-suffix">(+${splitCount})</span>` : '';
          return `\n    <td class="col-${cls}" title="${titleAttr}">` + escapeHtml(cell) + suffix + `</td>`;
        }
        return `\n    <td class="col-${cls}" title="${titleAttr}">${escapeHtml(cell)}</td>`;
      }).join('');
      return `\n  <tr data-row="${ri}"><td class="checkbox-cell"><input type='checkbox' data-select-row='${ri}'></td>` + cells + `\n  </tr>`;
    }).join('') + '\n</tbody>';
    html += '\n</table>';
    container.innerHTML = html;

    // wire inputs
    const inputs = container.querySelectorAll('input[data-row][data-col], select[data-row][data-col]');
    inputs.forEach(inp => {
      inp.oninput = inp.onchange = (ev) => {
        const r = parseInt(inp.dataset.row, 10); const c = parseInt(inp.dataset.col, 10); const val = inp.value;
        currentEditorData.rows[r][c] = val;
        // If user edited 'task' column, attempt to keep bids_name in sync
        const colKey = (currentEditorData.headers[c] || '').toLowerCase();
        // if certain fields change, rebuild the bids_name from the full row
        const changedKeysForBids = ['task','run','split','participant_to','participant','session_to','session','acquisition','processing','raw_name','raw_file'];
        if (changedKeysForBids.includes(colKey)) {
          const bidsIdx = currentEditorData.headers.findIndex(h => (h||'').toLowerCase() === 'bids_name');
          if (bidsIdx >= 0) {
            const newBids = buildBidsNameFromRow(currentEditorData.headers, currentEditorData.rows[r]);
            if (newBids) {
              const old = currentEditorData.rows[r][bidsIdx] || '';
              if (old !== newBids) {
                currentEditorData.rows[r][bidsIdx] = newBids;
                // update DOM cell if present
                try {
                  const td = container.querySelector(`tr[data-row='${r}'] td.col-${colClassName('bids_name')}`);
                  if (td) { td.textContent = newBids; try { td.title = newBids; } catch(e){} }
                } catch (e) {}
              }
            }
            // also update raw_name display to show a split marker like 'raw_name (+n)' when split > 1
            try {
              const rawIdx = currentEditorData.headers.findIndex(h => ['raw_name','raw_file','raw'].includes((h||'').toLowerCase()));
              if (rawIdx >= 0) {
                const rawVal = currentEditorData.rows[r][rawIdx] || '';
                const splitVal = (currentEditorData.headers.includes('split') ? currentEditorData.rows[r][ currentEditorData.headers.findIndex(h=> (h||'').toLowerCase()==='split') ] : '') || '';
                let disp = rawVal;
                const snum = Number(String(splitVal).trim());
                if (!Number.isNaN(snum) && snum >= 1) {
                  disp = `${rawVal} (+${snum})`;
                }
                const tdRaw = container.querySelector(`tr[data-row='${r}'] td.col-${colClassName(currentEditorData.headers[rawIdx])}`);
                  if (tdRaw) {
                    // preserve the split-suffix element (visual-only) by setting innerHTML
                    const snum = Number(String(splitVal).trim());
                    const suffix = (!Number.isNaN(snum) && snum >= 1) ? ` <span class="split-suffix">(+${snum})</span>` : '';
                    try { tdRaw.innerHTML = escapeHtml(rawVal) + suffix; } catch(e) { tdRaw.textContent = disp; }
                    try { tdRaw.title = rawVal; } catch(e){}
                  }
              }
            } catch (e) {}
          }
        }
        // Compare edited value against the original full table value for the
        // corresponding column (map view column -> full column by header name).
        try {
          if (fullEditorData && fullEditorData.headers && fullEditorData.rows && fullEditorData.rows[r]) {
            const viewHeader = (currentEditorData.headers[c] || '').toLowerCase();
            let fullIdx = fullEditorData.headers.map(h => (h||'').toLowerCase()).indexOf(viewHeader);
            let original = '';
            if (fullIdx >= 0) original = fullEditorData.rows[r][fullIdx] || '';
            else original = '';
            if (original !== (val||'')) modifiedRows.add(r);
            else {
              // If all view columns match their original full values, mark row unmodified
              const rowNow = currentEditorData.rows[r] || [];
              const viewHeaders = currentEditorData.headers || [];
              let anyDiff = false;
              for (let vi = 0; vi < viewHeaders.length; vi++) {
                const vh = (viewHeaders[vi]||'').toLowerCase();
                const fidx = fullEditorData.headers.map(h => (h||'').toLowerCase()).indexOf(vh);
                const nowVal = String((rowNow[vi]||'') || '');
                const origVal = (fidx >= 0 && fullEditorData.rows[r] && fullEditorData.rows[r][fidx] !== undefined) ? String(fullEditorData.rows[r][fidx]||'') : '';
                if (nowVal !== origVal) { anyDiff = true; break; }
              }
              if (!anyDiff) modifiedRows.delete(r);
            }
          } else {
            modifiedRows.add(r);
          }
        } catch (e) { modifiedRows.add(r); }
        if ((currentEditorData.headers[c]||'').toLowerCase() === 'status') manualStatusChanges.add(r);
        const hasMods = modifiedRows.size > 0; if (document.getElementById('saveTableServer')) document.getElementById('saveTableServer').disabled = !hasMods; if (document.getElementById('saveTableCanonical')) document.getElementById('saveTableCanonical').disabled = !hasMods; if (document.getElementById('downloadTable')) document.getElementById('downloadTable').disabled = !hasMods;
        const rowEl = container.querySelector(`tr[data-row='${r}']`); if (rowEl) { if (hasMods && modifiedRows.has(r)) rowEl.classList.add('row-modified'); else rowEl.classList.remove('row-modified'); }
        // automatic sizing removed — no reflow scheduled here so CSS controls widths
      };
    });

    // select-all
    const thead = container.querySelector('thead tr'); if (thead) {
      const selectAllCheckbox = document.createElement('input'); selectAllCheckbox.type = 'checkbox'; selectAllCheckbox.id = 'selectAllEditorCheckbox'; selectAllCheckbox.style.cursor = 'pointer'; selectAllCheckbox.onchange = function(){ const boxes = container.querySelectorAll('input[data-select-row]'); boxes.forEach(b => b.checked = selectAllCheckbox.checked); updateSelectionCount(); };
      thead.children[0].innerHTML = ''; thead.children[0].appendChild(selectAllCheckbox);
    }

    const checkboxes = container.querySelectorAll('input[data-select-row]');
    function updateSelectionCount(){ const chosen = Array.from(checkboxes).filter(b=>b.checked).length; const batchBtn = document.getElementById('applyBatchStatusBtn'); if (batchBtn) batchBtn.disabled = chosen === 0; const batchDiv = document.getElementById('batchActionsDiv'); if (batchDiv) batchDiv.style.display = (chosen > 0) ? 'flex' : 'none'; const selectedCountEl = document.getElementById('selectedCount'); if (selectedCountEl) selectedCountEl.textContent = `${chosen} rows selected`; updateEditorRowCount(); }
    checkboxes.forEach(b => b.addEventListener('change', updateSelectionCount)); updateSelectionCount();

    const statusIdx = headers.findIndex(h => (h||'').toLowerCase() === 'status');
    if (statusIdx >= 0) {
      const selects = container.querySelectorAll(`select[data-col='${statusIdx}']`);
      selects.forEach(s => {
        const r = parseInt(s.dataset.row, 10);
        const cur = (currentEditorData.rows[r][statusIdx] || '').toLowerCase(); s.value = cur || '';
        const rowEl = container.querySelector(`tr[data-row='${r}']`); if (rowEl) { rowEl.classList.remove('status-run','status-check','status-processed','status-skip','status-missing'); if (cur) rowEl.classList.add('status-' + cur.replace(/[^a-z0-9_-]/g,'')); }
        s.addEventListener('change', () => {
          const val = s.value || '';
          currentEditorData.rows[r][statusIdx] = val; manualStatusChanges.add(r); modifiedRows.add(r);
          const row = container.querySelector(`tr[data-row='${r}']`); if (row) { row.classList.remove('status-run','status-check','status-processed','status-skip','status-missing'); if (val) row.classList.add('status-' + val.replace(/[^a-z0-9_-]/g,'')); }
          if (document.getElementById('saveTableServer')) document.getElementById('saveTableServer').disabled = false; if (document.getElementById('downloadTable')) document.getElementById('downloadTable').disabled = false;
        });
      });
      }

    // Batch apply: set status for selected rows
    const applyBtn = document.getElementById('applyBatchStatusBtn');
    if (applyBtn) applyBtn.onclick = () => {
      const selected = Array.from(container.querySelectorAll('input[data-select-row]:checked')).map(b => parseInt(b.dataset.selectRow, 10));
      if (selected.length === 0) { alert('No rows selected'); return; }
      const status = (document.getElementById('batchStatusSelect')?.value || '').trim();
      if (!status) { alert('Select a status first'); return; }
      const sIdx = currentEditorData.headers.findIndex(h => (h||'').toLowerCase() === 'status');
      if (sIdx < 0) return alert('No status column present');
      selected.forEach(ridx => {
        if (ridx >= 0 && ridx < currentEditorData.rows.length) {
          currentEditorData.rows[ridx][sIdx] = status;
          modifiedRows.add(ridx); manualStatusChanges.add(ridx);
        }
      });
      renderTableFromData();
    };
  }

  function addRowToTable() { if (!currentEditorData) return; if (window.EditorModel && typeof window.EditorModel.addRow === 'function') { window.EditorModel.addRow(currentEditorData); } else { const cols = currentEditorData.headers.length; currentEditorData.rows.push(Array.from({ length: cols }, () => '')); } renderTableFromData(); }

  function deleteSelectedRows() { if (!currentEditorData) return; const container = document.getElementById('tableContainer'); const boxes = container.querySelectorAll('input[data-select-row]'); const toDelete = Array.from(boxes).filter(b => b.checked).map(b => parseInt(b.dataset.selectRow, 10)); if (toDelete.length === 0) return alert('No rows selected'); if (window.EditorModel && typeof window.EditorModel.deleteRows === 'function') { window.EditorModel.deleteRows(currentEditorData, toDelete); } else { toDelete.sort((a,b)=>b-a).forEach(idx=> currentEditorData.rows.splice(idx, 1)); } renderTableFromData(); }

  function addColumnToTable() { if (!currentEditorData) return; const idx = parseInt(document.getElementById('colIndex')?.value || '', 10); const name = document.getElementById('colName')?.value || `col${currentEditorData.headers.length}`; if (window.EditorModel && typeof window.EditorModel.addColumn === 'function') { window.EditorModel.addColumn(currentEditorData, idx, name); } else { const pos = Number.isNaN(idx) ? currentEditorData.headers.length : Math.max(0, Math.min(idx, currentEditorData.headers.length)); currentEditorData.headers.splice(pos, 0, name); currentEditorData.rows.forEach(r => r.splice(pos, 0, '')); } renderTableFromData(); }

  function deleteColumnFromTable() { if (!currentEditorData) return; const idx = parseInt(document.getElementById('colIndex')?.value || '', 10); if (Number.isNaN(idx) || idx < 0 || idx >= currentEditorData.headers.length) return alert('Invalid column index'); if (window.EditorModel && typeof window.EditorModel.deleteColumn === 'function') { window.EditorModel.deleteColumn(currentEditorData, idx); } else { currentEditorData.headers.splice(idx, 1); currentEditorData.rows.forEach(r => r.splice(idx, 1)); } renderTableFromData(); }

  function sortTableByColumn(asc=true) { if (!currentEditorData) return; const idx = parseInt(document.getElementById('sortColIndex')?.value || '', 10); if (Number.isNaN(idx) || idx < 0 || idx >= currentEditorData.headers.length) return alert('Invalid column index'); if (window.EditorModel && typeof window.EditorModel.sortByColumn === 'function') { window.EditorModel.sortByColumn(currentEditorData, idx, asc); } else { currentEditorData.rows.sort((a,b)=>{ const av = a[idx] || ''; const bv = b[idx] || ''; if (av === bv) return 0; const cmp = av < bv ? -1 : 1; return asc ? cmp : -cmp; }); } renderTableFromData(); }

  function moveSelectedRows(dir) { if (!currentEditorData) return; const container = document.getElementById('tableContainer'); const boxes = Array.from(container.querySelectorAll('input[data-select-row]')).map(b => ({idx: parseInt(b.dataset.selectRow,10), checked: b.checked})).filter(x=>x.checked).map(x=>x.idx); if (boxes.length===0) return alert('No rows selected'); if (window.EditorModel && typeof window.EditorModel.moveRows === 'function') { window.EditorModel.moveRows(currentEditorData, boxes, dir); } else { const rows = currentEditorData.rows; const unique = Array.from(new Set(boxes)).sort((a,b)=> dir>0 ? b-a : a-b); for (const idx of unique) { const newIdx = idx + dir; if (newIdx < 0 || newIdx >= rows.length) continue; const [row] = rows.splice(idx,1); rows.splice(newIdx, 0, row); } } renderTableFromData(); }

  function applyToColumn() { if (!currentEditorData) return; const idx = parseInt(document.getElementById('applyColIndex')?.value||'', 10); const val = document.getElementById('applyColValue')?.value; if (Number.isNaN(idx) || idx < 0 || idx >= currentEditorData.headers.length) return alert('Invalid column index'); if (window.EditorModel && typeof window.EditorModel.applyToColumn === 'function') { window.EditorModel.applyToColumn(currentEditorData, idx, val); } else { currentEditorData.rows.forEach(r => r[idx] = val); } renderTableFromData(); }

  function findReplaceInTable() { if (!currentEditorData) return; const find = document.getElementById('findText')?.value; const repl = document.getElementById('replaceText')?.value; if (!find) return alert('Enter text to find'); if (window.EditorModel && typeof window.EditorModel.findReplace === 'function') { window.EditorModel.findReplace(currentEditorData, find, repl); } else { currentEditorData.rows = currentEditorData.rows.map(r => r.map(cell => cell.split(find).join(repl))); } renderTableFromData(); }

  // Build a merged model containing all original columns with editor edits
  function buildMergedModel() {
    if (!currentEditorData) return null;
    // If we don't have the full original table (legacy), just use the current view
    if (!fullEditorData) return { headers: JSON.parse(JSON.stringify(currentEditorData.headers)), rows: JSON.parse(JSON.stringify(currentEditorData.rows)) };
    const fullH = fullEditorData.headers.slice();
    const fullRows = fullEditorData.rows.map(r => r.slice());
    const viewH = currentEditorData.headers || [];
    const viewRows = currentEditorData.rows || [];
    // Ensure row counts match (expand fullRows if user added rows)
    if (viewRows.length > fullRows.length) {
      const delta = viewRows.length - fullRows.length;
      for (let i=0;i<delta;i++) fullRows.push(Array.from({ length: fullH.length }, () => ''));
    }
    // Overlay view data into fullRows, append columns that didn't exist
    for (let vi = 0; vi < viewH.length; vi++) {
      const vh = (viewH[vi]||'').toLowerCase();
      let fi = fullH.map(h => (h||'').toLowerCase()).indexOf(vh);
      if (fi < 0) {
        fi = fullH.length; fullH.push(currentEditorData.headers[vi] || viewH[vi]);
        fullRows.forEach(r => r.push(''));
      }
      for (let r = 0; r < viewRows.length; r++) {
        fullRows[r][fi] = viewRows[r][vi] || '';
      }
    }
    return { headers: fullH, rows: fullRows };
  }

  function downloadEditedTable(){
    if (!currentEditorData) return;
    const merged = buildMergedModel(); if (!merged) return;
    let tsv = '';
    if (window.EditorModel && typeof window.EditorModel.modelToTsv === 'function') tsv = window.EditorModel.modelToTsv(merged);
    else { const headers = merged.headers; const lines = [headers.join('\t')].concat(merged.rows.map(r => r.join('\t'))); tsv = lines.join('\n'); }
    const blob = new Blob([tsv], { type: 'text/tab-separated-values' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = currentEditorData.filename || 'conversion.tsv'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // Save to server handler (wired by DOM or other init code)
  async function saveTableServer(){
    if (!currentEditorData) return alert('No table opened');
    const path = document.getElementById('saveTablePath')?.value.trim();
    if (!path) return alert('Enter a server path to save the table (e.g. /path/to/logs/bids_conversion.tsv)');
    const merged = buildMergedModel(); if (!merged) return alert('Failed to build merged table');
    let tsv = '';
    if (window.EditorModel && typeof window.EditorModel.modelToTsv === 'function') tsv = window.EditorModel.modelToTsv(merged);
    else tsv = [merged.headers.join('\t')].concat(merged.rows.map(r => r.join('\t'))).join('\n');
    try {
      let res = await fetch('/api/save-file', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({path, content: tsv}) });
      let j = await res.json();
      if (!res.ok) {
        // Handle file exists error
        if (res.status === 409 && j.error === 'file_exists') {
          const okToOverwrite = confirm(`${path} already exists. Overwrite?`);
          if (!okToOverwrite) return;
          res = await fetch('/api/save-file', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({path, content: tsv, force_overwrite: true}) });
          j = await res.json();
          if (!res.ok) { alert('Save failed: ' + (j.error || JSON.stringify(j))); return; }
        } else {
          alert('Save failed: ' + (j.error || JSON.stringify(j))); return;
        }
      }
      // update the stored original/full data to reflect the saved state
      fullEditorData = { headers: JSON.parse(JSON.stringify(merged.headers)), rows: JSON.parse(JSON.stringify(merged.rows)), filename: currentEditorData.filename };
      originalEditorData = { headers: JSON.parse(JSON.stringify(fullEditorData.headers)), rows: JSON.parse(JSON.stringify(fullEditorData.rows)), filename: fullEditorData.filename };
      // Sync the saved path back to config_conversion_file so it stays in sync with the form
      const convFileEl = document.getElementById('config_conversion_file');
      if (convFileEl && path) {
        convFileEl.value = path;
        console.log('[AppEditor] Synced conversion path to hidden field:', path);
      }
      // Re-open editor from merged content so view columns stay in sync with saved file
      try {
        if (window.EditorModel && typeof window.EditorModel.modelToTsv === 'function') {
          openTableEditor(window.EditorModel.modelToTsv(fullEditorData), currentEditorData.filename);
        } else {
          openTableEditor([fullEditorData.headers.join('\t')].concat(fullEditorData.rows.map(r => r.join('\t'))).join('\n'), currentEditorData.filename);
        }
      } catch(e) { /* ignore */ }
      modifiedRows.clear(); manualStatusChanges.clear();
      if (document.getElementById('saveTableServer')) document.getElementById('saveTableServer').disabled = true;
      if (document.getElementById('saveTableCanonical')) document.getElementById('saveTableCanonical').disabled = true;
      if (document.getElementById('downloadTable')) document.getElementById('downloadTable').disabled = true;
      
      // Automatically save the config file to persist the updated Conversion_file path to YAML
      try {
        if (window.AppConfig && typeof window.AppConfig.saveConfig === 'function') {
          // Get the current config save path
          const saveConfigPath = document.getElementById('saveConfigPath')?.value || 
                                document.getElementById('loadConfigPath')?.value || '';
          console.log('[AppEditor] Auto-saving config with path:', saveConfigPath);
          // Use forceOverwrite=true for auto-save to avoid prompting user
          await window.AppConfig.saveConfig(saveConfigPath, true);
        }
      } catch(e) { console.warn('Config auto-save after table save failed:', e); }
      
      alert('Saved to ' + j.path);
    } catch (err) { alert('Save failed: ' + err.message); }
  }

  async function saveTableCanonical(){
    // Try to detect the correct save path from config fields or raw YAML
    let detected = null;
    
    // First try form fields (more reliable)
    const root = (document.getElementById('config_root_path')?.value || '').trim();
    const proj = (document.getElementById('config_project_name')?.value || '').trim();
    const bids = (document.getElementById('config_bids_path')?.value || '').trim();
    const conv = (document.getElementById('config_conversion_file')?.value || 'bids_conversion.tsv').trim() || 'bids_conversion.tsv';
    
    // Check if conv is already a full path
    if (conv.startsWith('/') || conv.startsWith('~')) {
      detected = conv;
    } else if (bids && (bids.includes('/') || bids.startsWith('.') || bids.startsWith('~'))) {
      // bidsify.py saves to: dirname(BIDS)/logs/<conv>
      const bidsNorm = bids.replace(/\/+$/, '');
      const bidsDir = bidsNorm.substring(0, bidsNorm.lastIndexOf('/')) || bidsNorm;
      detected = `${bidsDir}/logs/${conv}`;
    } else if (root && proj) {
      detected = `${root.replace(/\/+$/,'')}/${proj.replace(/\/+$/,'')}/logs/${conv}`;
    }
    
    // Fallback: try parsing raw YAML if form fields didn't work
    if (!detected) {
      try {
        const cfg = document.getElementById('configText')?.value || '';
        const lines = cfg.split('\n');
        let inProj = false; let yamlRoot=''; let yamlName='';
        for (let ln of lines) {
          const t = ln.trim();
          if (!inProj && t.startsWith('Project:')) { inProj = true; continue; }
          if (inProj) {
            if (/^[A-Za-z0-9_].*:/.test(t)) { break; }
            const mRoot = t.match(/^Root:\s*(.*)/); if (mRoot) yamlRoot = mRoot[1].trim();
            const mName = t.match(/^Name:\s*(.*)/); if (mName) yamlName = mName[1].trim();
          }
        }
        if (yamlRoot && yamlName) detected = `${yamlRoot}/${yamlName}/logs/${conv}`;
      } catch (e) {}
    }
    
    if (!detected) {
      const confirmSkip = confirm('Could not detect Project Root/Name or BIDS path in config. Do you want to enter a custom save path instead?');
      if (!confirmSkip) return;
      const p = prompt('Enter server path to save to', '/path/to/logs/bids_conversion.tsv');
      if (!p) return;
      document.getElementById('saveTablePath').value = p;
    } else {
      document.getElementById('saveTablePath').value = detected.replace(/^\/+/,'');
    }
    // trigger save
    if (document.getElementById('saveTableServer')) document.getElementById('saveTableServer').click();
  }

  // expose API
  window.AppEditor = {
    openTableEditor, loadArtifact, renderTableFromData, addRowToTable, deleteSelectedRows, addColumnToTable, deleteColumnFromTable, sortTableByColumn, moveSelectedRows, applyToColumn, findReplaceInTable, downloadEditedTable, saveTableServer, saveTableCanonical
  };

  // expose backwards-compatible globals for existing callers
  window.openTableEditor = window.AppEditor.openTableEditor;
  window.loadArtifact = window.AppEditor.loadArtifact;

  // wire save button event listeners when DOM is ready
  window.addEventListener('DOMContentLoaded', () => {
    const saveTableServerEl = document.getElementById('saveTableServer');
    if (saveTableServerEl) saveTableServerEl.addEventListener('click', saveTableServer);
    const saveTableCanonicalEl = document.getElementById('saveTableCanonical');
    if (saveTableCanonicalEl) saveTableCanonicalEl.addEventListener('click', saveTableCanonical);
    // wire load table file picker and button for the web editor
    const loadTableBtn = document.getElementById('loadTableBtn');
    const loadTableInput = document.getElementById('loadTableInput');
    // Make the Load button fetch the file indicated by the adjacent `saveTablePath`
    // input (server-side path) and fall back to the local file picker when empty.
    const computeAndFillSaveTablePath = () => {
      try {
        const root = (document.getElementById('config_root_path')?.value || '').trim();
        const proj = (document.getElementById('config_project_name')?.value || '').trim();
        const bids = (document.getElementById('config_bids_path')?.value || '').trim();
        const conv = (document.getElementById('config_conversion_file')?.value || 'bids_conversion.tsv').trim() || 'bids_conversion.tsv';
        let candidate = '';
        
        // Check if conv is already a full path (starts with / or ~)
        if (conv.startsWith('/') || conv.startsWith('~')) {
          // It's already a full path, use it directly
          candidate = conv;
        } else {
          // It's a relative filename, build the full path
          // bidsify.py saves to: dirname(BIDS)/logs/<conv> (see bidsify.py line ~994)
          if (bids && (bids.includes('/') || bids.startsWith('.') || bids.startsWith('~'))) {
            // Get dirname of BIDS path and append /logs/<conv>
            const bidsNorm = bids.replace(/\/+$/, '');
            const bidsDir = bidsNorm.substring(0, bidsNorm.lastIndexOf('/')) || bidsNorm;
            candidate = `${bidsDir}/logs/${conv}`;
          } else if (root && proj) {
            // Fallback: assume BIDS is at root/proj/BIDS, so logs at root/proj/logs
            candidate = `${root.replace(/\/+$/,'')}/${proj.replace(/\/+$/,'')}/logs/${conv}`;
          }
        }
        
        // Only auto-fill when the input is empty and the candidate path is different so we don't clobber a user-provided path or duplicate the same path.
        const savePathEl = document.getElementById('saveTablePath');
        const currentPath = (savePathEl?.value || '').trim();
        if (savePathEl && candidate && !currentPath && candidate !== currentPath) {
          savePathEl.value = candidate;
          console.log('[AppEditor] Auto-filled saveTablePath:', candidate);
        }
      } catch (e) { /* ignore */ }
    };

    // compute initial suggested path once the page is ready
    try { computeAndFillSaveTablePath(); } catch(e){}

    // Recompute when an AppConfig module notifies listeners that a config was loaded
    try { window.addEventListener && window.addEventListener('AppConfigChanged', computeAndFillSaveTablePath); } catch(e){}

    // Wire filter selects to trigger re-render when changed
    ['statusFilterSelect','subjectFilterSelect','sessionFilterSelect','taskFilterSelect','acquisitionFilterSelect'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => { if (typeof renderTableFromData === 'function') renderTableFromData(); });
      }
    });

    // keep the suggestion up-to-date when the config fields change
    ['config_root_path','config_project_name','config_bids_path','config_conversion_file'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => { try { computeAndFillSaveTablePath(); } catch(e){} });
        el.addEventListener('change', () => { try { computeAndFillSaveTablePath(); } catch(e){} });
      }
    });

    // Sync saveTablePath changes back to config_conversion_file
    const saveTablePathEl = document.getElementById('saveTablePath');
    if (saveTablePathEl) {
      saveTablePathEl.addEventListener('input', () => {
        try {
          const path = (saveTablePathEl.value || '').trim();
          const convFileEl = document.getElementById('config_conversion_file');
          if (convFileEl && path) {
            convFileEl.value = path;
          }
          // Enable save button when path is edited
          if (document.getElementById('saveTableServer')) document.getElementById('saveTableServer').disabled = false;
        } catch (e) { /* ignore */ }
      });
      saveTablePathEl.addEventListener('change', () => {
        try {
          const path = (saveTablePathEl.value || '').trim();
          const convFileEl = document.getElementById('config_conversion_file');
          if (convFileEl && path) {
            convFileEl.value = path;
          }
          // Enable save button when path is edited
          if (document.getElementById('saveTableServer')) document.getElementById('saveTableServer').disabled = false;
        } catch (e) { /* ignore */ }
      });
    }

    if (loadTableBtn && loadTableInput) {
      loadTableBtn.addEventListener('click', async () => {
        try {
          const path = (document.getElementById('saveTablePath')?.value || '').trim();
          if (!path) {
            // fallback to selecting a local file
            return loadTableInput.click();
          }

          // Attempt to read the server-side file via /api/read-file
          const resp = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path }) });
          const j = await resp.json().catch(() => ({}));
          if (!resp.ok) { alert('Load failed: ' + (j.error || JSON.stringify(j))); return; }
          if (j && typeof j.content === 'string') {
            try { openTableEditor(j.content, (path.split('/').pop() || 'conversion.tsv')); } catch(e) { /* ignore */ }
            const te = document.getElementById('tableEditor'); if (te) te.style.display = 'block';
            
            // Update config file with the loaded path
            const convFileEl = document.getElementById('config_conversion_file');
            if (convFileEl) {
              convFileEl.value = path;
              console.log('[AppEditor] Updated conversion path to:', path);
            }
            
            // Auto-save config with the new path only if a config path is available
            // and the config is actually saved/loaded (not a new unsaved config)
            try {
              if (window.AppConfig && typeof window.AppConfig.saveConfig === 'function') {
                const saveConfigPath = document.getElementById('saveConfigPath')?.value || 
                                      document.getElementById('loadConfigPath')?.value || '';
                // Only auto-save if we have a valid path and the config was previously saved
                if (saveConfigPath && window.AppConfig.isConfigSaved && window.AppConfig.isConfigSaved()) {
                  console.log('[AppEditor] Auto-saving config after table load with path:', saveConfigPath);
                  // Use forceOverwrite=true for auto-save to avoid prompting user
                  await window.AppConfig.saveConfig(saveConfigPath, true);
                } else {
                  console.log('[AppEditor] Skipping auto-save: no saved config or path');
                }
              }
            } catch(e) { console.warn('Config auto-save after table load failed:', e); }
          } else {
            alert('File not found or empty: ' + path);
          }
        } catch (e) {
          // if anything goes wrong fall back to the local picker so the user can still load a file
          try { loadTableInput.click(); } catch(er){}
        }
      });
      loadTableInput.addEventListener('change', async (ev) => {
        const f = ev.target.files && ev.target.files[0]; if (!f) return;
        try {
          const txt = await f.text();
          openTableEditor(txt, f.name);
          const savePathEl = document.getElementById('saveTablePath'); if (savePathEl) savePathEl.value = f.name;
        } catch (e) { alert('Failed to load table: ' + (e && e.message ? e.message : String(e))); }
      });
    }
    // no auto-fit toggle wiring — automatic fitting removed; CSS controls widths
  });

})();
