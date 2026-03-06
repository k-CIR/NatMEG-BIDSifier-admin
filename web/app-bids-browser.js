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
    qaResults: null,
    ignoreAcknowledgedForCurrentQA: false,
    fileIssues: {},
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
      
      // QA Summary Panel DISABLED - QA findings now shown in separate "Active Issues Detail" section
      // This keeps the BIDS browser clean and focused on file structure display only
      if (false && self.qaResults && self.qaResults.summary) {
        // Recalculate counts based on currently active (non-acknowledged) issues
        var totalIssues = 0;
        var errors = 0;
        var warnings = 0;
        var infos = 0;
        var categoryCounts = {};
        var severityByCategory = {}; // New: track severity counts per category
        var allActiveIssues = [];
        var visiblePaths = {};

        // Paths currently rendered in the table (normalized)
        for (var vp = 0; vp < self.flatList.length; vp++) {
          var normalizedVisible = self.normalizeIssuePath(self.flatList[vp].path);
          if (normalizedVisible) visiblePaths[normalizedVisible] = true;
        }
        
        for (var path in self.fileIssues) {
          var issueInfo = self.getFileIssues(path);
          totalIssues += issueInfo.count;
          for (var i = 0; i < issueInfo.issues.length; i++) {
            var issue = issueInfo.issues[i];
            var severity = issue.severity || 'info';
            var category = issue.category || 'Other';
            
            // Overall severity counts
            if (severity === 'error') errors++;
            else if (severity === 'warning') warnings++;
            else infos++;
            
            // Collect for issues panel
            var issueItem = Object.assign({}, issue);
            issueItem.itemPath = path;

            // Show in Active Issues Detail only when not visible in file table rows
            var normalizedIssuePath = self.normalizeIssuePath(path);
            if (!visiblePaths[normalizedIssuePath]) {
              allActiveIssues.push(issueItem);
            }
            
            // Count by category (total)
            categoryCounts[category] = (categoryCounts[category] || 0) + 1;
            
            // Count by category and severity
            if (!severityByCategory[category]) {
              severityByCategory[category] = { error: 0, warning: 0, info: 0 };
            }
            severityByCategory[category][severity]++;
          }
        }
        
        var statusColor = errors > 0 ? '#d32f2f' : warnings > 0 ? '#f57f17' : totalIssues > 0 ? '#2196f3' : '#4caf50';
        var statusBg = errors > 0 ? '#ffebee' : warnings > 0 ? '#fff8e1' : totalIssues > 0 ? '#e3f2fd' : '#e8f5e9';
        var statusIcon = errors > 0 ? '⚠️' : warnings > 0 ? '⚡' : totalIssues > 0 ? 'ℹ️' : '✓';
        
        html += '<div id="qaSummaryPanel" style="padding:12px 16px; background:' + statusBg + '; border-radius:6px; margin-bottom:16px; border-left:4px solid ' + statusColor + '; box-shadow:0 2px 4px rgba(0,0,0,0.05);">';
        html += '<div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">';
        html += '<span style="font-size:20px;">' + statusIcon + '</span>';
        html += '<div style="flex:1;">';
        html += '<div style="font-weight:600; font-size:14px; color:' + statusColor + ';">';
        html += totalIssues === 0 ? 'All Issues Resolved!' : totalIssues + ' Active Issue' + (totalIssues === 1 ? '' : 's');
        html += '</div>';
        html += '<div style="font-size:11px; color:#666; margin-top:2px;">';
        if (totalIssues > 0) {
          html += 'Errors: ' + errors + ' • Warnings: ' + warnings + ' • Info: ' + infos;
        } else {
          html += 'All BIDS issues addressed';
        }
        html += '</div>';
        html += '</div>';
        html += '</div>';
        
        // Add severity by category matrix table
        if (totalIssues > 0 && Object.keys(severityByCategory).length > 0) {
          html += '<div style="overflow-x:auto; margin-top:8px;">';
          html += '<table style="width:100%; border-collapse:collapse; font-size:11px; background:white; border-radius:4px; overflow:hidden;">';
          html += '<thead>';
          html += '<tr style="background:#f5f5f5; border-bottom:2px solid #ddd;">';
          html += '<th style="text-align:left; padding:6px 8px; font-weight:600; color:#555;">Category</th>';
          html += '<th style="text-align:center; padding:6px 8px; font-weight:600; color:#d32f2f;">❌ Errors</th>';
          html += '<th style="text-align:center; padding:6px 8px; font-weight:600; color:#f57f17;">⚠️ Warnings</th>';
          html += '<th style="text-align:center; padding:6px 8px; font-weight:600; color:#2196f3;">ℹ️ Info</th>';
          html += '<th style="text-align:center; padding:6px 8px; font-weight:600; color:#666;">Total</th>';
          html += '</tr>';
          html += '</thead>';
          html += '<tbody>';
          
          // Sort categories by total count (descending)
          var sortedCategories = Object.keys(severityByCategory).sort(function(a, b) {
            return categoryCounts[b] - categoryCounts[a];
          });
          
          for (var idx = 0; idx < sortedCategories.length; idx++) {
            var cat = sortedCategories[idx];
            var counts = severityByCategory[cat];
            var total = categoryCounts[cat];
            var rowBg = idx % 2 === 0 ? '#fafafa' : 'white';
            
            html += '<tr style="background:' + rowBg + '; border-bottom:1px solid #eee;">';
            html += '<td style="padding:6px 8px; font-weight:500; color:#333;">' + self.escapeHtml(cat) + '</td>';
            html += '<td style="text-align:center; padding:6px 8px; color:' + (counts.error > 0 ? '#d32f2f' : '#ccc') + '; font-weight:' + (counts.error > 0 ? '600' : '400') + ';">' + counts.error + '</td>';
            html += '<td style="text-align:center; padding:6px 8px; color:' + (counts.warning > 0 ? '#f57f17' : '#ccc') + '; font-weight:' + (counts.warning > 0 ? '600' : '400') + ';">' + counts.warning + '</td>';
            html += '<td style="text-align:center; padding:6px 8px; color:' + (counts.info > 0 ? '#2196f3' : '#ccc') + '; font-weight:' + (counts.info > 0 ? '600' : '400') + ';">' + counts.info + '</td>';
            html += '<td style="text-align:center; padding:6px 8px; font-weight:600; color:#555;">' + total + '</td>';
            html += '</tr>';
          }
          
          // Add totals row
          html += '<tr style="background:#f5f5f5; border-top:2px solid #ddd; font-weight:600;">';
          html += '<td style="padding:6px 8px; color:#333;">Total</td>';
          html += '<td style="text-align:center; padding:6px 8px; color:#d32f2f;">' + errors + '</td>';
          html += '<td style="text-align:center; padding:6px 8px; color:#f57f17;">' + warnings + '</td>';
          html += '<td style="text-align:center; padding:6px 8px; color:#2196f3;">' + infos + '</td>';
          html += '<td style="text-align:center; padding:6px 8px; color:#333;">' + totalIssues + '</td>';
          html += '</tr>';
          
          html += '</tbody>';
          html += '</table>';
          html += '</div>';
        }
        
        html += '</div>';
        
        // Issues Detail Panel - Show only active issues not visible in table
        if (allActiveIssues.length > 0) {
          html += '<div id="qaIssuesDetailPanel" style="margin-bottom:16px; background:#f9f9f9; border:1px solid #ddd; border-radius:6px; overflow:hidden;">';
          html += '<div style="padding:10px 16px; background:#f5f5f5; border-bottom:1px solid #ddd; font-weight:600; font-size:12px; color:#333;">Active Issues Detail (' + allActiveIssues.length + ')</div>';
          html += '<div style="max-height:300px; overflow-y:auto;">';
          
          for (var idx = 0; idx < allActiveIssues.length; idx++) {
            var activeIss = allActiveIssues[idx];
            var sevColor = activeIss.severity === 'error' ? '#d32f2f' : activeIss.severity === 'warning' ? '#f57f17' : '#1976d2';
            var sevIcon = activeIss.severity === 'error' ? '❌' : activeIss.severity === 'warning' ? '⚠️' : 'ℹ️';
            var activeLevel = activeIss.bids_level || self.inferIssueLevel(activeIss, activeIss.itemPath);
            var levelColor = activeLevel === 'dataset' ? '#9c27b0' : activeLevel === 'subject' ? '#2196f3' : activeLevel === 'session' ? '#ff9800' : '#4caf50';
            
            // Get BIDS documentation link
            var docLink = self.getBIDSDocLink(activeIss);
            
            html += '<div style="padding:10px 16px; border-bottom:1px solid #eee; display:flex; align-items:flex-start; gap:10px;">';
            html += '<span style="font-size:14px; margin-top:1px;">' + sevIcon + '</span>';
            html += '<div style="flex:1; min-width:0;">';
            html += '<div style="font-weight:500; font-size:12px; margin-bottom:3px;">' + self.escapeHtml(activeIss.issue || 'Unknown') + '</div>';
            html += '<div style="font-size:10px; color:#666; margin-bottom:4px;">📍 ' + self.escapeHtml((activeIss.itemPath || 'dataset').substr(0, 60)) + '</div>';
            if (activeIss.suggestion) {
              html += '<div style="font-size:10px; color:#555; margin-bottom:4px;">💡 ' + self.escapeHtml(activeIss.suggestion) + '</div>';
            }
            // Add BIDS documentation link
            if (docLink) {
              html += '<div style="font-size:10px; margin-top:4px;">';
              html += '<a href="' + docLink.url + '" target="_blank" rel="noopener noreferrer" style="color:#2196f3; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">';
              html += '📖 ' + self.escapeHtml(docLink.label) + ' ↗';
              html += '</a>';
              html += '</div>';
            }
            html += '</div>';
            html += '<span style="font-size:8px; padding:2px 6px; background:' + levelColor + '; color:white; border-radius:3px; font-weight:600; white-space:nowrap;">' + (activeLevel || 'file').toUpperCase() + '</span>';
            html += '<button onclick="BIDSBrowser.dismissIssueFromPanel(' + idx + '); return false;" style="padding:4px 8px; font-size:10px; background:#4caf50; color:white; border:none; border-radius:3px; cursor:pointer; white-space:nowrap;">✓ OK</button>';
            html += '</div>';
          }
          
          html += '</div>';
          html += '</div>';
        }
      }
      
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
      
      // Check if this file has QA issues
      var issueInfo = self.getFileIssues(item.path);
      var hasIssues = issueInfo.count > 0;
      
      var valClass = self.getValidationClass(item.name, item.shortPath);
      var bgColor = {
        'valid': '#e8f5e9',
        'entity': '#fff3e0',
        'datafile': '#e3f2fd',
        'other': '#fafafa'
      }[valClass] || 'transparent';
      
      // Override background if file has issues
      if (hasIssues) {
        if (issueInfo.maxSeverity === 'error') {
          bgColor = '#ffebee';
        } else if (issueInfo.maxSeverity === 'warning') {
          bgColor = '#fff8e1';
        } else {
          bgColor = '#e3f2fd';
        }
      }
      
      var borderLeft = {
        'valid': '3px solid #4caf50',
        'entity': '3px solid #ff9800',
        'datafile': '3px solid #2196f3',
        'other': '3px solid #ccc'
      }[valClass] || '3px solid #999';
      
      // Override border if file has issues
      if (hasIssues) {
        if (issueInfo.maxSeverity === 'error') {
          borderLeft = '3px solid #d32f2f';
        } else if (issueInfo.maxSeverity === 'warning') {
          borderLeft = '3px solid #f57f17';
        } else {
          borderLeft = '3px solid #1976d2';
        }
      }
      
      var html = '<tr id="row-' + self.sanitizeId(item.path) + '" style="background:' + bgColor + '; border-left:' + borderLeft + '; border-bottom:1px solid #eee; display:' + (isVisible ? 'table-row' : 'none') + ';">';
      
      // Toggle button
      if (item.isDir) {
        var icon = self.expandedDirs[item.path] ? '▼' : '▶';
        html += '<td style="padding:8px; text-align:center; cursor:pointer; user-select:none; font-size:14px; vertical-align:middle; color:#666;" data-path="' + item.path + '" onclick="BIDSBrowser.toggleExpand(\'' + item.path.replace(/'/g, "\\'") + '\');">' + icon + '</td>';
      } else {
        html += '<td style="padding:8px; text-align:center; font-size:14px; vertical-align:middle;">📄</td>';
      }
      
      // Name with indentation and issue indicator
      var indent = item.depth * 20;
      var rowId = self.sanitizeId(item.path);
      html += '<td style="padding:8px; user-select:text; font-family:monospace; padding-left:' + (8 + indent) + 'px; vertical-align:middle;">';
      html += self.escapeHtml(item.name);
      
      // Show indicator for items with issues (files AND directories)
      if (hasIssues) {
        var issueIcon = issueInfo.maxSeverity === 'error' ? '❌' : issueInfo.maxSeverity === 'warning' ? '⚠️' : 'ℹ️';
        var issueTitle = issueInfo.count + ' issue' + (issueInfo.count === 1 ? '' : 's') + ' - click to expand';
        console.log('[BIDSBrowser] Rendering issue indicator for:', item.name, 'isDir:', item.isDir, 'rowId:', rowId, 'issues:', issueInfo.count);
        html += ' <span id="issue-icon-' + rowId + '" style="margin-left:6px; font-size:12px; cursor:pointer; user-select:none; padding:2px 6px; border-radius:2px; background:rgba(0,0,0,0.05); transition:all 0.2s;" title="' + issueTitle + '" onclick="console.log(\'Icon clicked\'); BIDSBrowser.toggleIssueDetails(\'' + rowId + '\'); return false;">' + issueIcon + ' (' + issueInfo.count + ')</span>';
      }
      html += '</td>';
      
      // Size
      html += '<td style="padding:8px; text-align:right; font-family:monospace; font-size:11px; color:#666; vertical-align:middle;">' + self.formatSize(item.size) + '</td>';
      
      // Modified
      html += '<td style="padding:8px; text-align:right; font-family:monospace; font-size:11px; color:#666; vertical-align:middle;">' + self.formatDate(item.mtime) + '</td>';
      
      html += '</tr>';
      
      // If item has issues (file or directory), add expandable issue details row
      if (hasIssues) {
        html += '<tr id="issue-details-' + rowId + '" style="display:none; background:#fffef0; border-left:' + borderLeft + ';">';
        html += '<td colspan="4" style="padding:12px 16px;">';
        html += '<div style="font-size:12px; font-weight:600; margin-bottom:8px; color:#333;">QA Issues for ' + self.escapeHtml(item.name) + ':</div>';
        
        for (var i = 0; i < issueInfo.issues.length; i++) {
          var issue = issueInfo.issues[i];
          var sevColor = issue.severity === 'error' ? '#d32f2f' : issue.severity === 'warning' ? '#f57f17' : '#1976d2';
          var sevBg = issue.severity === 'error' ? '#ffebee' : issue.severity === 'warning' ? '#fff8e1' : '#e3f2fd';
          var sevIcon = issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
          
          // Track the original index in the full issue list for acknowledgement
          var originalIndex = issue.originalIndex !== undefined ? issue.originalIndex : i;
          var issueRowId = 'issue-row-' + btoa(item.path).replace(/[^a-z0-9]/gi, '') + '-' + originalIndex;
          
          html += '<div id="' + issueRowId + '" style="margin-bottom:8px; padding:10px; background:' + sevBg + '; border-left:3px solid ' + sevColor + '; border-radius:4px; transition:all 0.3s ease;">';
          html += '<div style="display:flex; align-items:flex-start; gap:8px;">';
          html += '<span style="font-size:14px;">' + sevIcon + '</span>';
          html += '<div style="flex:1;">';
          
          var issuePath = issue.sourcePath || item.path;
          var issuePathEscaped = String(issuePath).replace(/'/g, "\\'");
          var displayLevel = issue.bids_level || self.inferIssueLevel(issue, issuePath);
          
          // Issue header with BIDS level badge
          html += '<div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">';
          html += '<div style="font-weight:500; font-size:12px; line-height:1.4;">' + self.escapeHtml(issue.issue || 'Unknown issue') + '</div>';
          var levelColor = displayLevel === 'dataset' ? '#9c27b0' : 
                          displayLevel === 'subject' ? '#2196f3' : 
                          displayLevel === 'session' ? '#ff9800' : '#4caf50';
          html += '<span style="font-size:9px; padding:2px 6px; background:' + levelColor + '; color:white; border-radius:3px; font-weight:600; text-transform:uppercase;">' + self.escapeHtml(displayLevel) + '</span>';
          html += '</div>';
          
          if (issue.suggestion) {
            html += '<div style="font-size:11px; color:#555; margin-top:6px; padding:6px 8px; background:rgba(255,255,255,0.6); border-radius:3px;">';
            html += '<strong>💡 Suggestion:</strong> ' + self.escapeHtml(issue.suggestion);
            html += '</div>';
          }
          
          // Show validator reference if available
          if (issue.validator_reference) {
            html += '<div style="font-size:10px; color:#666; margin-top:6px; padding:4px 8px; background:rgba(100,100,100,0.1); border-radius:3px;">';
            html += '<strong>🔗 BIDS Validator:</strong> ';
            if (issue.validator_reference.validator_code) {
              html += '<code style="font-size:9px; background:rgba(0,0,0,0.1); padding:1px 4px; border-radius:2px;">' + self.escapeHtml(issue.validator_reference.validator_code) + '</code> ';
            }
            if (issue.validator_reference.validator_link) {
              html += '<a href="' + self.escapeHtml(issue.validator_reference.validator_link) + '" target="_blank" style="color:#1976d2; text-decoration:none;">Learn more →</a>';
            }
            html += '</div>';
          }

          html += '<div style="margin-top:8px; display:flex; gap:6px;">';
          var issueRowId = 'issue-row-' + btoa(item.path).replace(/[^a-z0-9]/gi, '') + '-' + originalIndex;
          html += '<button data-issue-row="' + issueRowId + '" class="issue-action-btn" onclick="BIDSBrowser._markIssueAsOK(\'' + issuePathEscaped + '\', ' + originalIndex + '); return false;" style="padding:6px 12px; font-size:11px; background:#4caf50; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:600; transition:all 0.2s;">✓ Mark as OK</button>';
          var issueTextEscaped = String(issue.issue || '').replace(/'/g, "\\'");
          var rowPathEscaped = String(item.path || '').replace(/'/g, "\\'");
          html += '<button class="issue-action-btn" onclick="BIDSBrowser.viewInEditor(\'' + rowPathEscaped + '\', \'' + issuePathEscaped + '\', \'' + issueTextEscaped + '\'); return false;" style="padding:6px 12px; font-size:11px; background:#2196f3; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:600; transition:all 0.2s;">👁️ View in Editor</button>';
          html += '</div>';
          
          html += '</div></div></div>';
        }
        
        html += '</td></tr>';
      }
      
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
    
    sanitizeId: function(path) {
      // Create a valid DOM ID from a file path
      // Remove leading/trailing slashes, replace special chars with underscores
      return 'file-' + String(path)
        .replace(/^\/+|\/+$/g, '')           // remove leading/trailing slashes
        .replace(/[^a-zA-Z0-9._-]/g, '_')    // replace special chars
        .substring(0, 200);                   // limit length
    },

    normalizeIssuePath: function(path) {
      var p = String(path || '').trim();
      if (!p) return '';

      // Normalize separators and trim wrappers
      p = p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '');

      // If absolute path, keep BIDS-relevant suffix only
      var subIdx = p.search(/(?:^|\/)sub-[^/]+/);
      if (subIdx >= 0) {
        p = p.substring(subIdx).replace(/^\/+/, '');
      } else {
        var knownDatasetFiles = ['README', 'CHANGES', 'dataset_description.json', 'participants.tsv', 'participants.json'];
        var base = p.split('/').pop();
        if (knownDatasetFiles.indexOf(base) >= 0) {
          p = base;
        }
      }

      return p;
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
    },
    
    setQAResults: function(qaResults) {
      var self = this;
      self.qaResults = qaResults;
      self.fileIssues = {};
      console.log('[BIDSBrowser] setQAResults called with:', qaResults);
      
      // If qaResults is null or undefined, clear everything and re-render
      if (!qaResults) {
        console.log('[BIDSBrowser] Clearing QA results (null passed)');
        self.qaResults = null;
        self.ignoreAcknowledgedForCurrentQA = false;
        self.fileIssues = {};
        // Re-render the browser to remove QA panels
        var container = document.getElementById('bidsResultsContainer');
        if (container) {
          self.renderBrowser(container);
        }
        return;
      }
      
      // Use server-side acknowledgements as source of truth for a loaded QA file.
      // This avoids stale local acknowledgements hiding fresh findings when qa_analysis.json
      // is regenerated from scratch.
      var hasServerAcknowledged = Object.prototype.hasOwnProperty.call(qaResults, 'acknowledged_issues');
      var effectiveAcknowledged = {};

      if (hasServerAcknowledged && qaResults.acknowledged_issues && typeof qaResults.acknowledged_issues === 'object') {
        effectiveAcknowledged = qaResults.acknowledged_issues;
        self.ignoreAcknowledgedForCurrentQA = false;
        console.log('[BIDSBrowser] Loaded acknowledged issues from server file');
      } else {
        // No acknowledgements persisted in this QA file yet -> start clean for this load.
        effectiveAcknowledged = {};
        self.ignoreAcknowledgedForCurrentQA = true;
        console.log('[BIDSBrowser] No server acknowledgements in QA file, starting with clean active issues');
      }

      localStorage.setItem('acknowledgedQAIssues', JSON.stringify(effectiveAcknowledged));
      
      // Build a map of file paths to their issues
      if (qaResults && qaResults.findings && Array.isArray(qaResults.findings)) {
        console.log('[BIDSBrowser] Processing', qaResults.findings.length, 'findings');
        for (var i = 0; i < qaResults.findings.length; i++) {
          var finding = qaResults.findings[i];
          console.log('[BIDSBrowser] Finding', i + ':', finding);
          var file = finding.file;
          
          // Skip findings without specific files
          if (!file || file === 'multiple' || file === 'dataset') {
            console.log('[BIDSBrowser] Skipping finding without specific file:', file);
            continue;
          }
          
          // Normalize file path so it matches browser row paths
          var normalizedPath = self.normalizeIssuePath(file);
          
          console.log('[BIDSBrowser] Storing finding for path:', normalizedPath);
          if (!self.fileIssues[normalizedPath]) {
            self.fileIssues[normalizedPath] = [];
          }
          self.fileIssues[normalizedPath].push(finding);
        }
        console.log('[BIDSBrowser] Final item issues map keys:', Object.keys(self.fileIssues));
        for (var key in self.fileIssues) {
          console.log('[BIDSBrowser] Issues for', key + ':', self.fileIssues[key].length, 'issues');
        }
      } else {
        console.warn('[BIDSBrowser] qaResults has no findings array or is null');
      }
      
      // Refresh the browser view if it's already loaded
      var container = document.getElementById('bidsBrowserContainer');
      console.log('[BIDSBrowser] Container found:', !!container, 'FlatList length:', self.flatList.length);
      if (container && self.flatList.length > 0) {
        console.log('[BIDSBrowser] Re-rendering with QA results');
        self.renderBrowser(container);
      } else if (container) {
        console.log('[BIDSBrowser] Container exists but flatList empty, will render on next load');
      }
    },
    
    getFileIssues: function(filePath) {
      var self = this;
      var normalizedFilePath = self.normalizeIssuePath(filePath);
      var issues = [];

      // 1) Direct match first
      if (self.fileIssues[filePath]) {
        for (var d = 0; d < self.fileIssues[filePath].length; d++) {
          var directIssue = Object.assign({}, self.fileIssues[filePath][d]);
          directIssue.sourcePath = filePath;
          directIssue.sourceIndex = d;
          issues.push(directIssue);
        }
      }

      // 2) Strict normalized matching (single level only)
      if (issues.length === 0) {
        for (var key in self.fileIssues) {
          var normalizedKey = self.normalizeIssuePath(key);
          if (!normalizedKey) continue;

          if (normalizedKey === normalizedFilePath) {
            var keyIssues = self.fileIssues[key] || [];
            for (var k = 0; k < keyIssues.length; k++) {
              var matchedIssue = Object.assign({}, keyIssues[k]);
              matchedIssue.sourcePath = key;
              matchedIssue.sourceIndex = k;
              issues.push(matchedIssue);
            }
          }
        }
      }
      
      if (issues.length === 0) {
        return { count: 0, maxSeverity: null, issues: [] };
      }

      // Fresh QA run/file with no acknowledged_issues should show all findings immediately.
      if (self.ignoreAcknowledgedForCurrentQA) {
        var freshMaxSeverity = 'info';
        for (var fi = 0; fi < issues.length; fi++) {
          var freshIssue = Object.assign({}, issues[fi]);
          freshIssue.originalIndex = (typeof issues[fi].sourceIndex === 'number') ? issues[fi].sourceIndex : fi;
          freshIssue.sourcePath = issues[fi].sourcePath || filePath;
          issues[fi] = freshIssue;
          var freshSeverity = freshIssue.severity || 'info';
          if (freshSeverity === 'error') {
            freshMaxSeverity = 'error';
            break;
          } else if (freshSeverity === 'warning' && freshMaxSeverity !== 'error') {
            freshMaxSeverity = 'warning';
          }
        }
        if (issues.length > 0) {
          console.log('[BIDSBrowser.getFileIssues] Fresh QA mode:', issues.length, 'active issues for:', filePath);
        }
        return {
          count: issues.length,
          maxSeverity: freshMaxSeverity,
          issues: issues
        };
      }
      
      // Filter out acknowledged issues
      var acknowledgedIssues = JSON.parse(localStorage.getItem('acknowledgedQAIssues') || '{}');
      var filteredIssues = [];
      
      for (var i = 0; i < issues.length; i++) {
        var sourcePath = issues[i].sourcePath || filePath;
        var fileAcknowledged = acknowledgedIssues[sourcePath] || acknowledgedIssues[filePath] || [];

        // Check if issue is acknowledged (support both old format [index] and new format [{index, ...}])
        var isAcknowledged = false;
        for (var j = 0; j < fileAcknowledged.length; j++) {
          var acknowledged = fileAcknowledged[j];
          // Handle both formats: number (old) or object with index property (new)
          var ackIndex = typeof acknowledged === 'number' ? acknowledged : acknowledged.index;
          if (ackIndex === i) {
            isAcknowledged = true;
            break;
          }
        }
        
        if (!isAcknowledged) {
          // Keep track of original index for acknowledgement
          var issueWithIndex = Object.assign({}, issues[i]);
          issueWithIndex.originalIndex = (typeof issues[i].sourceIndex === 'number') ? issues[i].sourceIndex : i;
          issueWithIndex.sourcePath = sourcePath;
          filteredIssues.push(issueWithIndex);
        }
      }
      
      if (filteredIssues.length === 0) {
        return { count: 0, maxSeverity: null, issues: [] };
      }
      
      // Determine the highest severity
      var maxSeverity = 'info';
      for (var i = 0; i < filteredIssues.length; i++) {
        var severity = filteredIssues[i].severity || 'info';
        if (severity === 'error') {
          maxSeverity = 'error';
          break;
        } else if (severity === 'warning' && maxSeverity !== 'error') {
          maxSeverity = 'warning';
        }
      }
      
      if (filteredIssues.length > 0) {
        console.log('[BIDSBrowser.getFileIssues] Found', filteredIssues.length, 'active issues for:', filePath);
      }
      
      return {
        count: filteredIssues.length,
        maxSeverity: maxSeverity,
        issues: filteredIssues
      };
    },
    
    getBIDSDocLink: function(issue) {
      // Return relevant BIDS specification link based on issue category and file
      var baseUrl = 'https://bids-specification.readthedocs.io/en/stable/';
      var file = issue.file || '';
      var category = issue.category || '';
      
      // File-specific links
      if (file === 'README' || file.startsWith('README')) {
        return {
          url: baseUrl + '03-modality-agnostic-files.html#readme',
          label: 'README spec'
        };
      }
      if (file === 'dataset_description.json') {
        return {
          url: baseUrl + '03-modality-agnostic-files.html#dataset_descriptionjson',
          label: 'Dataset description spec'
        };
      }
      if (file === 'participants.tsv' || file === 'participants.json') {
        return {
          url: baseUrl + '03-modality-agnostic-files.html#participants-file',
          label: 'Participants file spec'
        };
      }
      if (file === 'CHANGES') {
        return {
          url: baseUrl + '03-modality-agnostic-files.html#changes',
          label: 'CHANGES file spec'
        };
      }
      
      // Category-specific links
      if (category === 'Documentation') {
        return {
          url: baseUrl + '02-common-principles.html#file-formation-specification',
          label: 'BIDS documentation'
        };
      }
      if (category === 'BIDS') {
        return {
          url: baseUrl + '01-introduction.html',
          label: 'BIDS intro'
        };
      }
      if (category === 'Metadata') {
        return {
          url: baseUrl + '04-modality-specific-files/04-intracranial-electroencephalography.html#sidecar-json-_eegjson',
          label: 'Metadata spec'
        };
      }
      if (category === 'Dataset Consistency') {
        return {
          url: baseUrl + '02-common-principles.html#definitions',
          label: 'BIDS principles'
        };
      }
      
      // Default to main BIDS spec
      return {
        url: baseUrl,
        label: 'BIDS spec'
      };
    },

    inferIssueLevel: function(issue, path) {
      var p = this.normalizeIssuePath((issue && issue.file) || path || '');
      if (!p) return 'file';

      var datasetFiles = {
        'README': true,
        'CHANGES': true,
        'dataset_description.json': true,
        'participants.tsv': true,
        'participants.json': true
      };
      if (datasetFiles[p]) return 'dataset';
      if (/^sub-[^/]+$/i.test(p)) return 'subject';
      if (/^sub-[^/]+\/ses-[^/]+$/i.test(p)) return 'session';
      return 'file';
    },
    
    toggleIssueDetails: function(rowId) {
      console.log('[BIDSBrowser] toggleIssueDetails called with rowId:', rowId);
      var detailsRow = document.getElementById('issue-details-' + rowId);
      console.log('[BIDSBrowser] Found details row:', !!detailsRow);
      if (detailsRow) {
        if (detailsRow.style.display === 'none' || detailsRow.style.display === '') {
          detailsRow.style.display = 'table-row';
          console.log('[BIDSBrowser] Showing details row');
        } else {
          detailsRow.style.display = 'none';
          console.log('[BIDSBrowser] Hiding details row');
        }
      } else {
        console.warn('[BIDSBrowser] Details row not found with ID: issue-details-' + rowId);
      }
    },
    
    markIssueOK: function(rowId, issueIndex) {
      var self = this;
      console.log('[BIDSBrowser] markIssueOK called with rowId:', rowId, 'issueIndex:', issueIndex);
      
      // The rowId is sanitized, need to find the actual file path
      // Search for the file with this rowId by looking at rendered DOM
      var row = document.getElementById('row-' + rowId);
      if (!row) {
        alert('Could not find item row. Please refresh and try again.');
        return;
      }
      
      // Find the file path from the BIDSBrowser's item list
      var filePath = null;
      for (var i = 0; i < self.flatList.length; i++) {
        if (self.sanitizeId(self.flatList[i].path) === rowId) {
          filePath = self.flatList[i].path;
          break;
        }
      }
      
      if (!filePath) {
        alert('Could not locate item path. Please refresh and try again.');
        return;
      }
      
      // Get the actual issue from the fileIssues
      var allIssues = self.fileIssues[filePath] || [];
      if (issueIndex >= allIssues.length) {
        alert('Issue not found. Please refresh and try again.');
        return;
      }
      
      var issue = allIssues[issueIndex];
      
      // Store acknowledged issues with full details in localStorage
      var acknowledgedIssues = JSON.parse(localStorage.getItem('acknowledgedQAIssues') || '{}');
      if (!acknowledgedIssues[filePath]) {
        acknowledgedIssues[filePath] = [];
      }
      
      // Create acknowledged issue object with full details
      var acknowledgedIssue = {
        index: issueIndex,
        issue: issue.issue || 'Unknown issue',
        category: issue.category || 'Other',
        severity: issue.severity || 'info',
        suggestion: issue.suggestion || '',
        timestamp: new Date().toISOString()
      };
      
      acknowledgedIssues[filePath].push(acknowledgedIssue);
      localStorage.setItem('acknowledgedQAIssues', JSON.stringify(acknowledgedIssues));
      
      console.log('[BIDSBrowser] Marked issue as OK for item:', filePath);
      
      // Persist to server
      self.persistAcknowledgedIssues(acknowledgedIssues);
      
      // Refresh the browser to hide the acknowledged issue
      var container = document.getElementById('bidsBrowserContainer');
      if (container) {
        self.renderBrowser(container);
        console.log('[BIDSBrowser] Browser refreshed after acknowledging issue');
      }
    },
    
    dismissIssueFromPanel: function(issueIndex) {
      // Dismiss issue directly from the detail panel without navigating to file
      var self = this;
      console.log('[BIDSBrowser] Dismissing issue from panel:', issueIndex);
      
      // Find the issue and get its file path
      var issueCount = 0;
      for (var path in self.fileIssues) {
        var issueInfo = self.getFileIssues(path);
        for (var i = 0; i < issueInfo.issues.length; i++) {
          if (issueCount === issueIndex) {
            // Found the issue - mark it as OK
            var originalIndex = issueInfo.issues[i].originalIndex !== undefined ? issueInfo.issues[i].originalIndex : i;
            self._markIssueAsOK(path, originalIndex);
            return;
          }
          issueCount++;
        }
      }
    },

    /**
     * Show modal dialog to get mandatory note for marking issue as OK
     * @returns {Promise<string>} Note text if confirmed, empty string if cancelled
     */
    _showActionNoteModal: function() {
      return new Promise(function(resolve) {
        var modal = document.getElementById('actionNoteModal');
        var noteInput = document.getElementById('actionNoteInput');
        var confirmBtn = document.getElementById('actionNoteConfirm');
        var cancelBtn = document.getElementById('actionNoteCancel');
        
        if (!modal || !noteInput || !confirmBtn || !cancelBtn) {
          console.error('[BIDSBrowser] Action note modal elements not found');
          resolve('');
          return;
        }
        
        // Clear and focus the input
        noteInput.value = '';
        noteInput.focus();
        
        // Initially disable confirm button
        confirmBtn.disabled = true;
        
        // Enable/disable confirm button based on input
        var updateConfirmButton = function() {
          confirmBtn.disabled = !noteInput.value.trim();
        };
        
        noteInput.addEventListener('input', updateConfirmButton);
        
        // Confirm handler
        var handleConfirm = function() {
          var note = noteInput.value.trim();
          modal.classList.add('hidden');
          modal.setAttribute('aria-hidden', 'true');
          cleanup();
          resolve(note || '');
        };
        
        // Cancel handler
        var handleCancel = function() {
          modal.classList.add('hidden');
          modal.setAttribute('aria-hidden', 'true');
          cleanup();
          resolve('');
        };
        
        // Cleanup event listeners
        var cleanup = function() {
          noteInput.removeEventListener('input', updateConfirmButton);
          confirmBtn.removeEventListener('click', handleConfirm);
          cancelBtn.removeEventListener('click', handleCancel);
          document.removeEventListener('keydown', handleEscape);
        };
        
        // Escape key handler
        var handleEscape = function(e) {
          if (e.key === 'Escape') {
            handleCancel();
          }
        };
        
        // Show modal
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        
        // Attach event listeners
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        document.addEventListener('keydown', handleEscape);
      });
    },
    
    _markIssueAsOK: async function(filePath, issueIndex) {
      // Helper to mark issue as OK with mandatory note
      var self = this;
      
      // Show modal to get mandatory note
      var note = await this._showActionNoteModal();
      
      if (!note) {
        // User cancelled
        console.log('[BIDSBrowser] User cancelled action');
        return;
      }

      // Reuse AppQA persistence flow so actions are written to bids_validation.json.
      var issueRowId = 'issue-row-' + btoa(filePath).replace(/[^a-z0-9]/gi, '') + '-' + issueIndex;
      if (window.AppQA && typeof window.AppQA.markFileAsResolvedWithNote === 'function') {
        await window.AppQA.markFileAsResolvedWithNote(filePath, 'Marked as OK', issueRowId, note);
        return;
      }
      
      // Find and animate the row
      var rowElement = document.getElementById(issueRowId);
      
      // Animate row success
      if (rowElement) {
        rowElement.classList.add('file-row-success');
      }
      
      var allIssues = self.fileIssues[filePath] || [];
      if (issueIndex >= allIssues.length) {
        console.warn('[BIDSBrowser] Issue index not found:', issueIndex);
        return;
      }
      
      var issue = allIssues[issueIndex];
      
      // Store acknowledged issues with full details in localStorage
      var acknowledgedIssues = JSON.parse(localStorage.getItem('acknowledgedQAIssues') || '{}');
      if (!acknowledgedIssues[filePath]) {
        acknowledgedIssues[filePath] = [];
      }
      
      // Create acknowledged issue object with full details and note
      var acknowledgedIssue = {
        index: issueIndex,
        issue: issue.issue || 'Unknown issue',
        category: issue.category || 'Other',
        severity: issue.severity || 'info',
        suggestion: issue.suggestion || '',
        note: note,
        timestamp: new Date().toISOString()
      };
      
      acknowledgedIssues[filePath].push(acknowledgedIssue);
      localStorage.setItem('acknowledgedQAIssues', JSON.stringify(acknowledgedIssues));
      
      console.log('[BIDSBrowser] Marked issue as OK for item:', filePath, 'with note:', note);
      
      // Persist to server
      self.persistAcknowledgedIssues(acknowledgedIssues);
      
      // Remove and fade out after animation
      if (rowElement) {
        setTimeout(function() {
          rowElement.classList.remove('file-row-success');
          rowElement.classList.add('file-row-removing');
          
          // Refresh the browser after fade out
          setTimeout(function() {
            var container = document.getElementById('bidsBrowserContainer');
            if (container) {
              self.renderBrowser(container);
              console.log('[BIDSBrowser] Browser refreshed after dismissing issue');
            }
          }, 600);
        }, 600);
      } else {
        // No animation, refresh immediately
        var container = document.getElementById('bidsBrowserContainer');
        if (container) {
          self.renderBrowser(container);
          console.log('[BIDSBrowser] Browser refreshed after dismissing issue');
        }
      }
    },
    
    persistAcknowledgedIssues: function(acknowledgedIssues) {
      // Save acknowledged issues to server
      var configPayload = (window.AppConfig && typeof window.AppConfig.buildJobPayload === 'function')
        ? window.AppConfig.buildJobPayload()
        : null;
      
      if (!configPayload) {
        console.warn('[BIDSBrowser] No config available to persist acknowledged issues');
        return;
      }
      
      fetch('/api/qa/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: configPayload,
          acknowledged_issues: acknowledgedIssues
        })
      })
      .then(function(response) { return response.json(); })
      .then(function(result) {
        if (result.success) {
          console.log('[BIDSBrowser] Acknowledged issues persisted to server:', result.acknowledged_count);
        } else {
          console.warn('[BIDSBrowser] Failed to persist acknowledged issues:', result.error);
        }
      })
      .catch(function(error) {
        console.error('[BIDSBrowser] Error persisting acknowledged issues:', error);
      });
    },
    
    viewInEditor: function(filePath, issuePath, issueText) {
      var targetPath = issuePath || filePath || '';
      var text = issueText || '';
      console.log('[BIDSBrowser] View in editor requested for:', targetPath, 'issue:', text);

      // Switch to Editor tab/view
      var editorTab = document.getElementById('nav-editor');
      if (editorTab) editorTab.click();

      // Ensure editor table is loaded if not already
      if (window.AppEditor && typeof window.AppEditor.ensureLoaded === 'function') {
        window.AppEditor.ensureLoaded();
      } else {
        var tableContainer = document.getElementById('tableContainer');
        var hasTable = !!(tableContainer && tableContainer.querySelector('table'));
        if (!hasTable) {
          var loadBtn = document.getElementById('loadTableBtn');
          if (loadBtn) loadBtn.click();
        }
      }

      // Extract filters from path + issue text, removing prefix keywords
      var subjectMatch = targetPath.match(/(sub-[^_\/]+)/);
      var sessionMatch = targetPath.match(/(ses-[^_\/]+)/);
      var taskMatch = targetPath.match(/(task-[^_\/]+)/);

      var subject = subjectMatch ? subjectMatch[1].replace(/^sub-/, '') : '';
      var session = sessionMatch ? sessionMatch[1].replace(/^ses-/, '') : '';
      // Only filter on task if it exists in path, NOT on missing tasks mentioned in issue
      // (filtering to a missing task value won't show any rows)
      var task = taskMatch ? taskMatch[1].replace(/^task-/, '') : '';

      var filters = {
        subject: subject,
        session: session,
        task: task
      };

      // Apply filters after editor load settles
      var applyWithRetry = function(tries) {
        tries = tries || 0;
        var ready = !!(document.getElementById('tableContainer') && document.getElementById('tableContainer').querySelector('table'));
        if (!ready && tries < 8) {
          setTimeout(function() { applyWithRetry(tries + 1); }, 250);
          return;
        }

        if (window.AppEditor && typeof window.AppEditor.setIssueFilters === 'function') {
          window.AppEditor.setIssueFilters(filters);
          console.log('[BIDSBrowser] Applied issue filters in editor:', filters);
        }
      };

      setTimeout(function() { applyWithRetry(0); }, 250);
    }
  };
  
  window.BIDSBrowser = BIDSBrowser;
  console.log('BIDSBrowser loaded with methods:', Object.keys(BIDSBrowser).filter(function(k) { return typeof BIDSBrowser[k] === 'function'; }));
})();
