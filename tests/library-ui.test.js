'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LibraryModel } = require('../library-model.js');

function harness({ count = 3 } = {}) {
  const model = new LibraryModel();
  for (const field of [
    { id: 'a', name: 'Archive', parent: null },
    { id: 'child', name: 'Recordings', parent: 'a' },
    { id: 'grandchild', name: 'Sessions', parent: 'child' },
    { id: 'b', name: 'Shared', parent: null }
  ]) model.createField({ ...field, color: '#6384ff' });
  for (let index = 0; index < count; index++) model.createItem({ id: `item-${index}`, kind: 'note', title: `Note ${index}`, body: `Content ${index}` }, ['a']);
  const listeners = new Map(), nodes = new Map();
  const stats = { renders: 0, navigations: [], lastHtml: '', focused: 0 };
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', open: false, value: '', focus() { stats.focused++; }, append() {}, querySelectorAll() { return [{ value: 'b' }]; } });
    return nodes.get(selector);
  };
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  let context;
  const document = {
    body: { setAttribute() {}, removeAttribute() {} },
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
    querySelector: node, querySelectorAll: () => [], createElement: () => ({})
  };
  const globals = {
    window: { FieldDesktop: { isDesktop: false }, addEventListener() {} }, document,
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    fields: model.fields, items: model.items, currentField: null, itemFilter: 'all',
    isReady: true, isSaving: false, nativeBusy: false, syncingFiles: false, libraryRevision: 0,
    openItemId: null, quickMenu: { isOpen: false }, fileStates: new Map(),
    colors: ['#6384ff'], kinds: { note: { plural: 'Notes', icon: 'note' } },
    $: node, escapeHTML, icon: name => `<svg data-icon="${name}"></svg>`,
    byField: id => context.fields.find(field => field.id === id), byItem: id => context.items.find(item => item.id === id),
    fieldPath: id => id,
    ancestry(id) {
      const result = [];
      for (let field = model.fields.find(field => field.id === id); field; field = model.fields.find(candidate => candidate.id === field.parent)) result.unshift(field);
      return result;
    },
    navigate(next, id) { context.currentField = id; stats.navigations.push([next, id]); },
    renderSidebar() {},
    renderItem: item => `<button class="item-row" data-action="open-item" data-id="${item.id}">${escapeHTML(item.title)}</button>`,
    renderItems() { return ''; }, renderFilters: () => '<div class="filters"></div>',
    renderFields: () => '<header><div class="header-actions"></div></header>',
    renderField: () => '<header></header>', fieldQuickActions: () => [],
    render() { stats.renders++; stats.lastHtml = context.renderItems(context.items); },
    applyModel() {}, renderFileChanges() { globals.render(); }, openItem() {},
    showModal(title, html) { node('#modal').open = true; stats.dialogTitle = title; stats.dialogHtml = html; },
    closeModal() { node('#modal').open = false; },
    button: (label, action) => `<button data-action="${action}">${label}</button>`,
    saveMutation: async change => change(model), saveError: error => error.message,
    toast: message => { stats.toast = message; }, uid: () => 'unused', search() {}, library() {}
  };
  context = vm.createContext(globals);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../library-ui.js'), 'utf8'), context, { filename: 'library-ui.js' });
  const target = ({ action, id, filter = false, select, all = false, checked = true } = {}) => ({
    dataset: { libraryAction: action, id, selectItem: select }, checked,
    closest(selector) {
      if (selector === '[data-library-action]') return action ? this : null;
      if (selector.includes('[data-action="filter"]')) return filter ? this : null;
      return null;
    },
    matches(selector) { return selector === '[data-select-item]' ? Boolean(select) : selector === '[data-select-all]' && all; }
  });
  function dispatch(type, properties) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const handler of listeners.get(type) || []) handler(event);
    return event;
  }
  return {
    model, context, stats, node, target, dispatch,
    click: options => dispatch('click', { target: target(options) }),
    select: (id, checked = true) => dispatch('change', { target: target({ select: id, checked }) }),
    html: () => context.renderItems(context.items),
    tree() { context.renderSidebar(); return node('#field-navigation').innerHTML; },
    async submitBulk() { await node('#bulk-form').onsubmit({ preventDefault() {}, currentTarget: node('#bulk-form') }); }
  };
}

test('sidebar starts with root fields and accessible collapsed toggles only', () => {
  const h = harness();
  const html = h.tree();
  assert.match(html, /data-action="open-field" data-id="a"/);
  assert.match(html, /data-action="open-field" data-id="b"/);
  assert.match(html, /aria-label="Expand Archive" aria-expanded="false" aria-controls="children-a"/);
  assert.doesNotMatch(html, /data-action="open-field" data-id="child"/);
  assert.doesNotMatch(html, /data-action="open-field" data-id="grandchild"/);
});

