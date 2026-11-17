<script>
  // Tiny hash router: `#/` → landing, `#/app` → the fleet chat. Hash-based so it
  // works on any static host (CF Pages etc.) without SPA-fallback rewrites.
  // Routing logic lives in ./lib/router.js so it can be unit-tested in isolation.
  //
  // `#/app/join/<payload>` is the Share-room QR link: the payload is stripped
  // from the hash (so it never lingers in the address bar / history) and
  // handed to Chat as a prop.
  import Landing from './Landing.svelte';
  import Chat from './Chat.svelte';
  import { parseRoute, isAppRoute, parseJoinRoute } from './lib/router.js';

  let joinPayload = $state(null);

  function applyRoute() {
    const payload = parseJoinRoute(location.hash);
    if (payload) {
      joinPayload = payload;
      // Strip the secret from the address bar + history (replace, not push).
      history.replaceState(null, '', `${location.pathname}#/app`);
      route = 'app';
    } else {
      route = parseRoute(location.hash);
    }
  }

  let route = $state(parseRoute(location.hash));

  $effect(() => {
    const onHash = () => applyRoute();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
</script>

{#if isAppRoute(route)}
  <Chat {joinPayload} />
{:else}
  <Landing />
{/if}