// App state management and UI controller
let currentConfig = null;
let conversionStatus = 'not-run';
let analysisComplete = false;
let executionComplete = false;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initializeNavigation();
    initializeEventHandlers();
    loadDefaultConfig();
    // Auto-load conversion table and report when config is loaded
    document.addEventListener('configLoaded', () => {
        // Editor: auto-load conversion table
        if (document.getElementById('editor')) {
            loadConversionTable();
        }
        // Report: auto-load report
        if (document.getElementById('report')) {
            loadReport();
        }
    });
});

// Navigation
function initializeNavigation() {
    // Sidebar navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const viewId = item.dataset.view;
            switchView(viewId);
        });
    });
}

// Track if paths were manually edited
let pathsManuallyEdited = {
    raw: false,
    bids: false,
    calibration: false,
    crosstalk: false
};

function initializeEventHandlers() {
        // Analyse: Create Conversion Table
        const runAnalyseBtn = document.getElementById('runAnalyseBtn');
        if (runAnalyseBtn) {
            runAnalyseBtn.addEventListener('click', runAnalysis);
        }

        // Execute: Start Conversion
        const runBidsifyBtn = document.getElementById('runBidsifyBtn');
        if (runBidsifyBtn) {
            runBidsifyBtn.addEventListener('click', runBidsification);
        }

        // Report: Create Report
        const createReportBtn = document.getElementById('createReportBtn');
        if (createReportBtn) {
            createReportBtn.addEventListener('click', async () => {
                await runReportWithMainConfig();
            });
        }
    // Set placeholders dynamically to show <project>
    document.getElementById('config_raw_path').placeholder = 'Auto: {root}/{project}/raw';
    document.getElementById('config_bids_path').placeholder = 'Auto: {root}/{project}/BIDS';
    
    // Step 1: Configuration
    document.getElementById('loadConfigBtn').addEventListener('click', loadConfigFile);
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfigFile);

    function loadConversionTable() {
        // Implement logic to load bids_conversion.tsv into the editor
        // ...
        console.log('Auto-loading conversion table in Editor');
    }

    function loadReport() {
        // Implement logic to load report into the Report page
        // ...
        console.log('Auto-loading report in Report page');
    }


    // Helper: Run report with main config file
    async function runReportWithMainConfig() {
        if (!window.electronAPI) {
            alert('Electron API not available');
            return;
        }
        // If no saved config file is available, we can use the in-memory `currentConfig`
        // by saving it as a temporary config file via the main process.
        let configFileToUse = window.currentConfigFilePath || null;
        if (!configFileToUse) {
            if (!currentConfig) {
                alert('No configuration loaded. Please load or create a configuration first.');
                return;
            }
            // Auto-save the in-memory configuration to a temporary file and use it for
            // report generation. This avoids prompting the user to save; the temp file
            // is ephemeral and won't overwrite any existing config file.
            try {
                const tempPath = await window.electronAPI.saveTempConfig(currentConfig);
                configFileToUse = tempPath;
            } catch (err) {
                alert('Failed to create temporary config: ' + err.message);
                return;
            }
        }
        // Check for unsaved changes and automatically save them to a temp config
        // so we can generate a report without prompting the user to save.
        const newConfig = collectConfigFromForm();
        const configChanged = JSON.stringify(currentConfig) !== JSON.stringify(newConfig);
        if (configChanged) {
            currentConfig = newConfig;
            try {
                // Save the in-memory config as a temporary file so the report
                // generator can read it without showing Save dialogs.
                const tempPath = await window.electronAPI.saveTempConfig(newConfig);
                configFileToUse = tempPath;
            } catch (err) {
                alert('❌ Failed to create temporary config: ' + err.message);
                return;
            }
        }
        // Run bidsify.py --report --config <main config path>
        try {
            const result = await window.electronAPI.runBidsifyWithArgs(['--report', '--config', configFileToUse]);
            if (result.success) {
                alert('✅ Report created successfully');
            } else {
                alert('❌ Error creating report: ' + (result.error || 'Unknown error'));
            }
        } catch (err) {
            alert('❌ Failed to create report: ' + err.message);
        }
    }
    
    // Track manual edits to paths
    document.getElementById('config_raw_path').addEventListener('input', (e) => {
        pathsManuallyEdited.raw = true;
        updatePathIndicator('raw', true);
    });
    
    document.getElementById('config_bids_path').addEventListener('input', (e) => {
        pathsManuallyEdited.bids = true;
        updatePathIndicator('bids', true);
    });
    
    // Add reset buttons next to path fields
    const rawPathGroup = document.getElementById('config_raw_path').parentElement;
    const bidsPathGroup = document.getElementById('config_bids_path').parentElement;
    
    const rawResetBtn = document.createElement('button');
    rawResetBtn.textContent = '🔄 Reset to auto';
    rawResetBtn.className = 'path-reset-btn';
    rawResetBtn.style.cssText = 'margin-top: 5px; padding: 4px 8px; font-size: 11px; background: #860052; color: white; border: none; border-radius: 4px; cursor: pointer; display: none;';
    rawResetBtn.onclick = (e) => {
        e.preventDefault();
        pathsManuallyEdited.raw = false;
        updatePathsFromRoot();
        updatePathIndicator('raw', false);
    };
    rawPathGroup.appendChild(rawResetBtn);
    
    const bidsResetBtn = document.createElement('button');
    bidsResetBtn.textContent = '🔄 Reset to auto';
    bidsResetBtn.className = 'path-reset-btn';
    bidsResetBtn.style.cssText = 'margin-top: 5px; padding: 4px 8px; font-size: 11px; background: #860052; color: white; border: none; border-radius: 4px; cursor: pointer; display: none;';
    bidsResetBtn.onclick = (e) => {
        e.preventDefault();
        pathsManuallyEdited.bids = false;
        updatePathsFromRoot();
        updatePathIndicator('bids', false);
    };
    bidsPathGroup.appendChild(bidsResetBtn);
    
    // Auto-update paths when root or project name changes
    document.getElementById('config_root_path').addEventListener('input', updatePathsFromRoot);
    document.getElementById('config_project_name').addEventListener('input', updatePathsFromRoot);
    
    const nextBtn = document.getElementById('nextToEditorBtn');
    if (nextBtn) {
        nextBtn.addEventListener('click', async () => {
            console.log('Next to Editor clicked');
            if (validateConfig()) {
                const newConfig = collectConfigFromForm();
                
                // Check if config has changed from what was loaded or last saved
                const configChanged = JSON.stringify(currentConfig) !== JSON.stringify(newConfig);
                
                if (configChanged && currentConfig !== null) {
                    const confirmProceed = confirm(
                        '⚠️ You have unsaved configuration changes.\n\n' +
                        'Do you want to save your configuration before proceeding to Editor?\n\n' +
                        'Click "OK" to save and continue, or "Cancel" to continue without saving.'
                    );
                    
                    if (confirmProceed) {
                        // Save config first (await to keep navigation in order)
                        try {
                            await saveConfigFile();
                            currentConfig = newConfig;
                        } catch (error) {
                            console.error('Error saving config:', error);
                            // Proceed anyway if user wants
                            const proceedAnyway = confirm('Failed to save config. Proceed anyway?');
                            if (proceedAnyway) {
                                currentConfig = newConfig;
                            }
                        }
                    } else {
                        // User chose to proceed without saving
                        currentConfig = newConfig;
                        // switchView('analyse');
                    }
                } else {
                    // No changes, proceed directly
                    currentConfig = newConfig;
                }
            }

            // If a conversion table exists from prior runs, try to reload it before switching
            if (currentTablePath && analysisComplete) {
                try {
                    const fileContent = await window.electronAPI.readFile(currentTablePath);
                    if (fileContent) parseAndDisplayTable(fileContent);
                } catch (e) {
                    console.log('Could not reload table:', e.message);
                }
            }

            // Move user to editor
            switchView('editor');
        });
    } else {
        console.error('nextToEditorBtn not found!');
    }
    
    // Step 2: Analyse
    // Listen to runAnalyseBtn already wired in initializeEventHandlers
    // Next-to-editor navigation now handled from config page instead
    
    // Step 3: Editor
    document.getElementById('backToConfigBtn').addEventListener('click', () => switchView('config'));
    document.getElementById('nextToExecuteBtn').addEventListener('click', () => {
        // Check if there are unsaved changes before proceeding
        if (editorData.modifiedRows.size > 0) {
            const confirmProceed = confirm(
                `⚠️ You have ${editorData.modifiedRows.size} unsaved change(s) in the conversion table.\n\n` +
                'Do you want to save your changes before proceeding to Execute?\n\n' +
                'Click "OK" to save and continue, or "Cancel" to continue without saving.'
            );
            
            if (confirmProceed) {
                // Save the table first
                saveEditorTable().then(() => {
                    switchView('execute');
                }).catch(error => {
                    alert('❌ Error saving changes: ' + error.message + '\n\nPlease save manually before proceeding.');
                });
            } else {
                // User chose to proceed without saving
                switchView('execute');
            }
        } else {
            // No unsaved changes, proceed directly
            switchView('execute');
        }
    });
    
    // Step 4: Execute
    document.getElementById('runBidsifyBtn').addEventListener('click', runBidsification);
    document.getElementById('backToEditorBtn').addEventListener('click', () => switchView('editor'));
    document.getElementById('nextToReportBtn').addEventListener('click', () => {
        generateReport();
        switchView('report');
    });
    
    // Step 5: Report
    document.getElementById('backToExecuteBtn').addEventListener('click', () => switchView('execute'));
    document.getElementById('startOverBtn').addEventListener('click', () => {
        resetWorkflow();
        switchView('config');
    });
    document.getElementById('exportReportBtn').addEventListener('click', exportReport);
    
    // Auto-save config on input change
    document.getElementById('configForm').addEventListener('change', () => {
        currentConfig = collectConfigFromForm();
    });

    // GitHub external link: open it in system default browser instead of navigating inside Electron
    const gh = document.getElementById('githubLink');
    if (gh) {
        gh.addEventListener('click', (e) => {
            e.preventDefault();
            const url = gh.dataset.url || gh.href;
            if (window.electronAPI && window.electronAPI.openExternal) {
                window.electronAPI.openExternal(url);
            } else {
                window.open(url, '_blank');
            }
        });
    }
}

