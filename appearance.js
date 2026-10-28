/* Apply the saved appearance before the first paint. Library data is untouched. */
(function () {
  'use strict';
  const key = 'field-appearance-theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => value === 'light' || value === 'dark';
  let preference = null;
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch { /* The theme still works when preference storage is unavailable. */ }

  const sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>';
  const moon = '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z"/>';

  function updateControl() {
    const control = document.getElementById('theme-toggle');
    if (!control) return;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    control.setAttribute('aria-label', `Switch to ${next} theme`);
    control.title = next === 'light' ? 'Light theme' : 'Dark theme';
    control.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${next === 'light' ? sun : moon}</svg>`;
  }

  function apply(theme) {
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#fcfcfa' : '#101215');
    updateControl();
    if (window.FieldDesktop?.isDesktop) window.FieldDesktop.ready
      .then(() => window.FieldDesktop.request('app.theme', { theme }))
      .catch(() => {});
  }

  function setTheme(theme) {
    if (!valid(theme)) return;
    preference = theme;
    try { localStorage.setItem(key, theme); } catch { /* Session preference remains active. */ }
    apply(theme);
  }

  apply(preference || (system.matches ? 'dark' : 'light'));
  document.addEventListener('DOMContentLoaded', () => {
    updateControl();
    document.getElementById('theme-toggle')?.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
  });
  system.addEventListener('change', event => {
    if (!preference) apply(event.matches ? 'dark' : 'light');
  });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : null;
    apply(preference || (system.matches ? 'dark' : 'light'));
  });
})();
