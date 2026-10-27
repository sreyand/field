'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LibraryModel, identityKey } = require('../library-model.js');

function library() {
  const model = new LibraryModel();
  for (const id of ['a', 'b', 'c']) model.createField({ id, name: id.toUpperCase(), parent: null, color: '#6384ff' });
  return model;
}

const drawing = 'data:image/png;base64,aGVsbG8=';
const records = [
  { id: 'note', kind: 'note', title: 'Note', body: 'Original note' },
  { id: 'link', kind: 'link', title: 'Link', url: 'https://example.com/page' },
  { id: 'file', kind: 'file', title: 'File', path: 'C:\\Users\\You\\File.pdf', fileName: 'File.pdf' },
  { id: 'drawing', kind: 'drawing', title: 'Drawing', drawing }
];

test('a fresh library is empty', () => {
  assert.deepEqual(new LibraryModel().snapshot(), { version: 1, fields: [], items: [], memberships: [], connections: [] });
});

for (const source of records) test(`${source.kind}: one canonical record is shared and edited across fields`, () => {
  const model = library();
  const arrays = { fields: model.fields, items: model.items, connections: model.connections };
  const result = model.createItem(source, ['a']);
  assert.deepEqual(result, { itemId: source.id, created: true, added: 1 });
  const canonical = model.items[0];
  model.setMemberships(source.id, ['a', 'b', 'b']);
  const contentPatch = {
    note: { body: 'Edited shared note' },
    link: { url: 'https://example.com/edited' },
    file: { path: 'D:\\Archive\\Edited.pdf', fileName: 'Edited.pdf' },
    drawing: { drawing: 'data:image/png;base64,dXBkYXRlZA==' }
  }[source.kind];
  const updated = model.updateItem(source.id, { title: 'Updated everywhere', ...contentPatch, fields: ['c'] });
  assert.equal(updated, canonical);
  assert.equal(model.items.length, 1);
  assert.deepEqual(canonical.fields, ['a', 'b']);
  for (const fieldId of ['a', 'b']) {
    const inField = model.items.find(item => item.fields.includes(fieldId));
    assert.equal(inField.title, 'Updated everywhere');
    for (const [key, value] of Object.entries(contentPatch)) assert.equal(inField[key], value);
  }
  assert.equal(model.fields, arrays.fields);
  assert.equal(model.items, arrays.items);
  assert.equal(model.connections, arrays.connections);
});

test('link dedup normalizes host, ports, and root slash without discarding original contents', () => {
  const model = library();
  model.createItem({ id: 'first', kind: 'link', title: 'First title', url: 'https://EXAMPLE.com:443' }, ['a']);
  const duplicate = model.createItem({ id: 'second', kind: 'link', title: 'Do not overwrite', url: 'https://example.com/' }, ['a', 'b']);
  assert.deepEqual(duplicate, { itemId: 'first', created: false, added: 1 });
  assert.equal(model.items.length, 1);
  assert.equal(model.items[0].title, 'First title');
  assert.deepEqual(model.items[0].fields, ['a', 'b']);
  assert.equal(model.createItem({ id: 'again', kind: 'link', title: 'Again', url: 'https://example.com/' }, ['b']).added, 0);
  model.createItem({ id: 'anchor', kind: 'link', title: 'Anchor', url: 'https://example.com/#section' }, ['a']);
  assert.equal(model.items.length, 2, 'full URLs preserve meaningful fragments');
});

test('Windows file references dedup by normalized path, including UNC and extended aliases', () => {
  const model = library();
  model.createItem({ id: 'file', kind: 'file', title: 'Original', path: 'C:\\Users\\YOU\\Docs\\..\\File.pdf' }, ['a']);
  const duplicate = model.createItem({ id: 'other', kind: 'file', title: 'Other', path: 'c:/users/you/file.PDF' }, ['b']);
  assert.deepEqual(duplicate, { itemId: 'file', created: false, added: 1 });
  assert.equal(identityKey({ kind: 'file', path: '\\\\?\\C:\\Users\\You\\File.pdf' }), identityKey({ kind: 'file', path: 'c:/users/you/file.pdf' }));
  assert.equal(identityKey({ kind: 'file', path: '\\\\?\\UNC\\Server\\Share\\file.pdf' }), identityKey({ kind: 'file', path: '\\\\server\\share\\FILE.pdf' }));
});

