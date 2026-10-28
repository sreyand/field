const test = require('node:test');
const assert = require('node:assert/strict');
const { LibraryModel } = require('../library-model.js');
const transfer = require('../library-transfer.js');

function populated() {
  const model = new LibraryModel();
  model.createField({ id: 'archive', name: 'Archive', color: '#6384ff' });
  model.createField({ id: 'notes', name: 'Notes', color: '#80bca3', parent: 'archive' });
  model.createItem({ id: 'note', kind: 'note', title: 'A note', body: 'Keep the original text.\nSecond line.' }, ['archive', 'notes']);
  model.createItem({ id: 'link', kind: 'link', title: 'Reference', url: 'https://example.com/?q=one#two' }, ['notes']);
  model.createItem({ id: 'drawing', kind: 'drawing', title: 'Sketch', drawing: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }, ['archive']);
  model.createItem({ id: 'file', kind: 'file', title: 'Local file', fileName: 'reference.txt', path: 'C:\\FIELD\\reference.txt', size: 12, native: {
    referenceId: '0123456789abcdef0123456789abcdef', path: 'C:\\FIELD\\reference.txt', fileName: 'reference.txt', size: 12,
    identity: { volumeSerial: '0123456789abcdef', fileId: '0123456789abcdef0123456789abcdef', volumePath: 'C:\\', creationTime: '133720000000000000' },
    modifiedUtc: '2026-10-27T00:00:00Z', status: 'available', recoverable: true, message: null
  } }, ['archive', 'notes']);
  model.createConnection({ id: 'connection', from: 'archive', to: 'notes', label: 'Related' });
  return model;
}

test('migration roundtrip preserves all item kinds, native identity, hierarchy and memberships', () => {
  const original = populated().snapshot();
  const exported = transfer.encode(original);
  assert.equal(JSON.parse(exported).format, 'FIELD.library');
  assert.deepEqual(transfer.decode(exported), original);
  assert.deepEqual(original, populated().snapshot(), 'export does not mutate its source');
});

test('empty libraries roundtrip and UTF-8 BOM exports can be imported', () => {
  const snapshot = new LibraryModel().snapshot();
  assert.deepEqual(transfer.decode('\uFEFF' + transfer.encode(snapshot)), snapshot);
});

test('unrelated JSON and unsupported export versions do not become empty libraries', () => {
  for (const value of [{}, [], null, { format: 'FIELD.library', version: 2, snapshot: new LibraryModel().snapshot() },
    { format: 'FIELD.library', version: 1, snapshot: { version: 1, fields: [] } }]) {
    assert.throws(() => transfer.decode(JSON.stringify(value)), /FIELD library export/);
  }
  assert.throws(() => transfer.decode('not json'), /valid JSON/);
});

test('corrupt memberships and unsafe IDs are rejected before an import can reach storage', () => {
  const envelope = JSON.parse(transfer.encode(populated().snapshot()));
  envelope.snapshot.memberships.push({ itemId: 'missing', fieldId: 'archive' });
  assert.throws(() => transfer.decode(JSON.stringify(envelope)), /missing item or field/);
  envelope.snapshot.memberships.pop();
  envelope.snapshot.fields[0].id = 'unsafe" id';
  assert.throws(() => transfer.decode(JSON.stringify(envelope)), /unsupported characters/);
});
