'use strict';

// Prototype state. There is no seeded content or filesystem indexing.
const fields = [];
const items = [];
const connections = [];
const attachments = new Map();
const positions = new Map();
const colors = ['#6384ff', '#80bca3', '#c0a17d', '#ad91cd', '#d28c8c'];
const kinds = {
  link: { label: 'Link', plural: 'Links', icon: 'link' },
  file: { label: 'File', plural: 'Files', icon: 'file' },
  note: { label: 'Note', plural: 'Notes', icon: 'note' },
  drawing: { label: 'Drawing', plural: 'Drawings', icon: 'pen' }
};
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  orbit: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-35 12 12)"/><path d="M7 4c6-1 12 10 9 16"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  folder: '<path d="M3 7V5h7l2 3h9v12H3V7Z"/>',
  file: '<path d="M5 3h9l5 5v13H5Z M14 3v6h5"/>',
  note: '<path d="M5 3h14v18H5ZM8 8h8M8 12h8M8 16h5"/>',
  pen: '<path d="m14 4 6 6M4 20l5-1L21 7l-4-4L5 15l-1 5Z"/>',
  link: '<path d="m9 15 6-6M8 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 7l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  external: '<path d="M13 4h7v7M20 4 10 14M10 5H4v15h15v-6"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 3v4l3 2 3-1 3 1 3-2v-4l2-3-2-3-3-1-1-3Z"/><circle cx="11" cy="11" r="3"/>',
  subfield: '<path d="M5 3v12a4 4 0 0 0 4 4h10M15 15l4 4-4 4M10 6h9M14.5 1.5v9"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H3v13h5"/>',
  undo: '<path d="M8 5 3 10l5 5M3 10h10a6 6 0 0 1 0 12"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>'
};

const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const uid = prefix => `${prefix}-${crypto.randomUUID()}`;
const byField = id => fields.find(field => field.id === id);
const byItem = id => items.find(item => item.id === id);
const typeName = kind => kinds[kind].label;
let view = 'fields';
let currentField = null;
let itemFilter = 'all';
let everythingMode = 'map';
let selectedEdge = null;
let mapObserver = null;
let mapSize = { width: 600, height: 400 };
let zoom = 1;
let dragged = false;
let drawingPad = null;
let returnFocus = null;

function ancestry(id) {
  const result = [];
  for (let field = byField(id); field; field = byField(field.parent)) result.unshift(field);
  return result;
}

function descendants(id) {
  return [id, ...fields.filter(field => field.parent === id).flatMap(field => descendants(field.id))];
}

function itemsIn(id) {
  const ids = new Set(descendants(id));
  return items.filter(item => item.fields.some(fieldId => ids.has(fieldId)));
}

function fieldPath(id) {
  return ancestry(id).map(field => field.name).join(' / ');
}

function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function button(label, action, className = 'secondary', attrs = '', glyph = '') {
  return `<button class="button ${className}" data-action="${action}" ${attrs}>${glyph ? icon(glyph) : ''}${label}</button>`;
}

function heading(title, actions, count = null) {
  return `<header class="page-header"><div class="page-title"><h1>${escapeHTML(title)}</h1>${count ? `<span class="page-count">${count}</span>` : ''}</div><div class="header-actions">${actions}</div></header>`;
}

function addMenu() {
  return `<div class="add-menu-wrap">${button('Add', 'toggle-add', 'primary', 'aria-expanded="false" aria-controls="add-menu"', 'plus')}<div class="add-menu" id="add-menu" hidden>${Object.entries(kinds).map(([kind, meta]) => `<button data-action="add-item" data-kind="${kind}">${icon(meta.icon)}${meta.label}</button>`).join('')}</div></div>`;
}

function navigate(next, id = null) {
  view = next;
  currentField = id;
  itemFilter = 'all';
  closeDetail();
  render();
}

