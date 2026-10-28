/* Explicit RPC to the desktop window. Browser previews keep using browser storage. */
(function () {
  'use strict';
  const webview = window.chrome?.webview;
  const isDesktop = Boolean(webview && location.origin === 'https://field.local');
  const pending = new Map();
  const methods = new Set(['app.info', 'app.theme', 'files.track', 'files.resolve', 'files.pick', 'files.open', 'files.preview', 'library.load', 'library.save', 'library.import', 'library.pickImport']);

  function request(method, params = {}, timeout = 15000) {
    if (!isDesktop) return Promise.reject(new Error('The FIELD desktop app is not connected.'));
    if (!methods.has(method)) return Promise.reject(new Error('Unsupported desktop operation.'));
    if (pending.size >= 64) return Promise.reject(new Error('Too many operations are in progress. Try again.'));
    return new Promise((resolve, reject) => {
      const id = 'desktop-' + crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The desktop operation timed out. Try again.'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try { webview.postMessage({ id, method, params }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }

  if (isDesktop) webview.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.id !== 'string' || typeof message.ok !== 'boolean') return;
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    clearTimeout(operation.timer);
    if (message.ok) operation.resolve(message.result);
    else {
      const error = new Error(message.error?.message || 'The desktop operation failed.');
      error.code = message.error?.code;
      operation.reject(error);
    }
  });

  window.FieldDesktop = { isDesktop, request };
  window.FieldDesktop.ready = isDesktop ? request('app.info').then(info => {
    if (info?.app !== 'FIELD' || info.platform !== 'windows') throw new Error('The desktop connection is invalid.');
    return info;
  }) : Promise.resolve(null);
  // A startup error is displayed by library initialization when it awaits this promise.
  window.FieldDesktop.ready.catch(() => {});
})();
