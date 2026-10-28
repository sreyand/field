'use strict';

// Canonical records and memberships are stored locally. Fresh libraries have no seeded content.
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
  settings: '<path d="m10 4-1 3-3 1-2 3 2 3v4l3 2 3-1 3 1 3-2v-4l2-3-2-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  subfield: '<path d="M5 3v12a4 4 0 0 0 4 4h10M15 15l4 4-4 4M10 6h9M14.5 1.5v9"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H3v13h5"/>',
  undo: '<path d="M8 5 3 10l5 5M3 10h10a6 6 0 0 1 0 12"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
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
let canonicalModel = null;
let libraryRevision = 0;
let isReady = false;
let isSaving = false;
let storageError = '';
let openItemId = null;
let nativeBusy = false;
let syncingFiles = false;
let fileSyncPaused = false;
const fileStates = new Map();
const native = window.FieldNative;
const repository = window.FieldStorage.open();
const quickMenu = window.FieldContextMenu.create({ document, window });

function applyModel(model) {
  canonicalModel = model;
  for (const [viewArray, records] of [[fields, model.fields], [items, model.items], [connections, model.connections]]) {
    viewArray.length = 0;
    for (const record of records) viewArray.push(record);
  }
}

async function initializeLibrary() {
  try {
    const saved = await repository.load();
    const model = new window.FieldModel.LibraryModel(saved.snapshot);
    applyModel(model);
    libraryRevision = saved.revision;
    isReady = true;
  } catch (error) {
    storageError = error.message;
  }
  render();
  await native.ready;
  syncFileReferences();
}

function nativeSnapshot(reference) {
  const { referenceId, identity, path, fileName, size, modifiedUtc, status, recoverable, message } = reference;
  return { referenceId, identity, path, fileName, size, modifiedUtc, status, recoverable, message };
}

function filePatch(item, reference) {
  const patch = { native: nativeSnapshot(reference) };
  if (reference.path) patch.path = reference.path;
  if (reference.status === 'available') {
    Object.assign(patch, { fileName: reference.fileName, modifiedUtc: reference.modifiedUtc });
    if (Number.isSafeInteger(reference.size)) patch.size = reference.size;
    if (item.title === item.fileName) patch.title = reference.fileName;
  }
  return patch;
}

function fileState(item) {
  if (!item.native) return { status: 'untracked', label: 'Untracked' };
  if (!native.available) return { status: 'offline', label: 'Tracking offline', message: 'Open FIELD.cmd to reconnect.' };
  const state = fileStates.get(item.id) || item.native;
  const labels = { available: state.recoverable ? 'Available' : 'Path only', missing: 'Missing', unavailable: 'Unavailable', inaccessible: 'Access denied', unsupported: 'Relink required', replaced: 'File replaced', unregistered: 'Relink required' };
  return { ...state, label: labels[state.status] || 'Unavailable' };
}

function fileStatus(item, detail = false) {
  const state = fileState(item);
  if (!detail && state.status === 'available' && state.recoverable) return '';
  return `<span class="file-status ${state.status === 'available' ? 'available' : ''}" data-file-status="${escapeHTML(state.status)}">${escapeHTML(state.label)}</span>${detail && state.message ? `<p class="file-status-message">${escapeHTML(state.message)}</p>` : ''}`;
}

function renderFileChanges() {
  const focused = document.activeElement.closest('[data-action]');
  const focusAction = focused?.dataset.action;
  const focusId = focused?.dataset.id;
  const selected = openItemId;
  render();
  if (selected && byItem(selected)) openItem(selected);
  if (focusAction) [...document.querySelectorAll('[data-action]')].find(node => node.dataset.action === focusAction && node.dataset.id === focusId)?.focus({ preventScroll: true });
}

async function syncFileReferences(force = false) {
  if (!isReady || isSaving || nativeBusy || syncingFiles || fileSyncPaused || $('#modal').open || quickMenu.isOpen || dragged || document.hidden && !force) return;
  const tracked = items.filter(item => item.kind === 'file' && item.native);
  if (!tracked.length) return;
  syncingFiles = true;
  try {
    if (!native.available && !await native.connect()) return;
    const references = [];
    const ids = [...new Set(tracked.map(item => item.native.referenceId))];
    for (let offset = 0; offset < ids.length; offset += 100) references.push(...await native.resolve(ids.slice(offset, offset + 100)));
    // A modal or relink may have opened while metadata was being checked.
    if (isSaving || nativeBusy || $('#modal').open || quickMenu.isOpen) return;
    const found = new Map(references.map(reference => [reference.referenceId, reference]));
    const updates = [];
    let statesChanged = false;
    for (const before of tracked) {
      const item = byItem(before.id);
      const reference = found.get(before.native.referenceId);
      if (!item || item.native?.referenceId !== before.native.referenceId || !reference) continue;
      const state = nativeSnapshot(reference);
      if (JSON.stringify(fileStates.get(item.id)) !== JSON.stringify(state)) statesChanged = true;
      fileStates.set(item.id, state);
      if (reference.status === 'unregistered') continue;
      const patch = filePatch(item, reference);
      if (Object.entries(patch).some(([key, value]) => JSON.stringify(item[key]) !== JSON.stringify(value))) updates.push([item.id, patch]);
    }
    if (updates.length) {
      await saveMutation(model => updates.forEach(([id, patch]) => model.updateItem(id, patch)));
    }
    if (updates.length || statesChanged) renderFileChanges();
  } catch (error) {
    if (native.available) {
      fileSyncPaused = true;
      toast(saveError(error));
    }
  } finally { syncingFiles = false; }
}

window.addEventListener('field-runtime-change', () => {
  if (isReady && !isSaving && !nativeBusy && !$('#modal').open) renderFileChanges();
});
setInterval(syncFileReferences, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFileReferences(true); });

function saveError(error) {
  return error.name === 'QuotaExceededError' ? 'Device storage is full. Your changes were not saved.' : error.message;
}