function renderSidebar() {
  document.querySelectorAll('[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === (view === 'field' ? 'fields' : view)));
  $('#field-count').textContent = fields.length ? fields.filter(field => !field.parent).length : '';
  const renderTree = (parent, depth = 0) => fields.filter(field => field.parent === parent).map(field => `<button data-action="open-field" data-id="${field.id}" class="${currentField === field.id ? 'current' : ''}" style="padding-left:${14 + depth * 13}px;--field-color:${field.color}"><span class="field-dot"></span><span class="nav-field-name">${escapeHTML(field.name)}</span></button>${renderTree(field.id, depth + 1)}`).join('');
  $('#field-navigation').innerHTML = fields.length ? `<div class="section-label">Fields</div>${renderTree(null)}` : '';
}

function render() {
  mapObserver?.disconnect();
  renderSidebar();
  $('#content').innerHTML = view === 'field' ? renderField() : view === 'everything' ? renderEverything() : renderFields();
  if (view === 'everything' && everythingMode === 'map' && fields.length) initMap();
}

function renderFieldCard(field) {
  const count = itemsIn(field.id).length;
  return `<button class="field-card" data-action="open-field" data-id="${field.id}" style="--field-color:${field.color}">${icon('folder')}<div class="field-card-info"><strong>${escapeHTML(field.name)}</strong><small>${count} ${count === 1 ? 'item' : 'items'}</small></div></button>`;
}

function renderFields() {
  const roots = fields.filter(field => !field.parent);
  return heading('Fields', button('New field', 'new-field', 'primary', '', 'plus'), roots.length) + '<div class="rule"></div>' + (roots.length ? `<div class="field-grid">${roots.map(renderFieldCard).join('')}</div>` : '<div class="empty-state">No fields</div>');
}

function renderFilters() {
  return `<div class="item-toolbar" aria-label="Filter items">${[['all', 'All'], ...Object.entries(kinds).map(([key, value]) => [key, value.plural])].map(([key, label]) => `<button class="filter-button ${itemFilter === key ? 'active' : ''}" data-action="filter" data-kind="${key}">${label}</button>`).join('')}</div>`;
}

function renderItem(item) {
  const meta = kinds[item.kind];
  const notePreview = item.kind === 'note' ? (item.body === item.title ? '' : item.body.startsWith(item.title + '\n') ? item.body.slice(item.title.length + 1) : item.body) : '';
  const extra = item.kind === 'link' ? new URL(item.url).hostname : item.kind === 'file' ? (item.path || (item.fileName !== item.title ? item.fileName : '') || '') : '';
  return `<button class="item-card" data-action="open-item" data-id="${item.id}">${item.kind === 'drawing' ? `<img class="drawing-preview" src="${item.drawing}" alt="${escapeHTML(item.title)}">` : ''}<div class="item-card-top">${icon(meta.icon)}${meta.label}${item.fields.length > 1 ? `<span class="membership-count">${icon('link')}${item.fields.length}</span>` : ''}</div><h3>${escapeHTML(item.title)}</h3>${notePreview ? `<p>${escapeHTML(notePreview.slice(0, 350))}</p>` : extra ? `<small>${escapeHTML(extra)}</small>` : ''}${item.kind === 'file' && item.size !== undefined ? `<div class="item-card-bottom">${formatSize(item.size)}</div>` : ''}</button>`;
}

function renderItems(list) {
  const visible = list.filter(item => itemFilter === 'all' || item.kind === itemFilter);
  return (list.length ? renderFilters() : '') + (visible.length ? `<div class="item-grid">${visible.map(renderItem).join('')}</div>` : `<div class="empty-state">${itemFilter === 'all' ? 'No items' : `No ${kinds[itemFilter].plural.toLowerCase()}`}</div>`);
}

function renderField() {
  const field = byField(currentField);
  const parents = ancestry(field.id).slice(0, -1);
  const list = itemsIn(field.id);
  const children = fields.filter(child => child.parent === field.id);
  const related = allEdges().filter(edge => edge.kind !== 'parent' && [edge.from, edge.to].includes(field.id));
  const crumbs = `<div class="breadcrumb"><button data-action="go-fields">Fields</button>${parents.map(parent => `<span>/</span><button data-action="open-field" data-id="${parent.id}">${escapeHTML(parent.name)}</button>`).join('')}<span>/</span><span>${escapeHTML(field.name)}</span></div>`;
  const actions = button('<span class="action-label">Subfield</span>', 'new-field', 'quiet', `data-parent="${field.id}" aria-label="New subfield"`, 'subfield') + (fields.length > 1 ? button('', 'connect-fields', 'quiet', 'aria-label="Connect fields"', 'link') : '') + addMenu();
  return crumbs + heading(field.name, actions, list.length) + (children.length ? `<div class="subfields">${children.map(child => `<button class="subfield" data-action="open-field" data-id="${child.id}" style="--field-color:${child.color}">${icon('folder')}${escapeHTML(child.name)}<small>${itemsIn(child.id).length}</small></button>`).join('')}</div>` : '') + renderItems(list) + (related.length ? `<div class="section-heading">Connections</div><div class="connections">${related.map(edge => `<button class="connection-chip" data-action="open-edge" data-id="${edge.id}">${icon('link')}${escapeHTML(byField(edge.from === field.id ? edge.to : edge.from).name)}<span>${escapeHTML(edge.label)}</span></button>`).join('')}</div>` : '');
}

function renderEverything() {
  const actions = fields.length ? addMenu() : button('New field', 'new-field', 'primary', '', 'plus');
  const tools = `<div class="everything-toolbar"><div class="segmented">${[['map', 'Map'], ['items', 'Items']].map(([key, label]) => `<button class="${everythingMode === key ? 'active' : ''}" data-action="everything-mode" data-mode="${key}">${label}</button>`).join('')}</div>${everythingMode === 'map' && fields.length > 1 ? button('Connect', 'connect-fields', 'secondary compact', '', 'link') : ''}</div>`;
  if (everythingMode === 'items') return heading('The big FIELD', actions, items.length) + tools + renderItems([...items].reverse());
  const edge = allEdges().find(candidate => candidate.id === selectedEdge && candidate.kind !== 'parent');
  return heading('The big FIELD', actions) + tools + (!fields.length ? '<div class="empty-state">No fields</div>' : `<div class="map-layout ${edge ? 'has-inspector' : ''}"><div class="map-shell" id="map-shell"><div class="graph-stage" id="graph-stage"><svg class="graph-lines" id="graph-lines" aria-hidden="true"></svg><div id="graph-nodes"></div><div id="graph-labels"></div></div><div class="map-legend"><span><i></i> Shared items</span><span><i class="dashed"></i> Connection</span></div><div class="map-controls"><button data-action="zoom-out" aria-label="Zoom out">−</button><button data-action="zoom-reset" aria-label="Fit map">${icon('grid')}</button><button data-action="zoom-in" aria-label="Zoom in">+</button></div></div>${edge ? renderInspector(edge) : ''}</div>`);
}

function allEdges() {
  const shared = [];
  for (let a = 0; a < fields.length; a++) {
    for (let b = a + 1; b < fields.length; b++) {
      const matches = items.filter(item => item.fields.includes(fields[a].id) && item.fields.includes(fields[b].id));
      if (matches.length) shared.push({ id: `shared-${fields[a].id}-${fields[b].id}`, kind: 'shared', from: fields[a].id, to: fields[b].id, items: matches.map(item => item.id), label: `${matches.length} ${matches.length === 1 ? 'item' : 'items'}` });
    }
  }
  return [...fields.filter(field => field.parent).map(field => ({ id: `parent-${field.id}`, kind: 'parent', from: field.parent, to: field.id })), ...shared, ...connections];
}

function renderInspector(edge) {
  return `<aside class="map-inspector"><div class="inspector-top"><span>${escapeHTML(byField(edge.from).name)} / ${escapeHTML(byField(edge.to).name)}</span><button class="icon-button" data-action="close-edge" aria-label="Close connection">${icon('close')}</button></div><h2>${edge.kind === 'shared' ? 'Shared items' : escapeHTML(edge.label)}</h2>${edge.note ? `<p>${escapeHTML(edge.note)}</p>` : ''}${(edge.items || []).map(id => { const item = byItem(id); return `<button class="shared-item" data-action="open-item" data-id="${id}">${icon(kinds[item.kind].icon)}<span>${escapeHTML(item.title)}</span></button>`; }).join('')}${button('Open field', 'open-field', 'secondary compact', `data-id="${edge.from}"`, 'arrow')}</aside>`;
}

function nodePosition(field) {
  if (positions.has(field.id)) return positions.get(field.id);
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(fields.length))));
  const index = fields.indexOf(field);
  return { x: (mapSize.width - (columns * 176 + (columns - 1) * 70)) / 2 + index % columns * 246, y: 70 + Math.floor(index / columns) * 150 };
}

