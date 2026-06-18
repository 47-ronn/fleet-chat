// Pure hash-router helpers, extracted from App.svelte so the routing decision
// is testable without mounting the heavy Chat/Landing components (three.js,
// WebSocket, crypto).

// Normalize a `location.hash` into a route key: strip the leading '#', an
// optional '/', and lowercase the rest. '#/App' -> 'app', '#' -> '', '' -> ''.
export function parseRoute(hash = '') {
  return hash.replace(/^#\/?/, '').toLowerCase();
}

// Map a route key to the top-level view: the exact 'app' route or any of its
// sub-paths ('app/123') resolve to the chat view; everything else is landing.
//
// Segment-aware on purpose — a bare `startsWith('app')` would also match
// unrelated routes like 'application' or 'apple'.
export function isAppRoute(route) {
  return route === 'app' || route.startsWith('app/');
}