test('expanding one parent reveals direct children without opening deeper descendants', () => {
  const h = harness();
  h.click({ action: 'toggle-field', id: 'a' });
  let html = h.tree();
  assert.match(html, /aria-label="Collapse Archive" aria-expanded="true"/);
  assert.match(html, /data-action="open-field" data-id="child"/);
  assert.match(html, /aria-label="Expand Recordings" aria-expanded="false"/);
  assert.doesNotMatch(html, /data-action="open-field" data-id="grandchild"/);
  h.click({ action: 'toggle-field', id: 'child' });
  assert.match(h.tree(), /data-action="open-field" data-id="grandchild"/);
  h.click({ action: 'toggle-field', id: 'a' });
  assert.doesNotMatch(h.tree(), /data-action="open-field" data-id="child"/);
  assert.ok(h.stats.focused >= 3, 'toggle focus is retained after sidebar rerenders');
});

test('opening a deeply nested field expands its ancestors and marks the field current', () => {
  const h = harness();
  h.context.navigate('field', 'grandchild');
  const html = h.tree();
  assert.match(html, /aria-label="Collapse Archive" aria-expanded="true"/);
  assert.match(html, /aria-label="Collapse Recordings" aria-expanded="true"/);
  assert.match(html, /class="tree-name current" data-action="open-field" data-id="grandchild"/);
  assert.deepEqual(h.stats.navigations, [['field', 'grandchild']]);
});

test('item rows page at 100, Show more extends by 100, and navigation resets the page', () => {
  const h = harness({ count: 205 });
  let html = h.html();
  assert.equal((html.match(/class="item-row"/g) || []).length, 100);
  assert.match(html, /Show more \(105\)/);
  assert.doesNotMatch(html, /data-id="item-100"/);
  h.click({ action: 'more' });
  html = h.html();
  assert.equal((html.match(/class="item-row"/g) || []).length, 200);
  assert.match(html, /Show more \(5\)/);
  h.click({ action: 'more' });
  assert.equal((h.html().match(/class="item-row"/g) || []).length, 205);
  assert.doesNotMatch(h.html(), /Show more/);
  h.context.navigate('field', 'a');
  assert.equal((h.html().match(/class="item-row"/g) || []).length, 100);
});

test('selection checkboxes are siblings of item buttons and labels remain escaped', () => {
  const h = harness();
  h.model.updateItem('item-0', { title: '<unsafe> "title"' });
  const html = h.html();
  assert.match(html, /<div class="selectable-item "><input type="checkbox"[^>]+data-select-item="item-0"[^>]+aria-label="Select &lt;unsafe&gt; &quot;title&quot;"[^>]*><button class="item-row"/);
  assert.doesNotMatch(html, /<button[^>]*>[^<]*<input/);
  assert.doesNotMatch(html, /<unsafe>/);
  h.select('item-0');
  assert.match(h.html(), /class="selectable-item selected"/);
  assert.match(h.html(), /1 selected/);
});

test('changing filters clears selection and resets paging through the actual event handler', () => {
  const h = harness({ count: 150 });
  h.click({ action: 'more' });
  h.select('item-0');
  h.select('item-1');
  assert.match(h.html(), /2 selected/);
  h.click({ filter: true });
  const html = h.html();
  assert.doesNotMatch(html, /\d+ selected|data-library-action="bulk-add"|class="selectable-item selected"/);
  assert.equal((html.match(/class="item-row"/g) || []).length, 100);
  assert.match(html, /Show more \(50\)/);
});

test('select all includes filtered off-page items and Clear releases the selection', () => {
  const h = harness({ count: 150 });
  h.html();
  h.dispatch('change', { target: h.target({ all: true }) });
  assert.match(h.html(), /150 selected/);
  h.click({ action: 'clear' });
  assert.doesNotMatch(h.html(), /150 selected|class="selectable-item selected"/);
});

test('successful bulk changes expose Undo even when the displayed list becomes empty', async () => {
  const h = harness();
  h.select('item-0');
  h.click({ action: 'bulk-add' });
  assert.equal(h.stats.dialogTitle, 'Add to fields');
  await h.submitBulk();
  assert.deepEqual(h.model.items[0].fields, ['a', 'b']);
  assert.match(h.html(), /data-library-action="undo"/);
  const empty = h.context.renderItems([]);
  assert.match(empty, /data-library-action="undo"/);
  assert.match(empty, /No items/);
  assert.doesNotMatch(empty, /data-select-all/);
  h.click({ action: 'undo' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.model.items[0].fields, ['a']);
  assert.doesNotMatch(h.html(), /data-library-action="undo"/);
});