async function saveMutation(change, form) {
  if (!isReady) throw new Error('The library is not ready.');
  if (isSaving) throw new Error('A save is already in progress.');
  const candidate = new window.FieldModel.LibraryModel(canonicalModel.snapshot());
  const result = change(candidate);
  const submit = form?.querySelector('[type=submit]');
  const activeForm = form || $('#modal-content');
  const wasInert = activeForm.inert;
  activeForm.inert = true;
  isSaving = true;
  document.body.setAttribute('aria-busy', 'true');
  if (submit) submit.disabled = true;
  try {
    const saved = await repository.save(candidate.snapshot(), libraryRevision);
    applyModel(candidate);
    libraryRevision = saved.revision;
    return result;
  } finally {
    isSaving = false;
    document.body.removeAttribute('aria-busy');
    activeForm.inert = wasInert;
    if (submit?.isConnected) submit.disabled = false;
  }
}

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
  return `<div class="add-menu-wrap">${button('Add', 'toggle-add', 'primary', 'aria-expanded="false" aria-controls="add-menu"', 'plus')}<div class="add-menu" id="add-menu" hidden>${Object.entries(kinds).map(([kind, meta]) => `<button data-action="add-item" data-kind="${kind}">${icon(meta.icon)}${meta.label}</button>`).join('')}${currentField && items.length ? `<div class="menu-separator"></div><button data-action="add-existing">${icon('link')}Existing item</button>` : ''}</div></div>`;
}

function navigate(next, id = null) {
  view = next;
  currentField = id;
  itemFilter = 'all';
  closeDetail();
  render();
}

