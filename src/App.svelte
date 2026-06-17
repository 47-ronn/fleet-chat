<script>
  // Tiny hash router: `#/` → landing, `#/app` → the fleet chat. Hash-based so it
  // works on any static host (CF Pages etc.) without SPA-fallback rewrites.
  import Landing from './Landing.svelte';
  import Chat from './Chat.svelte';

  const parseRoute = () => location.hash.replace(/^#\/?/, '').toLowerCase();
  let route = $state(parseRoute());

  $effect(() => {
    const onHash = () => (route = parseRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
</script>

{#if route.startsWith('app')}
  <Chat />
{:else}
  <Landing />
{/if}
