const test = require('node:test');
const assert = require('node:assert/strict');
const { routes } = require('../map-geometry.js');

const rect = (x, y) => ({ x, y, width: 176, height: 77 });
const edge = (id, from = 'a', to = 'b', kind = 'related') => ({ id, from, to, kind });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} != ${expected}`);
function onPerimeter(point, rectangle) {
  const within = point.x >= rectangle.x - 0.000001 && point.x <= rectangle.x + rectangle.width + 0.000001 &&
    point.y >= rectangle.y - 0.000001 && point.y <= rectangle.y + rectangle.height + 0.000001;
  return within && [point.x - rectangle.x, point.x - rectangle.x - rectangle.width,
    point.y - rectangle.y, point.y - rectangle.y - rectangle.height].some(value => Math.abs(value) < 0.000001);
}

test('a single horizontal connection runs between the visible rectangle edges', () => {
  const nodes = { a: rect(0, 0), b: rect(300, 0) };
  const route = routes([edge('ab')], id => nodes[id]).get('ab');
  assert.deepEqual(route.start, { x: 176, y: 38.5 });
  assert.deepEqual(route.end, { x: 300, y: 38.5 });
  assert.deepEqual(route.label, { x: 238, y: 38.5 });
  assert.equal(route.path, 'M 176 38.5 L 300 38.5');
});

test('vertical and diagonal routes end exactly on both field perimeters', () => {
  for (const destination of [rect(0, 250), rect(300, 180), rect(-260, -200)]) {
    const nodes = { a: rect(0, 0), b: destination };
    const route = routes([edge('ab')], id => nodes[id]).get('ab');
    assert.ok(onPerimeter(route.start, nodes.a));
    assert.ok(onPerimeter(route.end, nodes.b));
    near(route.label.x, (route.start.x + route.end.x) / 2);
    near(route.label.y, (route.start.y + route.end.y) / 2);
  }
});

test('shared items and manual connections use separate curves with on-curve labels', () => {
  const nodes = { a: rect(0, 0), b: rect(350, 0) };
  const result = routes([edge('manual'), edge('shared', 'b', 'a', 'shared')], id => nodes[id]);
  const first = result.get('manual');
  const second = result.get('shared');
  assert.notEqual(first.label.y, second.label.y);
  assert.notEqual(first.path, second.path);
  for (const route of result.values()) {
    near(route.label.x, 0.25 * route.start.x + 0.5 * route.control.x + 0.25 * route.end.x);
    near(route.label.y, 0.25 * route.start.y + 0.5 * route.control.y + 0.25 * route.end.y);
  }
  assert.ok(onPerimeter(first.start, nodes.a));
  assert.ok(onPerimeter(second.start, nodes.b));
});

test('route lanes are stable when incoming edge order changes', () => {
  const nodes = { a: rect(0, 0), b: rect(300, 100) };
  const edges = [edge('c'), edge('b'), edge('a', 'a', 'b', 'parent')];
  const before = routes(edges, id => nodes[id]);
  const after = routes([...edges].reverse(), id => nodes[id]);
  for (const connection of edges) assert.deepEqual(after.get(connection.id), before.get(connection.id));
});

test('dragging changes geometry without separating a label from its connection', () => {
  const nodes = { a: rect(10, 20), b: rect(320, 40) };
  const before = routes([edge('ab')], id => nodes[id]).get('ab');
  nodes.b = rect(90, 300);
  const after = routes([edge('ab')], id => nodes[id]).get('ab');
  assert.notEqual(after.path, before.path);
  assert.ok(onPerimeter(after.start, nodes.a));
  assert.ok(onPerimeter(after.end, nodes.b));
  near(after.label.x, (after.start.x + after.end.x) / 2);
  near(after.label.y, (after.start.y + after.end.y) / 2);
});

test('overlapping fields remain finite and missing fields do not emit broken routes', () => {
  const nodes = { a: rect(0, 0), b: rect(0, 0) };
  const result = routes([edge('ab'), edge('bad', 'a', 'missing')], id => nodes[id]);
  assert.equal(result.size, 1);
  assert.ok(!/NaN|Infinity/.test(result.get('ab').path));
});
