// Pure hash-router helpers, extracted from App.svelte so the routing decision
// is testable without mounting the heavy Chat/Landing components (three.js,
// WebSocket, crypto).

// Normalize a `location.hash` into a route key: strip the leading '#', an
// optional '/', and lowercase the rest. '#/App' -> 'app', '#' -> '', '' -> ''.
export function parseRoute(hash = '') {
  return hash.replace(/^#\/?/, '').toLowerCase();
}

// Map a route key to the top-level view. Prefix match, so 'app' and 'app/x'
// both resolve to the chat view.
//
// NOTE: this is a prefix match, so 'application' (or any 'app…' route) also
// resolves to chat. That matches App.svelte's original `startsWith('app')`
// behavior — preserved here deliberately. Tighten to an exact/segment match if
// such routes ever exist (see App.svelte.test.js).
export function isAppRoute(route) {
  return route.startsWith('app');
}