function switchView(viewId) {
    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        const isActive = item.dataset.view === viewId;
        item.classList.toggle('active', isActive);
        
        // Mark completed steps
        const stepNum = parseInt(item.dataset.step);
        const currentViewItem = document.querySelector(`.nav-item[data-view="${viewId}"]`);
        if (currentViewItem) {
            const currentStepNum = parseInt(currentViewItem.dataset.step);
            if (stepNum < currentStepNum) {
                item.classList.add('completed');
            } else {
                item.classList.remove('completed');
            }
        }
    });
    
    // Update content views
    document.querySelectorAll('.content-view').forEach(view => {
        view.classList.toggle('active', view.id === viewId);
    });
}

// Configuration Management
async function browseDirectory(inputId) {
    if (window.electronAPI) {
        const result = await window.electronAPI.selectDirectory();
        if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
            const selectedPath = result.filePaths[0];
            document.getElementById(inputId).value = selectedPath;
            
            // Mark path as manually edited if it's raw or bids path
            if (inputId === 'config_raw_path') {
                pathsManuallyEdited.raw = true;
                updatePathIndicator('raw', true);
            } else if (inputId === 'config_bids_path') {
                pathsManuallyEdited.bids = true;
                updatePathIndicator('bids', true);
            } else if (inputId === 'config_calibration_path') {
                pathsManuallyEdited.calibration = true;
            } else if (inputId === 'config_crosstalk_path') {
                pathsManuallyEdited.crosstalk = true;
            }
            
            // Trigger validation
            document.getElementById(inputId).dispatchEvent(new Event('change'));
        }
    }
}

async function browseFile(inputId) {
    if (window.electronAPI) {
        const result = await window.electronAPI.selectFile();
        if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
            const selectedPath = result.filePaths[0];
            document.getElementById(inputId).value = selectedPath;
            
            // Mark as manually edited
            if (inputId === 'config_calibration_path') {
                pathsManuallyEdited.calibration = true;
            } else if (inputId === 'config_crosstalk_path') {
                pathsManuallyEdited.crosstalk = true;
            }
            
            // Trigger validation
            document.getElementById(inputId).dispatchEvent(new Event('change'));
        }
    }
}

async function loadDefaultConfig() {
    if (window.electronAPI) {
        try {
            const result = await window.electronAPI.loadDefaultConfig();
            if (result) {
                // If result is just the config object, keep old logic
                if (result.config) {
                    populateConfigForm(result.config);
                    currentConfig = result.config;
                    window.currentConfigFilePath = result.filePath || result.configPath || null;
                } else {
                    populateConfigForm(result);
                    currentConfig = result;
                    window.currentConfigFilePath = null;
                }
            }
        } catch (error) {
            console.error('Error loading default config:', error);
        }
    }
}

async function loadConfigFile() {
    if (window.electronAPI) {
        const result = await window.electronAPI.loadConfig();
        if (result && result.config) {
            populateConfigForm(result.config);
            currentConfig = result.config;
            // Store the config file path for later use
            window.currentConfigFilePath = result.filePath || result.configPath || null;
            alert('✅ Configuration loaded successfully');

            // Auto-load Editor and Report if files exist
            const projectRoot = result.config?.Project?.Root && result.config?.Project?.Name
                ? `${result.config.Project.Root}/${result.config.Project.Name}`
                : null;
            if (projectRoot) {
                const logsPath = `${projectRoot}/logs`;
                const conversionFile = result.config.BIDS?.Conversion_file || 'bids_conversion.tsv';
                const conversionTablePath = `${logsPath}/${conversionFile}`;
                const summaryPath = `${logsPath}/bids_results.json`;
                const fs = window.electronAPI;
                // Check for conversion table
                try {
                    const tableContent = await fs.readFile(conversionTablePath);
                    if (tableContent) {
                        // Load table in editor but do not automatically switch view
                        // This avoids disrupting the user when they just wanted to load config
                        await loadConversionTableInEditor(conversionTablePath);
                    }
                } catch (e) {
                    // Table not found, do nothing
                }
                // Check for summary/report
                try {
                    const summaryContent = await fs.readFile(summaryPath);
                    if (summaryContent) {
                        // Only generate report, do not switch view automatically
                        await generateReport();
                    }
                } catch (e) {
                    // Summary not found, do nothing
                }
            }
        }
    }
}

async function saveConfigFile() {
    const config = collectConfigFromForm();
    if (!validateConfig()) {
        return Promise.reject(new Error('Configuration validation failed'));
    }
    
    if (window.electronAPI) {
        const result = await window.electronAPI.saveConfig(config);
        if (result.success) {
            alert('✅ Configuration saved successfully');
            return Promise.resolve();
        } else {
            alert('❌ Error saving configuration: ' + result.error);
            return Promise.reject(new Error(result.error));
        }
    }
    return Promise.reject(new Error('Electron API not available'));
}

function populateConfigForm(config) {
    const projectName = config.Project?.Name || '';
    const rootPath = config.Project?.Root || '/neuro/data/local';
    
    document.getElementById('config_project_name').value = projectName;
    document.getElementById('config_cir_id').value = config.Project?.['CIR-ID'] || '';
    
    // Populate Tasks field
    const tasks = config.Project?.Tasks || [];
    document.getElementById('config_tasks').value = Array.isArray(tasks) ? tasks.filter(t => t).join(', ') : '';
    
    // Auto-resolve <project> placeholder in root path
    document.getElementById('config_root_path').value = rootPath.replace(/<project>/g, projectName);
    
    // Auto-resolve placeholders when populating
    const rawPath = config.Project?.Raw || '';
    const bidsPath = config.Project?.BIDS || '';
    
    document.getElementById('config_raw_path').value = rawPath.replace(/<project>/g, projectName);
    document.getElementById('config_bids_path').value = bidsPath.replace(/<project>/g, projectName);
    
    // Populate Calibration and Crosstalk paths
    const calibrationPath = config.Project?.Calibration || '';
    const crosstalkPath = config.Project?.Crosstalk || '';
    document.getElementById('config_calibration_path').value = calibrationPath.replace(/<project>/g, projectName);
    document.getElementById('config_crosstalk_path').value = crosstalkPath.replace(/<project>/g, projectName);
    
    // Reset manual edit flags when loading config
    pathsManuallyEdited.raw = false;
    pathsManuallyEdited.bids = false;
    pathsManuallyEdited.calibration = false;
    pathsManuallyEdited.crosstalk = false;
    
    // Dataset description fields
    document.getElementById('config_dataset_name').value = config.Dataset_description?.Name || projectName;
    document.getElementById('config_bids_version').value = config.Dataset_description?.BIDSVersion || '1.7.0';
    document.getElementById('config_dataset_type').value = config.Dataset_description?.DatasetType || 'raw';
    document.getElementById('config_license').value = config.Dataset_description?.License || config.BIDS?.data_license || '';
    
    const authors = config.Dataset_description?.Authors || [];
    document.getElementById('config_authors').value = Array.isArray(authors) ? authors.filter(a => a).join(', ') : (config.BIDS?.authors || '');
    
    document.getElementById('config_acknowledgements').value = config.Dataset_description?.Acknowledgements || '';
    document.getElementById('config_how_to_acknowledge').value = config.Dataset_description?.HowToAcknowledge || '';
    
    const funding = config.Dataset_description?.Funding || [];
    document.getElementById('config_funding').value = Array.isArray(funding) ? funding.filter(f => f).join(', ') : '';
    
    const ethics = config.Dataset_description?.EthicsApprovals || [];
    document.getElementById('config_ethics_approvals').value = Array.isArray(ethics) ? ethics.filter(e => e).join(', ') : '';
    
    const refs = config.Dataset_description?.ReferencesAndLinks || [];
    document.getElementById('config_references_links').value = Array.isArray(refs) ? refs.filter(r => r).join(', ') : '';
    
    document.getElementById('config_dataset_doi').value = config.Dataset_description?.DatasetDOI || '';
    document.getElementById('config_code_url').value = config.Dataset_description?.GeneratedBy?.[0]?.CodeURL || 'https://mne.tools/mne-bids/';
    
    document.getElementById('config_conversion_file').value = config.BIDS?.Conversion_file || 'bids_conversion.tsv';
    document.getElementById('config_overwrite').value = config.BIDS?.overwrite ? 'true' : 'false';
}

function updatePathIndicator(pathType, isManual) {
    const field = pathType === 'raw' ? document.getElementById('config_raw_path') : document.getElementById('config_bids_path');
    const resetBtn = field.parentElement.querySelector('.path-reset-btn');
    const smallText = field.nextElementSibling;
    
    if (isManual) {
        field.style.borderColor = '#ff9800';
        field.style.borderWidth = '2px';
        if (resetBtn) resetBtn.style.display = 'inline-block';
        if (smallText && smallText.tagName === 'SMALL') {
            smallText.textContent = '🔒 Manually set (won\'t auto-update)';
            smallText.style.color = '#ff9800';
        }
    } else {
        field.style.borderColor = '#ddd';
        field.style.borderWidth = '1px';
        if (resetBtn) resetBtn.style.display = 'none';
        if (smallText && smallText.tagName === 'SMALL') {
            smallText.textContent = 'Auto-updates unless manually edited';
            smallText.style.color = '#666';
        }
    }
}

