/**
 * BIDS Browser Module - Table-based file browser
 * Displays BIDS directory structure in a table with expand/collapse functionality
 * Color-codes files based on BIDS validation status
 */

(function() {
  'use strict';

  var BIDSBrowser = {
    expandedDirs: {},
    loadedDirs: {},
    validationStatus: {},
    flatList: [],
    rootPath: '',
    
    loadDirectory: function(path, resultsJson) {
      var self = this;
      self.expandedDirs = {};
      self.loadedDirs = {};
      self.flatList = [];
      self.rootPath = path;
      
      var container = document.getElementById('bidsBrowserContainer');
      if (!container) {
        console.error('BIDSBrowser: container not found');
        return;
      }
      
      if (!path || path.trim() === '') {
        container.innerHTML = '<div style="color: #f39c12; font-size: 12px;">⚠ No BIDS path configured</div>';
        return;
      }
      
      container.innerHTML = '<div style="color: #666; font-size: 12px;">Loading directory structure...</div>';
      
      // Parse validation status from bids_results.json if provided
      if (resultsJson && typeof resultsJson === 'object') {
        self.parseValidationStatus(resultsJson);
      }
      
      // Fetch directory listing
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/list-dir', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function() {
        try {
          if (xhr.status === 200) {
            var data = JSON.parse(xhr.responseText);
            if (data.items && Array.isArray(data.items)) {
              var tree = self.buildTreeFromItems(data.items);
              self.flattenTree(tree, 0);
              self.loadedDirs[''] = true;
              self.renderBrowser(container);
            } else {
              container.innerHTML = '<div style="color: #999; font-size: 12px;">No items found in directory</div>';
            }
          } else {
            container.innerHTML = '<div style="color: #d9534f; font-size: 12px;">Error loading directory</div>';
          }
        } catch (e) {
          console.error('BIDSBrowser load error:', e);
          container.innerHTML = '<div style="color: #d9534f; font-size: 12px;">Error: ' + e.message + '</div>';
        }
      };
      xhr.onerror = function() {
        container.innerHTML = '<div style="color: #d9534f; font-size: 12px;">Failed to connect to server</div>';
      };
      xhr.send(JSON.stringify({ path: path, calculate_size: true }));
    },
    
    parseValidationStatus: function(resultsJson) {
      var self = this;
      if (resultsJson.subjects && typeof resultsJson.subjects === 'object') {
        for (var sub in resultsJson.subjects) {
          if (resultsJson.subjects.hasOwnProperty(sub)) {
            self.validationStatus[sub] = 'valid';
            var subjData = resultsJson.subjects[sub];
            if (subjData.sessions && typeof subjData.sessions === 'object') {
              for (var ses in subjData.sessions) {
                if (subjData.sessions.hasOwnProperty(ses)) {
                  self.validationStatus[sub + '/' + ses] = 'valid';
                }
              }
            }
          }
        }
      }
    },
    
    buildTreeFromItems: function(items) {
      var tree = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.name && item.name.charAt(0) !== '.') {
          tree.push({
            name: item.name,
            isDir: item.is_dir === true,
            size: item.size || 0,
            mtime: item.mtime || null,
            children: []
          });
        }
      }
      return tree.sort(function(a, b) {
        return (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name);
      });
    },
    
    flattenTree: function(tree, depth, parentPath) {
      var self = this;
      parentPath = parentPath || '';
      
      for (var i = 0; i < tree.length; i++) {
        var item = tree[i];
        var fullPath = parentPath ? parentPath + '/' + item.name : item.name;
        var shortPath = fullPath.replace(/^.*\/(sub-[^/]*)/, '$1');
        
        self.flatList.push({
          name: item.name,
          isDir: item.isDir,
          size: item.size,
          mtime: item.mtime,
          depth: depth,
          path: fullPath,
          shortPath: shortPath,
          parentPath: parentPath,
          id: 'item-' + Math.random().toString(36).substr(2, 9)
        });
      }
    },

    getItemIndexByPath: function(path) {
      for (var i = 0; i < this.flatList.length; i++) {
        if (this.flatList[i].path === path) {
          return i;
        }
      }
      return -1;
    },

    insertChildren: function(parentPath, items) {
      var parentIndex = this.getItemIndexByPath(parentPath);
      if (parentIndex < 0) {
        return;
      }

      var parentItem = this.flatList[parentIndex];
      var insertIndex = parentIndex + 1;
      while (
        insertIndex < this.flatList.length &&
        this.flatList[insertIndex].path.indexOf(parentPath + '/') === 0
      ) {
        insertIndex++;
      }

      var toInsert = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var fullPath = parentPath ? parentPath + '/' + item.name : item.name;
        var shortPath = fullPath.replace(/^.*\/(sub-[^/]*)/, '$1');
        toInsert.push({
          name: item.name,
          isDir: item.isDir,
          size: item.size,
          mtime: item.mtime,
          depth: parentItem.depth + 1,
          path: fullPath,
          shortPath: shortPath,
          parentPath: parentPath,
          id: 'item-' + Math.random().toString(36).substr(2, 9)
        });
      }

      this.flatList.splice.apply(this.flatList, [insertIndex, 0].concat(toInsert));
    },

    fetchChildren: function(path, callback) {
      var self = this;
      var targetPath = self.joinPath(self.rootPath, path);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/list-dir', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function() {
        if (xhr.status === 200) {
          try {
            var data = JSON.parse(xhr.responseText);
            var items = data.items && Array.isArray(data.items) ? data.items : [];
            callback(null, items);
          } catch (e) {
            callback(e, []);
          }
        } else {
          callback(new Error('Failed to load directory'), []);
        }
      };
      xhr.onerror = function() {
        callback(new Error('Failed to connect to server'), []);
      };
      xhr.send(JSON.stringify({ path: targetPath, calculate_size: true }));
    },

    joinPath: function(basePath, relativePath) {
      if (!relativePath) {
        return basePath;
      }
      if (!basePath) {
        return relativePath;
      }
      if (basePath.endsWith('/')) {
        return basePath + relativePath;
      }
      return basePath + '/' + relativePath;
    },
    
    getValidationClass: function(name, shortPath) {
      // Color coding temporarily disabled
      return 'other';
      // if (this.validationStatus[shortPath]) {
      //   return 'valid';
      // }
      // if (name.match(/^sub-|^ses-|^task-|^run-|^acq-/i)) {
      //   return 'entity';
      // }
      // if (name === 'dataset_description.json' || name === 'README' || name === 'CHANGES') {
      //   return 'valid';
      // }
      // if (name.match(/\.(tsv|json|nii\.gz|nii)$/i)) {
      //   return 'datafile';
      // }
      // return 'other';
    },
    
    renderBrowser: function(container) {
      var self = this;
      var html = '';
      
      // Legend (temporarily disabled)
      // html += '<div style="margin-bottom:16px; display:flex; gap:20px; flex-wrap:wrap; font-size:12px; padding:12px; background:#f9f9f9; border-radius:4px; border:1px solid #eee;">';
      // html += '<div><div style="display:inline-block; width:12px; height:12px; border-radius:2px; background:#4caf50; margin-right:6px; vertical-align:middle;"></div><strong>Valid BIDS</strong></div>';
      // html += '<div><div style="display:inline-block; width:12px; height:12px; border-radius:2px; background:#2196f3; margin-right:6px; vertical-align:middle;"></div><strong>Data file</strong></div>';
      // html += '<div><div style="display:inline-block; width:12px; height:12px; border-radius:2px; background:#ff9800; margin-right:6px; vertical-align:middle;"></div><strong>BIDS entity</strong></div>';
      // html += '<div><div style="display:inline-block; width:12px; height:12px; border-radius:2px; background:#ccc; margin-right:6px; vertical-align:middle;"></div><strong>Other</strong></div>';
      // html += '</div>';
      
      // Table
      html += '<table style="width:100%; border-collapse:collapse; font-size:12px; background:#fff; border:1px solid #eee; border-radius:4px; overflow:hidden;">';
      html += '<thead style="background:#f5f5f5; border-bottom:2px solid #ddd;">';
      html += '<tr>';
      html += '<th style="padding:10px; text-align:left; font-weight:600; width:30px;"></th>';
      html += '<th style="padding:10px; text-align:left; font-weight:600;">Name</th>';
      html += '<th style="padding:10px; text-align:right; font-weight:600; width:90px;">Size</th>';
      html += '<th style="padding:10px; text-align:right; font-weight:600; width:140px;">Modified</th>';
      html += '</tr>';
      html += '</thead>';
      html += '<tbody>';
      
      for (var i = 0; i < self.flatList.length; i++) {
        html += self.renderRow(self.flatList[i]);
      }
      
      html += '</tbody>';
      html += '</table>';
      
      container.innerHTML = html;
    },
    
    renderRow: function(item) {
      var self = this;
      var isVisible = self.shouldShowRow(item);
      var valClass = self.getValidationClass(item.name, item.shortPath);
      var bgColor = {
        'valid': '#e8f5e9',
        'entity': '#fff3e0',
        'datafile': '#e3f2fd',
        'other': '#fafafa'
      }[valClass] || 'transparent';
      
      var borderLeft = {
        'valid': '3px solid #4caf50',
        'entity': '3px solid #ff9800',
        'datafile': '3px solid #2196f3',
        'other': '3px solid #ccc'
      }[valClass] || '3px solid #999';
      
      var html = '<tr id="' + item.id + '" style="background:' + bgColor + '; border-left:' + borderLeft + '; border-bottom:1px solid #eee; display:' + (isVisible ? 'table-row' : 'none') + ';">';
      
      // Toggle button
      if (item.isDir) {
        var icon = self.expandedDirs[item.path] ? '▼' : '▶';
        html += '<td style="padding:8px; text-align:center; cursor:pointer; user-select:none; font-size:14px; vertical-align:middle; color:#666;" data-path="' + item.path + '" onclick="BIDSBrowser.toggleExpand(\'' + item.path + '\');">' + icon + '</td>';
      } else {
        html += '<td style="padding:8px; text-align:center; font-size:14px; vertical-align:middle;">📄</td>';
      }
      
      // Name with indentation
      var indent = item.depth * 20;
      html += '<td style="padding:8px; user-select:text; font-family:monospace; padding-left:' + (8 + indent) + 'px; vertical-align:middle;">' + self.escapeHtml(item.name) + '</td>';
      
      // Size
      html += '<td style="padding:8px; text-align:right; font-family:monospace; font-size:11px; color:#666; vertical-align:middle;">' + self.formatSize(item.size) + '</td>';
      
      // Modified
      html += '<td style="padding:8px; text-align:right; font-family:monospace; font-size:11px; color:#666; vertical-align:middle;">' + self.formatDate(item.mtime) + '</td>';
      
      html += '</tr>';
      
      return html;
    },
    
    toggleExpand: function(path) {
      var self = this;
      var isExpanded = !!self.expandedDirs[path];

      if (isExpanded) {
        delete self.expandedDirs[path];
        self.renderBrowser(document.getElementById('bidsBrowserContainer'));
        return;
      }

      self.expandedDirs[path] = true;

      if (self.loadedDirs[path]) {
        self.renderBrowser(document.getElementById('bidsBrowserContainer'));
        return;
      }

      self.fetchChildren(path, function(err, items) {
        if (err) {
          console.error('BIDSBrowser: failed to load children for', path, err);
          self.renderBrowser(document.getElementById('bidsBrowserContainer'));
          return;
        }
        var tree = self.buildTreeFromItems(items);
        self.insertChildren(path, tree);
        self.loadedDirs[path] = true;
        self.renderBrowser(document.getElementById('bidsBrowserContainer'));
      });
    },
    
    shouldShowRow: function(item) {
      var parts = item.path.split('/');
      for (var i = 0; i < parts.length - 1; i++) {
        var parent = parts.slice(0, i + 1).join('/');
        if (!(parent in this.expandedDirs)) {
          return false;
        }
      }
      return true;
    },
    
    escapeHtml: function(text) {
      var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
      return String(text).replace(/[&<>"']/g, function(c) { return map[c]; });
    },
    
    formatSize: function(bytes) {
      if (!bytes || bytes === 0) return '—';
      var units = ['B', 'KB', 'MB', 'GB', 'TB'];
      var size = bytes;
      var idx = 0;
      while (size >= 1024 && idx < units.length - 1) {
        size /= 1024;
        idx++;
      }
      return size.toFixed(1) + ' ' + units[idx];
    },
    
    formatDate: function(timestamp) {
      if (!timestamp) return '—';
      var date = new Date(timestamp * 1000);
      var y = date.getFullYear();
      var m = String(date.getMonth() + 1).padStart(2, '0');
      var d = String(date.getDate()).padStart(2, '0');
      var h = String(date.getHours()).padStart(2, '0');
      var min = String(date.getMinutes()).padStart(2, '0');
      return y + '-' + m + '-' + d + ' ' + h + ':' + min;
    }
  };
  
  window.BIDSBrowser = BIDSBrowser;
  console.log('BIDSBrowser loaded');
})();
