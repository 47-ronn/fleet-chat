<script>
  import { Relay } from './lib/relay.js';
  import Auth from './lib/Auth.svelte';
  import Files from './lib/Files.svelte';
  import { storeCreds, clearCreds } from './lib/creds.js';

  let relay = $state(null);
  let showFiles = $state(false); // file-browser overlay visibility
  let showSettings = $state(false); // credentials/settings overlay
  // Current connection credentials (for the settings form). The PIN is kept in
  // memory only for re-encrypting on a settings change — never persisted.
  let creds = $state({ relayUrl: '', room: '', token: '' });
  let sessionPin = null;
  let authed = $state(false);
  let agents = $state([]); // fleet hosts (AgentInfo[])
  // Provider sessions: {key, host, hostName, provider, id, title, updated, cwd, live}
  let dialogs = $state([]);
  // Hosts whose history couldn't be read this refresh: {hostName, error}
  let hostErrors = $state([]);
  // In-progress work: {host, hostName, kind:'task'|'cron', label, detail}
  let inProgress = $state([]);
  let active = $state(null); // selected dialog key, or null = new chat
  let selected = $state(new Set()); // agent ids addressed in the composer
  let input = $state('');
  let sending = $state(false);
  let loading = $state(false);
  let transcript = $state([]); // lazily-loaded messages of the active dialog
  let loadingTranscript = $state(false);
  let transcriptError = $state(null);
  let composerEl = $state(null); // <textarea> ref for auto-grow
  let messagesEl = $state(null); // scroll container, kept pinned to the bottom
  let sidebarOpen = $state(false); // mobile-only: dialog drawer visibility
  // A freshly-started chat that has no provider session yet — owns the
  // transcript locally until the host materializes the session.
  let pendingChat = $state(null); // {host, hostName} | null

  // Pinned dialogs (client-side only — the fleet protocol has no pin flag).
  // Persisted per-room so different rooms keep separate pins.
  let room = $state('');
  let pinned = $state(new Set());

  function pinStoreKey() {
    return `fleet-chat:pinned:${room}`;
  }
  function loadPinned() {
    try {
      pinned = new Set(JSON.parse(localStorage.getItem(pinStoreKey()) || '[]'));
    } catch {
      pinned = new Set();
    }
  }
  function togglePin(key, e) {
    e?.stopPropagation();
    const next = new Set(pinned);
    next.has(key) ? next.delete(key) : next.add(key);
    pinned = next;
    try {
      localStorage.setItem(pinStoreKey(), JSON.stringify([...next]));
    } catch {}
  }

  // Pinned first, then by recency (the order refreshFleet already applies).
  const sortedDialogs = $derived(
    [...dialogs].sort(
      (a, b) => (pinned.has(b.key) ? 1 : 0) - (pinned.has(a.key) ? 1 : 0)
    )
  );

  // Grow the composer to fit its content (capped by CSS max-height). Re-runs
  // whenever `input` changes — including the programmatic clear after send.
  $effect(() => {
    input;
    if (!composerEl) return;
    composerEl.style.height = 'auto';
    composerEl.style.height = Math.min(composerEl.scrollHeight, 180) + 'px';
  });

  // Keep the transcript pinned to the latest message (also when the "typing…"
  // bubble appears/disappears).
  $effect(() => {
    transcript;
    sending;
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  const executors = $derived(agents.filter((a) => a.accepts_commands !== false));
  // Hosts that can actually run an AI task (auto-detected provider). Only these
  // can answer a chat message.
  const aiHosts = $derived(executors.filter((a) => a.autonomous));

  async function onConnect({ relayUrl, room: roomName, token, pin }) {
    const r = new Relay(relayUrl, roomName, token);
    r.onAgentChange = onAgentChange;
    r.onEvent = () => scheduleRefresh(); // task_completed etc. → reconcile
    await r.connect(); // throws on bad creds → nothing is stored below
    relay = r;
    room = roomName;
    creds = { relayUrl, room: roomName, token };
    // Persist (encrypted with the PIN) only after a successful connect, so a
    // wrong token never gets remembered. Refreshes the 180-day expiry each login.
    if (pin) {
      sessionPin = pin;
      await storeCreds(pin, creds);
    }
    loadPinned();
    authed = true;
    await refreshFleet();
    clearInterval(pollTimer);
    pollTimer = setInterval(pollFleet, 5000);
  }

  // Apply edited credentials from the settings panel: reconnect, then re-encrypt
  // the cookie with the (possibly new) PIN. `newPin` empty → keep the current one.
  async function applySettings({ relayUrl, room: roomName, token, newPin }) {
    clearInterval(pollTimer);
    pollTimer = null;
    relay?.close();
    relay = null;
    const r = new Relay(relayUrl, roomName, token);
    r.onAgentChange = onAgentChange;
    r.onEvent = () => scheduleRefresh();
    await r.connect();
    relay = r;
    room = roomName;
    creds = { relayUrl, room: roomName, token };
    const pin = newPin || sessionPin;
    sessionPin = pin;
    if (pin) await storeCreds(pin, creds);
    loadedKey = null;
    await refreshFleet();
    pollTimer = setInterval(pollFleet, 5000);
  }

  // Forget the saved cookie entirely and return to the full setup form.
  function forgetCreds() {
    clearCreds();
    sessionPin = null;
    showSettings = false;
    logout();
  }

  // --- settings panel ---
  let setRelay = $state('');
  let setRoom = $state('');
  let setToken = $state('');
  let setNewPin = $state('');
  let setBusy = $state(false);
  let setErr = $state('');

  function openSettings() {
    setRelay = creds.relayUrl;
    setRoom = creds.room;
    setToken = creds.token;
    setNewPin = '';
    setErr = '';
    showSettings = true;
  }

  async function saveSettings(e) {
    e.preventDefault();
    setErr = '';
    setBusy = true;
    try {
      await applySettings({
        relayUrl: setRelay,
        room: setRoom,
        token: setToken,
        newPin: setNewPin,
      });
      showSettings = false;
    } catch (err) {
      setErr = err.message || String(err);
    } finally {
      setBusy = false;
    }
  }

  // Pull the fleet's hosts, every provider session (history), and in-progress work.
  // `silent` skips the loading indicator (used by the background poll); concurrent
  // calls coalesce onto the in-flight refresh so a 5s poll can't stack up.
  let refreshInflight = null;
  function refreshFleet({ silent = false } = {}) {
    if (refreshInflight) return refreshInflight;
    refreshInflight = (async () => {
      if (!silent) loading = true;
      try {
      agents = await relay.listAgents();
      const dl = [];
      const ip = [];
      const he = [];
      // Warn about machines with several live connections under one agent-id:
      // a wrong-keyed/stale socket among them can hijack routing (key mismatch).
      for (const a of agents) {
        if ((a.connections ?? 1) > 1) {
          he.push({
            hostName: a.name,
            error: `${a.connections} connections under one agent-id — close the extra sessions (possible key/version conflict)`,
          });
        }
      }
      // Only executor peers have local history / a task DB.
      for (const a of agents.filter((x) => x.accepts_commands !== false)) {
        try {
          const { sessions, active: live } = await relay.sessionList(a.id);
          const liveSet = new Set(live);
          for (const s of sessions) {
            dl.push({
              key: `${a.id}:${s.provider}:${s.id}`,
              host: a.id,
              hostName: a.name,
              provider: s.provider,
              id: s.id,
              title: s.title || s.id,
              updated: s.updated || 0,
              cwd: s.cwd,
              live: liveSet.has(s.id),
              // VS Code agents (cline/roo/kilo) have no headless resume → the
              // panel shows their history read-only. Defaults true (legacy).
              resumable: s.resumable !== false,
            });
          }
        } catch (e) {
          // Surface the failure instead of hiding it: a decryption/key error
          // means this host runs on a different token/key (or a stale socket
          // shares its agent-id) — otherwise the user just sees "no history".
          const msg = String(e?.message || e);
          if (!/timed out/i.test(msg)) he.push({ hostName: a.name, error: msg });
        }
        try {
          for (const t of await relay.taskList(a.id)) {
            if (t.status === 'running') {
              ip.push({ host: a.id, hostName: a.name, kind: 'task', label: (t.prompt || t.id).slice(0, 60), detail: 'running' });
            }
          }
        } catch {}
        try {
          for (const c of await relay.scheduleList(a.id)) {
            ip.push({ host: a.id, hostName: a.name, kind: 'cron', label: c.name, detail: c.cron });
          }
        } catch {}
      }
      dl.sort((x, y) => (y.updated || 0) - (x.updated || 0));
      dialogs = dl;
      inProgress = ip;
      hostErrors = he;
      } finally {
        if (!silent) loading = false;
        refreshInflight = null;
      }
    })();
    return refreshInflight;
  }

  // --- Live reactivity ------------------------------------------------------
  // The relay pushes agent_joined/left/mode and task events; we also poll for
  // session liveness (a `claude --resume` starting/stopping on a host isn't
  // pushed). Both keep the host chips, dialog list, and the open transcript in
  // sync without a manual refresh.
  let pollTimer = null;
  let refreshDebounce = null;

  function scheduleRefresh() {
    clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => refreshFleet({ silent: true }), 400);
  }

  function onAgentChange(ch) {
    // Update the chips instantly from the pushed event, then reconcile the rest
    // (dialogs, connection counts) on the debounced refresh.
    if (ch.kind === 'joined' && ch.agent) {
      agents = [...agents.filter((a) => a.id !== ch.agent.id), ch.agent];
    } else if (ch.kind === 'left') {
      agents = agents.filter((a) => a.id !== ch.id);
    } else if (ch.kind === 'mode') {
      agents = agents.map((a) => (a.id === ch.id ? { ...a, mode: ch.mode } : a));
    }
    scheduleRefresh();
  }

  async function pollFleet() {
    if (!relay || !authed) return;
    await refreshFleet({ silent: true });
    // A live session is being driven on the host — pull any new turns so the
    // open chat updates as the user writes to it there.
    const d = activeDialog;
    if (d && d.live && !pendingChat) loadTranscript(d, { force: true });
  }

  const activeDialog = $derived(dialogs.find((d) => d.key === active) || null);

  // Which dialog's transcript is currently shown — so a background refresh that
  // rebuilds `dialogs` (new object, same key) doesn't re-fetch it every poll.
  let loadedKey = null;

  // Fetch a dialog's transcript. `force` reloads in place (no spinner/clear),
  // used by the poll to pull new turns of a live session.
  async function loadTranscript(d, { force = false } = {}) {
    if (!d || !relay) return;
    if (!force && d.key === loadedKey) return; // already loaded this dialog
    loadedKey = d.key;
    const key = d.key;
    if (!force) {
      loadingTranscript = true;
      transcriptError = null;
      transcript = [];
    }
    try {
      const msgs = await relay.sessionGet(d.host, d.provider, d.id);
      if (active === key) {
        transcript = msgs;
        transcriptError = null;
      }
    } catch (e) {
      // Surface the failure instead of leaving the pane blank (which read as
      // "clicking does nothing"); a background reload keeps the old transcript.
      if (active === key && !force) transcriptError = String(e?.message || e);
    } finally {
      if (active === key && !force) loadingTranscript = false;
    }
  }

  // Load (once) when a dialog is opened. Reading activeDialog tracks selection;
  // the loadedKey guard inside makes repeated runs (from refreshes) cheap.
  $effect(() => {
    const d = activeDialog;
    if (pendingChat) return; // a fresh chat owns its transcript locally
    if (!d || !relay) {
      transcript = [];
      loadedKey = null;
      return;
    }
    loadTranscript(d);
  });

  function newChat() {
    active = null;
    pendingChat = null;
    input = '';
    sidebarOpen = false;
  }

  function openDialog(d) {
    active = d.key;
    pendingChat = null;
    sidebarOpen = false;
  }

  // Toggle a host in the composer; selecting inserts an @tag into the text so
  // the answering host's AI knows which peers to delegate sub-tasks to.
  function toggleHost(a) {
    const next = new Set(selected);
    if (next.has(a.id)) {
      next.delete(a.id);
      input = input.replace(new RegExp(`@${escapeRe(a.name)}\\s?`), '');
    } else {
      next.add(a.id);
      input = (input.trim() + ` @${a.name} `).trimStart();
    }
    selected = next;
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // The AI host that answers this turn — must be AI-capable (autonomous). The
  // active dialog's owner if it still qualifies, else a selected AI host, else
  // the first AI host in the fleet. @-tagged non-AI hosts stay delegation
  // targets, not answerers.
  function answeringHost() {
    if (activeDialog && aiHosts.some((a) => a.id === activeDialog.host)) {
      return activeDialog.host;
    }
    const sel = aiHosts.find((a) => selected.has(a.id));
    if (sel) return sel.id;
    return aiHosts[0]?.id || null;
  }

  // Composer is locked when the open dialog can't be continued from web: a live
  // session (a human drives it on the host) or a view-only VS Code agent
  // (cline/roo/kilo — no headless resume).
  const composerLocked = $derived(
    !!activeDialog && (activeDialog.live || activeDialog.resumable === false)
  );
  const canSend = $derived(activeDialog ? !composerLocked : aiHosts.length > 0);

  async function send() {
    const text = input.trim();
    if (!text || sending || composerLocked) return;
    sending = true;
    try {
      if (activeDialog) {
        // Continue an existing provider session on the host that owns it.
        const d = activeDialog;
        transcript = [...transcript, { role: 'user', text }];
        input = '';
        const taskId = await relay.sessionResume(d.host, d.provider, d.id, text);
        const reply = await pollTask(d.host, taskId);
        if (reply != null) transcript = [...transcript, { role: 'assistant', text: reply, host: d.host }];
      } else {
        // New chat → dispatch to an AI host. Show the message + a typing
        // indicator locally while the host runs the task, then adopt the
        // provider session it creates.
        const host = answeringHost();
        if (!host) {
          alert('No host in the fleet has an AI provider ✨. Start a node where claude/opencode is available.');
          return;
        }
        const msg = text;
        input = '';
        selected = new Set();
        const hostName = aiHosts.find((a) => a.id === host)?.name || host;
        const before = new Set(dialogs.map((d) => d.key));
        pendingChat = { host, hostName };
        transcript = [{ role: 'user', text: msg }];
        const taskId = await relay.taskDispatch(host, msg);
        const reply = await pollTask(host, taskId);
        if (reply != null) transcript = [...transcript, { role: 'assistant', text: reply, host }];
        // Adopt the newly-created provider session so the NEXT message resumes
        // it (conversation context). The host drops its session-list cache on
        // task finish, so it appears quickly; retry a few times for scan lag.
        let fresh = null;
        for (let i = 0; i < 4 && !fresh; i++) {
          await refreshFleet();
          fresh = dialogs.find((d) => d.host === host && !before.has(d.key));
          if (!fresh) await new Promise((r) => setTimeout(r, 1200));
        }
        if (fresh) {
          active = fresh.key; // subsequent send() goes through sessionResume
          pendingChat = null;
        }
        // else: session not surfaced yet — keep the local transcript; the next
        // refresh will adopt it under "Dialogs".
      }
    } catch (err) {
      alert('Failed to send: ' + (err.message || err));
    } finally {
      sending = false;
    }
  }

  // Poll a host for an autonomous task result; returns the reply text.
  async function pollTask(host, id) {
    if (!id) return null;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      let task;
      try {
        task = await relay.taskGet(host, id);
      } catch {
        continue;
      }
      if (!task) continue;
      if (task.status === 'done') return task.result || '';
      if (task.status === 'failed') return '⚠️ ' + (task.error || 'error');
    }
    return '⏱️ timed out waiting for a reply';
  }

  // --- Inline images in chat -------------------------------------------------
  // An assistant reply often names a local image path (e.g. a screenshot it
  // found). Render those inline as thumbnails fetched from the answering host
  // (binary-safe), so the picture shows up in chat without the AI having to
  // "send" it. Click a thumbnail to download the original.
  let chatImgs = $state({}); // "host:path" -> { loading } | { thumb } | { error }

  const IMG_RE =
    /`([^`\n]+\.(?:png|jpe?g|gif|webp|bmp))`|(\/[^\n`]*?\.(?:png|jpe?g|gif|webp|bmp))/gi;
  function imagePaths(text) {
    if (!text) return [];
    const out = new Set();
    for (const m of text.matchAll(IMG_RE)) out.add((m[1] || m[2]).trim());
    return [...out];
  }
  // The host whose filesystem a transcript message refers to.
  function msgHost(m) {
    return m.host || activeDialog?.host || pendingChat?.host || null;
  }

  async function loadChatThumb(host, path) {
    const key = `${host}:${path}`;
    if (!host || chatImgs[key]) return;
    chatImgs = { ...chatImgs, [key]: { loading: true } };
    try {
      const t = await relay.fileThumb(host, path, 480);
      chatImgs = {
        ...chatImgs,
        [key]: t ? { thumb: 'data:image/jpeg;base64,' + t.data } : { error: 'not an image' },
      };
    } catch (e) {
      chatImgs = { ...chatImgs, [key]: { error: e.message || 'failed to load' } };
    }
  }
  // Svelte action: fetch the thumbnail as soon as the image element mounts.
  function imgload(_node, [host, path]) {
    loadChatThumb(host, path);
  }

  async function downloadChatImage(host, path) {
    try {
      const meta = await relay.fileStat(host, path);
      const blob = await relay.downloadFile(host, path, { mime: meta?.mime, size: meta?.size });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = path.split(/[\\/]/).pop() || 'image';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      alert('Failed to download: ' + (e.message || e));
    }
  }

  async function terminateSession(d) {
    if (!confirm(`End the active session on ${d.hostName}?`)) return;
    try {
      await relay.sessionTerminate(d.host, d.id);
      await refreshFleet();
    } catch (err) {
      alert('Failed to end session: ' + (err.message || err));
    }
  }

  function onComposerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function logout() {
    clearInterval(pollTimer);
    pollTimer = null;
    clearTimeout(refreshDebounce);
    relay?.close();
    relay = null;
    authed = false;
    dialogs = [];
    inProgress = [];
    agents = [];
    active = null;
    pendingChat = null;
    transcript = [];
    loadedKey = null;
    // Keep the encrypted cookie so the next visit only needs the PIN; just drop
    // the in-memory PIN. Use "Forget" in settings to remove the cookie.
    sessionPin = null;
  }
