/**
 * BIDS Browser Module
 * Provides tree view of BIDS directory structure with search and filtering
 * Safari-compatible - uses ES5 syntax only
 */

(function() {
  'use strict';

  var BIDSBrowser = {
    expandedDirs: [],
    allItems: {},
    container: null,
    
    expandedDirsHas: function(path) {
      for (var i = 0; i < this.expandedDirs.length; i++) {
        if (this.expandedDirs[i] === path) return true;
      }
      return false;
    },
    
    expandedDirsAdd: function(path) {
      if (!this.expandedDirsHas(path)) {
        this.expandedDirs.push(path);
      }
    },
    
    expandedDirsDelete: function(path) {
      var newDirs = [];
      for (var i = 0; i < this.expandedDirs.length; i++) {
        if (this.expandedDirs[i] !== path) {
          newDirs.push(this.expandedDirs[i]);
        }
      }
      this.expandedDirs = newDirs;
    },
    
    expandedDirsClear: function() {
      this.expandedDirs = [];
    },
    
    loadDirectory: function(path) {
      try {
        var self = this;
        var container = document.getElementById('bidsBrowserContainer');
        if (!container) {
          console.error('BIDSBrowser: container not found');
          return;
        }
        
        self.container = container;
        
        if (!path || path.trim() === '') {
          container.innerHTML = '<div style="color: #f39c12; font-size: 12px;">&#9888; No BIDS path configured</div>';
          return;
        }
        
        container.innerHTML = '<div style="color: #666; font-size: 12px;">Loading...</div>';
        self.expandedDirsClear();
        self.allItems = {};
        
        self.loadAndRender(path, container);
      } catch(e) {
        console.error('BIDSBrowser.loadDirectory error:', e);
      }
    },
    
    loadAndRender: function(path, container) {
      try {
        var self = this;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/list-dir', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function() {
          try {
            if (xhr.status === 200) {
              var data = JSON.parse(xhr.responseText);
              var filtered = [];
              for (var i = 0; i < data.items.length; i++) {
                if (data.items[i].name.charAt(0) !== '.') {
                  filtered.push(data.items[i]);
                }
              }
              self.allItems[path] = filtered;
              
              var html = '<div style="display: flex; flex-direction: column; gap: 12px; height: 100%;">';
              html += '<div style="display: flex; gap: 8px; flex-wrap: wrap;">';
              html += '<input type="text" class="bids-search" placeholder="Search..." style="flex: 1; min-width: 150px; padding: 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;">';
              html += '<select class="bids-type" style="padding: 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;">';
              html += '<option value="">All items</option>';
              html += '<option value="folders">Folders only</option>';
              html += '<option value="files">Files only</option>';
              html += '</select>';
              html += '</div>';
              html += '<div class="bids-tree-container" style="flex: 1; overflow: auto; background: white; border: 1px solid #e0e0e0; border-radius: 4px; padding: 8px; font-family: monospace; font-size: 11px;">';
              html += self.renderTree(data.items, path, 0);
              html += '</div></div>';
              
              container.innerHTML = html;
              self.setupEventListeners(container, path);
            } else {
              var err = JSON.parse(xhr.responseText);
              container.innerHTML = '<div style="color: #e74c3c; font-size: 12px;">Error: ' + (err.error || 'Unknown error') + '</div>';
            }
          } catch(e) {
            console.error('BIDSBrowser.loadAndRender onload error:', e);
            container.innerHTML = '<div style="color: #e74c3c; font-size: 12px;">Error: ' + e.message + '</div>';
          }
        };
        xhr.onerror = function() {
          container.innerHTML = '<div style="color: #e74c3c; font-size: 12px;">Network error loading directory</div>';
        };
        xhr.send(JSON.stringify({ path: path, calculate_size: true }));
      } catch(e) {
        console.error('BIDSBrowser.loadAndRender error:', e);
      }
    },
    
    renderTree: function(items, basePath, level) {
      try {
        var self = this;
        var html = '<div style="line-height: 1.8;">';
        
        // Sort items
        var sortedItems = [];
        for (var i = 0; i < items.length; i++) {
          sortedItems.push(items[i]);
        }
        sortedItems.sort(function(a, b) {
          if (a.is_dir !== b.is_dir) return b.is_dir ? 1 : -1;
          return a.name.localeCompare(b.name);
        });
        
        for (var i = 0; i < sortedItems.length; i++) {
          var item = sortedItems[i];
          if (item.name.charAt(0) === '.') continue;
          
          var indent = level * 16;
          var isDir = item.is_dir;
          var icon = isDir ? '📁' : '📄';
          var sizeStr = item.size !== null && item.size !== undefined ? self.formatSize(item.size) : '';
          var modDateStr = item.mtime ? self.formatDate(item.mtime) : '';
          var itemType = isDir ? 'folder' : 'file';
          
          html += '<div class="bids-item" data-type="' + itemType + '" data-path="' + self.escapeHtml(item.path) + '" data-level="' + level + '" data-indent="' + indent + '" style="padding: 3px 6px; display: flex; align-items: center; gap: 8px; margin-left: ' + indent + 'px; border-radius: 3px; cursor: default;">';
          
          if (isDir) {
            html += '<button class="bids-toggle" data-path="' + self.escapeHtml(item.path) + '" style="border: none; background: none; cursor: pointer; padding: 0 2px; width: 14px; text-align: center; font-size: 11px; color: #666; font-weight: bold;">▶</button>';
          } else {
            html += '<span style="width: 14px;"></span>';
          }
          
          html += '<span style="color: #333; font-size: 12px;">' + icon + '</span>';
          html += '<span style="flex: 1; cursor: default; user-select: text; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + self.escapeHtml(item.name) + '">' + self.escapeHtml(item.name) + '</span>';
          html += '<span style="color: #999; font-size: 9px; min-width: 145px; text-align: right; flex-shrink: 0;" title="' + modDateStr + '">' + modDateStr + '</span>';
          html += '<span style="color: #999; font-size: 9px; min-width: 60px; text-align: right; flex-shrink: 0;">' + sizeStr + '</span>';
          html += '</div>';
          
          if (isDir) {
            html += '<div class="bids-children" data-path="' + self.escapeHtml(item.path) + '" data-level="' + (level + 1) + '" style="display: none;"></div>';
          }
        }
        
        html += '</div>';
        return html;
      } catch(e) {
        console.error('BIDSBrowser.renderTree error:', e);
        return '<div style="color: #e74c3c; font-size: 12px;">Error rendering tree: ' + e.message + '</div>';
      }
    },
    
    escapeHtml: function(text) {
      var map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      };
      var result = '';
      for (var i = 0; i < text.length; i++) {
        var char = text.charAt(i);
        result += map[char] || char;
      }
      return result;
    },
    
    setupEventListeners: function(container, basePath) {
      try {
        var self = this;
        var searchInput = container.querySelector('.bids-search');
        var typeFilter = container.querySelector('.bids-type');
        var treeContainer = container.querySelector('.bids-tree-container');
        
        if (searchInput) {
          searchInput.addEventListener('input', function() {
            self.applyFilters(container);
          });
        }
        
        if (typeFilter) {
          typeFilter.addEventListener('change', function() {
            self.applyFilters(container);
          });
        }
        
        if (treeContainer) {
          treeContainer.addEventListener('click', function(e) {
            var toggleBtn = e.target;
            if (toggleBtn.className && toggleBtn.className.indexOf('bids-toggle') !== -1) {
              self.toggleDir(toggleBtn, container, basePath);
            }
          });
        }
      } catch(e) {
        console.error('BIDSBrowser.setupEventListeners error:', e);
      }
    },
    
    applyFilters: function(container) {
      try {
        var searchInput = container.querySelector('.bids-search');
        var typeFilter = container.querySelector('.bids-type');
        var search = searchInput ? searchInput.value.toLowerCase() : '';
        var typeVal = typeFilter ? typeFilter.value : '';
        
        var items = container.querySelectorAll('.bids-item');
        var childDivs = container.querySelectorAll('.bids-children');
        
        // If no search and no filter, show everything and restore original indentation
        if (!search && !typeVal) {
          for (var i = 0; i < items.length; i++) {
            items[i].style.display = 'block';
            items[i].removeAttribute('data-filtered');
            var originalIndent = items[i].getAttribute('data-indent');
            if (originalIndent !== null) {
              items[i].style.marginLeft = originalIndent + 'px';
            }
          }
          for (var j = 0; j < childDivs.length; j++) {
            childDivs[j].removeAttribute('data-filtered');
            // Keep collapsed folders collapsed, show expanded ones
            if (!childDivs[j].getAttribute('data-collapsed')) {
              childDivs[j].style.display = 'block';
            } else {
              childDivs[j].style.display = 'none';
            }
          }
          return;
        }
        
        // Filtering is active
        // Step 1: Hide everything
        for (var i = 0; i < items.length; i++) {
          items[i].style.display = 'none';
          items[i].setAttribute('data-filtered', 'true');
        }
        for (var j = 0; j < childDivs.length; j++) {
          childDivs[j].style.display = 'none';
        }
        
        // Step 2: Show matching items with flat indentation
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var itemType = item.getAttribute('data-type');
          var text = item.textContent.toLowerCase();
          
          var matchesSearch = !search || text.indexOf(search) !== -1;
          var matchesType = !typeVal || 
            (typeVal === 'folders' && itemType === 'folder') ||
            (typeVal === 'files' && itemType === 'file');
          
          if (matchesSearch && matchesType) {
            item.style.display = 'block';
            item.setAttribute('data-filtered', 'false');
            item.style.marginLeft = '0px';  // Flat layout during search
          }
        }
        
        // Step 3: Show containers that have visible items
        for (var j = 0; j < childDivs.length; j++) {
          var childDiv = childDivs[j];
          var itemsInContainer = childDiv.querySelectorAll('.bids-item');
          var hasVisibleItem = false;
          
          for (var k = 0; k < itemsInContainer.length; k++) {
            if (itemsInContainer[k].getAttribute('data-filtered') === 'false') {
              hasVisibleItem = true;
              break;
            }
          }
          
          if (hasVisibleItem) {
            childDiv.style.display = 'block';
          }
        }
      } catch(e) {
        console.error('BIDSBrowser.applyFilters error:', e);
      }
    },
    
    toggleDir: function(button, container, basePath) {
      try {
        var self = this;
        var dirPath = button.getAttribute('data-path');
        var children = container.querySelectorAll('.bids-children');
        var childContainer = null;
        
        for (var i = 0; i < children.length; i++) {
          if (children[i].getAttribute('data-path') === dirPath) {
            childContainer = children[i];
            break;
          }
        }
        
        if (!childContainer) return;
        
        var isExpanded = self.expandedDirsHas(dirPath);
        var level = parseInt(childContainer.getAttribute('data-level')) || 1;
        
        if (isExpanded) {
          self.expandedDirsDelete(dirPath);
          button.textContent = '▶';
          childContainer.style.display = 'none';
          childContainer.setAttribute('data-collapsed', 'true');
        } else {
          self.expandedDirsAdd(dirPath);
          button.textContent = '▼';
          childContainer.removeAttribute('data-collapsed');
          childContainer.style.display = 'block';
          
          if (childContainer.innerHTML === '') {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/list-dir', true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onload = function() {
              if (xhr.status === 200) {
                var data = JSON.parse(xhr.responseText);
                childContainer.innerHTML = self.renderTree(data.items, dirPath, level);
                self.setupEventListeners(childContainer, dirPath);
              }
            };
            xhr.send(JSON.stringify({ path: dirPath, calculate_size: true }));
          }
        }
      } catch(e) {
        console.error('BIDSBrowser.toggleDir error:', e);
      }
    },
    
    formatSize: function(bytes) {
      if (bytes === 0) return '0 B';
      var k = 1024;
      var sizes = ['B', 'KB', 'MB', 'GB'];
      var i = Math.floor(Math.log(bytes) / Math.log(k));
      var size = Math.round(bytes / Math.pow(k, i) * 10) / 10;
      return size + ' ' + sizes[i];
    },
    
    formatDate: function(timestamp) {
      var date = new Date(timestamp * 1000);
      var year = date.getFullYear();
      var month = String(date.getMonth() + 1).padStart(2, '0');
      var day = String(date.getDate()).padStart(2, '0');
      var hours = String(date.getHours()).padStart(2, '0');
      var minutes = String(date.getMinutes()).padStart(2, '0');
      var seconds = String(date.getSeconds()).padStart(2, '0');
      return year + '-' + month + '-' + day + ' ' + hours + ':' + minutes + ':' + seconds;
    }
  };
  
  // Expose to global scope
  window.BIDSBrowser = BIDSBrowser;
  console.log('BIDSBrowser module loaded');
})();