function updatePathsFromRoot() {
    const rootPath = document.getElementById('config_root_path').value.trim();
    const projectName = document.getElementById('config_project_name').value.trim();
    
    // Need both root and project to generate paths
    if (!rootPath || !projectName) {
        return;
    }
    
    // Helper to join paths without creating double slashes
    const joinPath = (...parts) => {
        return parts
            .map((part, index) => {
                // Remove trailing slashes except for the last part
                if (index < parts.length - 1) {
                    return part.replace(/\/+$/, '');
                }
                return part;
            })
            .join('/')
            .replace(/\/+/g, '/'); // Replace multiple slashes with single slash
    };
    
    // Auto-update raw path unless manually edited
    // Always construct as: {root}/{project}/raw
    if (!pathsManuallyEdited.raw) {
        const rawPath = joinPath(rootPath, projectName, 'raw');
        document.getElementById('config_raw_path').value = rawPath;
        updatePathIndicator('raw', false);
    }
    
    // Auto-update BIDS path unless manually edited
    // Always construct as: {root}/{project}/BIDS
    if (!pathsManuallyEdited.bids) {
        const bidsPath = joinPath(rootPath, projectName, 'BIDS');
        document.getElementById('config_bids_path').value = bidsPath;
        updatePathIndicator('bids', false);
    }
    
    // Auto-update calibration path unless manually edited
    if (!pathsManuallyEdited.calibration) {
        const calibrationPath = joinPath(rootPath, projectName, 'triux_files/sss/sss_cal.dat');
        document.getElementById('config_calibration_path').value = calibrationPath;
    }
    
    // Auto-update crosstalk path unless manually edited
    if (!pathsManuallyEdited.crosstalk) {
        const crosstalkPath = joinPath(rootPath, projectName, 'triux_files/ctc/ct_sparse.fif');
        document.getElementById('config_crosstalk_path').value = crosstalkPath;
    }
}

function collectConfigFromForm() {
    const projectName = document.getElementById('config_project_name').value;
    const rootPath = document.getElementById('config_root_path').value;
    const rawPath = document.getElementById('config_raw_path').value;
    const bidsPath = document.getElementById('config_bids_path').value;
    const calibrationPath = document.getElementById('config_calibration_path').value;
    const crosstalkPath = document.getElementById('config_crosstalk_path').value;
    
    // Helper to split comma-separated string into array, filtering empty values
    const splitToArray = (value) => value ? value.split(',').map(s => s.trim()).filter(s => s) : [];
    
    const tasksArray = splitToArray(document.getElementById('config_tasks').value);
    const authorsArray = splitToArray(document.getElementById('config_authors').value);
    const fundingArray = splitToArray(document.getElementById('config_funding').value);
    const ethicsArray = splitToArray(document.getElementById('config_ethics_approvals').value);
    const refsArray = splitToArray(document.getElementById('config_references_links').value);
    
    // Preserve fields from currentConfig that aren't in the form (like OPM, MaxFilter, etc.)
    const baseConfig = currentConfig || {};
    
    return {
        Project: {
            Name: projectName,
            'CIR-ID': document.getElementById('config_cir_id').value,
            Root: rootPath,
            Raw: rawPath,
            BIDS: bidsPath,
            Calibration: calibrationPath,
            Crosstalk: crosstalkPath,
            Tasks: tasksArray.length > 0 ? tasksArray : [],
            InstitutionName: 'Karolinska Institutet',
            InstitutionAddress: 'Nobels vag 9, 171 77, Stockholm, Sweden',
            InstitutionDepartmentName: 'Department of Clinical Neuroscience (CNS)',
            // Preserve additional Project fields from loaded config
            ...(baseConfig.Project && {
                Description: baseConfig.Project.Description,
                'Sinuhe raw': baseConfig.Project['Sinuhe raw'],
                'Kaptah raw': baseConfig.Project['Kaptah raw'],
                Logfile: baseConfig.Project.Logfile
            })
        },
        Dataset_description: {
            Name: document.getElementById('config_dataset_name').value || projectName,
            BIDSVersion: document.getElementById('config_bids_version').value || '1.7.0',
            DatasetType: document.getElementById('config_dataset_type').value || 'raw',
            License: document.getElementById('config_license').value || '',
            Authors: authorsArray.length > 0 ? authorsArray : [''],
            Acknowledgements: document.getElementById('config_acknowledgements').value || '',
            HowToAcknowledge: document.getElementById('config_how_to_acknowledge').value || '',
            Funding: fundingArray.length > 0 ? fundingArray : [''],
            EthicsApprovals: ethicsArray.length > 0 ? ethicsArray : [''],
            ReferencesAndLinks: refsArray.length > 0 ? refsArray : [''],
            DatasetDOI: document.getElementById('config_dataset_doi').value || 'doi:<insert_doi>',
            GeneratedBy: [
                {
                    Name: 'MNE-BIDS',
                    Version: '0.17.0',
                    CodeURL: document.getElementById('config_code_url').value || 'https://mne.tools/mne-bids/'
                }
            ]
        },
        BIDS: {
            Conversion_file: document.getElementById('config_conversion_file').value,
            overwrite: document.getElementById('config_overwrite').value === 'true',
            authors: document.getElementById('config_authors').value,
            data_license: document.getElementById('config_license').value,
            // Preserve additional BIDS fields from loaded config
            ...(baseConfig.BIDS && {
                Participants: baseConfig.BIDS.Participants,
                Participants_mapping_file: baseConfig.BIDS.Participants_mapping_file,
                Overwrite_conversion: baseConfig.BIDS.Overwrite_conversion,
                Original_subjID_name: baseConfig.BIDS.Original_subjID_name,
                New_subjID_name: baseConfig.BIDS.New_subjID_name,
                Original_session_name: baseConfig.BIDS.Original_session_name,
                New_session_name: baseConfig.BIDS.New_session_name,
                dataset_type: baseConfig.BIDS.dataset_type,
                acknowledgements: baseConfig.BIDS.acknowledgements,
                how_to_acknowledge: baseConfig.BIDS.how_to_acknowledge,
                funding: baseConfig.BIDS.funding,
                ethics_approvals: baseConfig.BIDS.ethics_approvals,
                references_and_links: baseConfig.BIDS.references_and_links,
                doi: baseConfig.BIDS.doi,
                Dataset_description: baseConfig.BIDS.Dataset_description
            })
        },
        // Preserve entire sections that have no form representation
        ...(baseConfig.OPM && { OPM: baseConfig.OPM }),
        ...(baseConfig.MaxFilter && { MaxFilter: baseConfig.MaxFilter }),
        RUN: {
            bidsify: true,
            maxfilter: false,
            add_hpi: false
        }
    };
}

function validateConfig() {
    const projectName = document.getElementById('config_project_name').value.trim();
    const rootPath = document.getElementById('config_root_path').value.trim();
    const rawPath = document.getElementById('config_raw_path').value.trim();
    const bidsPath = document.getElementById('config_bids_path').value.trim();
    const tasks = document.getElementById('config_tasks').value.trim();
    
    if (!projectName) {
        alert('⚠️ Please enter a project name');
        return false;
    }
    
    if (!tasks) {
        alert('⚠️ Please enter at least one task (comma-separated if multiple)');
        return false;
    }
    
    if (!rootPath) {
        alert('⚠️ Please enter a root path');
        return false;
    }
    
    if (!rawPath || !bidsPath) {
        alert('⚠️ Please fill in all required path fields (marked with *)');
        return false;
    }
    
    // Check for unresolved placeholders (excluding root path which can have <project>)
    if (rootPath.includes('<') || rootPath.includes('>') ||
        rawPath.includes('<') || rawPath.includes('>') || 
        bidsPath.includes('<') || bidsPath.includes('>')) {
        alert('⚠️ Paths contain placeholders like <project>.\n\nPlease enter the actual project name in the "Project Name" field to auto-fill the paths, or manually enter complete absolute paths.');
        return false;
    }
    
    // Check that paths are absolute
    const isAbsolute = (p) => {
        if (!p) return false;
        return p.startsWith('/') || p.match(/^[A-Z]:\\/);
    };
    
    if (!isAbsolute(rootPath)) {
        alert(`⚠️ Root Path must be absolute (starting with / on Unix or C:\\ on Windows)\n\nCurrent value: ${rootPath}`);
        return false;
    }
    
    if (!isAbsolute(rawPath)) {
        alert(`⚠️ Raw Data Path must be absolute (starting with / on Unix or C:\\ on Windows)\n\nCurrent value: ${rawPath}`);
        return false;
    }
    
    if (!isAbsolute(bidsPath)) {
        alert(`⚠️ BIDS Output Path must be absolute (starting with / on Unix or C:\\ on Windows)\n\nCurrent value: ${bidsPath}`);
        return false;
    }
    
    return true;
}

