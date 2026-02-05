// File browser module for selecting paths in Configuration and Editor views
(function() {
  // Track which input field requested the file browser
  let targetInputId = null;
  let currentPath = '/';

  // Parse a path into parts for breadcrumb navigation
  function getPathParts(path) {
    if (!path) return [];
    // normalize: remove leading/trailing slashes
    path = String(path).replace(/^\/+|\/+$/g, '');
    if (!path) return [];
    return path.split('/').filter(p => p);
  }

  // Reconstruct path from parts
  function joinPathParts(parts) {
    if (!Array.isArray(parts) || parts.length === 0) return '/';
    return '/' + parts.join('/');
  }

  // Format file size for display
  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 10) / 10 + ' ' + sizes[i];
  }

  // Load and display directory contents
  async function loadDirectory(path) {
    try {
      currentPath = path;
      const listBtn = document.getElementById('fileBrowserLoadBtn');
      if (listBtn) listBtn.disabled = true;

      const resp = await fetch('/api/list-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path })
      });

      const data = await resp.json();
      if (!resp.ok) {
        alert('Error: ' + (data.error || 'Failed to load directory'));
        if (listBtn) listBtn.disabled = false;
        return;
      }

      // Update breadcrumb navigation
      updateBreadcrumbs(path);

      // Render file list
      const listEl = document.getElementById('fileBrowserList');
      if (!listEl) return;

      listEl.innerHTML = '';

      if (!data.items || data.items.length === 0) {
        listEl.innerHTML = '<div class="filebrowser-item disabled">(empty directory)</div>';
      } else {
        // Filter out hidden files (starting with .)
        const visible = data.items.filter(item => !item.name.startsWith('.'));
        
        if (visible.length === 0) {
          listEl.innerHTML = '<div class="filebrowser-item disabled">(no visible files)</div>';
        } else {
          // Sort: directories first, then files, alphabetically
          const sorted = visible.sort((a, b) => {
            if (a.is_dir !== b.is_dir) return b.is_dir - a.is_dir;
            return (a.name || '').localeCompare(b.name || '');
          });

          sorted.forEach(item => {
            const itemEl = document.createElement('div');
            itemEl.className = 'filebrowser-item ' + (item.is_dir ? 'dir' : 'file');
            
            // Create a more structured item with name and size info
            const nameSpan = document.createElement('span');
            nameSpan.className = 'filebrowser-item-name';
            nameSpan.textContent = item.name || '(unnamed)';
            itemEl.appendChild(nameSpan);
            
            // Add file size for files
            if (!item.is_dir && item.size !== null && item.size !== undefined) {
              const sizeSpan = document.createElement('span');
              sizeSpan.className = 'filebrowser-item-size';
              sizeSpan.textContent = formatFileSize(item.size);
              itemEl.appendChild(sizeSpan);
            }

            if (item.is_dir) {
              itemEl.addEventListener('click', () => loadDirectory(item.path));
              itemEl.addEventListener('touchend', (e) => { e.preventDefault(); loadDirectory(item.path); });
              itemEl.style.cursor = 'pointer';
            } else {
              itemEl.addEventListener('click', () => selectPath(item.path));
              itemEl.addEventListener('touchend', (e) => { e.preventDefault(); selectPath(item.path); });
              itemEl.style.cursor = 'pointer';
            }

            listEl.appendChild(itemEl);
          });
        }
      }

      if (listBtn) listBtn.disabled = false;
    } catch (err) {
      console.error('[FileBrowser] Error loading directory:', err);
      alert('Failed to load directory: ' + (err.message || String(err)));
      const listBtn = document.getElementById('fileBrowserLoadBtn');
      if (listBtn) listBtn.disabled = false;
    }
  }

  // Update breadcrumb navigation
  function updateBreadcrumbs(path) {
    const parts = getPathParts(path);
    const breadcrumbEl = document.getElementById('fileBrowserBreadcrumb');
    if (!breadcrumbEl) return;

    breadcrumbEl.innerHTML = '';

    // Home button for ~ paths
    if (path === '~' || path.startsWith('~' + '/')) {
      const homeBtn = document.createElement('button');
      homeBtn.textContent = '~';
      homeBtn.type = 'button';
      homeBtn.addEventListener('click', () => loadDirectory('~'));
      breadcrumbEl.appendChild(homeBtn);
      
      // Add remaining parts after ~
      const afterHome = path.substring(1); // Remove ~ 
      if (afterHome && afterHome !== '/') {
        const afterParts = afterHome.split('/').filter(p => p);
        afterParts.forEach((part, idx) => {
          const sep = document.createElement('span');
          sep.className = 'breadcrumb-sep';
          sep.textContent = '/';
          breadcrumbEl.appendChild(sep);

          const btn = document.createElement('button');
          btn.textContent = part;
          btn.type = 'button';
          const newPath = '~' + '/' + afterParts.slice(0, idx + 1).join('/');
          btn.addEventListener('click', () => loadDirectory(newPath));
          breadcrumbEl.appendChild(btn);
        });
      }
    } else if (parts.length === 0 || (parts.length === 0 && path === '/')) {
      // Root path - show just "/"
      const rootBtn = document.createElement('button');
      rootBtn.textContent = '/';
      rootBtn.type = 'button';
      rootBtn.addEventListener('click', () => loadDirectory('/'));
      breadcrumbEl.appendChild(rootBtn);
    } else {
      // Absolute paths - skip showing the initial "/" button for top-level dirs like /data/
      // Part buttons (no separate root button for cleaner display)
      parts.forEach((part, idx) => {
        if (idx > 0) {
          const sep = document.createElement('span');
          sep.className = 'breadcrumb-sep';
          sep.textContent = '/';
          breadcrumbEl.appendChild(sep);
        }

        const btn = document.createElement('button');
        btn.textContent = part;
        btn.type = 'button';
        const newPath = joinPathParts(parts.slice(0, idx + 1));
        btn.addEventListener('click', () => loadDirectory(newPath));
        breadcrumbEl.appendChild(btn);
      });
    }

    // Update current path display
    const pathDisplay = document.getElementById('fileBrowserCurrentPath');
    if (pathDisplay) {
      pathDisplay.textContent = path || '~';
    }
  }

  // Select a path and populate the target input field
  function selectPath(path) {
    if (!targetInputId) {
      alert('No target input field selected');
      return;
    }

    const inputEl = document.getElementById(targetInputId);
    if (inputEl) {
      inputEl.value = path;
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      closeFileBrowser();
    }
  }

  // Open file browser modal for a specific input
  function openFileBrowser(inputId, initialPath = null) {
    targetInputId = inputId;
    const inputEl = document.getElementById(inputId);

    // Determine initial path:
    // 1. If input has a value, start from that directory
    if (inputEl && inputEl.value) {
      const val = String(inputEl.value).trim();
      if (val) {
        initialPath = val;
      }
    }
    
    // 2. If no path determined yet, default to /data/ (shows safe paths)
    if (!initialPath) {
      initialPath = '/data/';
    }

    // Ensure modal exists
    ensureModalExists();

    const modal = document.getElementById('fileBrowserModal');
    if (!modal) return;

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    loadDirectory(initialPath);
  }

  // Close file browser modal
  function closeFileBrowser() {
    const modal = document.getElementById('fileBrowserModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    }
    targetInputId = null;
  }

  // Ensure modal HTML exists in the DOM
  function ensureModalExists() {
    if (document.getElementById('fileBrowserModal')) return; // Already exists

    const modal = document.createElement('div');
    modal.id = 'fileBrowserModal';
    modal.className = 'modal hidden';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="fileBrowserTitle">
        <h3 id="fileBrowserTitle">Browse for path</h3>
        <small class="hint">Navigate directories and select a file or folder.</small>

        <div class="filebrowser-nav">
          <div class="path-parts" id="fileBrowserBreadcrumb"></div>
        </div>

        <div style="margin-bottom:8px; font-size:12px;">
          Current: <code id="fileBrowserCurrentPath">/</code>
        </div>

        <div class="filebrowser-list" id="fileBrowserList"></div>

        <div style="display:flex; gap:8px; margin-top:12px; justify-content:flex-end;">
          <button id="fileBrowserCloseBtn" class="btn" type="button">Cancel</button>
          <button id="fileBrowserLoadBtn" class="btn primary" type="button" disabled>Select current path</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Attach event listeners
    document.getElementById('fileBrowserCloseBtn').addEventListener('click', closeFileBrowser);
    document.getElementById('fileBrowserLoadBtn').addEventListener('click', () => selectPath(currentPath));

    // Close on backdrop click
    modal.querySelector('.modal-backdrop').addEventListener('click', closeFileBrowser);
  }

  // Attach file browser opener to a path input
  function attachFileBrowser(inputId, options = {}) {
    const inputEl = document.getElementById(inputId);
    if (!inputEl) return;

    // Create/find the wrapper
    let wrapper = inputEl.parentElement;
    if (!wrapper || !wrapper.classList.contains('path-input-group')) {
      wrapper = document.createElement('div');
      wrapper.className = 'path-input-group';
      inputEl.parentElement.insertBefore(wrapper, inputEl);
      wrapper.appendChild(inputEl);
    }

    // Create browse button if not already present
    let browseBtn = wrapper.querySelector('.btn-browse');
    if (!browseBtn) {
      browseBtn = document.createElement('button');
      browseBtn.type = 'button';
      browseBtn.className = 'btn btn-browse';
      browseBtn.textContent = '📁 Browse';
      browseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openFileBrowser(inputId, options.initialPath);
      });
      wrapper.appendChild(browseBtn);
    }
  }

  // Public API
  window.FileBrowser = {
    open: openFileBrowser,
    close: closeFileBrowser,
    attach: attachFileBrowser,
    selectPath: selectPath
  };
})();
