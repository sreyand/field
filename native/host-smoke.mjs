// Run after building Field.Host: node native/host-smoke.mjs <absolute fixture parent>.
// Creates only its own fixture directory and never opens files or native dialogs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, mkdir, rename, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const native = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(native);
const parent = process.argv[2];
assert(parent && path.isAbsolute(parent), 'Pass an absolute, disposable fixture parent directory.');
await mkdir(parent, { recursive: true });
const fixture = await mkdtemp(path.join(parent, 'field-host-'));
const data = path.join(fixture, 'state');
const port = Number(process.env.FIELD_TEST_PORT || 4324);
const base = `http://127.0.0.1:${port}`;
const dll = path.join(native, 'bin', 'Release', 'net8.0-windows', 'Field.Host.dll');
let child;
let token;
let checks = 0;
function check(value, message) { assert(value, message); checks++; }
async function start() {
  child = spawn('dotnet', [dll, '--port', String(port), '--root', root, '--data-dir', data], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Host did not start: ${output}`)), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('FIELD runtime:')) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Host exited ${code}: ${output}`)); });
    child.once('error', reject);
  });
  const session = await (await fetch(base + '/api/session')).json();
  check(session.app === 'FIELD' && /^[a-f0-9]{64}$/.test(session.token), 'Session is identified and provides capability.');
  token = session.token;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}
async function post(route, body, headers = {}) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Field-Token': token, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
}
async function resolve(referenceId) {
  const response = await post('/api/files/resolve', { referenceIds: [referenceId] });
  assert.equal(response.status, 200);
  return (await response.json()).references[0];
}
function rawStatus(headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(base + '/api/session', { headers }, response => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject);
    request.end();
  });
}
try {
  await start();
  check((await fetch(base + '/api/session', { headers: { Origin: 'https://example.com' } })).status === 403, 'Foreign origin cannot acquire session.');
  check(await rawStatus({ Host: 'example.com:' + port }) === 403, 'Foreign Host is rejected.');
  check((await fetch(base + '/api/session', { headers: { Origin: 'null' } })).status === 401, 'Opaque origin cannot acquire session without capability.');
  check((await fetch(base + '/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status === 403, 'Cross-site session is rejected.');
  check((await fetch(base + '/api/files/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401, 'File API requires capability.');
  check((await post('/api/files/resolve', { referenceIds: [] }, { 'X-Field-Token': 'invalid' })).status === 401, 'Expired capability is rejected.');
  check((await post('/api/files/track', { path: fixture }, { Origin: 'https://example.com' })).status === 403, 'Capability never enables foreign HTTP origins.');
  const nullSession = await fetch(base + '/api/session', { headers: { Origin: 'null', 'X-Field-Token': token } });
  check(nullSession.status === 200 && nullSession.headers.get('access-control-allow-origin') === 'null', 'Authorized existing file-origin interface may connect.');
  const preflight = await fetch(base + '/api/files/track', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-field-token' } });
  check(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === 'null', 'File-origin JSON requests can preflight their capability header.');
  const malformed = await fetch(base + '/api/files/track', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Field-Token': token }, body: '{' });
  check(malformed.status === 400, 'Malformed JSON remains a client error.');
  for (const resource of ['/native/Program.cs', '/.git/config', '/README.md', '/native/bin/Release/net8.0-windows/Field.Host.dll'])
    check((await fetch(base + resource)).status === 404, 'Private source/build file is not served.');
  check((await post('/api/files/track', { path: fixture })).status === 400, 'Directories cannot be registered as files.');
  check((await post('/api/files/track', { path: path.join(fixture, 'does-not-exist.txt') })).status === 400, 'Missing new files cannot be registered.');
  const original = path.join(fixture, 'original.txt');
  await writeFile(original, 'A FIELD host fixture.');
  const response = await post('/api/files/track', { path: original });
  assert.equal(response.status, 200);
  const tracked = (await response.json()).reference;
  check(tracked.status === 'available' && tracked.recoverable && tracked.identity, 'NTFS fixture has stable native identity.');
  const duplicate = (await (await post('/api/files/track', { path: original })).json()).reference;
  check(duplicate.referenceId === tracked.referenceId, 'Repeated registration reuses reference.');
  const renamed = path.join(fixture, 'renamed.txt');
  await rename(original, renamed);
  const afterRename = await resolve(tracked.referenceId);
  check(afterRename.status === 'available' && afterRename.path === renamed, 'Registered reference follows rename.');
  const destination = path.join(fixture, 'moved');
  await mkdir(destination);
  const moved = path.join(destination, 'renamed.txt');
  await rename(renamed, moved);
  const blockedTemporary = path.join(data, 'file-references.json.tmp');
  await mkdir(blockedTemporary);
  check((await post('/api/files/resolve', { referenceIds: [tracked.referenceId] })).status === 500, 'Registry write failure is returned instead of claiming success.');
  await rmdir(blockedTemporary);
  const afterMove = await resolve(tracked.referenceId);
  check(afterMove.status === 'available' && afterMove.path === moved, 'Registered reference follows same-volume move.');
  const disk = JSON.parse(await readFile(path.join(data, 'file-references.json'), 'utf8'));
  check(disk.references[0].path === moved && disk.references[0].identity.fileId === tracked.identity.fileId, 'Registry atomically stores current path and identity.');
  const competing = spawn('dotnet', [dll, '--port', String(port + 1), '--root', root, '--data-dir', data], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  const [competingCode] = await once(competing, 'exit');
  check(competingCode !== 0, 'A competing process cannot write the same registry.');
  await stop();
  await start();
  const afterRestart = await resolve(tracked.referenceId);
  check(afterRestart.status === 'available' && afterRestart.identity.fileId === tracked.identity.fileId, 'Persisted references resolve after process restart.');
  const unregistered = await resolve('00000000000000000000000000000000');
  check(unregistered.status === 'unregistered', 'Unknown reference explicitly requires relink.');
  console.log(`PASS: ${checks} host/API checks. Fixtures: ${fixture}`);
} finally { await stop(); }
