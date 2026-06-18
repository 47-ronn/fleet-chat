<script>
  import { Relay } from './lib/relay.js';
  import Auth from './lib/Auth.svelte';
  import Files from './lib/Files.svelte';
  import Icon from './lib/Icon.svelte';
  import { scale } from 'svelte/transition';
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

  // --- transcript scroll follow + "jump to latest" button ---
  // We only auto-follow when the user is already near the bottom; if they've
  // scrolled up to read history we leave them there and surface a button (with
  // an unread count) instead of yanking them down on every new message.
  let atBottom = $state(true); // is the viewport near the latest message?
  let newCount = $state(0); // messages arrived while scrolled up
  let prevLen = 0; // transcript length on the last effect run
  let prevKey = null; // active dialog on the last run (switch => force pin)

  const NEAR_BOTTOM_PX = 80;

  function onMessagesScroll() {
    if (!messagesEl) return;
    const dist = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    atBottom = dist < NEAR_BOTTOM_PX;
    if (atBottom) newCount = 0;
  }

  function scrollToBottom(smooth = true) {
    if (!messagesEl) return;
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottom = true;
    newCount = 0;
  }

  // Pin to the latest message when following (or when the dialog changes), and
  // otherwise tally how many messages arrived out of view.
  $effect(() => {
    const key = active;
    const len = transcript.length;
    sending; // also re-pin when the "typing…" bubble toggles
    if (!messagesEl) return;
    const dialogChanged = key !== prevKey;
    if (dialogChanged || atBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight; // instant; smooth is for the button
      atBottom = true;
      newCount = 0;
    } else if (len > prevLen) {
      newCount += len - prevLen;
    }
    prevKey = key;
    prevLen = len;
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

  // --- tunnels panel: expose a host's local port at a public URL ---
  let showTunnels = $state(false);
  let tunHost = $state(''); // selected executor agent id
  let tunTarget = $state('3000'); // local port or address to expose
  let tunnels = $state([]); // running tunnels on the selected host
  let tunBusy = $state(false);
  let tunErr = $state('');

  function openTunnels() {
    tunErr = '';
    if (!tunHost || !executors.some((a) => a.id === tunHost)) {
      tunHost = executors[0]?.id || '';
    }
    showTunnels = true;
    refreshTunnels();
  }

  async function refreshTunnels() {
    if (!relay || !tunHost) {
      tunnels = [];
      return;
    }
    try {
      tunnels = await relay.tunnelList(tunHost);
    } catch (e) {
      tunErr = String(e?.message || e);
    }
  }

  async function startTunnel() {
    if (!relay || !tunHost || !tunTarget.trim()) return;
    tunErr = '';
    tunBusy = true;
    try {
      const t = await relay.tunnelStart(tunHost, tunTarget.trim());
      if (t) tunnels = [...tunnels.filter((x) => x.id !== t.id), t];
    } catch (e) {
      tunErr = String(e?.message || e);
    } finally {
      tunBusy = false;
    }
  }

  async function stopTunnel(id) {
    try {
      await relay.tunnelStop(tunHost, id);
      tunnels = tunnels.filter((t) => t.id !== id);
    } catch (e) {
      tunErr = String(e?.message || e);
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
          notify('No AI-provider host in the fleet ✨. Start a node where claude/opencode is available.', 'error');
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
      notify('Failed to send: ' + (err.message || err), 'error');
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

  // Absolute file paths mentioned in a message (backtick-quoted or bare),
  // excluding images (those get inline thumbnails). Rendered as download cards
  // so "send me the file" attaches the actual file instead of pasting its text.
  const FILE_RE =
    /`((?:\/|~\/|[A-Za-z]:\\)[^`\n]+\.[A-Za-z0-9]{1,8})`|((?:\/|~\/|[A-Za-z]:\\)[^\s`*<>|"]+\.[A-Za-z0-9]{1,8})/g;
  const IMG_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;
  function filePaths(text) {
    if (!text) return [];
    const out = new Set();
    for (const m of text.matchAll(FILE_RE)) {
      const p = (m[1] || m[2]).trim().replace(/[.,;:)]+$/, '');
      if (!IMG_EXT.test(p)) out.add(p);
    }
    return [...out];
  }

  let copiedIdx = $state(-1);
  async function copyMsg(text, idx) {
    try {
      await navigator.clipboard.writeText(text);
      copiedIdx = idx;
      setTimeout(() => {
        if (copiedIdx === idx) copiedIdx = -1;
      }, 1200);
    } catch {
      notify('Copy failed', 'error');
    }
  }

  // --- toast notifications (replace blocking alert()) ---
  let toasts = $state([]);
  let toastSeq = 0;
  function notify(message, type = 'error') {
    const id = ++toastSeq;
    toasts = [...toasts, { id, message, type }];
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, type === 'error' ? 6000 : 3500);
  }
  function dismissToast(id) {
    toasts = toasts.filter((t) => t.id !== id);
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

  async function downloadChatFile(host, path) {
    if (!host) {
      notify('Unknown host for this file', 'error');
      return;
    }
    try {
      const meta = await relay.fileStat(host, path);
      const blob = await relay.downloadFile(host, path, { mime: meta?.mime, size: meta?.size });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = path.split(/[\\/]/).pop() || 'file';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      notify('Failed to download: ' + (e.message || e), 'error');
    }
  }

  async function terminateSession(d) {
    if (!confirm(`End the active session on ${d.hostName}?`)) return;
    try {
      await relay.sessionTerminate(d.host, d.id);
      await refreshFleet();
    } catch (err) {
      notify('Failed to end session: ' + (err.message || err), 'error');
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
        <a class="ghost ic" href="#/" title="Home"><Icon name="home" /><span>Home</span></a>
        <button class="ghost ic" onclick={() => (showFiles = true)} title="Files"><Icon name="folder" /><span>Files</span></button>
        <button class="ghost ic" onclick={openTunnels} title="Tunnels"><Icon name="cloud" /><span>Tunnels</span></button>
        <button class="ghost ic icon-only" onclick={openSettings} title="Settings" aria-label="Settings"><Icon name="settings" /></button>
        <button class="ghost ic" onclick={logout} title="Log out"><Icon name="logout" /><span>Log out</span></button>
        <button
          class="ghost ic icon-only menu-toggle"
          aria-label="Chat list"
          onclick={() => (sidebarOpen = !sidebarOpen)}
        ><Icon name="menu" /></button>
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

      <div class="messages" bind:this={messagesEl} onscroll={onMessagesScroll}>
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
        {#each transcript as m, i}
          <div class="msg {m.role}">
            <div class="bubble">
              {m.text || '…'}
              {#if m.text}
                <button
                  class="copy-btn"
                  title="Copy message"
                  onclick={() => copyMsg(m.text, i)}
                >{copiedIdx === i ? '✓' : '⧉'}</button>
              {/if}
            </div>
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
                    onclick={() => downloadChatFile(host, p)}
                  >
                    <img src={st.thumb} alt={p} />
                  </button>
                  <div class="img-name">{p.split('/').pop()} · click to download</div>
                {:else if st.error}
                  <div class="bubble dim">⚠️ {p.split('/').pop()}: {st.error}</div>
                {/if}
              </div>
            {/each}
            {#each filePaths(m.text) as p (p)}
              {@const host = msgHost(m)}
              <button class="file-card" title="Download file" onclick={() => downloadChatFile(host, p)}>
                <span class="file-card-ic">📄</span>
                <span class="file-card-name">{p.split(/[\\/]/).pop()}</span>
                <span class="file-card-dl">Download</span>
              </button>
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

      {#if !atBottom}
        <button
          class="scroll-fab"
          transition:scale={{ duration: 160, start: 0.6 }}
          onclick={() => scrollToBottom()}
          aria-label="Scroll to latest"
          title="Scroll to latest"
        >
          <Icon name="arrow-down" size={20} />
          {#if newCount > 0}
            <span class="fab-badge">{newCount > 99 ? '99+' : newCount}</span>
          {/if}
        </button>
      {/if}

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
        <button class="send" onclick={send} disabled={sending || !input.trim() || !canSend} aria-label="Send"><Icon name="arrow-up" size={18} draw={false} /></button>
      </div>
    </section>

    <!-- Mobile drawer backdrop -->
    {#if sidebarOpen}
      <button class="backdrop" aria-label="Close list" onclick={() => (sidebarOpen = false)}></button>
    {/if}

    <!-- Dialog list (right) -->
    <aside class="sidebar" class:open={sidebarOpen}>
      <button class="new" onclick={newChat}><Icon name="plus" size={16} /><span>New chat</span></button>

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

  {#if showTunnels}
    <div class="files-overlay" onclick={(e) => { if (e.target === e.currentTarget) showTunnels = false; }}>
      <div class="settings-modal tunnels-modal">
        <header class="bar">
          <strong>🌐 Quick tunnels</strong>
          <button type="button" class="ghost" onclick={() => (showTunnels = false)}>✕ Close</button>
        </header>
        <div class="settings-body">
          <label>Host</label>
          <select bind:value={tunHost} onchange={refreshTunnels}>
            {#each executors as a}
              <option value={a.id}>{a.name}</option>
            {/each}
          </select>
          <label>Local target (port or address)</label>
          <div class="tun-start">
            <input
              bind:value={tunTarget}
              placeholder="3000 or http://localhost:3000"
              autocomplete="off"
              onkeydown={(e) => { if (e.key === 'Enter') startTunnel(); }}
            />
            <button class="primary" onclick={startTunnel} disabled={tunBusy || !tunHost || !tunTarget.trim()}>
              {tunBusy ? 'Starting…' : 'Start'}
            </button>
          </div>
          <p class="hint">Exposes the host's local port at a public https://*.trycloudflare.com URL (downloads cloudflared on first use; host must be in edit/bypass mode).</p>
          {#if tunErr}<div class="err">{tunErr}</div>{/if}

          {#if tunnels.length}
            <div class="tun-list">
              {#each tunnels as t}
                <div class="tun-row">
                  <div class="tun-meta">
                    <a href={t.public_url} target="_blank" rel="noopener" class="tun-url">{t.public_url}</a>
                    <span class="muted">→ {t.target}</span>
                  </div>
                  <div class="tun-acts">
                    <button class="ghost" title="Copy URL" onclick={() => navigator.clipboard?.writeText(t.public_url)}>📋</button>
                    <button class="ghost danger" onclick={() => stopTunnel(t.id)}>Stop</button>
                  </div>
                </div>
              {/each}
            </div>
          {:else}
            <p class="muted tun-empty">No running tunnels on this host.</p>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- Toast notifications (replace blocking alert()) -->
  <div class="toasts" aria-live="polite">
    {#each toasts as t (t.id)}
      <button class="toast {t.type}" onclick={() => dismissToast(t.id)} title="Dismiss">
        {t.message}
      </button>
    {/each}
  </div>
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
  .tunnels-modal {
    width: min(560px, 100%);
  }
  .settings-body select {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
    color: var(--text);
    font-size: 14px;
    outline: none;
  }
  .tun-start {
    display: flex;
    gap: 8px;
  }
  .tun-start input {
    flex: 1;
  }
  .tun-start .primary {
    background: var(--accent);
    border: none;
    border-radius: 10px;
    padding: 0 18px;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
  }
  .tun-start .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .tun-list {
    margin-top: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tun-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
  }
  .tun-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .tun-url {
    color: var(--accent);
    font-size: 14px;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tun-url:hover {
    text-decoration: underline;
  }
  .tun-meta .muted {
    font-size: 12px;
  }
  .tun-acts {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .tun-empty {
    margin-top: 16px;
    text-align: center;
    font-size: 14px;
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
    position: relative; /* anchor for the scroll-to-latest FAB */
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
  /* Icon + label buttons: keep a small gap and color the icon on hover. */
  .ghost.ic {
    gap: 6px;
  }
  .ghost.ic:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .ghost.icon-only {
    padding: 6px 8px;
  }

  /* Floating "jump to latest" button, sits above the composer on the right. */
  .scroll-fab {
    position: absolute;
    right: 28px;
    bottom: 92px;
    z-index: 5;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--bg-3);
    border: 1px solid var(--line);
    color: var(--text);
    display: grid;
    place-items: center;
    cursor: pointer;
    box-shadow: 0 6px 18px #00000055;
    transition: background 0.15s, transform 0.15s, border-color 0.15s;
  }
  .scroll-fab:hover {
    background: var(--bg-hover);
    border-color: var(--accent);
    transform: translateY(-1px);
  }
  .fab-badge {
    position: absolute;
    top: -5px;
    right: -5px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--accent);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    text-align: center;
    box-shadow: 0 0 0 2px var(--bg);
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
    position: relative;
    max-width: min(720px, 78%);
    padding: 12px 16px;
    border-radius: var(--radius);
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 15px;
  }
  /* Copy-to-clipboard button, revealed on hover of a message. */
  .copy-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    border: none;
    background: var(--bg-3);
    color: var(--text-dim);
    border-radius: 6px;
    width: 24px;
    height: 24px;
    font-size: 13px;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.12s;
    cursor: pointer;
  }
  .bubble:hover .copy-btn {
    opacity: 0.85;
  }
  .copy-btn:hover {
    opacity: 1 !important;
    color: var(--text);
  }
  /* Download card for a file path mentioned in a message. */
  .file-card {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    padding: 8px 12px;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--text);
    font-size: 14px;
    cursor: pointer;
    max-width: min(420px, 78%);
  }
  .file-card:hover {
    border-color: var(--accent);
  }
  .file-card-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-card-dl {
    margin-left: auto;
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }
  /* Toast notifications. */
  .toasts {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 100;
    max-width: min(560px, 92vw);
  }
  .toast {
    text-align: left;
    padding: 11px 16px;
    border-radius: 10px;
    font-size: 14px;
    color: #fff;
    border: none;
    cursor: pointer;
    box-shadow: 0 6px 24px #0006;
    background: var(--bg-3);
  }
  .toast.error {
    background: #b3323b;
  }
  .toast.success {
    background: #2f7d4f;
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
    flex: none;
    display: grid;
    place-items: center;
    cursor: pointer;
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    cursor: pointer;
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
    /* Compact header on mobile: show icons only, drop the text labels. */
    .ghost.ic span {
      display: none;
    }
    .ghost.ic {
      padding: 6px 8px;
    }
    .scroll-fab {
      right: 20px;
      bottom: 88px;
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