function renderSidebar() {
  document.querySelectorAll('[data-view]').forEach(node => {
    const active = node.dataset.view === (view === 'field' ? 'fields' : view);
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  if (view === 'everything') $('.brand').setAttribute('aria-current', 'page');
  else $('.brand').removeAttribute('aria-current');
  $('#field-count').textContent = fields.length ? fields.filter(field => !field.parent).length : '';
  const renderTree = (parent, depth = 0) => fields.filter(field => field.parent === parent).map(field => `<button data-action="open-field" data-id="${field.id}" class="${currentField === field.id ? 'current' : ''}" style="padding-left:${14 + depth * 13}px;--field-color:${field.color}"><span class="field-dot"></span><span class="nav-field-name">${escapeHTML(field.name)}</span></button>${renderTree(field.id, depth + 1)}`).join('');
  $('#field-navigation').innerHTML = fields.length ? `<div class="section-label">Fields</div>${renderTree(null)}` : '';
}

function render() {
  quickMenu.close({ restoreFocus: false });
  mapObserver?.disconnect();
  if (!isReady) {
    $('#content').innerHTML = storageError ? heading('Library unavailable', '') + `<p class="storage-error" role="alert">${escapeHTML(storageError)}</p>` + button('Reload', 'reload-library', 'secondary') : '<div class="empty-state">Loading…</div>';
    return;
  }
  renderSidebar();
  $('#content').innerHTML = view === 'field' ? renderField() : view === 'everything' ? renderEverything() : renderFields();
  if (view === 'everything' && everythingMode === 'map' && fields.length) initMap();
  window.FieldPreviews.observe(items);
}

function renderFieldRow(field) {
  const count = itemsIn(field.id).length;
  return `<button class="entry-row field-row" data-action="open-field" data-id="${field.id}" style="--field-color:${field.color}"><span class="entry-icon">${icon('folder')}</span><span class="field-row-info"><strong class="entry-name" title="${escapeHTML(field.name)}">${escapeHTML(field.name)}</strong><small class="entry-count">${count} ${count === 1 ? 'item' : 'items'}</small></span></button>`;
}

function renderFields() {
  const roots = fields.filter(field => !field.parent);
  return heading('Fields', button('New field', 'new-field', 'primary', '', 'plus')) + (roots.length ? `<div class="entry-list field-list">${roots.map(renderFieldRow).join('')}</div>` : '<div class="empty-state">No fields</div>');
}

function renderFilters() {
  return `<div class="item-toolbar" aria-label="Filter items">${[['all', 'All'], ...Object.entries(kinds).map(([key, value]) => [key, value.plural])].map(([key, label]) => `<button class="filter-button ${itemFilter === key ? 'active' : ''}" data-action="filter" data-kind="${key}">${label}</button>`).join('')}</div>`;
}

function imagePreview(item, detail = false) {
  if (item.kind !== 'file') return '';
  const attached = attachments.get(item.id);
  const className = detail ? 'detail-image' : 'item-thumbnail';
  if (attached && item.mime?.startsWith('image/')) return `<img class="${className}" src="${attached.url}" alt="${detail ? escapeHTML(item.title) : ''}">`;
  return window.FieldPreviews.supported(item) ? `<img class="${className}" data-image-preview="${item.id}" alt="${detail ? escapeHTML(item.title) : ''}" hidden>` : '';
}

function renderItem(item) {
  const meta = kinds[item.kind];
  const notePreview = item.kind === 'note' ? (item.body === item.title ? '' : item.body.startsWith(item.title + '\n') ? item.body.slice(item.title.length + 1) : item.body) : '';
  const extra = item.kind === 'link' ? new URL(item.url).hostname : item.kind === 'file' ? (item.path || (item.fileName !== item.title ? item.fileName : '') || '') : '';
  const description = notePreview || extra;
  const metadata = (description ? `<span class="item-description">${escapeHTML(description.replace(/\s+/g, ' ').slice(0, 350))}</span>` : '') + (item.kind === 'file' ? fileStatus(item) + (item.size !== undefined ? `<span class="file-size">${formatSize(item.size)}</span>` : '') : '');
  return `<button class="entry-row item-row" data-action="open-item" data-id="${item.id}"><span class="entry-icon">${icon(meta.icon)}</span><span class="sr-only">${meta.label}: </span><span class="entry-content"><span class="entry-heading"><strong class="entry-name" title="${escapeHTML(item.title)}">${escapeHTML(item.title)}</strong>${item.fields.length > 1 ? `<span class="membership-count">${icon('link')}<span>${item.fields.length}<span class="sr-only"> fields</span></span></span>` : ''}</span>${metadata ? `<span class="entry-meta">${metadata}</span>` : ''}</span>${item.kind === 'drawing' ? `<img class="item-thumbnail" src="${item.drawing}" alt="">` : imagePreview(item)}</button>`;
}

function renderItems(list) {
  const visible = list.filter(item => itemFilter === 'all' || item.kind === itemFilter);
  return (list.length ? renderFilters() : '') + (visible.length ? `<div class="entry-list item-list">${visible.map(renderItem).join('')}</div>` : `<div class="empty-state">${itemFilter === 'all' ? 'No items' : `No ${kinds[itemFilter].plural.toLowerCase()}`}</div>`);
}

function renderField() {
  const field = byField(currentField);
  const parents = ancestry(field.id).slice(0, -1);
  const list = itemsIn(field.id);
  const children = fields.filter(child => child.parent === field.id);
  const related = allEdges().filter(edge => edge.kind !== 'parent' && [edge.from, edge.to].includes(field.id));
  const crumbs = `<div class="breadcrumb"><button data-action="go-fields">Fields</button>${parents.map(parent => `<span>/</span><button data-action="open-field" data-id="${parent.id}">${escapeHTML(parent.name)}</button>`).join('')}<span>/</span><span>${escapeHTML(field.name)}</span></div>`;
  const actions = button('<span class="action-label">Subfield</span>', 'new-field', 'quiet', `data-parent="${field.id}" aria-label="New subfield"`, 'subfield') + (fields.length > 1 ? button('', 'connect-fields', 'quiet', 'aria-label="Connect fields"', 'link') : '') + addMenu() + button('', 'field-menu', 'quiet field-more', `data-id="${field.id}" aria-label="Field actions" aria-haspopup="menu"`, 'more');
  return crumbs + heading(field.name, actions, list.length) + (children.length ? `<div class="entry-list subfield-list">${children.map(renderFieldRow).join('')}</div>` : '') + renderItems(list) + (related.length ? `<div class="section-heading">Connections</div><div class="connections">${related.map(edge => `<button class="connection-chip" data-action="open-edge" data-id="${edge.id}">${icon('link')}${escapeHTML(byField(edge.from === field.id ? edge.to : edge.from).name)}${connectionName(edge) ? `<span>${escapeHTML(connectionName(edge))}</span>` : ''}</button>`).join('')}</div>` : '');
}

function renderEverything() {
  const actions = fields.length ? addMenu() : button('New field', 'new-field', 'primary', '', 'plus');
  const tools = `<div class="everything-toolbar overview-toolbar" aria-label="Library overview"><div class="segmented">${[['map', 'Map'], ['items', 'Items']].map(([key, label]) => `<button class="${everythingMode === key ? 'active' : ''}" data-action="everything-mode" data-mode="${key}">${label}</button>`).join('')}</div><div class="header-actions">${everythingMode === 'map' && fields.length > 1 ? button('Connect', 'connect-fields', 'secondary compact', '', 'link') : ''}${actions}</div></div>`;
  if (everythingMode === 'items') return tools + renderItems([...items].reverse());
  const edge = allEdges().find(candidate => candidate.id === selectedEdge && candidate.kind !== 'parent');
  return tools + (!fields.length ? '<div class="empty-state">No fields</div>' : `<div class="map-layout ${edge ? 'has-inspector' : ''}"><div class="map-shell" id="map-shell"><div class="graph-stage" id="graph-stage"><svg class="graph-lines" id="graph-lines" aria-hidden="true"></svg><div id="graph-nodes"></div><div id="graph-labels"></div></div><div class="map-legend"><span><i></i> Shared items</span><span><i class="dashed"></i> Connection</span></div><div class="map-controls"><button data-action="zoom-out" aria-label="Zoom out">−</button><button data-action="zoom-reset" aria-label="Fit map">${icon('grid')}</button><button data-action="zoom-in" aria-label="Zoom in">+</button></div></div>${edge ? renderInspector(edge) : ''}</div>`);
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

function connectionName(edge) {
  return edge.kind === 'shared' ? edge.label : /^(?:connection|related)$/i.test(edge.label?.trim() || '') ? '' : edge.label || '';
}

function renderInspector(edge) {
  return `<aside class="map-inspector"><div class="inspector-top"><span>${escapeHTML(byField(edge.from).name)} ↔ ${escapeHTML(byField(edge.to).name)}</span><button class="icon-button" data-action="close-edge" aria-label="Close connection">${icon('close')}</button></div><h2>${edge.kind === 'shared' ? 'Shared items' : escapeHTML(connectionName(edge) || 'Connection')}</h2>${edge.note ? `<p>${escapeHTML(edge.note)}</p>` : ''}${(edge.items || []).map(id => { const item = byItem(id); return `<button class="shared-item" data-action="open-item" data-id="${id}">${icon(kinds[item.kind].icon)}<span>${escapeHTML(item.title)}</span></button>`; }).join('')}<div class="inspector-fields">${button(escapeHTML(byField(edge.from).name), 'open-field', 'secondary compact', `data-id="${edge.from}"`, 'folder')}${button(escapeHTML(byField(edge.to).name), 'open-field', 'secondary compact', `data-id="${edge.to}"`, 'folder')}</div></aside>`;
}

function nodePosition(field) {
  if (positions.has(field.id)) return positions.get(field.id);
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(fields.length))));
  const index = fields.indexOf(field);
  return { x: (mapSize.width - (columns * 176 + (columns - 1) * 70)) / 2 + index % columns * 246, y: 70 + Math.floor(index / columns) * 150 };
}