// Step 2: Analyse Data Structure
async function runAnalysis() {
    if (!validateConfig()) {
        return;
    }
    
    const config = collectConfigFromForm();
    const progressContainer = document.getElementById('analyseProgressContainer');
    const progressBar = document.getElementById('analyseProgressBar');
    const progressText = document.getElementById('analyseProgressText');
    const consoleOutput = document.getElementById('analyseConsole');
    const runButton = document.getElementById('runAnalyseBtn');
    const nextButton = document.getElementById('nextToEditorBtn');
    
    // Update UI
    runButton.disabled = true;
    progressContainer.style.display = 'block';
    progressText.style.display = 'block';
    consoleOutput.style.display = 'block';
    consoleOutput.innerHTML = '';
    progressBar.style.width = '10%';
    progressText.textContent = 'Analysing data structure...';
    
    // Pass config without modifications - onlyTable flag will be passed to Python as command-line argument
    
    if (window.electronAPI) {
        try {
            const result = await window.electronAPI.runBidsify(config, true, (data) => {
                appendToConsole('analyseConsole', data.line);
                if (data.progress) {
                    progressBar.style.width = data.progress + '%';
                }
            });
            
            if (result.success) {
                progressBar.style.width = '100%';
                progressText.textContent = '✅ Analysis completed successfully';
                analysisComplete = true;
                nextButton.disabled = false;
                appendToConsole('analyseConsole', '\n✅ Conversion table generated successfully', 'success');
                
                // Automatically load the conversion table in the editor
                if (result.conversionTablePath) {
                    loadConversionTableInEditor(result.conversionTablePath);
                }
            } else {
                progressText.textContent = '❌ Analysis failed';
                appendToConsole('analyseConsole', '\n❌ ERROR: ' + result.error, 'error');
            }
        } catch (error) {
            progressText.textContent = '❌ Analysis failed';
            appendToConsole('analyseConsole', '\n❌ ERROR: ' + error.message, 'error');
        } finally {
            runButton.disabled = false;
        }
    }
}

// Step 3: Editor - Conversion Table Management
let editorData = {
    allRows: [],
    filteredRows: [],
    currentFilePath: null,
    modifiedRows: new Set(),
    columns: []
};

// Load conversion table into editor
async function loadConversionTableInEditor(tsvPath) {
    try {
        // Wait a bit for the file to be written
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Load the file content
        const fileData = await window.electronAPI.loadConversionTable(tsvPath);
        if (fileData && fileData.content) {
            editorData.currentFilePath = tsvPath;
            currentTablePath = tsvPath;  // Set for reload functionality
            parseAndDisplayTable(fileData.content);
            
            // Enable reload button
            document.getElementById('reloadTableBtn').disabled = false;
            
            console.log('✅ Conversion table loaded into editor:', tsvPath);
            appendToConsole('analyseConsole', `\n📄 Conversion table loaded in editor`, 'success');
        } else {
            throw new Error('File content is empty or file not found');
        }
    } catch (error) {
        console.error('Error loading conversion table in editor:', error);
        appendToConsole('analyseConsole', `\n⚠️ Could not auto-load conversion table: ${error.message}`, 'warning');
        showEditorError('Could not load conversion table: ' + error.message);
    }
}

function parseAndDisplayTable(tsvContent) {
    const loading = document.getElementById('editorLoading');
    const table = document.getElementById('conversionTable');
    const errorDiv = document.getElementById('editorError');
    
    loading.style.display = 'block';
    table.style.display = 'none';
    errorDiv.style.display = 'none';
    
    try {
        // Parse TSV
        const lines = tsvContent.trim().split('\n');
        const headers = lines[0].split('\t');
        editorData.columns = headers;
        
        editorData.allRows = lines.slice(1).map((line, index) => {
            const values = line.split('\t');
            const obj = { _index: index };
            headers.forEach((header, i) => {
                obj[header] = values[i] || '';
            });
            return obj;
        });
        
        // Reset filters and display
        editorData.filteredRows = [...editorData.allRows];
        editorData.modifiedRows.clear();
        
        // Populate filter dropdowns
        populateFilterDropdowns();
        
        renderEditorTable();
        
        loading.style.display = 'none';
        table.style.display = 'table';
        document.getElementById('saveTableBtn').disabled = true;
        
        updateEditorRowCount();
        
        // Setup interactive features
        setupSelectAllCheckbox();
        setupBatchActions();
        setupColumnSorting();
    } catch (error) {
        loading.style.display = 'none';
        showEditorError('Error parsing table: ' + error.message);
    }
}

function populateFilterDropdowns() {
    // Get unique values for each filter
    const subjects = new Set();
    const sessions = new Set();
    const tasks = new Set();
    const acquisitions = new Set();
    
    editorData.allRows.forEach(row => {
        if (row.participant_to) subjects.add(row.participant_to);
        if (row.session_to) sessions.add(row.session_to);
        if (row.task) tasks.add(row.task);
        if (row.acquisition) acquisitions.add(row.acquisition);
    });
    
    // Populate Subject filter
    const subjectSelect = document.getElementById('subjectFilterSelect');
    subjectSelect.innerHTML = '<option value="">All Subjects</option>';
    Array.from(subjects).sort().forEach(val => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        subjectSelect.appendChild(opt);
    });
    
    // Populate Session filter
    const sessionSelect = document.getElementById('sessionFilterSelect');
    sessionSelect.innerHTML = '<option value="">All Sessions</option>';
    Array.from(sessions).sort().forEach(val => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        sessionSelect.appendChild(opt);
    });
    
    // Populate Task filter - show config tasks first, then "Other"
    const taskSelect = document.getElementById('taskFilterSelect');
    taskSelect.innerHTML = '<option value="">All Tasks</option>';
    
    // Get tasks from config
    const configTasks = currentConfig?.Project?.Tasks || [];
    const allTasks = Array.from(tasks).sort();
    
    // Add config tasks first
    configTasks.forEach(configTask => {
        if (allTasks.includes(configTask)) {
            const opt = document.createElement('option');
            opt.value = configTask;
            opt.textContent = configTask;
            taskSelect.appendChild(opt);
        }
    });
    
    // Check if there are any tasks not in config
    const otherTasks = allTasks.filter(task => !configTasks.includes(task));
    if (otherTasks.length > 0) {
        // Add separator
        const separator = document.createElement('option');
        separator.disabled = true;
        separator.textContent = '──────────';
        taskSelect.appendChild(separator);
        
        // Add "Other" option to show all non-config tasks
        const otherOpt = document.createElement('option');
        otherOpt.value = '__OTHER__';
        otherOpt.textContent = 'Other (non-config tasks)';
        taskSelect.appendChild(otherOpt);
    }
    
    // Populate Acquisition filter
    const acquisitionSelect = document.getElementById('acquisitionFilterSelect');
    acquisitionSelect.innerHTML = '<option value="">All Acquisitions</option>';
    Array.from(acquisitions).sort().forEach(val => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        acquisitionSelect.appendChild(opt);
    });
}

function renderEditorTable() {
    const tbody = document.getElementById('conversionTableBody');
    tbody.innerHTML = '';
    
    editorData.filteredRows.forEach((row) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #e0e0e0';
        tr.dataset.index = row._index;
        
        if (editorData.modifiedRows.has(row._index)) {
            tr.style.background = '#fff3e0';
        }
        
        // Checkbox column
        const checkboxTd = document.createElement('td');
        checkboxTd.style.padding = '8px 12px';
        checkboxTd.style.textAlign = 'center';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'row-checkbox';
        checkbox.dataset.index = row._index;
        checkbox.style.cursor = 'pointer';
        checkbox.onchange = updateSelectedCount;
        checkboxTd.appendChild(checkbox);
        tr.appendChild(checkboxTd);
        
        // Status (editable dropdown)
        const statusTd = document.createElement('td');
        statusTd.style.padding = '8px 12px';
        const statusSelect = document.createElement('select');
        statusSelect.style.width = '100%';
        statusSelect.style.padding = '4px 8px';
        statusSelect.style.border = '1px solid #ddd';
        statusSelect.style.borderRadius = '4px';
        ['run', 'processed', 'check', 'skip'].forEach(val => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            opt.selected = row.status === val;
            statusSelect.appendChild(opt);
        });
        statusSelect.onchange = () => {
            row.status = statusSelect.value;
            markRowModified(row._index);
        };
        statusTd.appendChild(statusSelect);
        tr.appendChild(statusTd);
        
        // Subject (from participant_to)
        const subjectTd = document.createElement('td');
        subjectTd.style.padding = '8px 12px';
        subjectTd.textContent = row.participant_to || '';
        tr.appendChild(subjectTd);
        
        // Session (from session_to)
        const sessionTd = document.createElement('td');
        sessionTd.style.padding = '8px 12px';
        sessionTd.textContent = row.session_to || '';
        tr.appendChild(sessionTd);
        
        // Task (editable with auto-update BIDS name)
        const taskTd = document.createElement('td');
        taskTd.style.padding = '8px 12px';
        const taskInput = document.createElement('input');
        taskInput.type = 'text';
        taskInput.value = row.task || '';
        taskInput.style.width = '100%';
        taskInput.style.padding = '4px 8px';
        taskInput.style.border = '1px solid #ddd';
        taskInput.style.borderRadius = '4px';
        taskInput.oninput = () => {
            const oldTask = row.task;
            row.task = taskInput.value;
            // Auto-update BIDS filename
            if (row.bids_name && oldTask) {
                row.bids_name = row.bids_name.replace(`_task-${oldTask}_`, `_task-${taskInput.value}_`);
                const bidsCell = tr.querySelector('td:nth-last-child(1)');
                if (bidsCell) bidsCell.textContent = row.bids_name;
            }
            markRowModified(row._index);
        };
        taskTd.appendChild(taskInput);
        tr.appendChild(taskTd);
        
        // Acquisition
        const acqTd = document.createElement('td');
        acqTd.style.padding = '8px 12px';
        acqTd.textContent = row.acquisition || '';
        tr.appendChild(acqTd);
        
        // Run (editable)
        const runTd = document.createElement('td');
        runTd.style.padding = '8px 12px';
        const runInput = document.createElement('input');
        runInput.type = 'text';
        runInput.value = row.run || '';
        runInput.style.width = '100%';
        runInput.style.padding = '4px 8px';
        runInput.style.border = '1px solid #ddd';
        runInput.style.borderRadius = '4px';
        runInput.oninput = () => {
            row.run = runInput.value;
            markRowModified(row._index);
        };
        runTd.appendChild(runInput);
        tr.appendChild(runTd);
        
        // Split (read-only, auto-managed)
        const splitTd = document.createElement('td');
        splitTd.style.padding = '8px 12px';
        splitTd.style.color = '#666';
        splitTd.textContent = row.split || '';
        tr.appendChild(splitTd);
        
        // Processing
        const procTd = document.createElement('td');
        procTd.style.padding = '8px 12px';
        procTd.textContent = row.processing || '';
        tr.appendChild(procTd);
        
        // Description (editable)
        const descTd = document.createElement('td');
        descTd.style.padding = '8px 12px';
        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.value = row.description || '';
        descInput.style.width = '100%';
        descInput.style.padding = '4px 8px';
        descInput.style.border = '1px solid #ddd';
        descInput.style.borderRadius = '4px';
        descInput.oninput = () => {
            row.description = descInput.value;
            markRowModified(row._index);
        };
        descTd.appendChild(descInput);
        tr.appendChild(descTd);
        
        // Raw file
        const rawTd = document.createElement('td');
        rawTd.style.padding = '8px 12px';
        rawTd.style.fontSize = '12px';
        rawTd.style.color = '#666';
        rawTd.textContent = row.raw_name || '';
        rawTd.title = row.raw_path || '';
        tr.appendChild(rawTd);
        
        // BIDS file
        const bidsTd = document.createElement('td');
        bidsTd.style.padding = '8px 12px';
        bidsTd.style.fontSize = '12px';
        bidsTd.style.color = '#666';
        bidsTd.textContent = row.bids_name || '';
        bidsTd.title = row.bids_path || '';
        tr.appendChild(bidsTd);
        
        tbody.appendChild(tr);
    });
    
    updateSelectedCount();
}

