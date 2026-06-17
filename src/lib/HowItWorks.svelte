<script>
  // "Как это работает" — a self-contained, local inline SVG diagram of the flow:
  //   AI client (MCP) → E2E-encrypted relay → agent fleet → result back.
  // Visuals are CSS-animated (flowing wires, traveling ciphertext packets, pulsing
  // lock, relay shimmer, sequential host highlight). A tiny JS loop only rotates the
  // agent/command/result labels so the content feels alive. No external assets.
  import { onMount } from 'svelte';

  const STEPS = [
    { agent: 'claude',   cmd: 'exec  git pull',      res: '✓ up to date' },
    { agent: 'opencode', cmd: 'read  config.toml',   res: '✓ 1.2 KB' },
    { agent: 'cline',    cmd: 'write deploy.sh',     res: '✓ saved +bak' },
    { agent: 'roo',      cmd: 'git   commit -am ci', res: '✓ a3f9c1e' },
    { agent: 'kilo',     cmd: 'exec  npm test',      res: '✓ 42 passed' },
    { agent: 'zed',      cmd: 'read  src/main.rs',   res: '✓ 8.4 KB' },
  ];

  let idx = $state(0);
  let host = $state(0);
  const step = $derived(STEPS[idx]);

  onMount(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const id = setInterval(() => {
      idx = (idx + 1) % STEPS.length;
      host = (idx) % 3;
    }, 3600);
    return () => clearInterval(id);
  });
</script>

