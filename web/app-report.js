// Report view helpers — small module to manage report UI
(function(){
  function openReportView(){
    document.getElementById('main-config')?.classList.add('view-hidden');
    document.getElementById('main-editor')?.classList.add('view-hidden');
    document.getElementById('main-execute')?.classList.add('view-hidden');
    document.getElementById('main-report')?.classList.remove('view-hidden');
    document.querySelectorAll('.sidebar .nav-item').forEach(n => n.classList.remove('active'));
    const rnav = document.querySelector('.sidebar .nav-item[data-view="main-report"]') || document.querySelector('.sidebar .nav-item[data-view="report"]'); if (rnav) rnav.classList.add('active');
    const _rbadge = document.getElementById('activeViewBadge'); if (_rbadge) _rbadge.textContent = 'view: report';
  }

  function updateReportArea(htmlOrNode){ const el = document.getElementById('reportArea'); if (!el) return; if (typeof htmlOrNode === 'string') { el.innerHTML = htmlOrNode; } else if (htmlOrNode && htmlOrNode.nodeType === 1) { el.innerHTML = ''; el.appendChild(htmlOrNode); } }
  // Diagnostic logging helper
  // Debug helper — only prints when window.APP_DEBUG is truthy to avoid
  // noisy logs in production and normal test runs.
  function _dbg(msg, obj){ try { if (typeof window !== 'undefined' && window.APP_DEBUG) console.debug('[AppReport] ' + msg, obj ?? ''); } catch(e){} }

  function renderJSONPreview(obj){ const container = document.createElement('div'); const pretty = `<pre style="background:#fafafa;color:#111;padding:12px;border-radius:6px;overflow:auto;max-height:360px">${JSON.stringify(obj, null, 2)}</pre>`; container.innerHTML = `<div class="report-details">${pretty}</div>`; return container; }

  function renderTSVPreview(text, rows=8){ const rowsArr = text.split('\n').slice(0,rows).map(r=>r.split('\t'));
    const wrapper = document.createElement('div'); const table = document.createElement('table'); table.style.width='100%'; table.style.borderCollapse='collapse'; table.style.fontSize='12px'; rowsArr.forEach((row, ridx)=>{ const tr = document.createElement('tr'); row.forEach(c=>{ const td = document.createElement(ridx===0 ? 'th' : 'td'); td.textContent = c; td.style.border='1px solid #eee'; td.style.padding='6px'; tr.appendChild(td); }); table.appendChild(tr); }); wrapper.appendChild(table); return wrapper; }

  function renderHTMLPreview(html){ const frame = document.createElement('iframe'); frame.style.width='100%'; frame.style.height='420px'; frame.style.border='1px solid #ddd'; frame.srcdoc = html; return frame; }

  // Update numeric summary stats for the report view
  function updateStats({ subjects=null, sessions=null, tasks=null } = {}){
    try {
      if (subjects !== null) document.getElementById('stat-subjects').textContent = String(subjects);
      if (sessions !== null) document.getElementById('stat-sessions').textContent = String(sessions);
      if (tasks !== null) document.getElementById('stat-tasks').textContent = String(tasks);
      } catch(e) {}
      _dbg('updateStats', { subjects, sessions, tasks });
  }

  // Render a collapsible tree starting at given root path. `tree` is expected
  // to be an object or array representing nested folders/files. We'll accept a
  // variety of shapes and attempt to present them as a nested tree.
  function renderTree(rootPath, tree){
    const out = document.getElementById('reportTree');
    if (!out) return;
    out.innerHTML = '';

    function makeNode(label, children){
      const li = document.createElement('li'); li.style.listStyle='none'; li.style.margin='4px 0';
      const row = document.createElement('div'); row.style.display='flex'; row.style.alignItems='center'; row.style.gap='8px';
      const toggle = document.createElement('button'); toggle.textContent = '\u25B6'; toggle.style.border='none'; toggle.style.background='transparent'; toggle.style.cursor='pointer'; toggle.style.padding='0'; toggle.style.fontSize='12px';
      const lbl = document.createElement('span'); lbl.textContent = label; lbl.style.fontSize='13px';
      row.appendChild(toggle); row.appendChild(lbl); li.appendChild(row);

      if (children && (Array.isArray(children) ? children.length > 0 : Object.keys(children).length > 0)){
        const ul = document.createElement('ul'); ul.style.paddingLeft = '18px'; ul.style.margin = '6px 0'; ul.style.display = 'none';
        // build children
        if (Array.isArray(children)){
          children.forEach(c => {
            if (typeof c === 'string') ul.appendChild(makeNode(c, {}));
            else if (typeof c === 'object'){
              const k = Object.keys(c)[0]; ul.appendChild(makeNode(k, c[k]));
            }
          });
        } else if (typeof children === 'object'){
          Object.keys(children).forEach(k => { ul.appendChild(makeNode(k, children[k])); });
        }
        li.appendChild(ul);
        toggle.addEventListener('click', () => { if (ul.style.display === 'none'){ ul.style.display='block'; toggle.textContent='▾'; } else { ul.style.display='none'; toggle.textContent='▸'; } });
      } else {
        // leaf nodes show no toggle
        toggle.style.visibility = 'hidden';
      }
      return li;
    }

    // If the incoming 'tree' looks like a 'bids_results.json' payload produced
    // by the CLI (it typically contains a top-level 'Report Table' array),
    // derive a BIDS-style tree from that array so the UI can render a familiar
    // expandable BIDS directory structure (sub-*/ses-* grouping etc.).
    // This mirrors the logic used by the Electron viewer but keeps it
    // lightweight for the browser UI.
    function buildTreeFromRows(rows) {
      const root = { name: 'BIDS', path: 'BIDS', type: 'directory', children: [] };

      function findOrCreateChild(parent, name, type='directory'){
        parent.children = parent.children || [];
        let child = parent.children.find(c => c.name === name && c.type === type);
        if (!child){ child = { name, type, path: (parent.path ? (parent.path + '/' + name) : name), children: [] }; parent.children.push(child); }
        return child;
      }

      (rows || []).forEach(row => {
        const bfRaw = row['BIDS File'] || row['BIDSFile'] || row['bids_file'] || row['bids_path'] || null;
        const bidsFiles = Array.isArray(bfRaw) ? bfRaw : (bfRaw ? [bfRaw] : []);
        const validation = row['Validated'] || row['Validation'] || null;
        const dateVal = row['timestamp'] || row['Processing Date'] || null;

        bidsFiles.forEach(bf => {
          if (!bf) return;
          // try to locate a segment under a /BIDS/ root; otherwise use the full path
          let rel = String(bf).replace(/^\/*/, '');
          const idx = rel.indexOf('/BIDS/');
          if (idx !== -1) rel = rel.substring(idx + 6);
          if (rel.startsWith('/')) rel = rel.substring(1);
          const parts = rel.split('/').filter(Boolean);

          let parent = root;
          for (let i=0;i<parts.length;i++){
            const part = parts[i];
            const isFile = i === (parts.length - 1);
            if (isFile){ const node = findOrCreateChild(parent, part, 'file'); node.validation = validation; node.conversion_date = node.conversion_date || dateVal; node.fullpath = bf; }
            else { parent = findOrCreateChild(parent, part, 'directory'); }
          }
        });
      });

      // aggregate validation and latest date for directories
      function aggregate(node){
        if (!node) return { validation: null, dateMs: 0 };
        if (node.type === 'file') return { validation: node.validation || null, dateMs: node.conversion_date ? Date.parse(node.conversion_date) || 0 : 0 };
        let allValid = true, anyValid = false, anyInvalid = false, latest = 0;
        (node.children || []).forEach(c => { const r = aggregate(c); if (r.validation === 'True BIDS') anyValid = true; if (r.validation === 'False BIDS') anyInvalid = true; if (r.validation !== 'True BIDS') allValid = false; if (r.dateMs && r.dateMs > latest) latest = r.dateMs; });
        if (allValid && anyValid) node.validation = 'True BIDS'; else if (anyInvalid) node.validation = 'False BIDS'; else node.validation = 'N/A';
        if (latest) node.conversion_date = new Date(latest).toISOString();
        return { validation: node.validation, dateMs: latest };
      }

      aggregate(root);
      return root;
    }

    // Normalize tree param: if it's an object with subjects -> sessions, use that
    // Detect 'Report Table' payload and derive a BIDS tree for rendering
    let content = tree;
    if (content && typeof content === 'object' && Array.isArray(content['Report Table'])) {
      try {
        content = buildTreeFromRows(content['Report Table']);
      } catch(e){ /* fall through to normal rendering */ }
    }
    if (!content) {
      out.textContent = 'No tree data found';
      return;
    }

    const rootLabel = rootPath || (typeof content === 'string' ? content : 'BIDS');
    const ulRoot = document.createElement('ul'); ulRoot.style.paddingLeft='6px';

    // If the tree looks like { subjects: { 'sub-01': { sessions: { 'ses-01': {...}}}}}
    if (content.subjects && typeof content.subjects === 'object'){
      Object.keys(content.subjects).forEach(sub => {
        const subNode = {};
        const subObj = content.subjects[sub];
        if (subObj.sessions && typeof subObj.sessions === 'object'){
          subNode[sub] = {};
          Object.keys(subObj.sessions).forEach(ses => {
            const tasks = subObj.sessions[ses].tasks || subObj.sessions[ses].files || subObj.sessions[ses];
            subNode[sub][ses] = tasks;
          });
        } else {
          subNode[sub] = subObj;
        }
        ulRoot.appendChild(makeNode(sub, subNode[sub]));
      });
    } else if (Array.isArray(content.subjects)){
      content.subjects.forEach(s => ulRoot.appendChild(makeNode(s, {})));
    } else if (content.files && Array.isArray(content.files)){
      // flat files list: group by top-level path pieces under root
      const grouped = {};
      content.files.forEach(f => {
        const rel = String(f).replace(/^\/*/, '');
        const comp = rel.split('/').slice(0,3).join('/');
        grouped[comp] = grouped[comp] || []; grouped[comp].push(f);
      });
      Object.keys(grouped).forEach(k => ulRoot.appendChild(makeNode(k, grouped[k])));
    } else if (content && typeof content === 'object' && (content.name && (Array.isArray(content.children) || typeof content.children === 'object'))){
      // Content that was derived from a 'Report Table' -> structured tree object
      // Format: { name, path, type, children: [ {name, type, children: [...]}, ... ] }
      const renderNode = (node) => {
        const li = document.createElement('li'); li.style.listStyle='none'; li.style.margin='4px 0';
        const row = document.createElement('div'); row.style.display='flex'; row.style.alignItems='center'; row.style.gap='8px';
        const toggle = document.createElement('button'); toggle.textContent = '\u25B6'; toggle.style.border='none'; toggle.style.background='transparent'; toggle.style.cursor='pointer'; toggle.style.padding='0'; toggle.style.fontSize='12px';
        const lbl = document.createElement('span'); lbl.textContent = node.name || node.path || 'item'; lbl.style.fontSize='13px';
        row.appendChild(toggle); row.appendChild(lbl); li.appendChild(row);

        if (node.children && node.children.length){
          const ul = document.createElement('ul'); ul.style.paddingLeft = '18px'; ul.style.margin = '6px 0'; ul.style.display = 'none';
          node.children.forEach(cn => ul.appendChild(renderNode(cn)));
          li.appendChild(ul);
          toggle.addEventListener('click', () => { if (ul.style.display === 'none'){ ul.style.display='block'; toggle.textContent='▾'; } else { ul.style.display='none'; toggle.textContent='▸'; } });
        } else {
          toggle.style.visibility = 'hidden';
        }
        return li;
      };
      ulRoot.appendChild(renderNode(content));
    } else {
      // Fallback: render object keys
      if (typeof content === 'object'){
        Object.keys(content).forEach(k => ulRoot.appendChild(makeNode(k, content[k])));
      } else if (typeof content === 'string'){
        ulRoot.appendChild(makeNode(content, {}));
      }
    }

    out.appendChild(makeNode(rootLabel, {}));
    // append children below the root node
    const rootLi = out.querySelector('li');
    if (rootLi) rootLi.appendChild(ulRoot);
    _dbg('renderTree', { rootPath, children: (Array.isArray(Object.keys(tree)) ? Object.keys(tree).slice(0,6) : null) });
  }

  function clearReport(){ updateReportArea('No report yet — run Analyse or Report to generate output'); updateStats({ subjects:0, sessions:0, tasks:0 }); const tr = document.getElementById('reportTree'); if (tr) tr.innerHTML = 'No BIDS results yet'; }

  // Load and render the actual BIDS directory structure as a proper file browser
  async function loadBIDSDirectory(bidsPath) {
    const out = document.getElementById('reportTree');
    if (!out) return;
    out.innerHTML = '<div style="color: #666; font-size: 13px">Loading BIDS directory...</div>';
    
    try {
      _dbg('loadBIDSDirectory called with path', bidsPath);
      const resp = await fetch('/api/list-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: bidsPath })
      });
      
      if (!resp.ok) {
        const json = await resp.json();
        out.innerHTML = `<div style="color: #e74c3c; font-size: 13px">Error loading directory: ${json.error || 'Unknown error'}</div>`;
        _dbg('loadBIDSDirectory error', json);
        return;
      }

      const data = await resp.json();
      _dbg('loadBIDSDirectory response', data);

      // Build a tree structure from the API response
      const buildTree = (items, basePath = '') => {
        const dirs = [];
        const files = [];
        
        items.forEach(item => {
          // Skip hidden files/folders (starting with a dot)
          if (item.name.startsWith('.')) return;
          
          const node = {
            name: item.name,
            path: item.path,
            is_dir: item.is_dir,
            size: item.size
          };
          
          if (item.is_dir) {
            dirs.push(node);
          } else {
            files.push(node);
          }
        });
        
        // Sort directories first, then files
        return [...dirs, ...files];
      };

      const renderDirTree = (items, rootName = 'BIDS') => {
        const container = document.createElement('div');
        container.style.paddingLeft = '6px';

        const renderItem = (item, level = 0) => {
          const li = document.createElement('li');
          li.style.listStyle = 'none';
          li.style.margin = '2px 0';

          const row = document.createElement('div');
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.gap = '8px';
          row.style.paddingLeft = (level * 18) + 'px';

          const toggle = document.createElement('button');
          toggle.style.border = 'none';
          toggle.style.background = 'transparent';
          toggle.style.cursor = 'pointer';
          toggle.style.padding = '0';
          toggle.style.fontSize = '12px';
          toggle.style.width = '16px';
          toggle.style.textAlign = 'center';
          
          const icon = document.createElement('span');
          icon.style.fontSize = '13px';
          icon.style.marginRight = '4px';

          const lbl = document.createElement('span');
          lbl.style.fontSize = '12px';
          lbl.style.color = '#222';
          
          if (item.is_dir) {
            toggle.textContent = '▶';
            icon.textContent = '📁';
            lbl.textContent = item.name;
            row.appendChild(toggle);
            row.appendChild(icon);
            row.appendChild(lbl);
            li.appendChild(row);

            // Create collapsible content for directories
            const childContainer = document.createElement('div');
            childContainer.style.display = 'none';
            
            toggle.addEventListener('click', () => {
              if (childContainer.style.display === 'none') {
                childContainer.style.display = 'block';
                toggle.textContent = '▼';
                // Lazy load children if not already loaded
                if (childContainer.dataset.loaded !== 'true') {
                  loadDirChildren(item.path, childContainer, level + 1);
                  childContainer.dataset.loaded = 'true';
                }
              } else {
                childContainer.style.display = 'none';
                toggle.textContent = '▶';
              }
            });
            
            li.appendChild(childContainer);
          } else {
            toggle.style.visibility = 'hidden';
            icon.textContent = '📄';
            const sizeStr = item.size ? ` (${(item.size / 1024).toFixed(1)} KB)` : '';
            lbl.textContent = item.name + sizeStr;
            lbl.style.color = '#555';
            row.appendChild(toggle);
            row.appendChild(icon);
            row.appendChild(lbl);
            li.appendChild(row);
          }

          return li;
        };

        const ul = document.createElement('ul');
        ul.style.paddingLeft = '0';
        ul.style.margin = '0';
        
        if (items && Array.isArray(items)) {
          items.forEach(item => ul.appendChild(renderItem(item)));
        }

        container.appendChild(ul);
        return container;
      };

      // Lazy load function for directory children
      const loadDirChildren = async (path, container, level) => {
        try {
          const resp = await fetch('/api/list-dir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path })
          });
          
          if (!resp.ok) {
            container.innerHTML = '<div style="color: #e74c3c; padding: 8px; font-size: 12px">Error loading</div>';
            return;
          }

          const data = await resp.json();
          const sortedItems = buildTree(data.items);
          
          // Render items inline
          const ul = document.createElement('ul');
          ul.style.paddingLeft = '0';
          ul.style.margin = '0';
          
          const renderItem = (item) => {
            const li = document.createElement('li');
            li.style.listStyle = 'none';
            li.style.margin = '2px 0';

            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '8px';
            row.style.paddingLeft = (level * 18) + 'px';

            const toggle = document.createElement('button');
            toggle.style.border = 'none';
            toggle.style.background = 'transparent';
            toggle.style.cursor = 'pointer';
            toggle.style.padding = '0';
            toggle.style.fontSize = '12px';
            toggle.style.width = '16px';
            toggle.style.textAlign = 'center';
            
            const icon = document.createElement('span');
            icon.style.fontSize = '13px';
            icon.style.marginRight = '4px';

            const lbl = document.createElement('span');
            lbl.style.fontSize = '12px';
            lbl.style.color = '#222';
            
            if (item.is_dir) {
              toggle.textContent = '▶';
              icon.textContent = '📁';
              lbl.textContent = item.name;
              row.appendChild(toggle);
              row.appendChild(icon);
              row.appendChild(lbl);
              li.appendChild(row);

              const childContainer = document.createElement('div');
              childContainer.style.display = 'none';
              
              toggle.addEventListener('click', () => {
                if (childContainer.style.display === 'none') {
                  childContainer.style.display = 'block';
                  toggle.textContent = '▼';
                  if (childContainer.dataset.loaded !== 'true') {
                    loadDirChildren(item.path, childContainer, level + 1);
                    childContainer.dataset.loaded = 'true';
                  }
                } else {
                  childContainer.style.display = 'none';
                  toggle.textContent = '▶';
                }
              });
              
              li.appendChild(childContainer);
            } else {
              toggle.style.visibility = 'hidden';
              icon.textContent = '📄';
              const sizeStr = item.size ? ` (${(item.size / 1024).toFixed(1)} KB)` : '';
              lbl.textContent = item.name + sizeStr;
              lbl.style.color = '#555';
              row.appendChild(toggle);
              row.appendChild(icon);
              row.appendChild(lbl);
              li.appendChild(row);
            }

            return li;
          };
          
          sortedItems.forEach(item => ul.appendChild(renderItem(item)));
          container.innerHTML = '';
          container.appendChild(ul);
        } catch (e) {
          _dbg('loadDirChildren error', e);
          container.innerHTML = '<div style="color: #e74c3c; padding: 8px; font-size: 12px">Error loading children</div>';
        }
      };

      out.innerHTML = '';
      const sortedItems = buildTree(data.items);
      out.appendChild(renderDirTree(sortedItems, data.path));

      _dbg('loadBIDSDirectory rendered successfully');
    } catch (e) {
      _dbg('loadBIDSDirectory error', e);
      out.innerHTML = `<div style="color: #e74c3c; font-size: 13px">Error: ${e.message}</div>`;
    }
  }

  window.AppReport = { openReportView, updateReportArea, renderJSONPreview, renderTSVPreview, renderHTMLPreview, updateStats, renderTree, clearReport, loadBIDSDirectory };

  // Attempt to probe and load bids_results.json candidates. If candidates
  // parameter is provided (array of paths) we'll try those; otherwise we will
  // infer candidates from visible config form fields (project root + name or
  // BIDS output path). This is useful as a manual fallback when the auto-load
  // path fails (e.g. due to a race) or for debugging.
  async function loadCandidates(candidates){
    try {
      _dbg('loadCandidates called', candidates);
      const output = document.getElementById('reportOutput');
      if (output) { output.textContent = (output.textContent || '') + '\n[AppReport] probing candidates: ' + JSON.stringify(candidates || []) + '\n'; }

      // if not provided, derive from config form fields
      if (!Array.isArray(candidates) || candidates.length === 0){
        const projectRoot = (document.getElementById('config_root_path')?.value || '').trim();
        const projectName = (document.getElementById('config_project_name')?.value || '').trim();
        const bids = (document.getElementById('config_bids_path')?.value || '').trim();
        const derived = [];
        if (projectRoot && projectName) derived.push(`${projectRoot.replace(/\/$/, '')}/${projectName}/logs/bids_results.json`);
        if (bids && (bids.includes('/') || bids.startsWith('.') || bids.startsWith('~'))) {
          derived.push(`${bids.replace(/\/$/, '')}/logs/bids_results.json`);
          derived.push(`${bids.replace(/\/$/, '')}/bids_results.json`);
        }
        candidates = derived;
      }

      for (const candidate of candidates || []){
        // if a cached parsed payload exists from the config loader, prefer
        // using that rather than re-fetching the file (avoids race and
        // double-fetch situations).
        try {
          if (window._lastReportPayloads && window._lastReportPayloads[candidate]){
            const obj = window._lastReportPayloads[candidate];
            if (output) output.textContent += `[AppReport] using cached payload for ${candidate}\n`;
            if (window.AppReport && typeof window.AppReport.updateStats === 'function'){
              const rows = Array.isArray(obj) ? obj : (obj['Report Table'] || []);
              const subjects = new Set(rows.map(r => r.Participant).filter(Boolean));
              const sessions = new Set(rows.map(r => r.Session).filter(Boolean));
              const taskSet = new Set(); rows.forEach(r => { if (r.Task) taskSet.add(r.Task); });
              window.AppReport.updateStats({ subjects: subjects.size, sessions: sessions.size, tasks: taskSet.size });
            }
            // renderTree is now replaced by loadBIDSDirectory for a proper file browser
            // try { if (window.AppReport && typeof window.AppReport.renderTree === 'function') window.AppReport.renderTree(obj.bids_root || obj.bids_path || obj.root || obj.projectRoot || candidate, obj); } catch(e){}
            try { if (window.AppReport && typeof window.AppReport.updateReportArea === 'function') window.AppReport.updateReportArea(window.AppReport.renderJSONPreview(obj)); } catch(e){}
            if (output) output.textContent += `[AppReport] loaded (cached) ${candidate}\n`;
            delete window._lastReportPayloads[candidate];
            return true;
          }
        } catch(e){}
        try {
          if (output) output.textContent += `[AppReport] probing ${candidate}\n`;
          const resp = await fetch('/api/read-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: candidate }) });
          const j = await resp.json();
          if (!resp.ok) { if (output) output.textContent += `[AppReport] probe failed: ${j && j.error ? j.error : 'not found'}\n`; continue; }
          if (!j || !j.content) { if (output) output.textContent += `[AppReport] empty content at ${candidate}\n`; continue; }
          let obj = null;
          if (typeof j.content === 'string') obj = JSON.parse(j.content);
          else obj = j.content;
          // render the JSON/preview
          if (window.AppReport && typeof window.AppReport.updateStats === 'function'){
            // calculate basic counts similar to config loader
            const rows = Array.isArray(obj) ? obj : (obj['Report Table'] || []);
            const subjects = new Set(rows.map(r => r.Participant).filter(Boolean));
            const sessions = new Set(rows.map(r => r.Session).filter(Boolean));
            const taskSet = new Set(); rows.forEach(r => { if (r.Task) taskSet.add(r.Task); });
            window.AppReport.updateStats({ subjects: subjects.size, sessions: sessions.size, tasks: taskSet.size });
          }
          // renderTree is now replaced by loadBIDSDirectory for a proper file browser
          // if (window.AppReport && typeof window.AppReport.renderTree === 'function'){
          //   try { window.AppReport.renderTree(obj.bids_root || obj.bids_path || obj.root || obj.projectRoot || candidate, obj); } catch(e){}
          // }
          if (window.AppReport && typeof window.AppReport.updateReportArea === 'function'){
            try { window.AppReport.updateReportArea(window.AppReport.renderJSONPreview(obj)); } catch(e){}
          }
          // bring the view up so users see results
          // do not auto-open the Report view here; leave view switching to the user
          if (output) output.textContent += `[AppReport] loaded ${candidate}\n`;
          // stop after first successful candidate
          return true;
        } catch (e) {
          if (output) output.textContent += `[AppReport] error probing ${candidate}: ${e.message}\n`;
          _dbg('loadCandidates-error', { candidate, err: e });
        }
      }
      // nothing loaded
      if (output) output.textContent += '[AppReport] no candidates succeeded\n';
      return false;
    } catch (e) { _dbg('loadCandidates top-level error', e); return false; }
  }

  // expose loader
  window.AppReport.loadCandidates = loadCandidates;

  // If this module is loaded after DOMContentLoaded (e.g. dynamically), try
  // to immediately pick up any cached payloads/candidates left by
  // AppConfig so the report view auto-populates without needing a page
  // reload or user action. This runs quickly on load and defers to
  // loadCandidates when only candidate paths exist.
  try {
    setTimeout(async () => {
      try {
        if (window._lastReportPayloads && Object.keys(window._lastReportPayloads).length) {
          _dbg('immediate-apply cached _lastReportPayloads', Object.keys(window._lastReportPayloads));
          for (const candidate of Object.keys(window._lastReportPayloads)) {
            const cached = window._lastReportPayloads[candidate];
            if (!cached) continue;
            try { if (typeof window.AppReport.updateStats === 'function') {
                const rows = Array.isArray(cached) ? cached : (cached['Report Table'] || []);
                const subjects = new Set(rows.map(r => r.Participant).filter(Boolean));
                const sessions = new Set(rows.map(r => r.Session).filter(Boolean));
                const taskSet = new Set(); rows.forEach(r => { if (r.Task) taskSet.add(r.Task); });
                window.AppReport.updateStats({ subjects: subjects.size, sessions: sessions.size, tasks: taskSet.size });
              } } catch(e){}
            // renderTree is now replaced by loadBIDSDirectory for a proper file browser
            // try { if (typeof window.AppReport.renderTree === 'function') window.AppReport.renderTree(cached.bids_root || cached.bids_path || cached.root || cached.projectRoot || candidate, cached); } catch(e){}
            try { if (typeof window.AppReport.updateReportArea === 'function') { _dbg('calling updateReportArea'); window.AppReport.updateReportArea(window.AppReport.renderJSONPreview(cached)); _dbg('updateReportArea done'); } } catch(e){ _dbg('updateReportArea failed', e); }
            // do not auto-open report view on immediate-apply; keep navigation manual
            try { delete window._lastReportPayloads[candidate]; } catch(e){}
          }
        } else if (Array.isArray(window._lastReportCandidates) && window._lastReportCandidates.length) {
          _dbg('immediate-apply candidates', window._lastReportCandidates);
          // Disabled: Don't auto-load report data - we now use BIDS directory browser instead
          // try { await loadCandidates(window._lastReportCandidates); } catch(e){}
          // do not auto-open report view when applying candidates immediately
          try { window._lastReportCandidates = []; } catch(e){}
        }
      } catch(e) { _dbg('immediate-apply-failed', e); }
    }, 10);
  } catch(e){}

  function exportReportHTML(){ try {
      const el = document.getElementById('reportArea'); if (!el) return;
      const blob = new Blob([`<html><head><meta charset="utf-8"><title>NatMEG Report</title></head><body>${el.innerHTML}</body></html>`], { type: 'text/html' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'natmeg_report.html'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { console.warn('exportReportHTML failed', e); } }

  window.addEventListener('DOMContentLoaded', () => {
    // nav clicks can open report view
    const reportBtn = document.getElementById('reportBtn');
    if (reportBtn) reportBtn.addEventListener('click', () => { if (window.AppJobs && typeof window.AppJobs.createJob === 'function') { /* AppJobs handles 'report' run */ } else { openReportView(); } });
    // wire sidebar nav items to switch views
    const navs = document.querySelectorAll('.sidebar .nav-item');
    navs.forEach(n => n.addEventListener('click', () => {
      const view = n.getAttribute('data-view'); if (!view) return;
      // hide all web main views and electron-style content-view containers
      document.querySelectorAll('.main-view, .content-view').forEach(m=>m.classList.add('view-hidden'));
      // Try to reveal the selected view. Support both 'main-xxx' and legacy 'xxx' ids
      const mainId = view; const legacyId = (view||'').replace(/^main-/, '');
      const elMain = document.getElementById(mainId); const elLegacy = document.getElementById(legacyId);
      if (elMain) elMain.classList.remove('view-hidden');
      if (elLegacy) elLegacy.classList.remove('view-hidden');
      // update active state
      navs.forEach(x=>x.classList.remove('active')); n.classList.add('active');

      // show/hide header and upload controls only for config view
      const header = document.querySelector('.header-bar');
      const fileRow = document.querySelector('.file-row');
      if (view === 'main-config' || view === 'config') {
        if (header) header.classList.remove('view-hidden');
        if (fileRow) fileRow.classList.remove('view-hidden');
        const _cbd = document.getElementById('activeViewBadge'); if (_cbd) _cbd.textContent = 'view: config';
      } else {
        if (header) header.classList.add('view-hidden');
        if (fileRow) fileRow.classList.add('view-hidden');
        // map main-xxx to short name if possible
        const short = view.replace(/^main-/, '');
        const _sbd = document.getElementById('activeViewBadge'); if (_sbd) _sbd.textContent = 'view: ' + short;
      }

      // Auto-load BIDS directory when report view is opened
      if (view === 'main-report' || view === 'report') {
        try {
          var configBidsPathEl = document.getElementById('config_bids_path');
          var bidsPath = (configBidsPathEl ? configBidsPathEl.value : '').trim();
          
          _dbg('Report view opened - checking for BIDS path', { bidsPath: bidsPath, element: !!configBidsPathEl });
          
          // For testing: if test-bids flag is set and no path configured, use test path
          if (!bidsPath && window.location.search.indexOf('test-bids') !== -1) {
            bidsPath = '~/data/OPM-benchmarking/BIDS/';
            _dbg('Using test BIDS path', bidsPath);
          }
          
          // If no path configured, use test path by default
          if (!bidsPath) {
            bidsPath = '~/data/OPM-benchmarking/BIDS/';
            _dbg('No BIDS path configured, using default test path', bidsPath);
          }
          
          if (bidsPath) {
            // Use inline BIDSBrowser if available
            if (window.BIDSBrowser && typeof window.BIDSBrowser.loadDirectory === 'function') {
              _dbg('Auto-loading BIDS directory with inline browser', bidsPath);
              window.BIDSBrowser.loadDirectory(bidsPath);
            } else {
              _dbg('BIDSBrowser not available yet, will load when button clicked');
            }
          }
        } catch(e) { _dbg('Auto-load BIDS directory failed', e); }
      }
    }));

    // Wire report button
    document.getElementById('reportBtn')?.addEventListener('click', async () => {
      try {
        const reportFile = (document.getElementById('config_root_path')?.value || '') + '/.natmeg/bids_results.json';
        _dbg('Loading report from', reportFile);
        const resp = await fetch('api/get-file?file=' + encodeURIComponent(reportFile));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const cached = await resp.json();
        if (typeof window.AppReport.updateStats === 'function') {
          const rows = Array.isArray(cached) ? cached : (cached['Report Table'] || []);
          const subjects = new Set(rows.map(r => r.Participant).filter(Boolean));
          const sessions = new Set(rows.map(r => r.Session).filter(Boolean));
          const taskSet = new Set(); rows.forEach(r => { if (r.Task) taskSet.add(r.Task); });
          window.AppReport.updateStats({ subjects: subjects.size, sessions: sessions.size, tasks: taskSet.size });
        }
        if (typeof window.AppReport.updateReportArea === 'function') window.AppReport.updateReportArea(window.AppReport.renderJSONPreview(cached));
      } catch(e) { _dbg('Load report error', e); }
    });
    
    // when AppReport loads, check if the config loader left candidate paths

    try {
      window.addEventListener('AppConfigDeferred', (ev) => {
        try {
          const cand = ev && ev.detail && ev.detail.candidates ? ev.detail.candidates : (window._lastReportCandidates || []);
          _dbg('AppConfigDeferred event received', cand);
          // Disabled: Don't auto-load report data - we now use BIDS directory browser instead
          // try to load candidates provided by the event
          // setTimeout(() => { loadCandidates(cand); }, 10);
        } catch(e) { _dbg('AppReport: AppConfigDeferred handler failed', e); }
      });
    } catch(e){}

    // Poll briefly for cached payloads in case the AppConfigDeferred event
    // fired before our handler was registered, or to be resilient across
    // unusual race conditions.
    // Disabled: Don't auto-load report data - we now use BIDS directory browser instead
    // try {
    //   let pollTries = 0;
    //   ...
    // } catch(e){}
    try {} catch(e){}
    document.getElementById('startOverBtn')?.addEventListener('click', () => { clearReport(); });
    document.getElementById('exportReportBtn')?.addEventListener('click', () => { exportReportHTML(); });
    document.getElementById('createReportBtn')?.addEventListener('click', () => { if (window.AppJobs && typeof window.AppJobs.createJob === 'function') window.AppJobs.createJob('report'); });
    document.getElementById('backToExecuteBtn')?.addEventListener('click', () => { document.getElementById('main-report')?.classList.add('view-hidden'); document.getElementById('main-execute')?.classList.remove('view-hidden'); });
  });

})();