function drawEdges() {
  const edges = allEdges();
  $('#graph-lines').innerHTML = edges.map(edge => {
    const a = nodePosition(byField(edge.from));
    const b = nodePosition(byField(edge.to));
    return `<path class="edge ${edge.kind} ${edge.id === selectedEdge ? 'selected' : ''}" d="M ${a.x + 88} ${a.y + 38} Q ${(a.x + b.x) / 2 + 88} ${(a.y + b.y) / 2 + 12} ${b.x + 88} ${b.y + 38}"/>`;
  }).join('');
  $('#graph-labels').innerHTML = edges.filter(edge => edge.kind !== 'parent').map(edge => {
    const a = nodePosition(byField(edge.from));
    const b = nodePosition(byField(edge.to));
    return `<button class="edge-label ${edge.id === selectedEdge ? 'selected' : ''}" data-action="select-edge" data-id="${edge.id}" style="left:${(a.x + b.x) / 2 + 88}px;top:${(a.y + b.y) / 2 + (edge.kind === 'related' ? 53 : 25)}px" aria-label="${escapeHTML(byField(edge.from).name)} to ${escapeHTML(byField(edge.to).name)}: ${escapeHTML(edge.label)}">${escapeHTML(edge.label)}</button>`;
  }).join('');
}

function initMap() {
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(fields.length))));
  mapSize = { width: Math.max(600, columns * 246 + 50), height: Math.max(400, Math.ceil(fields.length / columns) * 150 + 100) };
  $('#graph-stage').style.width = `${mapSize.width}px`;
  $('#graph-stage').style.height = `${mapSize.height}px`;
  $('#graph-lines').setAttribute('viewBox', `0 0 ${mapSize.width} ${mapSize.height}`);
  $('#graph-nodes').innerHTML = fields.map(field => {
    const position = nodePosition(field);
    return `<button class="graph-node" data-action="open-field" data-map-node="${field.id}" data-id="${field.id}" style="left:${position.x}px;top:${position.y}px;--field-color:${field.color}" aria-label="Open ${escapeHTML(fieldPath(field.id))}">${icon('folder')}<div><strong>${escapeHTML(field.name)}</strong><small>${itemsIn(field.id).length} ${itemsIn(field.id).length === 1 ? 'item' : 'items'}</small></div></button>`;
  }).join('');
  drawEdges();
  const fit = () => {
    const shell = $('#map-shell');
    const stage = $('#graph-stage');
    if (!shell || !stage) return;
    const scale = Math.min(1.2, (shell.clientWidth - 25) / mapSize.width, (shell.clientHeight - 70) / mapSize.height) * zoom;
    stage.style.transform = `translate(-50%,-50%) scale(${scale})`;
    stage.dataset.scale = scale;
  };
  mapObserver = new ResizeObserver(fit);
  mapObserver.observe($('#map-shell'));
  fit();
}

