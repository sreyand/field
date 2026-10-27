/* A capability-scoped bridge to the local Windows runtime. File contents stay on disk. */
(function () {
  'use strict';
  let base = location.protocol === 'http:' && location.hostname === '127.0.0.1' ? location.origin : '';
  let token = '';
  let connected = false;
  let connecting = null;
  const storageKey = 'field-native-session';
  const validConfig = config => config && Number.isInteger(config.port) && config.port > 0 && config.port <= 65535 &&
    typeof config.token === 'string' && /^[A-Za-z0-9_+/=-]{32,128}$/.test(config.token);
  if (location.protocol === 'file:') {
    try {
      const fragment = new URLSearchParams(location.hash.slice(1));
      let config;
      if (fragment.has('field-runtime')) {
        config = JSON.parse(atob(fragment.get('field-runtime').replace(/-/g, '+').replace(/_/g, '/')));
        if (!validConfig(config)) throw new Error('Invalid runtime session.');
        sessionStorage.setItem(storageKey, JSON.stringify(config));
        fragment.delete('field-runtime');
        history.replaceState(null, '', location.pathname + (fragment.size ? '#' + fragment : ''));
      } else config = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (validConfig(config)) {
        base = `http://127.0.0.1:${config.port}`;
        token = config.token;
      }
    } catch { base = ''; token = ''; }
  }

  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    window.dispatchEvent(new Event('field-runtime-change'));
  }

  async function request(path, body, timeout = 8000) {
    if (!base) throw new Error('Open FIELD.cmd to connect file tracking.');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    let response;
    try {
      response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit', cache: 'no-store', signal: abort.signal,
        headers: { ...(token ? { 'X-Field-Token': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      setConnected(false);
      throw new Error('File tracking is offline. Open FIELD.cmd to reconnect.');
    } finally { clearTimeout(timer); }
    let data;
    try { data = await response.json(); }
    catch { setConnected(false); throw new Error('Open FIELD.cmd to connect file tracking.'); }
    if (!response.ok) {
      const error = new Error(data.error || data.message || 'The file operation failed.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function connect() {
    if (!base) return false;
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        const session = await request('/api/session');
        if (session.app !== 'FIELD' || session.platform !== 'windows' || typeof session.token !== 'string') throw new Error('Invalid runtime.');
        token = session.token;
        setConnected(true);
        return true;
      } catch { setConnected(false); return false; }
      finally { connecting = null; }
    })();
    return connecting;
  }

  async function call(path, body, timeout) {
    if (!connected && !await connect()) throw new Error('Open FIELD.cmd to connect file tracking.');
    try { return await request(path, body, timeout); }
    catch (error) {
      if (error.status === 401 && location.protocol === 'http:' && await connect()) return request(path, body, timeout);
      throw error;
    }
  }

  window.FieldNative = {
    get available() { return connected; },
    get configured() { return Boolean(base); },
    connect,
    track: async path => (await call('/api/files/track', { path })).reference,
    pick: async () => (await call('/api/files/pick', {}, 120000)).reference || null,
    resolve: async referenceIds => (await call('/api/files/resolve', { referenceIds })).references,
    open: referenceId => call('/api/files/open', { referenceId })
  };
  window.FieldNative.ready = connect();
})();
