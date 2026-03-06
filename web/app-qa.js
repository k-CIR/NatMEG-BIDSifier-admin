// QA Analysis module — handles post-conversion QA result display and interaction
// Analyzes completed BIDS conversions for dataset-level consistency issues:
//   - Missing sessions for subjects
//   - Incomplete task coverage
//   - Metadata inconsistencies
//   - BIDS compliance validation
(function () {
  window.AppQA = window.AppQA || {};

  // Store current QA results
  let currentQAResults = null;

  // Store current validation result and saved actions for action buttons
  let currentValidationResult = null;
  let currentSavedActions = {};
  let currentActiveIssues = [];
  // State tracking
  let invalidFilesTableExpanded = true;  // For renderInvalidFilesTable legacy function
  let fileIssuesExpanded = false;        // For new split tables - start collapsed
  let structuralIssuesExpanded = false;  // For new split tables - start collapsed

  function _dbg(msg, obj) {
    try {
      if (typeof window !== 'undefined' && window.APP_DEBUG) {
        console.debug('[AppQA] ' + msg, obj ?? '');
      }
    } catch (e) {}
  }

  function normalizeActionPath(path) {
    return String(path || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  function buildEntryKeySet(entry) {
    const keys = new Set();
    const filePath = entry['BIDS File'] || entry.file || '';
    const sourcePath = entry['Source File'] || entry.source_file || '';
    const fileNorm = normalizeActionPath(filePath);
    const sourceNorm = normalizeActionPath(sourcePath);

    if (fileNorm) keys.add(fileNorm);
    if (sourceNorm) keys.add(sourceNorm);

    const fileSuffix = fileNorm.includes('/sub-') ? fileNorm.slice(fileNorm.indexOf('/sub-') + 1) : '';
    const sourceSuffix = sourceNorm.includes('/sub-') ? sourceNorm.slice(sourceNorm.indexOf('/sub-') + 1) : '';
    if (fileSuffix) keys.add(fileSuffix);
    if (sourceSuffix) keys.add(sourceSuffix);

    return keys;
  }

  function hasSavedActionForEntry(entry, savedActions = {}) {
    const actionInEntry = String(entry.bids_action || '').trim();
    if (actionInEntry) return true;

    const candidateKeys = buildEntryKeySet(entry);
    for (const key of candidateKeys) {
      const value = savedActions[key];
      if (!value) continue;
      if (typeof value === 'object') {
        if (String(value.action || '').trim()) return true;
      } else if (String(value).trim()) {
        return true;
      }
    }
    return false;
  }

  function getUnresolvedInvalidEntries(validationEntries = [], savedActions = {}) {
    return validationEntries.filter(entry => {
      // Explicitly exclude N/A entries (valid BIDS files with no validation issues)
      const validationStatus = entry['Validated'] || entry.validated;
      const issueText = String(entry['Validation Issue'] || entry.issue || '').trim();
      if (validationStatus === 'N/A' || issueText === 'N/A') {
        return false;
      }
      
      // File-level validation: must be marked as False BIDS (invalid)
      const isInvalidFile = validationStatus === 'False BIDS';
      // QA findings: include dataset-level issues with error/warning severity only
      // (exclude info-level findings, they're just notes)
      const isQAIssue = (entry.type === 'dataset_issue' || entry.bids_level === 'dataset') && 
                        (entry.severity === 'error' || entry.severity === 'warning');
      const hasNoAction = !hasSavedActionForEntry(entry, savedActions);
      // Only show entries that have actual issues, not valid BIDS files or info-level notes
      return (isInvalidFile || isQAIssue) && hasNoAction;
    });
  }

  /**
   * Initialize QA module after DOM is ready
   */
  function init() {
    const validateBtn = document.getElementById('validateBtn');
    
    if (!validateBtn) {
      _dbg('Validate button not found');
      return;
    }

    // Single unified handler for validation (replaces separate QA and validation buttons)
    validateBtn.addEventListener('click', () => runUnifiedValidation());
    
    _dbg('QA module initialized with unified validation');
  }

  /**
   * Run unified validation/QA analysis (combines file compliance and dataset-level QA)
   * This consolidates both runQAAnalysis and runValidationAnalysis into one operation
   */
  async function runUnifiedValidation() {
    const validateBtn = document.getElementById('validateBtn');
    const progressContainer = document.getElementById('reportProgressContainer');
    const progressBar = document.getElementById('reportProgressBar');
    const progressText = document.getElementById('reportProgressText');

    if (!validateBtn) return;

    try {
      validateBtn.disabled = true;
      if (progressContainer) progressContainer.style.display = 'flex';
      if (progressBar) progressBar.style.width = '5%';
      if (progressText) progressText.textContent = 'Validating dataset...';

      // Build payload using same approach as other jobs
      let payload = null;
      try {
        if (window.AppConfig && typeof window.AppConfig.buildJobPayload === 'function') {
          payload = window.AppConfig.buildJobPayload('validate');
        }
      } catch (e) {
        payload = null;
      }

      // Fallback: use inline YAML if no saved path
      if (!payload) {
        const cfgYaml = (window.AppConfig && typeof window.AppConfig.writeFormToYaml === 'function')
          ? window.AppConfig.writeFormToYaml()
          : (document.getElementById('configText')?.value || '');
        
        if (!cfgYaml || !String(cfgYaml).trim()) {
          alert('No configuration loaded. Load or create a config first.');
          validateBtn.disabled = false;
          if (progressContainer) progressContainer.style.display = 'none';
          return;
        }
        payload = { config_yaml: cfgYaml };
      }

      // Step 1: Run validation analysis
      if (progressBar) progressBar.style.width = '25%';
      if (progressText) progressText.textContent = 'Running BIDS validation (file compliance)...';

      const validationResponse = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!validationResponse.ok) {
        const error = await validationResponse.json();
        throw new Error(error.error || 'Validation API error');
      }

      const validationResult = await validationResponse.json();
      _dbg('Validation API response received', { validationResult });
      
      // Check if response has 'BIDS Validation Summary' (actual bids_validation.json schema)
      if (!validationResult['BIDS Validation Summary']) {
        const actualKeys = Object.keys(validationResult);
        console.warn('[UnifiedValidation] Warning: No "BIDS Validation Summary" in response');
        console.warn('[UnifiedValidation] Response contains keys:', actualKeys);
        if (validationResult.stdout) {
          console.warn('[UnifiedValidation] API returned command output:', validationResult.stdout.substring(0, 200));
        }
      }
      
      if (progressBar) progressBar.style.width = '90%';

      // Step 2: Display validation results (QA panel removed)
      // Note: validationResult uses bids_validation.json schema with 'BIDS Validation Summary' and 'Validation Entries'
      displayUnifiedResults(validationResult, null);
      
      if (progressBar) progressBar.style.width = '100%';
      if (progressText) progressText.textContent = 'Validation complete';

      _dbg('Validation complete', { validationResult });

      // Auto-complete progress bar after delay
      setTimeout(() => {
        if (progressContainer) progressContainer.style.display = 'none';
        if (progressBar) progressBar.style.width = '0%';
      }, 2000);

    } catch (err) {
      console.error('[UnifiedValidation] Error:', err);
      if (progressText) progressText.textContent = `Error: ${err.message}`;
      if (progressBar) progressBar.style.width = '0%';
      alert(`Validation failed: ${err.message}`);
    } finally {
      validateBtn.disabled = false;
    }
  }

  /**
   * Display unified validation and QA results together
   */
  async function displayUnifiedResults(validationResult, qaResult) {
    // Load saved actions from backend
    const savedActions = await loadSavedActions();
    
    // Apply actions to validation results (recalculate compliance)
    updateComplianceWithActions(validationResult, savedActions);

    // Display validation summary in left panel
    const summaryPanel = document.getElementById('validationSummaryPanel');
    if (summaryPanel && validationResult) {
      const summary = validationResult['BIDS Validation Summary'] || {};
      const validationEntries = validationResult['Validation Entries'] || [];
      let panelHtml = renderValidationSummary(summary, savedActions, validationEntries);
      summaryPanel.innerHTML = panelHtml;
    }

    // Display Active Issues based on unresolved validation entries (single source of truth)
    renderActiveIssuesFromValidation(validationResult, savedActions);

    // Optional fallback for legacy QA payloads
    if (qaResult && !validationResult?.['Validation Entries']) {
      displayQAFindings(qaResult);
    }

    // Update stats if available
    if (validationResult) {
      updateStatsDisplay(validationResult);
    }

    // Store for later reference
    currentValidationResult = validationResult;
    currentSavedActions = savedActions;
  }

  /**
   * Render validation summary panel
   */
  function renderValidationSummary(summary, savedActions = {}, validationEntries = []) {
    // Ensure summary is an object with data
    if (!summary || typeof summary !== 'object' || Object.keys(summary).length === 0) {
      console.warn('[renderValidationSummary] Empty or invalid summary:', summary);
      return `<div style="padding:14px; background:#fef3cd; border:1px solid #ffc107; border-radius:6px; color:#856404; text-align:center;">
        <div style="font-weight:600; margin-bottom:6px;">⚠️ Validation Results Incomplete</div>
        <div style="font-size:11px; line-height:1.5;">
          Could not parse validation results. Check:
          <ul style="margin:6px 0; padding:0 0 0 20px; text-align:left;">
            <li><strong>Browser console</strong> for detailed error messages</li>
            <li><strong>Server logs</strong> for validation API errors (grep for "[Validation API]")</li>
            <li><strong>File location</strong> - verify bids_validation.json exists in logs directory</li>
            <li><strong>Response structure</strong> - check if schema normalization is working</li>
          </ul>
        </div>
      </div>`;
    }

    // Parse counts - support both legacy flat summary and nested bids_validation summary
    const fileValidation = summary.file_validation || {};
    let invalidCount = parseInt(summary['Invalid BIDS Files'] ?? fileValidation.invalid_bids, 10) || 0;
    let totalCount = parseInt(summary['Total Files'] ?? fileValidation.total_files, 10) || 0;
    let complianceRate = parseFloat(summary['Compliance Rate (%)'] ?? fileValidation.compliance_rate, 10) || 0;

    // Prefer entry-derived file counts when available so N/A issue rows are excluded from summary,
    // matching the active issue list behavior.
    if (validationEntries.length > 0) {
      const invalidFileEntries = validationEntries.filter(entry => {
        const validationStatus = entry['Validated'] || entry.validated;
        const issueText = String(entry['Validation Issue'] || entry.issue || '').trim();
        return validationStatus === 'False BIDS' && issueText !== 'N/A';
      });

      invalidCount = invalidFileEntries.length;

      if (!totalCount) {
        totalCount = validationEntries.length;
      }

      complianceRate = totalCount > 0 ? ((totalCount - invalidCount) / totalCount) * 100 : 0;
    }
    
    // Calculate unresolved invalid files (those without saved actions)
    let unresolvedInvalid = invalidCount;
    let userActionsApplied = 0;
    
    if (validationEntries.length > 0) {
      // Count unresolved invalid file entries only (exclude dataset issues).
      unresolvedInvalid = validationEntries.filter(entry => {
        const validationStatus = entry['Validated'] || entry.validated;
        const issueText = String(entry['Validation Issue'] || entry.issue || '').trim();
        const isInvalidFile = validationStatus === 'False BIDS' && issueText !== 'N/A';
        return isInvalidFile && !hasSavedActionForEntry(entry, savedActions);
      }).length;
      userActionsApplied = Object.keys(savedActions).length;
    } else {
      // Fallback: use backend values if no entries
      let resolvedInvalid = parseInt(summary['Resolved Invalid BIDS Files'], 10);
      if (!isNaN(resolvedInvalid)) {
        unresolvedInvalid = resolvedInvalid;
        userActionsApplied = parseInt(summary['User Actions Applied'], 10) || 0;
      }
    }
    
    // Calculate resolved compliance
    const resolvedValidCount = totalCount - unresolvedInvalid;
    const resolvedCompliance = totalCount > 0 ? (resolvedValidCount / totalCount) * 100 : complianceRate;
    
    const validationIssues = summary['Validation Issues'] || (fileValidation.issues_by_type ? { issues: fileValidation.issues_by_type } : null);
    const conversionStatus = summary['Conversion Status'] || summary.conversion_status || 'Unknown';

    // Debug logging
    _dbg('renderValidationSummary', { 
      invalidCount, 
      unresolvedInvalid,
      totalCount, 
      complianceRate,
      resolvedCompliance,
      userActionsApplied,
      hasIssues: !!validationIssues,
      keys: Object.keys(summary)
    });

    // Check if actually all files are valid (zero invalid files)
    const allValid = invalidCount === 0 && totalCount > 0;

    if (allValid) {
      return `<div style="padding:16px; color:#4caf50; background:linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%); border-radius:6px; border:1px solid #81c784; display:flex; align-items:center; gap:12px;">
        <span style="font-size:28px;">✓</span>
        <div>
          <div style="font-weight:600; font-size:14px;">All files comply with BIDS</div>
          <div style="font-size:12px; opacity:0.9;">${totalCount} file(s) with 100% compliance</div>
        </div>
      </div>`;
    }

    // Extract structural issues from validation entries
    const structuralIssues = validationEntries.filter(e => {
      const level = e.bids_level || 'file';
      const type = e.type || '';
      return level === 'dataset' || type === 'dataset_issue';
    });
    
    // Get QA analysis summary
    const qaAnalysis = summary.qa_analysis || {};
    const structuralErrorCount = structuralIssues.filter(e => e.severity === 'error').length;
    const structuralWarningCount = structuralIssues.filter(e => e.severity === 'warning').length;
    const structuralTotalCount = structuralIssues.length;
    
    // Count structural issue types
    const structuralIssueTypes = {};
    structuralIssues.forEach(issue => {
      const issueText = issue['Validation Issue'] || issue.issue || 'Unknown issue';
      // Extract key phrase from issue (first sentence or up to first punctuation)
      const keyPhrase = issueText.split(/[:.]/)[0].trim();
      structuralIssueTypes[keyPhrase] = (structuralIssueTypes[keyPhrase] || 0) + 1;
    });
    
    // Container for side-by-side summaries
    let html = `<div style="display:flex; gap:12px; flex-wrap:wrap;">`;
    
    // Show warning if there are invalid files or conversion is incomplete
    if (invalidCount > 0 || conversionStatus === 'Incomplete') {
      const validCount = totalCount - invalidCount;
      const complianceText = complianceRate >= 95 ? 'Good' : complianceRate >= 80 ? 'Fair' : 'Poor';
      const complianceColor = complianceRate >= 95 ? '#28a745' : complianceRate >= 80 ? '#ffc107' : '#dc3545';
      
      html += `<div style="flex:1; min-width:300px; padding:12px 14px; background:#fff3cd; border:1px solid #ffc107; border-radius:6px; margin-bottom:12px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
          <span style="font-size:20px;">⚠️</span>
          <div style="flex:1;">
            <div style="font-weight:600; color:#856404; font-size:13px;">${invalidCount} invalid file(s) — BIDS compliance: <span style="color:${complianceColor}; font-size:14px;">${complianceRate.toFixed(1)}%</span></div>
            <div style="font-size:11px; color:#714d1a; margin-top:3px;">
              ${validCount}/${totalCount} files valid • <strong>${complianceText} compliance</strong> • Status: ${conversionStatus}
            </div>
          </div>
        </div>`;
      
      // Add common file validation issues
      if (validationIssues && validationIssues.issues && Object.keys(validationIssues.issues).length > 0) {
        html += `<div style="font-size:12px; color:#714d1a; margin-top:10px; padding-top:10px; border-top:1px solid #ffc107;">
          <strong style="display:block; margin-bottom:6px;">Common validation issues:</strong>
          <ul style="margin:0; padding:0; margin-left:16px; list-style:disc;">`;
        
        Object.entries(validationIssues.issues).forEach(([issue, count]) => {
          html += `<li style="margin-bottom:3px; font-size:11px;">${issue} <span style="color:#d88a1f;">(${count})</span></li>`;
        });

        html += `</ul></div>`;
      }
      
      html += `<div style="margin-top:10px; padding-top:10px; border-top:1px solid #ffc107; font-size:11px;">
        📖 <a href="https://bids.neuroimaging.io/getting_started/index.html" target="_blank" style="color:#0066cc;">BIDS Getting Started</a> | 
        <a href="https://bids-specification.readthedocs.io/en/stable/modality-specific-files/magnetoencephalography.html" target="_blank" style="color:#0066cc;">MEG Specification</a>
      </div></div>`;
    }
    
    // Add structural issues summary card if any exist
    if (structuralTotalCount > 0) {
      const structStatusText = structuralErrorCount > 0 ? 'Errors present' : structuralWarningCount > 0 ? 'Warnings present' : 'Issues found';
      const structStatusColor = structuralErrorCount > 0 ? '#dc3545' : structuralWarningCount > 0 ? '#ffc107' : '#28a745';
      
      html += `<div style="flex:1; min-width:300px; padding:12px 14px; background:#fff3cd; border:1px solid #ffc107; border-radius:6px; margin-bottom:12px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
          <span style="font-size:20px;">🏗️</span>
          <div style="flex:1;">
            <div style="font-weight:600; color:#856404; font-size:13px;">${structuralTotalCount} structural issue(s) — Dataset-level validation</div>
            <div style="font-size:11px; color:#714d1a; margin-top:3px;">
              ${structuralErrorCount} error${structuralErrorCount !== 1 ? 's' : ''}, ${structuralWarningCount} warning${structuralWarningCount !== 1 ? 's' : ''} • <strong>${structStatusText}</strong>
            </div>
          </div>
        </div>`;
      
      if (Object.keys(structuralIssueTypes).length > 0) {
        html += `<div style="font-size:12px; color:#714d1a; margin-top:10px; padding-top:10px; border-top:1px solid #ffc107;">
          <strong style="display:block; margin-bottom:6px;">Common structural issues:</strong>
          <ul style="margin:0; padding:0; margin-left:16px; list-style:disc;">`;
        
        // Show top 5 most common structural issues
        const sortedIssues = Object.entries(structuralIssueTypes)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        
        sortedIssues.forEach(([issue, count]) => {
          html += `<li style="margin-bottom:3px; font-size:11px;">${issue} <span style="color:#d88a1f;">(${count})</span></li>`;
        });

        html += `</ul></div>`;
      }
      
      html += `<div style="margin-top:10px; padding-top:10px; border-top:1px solid #ffc107; font-size:11px;">
        📖 <a href="https://bids.neuroimaging.io/getting_started/index.html" target="_blank" style="color:#0066cc;">BIDS Getting Started</a> | 
        <a href="https://bids-specification.readthedocs.io/en/stable/modality-specific-files/magnetoencephalography.html" target="_blank" style="color:#0066cc;">MEG Specification</a>
      </div></div>`;
    }
    
    html += `</div>`; // Close side-by-side container

    // Show resolved compliance if user actions have been applied
    if (userActionsApplied > 0) {
      const resolvedColor = resolvedCompliance >= 95 ? '#28a745' : resolvedCompliance >= 80 ? '#ffc107' : '#dc3545';
      const resolvedText = resolvedCompliance >= 95 ? 'Good' : resolvedCompliance >= 80 ? 'Fair' : 'Poor';
      
      html += `<div style="margin-top:0; margin-bottom:12px; padding:10px; background:#e8f5e9; border:1px solid #81c784; border-radius:4px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="font-size:16px;">✓</span>
          <div>
            <div style="font-weight:600; color:#2e7d32; font-size:12px;">With user actions applied:</div>
            <div style="font-size:11px; color:#558b2f; margin-top:3px;">
              <strong>${resolvedValidCount}/${totalCount}</strong> files valid or checked • Compliance: <span style="color:${resolvedColor}; font-weight:bold;">${resolvedCompliance.toFixed(1)}%</span> • <strong>${userActionsApplied}</strong> action(s) applied
            </div>
          </div>
        </div>
      </div>`;
    }

    if (validationIssues && validationIssues.remediation && Object.keys(validationIssues.remediation).length > 0) {
      html += `<div style="margin-bottom:12px; padding:12px; background:#e3f2fd; border:1px solid #90caf9; border-radius:4px;">
        <strong style="display:block; margin-bottom:8px; color:#1565c0; font-size:12px;">💡 Remediation steps:</strong>
        <ul style="margin:0; padding:0; margin-left:16px; list-style:disc;">`;
      
      Object.entries(validationIssues.remediation).forEach(([issue, remedy]) => {
        html += `<li style="margin-bottom:6px; font-size:11px; color:#1976d2;"><strong>${issue}:</strong> <span style="color:#555;">${remedy}</span></li>`;
      });

      html += `</ul></div>`;
    }

    return html;

    // Fallback if no data available
    return `<div style="padding:12px; background:#f5f5f5; border:1px solid #ddd; border-radius:6px; text-align:center; color:#999; font-size:12px;">
      No validation data available
    </div>`;
  }

  /**
   * Display QA findings in right panel
   */
  function displayQAFindings(qaResult) {
    const container = document.getElementById('qaResultsContainer');
    if (!container) return;

    const findings = qaResult.findings || [];
    let totalIssues = 0;
    let errorCount = 0;
    let warningCount = 0;

    findings.forEach(category => {
      const issues = category.issues || [];
      issues.forEach(issue => {
        totalIssues++;
        if (issue.severity === 'error') errorCount++;
        else if (issue.severity === 'warning') warningCount++;
      });
    });

    // Update display with total issue count in header

    let html = '';
    if (totalIssues === 0) {
      html = `<div style="padding:16px; text-align:center; color:#4caf50; background:#e8f5e9;">
        <div style="font-size:24px; margin-bottom:4px;">✓</div>
        <div style="font-weight:600;">All QA checks passed</div>
        <div style="font-size:12px; margin-top:4px;">Dataset consistency verified.</div>
      </div>`;
    } else {
      html = `<div style="padding:12px; background:#e3f2fd; border-left:4px solid #2196f3; margin-bottom:12px;">
        <strong style="font-size:13px;">QA Findings: ${totalIssues} issue${totalIssues !== 1 ? 's' : ''}</strong>
        <div style="font-size:11px; margin-top:6px; color:#1976d2;">
          ${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warningCount} warning${warningCount !== 1 ? 's' : ''}
        </div>
      </div>`;

      let issueIndex = 0;
      findings.forEach(category => {
        const issues = category.issues || [];
        if (issues.length === 0) return;

        html += `<div style="margin-bottom:12px;">
          <div style="font-weight:600; font-size:12px; margin-bottom:6px; color:#333;">${category.category}</div>`;

        issues.forEach((issue, i) => {
          const issueId = 'qa-issue-' + issueIndex;
          const bgColor = issue.severity === 'error' ? '#ffebee' : issue.severity === 'warning' ? '#fff8e1' : '#e3f2fd';
          const borderColor = issue.severity === 'error' ? '#d32f2f' : issue.severity === 'warning' ? '#f57f17' : '#1976d2';
          const actionButtonStyle = issue.severity === 'error' ? '#d32f2f' : '#ff9800';
          
          html += `<div id="${issueId}" style="padding:8px; background:${bgColor}; border-left:3px solid ${borderColor}; border-radius:3px; font-size:11px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center; transition:all 0.3s ease;">
            <div>
              <strong>${issue.severity.toUpperCase()}:</strong> ${issue.issue}
            </div>
            <button onclick="AppQA.markQAIssueAsResolved(${issueIndex}, '${issueId}')" class="issue-action-btn" style="padding:4px 10px; font-size:9px; background:${actionButtonStyle}; color:white; border:none; border-radius:3px; cursor:pointer; font-weight:600; white-space:nowrap; flex-shrink:0; margin-left:8px;">✓ Acknowledge</button>
          </div>`;
          issueIndex++;
        });

        html += `</div>`;
      });
    }

    container.innerHTML = html;
  }

  /**
   * Update stats display from validation results
   */
  function updateStatsDisplay(validationResult) {
    const validationEntries = validationResult['Validation Entries'] || [];
    
    // Debug: log what we received
    _dbg('updateStatsDisplay called', { 
      hasValidationEntries: !!validationResult['Validation Entries'],
      entriesCount: validationEntries.length,
      firstEntry: validationEntries[0],
      summary: validationResult['BIDS Validation Summary']
    });
    
    if (validationEntries.length === 0) {
      console.warn('[updateStatsDisplay] No validation entries to process. Keys in result:', Object.keys(validationResult));
      return;
    }

    const subjects = new Set();
    const sessions = new Set();
    const tasks = new Set();

    validationEntries.forEach(entry => {
      const participant = entry.Participant || entry.participant;
      const session = entry.Session || entry.session;
      const task = entry.Task || entry.task;
      if (participant) subjects.add(participant);
      if (session) sessions.add(session);
      if (task) tasks.add(task);
    });

    const statSubjects = document.getElementById('stat-subjects');
    const statSessions = document.getElementById('stat-sessions');
    const statTasks = document.getElementById('stat-tasks');
    const statsContainer = document.getElementById('statsContainer');

    if (statSubjects) statSubjects.textContent = subjects.size.toString();
    if (statSessions) statSessions.textContent = sessions.size.toString();
    if (statTasks) statTasks.textContent = tasks.size.toString();
    if (statsContainer) {
      statsContainer.classList.remove('stats-hidden');
    }
  }

  /**
   * Save a BIDS file action to the backend (persist to file)
   * @param {string} bidsFile - Full path to BIDS file
   * @param {string} action - Action type: "Marked as OK", "Ignored", or empty to clear
   * @param {string} note - Optional user note
   */
  async function saveAction(bidsFile, action, note = '') {
    try {
      // Build payload with current config
      let payload = null;
      try {
        if (window.AppConfig && typeof window.AppConfig.buildJobPayload === 'function') {
          payload = window.AppConfig.buildJobPayload('validate');
        }
      } catch (e) {
        payload = null;
      }

      if (!payload) {
        const cfgYaml = (window.AppConfig && typeof window.AppConfig.writeFormToYaml === 'function')
          ? window.AppConfig.writeFormToYaml()
          : (document.getElementById('configText')?.value || '');
        payload = { config_yaml: cfgYaml };
      }

      // Prepare actions object
      const actions = {};
      if (action && action.trim()) {
        actions[bidsFile] = {
          action: action,
          timestamp: new Date().toISOString(),
          note: note
        };
      }

      // Send to backend
      const response = await fetch('/api/bids/actions/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: payload,
          actions: actions
        })
      });

      if (!response.ok) {
        const error = await response.json();
        console.error('[BIDS Actions] Save failed:', error);
        return false;
      }

      const result = await response.json();
      _dbg('Action saved', { bidsFile, action, result });
      return true;

    } catch (err) {
      console.error('[BIDS Actions] Save error:', err);
      return false;
    }
  }

  /**
   * Load all saved BIDS actions from backend
   * @return {Object} actions keyed by BIDS file path
   */
  async function loadSavedActions() {
    try {
      // Build payload with current config
      let payload = null;
      try {
        if (window.AppConfig && typeof window.AppConfig.buildJobPayload === 'function') {
          payload = window.AppConfig.buildJobPayload('validate');
        }
      } catch (e) {
        payload = null;
      }

      if (!payload) {
        const cfgYaml = (window.AppConfig && typeof window.AppConfig.writeFormToYaml === 'function')
          ? window.AppConfig.writeFormToYaml()
          : (document.getElementById('configText')?.value || '');
        payload = { config_yaml: cfgYaml };
      }

      // Load from backend
      const response = await fetch('/api/bids/actions/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        console.warn('[BIDS Actions] Load failed, returning empty actions');
        return {};
      }

      const result = await response.json();
      const actions = result.actions || {};
      _dbg('Actions loaded', { count: result.count, actions });
      return actions;

    } catch (err) {
      console.error('[BIDS Actions] Load error:', err);
      return {};
    }
  }

  /**
   * Update compliance statistics based on saved user actions
   * Recalculates resolved compliance by excluding files marked as "OK"
   */
  function updateComplianceWithActions(validationResult, savedActions) {
    if (!validationResult || !validationResult['BIDS Validation Summary'] || !savedActions || Object.keys(savedActions).length === 0) {
      return; // No updates needed
    }

    const summary = validationResult['BIDS Validation Summary'];
    const validationEntries = validationResult['Validation Entries'] || [];
    
    // Count files marked as OK
    let markedOkCount = 0;
    validationEntries.forEach(entry => {
      const bidsFile = entry['BIDS File'] || entry.file || '';
      if (bidsFile && savedActions[bidsFile]) {
        const actionData = savedActions[bidsFile];
        if (typeof actionData === 'object' && actionData.action === 'Marked as OK') {
          markedOkCount++;
        }
      }
    });

    if (markedOkCount > 0) {
      const totalFiles = summary['Total Files'] || 0;
      const originalInvalid = summary['Invalid BIDS Files'] || 0;
      const resolvedInvalid = Math.max(0, originalInvalid - markedOkCount);
      const resolvedCompliance = totalFiles > 0 ? (((totalFiles - resolvedInvalid) / totalFiles) * 100).toFixed(1) : 0;

      // Update summary with resolved stats
      validationResult['BIDS Validation Summary']['Resolved Invalid BIDS Files'] = resolvedInvalid;
      validationResult['BIDS Validation Summary']['Resolved Compliance Rate (%)'] = parseFloat(resolvedCompliance);
      validationResult['BIDS Validation Summary']['User Actions Applied'] = markedOkCount;

      _dbg('Compliance updated with actions', {
        originalInvalid,
        resolvedInvalid,
        markedOkCount,
        resolvedCompliance
      });
    }
  }

  /**
   * Run QA analysis via API
   */
  async function runQAAnalysis() {
    const qaBtn = document.getElementById('qaBtn');
    const progressBar = document.getElementById('reportProgressBar');
    const progressText = document.getElementById('reportProgressText');

    if (!qaBtn) return;

    try {
      qaBtn.disabled = true;
      if (progressBar) progressBar.style.width = '10%';
      if (progressText) progressText.textContent = 'Running post-conversion QA analysis...';

      // Build payload using same approach as other jobs
      let payload = null;
      try {
        if (window.AppConfig && typeof window.AppConfig.buildJobPayload === 'function') {
          payload = window.AppConfig.buildJobPayload('qa');
        }
      } catch (e) {
        payload = null;
      }

      // Fallback: use inline YAML if no saved path
      if (!payload) {
        const cfgYaml = (window.AppConfig && typeof window.AppConfig.writeFormToYaml === 'function')
          ? window.AppConfig.writeFormToYaml()
          : (document.getElementById('configText')?.value || '');
        
        if (!cfgYaml || !String(cfgYaml).trim()) {
          alert('No configuration loaded. Load or create a config first.');
          qaBtn.disabled = false;
          if (progressText) progressText.textContent = 'Idle';
          return;
        }
        payload = { config_yaml: cfgYaml };
      }

      // Call QA API
      const response = await fetch('/api/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (progressBar) progressBar.style.width = '50%';

      const result = await response.json();
      
      console.log('[QA] Raw API response:', result);
      console.log('[QA] Response keys:', Object.keys(result));
      console.log('[QA] Response.findings:', result.findings);
      console.log('[QA] Response.summary:', result.summary);
      console.log('[QA] Response.stdout:', result.stdout ? result.stdout.substring(0, 200) : 'N/A');
      _dbg('QA API response', result);

      if (!response.ok) {
        if (progressText) progressText.textContent = 'QA Analysis Error';
        console.error('QA API error:', result);
        
        // Show detailed error message
        let errorMsg = `QA Analysis failed: ${result.error || 'Unknown error'}`;
        if (result.stderr) {
          errorMsg += '\n\nError details:\n' + result.stderr.substring(0, 500);
        }
        alert(errorMsg);
        
        qaBtn.disabled = false;
        if (progressBar) progressBar.style.width = '0%';
        return;
      }

      if (progressBar) progressBar.style.width = '100%';

      // Check if result contains actual QA data or just success message
      let qaResults = result;
      console.log('[QA] Checking result structure - has findings:', !!result.findings, 'has summary:', !!result.summary);
      console.log('[QA] Result keys:', Object.keys(result));
      
      if (result.findings || result.summary) {
        // Process and display QA results directly
        currentQAResults = qaResults;
        console.log('[QA] Displaying structured QA results with', result.findings?.length || 0, 'findings');
        displayQAResults(qaResults);
        _dbg('Displayed structured QA results');
      } else if (result.stdout) {
        // Server returned bidsify output format - QA file might not have been created yet
        console.log('[QA] No structured results found, displaying stdout message');
        console.log('[QA] This might indicate the QA file was not created. Check server logs.');
        displayCompletionMessage(result.stdout);
        _dbg('Displayed stdout completion message');
        
        // Try to reload QA from file after a brief delay
        setTimeout(async () => {
          console.log('[QA] Attempting to load QA results from file...');
          const loaded = await loadQAFromFile(false);
          if (loaded) {
            console.log('[QA] Successfully loaded QA results from file after delay');
          } else {
            console.warn('[QA] Could not load QA file after delay - file may not exist');
          }
        }, 2000);
      } else {
        // Unknown format, try to display anyway
        console.warn('[QA] Unknown result format:', result);
        currentQAResults = result;
        displayQAResults(result);
        _dbg('Displayed unknown format QA results');
      }

      if (progressText) progressText.textContent = 'QA Analysis Complete';
      
      // Auto-hide progress after a delay
      setTimeout(() => {
        if (progressBar) progressBar.style.width = '0%';
        if (progressText) progressText.textContent = 'Idle';
      }, 3000);
      
    } catch (error) {
      _dbg('QA API error', error);
      console.error('QA API call failed:', error);
      alert(`QA API call failed: ${error.message}`);
      if (progressText) progressText.textContent = 'QA Analysis Error';
      if (progressBar) progressBar.style.width = '0%';
    } finally {
      qaBtn.disabled = false;
    }
  }

  /**
   * Display QA results in the Results tab - integrated with BIDS browser
   */
  function displayQAResults(qaResults) {
    console.log('[QA displayQAResults] Called with:', qaResults);
    
    // Send QA results to BIDS browser for integrated display
    if (window.BIDSBrowser && typeof window.BIDSBrowser.setQAResults === 'function') {
      console.log('[QA displayQAResults] Sending QA results to BIDS browser...');
      window.BIDSBrowser.setQAResults(qaResults);
    } else {
      console.warn('[QA displayQAResults] BIDSBrowser.setQAResults not available');
    }
    
    // Get container elements
    const container = document.getElementById('qaResultsContainer');
    const content = document.getElementById('qaResultsContent');
    
    console.log('[QA displayQAResults] Container found:', !!container, 'Content found:', !!content);

    if (!container || !content) {
      console.log('[QA] Container or content not found!');
      return;
    }

    // If no QA results, hide the container entirely
    if (!qaResults || !qaResults.findings) {
      console.log('[QA] No QA results to display, hiding container');
      container.style.display = 'none';
      content.innerHTML = '';
      return;
    }

    // Show container
    container.style.display = 'block';

    // Build simple summary message
    let html = '';
    
    const findings = qaResults.findings || [];
    let totalIssues = 0;
    let errorCount = 0;
    let warningCount = 0;
    
    for (let i = 0; i < findings.length; i++) {
      const issues = findings[i].issues || [];
      totalIssues += issues.length;
      for (let j = 0; j < issues.length; j++) {
        if (issues[j].severity === 'error') errorCount++;
        else if (issues[j].severity === 'warning') warningCount++;
      }
    }
    
    if (totalIssues === 0) {
      html = '<div style="padding:16px; color:#4caf50; font-weight:500; text-align:center; background:linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%); border-radius:6px; border:1px solid #81c784; display:flex; align-items:center; justify-content:center; gap:12px;">' +
        '<span style="font-size:32px;">✓</span>' +
        '<div><div style="font-size:16px; margin-bottom:4px;">All checks passed!</div>' +
        '<div style="font-size:12px; opacity:0.9;">No issues found in the dataset.</div></div>' +
        '</div>';
    } else {
      html = '<div style="padding:12px 16px; background:#e3f2fd; border-left:4px solid #2196f3; border-radius:4px; font-size:13px;">' +
        '<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">' +
        '<span style="font-size:18px;">ℹ️</span>' +
        '<strong style="font-size:14px;">QA Analysis Complete</strong>' +
        '</div>' +
        '<div style="margin-left:26px;">' +
        'Found <strong>' + totalIssues + ' issue' + (totalIssues === 1 ? '' : 's') + '</strong> (' +
        errorCount + ' errors, ' + warningCount + ' warnings).' +
        '<div style="margin-top:8px; padding:8px; background:rgba(255,255,255,0.6); border-radius:3px; font-size:12px;">' +
        '👆 Issues are displayed inline in the <strong>BIDS Browser</strong> above. Click issue indicators (❌/⚠️) to expand details and access action buttons.' +
        '</div>' +
        '</div>' +
        '</div>';
    }

    content.innerHTML = html;
    _dbg('QA results displayed', qaResults);
  }

  /**
   * Display completion message when QA returns stdout format
   */
  function displayCompletionMessage(stdout) {
    const container = document.getElementById('qaResultsContainer');
    const content = document.getElementById('qaResultsContent');

    if (!container || !content) return;

    container.style.display = 'block';

    let html = `
      <div style="display: flex; align-items: flex-start; gap: 12px; padding: 16px; background: linear-gradient(135deg, #e8f5e9 0%, #f1f8f4 100%); border-radius: 8px; margin-bottom: 12px; border-left: 4px solid #4caf50; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
        <div style="font-size: 24px; line-height: 1; margin-top: 2px;">✓</div>
        <div style="flex: 1;">
          <div style="font-weight: 600; font-size: 14px; color: #2e7d32; margin-bottom: 6px;">QA Analysis Completed</div>
          <p style="margin: 0; font-size: 13px; color: #1b5e20; line-height: 1.5;">
            Post-conversion quality analysis ran successfully. Detailed results have been saved.
          </p>
          <div style="margin-top: 10px; padding: 8px 12px; background: rgba(255,255,255,0.7); border-radius: 4px; font-size: 12px; color: #555;">
            <strong style="color: #2e7d32;">📁 Results location:</strong> <code style="background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 11px;">logs/qa_analysis.json</code>
          </div>
        </div>
      </div>
    `;

    if (stdout && stdout.trim()) {
      // Parse stdout for summary info
      const lines = stdout.split('\n').filter(line => line.trim());
      const summaryLines = lines.filter(line => 
        line.includes('issues found') || 
        line.includes('Errors:') || 
        line.includes('Warnings:') ||
        line.includes('No issues detected')
      );

      if (summaryLines.length > 0) {
        html += `
          <div style="padding: 14px; background: #f8f9fa; border-radius: 6px; border: 1px solid #e0e0e0; margin-bottom: 12px;">
            <div style="font-weight: 600; font-size: 13px; color: #333; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 16px;">📊</span> Analysis Summary
            </div>
            <div style="font-family: monospace; font-size: 12px; color: #555; line-height: 1.6;">
              ${summaryLines.map(line => `<div>${line}</div>`).join('')}
            </div>
          </div>
        `;
      }

      html += `
        <details style="margin-top: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 12px; color: #666; padding: 8px; background: #f5f5f5; border-radius: 4px; user-select: none;">
            📋 View Console Output
          </summary>
          <pre style="background: #fafafa; padding: 12px; border-radius: 4px; font-size: 11px; max-height: 300px; overflow: auto; margin-top: 8px; border: 1px solid #e0e0e0; line-height: 1.5;">${stdout}</pre>
        </details>
      `;
    }

    content.innerHTML = html;
  }

  /**
   * Export QA results as JSON
   */
  function exportQAResults() {
    if (!currentQAResults) {
      alert('No QA results to export');
      return;
    }

    const json = JSON.stringify(currentQAResults, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qa_analysis_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Load existing QA results from qa_analysis.json if it exists
   * Called automatically when config is loaded
   */
  async function loadQAFromFile(silent = true) {
    try {
      _dbg('loadQAFromFile called');

      // Get config to determine QA file paths
      const cfgYaml = (window.AppConfig && typeof window.AppConfig.writeFormToYaml === 'function')
        ? window.AppConfig.writeFormToYaml()
        : (document.getElementById('configText')?.value || '');
      
      if (!cfgYaml || !String(cfgYaml).trim()) {
        _dbg('No config available for QA file loading');
        // Clear any existing QA results since no config is loaded
        currentQAResults = null;
        if (window.BIDSBrowser && typeof window.BIDSBrowser.setQAResults === 'function') {
          window.BIDSBrowser.setQAResults(null);
        }
        return false;
      }

      // Parse config to extract paths (simple YAML parsing)
      const parseConfigPath = (yaml, key) => {
        const regex = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm');
        const match = yaml.match(regex);
        return match ? match[1].trim() : '';
      };

      const root = parseConfigPath(cfgYaml, 'Root');
      const name = parseConfigPath(cfgYaml, 'Name');
      const bidsPath = parseConfigPath(cfgYaml, 'BIDS');

      // Build candidate paths for qa_analysis.json
      const candidates = [];
      if (root && name) {
        candidates.push(`${root}/${name}/logs/qa_analysis.json`);
      }
      if (root) {
        candidates.push(`${root}/logs/qa_analysis.json`);
      }
      if (bidsPath) {
        // Try dirname(BIDS)/logs
        const lastSlash = bidsPath.lastIndexOf('/');
        if (lastSlash > 0) {
          const bidsParent = bidsPath.substring(0, lastSlash);
          candidates.push(`${bidsParent}/logs/qa_analysis.json`);
        // Clear any existing QA results
        currentQAResults = null;
        if (window.BIDSBrowser && typeof window.BIDSBrowser.setQAResults === 'function') {
          window.BIDSBrowser.setQAResults(null);
        }
        }
      }

      if (candidates.length === 0) {
        _dbg('Could not determine QA file path from config');
        return false;
      }

      _dbg('Trying QA file candidates:', candidates);

      // Try each candidate path
      for (const qaPath of candidates) {
        try {
          const response = await fetch('/api/read-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: qaPath })
          });

          if (response.ok) {
            const result = await response.json();
            if (result.content) {
              // Parse QA JSON
              const qaResults = JSON.parse(result.content);
              
              if (qaResults && (qaResults.findings || qaResults.summary)) {
                currentQAResults = qaResults;
                _dbg('Loaded existing QA results from:', qaPath);
                displayQAResults(qaResults);
                if (!silent) {
                  console.log('[QA] Successfully loaded existing QA analysis from:', qaPath);
                }
                return true;
              }
            }
          }
        } catch (err) {
          // Try next candidate
          _dbg('Could not load QA from:', qaPath, err.message);
        }
      }

      _dbg('No existing QA file found in any candidate location');
      // Clear any existing QA results since file doesn't exist
      currentQAResults = null;
      if (window.BIDSBrowser && typeof window.BIDSBrowser.setQAResults === 'function') {
        window.BIDSBrowser.setQAResults(null);
      }
      return false;
    } catch (error) {
      _dbg('Error loading QA file:', error);
      if (!silent) {
        console.warn('Error loading existing QA results:', error.message);
      }
      // Clear any existing QA results on error
      currentQAResults = null;
      if (window.BIDSBrowser && typeof window.BIDSBrowser.setQAResults === 'function') {
        window.BIDSBrowser.setQAResults(null);
      }
      return false;
    }
  }

  /**
   * Run unified BIDS validation (file compliance + QA analysis) via API
   */
  async function runValidationAnalysis() {
    const validationBtn = document.getElementById('validateBtn');
    const progressBar = document.getElementById('reportProgressBar');
    const progressText = document.getElementById('reportProgressText');

    if (!validationBtn) return;

    try {
      validationBtn.disabled = true;
      if (progressBar) progressBar.style.width = '10%';
      if (progressText) progressText.textContent = 'Running unified validation analysis...';

      // Build payload using same approach as other jobs
      let payload = null;
      try {
        if (window.AppConfig && typeof window.AppConfig.buildJobPayload === 'function') {
          payload = window.AppConfig.buildJobPayload('validate');
        }
      } catch (e) {
        payload = null;
      }

      // Fallback: use inline YAML if no saved path
      if (!payload) {
        const cfgYaml = (window.AppConfig && typeof window.AppConfig.writeFormToYaml === 'function')
          ? window.AppConfig.writeFormToYaml()
          : (document.getElementById('configText')?.value || '');
        
        if (!cfgYaml || !String(cfgYaml).trim()) {
          alert('No configuration loaded. Load or create a config first.');
          validationBtn.disabled = false;
          if (progressText) progressText.textContent = 'Idle';
          return;
        }
        payload = { config_yaml: cfgYaml };
      }

      // Call Validation API
      const response = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (progressBar) progressBar.style.width = '50%';

      const result = await response.json();
      
      console.log('[Validation] Raw API response:', result);
      console.log('[Validation] Response keys:', Object.keys(result));
      _dbg('Validation API response', result);

      if (!response.ok) {
        if (progressText) progressText.textContent = 'Validation Error';
        console.error('Validation API error:', result);
        
        // Show detailed error message
        let errorMsg = `Validation failed: ${result.error || 'Unknown error'}`;
        if (result.stderr) {
          errorMsg += '\n\nError details:\n' + result.stderr.substring(0, 500);
        }
        alert(errorMsg);
        validationBtn.disabled = false;
        if (progressText) progressText.textContent = 'Idle';
        return;
      }

      if (progressBar) progressBar.style.width = '100%';
      if (progressText) progressText.textContent = 'Validation complete';

      // Store results and display summary
      currentQAResults = result;
      
      // Display validation summary
      const summary = result['BIDS Validation Summary'] || {};
      const entries = result['Validation Entries'] || [];
      
      displayValidationResults({ summary, entries });

      _dbg('Validation results processed', result);
      
      validationBtn.disabled = false;
      if (progressBar) setTimeout(() => { progressBar.style.width = '0%'; }, 1000);

    } catch (err) {
      console.error('[Validation] Unexpected error:', err);
      if (progressText) progressText.textContent = `Error: ${err.message}`;
      validationBtn.disabled = false;
    }
  }

  /**
   * Display validation results in UI
   */
  function displayValidationResults(validationData) {
    const container = document.getElementById('qaResultsContainer');
    const content = document.getElementById('qaResultsContent');

    if (!container || !content) return;

    container.style.display = 'block';

    const summary = validationData.summary || {};
    const entries = validationData.entries || [];
    
    let html = `
      <div style="padding:14px; background: #f0f4ff; border-left:4px solid #2196f3; border-radius:4px; margin-bottom:12px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="font-size:18px;">📋</span>
          <strong style="font-size:14px;">Unified BIDS Validation Complete</strong>
        </div>
        <div style="font-size:13px; margin-left:26px;">
          <div>${summary.overall_status || 'Validation completed'}</div>
          <div style="margin-top:8px; display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:8px;">
            <div style="background:rgba(255,255,255,0.7); padding:8px; border-radius:3px;">
              <div style="font-size:11px; opacity:0.8;">File Validation</div>
              <div style="font-weight:bold; font-size:13px;">${summary.file_validation?.compliance_rate || 0}% compliant</div>
              <div style="font-size:11px; opacity:0.7;">${summary.file_validation?.valid_bids || 0}/${summary.file_validation?.total_files || 0} files</div>
            </div>
            <div style="background:rgba(255,255,255,0.7); padding:8px; border-radius:3px;">
              <div style="font-size:11px; opacity:0.8;">QA Issues</div>
              <div style="font-weight:bold; font-size:13px;">${summary.qa_analysis?.total_issues || 0} issue${(summary.qa_analysis?.total_issues || 0) === 1 ? '' : 's'}</div>
              <div style="font-size:11px; opacity:0.7;">
                ${summary.qa_analysis?.by_severity?.error || 0} errors, 
                ${summary.qa_analysis?.by_severity?.warning || 0} warnings
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    if (entries && entries.length > 0) {
      const errorEntries = entries.filter(e => e.severity === 'error');
      const warningEntries = entries.filter(e => e.severity === 'warning');
      
      if (errorEntries.length > 0) {
        html += `<div style="margin-top:12px; padding:10px; background:#ffebee; border-left:3px solid #d32f2f; border-radius:3px;">
          <div style="font-weight:bold; color:#c62828; font-size:12px; margin-bottom:6px;">❌ ${errorEntries.length} Error${errorEntries.length !== 1 ? 's' : ''}</div>
          <div style="font-size:12px; color:#b71c1c; margin-left:20px;">
            ${errorEntries.slice(0, 3).map(e => `<div>• ${e.category}: ${e.issue?.substring(0, 60)}</div>`).join('')}
            ${errorEntries.length > 3 ? `<div>• ... and ${errorEntries.length - 3} more</div>` : ''}
          </div>
        </div>`;
      }
      
      if (warningEntries.length > 0) {
        html += `<div style="margin-top:8px; padding:10px; background:#fff3e0; border-left:3px solid #f57c00; border-radius:3px;">
          <div style="font-weight:bold; color:#e65100; font-size:12px; margin-bottom:6px;">⚠️ ${warningEntries.length} Warning${warningEntries.length !== 1 ? 's' : ''}</div>
          <div style="font-size:12px; color:#bf360c; margin-left:20px;">
            ${warningEntries.slice(0, 3).map(e => `<div>• ${e.category}: ${e.issue?.substring(0, 60)}</div>`).join('')}
            ${warningEntries.length > 3 ? `<div>• ... and ${warningEntries.length - 3} more</div>` : ''}
          </div>
        </div>`;
      }
    }

    content.innerHTML = html;
    _dbg('Validation results displayed', validationData);
  }

  /**
   * Render table of invalid BIDS files with action buttons
   * @param {Object} validationResult - Validation results with Report Table
   * @param {Object} savedActions - Currently saved actions
   * @return {string} HTML table of invalid files
   */
  function renderInvalidFilesTable(validationResult, savedActions = {}) {
    const validationEntries = validationResult['Validation Entries'] || [];
    const summary = validationResult['BIDS Validation Summary'] || {};
    const fileValidation = summary.file_validation || {};
    const invalidCount = parseInt(summary['Invalid BIDS Files'] ?? fileValidation.invalid_bids, 10) || 0;

    if (invalidCount === 0) {
      return ''; // No invalid files, don't render table
    }

    // Filter to unresolved invalid files only.
    const invalidFiles = getUnresolvedInvalidEntries(validationEntries, savedActions);
    
    // If no unresolved invalid files, don't render table
    if (invalidFiles.length === 0) {
      return '';
    }

    const tableId = 'invalidFilesTable';
    const toggleId = 'toggleInvalidFiles';
    const tableDisplay = invalidFilesTableExpanded ? 'block' : 'none';
    const toggleSymbol = invalidFilesTableExpanded ? '▼' : '▶';
    
    let html = `<div style="margin-top:16px; padding:14px; background:#fafafa; border:1px solid #eee; border-radius:6px;">
      <div style="display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;" onclick="AppQA.toggleInvalidFilesTable();">
        <span id="${toggleId}" style="font-weight:bold; color:#333; font-size:14px;">${toggleSymbol}</span>
        <div style="font-weight:600; font-size:12px; color:#333;">Invalid Files (${invalidFiles.length})</div>
      </div>
      <table id="${tableId}" style="display:${tableDisplay}; width:100%; border-collapse:collapse; font-size:11px; margin-top:10px;">
        <thead>
          <tr style="background:#f0f0f0; border-bottom:1px solid #ddd;">
            <th style="padding:8px; text-align:left; font-weight:600;">BIDS File</th>
            <th style="padding:8px; text-align:left; font-weight:600;">Issue</th>
            <th style="padding:8px; text-align:center; font-weight:600; width:180px;">Action</th>
          </tr>
        </thead>
        <tbody>`;

    invalidFiles.forEach((entry, idx) => {
      const bidsFile = entry['BIDS File'] || entry.file || '';
      const issue = entry['Validation Issue'] || entry.issue || 'Unknown issue';
      const bgColor = idx % 2 === 0 ? '#ffffff' : '#f9f9f9';
      const bidsFileEscaped = String(bidsFile).replace(/'/g, "\\'");
      const rowId = 'file_row_' + btoa(bidsFile).replace(/[^a-z0-9]/gi, '');
      const issueEscaped = String(issue).replace(/'/g, "\\'");
      
      html += `<tr id="${rowId}" style="background:${bgColor}; border-bottom:1px solid #eee; transition:all 0.3s ease;">
        <td style="padding:8px; font-family:monospace; word-break:break-all;">${bidsFile}</td>
        <td style="padding:8px; color:#666;">${issue}</td>
        <td style="padding:8px; text-align:center; display:flex; gap:4px; justify-content:center;">
          <button onclick="AppQA.markFileAsResolved('${bidsFileEscaped}', 'Marked as OK', '${rowId}')" style="padding:6px 12px; font-size:10px; background:#4caf50; color:white; border:none; border-radius:3px; cursor:pointer; font-weight:600;">✓ Mark as OK</button>
          <button onclick="window.BIDSBrowser && BIDSBrowser.viewInEditor && BIDSBrowser.viewInEditor('${bidsFileEscaped}', '${bidsFileEscaped}', '${issueEscaped}')" style="padding:6px 12px; font-size:10px; background:#2196f3; color:white; border:none; border-radius:3px; cursor:pointer; font-weight:600;">👁 View in Editor</button>
        </td></tr>`;
    });

    html += `</tbody>
      </table>
    </div>`;
    
    return html;
  }

  // Toggle state for separate issue tables
  function toggleFileIssuesTable() {
    fileIssuesExpanded = !fileIssuesExpanded;
    renderActiveIssuesFromValidation(currentValidationResult, currentSavedActions);
  }

  function toggleStructuralIssuesTable() {
    structuralIssuesExpanded = !structuralIssuesExpanded;
    renderActiveIssuesFromValidation(currentValidationResult, currentSavedActions);
  }

  function renderActiveIssuesFromValidation(validationResult, savedActions = {}) {
    const container = document.getElementById('qaResultsContainer');
    if (!container) return;

    const validationEntries = validationResult?.['Validation Entries'] || [];
    const unresolvedEntries = getUnresolvedInvalidEntries(validationEntries, savedActions);
    
    // Separate file-level issues from dataset-level issues
    const fileIssues = unresolvedEntries.filter(e => {
      const level = e.bids_level || 'file';
      return level !== 'dataset' && e.type !== 'dataset_issue';
    });
    
    const structuralIssues = unresolvedEntries.filter(e => {
      const level = e.bids_level || 'file';
      return level === 'dataset' || e.type === 'dataset_issue';
    });
    
    currentActiveIssues = unresolvedEntries;

    if (unresolvedEntries.length === 0) {
      container.innerHTML = '<div style="color: #4caf50; font-size: 13px; text-align: center; padding:24px;">✓ No active dataset validation issues</div>';
      return;
    }

    let html = `<h4 style="margin-top:20px; margin-bottom:12px; color:#333; font-size:14px; font-weight:600; padding-bottom:8px; border-bottom:2px solid #2196f3;">Validation</h4>`;

    // Structural Issues Section
    if (structuralIssues.length > 0) {
      const structDisplay = structuralIssuesExpanded ? 'block' : 'none';
      const structSymbol = structuralIssuesExpanded ? '▼' : '▶';
      
      html += `<div style="margin-bottom:16px;">`;
      html += `<div style="display:flex; align-items:center; gap:12px; cursor:pointer; user-select:none; margin-bottom:8px; padding:12px; background:#f5f5f5; border:1px solid #ddd; border-radius:6px;" onclick="AppQA.toggleStructuralIssuesTable();">
        <span style="font-weight:bold; color:#333; font-size:14px;">${structSymbol}</span>
        <div style="font-weight:600; font-size:12px; color:#333; flex:1;">🏗️ Structural Issues</div>
        <div style="font-size:11px; background:#fff; padding:4px 8px; border-radius:3px; color:#666;">${structuralIssues.length} issue${structuralIssues.length !== 1 ? 's' : ''}</div>
      </div>
      <div id="structuralIssuesContainer" style="display:${structDisplay}; max-height:300px; overflow-y:auto; border:1px solid #ddd; border-radius:4px; padding:8px; background:#fafafa;">`;
      
      structuralIssues.forEach((entry, idx) => {
        const bidsFile = entry['BIDS File'] || entry.file || '';
        const issue = entry['Validation Issue'] || entry.issue || 'Unknown issue';
        const severity = String(entry.severity || 'error').toLowerCase();
        const rowId = `struct_issue_${idx}`;
        const fileEscaped = String(bidsFile).replace(/'/g, "\\'");
        const sevBg = severity === 'warning' ? '#fff8e1' : '#ffebee';
        const sevBorder = severity === 'warning' ? '#f57f17' : '#d32f2f';

        html += `<div id="${rowId}" style="padding:10px; background:${sevBg}; border-left:3px solid ${sevBorder}; border-radius:4px; font-size:11px; margin-bottom:8px;">`;
        html += `<div style="margin-bottom:8px;">`;
        html += `<div style="font-weight:600; color:#333; margin-bottom:4px;">${issue}</div>`;
        html += `<div style="font-family:monospace; color:#666; margin-bottom:6px; word-break:break-all; font-size:10px;">${bidsFile}</div>`;
        if (entry.suggestion) {
          html += `<div style="font-size:10px; color:#555; margin-top:4px; font-style:italic;">💡 ${entry.suggestion}</div>`;
        }
        html += `</div>`;
        html += `<div style="display:flex; gap:6px; flex-wrap:wrap;">`;
        html += `<button onclick="AppQA.markFileAsResolved('${fileEscaped}', 'Marked as OK', '${rowId}')" style="padding:6px 10px; font-size:10px; background:#4caf50; color:white; border:none; border-radius:3px; cursor:pointer; font-weight:600;">✓ OK</button>`;
        html += `</div>`;
        html += `</div>`;
      });
      
      html += `</div></div>`;
    }

    // File Issues Section
    if (fileIssues.length > 0) {
      const fileDisplay = fileIssuesExpanded ? 'block' : 'none';
      const fileSymbol = fileIssuesExpanded ? '▼' : '▶';
      
      html += `<div>`;
      html += `<div style="display:flex; align-items:center; gap:12px; cursor:pointer; user-select:none; margin-bottom:8px; padding:12px; background:#f5f5f5; border:1px solid #ddd; border-radius:6px;" onclick="AppQA.toggleFileIssuesTable();">
        <span style="font-weight:bold; color:#333; font-size:14px;">${fileSymbol}</span>
        <div style="font-weight:600; font-size:12px; color:#333; flex:1;">📄 File Validation Issues</div>
        <div style="font-size:11px; background:#fff; padding:4px 8px; border-radius:3px; color:#666;">${fileIssues.length} issue${fileIssues.length !== 1 ? 's' : ''}</div>
      </div>
      <div id="fileIssuesContainer" style="display:${fileDisplay}; max-height:300px; overflow-y:auto; border:1px solid #ddd; border-radius:4px; padding:8px; background:#fafafa;">`;
      
      fileIssues.forEach((entry, idx) => {
        const bidsFile = entry['BIDS File'] || entry.file || '';
        const issue = entry['Validation Issue'] || entry.issue || 'Unknown issue';
        const severity = String(entry.severity || 'error').toLowerCase();
        const rowId = `file_issue_${idx}`;
        const fileEscaped = String(bidsFile).replace(/'/g, "\\'");
        const issueEscaped = String(issue).replace(/'/g, "\\'");
        const sevBg = severity === 'warning' ? '#fff8e1' : '#ffebee';
        const sevBorder = severity === 'warning' ? '#f57f17' : '#d32f2f';

        html += `<div id="${rowId}" style="padding:10px; background:${sevBg}; border-left:3px solid ${sevBorder}; border-radius:4px; font-size:11px; margin-bottom:8px;">`;
        html += `<div style="margin-bottom:8px;">`;
        html += `<div style="font-weight:600; color:#333; margin-bottom:4px;">${issue}</div>`;
        html += `<div style="font-family:monospace; color:#666; margin-bottom:6px; word-break:break-all; font-size:10px;">${bidsFile}</div>`;
        html += `</div>`;
        html += `<div style="display:flex; gap:6px; flex-wrap:wrap;">`;
        html += `<button onclick="AppQA.markFileAsResolved('${fileEscaped}', 'Marked as OK', '${rowId}')" style="padding:6px 10px; font-size:10px; background:#4caf50; color:white; border:none; border-radius:3px; cursor:pointer; font-weight:600;">✓ OK</button>`;
        html += `<button onclick="window.BIDSBrowser && BIDSBrowser.viewInEditor && BIDSBrowser.viewInEditor('${fileEscaped}', '${fileEscaped}', '${issueEscaped}')" style="padding:6px 10px; font-size:10px; background:#2196f3; color:white; border:none; border-radius:3px; cursor:pointer; font-weight:600;">👁 View</button>`;
        html += `</div>`;
        html += `</div>`;
      });
      
      html += `</div></div>`;
    }

    container.innerHTML = html;
  }

  function rerenderValidationPanels() {
    const summaryPanel = document.getElementById('validationSummaryPanel');
    if (summaryPanel && currentValidationResult) {
      const summary = currentValidationResult['BIDS Validation Summary'] || {};
      const entries = currentValidationResult['Validation Entries'] || [];
      let panelHtml = renderValidationSummary(summary, currentSavedActions, entries);
      summaryPanel.innerHTML = panelHtml;
    }

    renderActiveIssuesFromValidation(currentValidationResult, currentSavedActions);
  }

  function applyActionToLocalValidation(bidsFile, action, note, timestamp) {
    if (!currentValidationResult || !currentValidationResult['Validation Entries']) return;

    const target = normalizeActionPath(bidsFile);
    const targetSuffix = target.includes('/sub-') ? target.slice(target.indexOf('/sub-') + 1) : '';

    currentValidationResult['Validation Entries'].forEach(entry => {
      const entryFile = normalizeActionPath(entry['BIDS File'] || entry.file || '');
      const entrySource = normalizeActionPath(entry['Source File'] || entry.source_file || '');
      const entryFileSuffix = entryFile.includes('/sub-') ? entryFile.slice(entryFile.indexOf('/sub-') + 1) : '';
      const entrySourceSuffix = entrySource.includes('/sub-') ? entrySource.slice(entrySource.indexOf('/sub-') + 1) : '';

      const matches = (
        target && (
          target === entryFile ||
          target === entrySource ||
          (targetSuffix && targetSuffix === entryFileSuffix) ||
          (targetSuffix && targetSuffix === entrySourceSuffix)
        )
      );

      if (matches) {
        entry.bids_action = action;
        entry.action_timestamp = timestamp;
        entry.bids_action_timestamp = timestamp;
        entry.action_user_note = note;
      }
    });
  }

  /**
   * Show modal dialog to get mandatory note for file action
   * @returns {Promise<string>} Note text if confirmed, empty string if cancelled
   */
  async function _showActionNoteModal() {
    return new Promise((resolve) => {
      const modal = document.getElementById('actionNoteModal');
      const noteInput = document.getElementById('actionNoteInput');
      const confirmBtn = document.getElementById('actionNoteConfirm');
      const cancelBtn = document.getElementById('actionNoteCancel');
      
      if (!modal || !noteInput || !confirmBtn || !cancelBtn) {
        _dbg('ERROR: Action note modal elements not found');
        resolve('');
        return;
      }
      
      // Clear and focus the input
      noteInput.value = '';
      noteInput.focus();
      
      // Initially disable confirm button
      confirmBtn.disabled = true;
      
      // Enable/disable confirm button based on input
      const updateConfirmButton = () => {
        confirmBtn.disabled = !noteInput.value.trim();
      };
      
      noteInput.addEventListener('input', updateConfirmButton);
      
      // Confirm handler
      const handleConfirm = () => {
        const note = noteInput.value.trim();
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        cleanup();
        resolve(note || '');
      };
      
      // Cancel handler
      const handleCancel = () => {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        cleanup();
        resolve('');
      };
      
      // Cleanup event listeners
      const cleanup = () => {
        noteInput.removeEventListener('input', updateConfirmButton);
        confirmBtn.removeEventListener('click', handleConfirm);
        cancelBtn.removeEventListener('click', handleCancel);
        document.removeEventListener('keydown', handleEscape);
      };
      
      // Escape key handler
      const handleEscape = (e) => {
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
  }

  /**
   * Handle action button clicks to mark files as resolved
   * @param {string} bidsFile - Full path to BIDS file
   * @param {string} action - Action type ('Marked as OK' or 'Ignored')
   * @param {string} rowId - Row element ID for animation
   */
  async function markFileAsResolved(bidsFile, action, rowId) {
    _dbg('markFileAsResolved', { bidsFile, action, rowId });
    
    // Show modal to get mandatory note
    const note = await _showActionNoteModal();
    
    if (!note) {
      // User cancelled
      _dbg('User cancelled action');
      return;
    }

    return applyResolutionAction(bidsFile, action, rowId, note);
  }

  async function applyResolutionAction(bidsFile, action, rowId, note) {
    _dbg('applyResolutionAction', { bidsFile, action, rowId });

    // Find row element for animation
    const rowElement = rowId ? document.getElementById(rowId) : null;
    
    // Show success animation on row (green highlight flash)
    if (rowElement) {
      rowElement.classList.add('file-row-success');
    }
    
    // Save action to backend with user's note
    const saved = await saveAction(bidsFile, action, note);
    
    if (saved) {
      const timestamp = new Date().toISOString();

      // Show success toast notification
      showToast(`✓ File marked as "${action}"`);
      
      // Update current state from the same source contract used by backend.
      currentSavedActions[normalizeActionPath(bidsFile)] = { action, note, timestamp };
      applyActionToLocalValidation(bidsFile, action, note, timestamp);
      rerenderValidationPanels();
      _dbg('Panels re-rendered with updated action state');
      
      // After success animation, fade out and remove the row
      setTimeout(() => {
        if (rowElement) {
          rowElement.classList.remove('file-row-success');
          rowElement.classList.add('file-row-removing');
          
          // Remove the element from DOM after animation completes
          setTimeout(() => {
            rowElement.remove();
          }, 600);
        }
      }, 600);
    } else {
      // Action failed
      showToast('❌ Failed to save action', 'error');
      if (rowElement) {
        rowElement.classList.remove('file-row-success');
      }
    }
  }
  
  /**
   * Show toast notification
   * @param {string} message - Message to display
   * @param {string} type - 'success' or 'error'
   */
  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.style.background = type === 'error' ? '#f44336' : '#4caf50';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Auto remove after 3 seconds
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
      toast.style.transition = 'all 0.4s ease-out';
      setTimeout(() => toast.remove(), 400);
    }, 2600);
  }

  /**
   * Handle QA issue acknowledgment with mandatory note
   * @param {number} issueIndex - Index of the QA issue
   * @param {string} issueId - DOM element ID of the issue row
   */
  async function markQAIssueAsResolved(issueIndex, issueId) {
    _dbg('markQAIssueAsResolved', { issueIndex, issueId });

    const issueEntry = currentActiveIssues[issueIndex];
    if (!issueEntry) {
      showToast('❌ Issue not found', 'error');
      return;
    }

    const bidsFile = issueEntry['BIDS File'] || issueEntry.file || '';
    if (!bidsFile) {
      showToast('❌ Missing file path for this issue', 'error');
      return;
    }

    await markFileAsResolved(bidsFile, 'Marked as OK', issueId);
  }

  // Public API — maintain backward compatibility
  window.AppQA.runAnalysis = runUnifiedValidation;        // Legacy alias
  window.AppQA.runValidation = runUnifiedValidation;       // Legacy alias
  window.AppQA.exportResults = exportQAResults;
  window.AppQA.loadFromFile = loadQAFromFile;
  window.AppQA.getCurrentResults = () => currentQAResults;
  window.AppQA.markFileAsResolved = markFileAsResolved;   // File validation action handler
  window.AppQA.markFileAsResolvedWithNote = applyResolutionAction;
  window.AppQA.markQAIssueAsResolved = markQAIssueAsResolved; // QA issue acknowledgment handler
  window.AppQA.toggleFileIssuesTable = toggleFileIssuesTable;
  window.AppQA.toggleStructuralIssuesTable = toggleStructuralIssuesTable;

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