function showModal(title, html, wide = false) {
  drawingPad?.destroy();
  drawingPad = null;
  returnFocus = document.activeElement.closest('.add-menu') ? document.querySelector('[data-action="toggle-add"]') : document.activeElement;
  const modal = $('#modal');
  modal.classList.toggle('wide', wide);
  $('#modal-content').innerHTML = `<div class="modal-header"><h2 id="modal-title">${escapeHTML(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><div class="modal-body">${html}</div>`;
  if (!modal.open) modal.showModal();
  modal.querySelector('input:not([type=file]):not([type=hidden]), textarea, select')?.focus();
}

function closeModal() {
  $('#modal').close();
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 2200);
}

function newField(parent = null) {
  let color = parent ? byField(parent).color : colors[0];
  showModal(parent ? 'New subfield' : 'New field', `<form id="field-form"><label class="form-label" for="field-name">Name</label><input class="input" id="field-name" maxlength="64" required autocomplete="off"><div class="swatches">${colors.map(candidate => `<button type="button" class="swatch ${candidate === color ? 'selected' : ''}" style="--swatch:${candidate}" data-color="${candidate}" aria-label="${candidate}" aria-pressed="${candidate === color}"></button>`).join('')}</div><div class="form-actions">${button('Cancel', 'close-modal', 'quiet', 'type="button"')}<button class="button primary" type="submit">Create</button></div></form>`);
  document.querySelectorAll('[data-color]').forEach(node => node.onclick = () => {
    color = node.dataset.color;
    document.querySelectorAll('[data-color]').forEach(candidate => {
      candidate.classList.toggle('selected', candidate === node);
      candidate.setAttribute('aria-pressed', String(candidate === node));
    });
  });
  $('#field-form').onsubmit = event => {
    event.preventDefault();
    const name = $('#field-name').value.trim();
    if (!name) return;
    const field = { id: uid('field'), name, color, parent };
    fields.push(field);
    closeModal();
    navigate('field', field.id);
  };
}

