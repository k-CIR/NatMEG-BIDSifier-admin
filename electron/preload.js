const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Save config to a temp file and return the path
    saveTempConfig: (config) => ipcRenderer.invoke('save-temp-config', config),

    // Run bidsify.py with arbitrary args (e.g., ['--report', '--config', path])
    runBidsifyWithArgs: (args) => ipcRenderer.invoke('run-bidsify-with-args', args),
  // Config management
  loadDefaultConfig: () => ipcRenderer.invoke('load-default-config'),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  
  // BIDSify execution
  runBidsify: (config, onlyTable, progressCallback) => {
    // Set up progress listener
    ipcRenderer.on('bidsify-progress', (event, data) => {
      if (progressCallback) progressCallback(data);
    });
    
    return ipcRenderer.invoke('run-bidsify', config, onlyTable);
  },
  
  // File operations
  loadConversionTable: (path) => ipcRenderer.invoke('load-conversion-table', path),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  openFile: () => ipcRenderer.invoke('open-file-dialog'),
  saveFile: (filePath, content) => ipcRenderer.invoke('save-file', { filePath, content }),
  // Accept optional options object to pass custom filters for the dialog
  saveFileDialog: (defaultPath, content, options = {}) => ipcRenderer.invoke('save-file-dialog', { defaultPath, content, options }),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectFile: () => ipcRenderer.invoke('select-file'),
  
  // Menu triggers
  onTriggerFileOpen: (callback) => ipcRenderer.on('trigger-file-open', callback),
  onTriggerSave: (callback) => ipcRenderer.on('trigger-save', callback),
  onTriggerLoadConfig: (callback) => ipcRenderer.on('trigger-load-config', callback),
  onTriggerSaveConfig: (callback) => ipcRenderer.on('trigger-save-config', callback)
  ,
  // Open external links using the system default browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