function drawEdges() {
  const edges = allEdges();
  const routes = window.FieldMapGeometry.routes(edges, id => {
    const field = byField(id);
    if (!field) return null;
    const node = document.querySelector(`[data-map-node="${id}"]`);
    return { ...nodePosition(field), width: node?.offsetWidth || 176, height: node?.offsetHeight || 77 };
  });
  $('#graph-lines').innerHTML = edges.map(edge => {
    const route = routes.get(edge.id);
    return route ? `<path class="edge ${edge.kind} ${edge.id === selectedEdge ? 'selected' : ''}" d="${route.path}"/>` : '';
  }).join('');
  $('#graph-labels').innerHTML = edges.filter(edge => edge.kind !== 'parent').map(edge => {
    const route = routes.get(edge.id);
    if (!route) return '';
    const name = connectionName(edge);
    const description = `${byField(edge.from).name} ↔ ${byField(edge.to).name}${name ? `: ${name}` : ''}`;
    return `<button class="edge-label ${!name ? 'edge-marker' : ''} ${edge.id === selectedEdge ? 'selected' : ''}" data-action="select-edge" data-id="${edge.id}" style="left:${route.label.x}px;top:${route.label.y}px" aria-label="${escapeHTML(description)}" title="${escapeHTML(description)}">${name ? escapeHTML(name) : icon('link')}</button>`;
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
  quickMenu.close();
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
  showModal(parent ? 'New subfield' : 'New field', `<form id="field-form"><label class="form-label" for="field-name">Name</label><input class="input" id="field-name" maxlength="64" required autocomplete="off"><div class="swatches">${colors.map(candidate => `<button type="button" class="swatch ${candidate === color ? 'selected' : ''}" style="--swatch:${candidate}" data-color="${candidate}" aria-label="${candidate}" aria-pressed="${candidate === color}"></button>`).join('')}</div><p class="form-error" id="field-error" role="alert"></p><div class="form-actions">${button('Cancel', 'close-modal', 'quiet', 'type="button"')}<button class="button primary" type="submit">Create</button></div></form>`);
  document.querySelectorAll('[data-color]').forEach(node => node.onclick = () => {
    color = node.dataset.color;
    document.querySelectorAll('[data-color]').forEach(candidate => {
      candidate.classList.toggle('selected', candidate === node);
      candidate.setAttribute('aria-pressed', String(candidate === node));
    });
  });
  $('#field-form').onsubmit = async event => {
    event.preventDefault();
    if (isSaving) return;
    const name = $('#field-name').value.trim();
    if (!name) return;
    const field = { id: uid('field'), name, color, parent };
    try {
      await saveMutation(model => model.createField(field), event.currentTarget);
      closeModal();
      navigate('field', field.id);
    } catch (error) {
      $('#field-error').textContent = saveError(error);
    }
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

function compose(kind, existingId = null, relinking = false) {
  const existing = existingId ? byItem(existingId) : null;
  const inField = currentField;
  if (!fields.length && !existing) return newField();
  let chosenFile = existingId ? attachments.get(existingId)?.file : null;
  let selectedNewFile = false;
  let selectedReference = existing?.native || null;
  let preparing = false;
  const fieldSelect = !existing && !inField ? `<label class="form-label" for="item-field">Field</label><select class="input" id="item-field">${fieldOptions(fields[0].id)}</select>` : '';
  let body = '';
  if (kind === 'link') body = `<label class="form-label" for="item-url">URL</label><input class="input" id="item-url" placeholder="https://" value="${escapeHTML(existing?.url || '')}" required>`;
  if (kind === 'file') body = `<div class="file-picker"><button class="button secondary" type="button" id="choose-file">${icon('file')}Choose file</button><input type="file" id="file-input" hidden><span class="file-picker-name" id="file-picker-name">${escapeHTML(existing?.fileName || '')}</span></div><label class="form-label" for="item-path">PC path <span class="optional">optional if a file is selected</span></label><input class="input" id="item-path" placeholder="C:\\" value="${escapeHTML(existing?.path || '')}">`;
  body += `<label class="form-label" for="item-title">Name <span class="optional">optional</span></label><input class="input" id="item-title" maxlength="120" value="${escapeHTML(existing?.title || '')}">`;
  if (kind === 'note') body += `<label class="form-label" for="item-body">Note</label><textarea class="input note-body" id="item-body" required>${escapeHTML(existing?.body || '')}</textarea>`;
  if (kind === 'drawing') body += `<div class="drawing-toolbar"><input type="color" id="pen-color" class="drawing-color" value="#d5dff3" aria-label="Pen color"><input type="range" id="pen-width" min="1" max="12" value="2" aria-label="Pen width"><button class="button secondary compact" type="button" id="drawing-undo">${icon('undo')}Undo</button><button class="button secondary compact" type="button" id="drawing-clear">Clear</button></div><canvas class="drawing-canvas" id="drawing-canvas" aria-label="Drawing canvas"></canvas>`;
  showModal(relinking ? 'Relink file' : `${existing ? 'Edit' : 'New'} ${typeName(kind).toLowerCase()}`, `<form id="item-form">${body}${fieldSelect}<p class="form-error" id="item-error" role="alert"></p><div class="form-actions">${button('Cancel', 'close-modal', 'quiet', 'type="button"')}<button class="button primary" type="submit">${relinking ? 'Relink' : existing ? 'Save' : 'Add'}</button></div></form>`, kind === 'note' || kind === 'drawing');
  if (kind === 'file') $('#choose-file').onclick = async () => {
    if (nativeBusy) return;
    if (!native.available) {
      if (existing?.native || relinking) { $('#item-error').textContent = 'Open FIELD.cmd to connect file tracking.'; return; }
      $('#file-input').click();
      return;
    }
    const form = $('#item-form');
    nativeBusy = true;
    form.inert = true;
    try {
      const reference = await native.pick();
      if (!reference) return;
      selectedReference = reference;
      selectedNewFile = true;
      chosenFile = null;
      $('#item-path').value = reference.path;
      $('#file-picker-name').textContent = reference.fileName;
      if (!$('#item-title').value || existing && existing.title === existing.fileName && $('#item-title').value === existing.title) $('#item-title').value = reference.fileName;
      $('#item-error').textContent = '';
    } catch (error) { $('#item-error').textContent = error.message; }
    finally { nativeBusy = false; form.inert = false; $('#choose-file').focus(); }
  };
  if (kind === 'file') $('#file-input').onchange = event => {
    if (!event.target.files[0]) return;
    chosenFile = event.target.files[0];
    selectedReference = null;
    selectedNewFile = true;
    $('#item-path').value = '';
    $('#file-picker-name').textContent = chosenFile?.name || '';
    if (!$('#item-title').value && chosenFile) $('#item-title').value = chosenFile.name;
  };
  if (kind === 'file') $('#item-path').oninput = () => {
    if (selectedReference?.path !== $('#item-path').value.trim()) selectedReference = null;
    if (selectedNewFile && !selectedReference) chosenFile = null;
    else chosenFile = existing && $('#item-path').value.trim() === (existing.path || '') ? attachments.get(existing.id)?.file : null;
    $('#file-picker-name').textContent = chosenFile?.name || '';
  };
  if (kind === 'drawing') {
    drawingPad = window.FieldDrawing.mount($('#drawing-canvas'), { color: '#d5dff3', lineWidth: 2, initialDataUrl: existing?.drawing });
    $('#pen-color').oninput = event => drawingPad.setColor(event.target.value);
    $('#pen-width').oninput = event => drawingPad.setLineWidth(event.target.value);
    $('#drawing-undo').onclick = () => drawingPad.undo();
    $('#drawing-clear').onclick = () => drawingPad.clear();
  }
  $('#item-form').onsubmit = async event => {
    event.preventDefault();
    if (isSaving || preparing) return;
    preparing = true;
    nativeBusy = true;
    const form = event.currentTarget;
    form.inert = true;
    try {
      const record = existing ? { ...existing } : { id: uid('item'), kind, createdAt: Date.now() };
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
        const unchanged = existing?.native && !selectedNewFile && record.path === existing.path && !relinking;
        if (unchanged) {
          // Editing a name while the drive is offline must retain the original identity.
          const reference = native.available ? (await native.resolve([existing.native.referenceId]))[0] : null;
          if (reference && reference.status !== 'unregistered') Object.assign(record, filePatch(existing, reference));
          if (title === existing.fileName) title = record.fileName;
        } else if (record.path && native.available) {
          const reference = selectedReference?.path === record.path && selectedNewFile ? selectedReference : await native.track(record.path);
          Object.assign(record, filePatch(existing || record, reference));
          chosenFile = null;
          if (existing && existing.title === existing.fileName && title === existing.title) title = reference.fileName;
        } else if (existing?.native || relinking) {
          throw new Error('Open FIELD.cmd to relink this file.');
        } else {
          record.native = null;
          record.fileName = chosenFile?.name || record.path.split(/[\\/]/).pop();
        }
        if (chosenFile && !record.native) {
          record.size = chosenFile.size;
          record.mime = chosenFile.type;
        } else if (!record.native && existing && record.path !== (existing.path || '')) {
          delete record.size;
          delete record.mime;
        }
        title ||= record.fileName;
      } else if (kind === 'drawing') {
        if (!drawingPad.hasContent()) throw new Error('Add a drawing.');
        record.drawing = drawingPad.toDataURL();
        title ||= 'Drawing';
      }
      record.title = title;
      const target = inField || $('#item-field')?.value;
      const result = await saveMutation(model => {
        if (existing) {
          model.updateItem(existing.id, record);
          return { itemId: existing.id, created: false, edited: true };
        }
        return model.createItem(record, [target]);
      }, form);
      if (existing?.kind === 'file' && (record.native || !chosenFile && record.path !== (existing.path || ''))) {
        attachments.get(result.itemId)?.url && URL.revokeObjectURL(attachments.get(result.itemId).url);
        attachments.delete(result.itemId);
      }
      if (chosenFile && (result.created || result.edited)) {
        attachments.get(result.itemId)?.url && URL.revokeObjectURL(attachments.get(result.itemId).url);
        attachments.set(result.itemId, { file: chosenFile, url: URL.createObjectURL(chosenFile) });
      }
      if (record.native && (result.created || result.edited)) fileStates.set(result.itemId, record.native);
      closeModal();
      itemFilter = 'all';
      render();
      if (existing || !result.created) openItem(result.itemId);
      if (!existing && !result.created) toast(result.added ? 'Existing item added to field' : 'Already in this field');
    } catch (error) {
      $('#item-error').textContent = error.message === 'Invalid URL' ? 'Enter a valid URL.' : saveError(error);
    } finally { preparing = false; nativeBusy = false; form.inert = false; }
  };
}

function openItem(id) {
  const item = byItem(id);
  if (!item) return;
  openItemId = id;
  const file = attachments.get(id);
  const meta = kinds[item.kind];
  let body = item.kind === 'note' ? `<div class="detail-body">${escapeHTML(item.body)}</div>` : item.kind === 'drawing' ? `<img class="detail-drawing" src="${item.drawing}" alt="${escapeHTML(item.title)}">` : item.kind === 'link' ? `<a class="detail-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item.url)}</a>` : `${imagePreview(item, true)}${item.path ? `<div class="detail-path">${escapeHTML(item.path)}</div>` : `<div class="detail-path">${escapeHTML(item.fileName)}</div>`}${item.size !== undefined ? `<div class="detail-metadata">${formatSize(item.size)}</div>` : ''}`;
  const openAction = item.kind === 'link' ? `<a class="button secondary compact" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer">${icon('external')}Open</a>` : item.kind === 'file' ? (file ? `<a class="button secondary compact" href="${file.url}" target="_blank" rel="noopener">${icon('external')}Open file</a>` : '') + (item.path ? button('Copy path', 'copy-path', 'secondary compact', `data-id="${id}"`, 'copy') : '') : item.kind === 'drawing' ? `<a class="button secondary compact" href="${item.drawing}" download="${escapeHTML(item.title.replace(/[^a-z0-9_-]/gi, '_'))}.png">Save PNG</a>` : '';
  const nativeActions = item.kind === 'file' && item.native ? button('Open file', 'open-native-file', 'secondary compact', `data-id="${id}" ${fileState(item).status !== 'available' ? 'disabled' : ''}`, 'external') : '';
  const relinkAction = item.kind === 'file' ? button(item.native ? 'Relink' : native.available ? 'Track file' : 'Reconnect', 'relink-file', 'secondary compact', `data-id="${id}"`) : '';
  $('#detail-panel').innerHTML = `<div class="detail-top"><span>${icon(meta.icon)}${meta.label}</span><button class="icon-button" data-action="close-detail" aria-label="Close item">${icon('close')}</button></div><h2>${escapeHTML(item.title)}</h2>${body}${item.kind === 'file' ? fileStatus(item, true) : ''}<div class="detail-actions">${nativeActions}${openAction}${button('Edit', 'edit-item', 'secondary compact', `data-id="${id}"`)}${relinkAction}</div><div class="detail-fields-title"><span>Fields</span>${button('Manage', 'share-item', 'quiet compact', `data-id="${id}"`)}</div><div class="membership-list">${item.fields.map(fieldId => `<button data-action="open-field" data-id="${fieldId}" style="--field-color:${byField(fieldId).color}"><span class="field-dot"></span>${escapeHTML(fieldPath(fieldId))}<span class="membership-arrow">↗</span></button>`).join('') || '<div class="blank-message">No fields</div>'}</div>`;
  $('#detail-panel').hidden = false;
  window.FieldPreviews.observe(items);
}

function closeDetail() {
  openItemId = null;
  $('#detail-panel').hidden = true;
}

async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { toast('Clipboard unavailable'); }
}

async function openNativeFile(id) {
  const item = byItem(id);
  if (!item?.native || fileState(item).status !== 'available') return;
  nativeBusy = true;
  try { await native.open(item.native.referenceId); }
  catch (error) { toast(error.message); }
  finally { nativeBusy = false; renderFileChanges(); syncFileReferences(true); }
}

function openItemTarget(id) {
  const item = byItem(id);
  if (!item) return;
  if (item.kind === 'link') window.open(item.url, '_blank', 'noopener,noreferrer');
  else if (item.kind === 'file' && item.native) openNativeFile(id);
  else if (item.kind === 'file' && attachments.has(id)) window.open(attachments.get(id).url, '_blank', 'noopener,noreferrer');
  else openItem(id);
}

function saveDrawing(id) {
  const item = byItem(id);
  if (item?.kind !== 'drawing') return;
  const download = document.createElement('a');
  download.href = item.drawing;
  download.download = `${item.title.replace(/[^a-z0-9_-]/gi, '_')}.png`;
  document.body.append(download);
  download.click();
  download.remove();
}

async function removeFromField(id, fieldId) {
  const item = byItem(id);
  if (!item?.fields.includes(fieldId)) return;
  try {
    await saveMutation(model => model.setMemberships(id, byItem(id).fields.filter(member => member !== fieldId)));
    const selected = openItemId;
    render();
    if (selected) openItem(selected);
    $('#content').focus({ preventScroll: true });
    toast('Removed from field');
  } catch (error) { toast(saveError(error)); }
}

function itemQuickActions(item) {
  const entries = [];
  if (item.kind === 'file' && item.native) {
    entries.push({ label: 'Open file', icon: icon('external'), disabled: fileState(item).status !== 'available', run: () => openNativeFile(item.id) });
  } else {
    entries.push({ label: item.kind === 'file' && attachments.has(item.id) ? 'Open file' : 'Open', icon: icon('external'), run: () => openItemTarget(item.id) });
  }
  if (item.kind === 'file' && item.path) entries.push({ label: 'Copy path', icon: icon('copy'), run: () => copyText(byItem(item.id).path, 'Path copied') });
  if (item.kind === 'link') entries.push({ label: 'Copy link', icon: icon('copy'), run: () => copyText(byItem(item.id).url, 'Link copied') });
  if (item.kind === 'note') entries.push({ label: 'Copy text', icon: icon('copy'), run: () => copyText(byItem(item.id).body, 'Text copied') });
  if (item.kind === 'drawing') entries.push({ label: 'Save PNG', icon: icon('file'), run: () => saveDrawing(item.id) });
  entries.push(null, { label: 'Edit', icon: icon('pen'), run: () => compose(item.kind, item.id) });
  if (item.kind === 'file') entries.push({ label: item.native ? 'Relink' : native.available ? 'Track file' : 'Reconnect', icon: icon('link'), run: () => compose('file', item.id, Boolean(item.native || native.available)) });
  entries.push({ label: 'Manage fields', icon: icon('folder'), run: () => shareItem(item.id) });
  if (currentField && item.fields.includes(currentField)) {
    const fieldId = currentField;
    entries.push(null, { label: 'Remove from field', icon: icon('close'), run: () => removeFromField(item.id, fieldId) });
  }
  return entries;
}

function fieldQuickActions(field) {
  return [
    { label: 'Open', icon: icon('folder'), run: () => navigate('field', field.id) },
    { label: 'New subfield', icon: icon('subfield'), run: () => newField(field.id) },
    null,
    { label: 'Delete field', icon: icon('trash'), danger: true, run: () => confirmDeleteField(field.id) }
  ];
}

function confirmDeleteField(id) {
  const field = byField(id);
  if (!field) return;
  const children = fields.filter(child => child.parent === id);
  const destination = field.parent ? byField(field.parent).name : 'Fields';
  showModal(`Delete “${field.name}”?`, `<form id="delete-field-form"><p class="confirm-copy">Items stay in FIELD.${children.length ? ` Subfields move to ${escapeHTML(destination)}.` : ''}</p><p class="form-error" id="delete-field-error" role="alert"></p><div class="form-actions">${button('Cancel', 'close-modal', 'quiet', 'type="button"')}<button class="button danger" type="submit">Delete field</button></div></form>`);
  $('#delete-field-form [data-action="close-modal"]').focus();
  $('#delete-field-form').onsubmit = async event => {
    event.preventDefault();
    if (isSaving || nativeBusy) return;
    try {
      const result = await saveMutation(model => model.deleteField(id), event.currentTarget);
      positions.delete(id);
      if (!allEdges().some(edge => edge.id === selectedEdge)) selectedEdge = null;
      if (currentField === id) { currentField = result.parentId; view = currentField ? 'field' : 'fields'; }
      closeModal();
      render();
      if (openItemId) openItem(openItemId);
      $('#content').focus({ preventScroll: true });
      toast('Field deleted');
    } catch (error) { $('#delete-field-error').textContent = saveError(error); }
  };
}

function quickMenuFor(target) {
  if (!isReady || isSaving || nativeBusy || $('#modal').open || target.closest('input, textarea, select, [contenteditable]')) return null;
  const itemNode = target.closest('[data-action="open-item"]');
  const item = byItem(itemNode?.dataset.id);
  if (item) return { anchor: itemNode, label: item.title, entries: itemQuickActions(item) };
  const fieldNode = target.closest('[data-action="open-field"]');
  const field = byField(fieldNode?.dataset.id);
  if (field) return { anchor: fieldNode, label: field.name, entries: fieldQuickActions(field) };
  const detailItem = target.closest('#detail-panel') && byItem(openItemId);
  if (detailItem) return { anchor: $('#detail-panel'), label: detailItem.title, entries: itemQuickActions(detailItem) };
  if (!target.closest('#main') || target.closest('button, a, [role="button"]')) return null;
  const entries = [{ label: 'New field', icon: icon('folder'), run: () => newField() }];
  if (view === 'field') entries.push({ label: 'New subfield', icon: icon('subfield'), run: () => newField(currentField) });
  if (fields.length && view !== 'fields') {
    entries.push(null, ...Object.entries(kinds).map(([kind, meta]) => ({ label: `New ${meta.label.toLowerCase()}`, icon: icon(meta.icon), run: () => compose(kind) })));
    if (currentField && items.some(item => !item.fields.includes(currentField))) entries.push(null, { label: 'Add existing item', icon: icon('link'), run: addExisting });
  }
  if (view === 'field') entries.push(null, { label: 'Delete field', icon: icon('trash'), danger: true, run: () => confirmDeleteField(currentField) });
  return { anchor: $('#content'), label: view === 'field' ? byField(currentField).name : 'Fields', entries };
}

function showQuickMenu(target, x, y) {
  const menu = quickMenuFor(target);
  if (!menu) { quickMenu.close(); return; }
  const add = $('#add-menu');
  if (add) add.hidden = true;
  document.querySelector('[data-action="toggle-add"]')?.setAttribute('aria-expanded', 'false');
  quickMenu.open({ ...menu, x, y });
}

document.addEventListener('contextmenu', event => {
  if (event.target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  showQuickMenu(event.target, event.clientX, event.clientY);
});

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return;
  const target = document.activeElement;
  if (target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  const bounds = target.getBoundingClientRect();
  showQuickMenu(target, bounds.left, bounds.bottom);
});

function shareItem(id) {
  const item = byItem(id);
  showModal('Fields', `<form id="membership-form"><div class="membership-options">${fields.map(field => `<label class="membership-option" style="--field-color:${field.color}"><input type="checkbox" name="field" value="${field.id}" ${item.fields.includes(field.id) ? 'checked' : ''}><span class="field-dot"></span><span>${escapeHTML(fieldPath(field.id))}</span></label>`).join('')}</div><p class="form-error" id="membership-error" role="alert"></p><div class="form-actions">${button('Cancel', 'close-modal', 'quiet', 'type="button"')}<button class="button primary" type="submit">Save</button></div></form>`);
  $('#membership-form').onsubmit = async event => {
    event.preventDefault();
    if (isSaving) return;
    const selected = [...event.currentTarget.querySelectorAll('input:checked')].map(input => input.value);
    try {
      await saveMutation(model => model.setMemberships(id, selected), event.currentTarget);
      closeModal();
      render();
      openItem(id);
    } catch (error) {
      $('#membership-error').textContent = saveError(error);
    }
  };
}

function addExisting() {
  const target = currentField;
  const available = items.filter(item => !item.fields.includes(target));
  showModal('Add existing item', `<input class="input search-input" id="existing-query" placeholder="Search items" aria-label="Search existing items"><div class="search-results" id="existing-results"></div><p class="form-error" id="existing-error" role="alert"></p>`);
  const update = () => {
    const query = $('#existing-query').value.trim().toLowerCase();
    const visible = available.filter(item => [item.title, item.body, item.url, item.path].some(text => text?.toLowerCase().includes(query)));
    $('#existing-results').innerHTML = visible.map(item => `<button class="search-result" data-existing-item="${item.id}">${icon(kinds[item.kind].icon)}<div><strong>${escapeHTML(item.title)}</strong><small>${typeName(item.kind)}</small></div></button>`).join('') || '<div class="search-empty">No items available</div>';
    document.querySelectorAll('[data-existing-item]').forEach(node => node.onclick = async () => {
      if (isSaving) return;
      try {
        await saveMutation(model => {
          const item = model.items.find(candidate => candidate.id === node.dataset.existingItem);
          model.setMemberships(item.id, [...item.fields, target]);
        });
        closeModal();
        render();
        openItem(node.dataset.existingItem);
      } catch (error) {
        $('#existing-error').textContent = saveError(error);
      }
    });
  };
  $('#existing-query').oninput = update;
  update();
}

function newConnection() {
  if (fields.length < 2) return;
  const source = currentField || fields[0].id;
  const target = fields.find(field => field.id !== source).id;
  showModal('Connect fields', `<form id="connection-form"><label class="form-label" for="connection-from">Field</label><select class="input" id="connection-from">${fieldOptions(source)}</select><label class="form-label" for="connection-to">Connect to</label><select class="input" id="connection-to">${fieldOptions(target)}</select><label class="form-label" for="connection-label">Name <span class="optional">optional</span></label><input class="input" id="connection-label" maxlength="64"><label class="form-label" for="connection-note">Note <span class="optional">optional</span></label><textarea class="input short-note" id="connection-note"></textarea><p id="connection-error" class="form-error" role="alert"></p><div class="form-actions">${button('Cancel', 'close-modal', 'quiet', 'type="button"')}<button class="button primary" type="submit">Connect</button></div></form>`);
  $('#connection-form').onsubmit = async event => {
    event.preventDefault();
    if (isSaving) return;
    const from = $('#connection-from').value;
    const to = $('#connection-to').value;
    if (from === to) { $('#connection-error').textContent = 'Choose two different fields.'; return; }
    if (connections.some(edge => edge.from === from && edge.to === to || edge.from === to && edge.to === from)) {
      $('#connection-error').textContent = 'These fields are already connected.';
      return;
    }
    const label = $('#connection-label').value.trim() || 'Connection';
    const edge = { id: uid('connection'), from, to, kind: 'related', label, note: $('#connection-note').value.trim() };
    try {
      await saveMutation(model => model.createConnection(edge), event.currentTarget);
      selectedEdge = edge.id;
      closeModal();
      everythingMode = 'map';
      navigate('everything');
    } catch (error) {
      $('#connection-error').textContent = saveError(error);
    }
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
  const desktop = Boolean(window.FieldDesktop?.isDesktop);
  showModal('Library', `<div class="library-row"><span>Fields</span><span>${fields.length}</span></div>${Object.entries(kinds).map(([kind, meta]) => `<div class="library-row"><span>${meta.plural}</span><span>${items.filter(item => item.kind === kind).length}</span></div>`).join('')}<div class="library-actions"><button class="button secondary" type="button" id="export-library">Export library</button>${desktop ? '<button class="button secondary" type="button" id="import-library">Import library</button>' : ''}</div><p class="form-error" id="library-error" role="alert"></p><p class="library-status">${desktop ? 'Saved on this PC' : 'Saved in this browser'}</p>`);
  $('#export-library').onclick = () => {
    try {
      const text = window.FieldTransfer.encode(canonicalModel.snapshot());
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const download = document.createElement('a');
      download.href = url;
      download.download = 'FIELD-library.json';
      download.hidden = true;
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('#library-error').textContent = '';
    } catch (error) { $('#library-error').textContent = error.message; }
  };
  if (!desktop) return;
  $('#import-library').onclick = async () => {
    if (fields.length || items.length || connections.length) {
      $('#library-error').textContent = 'Import is available for an empty desktop library. Your current library has not changed.';
      return;
    }
    if (isSaving) return;
    const modalBody = $('#modal-content');
    let imported = false;
    isSaving = true;
    modalBody.inert = true;
    document.body.setAttribute('aria-busy', 'true');
    try {
      const selected = await window.FieldDesktop.request('library.pickImport', {}, 120000);
      if (selected.cancelled) return;
      const snapshot = window.FieldTransfer.decode(selected.text);
      const saved = await repository.import(snapshot, libraryRevision);
      const model = new window.FieldModel.LibraryModel(saved.snapshot);
      applyModel(model);
      libraryRevision = saved.revision;
      fileStates.clear();
      fileSyncPaused = false;
      imported = true;
    } catch (error) { $('#library-error').textContent = saveError(error); }
    finally {
      isSaving = false;
      modalBody.inert = false;
      document.body.removeAttribute('aria-busy');
    }
    if (imported) {
      closeModal();
      navigate('fields');
      toast('Library imported');
      syncFileReferences(true);
    }
  };
}

document.addEventListener('click', async event => {
  if (event.target.closest('[data-action="reload-library"]')) { location.reload(); return; }
  if (!isReady || isSaving || nativeBusy) return;
  const nav = event.target.closest('[data-view]');
  if (nav) navigate(nav.dataset.view);
  const node = event.target.closest('[data-action]');
  if (node && !node.disabled) {
    const id = node.dataset.id;
    switch (node.dataset.action) {
      case 'go-fields': navigate('fields'); break;
      case 'open-field': if (!dragged) navigate('field', id); break;
      case 'new-field': newField(node.dataset.parent || null); break;
      case 'field-menu': {
        const field = byField(id);
        const bounds = node.getBoundingClientRect();
        quickMenu.open({ anchor: node, label: field.name, entries: fieldQuickActions(field), x: bounds.right - 208, y: bounds.bottom + 6 });
        break;
      }
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
      case 'relink-file': compose('file', id, Boolean(byItem(id).native || native.available)); break;
      case 'open-native-file': await openNativeFile(id); break;
      case 'open-item': openItem(id); break;
      case 'share-item': shareItem(id); break;
      case 'add-existing':
        $('#add-menu').hidden = true;
        addExisting();
        break;
      case 'copy-path': await copyText(byItem(id).path, 'Path copied'); break;
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

$('.brand').onclick = event => { event.preventDefault(); if (isReady && !isSaving && !nativeBusy) navigate('everything'); };
$('#search-button').onclick = () => { if (isReady && !isSaving && !nativeBusy) search(); };
$('#settings').onclick = () => { if (isReady && !isSaving && !nativeBusy) library(); };
$('#modal').addEventListener('cancel', event => { if (isSaving || nativeBusy) event.preventDefault(); });
$('#modal').addEventListener('close', () => {
  drawingPad?.destroy();
  drawingPad = null;
  if (returnFocus?.isConnected) returnFocus.focus();
  if (isReady && !isSaving && !nativeBusy) { renderFileChanges(); syncFileReferences(true); }
});
$('#modal').addEventListener('click', event => {
  if (event.target !== $('#modal') || isSaving || nativeBusy) return;
  const bounds = $('#modal').getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeModal();
});
document.addEventListener('keydown', event => {
  if (event.defaultPrevented) return;
  if (!isReady || isSaving || nativeBusy) return;
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
initializeLibrary();