test('same filenames and identical note contents do not falsely merge independent items', () => {
  const model = library();
  for (const id of ['one', 'two']) model.createItem({ id, kind: 'file', title: id, fileName: 'same.pdf', size: 52 }, ['a']);
  for (const id of ['note-one', 'note-two']) model.createItem({ id, kind: 'note', title: 'Same', body: 'Identical' }, ['a']);
  model.createItem({ id: 'path-a', kind: 'file', title: 'A', path: 'C:\\A\\same.pdf' }, ['a']);
  model.createItem({ id: 'path-b', kind: 'file', title: 'B', path: 'C:\\B\\same.pdf' }, ['a']);
  assert.equal(model.items.length, 6);
});

test('removing every membership preserves the canonical item and its content', () => {
  const model = library();
  model.createItem(records[0], ['a', 'b']);
  model.setMemberships('note', []);
  assert.equal(model.items.length, 1);
  assert.deepEqual(model.items[0].fields, []);
  assert.equal(model.items[0].body, 'Original note');
  assert.deepEqual(model.snapshot().memberships, []);
  model.setMemberships('note', ['c']);
  assert.deepEqual(model.items[0].fields, ['c']);
});

test('snapshot roundtrip restores all kinds, memberships, nested fields, and connections', () => {
  const model = library();
  model.createField({ id: 'nested', parent: 'b', name: 'Nested', color: '#6384ff' });
  for (const record of records) model.createItem(record, ['a', 'nested']);
  model.createConnection({ id: 'related', from: 'a', to: 'b', label: 'Related', note: 'A user note' });
  const snapshot = model.snapshot();
  assert.ok(snapshot.items.every(item => !Object.hasOwn(item, 'fields')));
  const reopened = new LibraryModel(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(reopened.snapshot(), snapshot);
  assert.deepEqual(reopened.items[0].fields, ['a', 'nested']);
  const extracted = reopened.items[0].fields;
  extracted.push('c');
  assert.deepEqual(reopened.items[0].fields, ['a', 'nested'], 'membership getter does not expose a mutable set');
});

test('an editing collision fails atomically and preserves identity and memberships', () => {
  const model = library();
  model.createItem(records[1], ['a', 'b']);
  model.createItem({ id: 'other', kind: 'link', title: 'Other', url: 'https://example.com/other' }, ['c']);
  const before = model.snapshot();
  assert.throws(() => model.updateItem('other', { url: 'https://example.com/page', title: 'Bad overwrite' }), /already belongs/);
  assert.deepEqual(model.snapshot(), before);
  assert.throws(() => model.updateItem('link', { id: 'changed' }), /cannot be changed/);
  assert.throws(() => model.updateItem('link', { kind: 'note' }), /cannot be changed/);
  assert.deepEqual(model.snapshot(), before);
});

test('invalid data and dangling memberships are rejected before state changes', () => {
  const model = library();
  assert.throws(() => model.createField({ id: 'bad', name: 'Bad', color: 'blue' }), /color/);
  assert.throws(() => model.createField({ id: 'bad', name: 'Bad', color: '#6384ff', parent: 'missing' }), /does not exist/);
  assert.throws(() => model.createItem(records[0], ['missing']), /does not exist/);
  assert.equal(model.items.length, 0);
  model.createItem(records[0], ['a']);
  assert.throws(() => model.setMemberships('note', ['b', 'missing']), /does not exist/);
  assert.deepEqual(model.items[0].fields, ['a']);
  assert.throws(() => model.createItem({ ...records[1], id: 'bad', url: 'javascript:alert(1)' }, ['a']), /http/);
  assert.throws(() => model.createItem({ ...records[2], id: 'bad', path: 'relative.pdf' }, ['a']), /absolute Windows path/);
  assert.throws(() => model.createConnection({ id: 'bad', from: 'a', to: 'a', label: 'Self' }), /different fields/);
});

test('corrupt snapshots do not silently drop records', () => {
  const model = library();
  model.createItem(records[0], ['a']);
  const snapshot = model.snapshot();
  assert.throws(() => new LibraryModel({ ...snapshot, items: [snapshot.items[0], snapshot.items[0]] }), /Duplicate item ID/);
  assert.throws(() => new LibraryModel({ ...snapshot, memberships: [{ itemId: 'missing', fieldId: 'a' }] }), /missing item or field/);
  assert.throws(() => new LibraryModel({ ...snapshot, memberships: [snapshot.memberships[0], snapshot.memberships[0]] }), /Duplicate membership/);
  assert.throws(() => new LibraryModel({ ...snapshot, fields: [{ id: 'cycle', name: 'Cycle', color: '#6384ff', parent: 'cycle' }] }), /cycle/);
  assert.throws(() => new LibraryModel({ ...snapshot, items: [{ ...snapshot.items[0], fields: ['a'] }] }), /separate membership/);
  assert.throws(() => new LibraryModel({ ...snapshot, version: 2 }), /version/);
});


test('unsafe persisted IDs are rejected before they reach UI attributes', () => {
  const model = library();
  assert.throws(() => model.createField({ id: 'field" onclick="bad', name: 'Bad', parent: null, color: '#6384ff' }), /unsupported characters/);
  assert.throws(() => model.createItem({ id: '<item>', kind: 'note', title: 'Bad', body: 'Text' }, ['a']), /unsupported characters/);
  const snapshot = model.snapshot();
  snapshot.fields[0].id = 'bad id';
  assert.throws(() => new LibraryModel(snapshot), /unsupported characters/);
});

function nativeFile(overrides = {}) {
  return {
    referenceId: 'native-reference-1',
    identity: {
      volumeSerial: '0123456789ABCDEF',
      fileId: '00000000000000000000000000000001',
      volumePath: 'C:\\',
      creationTime: '133720000000000000'
    },
    path: 'C:\\Documents\\Original.pdf',
    fileName: 'Original.pdf',
    size: 512,
    modifiedUtc: '2026-10-27T12:00:00Z',
    status: 'available',
    recoverable: true,
    message: '',
    ...overrides
  };
}

function trackedRecord(id, native = nativeFile()) {
  return { id, kind: 'file', title: `User title ${id}`, path: native.path, fileName: native.fileName, size: native.size ?? undefined, native };
}

test('native identity deduplicates the same file under a renamed path', () => {
  const model = library();
  model.createItem(trackedRecord('tracked'), ['a']);
  const renamed = nativeFile({ referenceId: 'another-registration', path: 'C:\\Renamed\\Report.pdf', fileName: 'Report.pdf' });
  const duplicate = model.createItem(trackedRecord('renamed', renamed), ['b']);
  assert.deepEqual(duplicate, { itemId: 'tracked', created: false, added: 1 });
  assert.equal(model.items.length, 1);
  assert.equal(model.items[0].title, 'User title tracked');
  assert.equal(model.items[0].native.referenceId, 'native-reference-1', 'reimport does not replace the canonical host registration');
  assert.deepEqual(model.items[0].fields, ['a', 'b']);
  assert.equal(identityKey(trackedRecord('one')), identityKey(trackedRecord('two', renamed)));
});

test('different native files at the same path, including reused IDs, are not merged', () => {
  const model = library();
  model.createItem(trackedRecord('original'), ['a']);
  const replacement = nativeFile({ referenceId: 'replacement-reference', identity: { ...nativeFile().identity, fileId: '00000000000000000000000000000002' } });
  model.createItem(trackedRecord('replacement', replacement), ['b']);
  const reused = nativeFile({ referenceId: 'reused-reference', identity: { ...nativeFile().identity, creationTime: '133720000000000001' } });
  model.createItem(trackedRecord('reused', reused), ['c']);
  assert.equal(model.items.length, 3);
  assert.deepEqual(model.items.map(item => item.fields), [['a'], ['b'], ['c']]);
});

test('native identities normalize hex casing and decimal creation times without depending on drive letters', () => {
  const source = nativeFile();
  const other = nativeFile({
    path: 'D:\\Documents\\Original.pdf',
    identity: { ...source.identity, volumeSerial: source.identity.volumeSerial.toLowerCase(), fileId: source.identity.fileId.toUpperCase(), creationTime: '00133720000000000000', volumePath: 'D:\\' }
  });
  assert.equal(identityKey(trackedRecord('one', source)), identityKey(trackedRecord('two', other)));
  const volumeGuid = nativeFile({ identity: { ...source.identity, volumePath: '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\' } });
  const model = library();
  assert.doesNotThrow(() => model.createItem(trackedRecord('guid-volume', volumeGuid), ['a']));
});

test('native snapshots roundtrip every tracking status without losing identity or last-known metadata', () => {
  const model = library();
  const source = nativeFile({ status: 'missing', size: null, modifiedUtc: null, message: 'Last known location retained.' });
  model.createItem(trackedRecord('tracked', source), ['a', 'c']);
  const restored = new LibraryModel(JSON.parse(JSON.stringify(model.snapshot())));
  assert.deepEqual(restored.items[0].native, source);
  assert.deepEqual(restored.items[0].fields, ['a', 'c']);
  assert.equal(identityKey(restored.items[0]), identityKey(trackedRecord('original')));
  for (const status of ['available', 'missing', 'unavailable', 'inaccessible', 'unsupported', 'replaced', 'unresolved']) {
    assert.doesNotThrow(() => model.updateItem('tracked', { native: { ...source, status } }));
  }
});

test('unsupported native files with null identities retain path-based deduplication', () => {
  const model = library();
  const unsupported = nativeFile({ identity: null, status: 'unsupported', recoverable: false });
  model.createItem(trackedRecord('unsupported', unsupported), ['a']);
  const duplicate = model.createItem({ id: 'path-only', kind: 'file', title: 'Same path', path: 'c:/documents/original.PDF' }, ['b']);
  assert.deepEqual(duplicate, { itemId: 'unsupported', created: false, added: 1 });
  assert.equal(model.items[0].native.identity, null);
});

test('legacy references upgrade explicitly without changing item identity, user data, or memberships', () => {
  const model = library();
  model.createItem({ id: 'legacy', kind: 'file', title: 'My original title', path: 'C:\\Old\\Reference.pdf', notes: 'My notes', annotations: [{ text: 'Keep this annotation' }] }, ['a', 'b']);
  const original = model.items[0];
  const native = nativeFile({ path: 'D:\\Moved\\Reference.pdf', fileName: 'Reference.pdf', identity: { ...nativeFile().identity, volumePath: 'D:\\' } });
  model.updateItem('legacy', { native, path: native.path, fileName: native.fileName, size: native.size, modifiedUtc: native.modifiedUtc });
  assert.equal(model.items[0], original);
  assert.equal(original.id, 'legacy');
  assert.equal(original.title, 'My original title');
  assert.equal(original.notes, 'My notes');
  assert.deepEqual(original.annotations, [{ text: 'Keep this annotation' }]);
  assert.deepEqual(original.fields, ['a', 'b']);
  assert.equal(original.path, native.path);
  assert.ok(identityKey(original).startsWith('native:'));
});

test('same-path native imports do not guess an upgrade of an unverified legacy reference', () => {
  const model = library();
  const native = nativeFile();
  model.createItem({ id: 'legacy', kind: 'file', title: 'Unverified old reference', path: native.path }, ['a']);
  const result = model.createItem(trackedRecord('verified', native), ['b']);
  assert.equal(result.created, true);
  assert.equal(model.items.length, 2);
  assert.equal(model.items[0].native, undefined);
  const before = model.snapshot();
  assert.throws(() => model.updateItem('legacy', { native, path: native.path, fileName: native.fileName }), /already belongs/);
  assert.deepEqual(model.snapshot(), before);
});

test('explicit relinking preserves the canonical item but rejects another existing native identity', () => {
  const model = library();
  const originalNative = nativeFile();
  model.createItem(trackedRecord('original', originalNative), ['a', 'c']);
  const otherNative = nativeFile({ referenceId: 'other-reference', path: 'C:\\Other.pdf', fileName: 'Other.pdf', identity: { ...originalNative.identity, fileId: '00000000000000000000000000000002' } });
  model.createItem(trackedRecord('other', otherNative), ['b']);
  const before = model.snapshot();
  assert.throws(() => model.updateItem('original', { native: otherNative, path: otherNative.path, fileName: otherNative.fileName }), /already belongs/);
  assert.deepEqual(model.snapshot(), before);
  const relinked = nativeFile({ referenceId: 'relinked-reference', path: 'C:\\Relinked.pdf', fileName: 'Relinked.pdf', identity: { ...originalNative.identity, fileId: '00000000000000000000000000000003' } });
  model.updateItem('original', { native: relinked, path: relinked.path, fileName: relinked.fileName });
  assert.equal(model.items[0].id, 'original');
  assert.equal(model.items[0].title, 'User title original');
  assert.deepEqual(model.items[0].fields, ['a', 'c']);
  assert.equal(model.items.length, 2);
});

test('native:null explicitly clears tracking and restores ordinary path identity', () => {
  const model = library();
  model.createItem(trackedRecord('tracked'), ['a']);
  model.updateItem('tracked', { native: null });
  assert.equal(model.items[0].native, null);
  assert.ok(identityKey(model.items[0]).startsWith('file:'));
  const result = model.createItem({ id: 'again', kind: 'file', title: 'Again', path: nativeFile().path }, ['b']);
  assert.deepEqual(result, { itemId: 'tracked', created: false, added: 1 });
});

test('a native reference ID cannot target different canonical items', () => {
  const model = library();
  const first = nativeFile();
  model.createItem(trackedRecord('first', first), ['a']);
  const alias = model.createItem(trackedRecord('alias', first), ['b']);
  assert.deepEqual(alias, { itemId: 'first', created: false, added: 1 });
  const different = nativeFile({ identity: { ...first.identity, fileId: '00000000000000000000000000000002' } });
  const before = model.snapshot();
  assert.throws(() => model.createItem(trackedRecord('different', different), ['c']), /Native reference ID already belongs/);
  assert.throws(() => model.createItem(trackedRecord('different-case', { ...different, referenceId: different.referenceId.toUpperCase() }), ['c']), /Native reference ID already belongs/);
  assert.deepEqual(model.snapshot(), before);
  model.createItem({ id: 'legacy', kind: 'file', title: 'Legacy', path: 'C:\\Legacy.pdf' }, ['c']);
  const beforeUpdate = model.snapshot();
  assert.throws(() => model.updateItem('legacy', { native: different, path: different.path, fileName: different.fileName }), /Native reference ID already belongs/);
  assert.deepEqual(model.snapshot(), beforeUpdate);
  const snapshot = model.snapshot();
  snapshot.items[1] = { ...trackedRecord('legacy', different) };
  assert.throws(() => new LibraryModel(snapshot), /Native reference ID already belongs/);
});

test('malformed native DTOs and mismatched path updates are rejected atomically', () => {
  const model = library();
  const invalid = [
    nativeFile({ referenceId: 'bad" id' }),
    nativeFile({ recoverable: 'yes' }),
    nativeFile({ status: 'unknown-status' }),
    nativeFile({ identity: undefined }),
    nativeFile({ identity: { ...nativeFile().identity, volumeSerial: 'FFFF' } }),
    nativeFile({ identity: { ...nativeFile().identity, fileId: 'g'.repeat(32) } }),
    nativeFile({ identity: { ...nativeFile().identity, creationTime: 133720000000000000 } }),
    nativeFile({ identity: { ...nativeFile().identity, creationTime: '18446744073709551616' } }),
    nativeFile({ identity: { ...nativeFile().identity, volumePath: 'relative' } }),
    nativeFile({ path: 'relative.pdf' }),
    nativeFile({ fileName: 'folder/file.pdf' }),
    nativeFile({ size: -1 }),
    nativeFile({ modifiedUtc: '2026-10-27' }),
    nativeFile({ message: 123 })
  ];
  for (const [index, native] of invalid.entries()) {
    assert.throws(() => model.createItem(trackedRecord(`bad-${index}`, native), ['a']));
    assert.equal(model.items.length, 0);
  }
  model.createItem(trackedRecord('tracked'), ['a']);
  const before = model.snapshot();
  assert.throws(() => model.updateItem('tracked', { path: 'C:\\New.pdf' }), /does not match/);
  assert.deepEqual(model.snapshot(), before);
  const corrupt = model.snapshot();
  corrupt.items[0].native.status = 'bad';
  assert.throws(() => new LibraryModel(corrupt), /status/);
  assert.throws(() => model.createItem({ id: 'bad-note', kind: 'note', title: 'Note', body: 'Text', native: nativeFile() }, ['a']), /Only files/);
});