function fieldOptions(selected) {
  return fields.map(field => `<option value="${field.id}" ${field.id === selected ? 'selected' : ''}>${escapeHTML(fieldPath(field.id))}</option>`).join('');
}

function normalizeURL(raw) {
  const text = raw.trim();
  if (!text) throw new Error('Enter a URL.');
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https URL.');
  return url.href;
}

function compose(kind, existingId = null) {
  const existing = existingId ? byItem(existingId) : null;
  const inField = currentField;
  if (!fields.length) return newField();
  let chosenFile = existingId ? attachments.get(existingId)?.file : null;
  const fieldSelect = !existing && !inField ? `<label class="form-label" for="item-field">Field</label><select class="input" id="item-field">${fieldOptions(fields[0].id)}</select>` : '';
  let body = '';
  if (kind === 'link') body = `<label class="form-label" for="item-url">URL</label><input class="input" id="item-url" placeholder="https://" value="${escapeHTML(existing?.url || '')}" required>`;
  if (kind === 'file') body = `<div class="file-picker"><button class="button secondary" type="button" id="choose-file">${icon('file')}Choose file</button><input type="file" id="file-input" hidden><span class="file-picker-name" id="file-picker-name">${escapeHTML(existing?.fileName || '')}</span></div><label class="form-label" for="item-path">PC path <span class="optional">optional if a file is selected</span></label><input class="input" id="item-path" placeholder="C:\\" value="${escapeHTML(existing?.path || '')}">`;
  body += `<label class="form-label" for="item-title">Name <span class="optional">optional</span></label><input class="input" id="item-title" maxlength="120" value="${escapeHTML(existing?.title || '')}">`;
  if (kind === 'note') body += `<label class="form-label" for="item-body">Note</label><textarea class="input note-body" id="item-body" required>${escapeHTML(existing?.body || '')}</textarea>`;
  if (kind === 'drawing') body += `<div class="drawing-toolbar"><input type="color" id="pen-color" class="drawing-color" value="#d5dff3" aria-label="Pen color"><input type="range" id="pen-width" min="1" max="12" value="2" aria-label="Pen width"><button class="button secondary compact" type="button" id="drawing-undo">${icon('undo')}Undo</button><button class="button secondary compact" type="button" id="drawing-clear">Clear</button></div><canvas class="drawing-canvas" id="drawing-canvas" aria-label="Drawing canvas"></canvas>`;
  showModal(`${existing ? 'Edit' : 'New'} ${typeName(kind).toLowerCase()}`, `<form id="item-form">${body}${fieldSelect}<p class="form-error" id="item-error" role="alert"></p><div class="form-actions">${button('Cancel', 'close-modal', 'quiet', 'type="button"')}<button class="button primary" type="submit">${existing ? 'Save' : 'Add'}</button></div></form>`, kind === 'note' || kind === 'drawing');
  if (kind === 'file') $('#choose-file').onclick = () => $('#file-input').click();
  if (kind === 'file') $('#file-input').onchange = event => {
    if (!event.target.files[0]) return;
    chosenFile = event.target.files[0];
    $('#item-path').value = '';
    $('#file-picker-name').textContent = chosenFile?.name || '';
    if (!$('#item-title').value && chosenFile) $('#item-title').value = chosenFile.name;
  };
  if (kind === 'drawing') {
    drawingPad = window.FieldDrawing.mount($('#drawing-canvas'), { color: '#d5dff3', lineWidth: 2, initialDataUrl: existing?.drawing });
    $('#pen-color').oninput = event => drawingPad.setColor(event.target.value);
    $('#pen-width').oninput = event => drawingPad.setLineWidth(event.target.value);
    $('#drawing-undo').onclick = () => drawingPad.undo();
    $('#drawing-clear').onclick = () => drawingPad.clear();
  }
  $('#item-form').onsubmit = event => {
    event.preventDefault();
    try {
      const record = existing ? { ...existing } : { id: uid('item'), kind, fields: [inField || $('#item-field').value], createdAt: Date.now() };
      let title = $('#item-title').value.trim();
      if (kind === 'link') {
        record.url = normalizeURL($('#item-url').value);
        title ||= new URL(record.url).hostname;
      } else if (kind === 'note') {
        record.body = $('#item-body').value.trim();
        if (!record.body) throw new Error('Enter a note.');
        title ||= record.body.split('\n')[0].slice(0, 64);
      } else if (kind === 'file') {
        record.path = $('#item-path').value.trim();
        if (!chosenFile && !record.path) throw new Error('Select a file or enter its PC path.');
        if (record.path && !/^(?:[a-z]:[\\/]|\\\\)/i.test(record.path)) throw new Error('Enter an absolute Windows path.');
        record.fileName = chosenFile?.name || record.path.split(/[\\/]/).pop();
        if (chosenFile) {
          record.size = chosenFile.size;
          record.mime = chosenFile.type;
        }
        title ||= record.fileName;
      } else if (kind === 'drawing') {
        if (!drawingPad.hasContent()) throw new Error('Add a drawing.');
        record.drawing = drawingPad.toDataURL();
        title ||= 'Drawing';
      }
      record.title = title;
      if (chosenFile) {
        attachments.get(record.id)?.url && URL.revokeObjectURL(attachments.get(record.id).url);
        attachments.set(record.id, { file: chosenFile, url: URL.createObjectURL(chosenFile) });
      }
      if (existing) items.splice(items.indexOf(existing), 1, record);
      else items.push(record);
      closeModal();
      itemFilter = 'all';
      render();
      if (existing) openItem(record.id);
    } catch (error) {
      $('#item-error').textContent = error.message === 'Invalid URL' ? 'Enter a valid URL.' : error.message;
    }
  };
}

