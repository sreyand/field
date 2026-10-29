(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FieldActivation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function create({ getItem, showDetails, openFile, canActivate, getDelay = () => 500, onPending = () => {} }) {
    let timer = null;
    let pendingId = null;
    function cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null; pendingId = null; onPending(null);
    }
    function click(id, count = 1) {
      const previousId = pendingId;
      cancel();
      if (!canActivate()) return;
      const item = getItem(id);
      if (!item) return;
      if (item.kind !== 'file' || count === 0) { showDetails(id); return; }
      if (count === 2) { if (previousId === id) openFile(id); return; }
      if (count > 2) return;
      pendingId = id; onPending(id);
      timer = setTimeout(() => {
        cancel();
        if (canActivate() && getItem(id)) showDetails(id);
      }, Math.max(200, Math.min(5000, getDelay())) + 30);
    }
    return { click, cancel, get pending() { return pendingId !== null; } };
  }
  return { create };
});