function markRowModified(index) {
    editorData.modifiedRows.add(index);
    document.getElementById('saveTableBtn').disabled = false;
    
    // Highlight the row
    const tr = document.querySelector(`tr[data-index="${index}"]`);
    if (tr) {
        tr.style.background = '#fff3e0';
    }
}

function updateSelectedCount() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    const count = checkboxes.length;
    const countSpan = document.getElementById('selectedCount');
    const batchDiv = document.getElementById('batchActionsDiv');
    
    if (countSpan) {
        countSpan.textContent = `${count} row${count !== 1 ? 's' : ''} selected`;
    }
    
    // Show/hide batch actions div
    if (batchDiv) {
        batchDiv.style.display = count > 0 ? 'block' : 'none';
    }
}

function setupSelectAllCheckbox() {
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    if (selectAllCheckbox) {
        selectAllCheckbox.onchange = function() {
            const checkboxes = document.querySelectorAll('.row-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = selectAllCheckbox.checked;
            });
            updateSelectedCount();
        };
    }
}

function setupBatchActions() {
    const applyBtn = document.getElementById('applyBatchStatusBtn');
    const statusSelect = document.getElementById('batchStatusSelect');
    
    if (applyBtn && statusSelect) {
        applyBtn.onclick = function() {
            const newStatus = statusSelect.value;
            if (!newStatus) {
                alert('Please select a status first');
                return;
            }
            
            const checkboxes = document.querySelectorAll('.row-checkbox:checked');
            checkboxes.forEach(cb => {
                const index = parseInt(cb.dataset.index);
                const row = editorData.allRows.find(r => r._index === index);
                if (row) {
                    row.status = newStatus;
                    markRowModified(index);
                }
            });
            
            // Uncheck all and re-render
            document.getElementById('selectAllCheckbox').checked = false;
            checkboxes.forEach(cb => cb.checked = false);
            renderEditorTable();
            updateSelectedCount();
            
            alert(`Updated ${checkboxes.length} row(s) to status: ${newStatus}`);
        };
    }
}

let editorSortState = {
    column: null,
    ascending: true
};

function setupColumnSorting() {
    const headers = document.querySelectorAll('#conversionTable thead th[data-sort]');
    headers.forEach(header => {
        header.onclick = function() {
            const sortKey = header.dataset.sort;
            
            // Toggle sort direction if same column, otherwise reset to ascending
            if (editorSortState.column === sortKey) {
                editorSortState.ascending = !editorSortState.ascending;
            } else {
                editorSortState.column = sortKey;
                editorSortState.ascending = true;
            }
            
            // Sort the filtered rows
            editorData.filteredRows.sort((a, b) => {
                const aVal = (a[sortKey] || '').toString().toLowerCase();
                const bVal = (b[sortKey] || '').toString().toLowerCase();
                
                if (aVal < bVal) return editorSortState.ascending ? -1 : 1;
                if (aVal > bVal) return editorSortState.ascending ? 1 : -1;
                return 0;
            });
            
            // Update all header arrows
            headers.forEach(h => {
                const arrow = h.querySelector('span');
                if (h.dataset.sort === sortKey) {
                    arrow.textContent = editorSortState.ascending ? '▲' : '▼';
                } else {
                    arrow.textContent = '▼';
                }
            });
            
            renderEditorTable();
        };
    });
}

function filterEditorTable() {
    const searchText = document.getElementById('editorSearchInput').value.toLowerCase();
    const statusFilter = document.getElementById('statusFilterSelect').value;
    const subjectFilter = document.getElementById('subjectFilterSelect').value;
    const sessionFilter = document.getElementById('sessionFilterSelect').value;
    const taskFilter = document.getElementById('taskFilterSelect').value;
    const acquisitionFilter = document.getElementById('acquisitionFilterSelect').value;
    
    // Get config tasks for "Other" filter
    const configTasks = currentConfig?.Project?.Tasks || [];
    
    editorData.filteredRows = editorData.allRows.filter(row => {
        // Status filter
        if (statusFilter && row.status !== statusFilter) {
            return false;
        }
        
        // Subject filter
        if (subjectFilter && row.participant_to !== subjectFilter) {
            return false;
        }
        
        // Session filter
        if (sessionFilter && row.session_to !== sessionFilter) {
            return false;
        }
        
        // Task filter
        if (taskFilter) {
            if (taskFilter === '__OTHER__') {
                // Show only tasks that are NOT in config
                if (!row.task || configTasks.includes(row.task)) {
                    return false;
                }
            } else if (row.task !== taskFilter) {
                return false;
            }
        }
        
        // Acquisition filter
        if (acquisitionFilter && row.acquisition !== acquisitionFilter) {
            return false;
        }
        
        // Search filter
        if (searchText) {
            const searchableText = [
                row.participant_to,
                row.session_to,
                row.task,
                row.acquisition,
                row.processing,
                row.description,
                row.raw_name,
                row.bids_name
            ].join(' ').toLowerCase();
            
            if (!searchableText.includes(searchText)) {
                return false;
            }
        }
        
        return true;
    });
    
    renderEditorTable();
    updateEditorRowCount();
}

function clearEditorFilters() {
    document.getElementById('editorSearchInput').value = '';
    document.getElementById('statusFilterSelect').value = '';
    document.getElementById('subjectFilterSelect').value = '';
    document.getElementById('sessionFilterSelect').value = '';
    document.getElementById('taskFilterSelect').value = '';
    document.getElementById('acquisitionFilterSelect').value = '';
    filterEditorTable();
}

function updateEditorRowCount() {
    const countDiv = document.getElementById('editorRowCount');
    if (editorData.allRows.length === 0) {
        countDiv.textContent = 'No data loaded';
    } else {
        countDiv.textContent = `Showing ${editorData.filteredRows.length} of ${editorData.allRows.length} rows`;
        if (editorData.modifiedRows.size > 0) {
            countDiv.textContent += ` (${editorData.modifiedRows.size} modified)`;
        }
    }
}

async function saveEditorTable() {
    if (!editorData.currentFilePath) {
        showEditorError('No file loaded');
        return;
    }
    
    try {
        // Convert back to TSV
        const tsvLines = [
            editorData.columns.join('\t'),
            ...editorData.allRows.map(row => 
                editorData.columns.map(col => row[col] || '').join('\t')
            )
        ];
        const tsvContent = tsvLines.join('\n');
        
        // Save using Electron API
        const result = await window.electronAPI.saveFile(editorData.currentFilePath, tsvContent);
        
        if (result.success) {
            editorData.modifiedRows.clear();
            document.getElementById('saveTableBtn').disabled = true;
            
            // Remove highlighting
            document.querySelectorAll('#conversionTableBody tr').forEach(tr => {
                tr.style.background = '';
            });
            
            alert('✅ Changes saved successfully');
        } else {
            throw new Error(result.error || 'Failed to save');
        }
    } catch (error) {
        showEditorError('Error saving: ' + error.message);
    }
}

// Track loaded table path for reload functionality
let currentTablePath = null;

async function loadEditorTable() {
    if (window.electronAPI) {
        const fileData = await window.electronAPI.openFile();
        if (fileData && fileData.content) {
            editorData.currentFilePath = fileData.path;
            currentTablePath = fileData.path;
            parseAndDisplayTable(fileData.content);
            // Enable reload button
            document.getElementById('reloadTableBtn').disabled = false;
        }
    }
}