function openItem(id) {
  const item = byItem(id);
  const file = attachments.get(id);
  const meta = kinds[item.kind];
  let body = item.kind === 'note' ? `<div class="detail-body">${escapeHTML(item.body)}</div>` : item.kind === 'drawing' ? `<img class="detail-drawing" src="${item.drawing}" alt="${escapeHTML(item.title)}">` : item.kind === 'link' ? `<a class="detail-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item.url)}</a>` : `${file && item.mime?.startsWith('image/') ? `<img class="detail-image" src="${file.url}" alt="${escapeHTML(item.title)}">` : ''}${item.path ? `<div class="detail-path">${escapeHTML(item.path)}</div>` : `<div class="detail-path">${escapeHTML(item.fileName)}</div>`}${item.size !== undefined ? `<div class="detail-metadata">${formatSize(item.size)}</div>` : ''}`;
  const openAction = item.kind === 'link' ? `<a class="button secondary compact" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer">${icon('external')}Open</a>` : item.kind === 'file' ? (file ? `<a class="button secondary compact" href="${file.url}" target="_blank" rel="noopener">${icon('external')}Open file</a>` : '') + (item.path ? button('Copy path', 'copy-path', 'secondary compact', `data-id="${id}"`, 'copy') : '') : item.kind === 'drawing' ? `<a class="button secondary compact" href="${item.drawing}" download="${escapeHTML(item.title.replace(/[^a-z0-9_-]/gi, '_'))}.png">Save PNG</a>` : '';
  $('#detail-panel').innerHTML = `<div class="detail-top"><span>${icon(meta.icon)}${meta.label}</span><button class="icon-button" data-action="close-detail" aria-label="Close item">${icon('close')}</button></div><h2>${escapeHTML(item.title)}</h2>${body}<div class="detail-actions">${openAction}${button('Edit', 'edit-item', 'secondary compact', `data-id="${id}"`)}</div><div class="detail-fields-title"><span>Fields</span>${button('Add to field', 'share-item', 'quiet compact', `data-id="${id}"`, 'plus')}</div><div class="membership-list">${item.fields.map(fieldId => `<button data-action="open-field" data-id="${fieldId}" style="--field-color:${byField(fieldId).color}"><span class="field-dot"></span>${escapeHTML(fieldPath(fieldId))}<span class="membership-arrow">↗</span></button>`).join('')}</div>`;
  $('#detail-panel').hidden = false;
}

