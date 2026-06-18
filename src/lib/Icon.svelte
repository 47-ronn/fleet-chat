<script>
  // Inline, line-md-style stroke icons with a draw-on animation (the stroke
  // paints itself in on mount via stroke-dashoffset, normalized with
  // pathLength="1" so it's geometry-independent). Multi-path icons stagger.
  //
  // Usage: <Icon name="arrow-down" size={20} />
  //   draw={false} renders the icon statically (no animation).
  let { name, size = 18, stroke = 2, draw = true, title = '' } = $props();
</script>

<svg
  class="icon"
  class:draw
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={title ? undefined : 'true'}
  role={title ? 'img' : undefined}
  aria-label={title || undefined}
>
  {#if name === 'arrow-down'}
    <path pathLength="1" d="M12 4v15" />
    <path pathLength="1" d="M6 13l6 6 6-6" />
  {:else if name === 'arrow-up'}
    <path pathLength="1" d="M12 20V5" />
    <path pathLength="1" d="M6 11l6-6 6 6" />
  {:else if name === 'folder'}
    <path pathLength="1" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  {:else if name === 'cloud'}
    <path pathLength="1" d="M7 18h10a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8 9.2 4 4 0 0 0 7 18z" />
  {:else if name === 'settings'}
    <circle pathLength="1" cx="12" cy="12" r="3" />
    <path pathLength="1" d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
  {:else if name === 'logout'}
    <path pathLength="1" d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path pathLength="1" d="M16 17l5-5-5-5" />
    <path pathLength="1" d="M21 12H9" />
  {:else if name === 'menu'}
    <path pathLength="1" d="M3 6h18" />
    <path pathLength="1" d="M3 12h18" />
    <path pathLength="1" d="M3 18h18" />
  {:else if name === 'plus'}
    <path pathLength="1" d="M12 5v14" />
    <path pathLength="1" d="M5 12h14" />
  {:else if name === 'home'}
    <path pathLength="1" d="M3 11l9-8 9 8" />
    <path pathLength="1" d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
  {/if}
</svg>

<style>
  .icon {
    display: block;
    flex: none;
    overflow: visible;
  }
  /* Each stroke paints itself in; later strokes start slightly later. */
  .draw :global(path),
  .draw :global(circle),
  .draw :global(line) {
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    animation: icon-draw 0.5s ease forwards;
  }
  .draw :global(:nth-child(2)) {
    animation-delay: 0.12s;
  }
  .draw :global(:nth-child(3)) {
    animation-delay: 0.24s;
  }
  @keyframes icon-draw {
    to {
      stroke-dashoffset: 0;
    }
  }
  /* Respect reduced-motion: show the icon fully drawn, no animation. */
  @media (prefers-reduced-motion: reduce) {
    .draw :global(path),
    .draw :global(circle),
    .draw :global(line) {
      animation: none;
      stroke-dashoffset: 0;
    }
  }
</style>