async function reloadEditorTable() {
    if (!currentTablePath) {
        alert('⚠️ No table loaded. Please load a table first.');
        return;
    }
    
    // Check if there are unsaved changes
    if (editorData.modifiedRows.size > 0) {
        const confirmReload = confirm('⚠️ You have unsaved changes. Reloading will discard them. Continue?');
        if (!confirmReload) {
            return;
        }
    }
    
    const reloadBtn = document.getElementById('reloadTableBtn');
    const originalText = reloadBtn.innerHTML;
    
    try {
        reloadBtn.innerHTML = '⏳ Reloading...';
        reloadBtn.disabled = true;
        document.getElementById('editorLoading').style.display = 'block';
        document.getElementById('editorError').style.display = 'none';
        
        // Read the file again
        const fileContent = await window.electronAPI.readFile(currentTablePath);
        if (fileContent) {
            parseAndDisplayTable(fileContent);
            console.log('✅ Table reloaded successfully');
            
            // Show success message briefly
            reloadBtn.innerHTML = '✅ Reloaded';
            setTimeout(() => {
                reloadBtn.innerHTML = originalText;
            }, 2000);
        }
    } catch (error) {
        showEditorError(`Failed to reload table: ${error.message}`);
        console.error('Error reloading table:', error);
        reloadBtn.innerHTML = originalText;
    } finally {
        document.getElementById('editorLoading').style.display = 'none';
        reloadBtn.disabled = false;
    }
}

function showEditorError(message) {
    const errorDiv = document.getElementById('editorError');
    errorDiv.textContent = '❌ ' + message;
    errorDiv.style.display = 'block';
}

// Initialize editor event handlers
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('loadTableBtn').addEventListener('click', loadEditorTable);
    document.getElementById('reloadTableBtn').addEventListener('click', reloadEditorTable);
    document.getElementById('saveTableBtn').addEventListener('click', saveEditorTable);
    document.getElementById('editorSearchInput').addEventListener('input', filterEditorTable);
    document.getElementById('statusFilterSelect').addEventListener('change', filterEditorTable);
    document.getElementById('subjectFilterSelect').addEventListener('change', filterEditorTable);
    document.getElementById('sessionFilterSelect').addEventListener('change', filterEditorTable);
    document.getElementById('taskFilterSelect').addEventListener('change', filterEditorTable);
    document.getElementById('acquisitionFilterSelect').addEventListener('change', filterEditorTable);
    document.getElementById('clearFiltersBtn').addEventListener('click', clearEditorFilters);
});

// Step 4: Execute Conversion
async function runBidsification() {
    // Do not change the current view when starting execution – keep the user in the
    // Execute view so they can stay on the same step while conversion runs.
    if (!validateConfig()) {
        return;
    }
    
    const config = collectConfigFromForm();
    const progressContainer = document.getElementById('executeProgressContainer');
    const progressBar = document.getElementById('executeProgressBar');
    const progressText = document.getElementById('executeProgressText');
    const consoleOutput = document.getElementById('executeConsole');
    const runButton = document.getElementById('runBidsifyBtn');
    const nextButton = document.getElementById('nextToReportBtn');
    
    // Update UI
    runButton.disabled = true;
    progressContainer.style.display = 'block';
    progressText.style.display = 'block';
    consoleOutput.style.display = 'block';
    consoleOutput.innerHTML = '';
    progressBar.style.width = '10%';
    progressText.textContent = 'Executing BIDS conversion...';
    
    if (window.electronAPI) {
        try {
            const result = await window.electronAPI.runBidsify(config, false, (data) => {
                appendToConsole('executeConsole', data.line);
                if (data.progress) {
                    progressBar.style.width = data.progress + '%';
                }
            });
            
            if (result.success) {
                progressBar.style.width = '100%';
                progressText.textContent = '✅ Conversion completed successfully';
                executionComplete = true;
                nextButton.disabled = false;
                appendToConsole('executeConsole', '\n✅ BIDS conversion completed successfully', 'success');
            } else {
                progressText.textContent = '❌ Conversion failed';
                appendToConsole('executeConsole', '\n❌ ERROR: ' + result.error, 'error');
            }
        } catch (error) {
            progressText.textContent = '❌ Conversion failed';
            appendToConsole('executeConsole', '\n❌ ERROR: ' + error.message, 'error');
        } finally {
            runButton.disabled = false;
        }
    }
}

