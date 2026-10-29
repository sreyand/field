'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LibraryModel } = require('../library-model.js');

function fixture() {
  const model = new LibraryModel();
  for (const id of ['a', 'b', 'c', 'd']) model.createField({ id, name: id.toUpperCase(), color: '#6384ff', parent: null });
  const native = {
    referenceId: 'native-reference', identity: {
      volumeSerial: '0123456789abcdef', fileId: '00000000000000000000000000000001',
      creationTime: '133720000000000000', volumePath: 'C:\\'
    }, path: 'C:\\Archive\\Photo.png', fileName: 'Photo.png', size: 42,
    modifiedUtc: '2026-10-29T12:00:00Z', status: 'available', recoverable: true, message: null
  };
  const records = [
    { id: 'note', kind: 'note', title: 'Notes', body: 'Keep this content' },
    { id: 'link', kind: 'link', title: 'Reference', url: 'https://example.com/' },
    { id: 'file', kind: 'file', title: 'Curated photograph', fileName: native.fileName, path: native.path, native },
    { id: 'drawing', kind: 'drawing', title: 'Sketch', drawing: 'data:image/png;base64,aGVsbG8=' }
  ];
  for (const record of records) model.createItem(record, ['a']);
  return model;
}

test('one bulk operation adds every item kind without copying canonical records', () => {
  const model = fixture();
  const originals = [...model.items];
  const native = model.items.find(item => item.id === 'file').native;
  const changes = model.bulkMemberships(originals.map(item => item.id), ['b', 'c', 'b'], 'add');
  assert.equal(changes.length, 4);
  assert.equal(model.items.length, 4);
  for (const original of originals) {
    assert.equal(model.items.find(item => item.id === original.id), original);
    assert.deepEqual(original.fields, ['a', 'b', 'c']);
    assert.deepEqual(changes.find(change => change.id === original.id), { id: original.id, added: ['b', 'c'], removed: [] });
  }
  assert.equal(model.items.find(item => item.id === 'file').native, native);
  const duplicate = model.createItem({ ...model.items.find(item => item.id === 'file'), id: 'duplicate' }, ['d']);
  assert.equal(duplicate.itemId, 'file');
  assert.equal(duplicate.created, false);
  assert.equal(model.items.length, 4);
});

test('invalid mixed selections and target fields fail before any membership or exclusion changes', () => {
  const model = fixture();
  model.fields[0].folder = { path: 'C:\\Archive', excludedItemIds: [], itemIds: ['file'] };
  const before = model.snapshot();
  for (const operation of [
    () => model.bulkMemberships(['note', 'absent'], ['b'], 'add'),
    () => model.bulkMemberships(['file', 'absent'], ['a'], 'remove'),
    () => model.bulkMemberships(['note', 'file'], ['b', 'absent'], 'add'),
    () => model.bulkMemberships(['note', '<unsafe>'], ['b'], 'add'),
    () => model.bulkMemberships(['note'], ['b'], 'replace'),
    () => model.bulkMemberships([], ['b'], 'add'),
    () => model.bulkMemberships(['note'], [], 'remove')
  ]) {
    assert.throws(operation);
    assert.deepEqual(model.snapshot(), before);
  }
});

test('removing the last membership retains files, notes, links, drawings, and their content', () => {
  const model = fixture();
  const originals = [...model.items];
  const before = model.snapshot().items;
  const changes = model.bulkMemberships(originals.map(item => item.id), ['a'], 'remove');
  for (const item of originals) assert.deepEqual(item.fields, []);
  assert.deepEqual(model.snapshot().items, before);
  assert.equal(model.items.length, 4);
  const restored = new LibraryModel(model.snapshot());
  assert.equal(restored.items.length, 4);
  assert.deepEqual(restored.snapshot(), model.snapshot());
  model.undoMemberships(changes);
  for (const item of originals) assert.deepEqual(item.fields, ['a']);
});

test('undo removes only the memberships added by the operation and preserves later unrelated work', () => {
  const model = fixture();
  const original = model.items.find(item => item.id === 'note');
  const changes = model.bulkMemberships(['note', 'link'], ['b'], 'add');
  model.setMemberships('note', ['a', 'b', 'c']);
  model.updateItem('note', { title: 'Edited afterwards', body: 'A later content edit' });
  model.createField({ id: 'later-field', name: 'Later', color: '#80bca3', parent: null });
  model.undoMemberships(changes);
  assert.equal(model.items.find(item => item.id === 'note'), original);
  assert.deepEqual(original.fields, ['a', 'c']);
  assert.equal(original.title, 'Edited afterwards');
  assert.equal(original.body, 'A later content edit');
  assert.deepEqual(model.items.find(item => item.id === 'link').fields, ['a']);
  assert.ok(model.fields.find(field => field.id === 'later-field'));
});

test('undo restores removed memberships while preserving later additions and skipping deleted fields', () => {
  const model = fixture();
  model.setMemberships('file', ['a', 'b', 'c']);
  const changes = model.bulkMemberships(['file'], ['a', 'b'], 'remove');
  model.setMemberships('file', ['c', 'd']);
  model.deleteField('b');
  model.undoMemberships(changes);
  assert.deepEqual(new Set(model.items.find(item => item.id === 'file').fields), new Set(['a', 'c', 'd']));
  assert.doesNotThrow(() => new LibraryModel(model.snapshot()));
});

test('bulk removal from linked folders persists exclusion and undo clears only its own exclusion', () => {
  const model = fixture();
  model.fields[0].folder = { path: 'C:\\Archive', excludedItemIds: ['other-item'], itemIds: ['file'] };
  const changes = model.bulkMemberships(['file', 'note'], ['a'], 'remove');
  assert.deepEqual(model.fields[0].folder.excludedItemIds, ['other-item', 'file']);
  const restored = new LibraryModel(model.snapshot());
  assert.deepEqual(restored.fields[0].folder.excludedItemIds, ['other-item', 'file']);
  restored.undoMemberships(changes);
  assert.deepEqual(restored.fields[0].folder.excludedItemIds, ['other-item']);
  assert.deepEqual(restored.items.find(item => item.id === 'file').fields, ['a']);
  assert.equal(restored.items.find(item => item.id === 'file').native.referenceId, 'native-reference');
});

test('duplicate selections and no-op memberships produce one reversible change per item', () => {
  const model = fixture();
  const before = model.snapshot();
  const changes = model.bulkMemberships(['note', 'note'], ['a'], 'add');
  assert.deepEqual(changes, [{ id: 'note', added: [], removed: [] }]);
  assert.deepEqual(model.snapshot(), before);
  model.undoMemberships(changes);
  assert.deepEqual(model.snapshot(), before);
});

test('invalid undo entries fail atomically before changing earlier valid records', () => {
  const model = fixture();
  const changes = model.bulkMemberships(['note', 'file'], ['b'], 'add');
  const before = model.snapshot();
  assert.throws(() => model.undoMemberships([...changes, { id: 'absent', added: ['b'], removed: [] }]));
  assert.deepEqual(model.snapshot(), before);
});
