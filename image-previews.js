/* Lazy, bounded previews. Decoded images never enter the library snapshot. */
(function () {
  'use strict';
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;
  const supported = /\.(png|jpe?g|gif|bmp|tiff?|webp|ico)$/i;
  function key(item) {
    const ref = item.native;
    return ref && supported.test(ref.path || '') ? JSON.stringify([ref.referenceId, ref.path, ref.modifiedUtc, ref.size, ref.status]) : null;
  }
  async function pump() {
    if (active >= 2 || !queue.length) return;
    const { item, id, resolve } = queue.shift();
    active++;
    let result = null;
    try {
      const response = await window.FieldDesktop.request('files.preview', { referenceId: item.native.referenceId });
      if (response.available && /^data:image\/png;base64,/.test(response.dataUrl)) result = response;
    } catch { /* File icons remain available when a preview cannot be decoded. */ }
    cache.set(id, result);
    while (cache.size > 32) cache.delete(cache.keys().next().value);
    pending.delete(id);
    active--;
    resolve(result);
    pump();
  }
  function load(item) {
    const id = key(item);
    if (!id || !window.FieldDesktop?.isDesktop || item.native.status !== 'available') return Promise.resolve(null);
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    if (!pending.has(id)) {
      pending.set(id, new Promise(resolve => queue.push({ item, id, resolve })));
      pump();
    }
    return pending.get(id);
  }
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const image = entry.target;
    observer.unobserve(image);
    const item = image.previewItem;
    delete image.previewItem;
    load(item).then(result => {
      if (!image.isConnected) return;
      if (result) {
        image.onload = () => { image.hidden = false; };
        image.onerror = () => { image.hidden = true; };
        image.src = result.dataUrl;
        if (image.classList.contains('detail-image')) image.title = `${result.width} × ${result.height}`;
      } else image.remove();
    });
  }), { rootMargin: '120px' });
  window.FieldPreviews = {
    supported: item => Boolean(key(item)) && window.FieldDesktop?.isDesktop && item.native.status === 'available',
    observe(items) {
      observer.disconnect();
      for (const image of document.querySelectorAll('[data-image-preview]')) {
        const item = items.find(candidate => candidate.id === image.dataset.imagePreview);
        if (item) { image.previewItem = item; observer.observe(image); }
      }
    }
  };
})();
