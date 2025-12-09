// Pure functions to manipulate a conversion table model { headers: string[], rows: string[][] }
// Designed to be testable in Node and usable in the browser.

function tsvToModel(tsv) {
  const lines = String(tsv || '').trim().split('\n').filter(Boolean);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split('\t').map(h => h.trim());
  const rows = lines.slice(1).map(r => r.split('\t'));
  return { headers, rows };
}

function modelToTsv(model) {
  const h = (model.headers || []).join('\t');
  const rows = (model.rows || []).map(r => r.join('\t'));
  return [h].concat(rows).join('\n');
}

function addRow(model) {
  const cols = model.headers.length || 0;
  const row = Array.from({ length: cols }, () => '');
  model.rows.push(row);
  return model;
}

function deleteRows(model, indices) {
  const uniq = Array.from(new Set(indices)).sort((a,b)=>b-a);
  for (const idx of uniq) {
    if (idx >=0 && idx < model.rows.length) model.rows.splice(idx,1);
  }
  return model;
}

function addColumn(model, pos, name='col') {
  const p = Number.isNaN(Number(pos)) ? model.headers.length : Math.max(0, Math.min(pos, model.headers.length));
  model.headers.splice(p,0,name);
  model.rows.forEach(r => r.splice(p,0,'') );
  return model;
}

function deleteColumn(model, idx) {
  if (Number.isNaN(Number(idx)) || idx < 0 || idx >= model.headers.length) throw new Error('Invalid column index');
  model.headers.splice(idx,1);
  model.rows.forEach(r => r.splice(idx,1));
  return model;
}

function sortByColumn(model, idx, asc=true) {
  if (Number.isNaN(Number(idx)) || idx < 0 || idx >= model.headers.length) throw new Error('Invalid column index');
  model.rows.sort((a,b)=>{
    const av = a[idx] || '';
    const bv = b[idx] || '';
    if (av === bv) return 0;
    return asc ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
  });
  return model;
}

function moveRows(model, indices, dir) {
  // indices is array of row indices to move; dir is -1 or 1
  if (!Array.isArray(indices) || indices.length === 0) return model;
  const rows = model.rows;
  const unique = Array.from(new Set(indices)).sort((a,b) => dir>0 ? b-a : a-b);
  for (const idx of unique) {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= rows.length) continue;
    const [row] = rows.splice(idx,1);
    rows.splice(newIdx,0,row);
  }
  return model;
}

function applyToColumn(model, colIdx, value) {
  if (Number.isNaN(Number(colIdx)) || colIdx < 0 || colIdx >= model.headers.length) throw new Error('Invalid column index');
  model.rows.forEach(r => r[colIdx] = value);
  return model;
}

function findReplace(model, find, replace) {
  if (!find) return model;
  model.rows = model.rows.map(r => r.map(cell => (cell || '').split(find).join(replace)));
  return model;
}

const _EditorModel = {
  tsvToModel, modelToTsv, addRow, deleteRows, addColumn, deleteColumn, sortByColumn, moveRows, applyToColumn, findReplace
};

// Support CommonJS (Node) if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = _EditorModel;
}

// Attach to window for browser usage if present
if (typeof window !== 'undefined') window.EditorModel = _EditorModel;