</script>

{#if !authed}
  <Auth onConnect={onConnect} />
{:else}
  <div class="main">
    <!-- Chat pane (left) -->
    <section class="chat">
      <header class="bar">
        <div class="bar-left">
          <strong>{activeDialog ? activeDialog.title : 'New chat'}</strong>
          <span class="hosts-count">
            {#if activeDialog}
              {activeDialog.provider} · {activeDialog.hostName}
              {#if activeDialog.cwd} · {activeDialog.cwd}{/if}
              {#if activeDialog.live} · <span class="live-tag">🟢 live on host</span>{/if}
              {#if !activeDialog.live && activeDialog.resumable === false} · <span class="live-tag">👁 view only</span>{/if}
            {:else if pendingChat}
              sent to {pendingChat.hostName} · waiting for a reply…
            {:else}
              {executors.length} host(s) · {aiHosts.length} with AI ✨ · {selected.size} selected
            {/if}
          </span>
        </div>
        {#if activeDialog && activeDialog.live}
          <button class="ghost danger" onclick={() => terminateSession(activeDialog)}>End session</button>
        {/if}
        <a class="ghost" href="#/" title="Home">← Home</a>
        <button class="ghost" onclick={() => (showFiles = true)}>📁 Files</button>
        <button class="ghost" onclick={openSettings} title="Settings">⚙️</button>
        <button class="ghost" onclick={logout}>Log out</button>
        <button
          class="ghost menu-toggle"
          aria-label="Chat list"
          onclick={() => (sidebarOpen = !sidebarOpen)}
        >☰</button>
      </header>

      <!-- Host selector chips -->
      <div class="hosts">
        {#each agents as a}
          <button
            class="chip"
            class:on={selected.has(a.id)}
            class:sendonly={a.accepts_commands === false}
            class:ai={a.autonomous}
            title={a.accepts_commands === false
              ? 'send-only (does not execute)'
              : a.autonomous
                ? `${a.os} · has an AI provider`
                : `${a.os} · no AI (executor only)`}
            onclick={() => toggleHost(a)}
            disabled={a.accepts_commands === false}
          >
            {#if a.autonomous}✨ {/if}@{a.name}
          </button>
        {/each}
      </div>

      <div class="messages" bind:this={messagesEl}>
        {#if !activeDialog && !pendingChat}
          <div class="empty">
            <div class="logo">⚡ Fleet Chat</div>
            {#if aiHosts.length > 0}
              <p>Write a task — a host with an AI provider ✨ will run it, or
                open a dialog from the history on the right to continue its context.</p>
            {:else}
              <p class="warn">No host in the fleet has access to an AI provider.
                Start a node with <code>claude</code> or
                <code>opencode</code> on its PATH — it will show up with a ✨ badge.</p>
            {/if}
          </div>
        {:else if activeDialog?.live}
          <div class="msg assistant"><div class="bubble dim">
            🟢 This session is currently open manually on {activeDialog.hostName} —
            it can't be continued from the web (conflict). You can only end it.
          </div></div>
        {/if}
        {#if loadingTranscript}
          <div class="msg assistant"><div class="bubble dim">Loading dialog…</div></div>
        {:else if transcriptError}
          <div class="msg assistant"><div class="bubble err">
            Failed to load dialog: {transcriptError}
          </div></div>
        {/if}
        {#each transcript as m}
          <div class="msg {m.role}">
            <div class="bubble">{m.text || '…'}</div>
            {#each imagePaths(m.text) as p (p)}
              {@const host = msgHost(m)}
              {@const st = chatImgs[`${host}:${p}`]}
              <div class="chat-img" use:imgload={[host, p]}>
                {#if !st || st.loading}
                  <div class="bubble dim">🖼️ loading preview…</div>
                {:else if st.thumb}
                  <button
                    class="img-btn"
                    title="Download original"
                    onclick={() => downloadChatImage(host, p)}
                  >
                    <img src={st.thumb} alt={p} />
                  </button>
                  <div class="img-name">{p.split('/').pop()} · click to download</div>
                {:else if st.error}
                  <div class="bubble dim">⚠️ {p.split('/').pop()}: {st.error}</div>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
        {#if sending && (activeDialog || pendingChat) && !composerLocked}
          <div class="msg assistant">
            <div class="bubble dim typing" aria-label="Host is typing">
              <span></span><span></span><span></span>
            </div>
          </div>
        {/if}
      </div>

      <div class="composer">
        <textarea
          bind:this={composerEl}
          bind:value={input}
          onkeydown={onComposerKey}
          aria-label="Message to the fleet"
          rows="1"
          placeholder={composerLocked
            ? activeDialog?.resumable === false && !activeDialog?.live
              ? "This agent's history is view-only"
              : 'Session is live on the host — can\'t continue here'
            : !canSend
              ? 'No AI host in the fleet'
              : activeDialog
                ? `Continue on ${activeDialog.hostName}…`
                : 'Message to the fleet…'}
          disabled={!canSend}
        ></textarea>
        <button class="send" onclick={send} disabled={sending || !input.trim() || !canSend}>↑</button>
      </div>
    </section>

    <!-- Mobile drawer backdrop -->
    {#if sidebarOpen}
      <button class="backdrop" aria-label="Close list" onclick={() => (sidebarOpen = false)}></button>
    {/if}

    <!-- Dialog list (right) -->
    <aside class="sidebar" class:open={sidebarOpen}>
      <button class="new" onclick={newChat}>＋ New chat</button>

      {#if inProgress.length > 0}
        <div class="sec-title">In progress</div>
        <div class="list">
          {#each inProgress as p}
            <div class="item progress">
              <span class="item-title">{p.kind === 'cron' ? '⏰' : '⚙️'} {p.label}</span>
              <span class="item-meta">{p.hostName} · {p.detail}</span>
            </div>
          {/each}
        </div>
      {/if}

      <div class="sec-title">Dialogs {#if loading}<span class="muted">· loading…</span>{/if}</div>
      {#if !loading && dialogs.length === 0}
        <div class="muted">No claude/opencode history found in the fleet</div>
      {/if}
      {#each hostErrors as he}
        <div class="host-err" title={he.error}>
          ⚠️ {he.hostName}: {he.error}
          {#if /decrypt|key/i.test(he.error)}<span class="muted"> — node is on a different token/key (or a stale socket is stuck under the same agent-id)</span>{/if}
        </div>
      {/each}
      <div class="list">
        {#each sortedDialogs as d}
          <div class="item" class:on={d.key === active}>
            <button class="item-open" onclick={() => openDialog(d)}>
              <span class="item-title">
                {#if d.live}🟢 {/if}{d.title}
              </span>
              <span class="item-meta">
                <span class="prov {d.provider}">{d.provider}</span> · {d.hostName}
              </span>
            </button>
            <button
              class="pin"
              class:on={pinned.has(d.key)}
              title={pinned.has(d.key) ? 'Unpin' : 'Pin'}
              aria-label={pinned.has(d.key) ? 'Unpin' : 'Pin'}
              onclick={(e) => togglePin(d.key, e)}
            >📌</button>
          </div>
        {/each}
      </div>
    </aside>
  </div>

  {#if showFiles}
    <div class="files-overlay" onclick={(e) => { if (e.target === e.currentTarget) showFiles = false; }}>
      <div class="files-modal">
        <header class="bar">
          <strong>📁 Fleet files</strong>
          <button class="ghost" onclick={() => (showFiles = false)}>✕ Close</button>
        </header>
        <Files {relay} agents={executors} />
      </div>
    </div>
  {/if}

  {#if showSettings}
    <div class="files-overlay" onclick={(e) => { if (e.target === e.currentTarget) showSettings = false; }}>
      <form class="settings-modal" onsubmit={saveSettings}>
        <header class="bar">
          <strong>⚙️ Connection settings</strong>
          <button type="button" class="ghost" onclick={() => (showSettings = false)}>✕ Close</button>
        </header>
        <div class="settings-body">
          <label>Relay URL</label>
          <input bind:value={setRelay} placeholder="wss://relay-host" autocomplete="off" />
          <label>Room</label>
          <input bind:value={setRoom} placeholder="gpu" autocomplete="off" />
          <label>Room key (token)</label>
          <input bind:value={setToken} type="password" placeholder="••••••" autocomplete="off" />
          <label>New PIN (optional)</label>
          <input bind:value={setNewPin} type="password" inputmode="numeric" placeholder="leave blank to keep the current one" autocomplete="off" />
          <p class="hint">Changes will reconnect to the fleet and re-encrypt the cookie with the current (or new) PIN.</p>
          {#if setErr}<div class="err">{setErr}</div>{/if}
          <div class="settings-actions">
            <button type="button" class="ghost danger" onclick={forgetCreds}>Forget credentials</button>
            <button type="submit" class="primary" disabled={setBusy || !setToken}>
              {setBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </div>
  {/if}
{/if}

<style>
  .files-overlay {
    position: fixed;
    inset: 0;
    background: #000000aa;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 24px;
  }
  .files-modal {
    width: min(920px, 100%);
    height: min(80vh, 100%);
    background: #15151b;
    border: 1px solid #ffffff1f;
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .files-modal .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #ffffff14;
  }
  .settings-modal {
    width: min(440px, 100%);
    background: #15151b;
    border: 1px solid #ffffff1f;
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .settings-modal .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #ffffff14;
  }
  .settings-body {
    display: flex;
    flex-direction: column;
    padding: 18px 18px 20px;
  }
  .settings-body label {
    font-size: 12px;
    color: var(--text-dim);
    margin: 12px 0 6px;
  }
  .settings-body input {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
    color: var(--text);
    font-size: 14px;
    outline: none;
  }
  .settings-body input:focus {
    border-color: var(--accent);
  }
  .settings-body .hint {
    margin: 14px 0 0;
    color: var(--text-faint);
    font-size: 12px;
    line-height: 1.5;
  }
  .settings-body .err {
    margin-top: 12px;
    color: #ff7a7a;
    font-size: 13px;
  }
  .settings-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 20px;
  }
  .settings-actions .primary {
    background: var(--accent);
    border: none;
    border-radius: 10px;
    padding: 10px 20px;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
  }
  .settings-actions .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .main {
    display: flex;
    height: 100%;
  }
  .chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .sidebar {
    width: var(--sidebar-w);
    border-left: 1px solid var(--line);
    background: var(--bg-2);
    display: flex;
    flex-direction: column;
    padding: 14px;
    gap: 10px;
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 22px;
    border-bottom: 1px solid var(--line);
  }
  .bar-left {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .bar-left strong {
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hosts-count {
    font-size: 12px;
    color: var(--text-dim);
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 12px;
    color: var(--text-dim);
    font-size: 13px;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }
  a.ghost:hover {
    color: var(--text);
  }

  .hosts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 22px;
    border-bottom: 1px solid var(--line);
  }
  .chip {
    background: var(--bg-3);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 13px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .chip.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: #cdd7ff;
  }
  .chip.sendonly {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .chip.ai {
    border-color: #4d6bfe66;
    color: #cdd7ff;
  }
  .warn {
    color: #e0a23a;
  }
  .warn code {
    background: var(--bg-3);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 0.9em;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 24px 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .empty {
    margin: auto;
    text-align: center;
    color: var(--text-dim);
    max-width: 440px;
  }
  .empty .logo {
    font-size: 24px;
    color: var(--text);
    margin-bottom: 12px;
  }
  .msg {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 22px;
  }
  .msg.user {
    justify-content: flex-end;
  }
  /* Inline images attach below the bubble (full-width row in the wrapping flex). */
  .chat-img {
    flex-basis: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .img-btn {
    padding: 0;
    border: 1px solid #ffffff1f;
    background: transparent;
    cursor: pointer;
    border-radius: 12px;
    overflow: hidden;
    max-width: min(420px, 80%);
  }
  .img-btn img {
    display: block;
    max-width: 100%;
    height: auto;
  }
  .img-name {
    font-size: 12px;
    color: #9a9aa6;
  }
  .bubble {
    max-width: min(720px, 78%);
    padding: 12px 16px;
    border-radius: var(--radius);
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 15px;
  }
  .msg.user .bubble {
    background: var(--bubble-user);
    border-bottom-right-radius: 4px;
  }
  .msg.assistant .bubble {
    background: var(--bg-2);
    border-bottom-left-radius: 4px;
  }
  .bubble.dim {
    color: var(--text-dim);
  }
  .bubble.err {
    color: #ff8a8a;
    border: 1px solid #ff8a8a44;
  }
  .bubble.typing {
    display: inline-flex;
    gap: 4px;
    padding: 14px 16px;
  }
  .bubble.typing span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-dim);
    animation: typing-dot 1.2s infinite ease-in-out;
  }
  .bubble.typing span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .bubble.typing span:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes typing-dot {
    0%, 60%, 100% {
      opacity: 0.3;
      transform: translateY(0);
    }
    30% {
      opacity: 1;
      transform: translateY(-3px);
    }
  }

  .composer {
    margin: 0 22px 22px;
    display: flex;
    align-items: flex-end;
    gap: 10px;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 10px 12px;
  }
  textarea {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    resize: none;
    color: var(--text);
    font-size: 15px;
    font-family: inherit;
    max-height: 180px;
    overflow-y: auto;
    line-height: 1.5;
  }
  .send {
    background: var(--accent);
    border: none;
    border-radius: 50%;
    width: 34px;
    height: 34px;
    color: #fff;
    font-size: 17px;
    flex: none;
  }
  .send:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .new {
    background: var(--bg-3);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 11px;
    font-size: 14px;
    font-weight: 600;
  }
  .muted {
    color: var(--text-faint);
    font-size: 13px;
    padding: 8px 4px;
  }
  .host-err {
    color: #e0a000;
    font-size: 12px;
    padding: 6px 8px;
    line-height: 1.4;
    border-left: 2px solid #e0a00055;
    margin: 2px 0;
  }
  .host-err .muted {
    padding: 0;
    display: inline;
  }
  .list {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    border-radius: 9px;
    display: flex;
    align-items: center;
  }
  .item:hover {
    background: var(--bg-hover);
  }
  .item.on {
    background: var(--bg-3);
  }
  .item-open {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    border-radius: 9px;
    padding: 9px 11px;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .pin {
    background: transparent;
    border: none;
    padding: 6px 9px;
    font-size: 13px;
    opacity: 0;
    filter: grayscale(1);
    flex: none;
    transition: opacity 0.12s;
  }
  .item:hover .pin {
    opacity: 0.55;
  }
  .pin:hover {
    opacity: 1 !important;
  }
  .pin.on {
    opacity: 1;
    filter: none;
  }
  .item-title {
    font-size: 14px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-meta {
    font-size: 11px;
    color: var(--text-faint);
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .sec-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-faint);
    margin: 8px 4px 2px;
  }
  .item.progress {
    cursor: default;
    opacity: 0.92;
  }
  .prov {
    border-radius: 4px;
    padding: 0 5px;
    font-size: 10px;
    background: var(--bg-3);
  }
  .prov.claude {
    color: #d6a86a;
  }
  .prov.opencode {
    color: #7fb3ff;
  }
  .prov.cline {
    color: #8ad6c0;
  }
  .prov.roo {
    color: #c9a8ff;
  }
  .prov.kilo {
    color: #ffb37f;
  }
  .prov.zed {
    color: #7fd6ff;
  }
  .live-tag {
    color: #5ad17f;
  }
  .ghost.danger {
    color: #ff8a8a;
    border-color: #ff8a8a44;
  }

  /* Desktop: the dialog list is a permanent right column. */
  .menu-toggle {
    display: none;
  }
  .backdrop {
    display: none;
  }

  /* Mobile: the dialog list becomes a right-side drawer. */
  @media (max-width: 760px) {
    .menu-toggle {
      display: inline-flex;
      align-items: center;
      font-size: 16px;
    }
    .bar {
      padding: 12px 16px;
      gap: 8px;
    }
    .hosts,
    .msg,
    .composer {
      padding-left: 16px;
      padding-right: 16px;
    }
    .composer {
      margin-left: 16px;
      margin-right: 16px;
    }
    .bubble {
      max-width: 88%;
    }
    .sidebar {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(84vw, 320px);
      z-index: 30;
      transform: translateX(100%);
      transition: transform 0.22s ease;
      box-shadow: -10px 0 30px rgba(0, 0, 0, 0.5);
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 20;
      border: none;
      background: rgba(0, 0, 0, 0.5);
    }
  }
</style>
