/* Field rectangles, connection routes and their on-curve label positions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FieldMapGeometry = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function center(rect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  function perimeter(rect, toward) {
    const origin = center(rect);
    const dx = toward.x - origin.x;
    const dy = toward.y - origin.y;
    if (!dx && !dy) return { x: rect.x + rect.width, y: origin.y };
    const scale = Math.min(dx ? rect.width / 2 / Math.abs(dx) : Infinity,
      dy ? rect.height / 2 / Math.abs(dy) : Infinity);
    return { x: origin.x + dx * scale, y: origin.y + dy * scale };
  }

  const number = value => String(Math.round(value * 1000) / 1000);

  function routes(edges, rectangle) {
    const pairs = new Map();
    for (const edge of edges) {
      const key = JSON.stringify([edge.from, edge.to].sort());
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(edge);
    }
    const result = new Map();
    for (const pair of pairs.values()) {
      pair.sort((a, b) => {
        const rank = { parent: 0, shared: 1, related: 2 };
        return (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3) || a.id.localeCompare(b.id);
      });
      pair.forEach((edge, index) => {
        const from = rectangle(edge.from);
        const to = rectangle(edge.to);
        if (!from || !to) return;
        const a = center(from);
        const b = center(to);
        const canonical = edge.from < edge.to ? [a, b] : [b, a];
        const dx = canonical[1].x - canonical[0].x;
        const dy = canonical[1].y - canonical[0].y;
        const distance = Math.hypot(dx, dy);
        const normal = distance ? { x: -dy / distance, y: dx / distance } : { x: 0, y: 1 };
        // Quadratic curves reach half the control-point offset at their midpoint.
        const offset = (index - (pair.length - 1) / 2) * 64;
        const control = { x: (a.x + b.x) / 2 + normal.x * offset, y: (a.y + b.y) / 2 + normal.y * offset };
        const start = perimeter(from, control);
        const end = perimeter(to, control);
        const label = { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 };
        const path = offset === 0
          ? `M ${number(start.x)} ${number(start.y)} L ${number(end.x)} ${number(end.y)}`
          : `M ${number(start.x)} ${number(start.y)} Q ${number(control.x)} ${number(control.y)} ${number(end.x)} ${number(end.y)}`;
        result.set(edge.id, { start, end, control, label, path });
      });
    }
    return result;
  }

  return { routes };
});
