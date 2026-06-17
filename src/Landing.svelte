<script>
  // Static landing page describing the project. The CTA links to `#/app`, which
  // the hash router (App.svelte) renders as the fleet chat.
  import { onMount } from 'svelte';
  import BrainField from './lib/BrainField.svelte';
  import HowItWorks from './lib/HowItWorks.svelte';

  const GITHUB = 'https://github.com/47-ronn/tunshell_mcp_agents';
  const NPM = 'https://www.npmjs.com/package/remote-agents';

  // The brain animation is heavy (WebGL + ~100k points), so skip it on phones/
  // small screens entirely — better performance and battery.
  const MOBILE = '(max-width: 760px)';
  let showBrain = $state(typeof matchMedia === 'undefined' ? true : !matchMedia(MOBILE).matches);
  onMount(() => {
    const mq = matchMedia(MOBILE);
    const update = () => (showBrain = !mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });

  const features = [
    {
      icon: '🦀',
      title: 'Single Rust binary',
      body: '`remote-agent` runs as an agent daemon (`run`), an MCP stdio server (`mcp`), or installs itself as a service — nothing else to install.',
    },
    {
      icon: '🔒',
      title: 'End-to-end encryption',
      body: 'AES-GCM-256 by default. The relay forwards only ciphertext and never sees your commands or results.',
    },
    {
      icon: '🛡️',
      title: 'Safety modes',
      body: 'Per host: plan (read-only), edit (writes with backups), bypass, disabled — plus path & command allow/deny-lists.',
    },
    {
      icon: '🖥️',
      title: 'Fleet as one computer',
      body: 'Any operation (exec / read / write / git) across all agents at once, by tags or by OS — results aggregated per host.',
    },
    {
      icon: '🧩',
      title: 'Distributed MapReduce',
      body: 'Partition data across the fleet, map with a shell command, reduce the outputs — with per-partition retry.',
    },
    {
      icon: '🤖',
      title: 'Autonomous mode',
      body: 'Delegate an AI task to a host that runs it with its own provider credentials — token-saving orchestration.',
    },
    {
      icon: '🌐',
      title: 'Two interchangeable relays',
      body: 'Cloudflare Workers (Durable Objects) or a self-hosted Rust WebSocket relay — switch with one `relay_url`.',
    },
    {
      icon: '⚡',
      title: 'Direct UDP channel',
      body: 'Host↔host data transfer via hole-punching, SHA-256 verified, with automatic fallback to the WebSocket relay.',
    },
  ];

  const providers = ['claude', 'opencode', 'cline', 'roo', 'kilo', 'zed'];
</script>

<div class="landing">
  <header class="nav">
    <div class="brand">⛓️ Remote Agents</div>
    <nav class="links">
      <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>
      <a href={NPM} target="_blank" rel="noopener">npm</a>
      <a class="btn primary sm" href="#/app">Open app</a>
    </nav>
  </header>

  {#if showBrain}
    <div class="hero-bg" aria-hidden="true">
      <BrainField />
      <div class="hero-scrim"></div>
    </div>
  {/if}

  <section class="hero">
    <h1>Drive a fleet of machines through AI agents</h1>
    <p class="lede">
      A unified, <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">MCP</a>-compatible
      system: agents connect outbound to a relay, and an MCP server lets AI agents
      (Claude, opencode, Cline, Roo, Kilo, Zed) run commands, work with files,
      drive git, schedule tasks, and orchestrate the whole fleet — all over
      end-to-end-encrypted channels.
    </p>
    <div class="cta">
      <a class="btn primary" href="#/app">Open app →</a>
      <a class="btn" href={GITHUB} target="_blank" rel="noopener">Source on GitHub</a>
    </div>
    <pre class="install"><code>npm install -g remote-agents
remote-agents mcp --help</code></pre>
  </section>

  <section class="features">
    <h2>Features</h2>
    <div class="grid">
      {#each features as f}
        <div class="card">
          <div class="ic">{f.icon}</div>
          <h3>{f.title}</h3>
          <p>{f.body}</p>
        </div>
      {/each}
    </div>
  </section>

  <section class="how">
    <h2>How it works</h2>
    <div class="how-grid">
      <ol class="steps">
        <li>
          <strong>An AI agent talks to <code>remote-agent mcp</code></strong>
          <span>Claude, opencode, Cline, Roo, Kilo or Zed — one MCP interface to the fleet.</span>
        </li>
        <li>
          <strong>The command is encrypted and sent to the relay</strong>
          <span>AES-GCM-256 over <code>wss://</code> — end-to-end; only the endpoints hold the key.</span>
        </li>
        <li>
          <strong>The relay forwards ciphertext only</strong>
          <span>Cloudflare Worker or self-hosted Rust — never sees commands or data.</span>
        </li>
        <li>
          <strong>Fleet agents execute and reply</strong>
          <span>exec / read / write / git on the right hosts — results over the same E2E channel.</span>
        </li>
        <li>
          <strong>Host↔host transfers go peer-to-peer</strong>
          <span>Direct UDP via hole-punching, SHA-256 verified, with automatic relay fallback.</span>
        </li>
      </ol>
      <HowItWorks />
    </div>
    <p class="note">
      This web panel is an anonymous observer in the room: it sees hosts in real
      time, sends commands, and reads each machine's AI-chat history
      ({#each providers as p, i}<code>{p}</code>{#if i < providers.length - 1}, {/if}{/each}).
    </p>
  </section>

  <footer class="foot">
    <span>MIT License</span>
    <span class="sep">·</span>
    <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>
    <span class="sep">·</span>
    <a href={NPM} target="_blank" rel="noopener">npm</a>
    <span class="sep">·</span>
    <a href="#/app">Open app</a>
  </footer>
</div>

<style>
  .landing {
    position: relative;
    height: 100%;
    overflow-y: auto;
    background: radial-gradient(1200px 600px at 50% -10%, #232a45 0%, var(--bg) 55%);
  }
  /* Full-bleed 3D brain behind the hero. Anchored to the top of the page; it
     scrolls away with the hero as the user moves down. */
  .hero-bg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100vh;
    z-index: 0;
    pointer-events: none;
  }
  /* Darkens the centre behind the headline so text stays readable over the
     glowing core, while letting the brain's edges shine through. */
  .hero-scrim {
    position: absolute;
    inset: 0;
    background: radial-gradient(
      78% 66% at 50% 42%,
      rgba(20, 21, 22, 0.88) 0%,
      rgba(20, 21, 22, 0.6) 46%,
      rgba(20, 21, 22, 0.2) 68%,
      transparent 82%
    );
  }
  @media (prefers-reduced-motion: reduce) {
    .hero-bg { opacity: 0.85; }
  }
  .nav {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px;
    backdrop-filter: blur(8px);
    background: #1b1c1dcc;
    border-bottom: 1px solid var(--line);
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.2px;
  }
  .links {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .links a {
    color: var(--text-dim);
    text-decoration: none;
    font-size: 14px;
  }
  .links a:hover {
    color: var(--text);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 18px;
    color: var(--text);
    text-decoration: none;
    font-size: 15px;
    background: var(--bg-2);
    transition: border-color 0.15s, background 0.15s;
  }
  .btn:hover {
    border-color: var(--accent);
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .btn.primary:hover {
    filter: brightness(1.08);
  }
  .btn.sm {
    padding: 7px 14px;
    font-size: 14px;
  }
  .hero {
    position: relative;
    z-index: 1;
    max-width: 820px;
    margin: 0 auto;
    padding: 72px 24px 40px;
    text-align: center;
  }
  .hero h1 {
    font-size: clamp(30px, 5vw, 48px);
    line-height: 1.1;
    margin: 0 0 18px;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.85), 0 2px 30px rgba(0, 0, 0, 0.65);
  }
  .lede {
    font-size: 18px;
    line-height: 1.6;
    color: #e3e4e8;
    margin: 0 auto 28px;
    max-width: 680px;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 2px 18px rgba(0, 0, 0, 0.85);
  }
  .lede a {
    color: var(--accent);
  }
  .cta {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 28px;
  }
  .install {
    display: inline-block;
    text-align: left;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 16px 20px;
    margin: 0 auto;
    font-size: 14px;
    color: var(--text);
    overflow-x: auto;
  }
  .install code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre;
  }
  section {
    position: relative;
    z-index: 1; /* sit above the brain canvas (.hero-bg, z-index 0) */
    max-width: 1000px;
    margin: 0 auto;
    padding: 40px 24px;
  }
  .foot {
    position: relative;
    z-index: 1;
  }
  section h2 {
    font-size: 26px;
    margin: 0 0 24px;
    text-align: center;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.85), 0 2px 24px rgba(0, 0, 0, 0.6);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
  }
  .card {
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 20px;
  }
  .card .ic {
    font-size: 24px;
    margin-bottom: 8px;
  }
  .card h3 {
    margin: 0 0 8px;
    font-size: 16px;
  }
  .card p {
    margin: 0;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.55;
  }
  .card :global(code),
  .note code,
  .steps code {
    background: var(--bg-3);
    border-radius: 4px;
    padding: 0 5px;
    font-size: 0.88em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .how-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 32px;
    align-items: center;
  }
  .steps {
    list-style: none;
    counter-reset: step;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .steps li {
    counter-increment: step;
    position: relative;
    padding-left: 46px;
  }
  .steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: -2px;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 9px;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    color: #aebcff;
    font-weight: 700;
    font-size: 14px;
  }
  .steps strong {
    display: block;
    font-size: 15px;
    margin-bottom: 4px;
  }
  .steps span {
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.55;
  }
  @media (max-width: 760px) {
    .how-grid {
      grid-template-columns: 1fr;
      gap: 24px;
    }
  }
  .note {
    text-align: center;
    color: #c7c8cc;
    font-size: 15px;
    line-height: 1.6;
    max-width: 720px;
    margin: 28px auto 0;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 1px 14px rgba(0, 0, 0, 0.7);
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 32px 24px 48px;
    color: var(--text-faint);
    font-size: 14px;
    border-top: 1px solid var(--line);
  }
  .foot a {
    color: var(--text-dim);
    text-decoration: none;
  }
  .foot a:hover {
    color: var(--text);
  }
  .foot .sep {
    opacity: 0.5;
  }
</style>