function closeDetail() {
  $('#detail-panel').hidden = true;
}

function shareItem(id) {
  const item = byItem(id);
  const available = fields.filter(field => !item.fields.includes(field.id));
  showModal('Add to field', available.length ? `<form id="share-form"><label class="form-label" for="share-field">Field</label><select class="input" id="share-field">${available.map(field => `<option value="${field.id}">${escapeHTML(fieldPath(field.id))}</option>`).join('')}</select><div class="form-actions">${button('Cancel', 'close-modal', 'quiet', 'type="button"')}<button class="button primary" type="submit">Add</button></div></form>` : '<div class="blank-message">Already in all fields</div>');
  if (available.length) $('#share-form').onsubmit = event => {
    event.preventDefault();
    item.fields.push($('#share-field').value);
    closeModal();
    render();
    openItem(id);
  };
}

function newConnection() {
  if (fields.length < 2) return;
  const source = currentField || fields[0].id;
  const target = fields.find(field => field.id !== source).id;
  showModal('Connect fields', `<form id="connection-form"><label class="form-label" for="connection-from">From</label><select class="input" id="connection-from">${fieldOptions(source)}</select><label class="form-label" for="connection-to">To</label><select class="input" id="connection-to">${fieldOptions(target)}</select><label class="form-label" for="connection-label">Label</label><input class="input" id="connection-label" maxlength="64" required><label class="form-label" for="connection-note">Note <span class="optional">optional</span></label><textarea class="input short-note" id="connection-note"></textarea><p id="connection-error" class="form-error" role="alert"></p><div class="form-actions">${button('Cancel', 'close-modal', 'quiet', 'type="button"')}<button class="button primary" type="submit">Connect</button></div></form>`);
  $('#connection-form').onsubmit = event => {
    event.preventDefault();
    const from = $('#connection-from').value;
    const to = $('#connection-to').value;
    if (from === to) { $('#connection-error').textContent = 'Choose two different fields.'; return; }
    const label = $('#connection-label').value.trim();
    if (!label) return;
    const edge = { id: uid('connection'), from, to, kind: 'related', label, note: $('#connection-note').value.trim() };
    connections.push(edge);
    selectedEdge = edge.id;
    closeModal();
    everythingMode = 'map';
    navigate('everything');
  };
}

function search() {
  showModal('Search', '<input class="input search-input" id="search-query" placeholder="Search" aria-label="Search library" autocomplete="off"><div class="search-results" id="search-results"></div>');
  const update = () => {
    const query = $('#search-query').value.trim().toLowerCase();
    const matches = [...fields.filter(field => field.name.toLowerCase().includes(query)).map(field => `<button class="search-result" data-action="search-field" data-id="${field.id}">${icon('folder')}<div><strong>${escapeHTML(field.name)}</strong><small>${escapeHTML(fieldPath(field.id))}</small></div></button>`), ...items.filter(item => [item.title, item.body, item.path, item.url].some(value => value?.toLowerCase().includes(query))).map(item => `<button class="search-result" data-action="search-item" data-id="${item.id}">${icon(kinds[item.kind].icon)}<div><strong>${escapeHTML(item.title)}</strong><small>${typeName(item.kind)}</small></div></button>`)];
    $('#search-results').innerHTML = matches.join('') || '<div class="search-empty">No results</div>';
  };
  $('#search-query').oninput = update;
  update();
}

