(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FieldContextMenu = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function create({ document = globalThis.document, window = document.defaultView } = {}) {
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    menu.hidden = true;
    document.body.append(menu);
    let anchor = null;
    let buttons = [];

    function close({ restoreFocus = true } = {}) {
      if (menu.hidden) return;
      const previousAnchor = anchor;
      previousAnchor?.classList.remove('context-menu-target');
      menu.hidden = true;
      anchor = null;
      buttons = [];
      menu.replaceChildren();
      if (restoreFocus && previousAnchor?.isConnected && !previousAnchor.disabled) {
        previousAnchor.focus({ preventScroll: true });
      }
    }

    function focus(button) {
      for (const candidate of buttons) candidate.tabIndex = candidate === button ? 0 : -1;
      (button || menu).focus({ preventScroll: true });
    }

    function open({ x, y, anchor: nextAnchor = document.activeElement, label = 'Actions', entries }) {
      close({ restoreFocus: false });
      const visible = entries.filter((entry, index) => entry || index > 0 && entries[index - 1]);
      while (visible.length && !visible[visible.length - 1]) visible.pop();
      if (!visible.length) return;
      anchor = nextAnchor;
      anchor?.classList.add('context-menu-target');
      menu.setAttribute('aria-label', label);
      for (const entry of visible) {
        if (!entry) {
          const separator = document.createElement('div');
          separator.className = 'context-menu-separator';
          separator.setAttribute('role', 'separator');
          menu.append(separator);
          continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'context-menu-item';
        if (entry.danger) button.classList.add('danger');
        button.setAttribute('role', 'menuitem');
        button.tabIndex = -1;
        button.disabled = Boolean(entry.disabled);
        if (button.disabled) button.setAttribute('aria-disabled', 'true');
        if (entry.icon) {
          const glyph = document.createElement('span');
          glyph.className = 'context-menu-icon';
          glyph.setAttribute('aria-hidden', 'true');
          glyph.innerHTML = entry.icon; // Icons come from FIELD's trusted icon set.
          button.append(glyph);
        }
        const text = document.createElement('span');
        text.textContent = entry.label;
        button.append(text);
        button.addEventListener('click', event => {
          event.stopPropagation();
          if (button.disabled || menu.hidden) return;
          close();
          entry.run();
        });
        menu.append(button);
        if (!button.disabled) buttons.push(button);
      }
      const width = window.innerWidth || document.documentElement.clientWidth;
      const height = window.innerHeight || document.documentElement.clientHeight;
      menu.style.maxWidth = `${Math.max(0, width - 16)}px`;
      menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
      menu.style.visibility = 'hidden';
      menu.hidden = false;
      const bounds = menu.getBoundingClientRect();
      const origin = anchor?.getBoundingClientRect();
      const requestedX = Number.isFinite(x) ? x : origin?.left || 8;
      const requestedY = Number.isFinite(y) ? y : origin?.bottom || 8;
      menu.style.left = `${Math.max(8, Math.min(requestedX, width - bounds.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(requestedY, height - bounds.height - 8))}px`;
      menu.style.visibility = '';
      focus(buttons[0]);
    }

    menu.addEventListener('keydown', event => {
      if (menu.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') {
        event.stopPropagation();
        close();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const current = buttons.indexOf(document.activeElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          event.key === 'ArrowDown' ? (current + 1) % buttons.length :
            (current - 1 + buttons.length) % buttons.length;
        focus(buttons[index]);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        if (buttons.includes(document.activeElement)) document.activeElement.click();
      }
    }, true);
    menu.addEventListener('click', event => event.stopPropagation());
    menu.addEventListener('pointerdown', event => event.stopPropagation());
    menu.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); });
    document.addEventListener('pointerdown', event => {
      if (!menu.hidden && !menu.contains(event.target)) close({ restoreFocus: false });
    }, true);
    document.addEventListener('focusin', event => {
      if (!menu.hidden && !menu.contains(event.target)) close({ restoreFocus: false });
    });
    document.addEventListener('scroll', event => {
      if (!menu.hidden && !menu.contains(event.target)) close({ restoreFocus: false });
    }, true);
    window.addEventListener('resize', () => close({ restoreFocus: false }));
    window.addEventListener('blur', () => close({ restoreFocus: false }));

    return { open, close, get isOpen() { return !menu.hidden; } };
  }

  return { create };
});