<div class="diagram">
  <svg viewBox="0 0 440 500" role="img"
       aria-label="An AI client sends an encrypted command through the relay to fleet agents and gets a result; agents also transfer files host-to-host over a direct P2P UDP channel">
    <defs>
      <linearGradient id="hiw-wire" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4d6bfe" stop-opacity="0" />
        <stop offset="0.5" stop-color="#6f8bff" stop-opacity="0.95" />
        <stop offset="1" stop-color="#4d6bfe" stop-opacity="0" />
      </linearGradient>
      <filter id="hiw-glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="2.4" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </defs>

    <!-- ================= CLIENT ================= -->
    <g>
      <rect class="card" x="40" y="14" width="360" height="120" rx="14" />
      <rect class="card-hd" x="40" y="14" width="360" height="30" rx="14" />
      <rect class="card-hd" x="40" y="28" width="360" height="16" />
      <circle class="dot r" cx="58" cy="29" r="3.5" />
      <circle class="dot y" cx="72" cy="29" r="3.5" />
      <circle class="dot g" cx="86" cy="29" r="3.5" />
      <text class="hd-t" x="220" y="33" text-anchor="middle">AI CLIENT · MCP</text>
      <!-- lock -->
      <g class="lock" filter="url(#hiw-glow)">
        <rect x="368" y="22" width="16" height="13" rx="2.5" />
        <path class="lock-sh" d="M371 22 v-3 a5 5 0 0 1 10 0 v3" />
      </g>
      <!-- terminal body -->
      <text class="mono dim" x="60" y="72">$ remote-agent mcp</text>
      <text class="mono acc" x="60" y="96">▸ {step.agent}<tspan class="dim">:</tspan> {step.cmd}<tspan class="cursor"> ▋</tspan></text>
      <text class="mono faint" x="60" y="118">aes-gcm-256 · wss://relay</text>
    </g>

    <!-- wire client → relay -->
    <g>
      <line class="wire-base" x1="220" y1="134" x2="220" y2="196" />
      <line class="wire-flow" x1="220" y1="134" x2="220" y2="196" filter="url(#hiw-glow)" />
      <g class="pkt down d0"><rect x="212" y="127" width="16" height="14" rx="3" /><text x="220" y="137" text-anchor="middle">▓</text></g>
      <text class="tag" x="232" y="170">wss:// · E2E</text>
    </g>

    <!-- ================= RELAY ================= -->
    <g>
      <rect class="card" x="40" y="196" width="360" height="96" rx="14" />
      <text class="node-t" x="60" y="222">RELAY</text>
      <text class="mono faint" x="60" y="240">CF Worker · self-hosted Rust</text>
      <g class="eye"><circle class="eye-o" cx="378" cy="214" r="8.5" /><circle class="eye-p" cx="378" cy="214" r="2.6" /><line class="eye-sl" x1="370" y1="222" x2="386" y2="206" /></g>
      <text class="blind" x="358" y="219" text-anchor="end">sees ciphertext only</text>
      <rect class="cipher-box" x="60" y="252" width="320" height="26" rx="6" />
      <text class="mono cipher" x="70" y="269">9f3a··c1e2 ▒▓ a8··2b1f ▒▓ d4··e0</text>
    </g>

    <!-- wire relay → fleet -->
    <g>
      <line class="wire-base" x1="220" y1="292" x2="220" y2="352" />
      <line class="wire-flow w2" x1="220" y1="292" x2="220" y2="352" filter="url(#hiw-glow)" />
      <g class="pkt down d1"><rect x="212" y="285" width="16" height="14" rx="3" /><text x="220" y="295" text-anchor="middle">▓</text></g>
      <g class="pkt up"><rect x="211" y="346" width="18" height="13" rx="3" /><text x="220" y="356" text-anchor="middle">✓</text></g>
      <text class="tag" x="232" y="328">wss:// · E2E</text>
    </g>

    <!-- ================= FLEET ================= -->
    <g>
      <rect class="card" x="20" y="352" width="400" height="130" rx="14" />
      <text class="node-t" x="40" y="378">AGENT FLEET</text>
      <text class="mono faint" x="380" y="378" text-anchor="end">exec · read · write · git</text>
      {#each [0, 1, 2] as n}
        <g class="host" class:active={host === n} transform="translate({44 + n * 122}, 392)">
          <rect class="host-box" x="0" y="0" width="108" height="48" rx="9" />
          <circle class="host-led" cx="16" cy="16" r="4" />
          <text class="mono host-name" x="30" y="20">host-{n + 1}</text>
          <text class="mono host-st" x="14" y="38">{host === n ? step.res : 'idle'}</text>
        </g>
      {/each}
      <!-- direct host↔host P2P/UDP channel (bypasses the relay) -->
      <path class="p2p-wire" d="M98 442 Q 220 470 342 442" />
      <g class="p2p-pkt"><rect x="-8" y="-6" width="16" height="12" rx="3" /></g>
      <text class="p2p-tag" x="220" y="476" text-anchor="middle">direct UDP · P2P · hole-punch · relay fallback</text>
    </g>
  </svg>
</div>

<style>
  .diagram {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 16px;
    background:
      radial-gradient(120% 80% at 50% 0%, #1c2336 0%, #161922 70%);
    padding: 10px;
    box-shadow: 0 24px 60px -30px rgba(0, 0, 0, 0.8);
  }
  svg { width: 100%; height: auto; display: block; }

  /* cards */
  .card { fill: #1a1f2e; stroke: rgba(109, 137, 255, 0.28); stroke-width: 1.4; }
  .card-hd { fill: #222a3d; }
  .dot { opacity: 0.85; }
  .dot.r { fill: #ff5f57; }
  .dot.y { fill: #febc2e; }
  .dot.g { fill: #28c840; }

  text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .hd-t { fill: #aeb4c7; font-size: 10px; letter-spacing: 0.5px; }
  .node-t { fill: #eceeffe6; font-size: 14px; font-weight: 700; letter-spacing: 0.4px; }
  .mono { font-size: 12px; }
  .acc { fill: #8ea2ff; }
  .dim { fill: #8d93a8; }
  .faint { fill: #5d6478; font-size: 10.5px; }
  .tag { fill: #6f7da6; font-size: 9.5px; letter-spacing: 0.4px; }

  .cursor { fill: #6f8bff; animation: hiw-blink 1s steps(1) infinite; }
  @keyframes hiw-blink { 50% { opacity: 0; } }

  /* lock */
  .lock rect { fill: #2a3350; stroke: #6f8bff; stroke-width: 1.4; }
  .lock-sh { fill: none; stroke: #6f8bff; stroke-width: 1.4; }
  .lock { animation: hiw-lock 3.6s ease-in-out infinite; transform-origin: 376px 28px; }
  @keyframes hiw-lock {
    0%, 100% { opacity: 0.65; }
    45%, 60% { opacity: 1; }
  }

  /* wires */
  .wire-base { stroke: rgba(109, 137, 255, 0.3); stroke-width: 2; }
  .wire-flow {
    stroke: url(#hiw-wire); stroke-width: 2.4;
    stroke-dasharray: 14 46; stroke-linecap: round;
    animation: hiw-dash 1.4s linear infinite;
  }
  .wire-flow.w2 { animation-delay: 0.5s; }
  @keyframes hiw-dash { to { stroke-dashoffset: -60; } }

  /* packets travelling the wires */
  .pkt rect { fill: #4d6bfe; }
  .pkt text { fill: #0b1020; font-size: 9px; font-weight: 700; }
  .pkt.up rect { fill: #3ddc97; }
  .pkt { filter: url(#hiw-glow); }
  .pkt.down.d0 { animation: hiw-down 3.6s cubic-bezier(.6,0,.4,1) infinite; }
  .pkt.down.d1 { animation: hiw-down 3.6s cubic-bezier(.6,0,.4,1) infinite; animation-delay: 0.45s; }
  .pkt.up      { animation: hiw-up 3.6s ease-in-out infinite; animation-delay: 2.2s; }
  @keyframes hiw-down {
    0% { transform: translateY(0); opacity: 0; }
    8% { opacity: 1; }
    34% { transform: translateY(60px); opacity: 1; }
    42%, 100% { transform: translateY(60px); opacity: 0; }
  }
  @keyframes hiw-up {
    0% { transform: translateY(0); opacity: 0; }
    10% { opacity: 1; }
    40% { transform: translateY(-60px); opacity: 1; }
    50%, 100% { transform: translateY(-60px); opacity: 0; }
  }

  /* relay "blind" cipher */
  .eye-o { fill: none; stroke: #f0b24d; stroke-width: 1.5; }
  .eye-p { fill: #f0b24d; }
  .eye-sl { stroke: #f0b24d; stroke-width: 1.6; stroke-linecap: round; }
  .cipher-box { fill: rgba(240, 178, 77, 0.06); stroke: rgba(240, 178, 77, 0.28); }
  .cipher { fill: #c9a25a; font-size: 11px; letter-spacing: 1px; animation: hiw-shimmer 2.4s ease-in-out infinite; }
  .blind { fill: #b8863a; font-size: 9.5px; }
  @keyframes hiw-shimmer { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

  /* fleet hosts */
  .host-box { fill: #161b29; stroke: rgba(255, 255, 255, 0.08); stroke-width: 1.2; transition: stroke 0.3s, fill 0.3s; }
  .host-led { fill: #3a4256; transition: fill 0.3s; }
  .host-name { fill: #9aa0b4; }
  .host-st { fill: #5d6478; font-size: 10px; }
  .host.active .host-box { fill: #16241f; stroke: #3ddc97; }
  .host.active .host-led { fill: #3ddc97; animation: hiw-pulse 0.9s ease-in-out infinite; }
  .host.active .host-st { fill: #3ddc97; }
  .host.active .host-name { fill: #e6f4ee; }
  @keyframes hiw-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  /* direct host↔host P2P/UDP channel */
  .p2p-wire {
    fill: none; stroke: rgba(61, 220, 151, 0.6); stroke-width: 1.8;
    stroke-dasharray: 7 7; animation: hiw-dash2 0.9s linear infinite;
  }
  @keyframes hiw-dash2 { to { stroke-dashoffset: -14; } }
  .p2p-pkt rect { fill: #3ddc97; }
  .p2p-pkt {
    filter: url(#hiw-glow);
    offset-path: path('M98 442 Q 220 470 342 442');
    offset-rotate: 0deg;
    animation: hiw-arc 2.8s ease-in-out infinite;
  }
  @keyframes hiw-arc {
    0% { offset-distance: 0%; opacity: 0; }
    10% { opacity: 1; }
    50% { offset-distance: 100%; opacity: 1; }
    60%, 100% { offset-distance: 100%; opacity: 0; }
  }
  .p2p-tag { fill: #7fbfa3; font-size: 9px; letter-spacing: 0.3px; }

  @media (prefers-reduced-motion: reduce) {
    .wire-flow, .pkt, .cipher, .lock, .cursor,
    .p2p-wire, .p2p-pkt, .host.active .host-led { animation: none; }
    .pkt, .p2p-pkt { opacity: 0; }
  }
</style>
