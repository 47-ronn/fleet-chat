<script module>
  // Fleet task-dependency graph.
  //
  // Nodes = fleet agents (+ a virtual "browser" node for web-initiated tasks),
  // edges = autonomous tasks aggregated per (initiator → executor host).
  // Roles read straight off the graph:
  //   consumer  — the initiator of a task (orders the work, consumes the result)
  //   executor  — the host that runs the task
  //   sub-agent — a node that only appears downstream of another agent
  //               (received a task dispatched while the executor was running)
</script>

<script>
  // Props (Svelte 5 runes):
  //  agents — AgentInfo[] currently in the room
  //  fleets — [{host, hostName, tasks: AutonomousTask[]}] per executor host
  let { agents = [], fleets = [] } = $props();

  const NODE_W = 158;
  const NODE_H = 46;
  const GAP_X = 34;
  const GAP_Y = 96;
  const PAD = 24;

  const BROWSER = 'browser';

  // Aggregate edges: initiator -> executor host, with the task list per edge.
  const edges = $derived.by(() => {
    const m = new Map(); // "from\u0000to" -> {from, to, tasks: []}
    for (const f of fleets || []) {
      for (const t of f.tasks || []) {
        const from = t.initiator || BROWSER;
        const key = `${from}\u0000${f.host}`;
        if (!m.has(key)) m.set(key, { from, to: f.host, tasks: [] });
        m.get(key).tasks.push(t);
      }
    }
    for (const e of m.values()) e.tasks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return [...m.values()];
  });

  // All involved node ids: agents with tasks (either side) + everyone else in
  // the room, so idle hosts still show up.
  const nodes = $derived.by(() => {
    const involved = new Set([BROWSER]);
    for (const e of edges) {
      involved.add(e.from);
      involved.add(e.to);
    }
    for (const a of agents) involved.add(a.id);
    const info = new Map(agents.map((a) => [a.id, a]));
    return [...involved].map((id) => {
      const a = info.get(id);
      return {
        id,
        name: id === BROWSER ? '🌐 browser' : a?.name || id,
        os: a?.os || (id === BROWSER ? 'web' : ''),
        autonomous: !!a?.autonomous,
        online: !!a,
        // tasks this node EXECUTES (incoming edges)
        executing: edges.filter((e) => e.to === id).reduce((n, e) => n + e.tasks.length, 0),
        // tasks this node ORDERED (outgoing edges) — the consumer side
        ordered: edges.filter((e) => e.from === id).reduce((n, e) => n + e.tasks.length, 0),
      };
    });
  });

  // Rank layout: sources on top, longest-path ranking (cycle-safe via capped
  // iterations). Rows are centered horizontally.
  const layout = $derived.by(() => {
    const ns = nodes;
    const ids = ns.map((n) => n.id);
    const idset = new Set(ids);
    const inc = new Map(ids.map((i) => [i, []])); // to -> [from]
    const out = new Map(ids.map((i) => [i, []])); // from -> [to]
    for (const e of edges) {
      if (!idset.has(e.from) || !idset.has(e.to) || e.from === e.to) continue;
      out.get(e.from).push(e.to);
      inc.get(e.to).push(e.from);
    }
    const rank = new Map(ids.map((i) => [i, 0]));
    for (let iter = 0; iter < ids.length + 1; iter++) {
      let changed = false;
      for (const id of ids) {
        let r = 0;
        for (const p of inc.get(id)) r = Math.max(r, (rank.get(p) ?? 0) + 1);
        if (r !== rank.get(id)) {
          rank.set(id, r);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const byRank = new Map();
    for (const id of ids) {
      const r = rank.get(id) ?? 0;
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(id);
    }
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    const pos = new Map();
    const width = Math.max(...ranks.map((r) => byRank.get(r).length));
    for (const r of ranks) {
      const row = byRank.get(r).sort((a, b) => {
        const na = ns.find((n) => n.id === a)?.name || a;
        const nb = ns.find((n) => n.id === b)?.name || b;
        return na.localeCompare(nb);
      });
      const rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
      row.forEach((id, i) => {
        pos.set(id, {
          x: PAD + (width * (NODE_W + GAP_X) - GAP_X - rowW) / 2 + i * (NODE_W + GAP_X),
          y: PAD + r * (NODE_H + GAP_Y),
        });
      });
    }
    const H = PAD * 2 + ranks.length * (NODE_H + GAP_Y) - GAP_Y;
    const W = PAD * 2 + width * (NODE_W + GAP_X) - GAP_X;
    return { pos, W, H, rank };
  });

  // Selection: highlight the node's neighbourhood, list its tasks with roles.
  let sel = $state(null); // agent id | BROWSER | null
  const selNode = $derived(nodes.find((n) => n.id === sel) || null);

  function edgeBadge(tasks) {
    const c = { done: 0, running: 0, queued: 0, failed: 0 };
    for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
    const parts = [];
    if (c.running) parts.push(`⟳${c.running}`);
    if (c.queued) parts.push(`…${c.queued}`);
    if (c.done) parts.push(`✓${c.done}`);
    if (c.failed) parts.push(`✗${c.failed}`);
    return parts.join(' ') || '0';
  }

  function edgeColor(tasks, dimmed) {
    if (dimmed) return '#ffffff22';
    const c = tasks.map((t) => t.status);
    if (c.includes('running')) return '#e0a23a';
    if (c.includes('failed')) return '#b3323b';
    if (c.includes('queued')) return '#4d6bfe';
    return '#3f8f5f';
  }

  function fmtTs(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d
      .getDate()
      .toString()
      .padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d
      .getMinutes()
      .toString()
      .padStart(2, '0')}`;
  }

  // Tasks of the selected node, split by its role in each.
  const selTasks = $derived.by(() => {
    if (!sel) return { executing: [], ordered: [] };
    const executing = [];
    for (const f of fleets) {
      if (f.host !== sel) continue;
      for (const t of f.tasks) executing.push({ ...t, hostName: f.hostName, role: 'executor' });
    }
    const ordered = [];
    for (const f of fleets) {
      for (const t of f.tasks) {
        if ((t.initiator || BROWSER) === sel && f.host !== sel) {
          ordered.push({ ...t, hostName: f.hostName, role: 'consumer' });
        }
      }
    }
    const byTime = (a, b) => (b.created_at || 0) - (a.created_at || 0);
    return {
      executing: executing.sort(byTime).slice(0, 40),
      ordered: ordered.sort(byTime).slice(0, 40),
    };
  });

  // Is a node a pure sub-agent (never orders anything, only executes for peers)?
  function isSubAgent(n) {
    return n.executing > 0 && n.ordered === 0 && n.id !== BROWSER;
  }
</script>

<div class="graph-wrap">
  <div class="legend">
    <span class="lg"><i class="dot" style="background:#e0a23a"></i>running</span>
    <span class="lg"><i class="dot" style="background:#4d6bfe"></i>queued</span>
    <span class="lg"><i class="dot" style="background:#3f8f5f"></i>done</span>
    <span class="lg"><i class="dot" style="background:#b3323b"></i>failed</span>
    <span class="lg">arrow: consumer → executor (its sub-agent)</span>
    <span class="lg">click a node for its tasks &amp; roles</span>
  </div>

  <div class="graph-scroll">
    <svg width={layout.W} height={layout.H} role="img" aria-label="Fleet dependency graph">
      {#each edges as e (e.from + '>' + e.to)}
        {@const p1 = layout.pos.get(e.from)}
        {@const p2 = layout.pos.get(e.to)}
        {@const dim = sel && e.from !== sel && e.to !== sel}
        {#if p1 && p2}
          {@const x1 = p1.x + NODE_W / 2}
          {@const y1 = p1.y + NODE_H}
          {@const x2 = p2.x + NODE_W / 2}
          {@const y2 = p2.y}
          {@const mx = (x1 + x2) / 2}
          {@const my = (y1 + y2) / 2}
          <path
            d="M {x1} {y1} C {x1} {y1 + 40}, {x2} {y2 - 40}, {x2} {y2}"
            fill="none"
            stroke={edgeColor(e.tasks, dim)}
            stroke-width={dim ? 1 : 2}
            stroke-opacity={dim ? 0.5 : 1}
          />
          <circle cx={x2} cy={y2} r="3" fill={edgeColor(e.tasks, dim)} />
          <text
            x={mx}
            y={my}
            text-anchor="middle"
            class="edge-label"
            fill={dim ? '#ffffff44' : '#cdd7ff'}
          >{edgeBadge(e.tasks)}</text>
        {/if}
      {/each}

      {#each nodes as n (n.id)}
        {@const p = layout.pos.get(n.id)}
        {#if p}
          {@const active = sel === n.id}
          {@const near = sel && edges.some(
            (e) => (e.from === sel && e.to === n.id) || (e.to === sel && e.from === n.id)
          )}
          <g
            class="node"
            class:dim={sel && !active && !near}
            class:active
            onclick={() => (sel = active ? null : n.id)}
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && (sel = active ? null : n.id)}
          >
            <rect
              x={p.x}
              y={p.y}
              width={NODE_W}
              height={NODE_H}
              rx="10"
              class="node-box"
              class:offline={!n.online && n.id !== BROWSER}
            />
            <text x={p.x + 10} y={p.y + 19} class="node-name">
              {#if n.autonomous}✨{/if}{n.name}
            </text>
            <text x={p.x + 10} y={p.y + 36} class="node-meta">
              {#if isSubAgent(n)}sub-agent · ⚙{n.executing}{:else}{#if n.ordered}🧭{n.ordered} · {/if}{#if n.executing}⚙{n.executing}{/if}{/if}
            </text>
          </g>
        {/if}
      {/each}
    </svg>
  </div>

  {#if selNode}
    <aside class="tasks">
      <header>
        <strong>{selNode.name}</strong>
        <span class="muted">
          {selNode.id === BROWSER
            ? 'you from the web panel'
            : isSubAgent(selNode)
              ? 'sub-agent — executes tasks ordered by peers'
              : selNode.executing && selNode.ordered
                ? 'both executor and consumer'
                : selNode.ordered
                  ? 'consumer — orders tasks on other hosts'
                  : 'executor — runs tasks for peers'}
        </span>
        <button class="ghost" onclick={() => (sel = null)}>✕</button>
      </header>

      {#if selTasks.executing.length}
        <div class="role-title">⚙ Executes (this host is the executor)</div>
        {#each selTasks.executing as t (t.id)}
          <div class="task">
            <span class="st {t.status}">{t.status}</span>
            <span class="task-prompt" title={t.prompt}>{t.prompt || t.id}</span>
            <span class="task-ts">{fmtTs(t.created_at)}</span>
          </div>
        {/each}
      {/if}

      {#if selTasks.ordered.length}
        <div class="role-title">🧭 Ordered on peers (this node is the consumer)</div>
        {#each selTasks.ordered as t (t.id)}
          <div class="task">
            <span class="st {t.status}">{t.status}</span>
            <span class="task-prompt" title={t.prompt}>→ {t.hostName}: {t.prompt || t.id}</span>
            <span class="task-ts">{fmtTs(t.created_at)}</span>
          </div>
        {/each}
      {/if}

      {#if !selTasks.executing.length && !selTasks.ordered.length}
        <div class="muted">No tasks on record for this node.</div>
      {/if}
    </aside>
  {/if}
</div>

<style>
  .graph-wrap {
    display: flex;
    flex: 1;
    min-height: 0;
    gap: 12px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    color: var(--text-dim);
  }
  .graph-wrap :global(.graph-scroll) {
    flex: 1;
    overflow: auto;
    min-width: 0;
  }
  .node {
    cursor: pointer;
  }
  .node-box {
    fill: var(--bg-3, #1d1d27);
    stroke: var(--line, #ffffff1f);
    stroke-width: 1;
  }
  .node:hover .node-box {
    stroke: var(--accent, #4d6bfe);
  }
  .node.active .node-box {
    stroke: var(--accent, #4d6bfe);
    stroke-width: 2;
  }
  .node.dim {
    opacity: 0.45;
  }
  .node.offline .node-box {
    stroke-dasharray: 4 3;
  }
  .node-name {
    fill: var(--text, #ececf1);
    font-size: 13px;
    font-weight: 600;
  }
  .node-meta {
    fill: var(--text-faint, #9a9aa6);
    font-size: 11px;
  }
  .edge-label {
    font-size: 10px;
    paint-order: stroke;
    stroke: #000000aa;
    stroke-width: 3px;
  }
  .tasks {
    width: 320px;
    flex: none;
    border-left: 1px solid var(--line);
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .tasks header {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .tasks header strong {
    font-size: 14px;
  }
  .tasks .muted {
    flex: 1;
    font-size: 11px;
    color: var(--text-faint);
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--text-dim);
    cursor: pointer;
    padding: 2px 8px;
    font-size: 12px;
  }
  .role-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-faint);
    margin: 8px 0 2px;
  }
  .task {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 12px;
  }
  .st {
    flex: none;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 6px;
    border: 1px solid var(--line);
  }
  .st.done { color: #6fcf8e; }
  .st.running { color: #e0a23a; }
  .st.queued { color: #7d8fff; }
  .st.failed { color: #ff7a7a; }
  .task-prompt {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .task-ts {
    flex: none;
    font-size: 10px;
    color: var(--text-faint);
  }
</style>
