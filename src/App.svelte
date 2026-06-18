<script>
  // Tiny hash router: `#/` → landing, `#/app` → the fleet chat. Hash-based so it
  // works on any static host (CF Pages etc.) without SPA-fallback rewrites.
  // Routing logic lives in ./lib/router.js so it can be unit-tested in isolation.
  import Landing from './Landing.svelte';
  import Chat from './Chat.svelte';
  import { parseRoute, isAppRoute } from './lib/router.js';

  let route = $state(parseRoute(location.hash));

  $effect(() => {
    const onHash = () => (route = parseRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
</script>

{#if isAppRoute(route)}
  <Chat />
{:else}
  <Landing />
{/if}