// Step 5: Generate Report
async function generateReport() {
    const detailsDiv = document.getElementById('report-details');

    // Try to load the canonical bids_results.json report only
    const projectRoot = currentConfig?.Project?.Root && currentConfig?.Project?.Name 
        ? `${currentConfig.Project.Root}/${currentConfig.Project.Name}` 
        : null;

    if (!projectRoot) {
        detailsDiv.innerHTML = `
            <h3 style="color: #860052; margin-bottom: 15px;">Conversion Details</h3>
            <p style="color: #666;">⚠️ Unable to load report: Project path not configured</p>
        `;
        return;
    }

    const bidsResultsPath = `${projectRoot}/logs/bids_results.json`;

    // Load combined bids_results.json if present (it will include 'Report Table' and 'BIDS Tree')
    let summaryObj = null;
    try {
        // Load the canonical combined report only
        const summaryContent = await window.electronAPI.readFile(bidsResultsPath);
        summaryObj = JSON.parse(summaryContent);
    } catch (e) {
        // If not present or invalid, set summaryObj to null and fall back to console parsing later
        summaryObj = null;
    }

    // Now try to load bids_results.json for details
    try {
        const fileContent = await window.electronAPI.readFile(bidsResultsPath);
        const bidsResultsRaw = JSON.parse(fileContent);

        // Accept either an array of rows or a dict with 'Report Table'
        const rows = Array.isArray(bidsResultsRaw) ? bidsResultsRaw : (bidsResultsRaw && bidsResultsRaw['Report Table'] ? bidsResultsRaw['Report Table'] : []);

        // Calculate statistics from bids_results
        const totalFiles = rows.length;
        // Files considered converted are those with Conversion Status === 'processed' (case-insensitive)
        // Accept both 'processed' and legacy 'success' as completed conversions
        const successfulConversions = rows.filter(r => {
            const s = (r['Conversion Status'] || '').toString().toLowerCase();
            return s === 'processed' || s === 'success';
        }).length;
        // Errors are entries where Conversion Status === 'error'
        const failedConversions = rows.filter(r => (r['Conversion Status'] || '').toString().toLowerCase() === 'error').length;

        // Get unique subjects and sessions
        const subjects = new Set(rows.map(r => r.Participant).filter(p => p));
        const sessions = new Set(rows.map(r => r.Session).filter(s => s));

        // Update statistics
        document.getElementById('stat-files-converted').textContent = successfulConversions.toString();
        document.getElementById('stat-subjects').textContent = subjects.size.toString();
        document.getElementById('stat-sessions').textContent = sessions.size.toString();
        document.getElementById('stat-errors').textContent = failedConversions.toString();

        // Group by task and acquisition for summary
        const taskStats = {};
        const acquisitionStats = {};

        rows.forEach(entry => {
            const task = entry.Task || 'Unknown';
            const acq = entry.Acquisition || 'Unknown';

            if (!taskStats[task]) taskStats[task] = 0;
            if (!acquisitionStats[acq]) acquisitionStats[acq] = 0;

            taskStats[task]++;
            acquisitionStats[acq]++;
        });

        // Calculate total file sizes
        const totalSourceSize = rows.reduce((sum, r) => sum + (r['Source Size'] || 0), 0);
        const totalBidsSize = rows.reduce((sum, r) => sum + (r['BIDS Size'] || 0), 0);

        const formatBytes = (bytes) => {
            if (!bytes) return 'N/A';
            const gb = bytes / (1024 * 1024 * 1024);
            return `${gb.toFixed(2)} GB`;
        };

        // Friendly date formatter for timestamps present in the report
        function formatDate(val) {
            if (!val) return '';
            try {
                // If value is a compact YYYYMMDD (string of 8 digits), return YYYY-MM-DD
                if (/^\d{8}$/.test(val)) {
                    const y = val.slice(0, 4);
                    const m = val.slice(4, 6);
                    const d = val.slice(6, 8);
                    return `${y}-${m}-${d}`;
                }

                // Try Date parse (ISO or others) and format as YYYY-MM-DD HH:mm:ss
                const t = Date.parse(val);
                if (!isNaN(t)) {
                    const dt = new Date(t);
                    const pad = (n) => String(n).padStart(2, '0');
                    return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
                }

                // If it's already a JS Date
                if (val instanceof Date) {
                    const dt = val;
                    const pad = (n) => String(n).padStart(2, '0');
                    return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
                }

                // last fallback
                return val.toString();
            } catch (e) {
                return val.toString();
            }
        }


        // Helper to render BIDS tree as expandable/collapsible HTML with conversion date
        // Helper SVG icons (monochrome) for consistent cross-platform rendering
        const CHECK_SVG = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="validation-svg">
                <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.12" />
                <path d="M7 12.5l2.5 2.5L17 8.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
        `;

        const WARNING_SVG = `
            <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="validation-svg">
                <path d="M1 21h22L12 2 1 21z" fill="currentColor" fill-opacity="0.12" />
                <path d="M12 9v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                <path d="M12 17h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
        `;

        // Inject small CSS to make icons monochrome and consistent
        if (!document.getElementById('bids-validation-icons-style')) {
            const style = document.createElement('style');
            style.id = 'bids-validation-icons-style';
            style.textContent = `
                /* Monochrome validation icons: color controlled via CSS (default: dark gray) */
                .validation-icon { display:inline-flex; vertical-align:middle; margin-left:8px; color: #444; }
                .validation-icon.valid { /* Keep classes for custom theming if needed */ }
                .validation-icon.invalid { /* Keep classes for custom theming if needed */ }
                .validation-icon.none { color: #999; }
                .validation-svg { display:block; }
            `;
            document.head.appendChild(style);
        }
        function renderBidsTreeExpandable(node, level = 0, parentId = '') {
            if (!node) return '';
            // Prefix IDs to avoid starting with a digit/underscore and ensure uniqueness
            const nodeId = 'node_' + (parentId ? parentId + '_' : '') + (node.name || 'root').replace(/[^a-zA-Z0-9]/g, '') + '_' + level;
            const indent = '&nbsp;'.repeat(level * 2);
            // Show date if present (try both 'conversion_date' and 'date')
            // Support several different timestamp field names and format for display
            let dateVal = node['conversion_date'] || node['date'] || node['timestamp'] || node['Processing Date'] || '';
            let dateStr = dateVal ? `<span style="color:#888; font-size:11px; margin-left:8px;">${formatDate(dateVal)}</span>` : '';
            let badge = '';
            // Show icon-only badges for validation: green check for valid, yellow warning for invalid.
            // Keep a title attribute for accessibility but do not include text in the badge itself.
            if (node.validation === 'True BIDS') badge = `<span class="validation-icon valid" title="Valid" role="img" aria-label="Valid">${CHECK_SVG}</span>`;
            else if (node.validation === 'False BIDS') badge = `<span class="validation-icon invalid" title="Invalid" role="img" aria-label="Invalid">${WARNING_SVG}</span>`;
            else badge = `<span class="validation-icon none" title="Unknown validation" role="img" aria-label="Unknown"></span>`;

            if (node.type === 'directory') {
                const hasChildren = node.children && node.children.length > 0;
                // By default, directories are expanded
                return `
                    <div style="margin-left: ${level * 16}px;">
                        <span class="tree-toggle" data-target="${nodeId}" style="cursor: pointer; user-select: none; font-weight: bold; color: #860052; display:inline-flex; align-items:center; gap:6px;">
                            ${hasChildren ? `<span class=\"tree-arrow\" id=\"arrow_${nodeId}\" style=\"display:inline-block;width:16px;\">▼</span>` : ''} ${indent}${node.name}/
                        </span>
                        ${dateStr}
                        ${badge}
                        <div id="${nodeId}" data-level="${level + 1}" class="tree-children" style="margin-left: 0;">
                            ${hasChildren ? node.children.map(child => renderBidsTreeExpandable(child, level + 1, nodeId)).join('') : ''}
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div style="margin-left: ${level * 16}px;">
                        <span>${indent}${node.name}</span> ${dateStr} ${badge}
                    </div>
                `;
            }
        }

        // Build the BIDS tree: prefer summaryObj['BIDS Tree'], but if not present
        // we can derive the tree from the 'Report Table' rows by parsing 'BIDS File' paths
        let bidsTreeHtml = '';
        const rowsTable = summaryObj && summaryObj['Report Table'] ? summaryObj['Report Table'] : [];

        function buildTreeFromRows(rows) {
            const root = { name: 'BIDS', path: 'BIDS', type: 'directory', children: [] };

            function findOrCreateChild(parent, name, type='directory') {
                let child = (parent.children || []).find(c => c.name === name && c.type === type);
                if (!child) {
                    child = { name, type, path: (parent.path ? (parent.path + '/' + name) : name), children: [] };
                    parent.children = parent.children || [];
                    parent.children.push(child);
                }
                return child;
            }

            rows.forEach(row => {
                const bidsFiles = Array.isArray(row['BIDS File']) ? row['BIDS File'] : (row['BIDS File'] ? [row['BIDS File']] : []);
                const validation = row['Validated'] || row['Validation'] || null;
                const dateVal = row['timestamp'] || row['Processing Date'] || null;

                bidsFiles.forEach(bf => {
                    if (!bf) return;
                    // Find relative path under 'BIDS'
                    const idx = bf.indexOf('/BIDS/');
                    let rel = idx !== -1 ? bf.substring(idx + 6) : bf;
                    // Normalize leading slash
                    if (rel.startsWith('/')) rel = rel.substring(1);
                    const parts = rel.split('/');

                    // Walk the tree and create nodes
                    let parent = root;
                    for (let i = 0; i < parts.length; i++) {
                        const part = parts[i];
                        const isFile = i === parts.length - 1;
                        if (isFile) {
                            const node = findOrCreateChild(parent, part, 'file');
                            node.validation = validation;
                            node.conversion_date = node.conversion_date || dateVal;
                            node.fullpath = bf;
                        } else {
                            parent = findOrCreateChild(parent, part, 'directory');
                        }
                    }
                });
            });

            // Aggregate validation & latest date for directories
            function aggregate(node) {
                if (node.type === 'file') {
                    return { validation: node.validation || null, dateMs: parseDateMs(node.conversion_date) };
                }
                let allValid = true;
                let anyValid = false;
                let anyInvalid = false;
                let latest = 0;
                (node.children || []).forEach(child => {
                    const res = aggregate(child);
                    if (res.validation === 'True BIDS') anyValid = true;
                    if (res.validation === 'False BIDS') anyInvalid = true;
                    if (res.validation !== 'True BIDS') allValid = false;
                    if (res.dateMs && res.dateMs > latest) latest = res.dateMs;
                });

                if (allValid && anyValid) node.validation = 'True BIDS';
                else if (anyInvalid) node.validation = 'False BIDS';
                else node.validation = 'N/A';

                if (latest) node.conversion_date = new Date(latest).toISOString();
                return { validation: node.validation, dateMs: latest };
            }

            aggregate(root);
            return root;
        }

        // parse date for directory aggregation
        function parseDateMs(val) {
            if (!val) return null;
            // YYYYMMDD
            if (/^\d{8}$/.test(val)) {
                const y = Number(val.slice(0,4));
                const m = Number(val.slice(4,6)) - 1;
                const d = Number(val.slice(6,8));
                return new Date(y, m, d).getTime();
            }
            const t = Date.parse(val);
            return isNaN(t) ? null : t;
        }

        let treeObj = summaryObj && summaryObj['BIDS Tree'] ? summaryObj['BIDS Tree'] : null;
        if (!treeObj && rowsTable && rowsTable.length > 0) {
            try {
                treeObj = buildTreeFromRows(rowsTable);
            } catch (e) {
                console.error('Failed to derive BIDS tree from report rows:', e);
                treeObj = null;
            }
        }

        if (treeObj) {
            bidsTreeHtml = `
                <h4 style="color: #860052; margin: 20px 0 10px;">BIDS Directory Structure & Validation</h4>
                <div id="bids-tree-expandable" style="background: #f8f8f8; border-radius: 8px; padding: 12px 18px; max-height: 400px; overflow-y: auto;">
                    ${renderBidsTreeExpandable(treeObj)}
                </div>
            `;
        }

        // Generate detailed report with BIDS tree only (tree is expandable, shows conversion date)
        detailsDiv.innerHTML = `
            <h3 style="color: #860052; margin-bottom: 15px;">Conversion Details</h3>
            <div style="color: #555; line-height: 1.8;">
                <p><strong>Project:</strong> ${currentConfig?.Project?.Name || 'N/A'}</p>
                <p><strong>Raw Data Path:</strong> ${currentConfig?.Project?.Raw || 'N/A'}</p>
                <p><strong>BIDS Output Path:</strong> ${currentConfig?.Project?.BIDS || 'N/A'}</p>
                <p><strong>Conversion Status:</strong> ${executionComplete ? '✅ Completed' : '⚠️ Incomplete'}</p>
                <p><strong>Total Conversions:</strong> ${totalFiles} files (${successfulConversions} successful, ${failedConversions} failed)</p>
                <p><strong>Total Source Size:</strong> ${formatBytes(totalSourceSize)}</p>
                <p><strong>Total BIDS Size:</strong> ${formatBytes(totalBidsSize)}</p>

                <hr style="margin: 20px 0; border: none; border-top: 1px solid #e0e0e0;">

                <h4 style="color: #860052; margin: 15px 0 10px;">Tasks</h4>
                <ul style="margin: 0; padding-left: 20px;">
                    ${Object.entries(taskStats).map(([task, count]) => 
                        `<li><strong>${task}:</strong> ${count} file(s)</li>`
                    ).join('')}
                </ul>

                <h4 style="color: #860052; margin: 15px 0 10px;">Acquisitions</h4>
                <ul style="margin: 0; padding-left: 20px;">
                    ${Object.entries(acquisitionStats).map(([acq, count]) => 
                        `<li><strong>${acq}:</strong> ${count} file(s)</li>`
                    ).join('')}
                </ul>

                <hr style="margin: 20px 0; border: none; border-top: 1px solid #e0e0e0;">
                ${bidsTreeHtml}
            </div>
        `;

        // Expand/collapse handler for the tree (delegation)
        setTimeout(() => {
                const container = document.getElementById('bids-tree-expandable');
            if (container) {
                container.addEventListener('click', function (e) {
                    const toggleEl = e.target.closest('.tree-toggle');
                    if (!toggleEl) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const targetId = toggleEl.getAttribute('data-target');
                    const childrenDiv = document.getElementById(targetId);
                    if (childrenDiv) {
                        const isVisible = childrenDiv.style.display === '' || childrenDiv.style.display === 'block';
                        childrenDiv.style.display = isVisible ? 'none' : 'block';
                        const arrow = document.getElementById('arrow_' + targetId);
                        if (arrow) arrow.textContent = isVisible ? '▶' : '▼';
                    }
                });

                    // Ensure arrow clicks also toggle the parent
                container.querySelectorAll('.tree-arrow').forEach(arrow => {
                    arrow.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const parentToggle = arrow.closest('.tree-toggle');
                        if (parentToggle) parentToggle.click();
                    });
                });
                // Initialize collapsed/expanded state: show only root and 1st level by default
                container.querySelectorAll('.tree-children').forEach(div => {
                    const levelAttr = div.getAttribute('data-level');
                    const levelNum = levelAttr ? parseInt(levelAttr, 10) : 0;
                    // Collapse deeper than level 1 (so only 0=root and 1=children of root are shown)
                    if (!isNaN(levelNum) && levelNum >= 2) {
                        div.style.display = 'none';
                    } else {
                        div.style.display = 'block';
                    }
                });
                container.querySelectorAll('.tree-arrow').forEach(arrow => {
                    const targetId = arrow.id.replace(/^arrow_/, '');
                    const childrenDiv = document.getElementById(targetId);
                    if (childrenDiv) {
                        arrow.textContent = (childrenDiv.style.display === 'block') ? '▼' : '▶';
                    }
                });
            }
        }, 0);

    } catch (error) {
        // If bids_results.json is missing, still show the summary and fallback info
        console.error('Error loading bids_results.json:', error);

        // Fallback to console output parsing
        const consoleText = document.getElementById('executeConsole').textContent;

        const filesMatch = consoleText.match(/(\d+)\s+files?/i);
        const subjectsMatch = consoleText.match(/(\d+)\s+subjects?/i);
        const sessionsMatch = consoleText.match(/(\d+)\s+sessions?/i);
        const errorsMatch = consoleText.match(/(\d+)\s+errors?/i);

        document.getElementById('stat-files-converted').textContent = filesMatch ? filesMatch[1] : (summaryObj?.['Processed Files'] ?? '0');
        document.getElementById('stat-subjects').textContent = subjectsMatch ? subjectsMatch[1] : (summaryObj?.['Total Subjects'] ?? '1');
        document.getElementById('stat-sessions').textContent = sessionsMatch ? sessionsMatch[1] : (summaryObj?.['Sessions per Subject'] ?? '1');
        document.getElementById('stat-errors').textContent = errorsMatch ? errorsMatch[1] : (summaryObj?.['Error Files'] ?? '0');

        detailsDiv.innerHTML = `
            
            <h3 style="color: #860052; margin-bottom: 15px;">Conversion Details</h3>
            <div style="color: #555; line-height: 1.8;">
                <p style="color: #ff6b6b;">⚠️ Could not load bids_results.json: ${error.message}</p>
                <p><strong>Project:</strong> ${currentConfig?.Project?.Name || 'N/A'}</p>
                <p><strong>Raw Data Path:</strong> ${currentConfig?.Project?.Raw || 'N/A'}</p>
                <p><strong>BIDS Output Path:</strong> ${currentConfig?.Project?.BIDS || 'N/A'}</p>
                <p><strong>Conversion Status:</strong> ${executionComplete ? '✅ Completed' : '⚠️ Incomplete'}</p>
                <hr style="margin: 20px 0; border: none; border-top: 1px solid #e0e0e0;">
                <p><strong>Console Output:</strong></p>
                <pre style="background: #f8f8f8; padding: 15px; border-radius: 6px; overflow-x: auto; max-height: 300px; overflow-y: auto;">${document.getElementById('executeConsole').textContent}</pre>
            </div>
        `;
        // Add expand/collapse logic for the tree view (fix: use correct display logic)
        setTimeout(() => {
            const toggles = document.querySelectorAll('.tree-toggle');
            toggles.forEach(toggle => {
                toggle.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('Tree toggle clicked:', this.getAttribute('data-target'));
                    const targetId = this.getAttribute('data-target');
                    const childrenDiv = document.getElementById(targetId);
                    if (childrenDiv) {
                        // Toggle display
                        const isVisible = childrenDiv.style.display === '' || childrenDiv.style.display === 'block';
                        childrenDiv.style.display = isVisible ? 'none' : 'block';
                        const arrow = document.getElementById('arrow_' + targetId);
                        if (arrow) arrow.textContent = isVisible ? '▶' : '▼';
                        console.log('Tree toggled', targetId, 'visible:', !isVisible);
                    }
                });
            });
            // Also make arrow click forward to the toggle click (better click target)
            document.querySelectorAll('.tree-arrow').forEach(arrow => {
                arrow.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const parentToggle = arrow.closest('.tree-toggle') || document.querySelector(`.tree-toggle[data-target='${arrow.id.replace(/^arrow_/, '')}']`);
                    if (parentToggle) parentToggle.click();
                });
            });
                // Initialize collapsed/expanded state: show only root and 1st level by default
                document.querySelectorAll('.tree-children').forEach(div => {
                    const levelAttr = div.getAttribute('data-level');
                    const levelNum = levelAttr ? parseInt(levelAttr, 10) : 0;
                    if (!isNaN(levelNum) && levelNum >= 2) {
                        div.style.display = 'none';
                    } else {
                        div.style.display = 'block';
                    }
                });
                document.querySelectorAll('.tree-arrow').forEach(arrow => {
                    const targetId = arrow.id.replace(/^arrow_/, '');
                    const childrenDiv = document.getElementById(targetId);
                    if (childrenDiv) {
                        arrow.textContent = (childrenDiv.style.display === 'block') ? '▼' : '▶';
                    }
                });
        }, 0);
    }
}

async function exportReport() {
    const reportHtml = `
<!DOCTYPE html>
<html>
<head>
    <title>BIDS Conversion Report</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; margin: 40px; line-height: 1.6; }
        h1 { color: #860052; }
        .stat { display: inline-block; margin: 20px; text-align: center; }
        .stat-value { font-size: 36px; font-weight: bold; color: #98C9A3; }
        .stat-label { color: #666; margin-top: 10px; }
        pre { background: #f8f8f8; padding: 15px; border-radius: 6px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th { background: #860052; color: white; padding: 10px; text-align: left; }
        td { padding: 8px; border-bottom: 1px solid #e0e0e0; }
        tr:hover { background: #f8f8f8; }
    </style>
</head>
<body>
    <h1>BIDS Conversion Report</h1>
    <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
    <p><strong>Project:</strong> ${currentConfig?.Project?.Name || 'N/A'}</p>
    
    <h2>Statistics</h2>
    <div class="stat">
        <div class="stat-value">${document.getElementById('stat-files-converted').textContent}</div>
        <div class="stat-label">Files Converted</div>
    </div>
    <div class="stat">
        <div class="stat-value">${document.getElementById('stat-subjects').textContent}</div>
        <div class="stat-label">Subjects</div>
    </div>
    <div class="stat">
        <div class="stat-value">${document.getElementById('stat-sessions').textContent}</div>
        <div class="stat-label">Sessions</div>
    </div>
    <div class="stat">
        <div class="stat-value">${document.getElementById('stat-errors').textContent}</div>
        <div class="stat-label">Errors</div>
    </div>
    
    ${document.getElementById('report-details').innerHTML}
</body>
</html>
    `;
    
    // Save report — show Save-as dialog restricted to HTML/HTM
    if (window.electronAPI) {
        const defaultPath = 'bids_conversion_report.html';
        try {
            const result = await window.electronAPI.saveFileDialog(defaultPath, reportHtml, { filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }] });
            if (result && result.success) {
                alert('✅ Report exported successfully to: ' + result.filePath);
            } else if (result && result.canceled) {
                // user canceled — do nothing
            } else {
                throw new Error(result?.error || 'Unknown error saving file');
            }
        } catch (err) {
            alert('❌ Error exporting report: ' + (err.message || err));
        }
    }
}

// NOTE: JSON export feature removed by request. Use 'Export as HTML' which opens a Save-as dialog
// implemented in `exportReport()` above (uses `electronAPI.saveFile`).

// Utility Functions
function appendToConsole(consoleId, text, type = 'normal') {
    const consoleOutput = document.getElementById(consoleId);
    const line = document.createElement('div');
    line.className = 'line ' + type;
    line.textContent = text;
    consoleOutput.appendChild(line);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function resetWorkflow() {
    analysisComplete = false;
    executionComplete = false;
    
    // Reset buttons
    document.getElementById('nextToEditorBtn').disabled = true;
    document.getElementById('nextToReportBtn').disabled = true;
    
    // Reset progress bars
    document.getElementById('analyseProgressBar').style.width = '0';
    document.getElementById('executeProgressBar').style.width = '0';
    
    // Clear consoles
    document.getElementById('analyseConsole').innerHTML = '';
    document.getElementById('executeConsole').innerHTML = '';
    
    // Hide progress elements
    document.getElementById('analyseProgressContainer').style.display = 'none';
    document.getElementById('analyseProgressText').style.display = 'none';
    document.getElementById('analyseConsole').style.display = 'none';
    document.getElementById('executeProgressContainer').style.display = 'none';
    document.getElementById('executeProgressText').style.display = 'none';
    document.getElementById('executeConsole').style.display = 'none';
}

// Handle menu triggers from main process
if (window.electronAPI) {
    window.electronAPI.onTriggerLoadConfig(() => {
        loadConfigFile();
    });
    
    window.electronAPI.onTriggerSaveConfig(() => {
        saveConfigFile();
    });
        // NOTE: Export JSON button intentionally removed (Export as HTML used instead). 
}