function library() {
  showModal('Library', `<div class="library-row"><span>Fields</span><span>${fields.length}</span></div>${Object.entries(kinds).map(([kind, meta]) => `<div class="library-row"><span>${meta.plural}</span><span>${items.filter(item => item.kind === kind).length}</span></div>`).join('')}<p class="library-status">Prototype · session only</p>`);
}

document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]');
  if (nav) navigate(nav.dataset.view);
  const node = event.target.closest('[data-action]');
  if (node && !node.disabled) {
    const id = node.dataset.id;
    switch (node.dataset.action) {
      case 'go-fields': navigate('fields'); break;
      case 'open-field': if (!dragged) navigate('field', id); break;
      case 'new-field': newField(node.dataset.parent || null); break;
      case 'close-modal': closeModal(); break;
      case 'close-detail': closeDetail(); break;
      case 'toggle-add': {
        const menu = $('#add-menu');
        menu.hidden = !menu.hidden;
        node.setAttribute('aria-expanded', String(!menu.hidden));
        break;
      }
      case 'add-item':
        $('#add-menu').hidden = true;
        document.querySelector('[data-action="toggle-add"]').setAttribute('aria-expanded', 'false');
        compose(node.dataset.kind);
        break;
      case 'edit-item': compose(byItem(id).kind, id); break;
      case 'open-item': openItem(id); break;
      case 'share-item': shareItem(id); break;
      case 'copy-path':
        try { await navigator.clipboard.writeText(byItem(id).path); toast('Path copied'); }
        catch { toast('Clipboard unavailable'); }
        break;
      case 'filter': itemFilter = node.dataset.kind; render(); break;
      case 'everything-mode': everythingMode = node.dataset.mode; itemFilter = 'all'; render(); break;
      case 'connect-fields': newConnection(); break;
      case 'select-edge': selectedEdge = id; render(); break;
      case 'open-edge': selectedEdge = id; everythingMode = 'map'; navigate('everything'); break;
      case 'close-edge': selectedEdge = null; render(); break;
      case 'zoom-in': zoom = Math.min(1.8, zoom + .15); render(); break;
      case 'zoom-out': zoom = Math.max(.5, zoom - .15); render(); break;
      case 'zoom-reset': zoom = 1; render(); break;
      case 'search-field': closeModal(); navigate('field', id); break;
      case 'search-item': closeModal(); openItem(id); break;
    }
  }
  if (!event.target.closest('.add-menu-wrap')) {
    const menu = $('#add-menu');
    if (menu) menu.hidden = true;
    document.querySelector('[data-action="toggle-add"]')?.setAttribute('aria-expanded', 'false');
  }
});

document.addEventListener('pointerdown', event => {
  const node = event.target.closest('[data-map-node]');
  if (!node || event.button !== 0) return;
  const id = node.dataset.mapNode;
  const origin = nodePosition(byField(id));
  const start = { x: event.clientX, y: event.clientY };
  const scale = Number($('#graph-stage').dataset.scale);
  dragged = false;
  const move = next => {
    const dx = (next.clientX - start.x) / scale;
    const dy = (next.clientY - start.y) / scale;
    if (Math.abs(dx) + Math.abs(dy) > 6) dragged = true;
    if (!dragged) return;
    const position = { x: Math.max(0, Math.min(mapSize.width - 176, origin.x + dx)), y: Math.max(0, Math.min(mapSize.height - 77, origin.y + dy)) };
    positions.set(id, position);
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
    drawEdges();
  };
  const stop = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', stop);
    document.removeEventListener('pointercancel', stop);
    setTimeout(() => { dragged = false; }, 100);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', stop);
  document.addEventListener('pointercancel', stop);
});

$('.brand').onclick = event => { event.preventDefault(); navigate('fields'); };
$('#search-button').onclick = search;
$('#settings').onclick = library;
$('#modal').addEventListener('close', () => {
  drawingPad?.destroy();
  drawingPad = null;
  if (returnFocus?.isConnected) returnFocus.focus();
});
$('#modal').addEventListener('click', event => {
  if (event.target !== $('#modal')) return;
  const bounds = $('#modal').getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeModal();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('#modal').open) closeDetail();
    const menu = $('#add-menu');
    if (menu) menu.hidden = true;
  }
  if (event.key === '/' && !$('#modal').open && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    search();
  }
});
document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
render();
