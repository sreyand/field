const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'desktop-client.js'), 'utf8');
const storageSource = fs.readFileSync(path.join(__dirname, '..', 'library-storage.js'), 'utf8');
const emptySnapshot = () => ({ version: 1, fields: [], items: [], memberships: [], connections: [] });

function harness({ origin = 'https://field.local', transport = true } = {}) {
  const messages = [];
  const timers = new Map();
  let nextTimer = 0;
  let nextId = 0;
  let receiver;
  let transportFailure;
  let indexedDBAttempts = 0;
  const indexedDB = { open() { indexedDBAttempts++; throw new Error('Unexpected browser storage access.'); } };
  const window = { indexedDB };
  if (transport) window.chrome = { webview: {
    postMessage(message) {
      if (transportFailure) throw transportFailure;
      // A native message is serialized across the process boundary, not passed by reference.
      messages.push(structuredClone(message));
    },
    addEventListener(type, handler) { assert.equal(type, 'message'); receiver = handler; }
  } };
  const context = vm.createContext({
    window, location: { origin }, indexedDB,
    crypto: { randomUUID: () => 'fixture-' + ++nextId },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(bridgeSource, context, { filename: 'desktop-client.js' });

  return {
    messages, timers, context,
    get desktop() { return window.FieldDesktop; },
    get indexedDBAttempts() { return indexedDBAttempts; },
    set transportFailure(error) { transportFailure = error; },
    receive(data) { receiver?.({ data }); },
    result(message, result) { receiver({ data: { id: message.id, ok: true, result } }); },
    failure(message, text = 'Native operation failed.', code = 'REQUEST_FAILED') {
      receiver({ data: { id: message.id, ok: false, error: { message: text, code } } });
    },
    async ready() {
      assert.equal(messages[0]?.method, 'app.info');
      this.result(messages[0], { app: 'FIELD', platform: 'windows', version: '0.1.0-alpha' });
      return this.desktop.ready;
    },
    loadStorage() {
      vm.runInContext(storageSource, context, { filename: 'library-storage.js' });
      return window.FieldStorage.open();
    },
    fireTimer(id) {
      const timer = timers.get(id);
      assert(timer, 'The requested timeout must still be active.');
      timers.delete(id);
      timer.callback();
    },
    async next(method) {
      // Let promise continuations reach the actual transport without using wall-clock sleeps.
      for (let attempt = 0; attempt < 12; attempt++) {
        const message = messages.find(entry => entry.method === method && !entry.observed);
        if (message) { message.observed = true; return message; }
        await Promise.resolve();
      }
      assert.fail('No request was posted for ' + method);
    }
  };
}

test('desktop activation requires the native transport and the exact application origin', async () => {
  for (const options of [
    { origin: 'https://example.com' },
    { origin: 'http://field.local' },
    { origin: 'https://field.local.example.com' },
    { origin: 'null' },
    { transport: false }
  ]) {
    const app = harness(options);
    assert.equal(app.desktop.isDesktop, false);
    assert.equal(await app.desktop.ready, null);
    await assert.rejects(app.desktop.request('app.info'), /not connected/);
    assert.equal(app.messages.length, 0);
    assert.equal(app.timers.size, 0);
  }
  const trusted = harness();
  assert.equal(trusted.desktop.isDesktop, true);
  assert.equal((await trusted.ready()).app, 'FIELD');
  assert.equal(trusted.timers.size, 0);
});

test('readiness rejects an unexpected native application identity', async () => {
  const app = harness();
  const rejected = assert.rejects(app.desktop.ready, /connection is invalid/);
  app.result(app.messages[0], { app: 'OTHER', platform: 'windows' });
  await rejected;
  assert.equal(app.timers.size, 0);
});

test('RPC responses correlate by ID when native operations complete out of order', async () => {
  const app = harness();
  await app.ready();
  const tracked = app.desktop.request('files.track', { path: 'C:\\fixtures\\reference.txt' });
  const resolved = app.desktop.request('files.resolve', { referenceIds: ['fixture-reference'] });
  const first = app.messages[1];
  const second = app.messages[2];
  assert.notEqual(first.id, second.id);
  app.result(second, { references: [{ status: 'missing' }] });
  assert.deepEqual(await resolved, { references: [{ status: 'missing' }] });
  assert.equal(app.timers.size, 1);
  app.result(first, { reference: { referenceId: 'fixture-reference' } });
  assert.deepEqual(await tracked, { reference: { referenceId: 'fixture-reference' } });
  assert.equal(app.timers.size, 0);
});

test('unknown IDs, malformed responses, and duplicate replies do not settle another request', async () => {
  const app = harness();
  await app.ready();
  let settled = false;
  const operation = app.desktop.request('files.open', { referenceId: 'fixture-reference' }).then(value => { settled = true; return value; });
  const request = app.messages[1];
  for (const message of [null, {}, { id: 'unknown', ok: true, result: 'wrong' }, { id: request.id, ok: 'true', result: 'wrong' }]) app.receive(message);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(app.timers.size, 1);
  app.result(request, { opened: true });
  assert.deepEqual(await operation, { opened: true });
  app.result(request, { opened: false });
  assert.equal(app.timers.size, 0);
});

test('native failures retain their message and code; unsupported methods are never sent', async () => {
  const app = harness();
  await app.ready();
  const operation = app.desktop.request('library.save', { snapshot: emptySnapshot(), expectedRevision: 7 });
  const rejected = assert.rejects(operation, error => error.message === 'The library changed in another window.' && error.code === 'REVISION_CONFLICT');
  app.failure(app.messages[1], 'The library changed in another window.', 'REVISION_CONFLICT');
  await rejected;
  await assert.rejects(app.desktop.request('files.readAnything', { path: 'C:\\fixtures\\unregistered.txt' }), /Unsupported desktop operation/);
  assert.equal(app.messages.length, 2);
  assert.equal(app.timers.size, 0);
});

test('timeouts remove requests, ignore late replies, and allow later operations to finish', async () => {
  const app = harness();
  await app.ready();
  const operation = app.desktop.request('files.resolve', { referenceIds: [] }, 25);
  const rejected = assert.rejects(operation, /timed out/);
  const timeoutId = [...app.timers.keys()][0];
  assert.equal(app.timers.get(timeoutId).delay, 25);
  app.fireTimer(timeoutId);
  await rejected;
  assert.equal(app.timers.size, 0);
  app.result(app.messages[1], { references: [] });
  const later = app.desktop.request('app.info');
  app.result(app.messages[2], { app: 'FIELD', platform: 'windows' });
  assert.equal((await later).app, 'FIELD');
  assert.equal(app.timers.size, 0);
});

test('the pending-operation limit rejects overflow and releases capacity after completion', async () => {
  const app = harness();
  await app.ready();
  const operations = Array.from({ length: 64 }, () => app.desktop.request('files.resolve', { referenceIds: [] }));
  assert.equal(app.timers.size, 64);
  await assert.rejects(app.desktop.request('files.resolve', { referenceIds: [] }), /Too many operations/);
  assert.equal(app.messages.length, 65, 'The overflow request must not reach the native host.');
  app.result(app.messages[1], { references: [] });
  await operations[0];
  operations.push(app.desktop.request('files.resolve', { referenceIds: [] }));
  for (const request of app.messages.slice(1)) app.result(request, { references: [] });
  await Promise.all(operations);
  assert.equal(app.timers.size, 0);
});

test('transport errors clean up their timeout and the import picker is an allowed explicit operation', async () => {
  const app = harness();
  await app.ready();
  app.transportFailure = new Error('The desktop transport closed.');
  await assert.rejects(app.desktop.request('library.load'), /transport closed/);
  assert.equal(app.timers.size, 0);
  assert.equal(app.messages.length, 1);
  app.transportFailure = null;
  const pick = app.desktop.request('library.pickImport');
  assert.equal(app.messages[1].method, 'library.pickImport');
  app.result(app.messages[1], { cancelled: true });
  assert.deepEqual(await pick, { cancelled: true });
  assert.equal(app.timers.size, 0);
});

test('native storage waits for readiness and forwards load, revision-checked saves, and imports', async () => {
  const app = harness();
  const repository = app.loadStorage();
  const loading = repository.load();
  await Promise.resolve();
  assert.equal(app.messages.length, 1, 'Storage must wait until app.info succeeds.');
  await app.ready();
  const loadRequest = await app.next('library.load');
  const original = { revision: 7, snapshot: emptySnapshot() };
  app.result(loadRequest, original);
  assert.deepEqual(await loading, original);

  const snapshot = emptySnapshot();
  snapshot.fields.push({ id: 'fixtures', name: 'Fixtures', color: '#6384ff', parent: null });
  const saved = repository.save(snapshot, 7);
  const saveRequest = await app.next('library.save');
  assert.deepEqual(saveRequest.params, { snapshot, expectedRevision: 7 });
  app.result(saveRequest, { revision: 8 });
  assert.deepEqual(await saved, { revision: 8 });

  const imported = repository.import(snapshot, 8);
  const importRequest = await app.next('library.import');
  assert.deepEqual(importRequest.params, { snapshot, expectedRevision: 8 });
  app.result(importRequest, { revision: 9, snapshot });
  assert.deepEqual(await imported, { revision: 9, snapshot });
  assert.equal(app.indexedDBAttempts, 0);
  assert.equal(app.timers.size, 0);
});

test('native storage failures never fall back to a separate IndexedDB catalogue', async () => {
  const app = harness();
  await app.ready();
  const repository = app.loadStorage();
  for (const [method, operation] of [
    ['library.load', () => repository.load()],
    ['library.save', () => repository.save(emptySnapshot(), 12)],
    ['library.import', () => repository.import(emptySnapshot(), 12)]
  ]) {
    const pending = operation();
    const rejected = assert.rejects(pending, /Native storage is unavailable/);
    app.failure(await app.next(method), 'Native storage is unavailable.');
    await rejected;
  }
  assert.equal(app.indexedDBAttempts, 0);
  assert.equal(app.messages.filter(message => message.method === 'library.save').length, 1, 'Failed writes must not be retried silently.');
  assert.equal(app.timers.size, 0);
});

test('a failed desktop handshake prevents storage access instead of creating an empty browser library', async () => {
  const app = harness();
  const repository = app.loadStorage();
  const loading = repository.load();
  const rejected = assert.rejects(loading, /Native startup failed/);
  app.failure(app.messages[0], 'Native startup failed.');
  await rejected;
  assert.equal(app.messages.length, 1);
  assert.equal(app.indexedDBAttempts, 0);
  assert.equal(app.timers.size, 0);
});
