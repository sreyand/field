const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../context-menu.js');

function harness({ width = 640, height = 480 } = {}) {
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    dispatch(type, properties = {}) {
      const event = { target: this, ...properties, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      for (const handler of this.listeners.get(type) || []) handler(event);
      return event;
    }
  }
  class Element extends Target {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {};
      this.style = {}; this.hidden = false; this.disabled = false; this.isConnected = false;
      const classes = new Set();
      this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(child) { this.children.push(child); child.parent = this; child.isConnected = this.isConnected; }
    replaceChildren() { this.children.forEach(child => { child.isConnected = false; child.parent = null; }); this.children = []; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    focus() { document.activeElement = this; document.dispatch('focusin', { target: this }); }
    click() { if (!this.disabled) this.dispatch('click'); }
    getBoundingClientRect() {
      return this.className === 'context-menu' ? { left: 0, bottom: 0, width: 210, height: 180 } :
        { left: 30, bottom: 70, width: 150, height: 40 };
    }
  }
  const document = new Target();
  const window = new Target();
  Object.assign(window, { innerWidth: width, innerHeight: height });
  Object.assign(document, { defaultView: window, createElement: tag => new Element(tag), documentElement: {} });
  document.body = new Element('body'); document.body.isConnected = true;
  const anchor = new Element('button'); document.body.append(anchor); document.activeElement = anchor;
  const controller = create({ document, window });
  const menu = document.body.children.find(child => child.className === 'context-menu');
  const entries = () => menu.children.filter(child => child.tagName === 'BUTTON');
  return { controller, document, window, anchor, menu, entries };
}

test('opens a labelled accessible menu, preserves literal labels and skips disabled actions', () => {
  const h = harness();
  h.controller.open({ x: 100, y: 120, anchor: h.anchor, label: 'Video actions', entries: [
    { label: 'Open', disabled: true, run() {} }, null,
    { label: '<img src=x>', run() {} }, { label: 'Edit', run() {} }
  ] });
  assert.equal(h.controller.isOpen, true);
  assert.equal(h.anchor.classList.contains('context-menu-target'), true);
  assert.equal(h.menu.attributes.role, 'menu');
  assert.equal(h.menu.attributes['aria-label'], 'Video actions');
  assert.equal(h.entries()[0].attributes['aria-disabled'], 'true');
  assert.equal(h.entries()[1].children[0].textContent, '<img src=x>');
  assert.equal(h.document.activeElement, h.entries()[1]);
  assert.deepEqual(h.entries().map(button => button.tabIndex), [-1, 0, -1]);
});

test('clamps the menu at every viewport edge and restricts size on small windows', () => {
  const h = harness();
  h.controller.open({ x: 638, y: 479, anchor: h.anchor, entries: [{ label: 'Edit', run() {} }] });
  assert.equal(h.menu.style.left, '422px');
  assert.equal(h.menu.style.top, '292px');
  h.controller.open({ x: -20, y: -30, anchor: h.anchor, entries: [{ label: 'Edit', run() {} }] });
  assert.equal(h.menu.style.left, '8px');
  assert.equal(h.menu.style.top, '8px');
  assert.equal(h.menu.style.maxWidth, '624px');
  assert.equal(h.menu.style.maxHeight, '464px');
});

test('keyboard arrows wrap enabled actions, Home and End select endpoints', () => {
  const h = harness();
  h.controller.open({ anchor: h.anchor, entries: [
    { label: 'Open', run() {} }, { label: 'Unavailable', disabled: true, run() {} },
    { label: 'Edit', run() {} }, { label: 'Fields', run() {} }
  ] });
  const actions = h.entries();
  h.menu.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(h.document.activeElement, actions[3]);
  h.menu.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(h.document.activeElement, actions[0]);
  h.menu.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(h.document.activeElement, actions[2]);
  h.menu.dispatch('keydown', { key: 'End' });
  assert.equal(h.document.activeElement, actions[3]);
  h.menu.dispatch('keydown', { key: 'Home' });
  assert.equal(h.document.activeElement, actions[0]);
});

test('Enter activates once after closing and restoring focus, allowing an action to focus a modal', () => {
  const h = harness();
  let runs = 0;
  const modalInput = h.document.createElement('input'); h.document.body.append(modalInput);
  h.controller.open({ anchor: h.anchor, entries: [{ label: 'Edit', run() {
    runs++;
    assert.equal(h.controller.isOpen, false);
    assert.equal(h.document.activeElement, h.anchor);
    modalInput.focus();
  } }] });
  const event = h.menu.dispatch('keydown', { key: 'Enter' });
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(runs, 1);
  assert.equal(h.document.activeElement, modalInput);
});

test('Escape restores anchor focus and consumes the key; Tab closes without preventing navigation', () => {
  const h = harness();
  const options = { anchor: h.anchor, entries: [{ label: 'Edit', run() {} }] };
  h.controller.open(options);
  const escape = h.menu.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.controller.isOpen, false);
  assert.equal(h.document.activeElement, h.anchor);
  assert.equal(h.anchor.classList.contains('context-menu-target'), false);
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);
  h.controller.open(options);
  const tab = h.menu.dispatch('keydown', { key: 'Tab' });
  assert.equal(h.controller.isOpen, false);
  assert.equal(tab.prevented, false);
  assert.equal(tab.stopped, true);
});

test('outside click, focus, scroll, blur and resize dismiss without stealing focus', () => {
  const h = harness();
  const options = { anchor: h.anchor, entries: [{ label: 'Edit', run() {} }] };
  for (const [target, event] of [[h.document, 'pointerdown'], [h.document, 'focusin'],
    [h.document, 'scroll'], [h.window, 'blur'], [h.window, 'resize']]) {
    h.controller.open(options);
    const focusedButton = h.document.activeElement;
    target.dispatch(event, { target: h.document.body });
    assert.equal(h.controller.isOpen, false, event);
    assert.equal(h.document.activeElement, focusedButton, event);
  }
});

test('inside pointer events and scrolling preserve the menu and default context menus are suppressed', () => {
  const h = harness();
  h.controller.open({ anchor: h.anchor, entries: [{ label: 'Edit', run() {} }] });
  h.document.dispatch('pointerdown', { target: h.entries()[0] });
  h.document.dispatch('scroll', { target: h.menu });
  assert.equal(h.controller.isOpen, true);
  const event = h.menu.dispatch('contextmenu');
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test('menus with only disabled entries can close safely and empty menus stay hidden', () => {
  const h = harness();
  h.controller.open({ anchor: h.anchor, entries: [{ label: 'Unavailable', disabled: true, run() {} }] });
  assert.equal(h.document.activeElement, h.menu);
  h.menu.dispatch('keydown', { key: 'ArrowDown' });
  h.menu.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.controller.isOpen, false);
  h.controller.open({ anchor: h.anchor, entries: [null, null] });
  assert.equal(h.controller.isOpen, false);
});
