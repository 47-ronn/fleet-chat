<script>
  // Self-contained file browser: search files on a host, preview images, download
  // to the browser (chunked through the relay), and move a file host→host.
  // Props: relay (connected Relay) + agents (fleet hosts).
  let { relay, agents = [] } = $props();

  let host = $state(null); // selected source host id
  let query = $state('');
  let kind = $state('name'); // 'name' | 'content' | 'image'
  let hits = $state([]);
  let busy = $state(false);
  let note = $state('');
  let thumbs = $state({}); // path -> base64 jpeg (or '' = none)
  let progress = $state({}); // path -> {pct, label}

  const hostName = (id) => agents.find((a) => a.id === id)?.name || id;

  function pickDefaultHost() {
    if (!host && agents.length) host = agents[0].id;
  }
  $effect(pickDefaultHost);

  const fmtSize = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
  };

  async function search() {
    if (!host || !query.trim() || busy) return;
    busy = true;
    note = '';
    hits = [];
    thumbs = {};
    try {
      hits = await relay.fileSearch(host, query.trim(), kind);
      if (!hits.length) note = 'Nothing found — you can ask the host AI to search.';
      loadThumbs();
    } catch (e) {
      note = 'Search error: ' + (e.message || e);
    } finally {
      busy = false;
    }
  }

  // Lazily fetch a small preview for each image hit.
  async function loadThumbs() {
    for (const h of hits) {
      if (!h.is_image || thumbs[h.path] !== undefined) continue;
      thumbs = { ...thumbs, [h.path]: '' }; // mark in-flight
      const t = await relay.fileThumb(host, h.path, 240).catch(() => null);
      thumbs = { ...thumbs, [h.path]: t?.data || '' };
    }
  }

  // Fallback: let the host's AI locate the file, then stat the paths it returns.
  async function aiFind() {
    if (!host || !query.trim() || busy) return;
    busy = true;
    note = 'Host AI is searching…';
    try {
      const prompt =
        `Find a file on this computer matching the description: "${query.trim()}". ` +
        'Output ONLY the absolute paths of the files found, one per line, with no explanations.';
      const id = await relay.taskDispatch(host, prompt);
      const out = await pollTask(host, id);
      const paths = (out || '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => /^(\/|[A-Za-z]:\\)/.test(s));
      const found = [];
      for (const p of paths) {
        const m = await relay.fileStat(host, p).catch(() => null);
        if (m) found.push(m);
      }
      hits = found;
      note = found.length ? '' : 'The AI found no matching files.';
      loadThumbs();
    } catch (e) {
      note = 'AI search error: ' + (e.message || e);
    } finally {
      busy = false;
    }
  }

  async function pollTask(h, id) {
    if (!id) return '';
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const t = await relay.taskGet(h, id).catch(() => null);
      if (!t) continue;
      if (t.status === 'done') return t.result || '';
      if (t.status === 'failed') return '';
    }
    return '';
  }

  async function download(h) {
    progress = { ...progress, [h.path]: { pct: 0, label: 'downloading…' } };
    try {
      const blob = await relay.downloadFile(host, h.path, {
        mime: h.mime,
        size: h.size,
        onProgress: (recv, total) => {
          const pct = total ? Math.round((recv / total) * 100) : 0;
          progress = { ...progress, [h.path]: { pct, label: `${pct}%` } };
        },
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = h.path.split(/[\\/]/).pop() || 'download';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      progress = { ...progress, [h.path]: { pct: 100, label: '✓ downloaded' } };
    } catch (e) {
      progress = { ...progress, [h.path]: { pct: 0, label: '⚠️ ' + (e.message || e) } };
    }
  }

  // Move a file to another host (host↔host transfer), then poll progress.
  async function moveTo(h, destId) {
    const base = h.path.split(/[\\/]/).pop() || 'file';
    const destPath = window.prompt(`Path on ${hostName(destId)}:`, '/tmp/' + base);
    if (!destPath) return;
    progress = { ...progress, [h.path]: { pct: 0, label: 'transferring…' } };
    try {
      const id = await relay.sendFileTo(host, h.path, destId, destPath);
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await relay.transferGet(host, id).catch(() => null);
        if (!st) continue;
        const pct = st.total ? Math.round((st.bytes / st.total) * 100) : 0;
        progress = { ...progress, [h.path]: { pct, label: `→ ${hostName(destId)} ${pct}%` } };
        if (st.state === 'done') {
          progress = { ...progress, [h.path]: { pct: 100, label: `✓ on ${hostName(destId)}` } };
          return;
        }
        if (st.state === 'failed') {
          progress = { ...progress, [h.path]: { pct: 0, label: '⚠️ ' + (st.error || 'error') } };
          return;
        }
      }
      progress = { ...progress, [h.path]: { pct: 0, label: '⏱️ timeout' } };
    } catch (e) {
      progress = { ...progress, [h.path]: { pct: 0, label: '⚠️ ' + (e.message || e) } };
    }
  }

  function onKey(e) {
    if (e.key === 'Enter') search();
  }
</script>

<div class="files">
  <div class="controls">
    <div class="hosts">
      {#each agents as a (a.id)}
        <button
          class="chip"
          class:on={host === a.id}
          onclick={() => (host = a.id)}
          title={a.id}
        >
          {a.autonomous ? '✨ ' : ''}{a.name}
        </button>
      {/each}
    </div>
    <div class="row">
      <input
        class="q"
        placeholder="file name, text inside, or description…"
        bind:value={query}
        onkeydown={onKey}
      />
      <select bind:value={kind} class="kind">
        <option value="name">by name</option>
        <option value="content">by content</option>
        <option value="image">photos</option>
      </select>
      <button class="go" onclick={search} disabled={busy}>Search</button>
    </div>
  </div>

  {#if note}
    <div class="note">
      {note}
      {#if !hits.length && query.trim()}
        <button class="ai" onclick={aiFind} disabled={busy}>🤖 let the AI search</button>
      {/if}
    </div>
  {/if}

  <div class="results">
    {#each hits as h (h.path)}
      <div class="card">
        <div class="preview">
          {#if h.is_image && thumbs[h.path]}
            <img src={'data:image/jpeg;base64,' + thumbs[h.path]} alt={h.path} />
          {:else}
            <div class="icon">{h.is_image ? '🖼️' : '📄'}</div>
          {/if}
        </div>
        <div class="meta">
          <div class="name" title={h.path}>{h.path.split(/[\\/]/).pop()}</div>
          <div class="sub">{fmtSize(h.size)} · {h.mime}</div>
          <div class="path">{h.path}</div>
          <div class="actions">
            <button class="act" onclick={() => download(h)}>⬇ Download</button>
            {#if agents.filter((a) => a.id !== host).length}
              <select
                class="moveto"
                onchange={(e) => {
                  if (e.target.value) moveTo(h, e.target.value);
                  e.target.value = '';
                }}
              >
                <option value="">→ transfer to…</option>
                {#each agents.filter((a) => a.id !== host) as a (a.id)}
                  <option value={a.id}>{a.name}</option>
                {/each}
              </select>
            {/if}
            {#if progress[h.path]}
              <span class="prog">{progress[h.path].label}</span>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .files {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .controls {
    padding: 12px;
    border-bottom: 1px solid #ffffff14;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hosts {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .chip {
    background: #ffffff10;
    border: 1px solid #ffffff1f;
    color: #e8e8ea;
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .chip.on {
    background: #4f7cff33;
    border-color: #4f7cff;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .q {
    flex: 1;
    background: #00000033;
    border: 1px solid #ffffff1f;
    border-radius: 8px;
    padding: 8px 10px;
    color: #fff;
    font-size: 14px;
  }
  .kind,
  .moveto {
    background: #00000033;
    border: 1px solid #ffffff1f;
    border-radius: 8px;
    color: #e8e8ea;
    padding: 6px 8px;
    font-size: 13px;
  }
  .go,
  .ai,
  .act {
    background: #4f7cff;
    border: none;
    color: #fff;
    border-radius: 8px;
    padding: 8px 14px;
    cursor: pointer;
    font-size: 14px;
  }
  .go:disabled {
    opacity: 0.5;
  }
  .ai {
    background: #6b48c8;
    margin-left: 8px;
    padding: 4px 10px;
    font-size: 13px;
  }
  .act {
    padding: 5px 10px;
    font-size: 13px;
  }
  .note {
    padding: 10px 12px;
    color: #b9b9c2;
    font-size: 14px;
  }
  .results {
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card {
    display: flex;
    gap: 12px;
    background: #ffffff08;
    border: 1px solid #ffffff14;
    border-radius: 12px;
    padding: 10px;
  }
  .preview {
    width: 72px;
    height: 72px;
    flex: none;
    border-radius: 8px;
    overflow: hidden;
    background: #00000033;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .icon {
    font-size: 32px;
  }
  .meta {
    min-width: 0;
    flex: 1;
  }
  .name {
    font-weight: 600;
    color: #fff;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: #9a9aa6;
    font-size: 12px;
    margin: 2px 0;
  }
  .path {
    color: #6f6f7a;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .prog {
    color: #b9b9c2;
    font-size: 13px;
  }
</style>
