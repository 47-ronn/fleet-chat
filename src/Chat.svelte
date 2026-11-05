<script>
  import { Relay } from './lib/relay.js';
  import Auth from './lib/Auth.svelte';
  import Files from './lib/Files.svelte';
  import FleetGraph from './lib/FleetGraph.svelte';
  import Icon from './lib/Icon.svelte';
  import { scale } from 'svelte/transition';
  import { storeCreds, clearCreds } from './lib/creds.js';

  let relay = $state(null);
  let showFiles = $state(false); // file-browser overlay visibility
  let showGraph = $state(false); // agent dependency-graph overlay
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
  // Per-host autonomous tasks for the dependency graph:
  // [{host, hostName, tasks: [{id, initiator, prompt, status, created_at, …}]}]
  let fleetTasks = $state([]);
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
  let copiedId = $state(false); // brief ✓ feedback after copying the session id
  // The most recent dispatched task (new-chat path), for "Then…" chaining.
  let lastDispatch = $state(null); // {host, taskId} | null
  // "Needs you": live dialogs whose transcript tail shows a tool still
  // PENDING a human answer (a question / permission) — key → tool name.
  // Refreshed by a cheap tail poll (see pollWaiting); the open dialog's value
  // is derived from its loaded transcript instead.
  let waitingOn = $state(new Map());
  let onlyWaiting = $state(false); // dialogs-list filter: only needs-you ones

  // Copy the selected session's id to the clipboard, with a short ✓ flip.
  async function copySessionId(id) {
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      copiedId = true;
      setTimeout(() => (copiedId = false), 1200);
    } catch {
      notify('Copy failed (clipboard unavailable)', 'error');
    }
  }

  // --- Chat export (Markdown) -------------------------------------------------
  // Downloads the OPEN dialog's loaded transcript as a readable .md (the
  // transcript is the host-capped tail — the truncation marker, if any, is a
  // system message and travels with it).
  function exportChat(d) {
    if (!d || !transcript.length) {
      notify('Сначала открой диалог с загруженной историей', 'error');
      return;
    }
    const ts = (ms) => (ms ? new Date(ms).toLocaleString('ru-RU') : '');
    const rows = [
      `# ${d.title}`,
      '',
      `> ${d.provider} · ${d.hostName}${d.cwd ? ` · ${d.cwd}` : ''} · \`${d.id}\``,
      `> экспорт из Fleet Chat: ${new Date().toLocaleString('ru-RU')}`,
      '',
    ];
    for (const m of transcript) {
      const who = m.role === 'user' ? '👤' : m.role === 'assistant' ? '🤖' : 'ℹ️';
      rows.push(`**${who} ${m.role}**${m.ts ? ` · _${ts(m.ts)}_` : ''}`, '', m.text || '…', '');
    }
    const base = (d.title || d.id)
      .replace(/[^\p{L}\p{N} _-]+/gu, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'dialog';
    const blob = new Blob([rows.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}.md`;
    document.body.appendChild(a); // Firefox requires the link in the DOM
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // --- Drag-and-drop file attachments ------------------------------------------
  // Dragging files over the chat pane shows a drop hint; dropping uploads
  // each file to the message's target host (WriteFile) and appends the
  // on-host path to the composer, so the AI reads it with full context.
  // Text files only — the wire carries UTF-8 strings (see relay.writeFile)
  // — and ≲512 KiB each, to stay clear of the relay frame limit.
  let dragOver = $state(false);
  let dragTimer = null;

  // The host files go to: the open dialog's host (continues its session) or,
  // for a new chat, the host the composer would send to.
  const dropTargetHost = $derived(activeDialog?.host || answeringHost());

  function onDragOver(ev) {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    // dragover keeps firing while held over the pane; a short timeout after
    // the last event clears the hint without child-element dragleave flicker.
    dragOver = true;
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => (dragOver = false), 250);
  }

  async function onDrop(ev) {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    dragOver = false;
    clearTimeout(dragTimer);
    const files = [...(ev.dataTransfer?.files || [])];
    if (files.length) await uploadFiles(files);
  }

  // Strict UTF-8 + a NUL-byte sniff: binary content must NOT ride the string
  // wire (protobuf `string`), it would arrive corrupted.
  function readFileText(f) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('файл не читается'));
      r.onload = () => {
        const buf = new Uint8Array(r.result);
        if (buf.slice(0, 8192).includes(0)) {
          return reject(new Error('бинарный файл — пока только текст (укажи путь к файлу на хосте)'));
        }
        try {
          resolve(new TextDecoder('utf-8', { fatal: true }).decode(buf));
        } catch {
          reject(new Error('не UTF-8 — пока только текстовые файлы'));
        }
      };
      r.readAsArrayBuffer(f);
    });
  }

  async function uploadFiles(files) {
    const host = dropTargetHost;
    if (!relay || !host) {
      notify('Не выбран хост-получатель для файлов', 'error');
      return;
    }
    const hostName = agents.find((a) => a.id === host)?.name || host;
    const uploaded = [];
    for (const f of files) {
      if (f.size > 512 * 1024) {
        notify(`${f.name}: больше 512 КБ — не влезает в кадр релея`, 'error');
        continue;
      }
      try {
        const text = await readFileText(f);
        // /tmp always exists (Linux hosts), the random prefix prevents
        // clobbering, and the AI reads the absolute path from the message.
        const safe = f.name.replace(/[\\/]+/g, '_');
        const path = `/tmp/fleet-${Math.random().toString(36).slice(2, 8)}-${safe}`;
        await relay.writeFile(host, path, text);
        uploaded.push(path);
        notify(`${f.name} → ${hostName}:${path}`, 'ok');
      } catch (e) {
        notify(`${f.name}: ${e?.message || e}`, 'error');
      }
    }
    if (uploaded.length) {
      const note = uploaded.map((p) => `Приложен файл: ${p}`).join('\n');
      input = input ? input.replace(/\s+$/, '') + '\n' + note : note;
      composerEl?.focus();
    }
  }

  // Dialogs filter: which providers (claude / opencode / cline / …) to show in
  // the chat list (empty = all). Set via the right-click context menu on the list.
  let providerFilter = $state(new Set());
  let hostMenu = $state(null); // {x, y} context-menu anchor, or null

  // --- Fleet-wide Algolia-style search modal over chat history & mentions ----
  // Fans `session_search` out to every executor host (each answers from its
  // local BM25 index), merges hits by score, highlights matched terms, and
  // jumps to the cited context (`session_get` window around the hit) on click
  // or Enter.
  let showSearch = $state(false);
  let searchInputEl = $state(null);
  let searchQuery = $state('');
  let searching = $state(false);
  let searchHits = $state([]); // {…SessionSearchHit, host, hostName}
  let searchNote = $state(null);
  let searchHostFilter = $state(''); // '' = all hosts, or agent id
  let searchCursor = $state(0); // keyboard selection index in modal
  let searchDebounce = null;
  let searchSeq = 0;
  let activeMention = $state(null); // {query, seq, snippet, markIdx} when viewing a window

  function stepMentionMark(delta) {
    if (!messagesEl || !activeMention) return;
    const marks = [...messagesEl.querySelectorAll('mark.hl')];
    if (!marks.length) return;
    const next = ((activeMention.markIdx ?? 0) + delta + marks.length) % marks.length;
    activeMention = { ...activeMention, markIdx: next, totalMarks: marks.length };
    marks.forEach((m, i) => m.classList.toggle('current', i === next));
    marks[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function openSearchModal(initial = '') {
    showSearch = true;
    if (initial && !searchQuery) searchQuery = initial;
    requestAnimationFrame(() => searchInputEl?.focus());
    if (searchQuery.trim() && !searchHits.length) runSearch();
  }

  function onSearchInput() {
    searchCursor = 0;
    clearTimeout(searchDebounce);
    const q = searchQuery.trim();
    if (!q) {
      searchHits = [];
      searchNote = null;
      searching = false;
      return;
    }
    searchDebounce = setTimeout(() => runSearch(), 240);
  }

  // Instant client-side title / cwd matches across loaded dialogs.
  const titleMatches = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    return dedupedDialogs
      .filter((d) => {
        if (searchHostFilter && d.host !== searchHostFilter) return false;
        const hay = `${d.title || ''} ${d.cwd || ''} ${d.provider || ''}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, 8);
  });

  // Deduplicate BM25 hits that point to the same (provider, session_id, seq)
  // across mirrored hosts, keeping the preferred host.
  const visibleSearchHits = $derived.by(() => {
    const seen = new Set();
    const out = [];
    for (const h of searchHits) {
      if (searchHostFilter && h.host !== searchHostFilter) continue;
      const k = `${h.provider}:${h.session_id}:${h.seq ?? 0}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(h);
    }
    return out;
  });

  // Split text into [{text, mark}] segments for safe `<mark>` highlighting.
  function highlightParts(text, query) {
    const src = String(text || '').replace(/<\/?b>/gi, '');
    const terms = String(query || '')
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .filter((t) => t.length >= 2);
    if (!terms.length || !src) return [{ text: src, mark: false }];
    const re = new RegExp(`(${terms.join('|')})`, 'gi');
    const parts = [];
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) parts.push({ text: src.slice(last, m.index), mark: false });
      parts.push({ text: m[0], mark: true });
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < src.length) parts.push({ text: src.slice(last), mark: false });
    return parts.length ? parts : [{ text: src, mark: false }];
  }

  async function runSearch() {
    const q = searchQuery.trim();
    if (!q || !relay) return;
    const mySeq = ++searchSeq;
    searching = true;
    searchNote = null;
    try {
      const providers = providerFilter.size ? [...providerFilter] : [];
      const hosts = executors;
      const results = await Promise.allSettled(
        hosts.map((a) => relay.sessionSearch(a.id, q, providers, 25))
      );
      if (mySeq !== searchSeq) return;
      const hits = [];
      let failed = 0;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          for (const h of r.value || []) {
            hits.push({ ...h, host: hosts[i].id, hostName: hosts[i].name });
          }
        } else {
          failed++;
        }
      });
      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      searchHits = hits;
      searchCursor = 0;
      searchNote = hits.length
        ? failed
          ? `${failed} host(s) failed to answer`
          : null
        : failed
          ? `Упоминаний в тексте не найдено (${failed} хост не ответил)`
          : 'Точных упоминаний в сообщениях не найдено — попробуй другое слово';
    } finally {
      if (mySeq === searchSeq) searching = false;
    }
  }

  function clearSearch() {
    searchQuery = '';
    searchHits = [];
    searchNote = null;
    searchCursor = 0;
  }

  // Open a search hit: adopt (or synthesize) its dialog, then load the cited
  // context window instead of the whole transcript and center it.
  function openSearchHit(h) {
    const key = `${h.host}:${h.provider}:${h.session_id}`;
    let d = dialogs.find((x) => x.key === key);
    if (!d) {
      d = {
        key,
        host: h.host,
        hostName: h.hostName,
        provider: h.provider,
        id: h.session_id,
        title: h.title || h.session_id,
        updated: h.ts || 0,
        cwd: h.cwd || null,
        live: false,
        resumable: ['claude', 'opencode', 'codex'].includes(h.provider),
      };
      dialogs = [d, ...dialogs];
    }
    active = key;
    pendingChat = null;
    sidebarOpen = false;
    showSearch = false;
    activeMention = {
      query: searchQuery.trim(),
      seq: h.seq,
      snippet: String(h.snippet || '').replace(/<\/?b>/gi, '').slice(0, 80),
      matchCount: h.match_count || 1,
    };
    loadTranscript(d, { force: true, aroundSeq: h.seq });
  }

  function onSearchModalKey(e) {
    const total = visibleSearchHits.length + titleMatches.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (total > 0) searchCursor = (searchCursor + 1) % total;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (total > 0) searchCursor = (searchCursor - 1 + total) % total;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchCursor < visibleSearchHits.length && visibleSearchHits[searchCursor]) {
        openSearchHit(visibleSearchHits[searchCursor]);
      } else {
        const d = titleMatches[searchCursor - visibleSearchHits.length];
        if (d) {
          showSearch = false;
          activeMention = null;
          openDialog(d);
        } else {
          runSearch();
        }
      }
    }
  }

  function openHostMenu(e) {
    e.preventDefault();
    hostMenu = { x: e.clientX, y: e.clientY };
  }
  function toggleProvider(p) {
    const next = new Set(providerFilter);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    providerFilter = next; // reassign so $derived recomputes
  }
  function clearProviderFilter() {
    providerFilter = new Set();
    hostMenu = null;
  }

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

  // Deduplicate sessions replicated across multiple hosts (same `provider:id`
  // after a database migration): keep one representative card, preferring a
  // live host, then a non-legacy host (anything other than `79f33ac4`), then the
  // freshest timestamp; surface the extra host names as `alsoOn` so the user
  // still sees where copies live.
  const dedupedDialogs = $derived.by(() => {
    const bySid = new Map();
    const score = (d) =>
      (d.live ? 4 : 0) + (pinned.has(d.key) ? 2 : 0) + (d.hostName !== '79f33ac4' ? 1 : 0);
    for (const d of dialogs) {
      const sid = `${d.provider}:${d.id}`;
      const cur = bySid.get(sid);
      if (!cur) {
        bySid.set(sid, { ...d, alsoOn: [] });
        continue;
      }
      const pickNew =
        score(d) > score(cur) ||
        (score(d) === score(cur) && (d.updated || 0) > (cur.updated || 0));
      if (pickNew) {
        const also = cur.alsoOn.includes(cur.hostName) ? cur.alsoOn : [...cur.alsoOn, cur.hostName];
        bySid.set(sid, { ...d, alsoOn: also.filter((h) => h !== d.hostName) });
      } else if (d.hostName !== cur.hostName && !cur.alsoOn.includes(d.hostName)) {
        cur.alsoOn.push(d.hostName);
      }
    }
    return [...bySid.values()];
  });

  // Pinned first, then by recency (the order refreshFleet already applies).
  const sortedDialogs = $derived(
    [...dedupedDialogs].sort(
      (a, b) => (pinned.has(b.key) ? 1 : 0) - (pinned.has(a.key) ? 1 : 0)
    )
  );

  // Providers (claude / opencode / cline / roo / kilo) present in the fleet's
  // history — the choices for the filter menu, with a per-provider count.
  const filterProviders = $derived(
    [...dialogs.reduce((m, d) => m.set(d.provider, (m.get(d.provider) || 0) + 1), new Map())]
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => a.provider.localeCompare(b.provider))
  );
  // key → waiting tool name across all dialogs: the tail poll's map, with the
  // OPEN dialog's entry derived from its loaded transcript (fresher).
  const waitingDialogs = $derived.by(() => {
    const m = new Map(waitingOn);
    if (activeDialog && transcript.length) {
      const tail = [...transcript].reverse().find((x) => x.role !== 'system');
      if (tail?.waiting) m.set(activeDialog.key, tail.waiting);
      else m.delete(activeDialog.key);
    }
    return m;
  });

  // Apply the provider filter (empty filter = show everything) and the
  // needs-you filter.
  const visibleDialogs = $derived.by(() => {
    let ds = providerFilter.size ? sortedDialogs.filter((d) => providerFilter.has(d.provider)) : sortedDialogs;
    if (onlyWaiting) ds = ds.filter((d) => waitingDialogs.has(d.key));
    return ds;
  });

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
    r.onReconnect = () => scheduleRefresh(); // re-fetch after a transparent re-dial
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
    r.onReconnect = () => scheduleRefresh();
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
      const ft = [];
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
          if (!/timed out|disconnected/i.test(msg)) he.push({ hostName: a.name, error: msg });
        }
        try {
          const ts = await relay.taskList(a.id);
          ft.push({ host: a.id, hostName: a.name, tasks: ts });
          for (const t of ts) {
            if (t.status === 'running' || t.status === 'queued') {
              ip.push({
                host: a.id,
                hostName: a.name,
                kind: 'task',
                taskId: t.id,
                prompt: t.prompt || t.id,
                createdAt: t.created_at || 0,
                label: (t.prompt || t.id).slice(0, 60),
                detail: t.status,
              });
            }
          }
        } catch {}
        try {
          for (const c of await relay.scheduleList(a.id)) {
            ip.push({
              host: a.id,
              hostName: a.name,
              kind: 'cron',
              command: c.command || '',
              lastRun: c.last_run || null,
              runCount: c.run_count || 0,
              label: c.name,
              detail: c.cron,
            });
          }
        } catch {}
      }
      dl.sort((x, y) => (y.updated || 0) - (x.updated || 0));
      dialogs = dl;
      inProgress = ip;
      hostErrors = he;
      fleetTasks = ft;
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
  let pollCount = 0;

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

  // Needs-you poll: live sessions get a cheap TAIL fetch (a tiny window at
  // the very end of the transcript) to see whether the agent stopped on a
  // tool still PENDING a human answer (question / permission). Only live
  // dialogs — a dead session can't be waiting. Runs every ~10s.
  async function pollWaiting() {
    if (!relay || !authed) return;
    const live = dialogs.filter((d) => d.live);
    const next = new Map();
    await Promise.allSettled(
      live.map(async (d) => {
        try {
          const msgs = await relay.sessionGet(d.host, d.provider, d.id, 1_000_000, 2);
          const tail = [...(msgs || [])].reverse().find((m) => m.role !== 'system');
          if (tail?.waiting) next.set(d.key, tail.waiting);
        } catch {}
      })
    );
    waitingOn = next;
  }

  async function pollFleet() {
    if (!relay || !authed) return;
    // A poll landing mid-reconnect rejects with 'disconnected'; ignore it and
    // let the next tick (or the onReconnect refresh) recover.
    try {
      await refreshFleet({ silent: true });
    } catch {
      return;
    }
    // Refresh host-owned chains (display only; firing happens on the host).
    if (pollCount++ % 6 === 0) refreshChains();
    // Needs-you tails (every other 5s tick ≈ 10s).
    if (pollCount % 2 === 0) pollWaiting();
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
  // used by the poll to pull new turns of a live session. `aroundSeq` loads
  // the cited window around that message (from a search hit) and centers it.
  async function loadTranscript(d, { force = false, aroundSeq = null } = {}) {
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
      const msgs = await relay.sessionGet(
        d.host,
        d.provider,
        d.id,
        aroundSeq,
        aroundSeq !== null ? 12 : null
      );
      if (active === key) {
        transcript = msgs;
        transcriptError = null;
        if (aroundSeq !== null) {
          // Scroll directly to the first highlighted `<mark class="hl">` inside
          // the loaded window (or fall back to the middle of the window).
          requestAnimationFrame(() => {
            if (!messagesEl) return;
            const mark = messagesEl.querySelector('mark.hl') || messagesEl.querySelector('.bubble.mention-hit');
            if (mark) {
              mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } else {
              messagesEl.scrollTop =
                messagesEl.scrollHeight / 2 - messagesEl.clientHeight / 2;
            }
          });
        }
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
    activeMention = null;
    sidebarOpen = false;
  }

  // Click an "In progress" item: if it's a running/queued task, jump to the
  // matching live dialog on that host if one exists, otherwise open the task
  // itself in the chat pane and poll `taskGet` until its result lands. For a
  // cron job, show its schedule + command in the chat pane.
  async function openProgressItem(p) {
    sidebarOpen = false;
    if (p.kind === 'task') {
      const needle = (p.prompt || '').trim().slice(0, 32).toLowerCase();
      const match =
        dialogs.find((d) => d.host === p.host && d.live) ||
        (needle &&
          dialogs.find(
            (d) => d.host === p.host && (d.title || '').toLowerCase().includes(needle)
          ));
      if (match) {
        openDialog(match);
        return;
      }
      active = null;
      loadedKey = null;
      transcriptError = null;
      loadingTranscript = false;
      pendingChat = { host: p.host, hostName: p.hostName, taskId: p.taskId, title: p.label, live: true };
      transcript = [
        { role: 'user', text: p.prompt || p.label, ts: p.createdAt || undefined },
        {
          role: 'assistant',
          text: `⏳ Задача ${p.taskId} выполняется на ${p.hostName} (${p.detail})…`,
          host: p.host,
        },
      ];
      lastDispatch = p.taskId ? { host: p.host, taskId: p.taskId } : null;
      if (p.taskId && relay) {
        try {
          const t = await relay.taskGet(p.host, p.taskId);
          if (t && pendingChat?.taskId === p.taskId) {
            if (t.status === 'done') {
              pendingChat = { ...pendingChat, live: false };
              transcript = [
                { role: 'user', text: t.prompt || p.prompt, ts: t.created_at || undefined },
                { role: 'assistant', text: t.result || '(пустой ответ)', host: p.host },
              ];
            } else if (t.status === 'failed') {
              pendingChat = { ...pendingChat, live: false };
              transcript = [
                { role: 'user', text: t.prompt || p.prompt, ts: t.created_at || undefined },
                { role: 'assistant', text: (t.result ? t.result + '\n\n' : '') + '⚠️ ' + (t.error || 'failed'), host: p.host },
              ];
            } else {
              if (t.result) {
                transcript = [
                  { role: 'user', text: t.prompt || p.prompt, ts: t.created_at || undefined },
                  { role: 'assistant', text: t.result + '\n\n⏳ (выполняется…)', host: p.host },
                ];
              }
              const reply = await pollTask(p.host, p.taskId, (liveTask) => {
                if (pendingChat?.taskId === p.taskId && liveTask.result) {
                  transcript = [
                    { role: 'user', text: liveTask.prompt || p.prompt, ts: liveTask.created_at || undefined },
                    { role: 'assistant', text: liveTask.result + '\n\n⏳ (выполняется…)', host: p.host },
                  ];
                }
              });
              if (reply != null && pendingChat?.taskId === p.taskId) {
                pendingChat = { ...pendingChat, live: false };
                transcript = [
                  { role: 'user', text: t.prompt || p.prompt, ts: t.created_at || undefined },
                  { role: 'assistant', text: reply, host: p.host },
                ];
              }
            }
          }
        } catch {}
      }
      return;
    }
    active = null;
    loadedKey = null;
    transcriptError = null;
    loadingTranscript = false;
    pendingChat = { host: p.host, hostName: p.hostName, title: `⏰ ${p.label}` };
    const lastStr = p.lastRun ? new Date(p.lastRun).toLocaleString('ru-RU') : 'ещё не запускалась';
    transcript = [
      {
        role: 'system',
        text: `⏰ Плановая задача «${p.label}» на ${p.hostName}\nРасписание: ${p.detail} · запусков: ${p.runCount} · последний: ${lastStr}${p.command ? `\nКоманда: ${p.command}` : ''}`,
      },
    ];
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

  // Composer is locked ONLY for view-only providers (cline/roo/kilo — no
  // headless resume). A session that is live on the host CAN now be written to
  // in parallel-debug mode: each message spawns its own headless resume
  // (`claude -p --resume` / `opencode run -s`) writing into the same session
  // store (JSONL/SQLite) while the interactive process keeps running. Context
  // may interleave — that's the debugging trade-off.
  const composerLocked = $derived(!!activeDialog && activeDialog.resumable === false);
  const canSend = $derived(activeDialog ? !composerLocked : aiHosts.length > 0);

  // Stop a running/queued autonomous task (from the header or an In-progress card).
  async function cancelTaskItem(host, taskId, ev) {
    if (ev) ev.stopPropagation();
    if (!relay || !host || !taskId) return;
    try {
      const t = await relay.taskCancel(host, taskId);
      inProgress = inProgress.filter((x) => x.taskId !== taskId);
      notify(`Задача ${taskId.slice(0, 8)}… остановлена`, 'ok');
      if (pendingChat?.taskId === taskId) {
        pendingChat = { ...pendingChat, live: false };
        const prev = t?.result ? t.result + '\n\n' : '';
        transcript = [
          transcript[0] || { role: 'user', text: pendingChat.title || taskId },
          { role: 'assistant', text: `${prev}⏹ Остановлено пользователем`, host },
        ];
      }
      await refreshFleet({ silent: true });
    } catch (e) {
      notify('Не удалось остановить: ' + (e?.message || e), 'error');
    }
  }

  // Arm a follow-up subtask on another agent from an In-progress task card.
  function openSubtask(p, ev) {
    if (ev) ev.stopPropagation();
    if (!p?.taskId) return;
    lastDispatch = { host: p.host, taskId: p.taskId };
    openThen();
  }

  async function send() {
    const text = input.trim();
    if (!text || sending || composerLocked) return;
    sending = true;
    try {
      if (pendingChat?.taskId && pendingChat?.live) {
        // Live running task open in the chat pane: try writing directly to its
        // stdin (`task_input`); if the runner closed stdin (one-shot CLI), fall
        // back to queuing a follow-up task on the same host.
        const { host, taskId } = pendingChat;
        input = '';
        transcript = [...transcript, { role: 'user', text }];
        try {
          await relay.taskInput(host, taskId, text);
          notify('Отправлено в stdin выполняющейся задачи', 'ok');
          return;
        } catch {
          const nextId = await relay.taskDispatch(host, text);
          if (nextId) {
            pendingChat = { ...pendingChat, taskId: nextId, live: true };
            lastDispatch = { host, taskId: nextId };
            const reply = await pollTask(host, nextId);
            if (reply != null) transcript = [...transcript, { role: 'assistant', text: reply, host }];
          }
          return;
        }
      }
      if (activeDialog) {
        // Continue an existing provider session on the host that owns it.
        const d = activeDialog;
        transcript = [...transcript, { role: 'user', text }];
        input = '';
        const baseLen = transcript.length;
        const taskId = await relay.sessionResume(d.host, d.provider, d.id, text);
        const reply = await pollTask(d.host, taskId, (liveTask) => {
          if (active === d.key && liveTask.result) {
            transcript = [
              ...transcript.slice(0, baseLen),
              { role: 'assistant', text: liveTask.result + '\n\n⏳ (выполняется…)', host: d.host },
            ];
          }
        });
        if (reply != null) {
          transcript = [
            ...transcript.slice(0, baseLen),
            { role: 'assistant', text: reply, host: d.host },
          ];
        }
      } else {
        // New chat → dispatch to an AI host. Show the message + live streaming
        // output while the host runs the task, then adopt the provider session.
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
        pendingChat = { host, hostName, title: msg.slice(0, 60), live: true };
        transcript = [{ role: 'user', text: msg }];
        const taskId = await relay.taskDispatch(host, msg);
        pendingChat = { host, hostName, taskId, title: msg.slice(0, 60), live: true };
        lastDispatch = taskId ? { host, taskId } : null;
        const reply = await pollTask(host, taskId, (liveTask) => {
          if (pendingChat?.taskId === taskId && liveTask.result) {
            transcript = [
              { role: 'user', text: msg },
              { role: 'assistant', text: liveTask.result + '\n\n⏳ (выполняется…)', host },
            ];
          }
        });
        pendingChat = pendingChat ? { ...pendingChat, live: false } : null;
        if (reply != null) transcript = [{ role: 'user', text: msg }, { role: 'assistant', text: reply, host }];
        // The reply is in — stop the "typing…" indicator now.
        sending = false;
        let fresh = null;
        for (let i = 0; i < 4 && !fresh; i++) {
          await refreshFleet();
          fresh = dialogs.find((d) => d.host === host && !before.has(d.key));
          if (!fresh) await new Promise((r) => setTimeout(r, 1200));
        }
        if (fresh) {
          active = fresh.key;
          pendingChat = null;
        }
      }
    } catch (err) {
      notify('Failed to send: ' + (err.message || err), 'error');
    } finally {
      sending = false;
    }
  }

  // Poll a host for an autonomous task result; calls `onProgress(task)` with
  // partial streaming stdout while `status === 'running'`, and returns the
  // final reply text.
  async function pollTask(host, id, onProgress = null) {
    if (!id) return null;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      let task;
      try {
        task = await relay.taskGet(host, id);
      } catch {
        continue;
      }
      if (!task) continue;
      if (task.status === 'running' && onProgress && task.result) {
        try { onProgress(task); } catch {}
      }
      if (task.status === 'done') return task.result || '';
      if (task.status === 'failed') {
        const prefix = task.result ? task.result + '\n\n' : '';
        return prefix + '⚠️ ' + (task.error || 'error');
      }
    }
    return '⏱️ timed out waiting for a reply';
  }

  // --- Task chains: durable on the HOST (owner-side), shown here -----------
  // Arming goes to the SOURCE host (it becomes the owner: persists the chain
  // in its SQLite, replicates to peers per its own consensus logic, and its
  // owner-tick fires the follow-up within ~10s). The panel only DISPLAYS
  // chains polled from each host — closing this browser changes nothing.
  let hostChains = $state([]); // [{host, hostName, chains: TaskChain[]}]

  // The follow-up spec being composed ("Then…"): {prompt, dstHost}
  let thenPrompt = $state('');
  let thenHost = $state('');
  let showThen = $state(false);

  function openThen() {
    if (!thenHost || !aiHosts.some((a) => a.id === thenHost)) {
      thenHost = aiHosts[0]?.id || '';
    }
    showThen = true;
  }

  async function submitThen(e) {
    e.preventDefault();
    if (!thenPrompt.trim() || !thenHost || !lastDispatch) return;
    // The owner is the host that runs the source task: its local owner-tick
    // watches the task without relay round-trips and fires the follow-up.
    const srcHost = lastDispatch.host;
    try {
      const chain = await relay.chainArm(srcHost, {
        src_agent: srcHost,
        src_task: lastDispatch.taskId,
        dst_agent: thenHost,
        prompt: thenPrompt.trim(),
      });
      if (!chain) {
        notify('Host rejected the chain arm (consensus failed?)', 'error');
        return;
      }
      thenPrompt = '';
      showThen = false;
      notify(`⛓ Chain armed on ${srcHost} — host-owned, survives this tab`, 'success');
      refreshChains();
    } catch (err) {
      notify('Failed to arm chain: ' + (err.message || err), 'error');
    }
  }

  // Pull every executor host's chain list (owner + replica copies).
  async function refreshChains() {
    if (!relay) return;
    const out = [];
    for (const a of executors) {
      try {
        const chains = await relay.chainList(a.id);
        if (chains.length) out.push({ host: a.id, hostName: a.name, chains });
      } catch {}
    }
    hostChains = out;
  }

  async function cancelChain(host, chainId) {
    try {
      await relay.chainCancel(host, chainId);
      refreshChains();
    } catch (err) {
      notify('Failed to cancel: ' + (err.message || err), 'error');
    }
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
    hostChains = [];
    // Keep the encrypted cookie so the next visit only needs the PIN; just drop
    // the in-memory PIN. Use "Forget" in settings to remove the cookie.
    sessionPin = null;
  }
  function onGlobalKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (authed) openSearchModal();
      return;
    }
    if (e.key !== 'Escape') return;
    if (hostMenu) hostMenu = null;
    else if (showSearch) showSearch = false;
    else if (showThen) showThen = false;
    else if (showTunnels) showTunnels = false;
    else if (showSettings) showSettings = false;
    else if (showGraph) showGraph = false;
    else if (showFiles) showFiles = false;
    else if (sidebarOpen) sidebarOpen = false;
  }
</script>

<svelte:window onkeydown={onGlobalKey} />

{#if !authed}
  <Auth onConnect={onConnect} />
{:else}
  <div class="main">
    <!-- Chat pane (left) -->
    <section class="chat" ondragover={onDragOver} ondrop={onDrop}>
      {#if dragOver}
        <div class="dropzone" aria-hidden="true">
          <div class="dropzone-card">
            📥 Отпусти файлы — уйдут на
            <b>{agents.find((a) => a.id === dropTargetHost)?.name || dropTargetHost || '…'}</b>
            и приложатся к сообщению
            <div class="dropzone-note">текстовые файлы до 512 КБ · попадут в /tmp/fleet-… на хосте</div>
          </div>
        </div>
      {/if}
      <header class="bar">
        <div class="bar-left">
          <span class="title-row">
            <strong>{activeDialog ? activeDialog.title : pendingChat?.title || 'New chat'}</strong>
            {#if activeDialog}
              <button
                class="copy-id"
                title="Экспорт диалога в Markdown"
                aria-label="Export dialog"
                onclick={() => exportChat(activeDialog)}
              >📥</button>
              <button
                class="copy-id"
                title={copiedId ? 'Copied!' : `Copy session id (${activeDialog.id})`}
                aria-label="Copy session id"
                onclick={() => copySessionId(activeDialog.id)}
              ><Icon name={copiedId ? 'check' : 'copy'} size={14} draw={false} /></button>
            {/if}
          </span>
          <span class="hosts-count">
            {#if activeDialog}
              {activeDialog.provider} · {activeDialog.hostName}
              {#if activeDialog.cwd} · {activeDialog.cwd}{/if}
              {#if waitingDialogs.has(activeDialog.key)} · <span class="live-tag wait-tag">⏳ ждёт ответа</span>{/if}
              {#if activeDialog.live} · <span class="live-tag">🟡 live · parallel-write</span>{/if}
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
        {:else if pendingChat?.taskId && pendingChat?.live}
          <button class="ghost" onclick={openThen} title="Делегировать подзадачу другому агенту по завершении">⛓ Подзадача</button>
          <button class="ghost danger" onclick={(e) => cancelTaskItem(pendingChat.host, pendingChat.taskId, e)}>⏹ Stop task</button>
        {/if}
        <a class="ghost ic" href="#/" title="Home"><Icon name="home" /><span>Home</span></a>
        <button class="ghost ic" onclick={() => (showFiles = true)} title="Files"><Icon name="folder" /><span>Files</span></button>
        <button class="ghost ic" onclick={() => (showGraph = true)} title="Agent graph"><Icon name="cloud" /><span>Graph</span></button>
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
        {:else if activeDialog && waitingDialogs.has(activeDialog.key)}
          <div class="msg assistant"><div class="bubble waiting wait-banner">
            ⏳ Агент остановился и ждёт ответа ({waitingDialogs.get(activeDialog.key)}).
            Ответь прямо здесь — сообщение продолжит ту же сессию, — либо ответь на хосте.
          </div></div>
        {:else if activeDialog?.live}
          <div class="msg assistant"><div class="bubble dim">
            🟡 Parallel-debug mode: the session is also open on {activeDialog.hostName}.
            Messages sent here run their own headless resume writing into the same
            session store — turns may interleave with the interactive process.
          </div></div>
        {/if}
        {#if loadingTranscript}
          <div class="msg assistant"><div class="bubble dim">Loading dialog…</div></div>
        {:else if transcriptError}
          <div class="msg assistant"><div class="bubble err">
            Failed to load dialog: {transcriptError}
          </div></div>
        {/if}
        {#if activeMention && activeDialog}
          <div class="mention-bar">
            <span>🔍 Упоминание «<b>{activeMention.query}</b>» · сообщ. #{activeMention.seq} ({activeMention.matchCount} в этом чате)</span>
            <div class="mention-acts">
              <button type="button" class="ghost" title="Предыдущее совпадение в окне" onclick={() => stepMentionMark(-1)}>↑ Пред.</button>
              <button type="button" class="ghost" title="Следующее совпадение в окне" onclick={() => stepMentionMark(1)}>↓ След.</button>
              <button type="button" class="ghost" onclick={() => { activeMention = null; loadTranscript(activeDialog, { force: true }); }}>Показать весь чат</button>
              <button type="button" class="ghost" onclick={() => openSearchModal()}>К результатам (Ctrl+K)</button>
            </div>
          </div>
        {/if}
        {#each transcript as m, i}
          {@const isMentionHit = activeMention?.query && m.role !== 'system' && highlightParts(m.text, activeMention.query).some((p) => p.mark)}
          <div class="msg {m.role}">
            <div class="bubble" class:waiting={m.waiting} class:mention-hit={isMentionHit}>
              {#if m.waiting}
                <div class="wait-line">⏳ ждёт вашего ответа · {m.waiting}</div>
              {/if}
              {#if isMentionHit}
                {#each highlightParts(m.text || '…', activeMention.query) as seg}{#if seg.mark}<mark class="hl">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
              {:else}
                {m.text || '…'}
              {/if}
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
              <div class="file-row">
                <button class="file-card" title="Download file" onclick={() => downloadChatFile(host, p)}>
                  <span class="file-card-ic">📄</span>
                  <span class="file-card-name">{p.split(/[\\/]/).pop()}</span>
                  <span class="file-card-dl">Download</span>
                </button>
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
          id="composer-input"
          name="message"
          bind:this={composerEl}
          bind:value={input}
          onkeydown={onComposerKey}
          aria-label="Message to the fleet"
          rows="1"
          placeholder={composerLocked
            ? "This agent's history is view-only"
            : !canSend
              ? 'No AI host in the fleet'
              : pendingChat?.taskId && pendingChat?.live
                ? `Напиши ввод для задачи на ${pendingChat.hostName} (или следующую инструкцию)…`
                : activeDialog
                  ? activeDialog.live
                    ? `Parallel-write into the live session on ${activeDialog.hostName}…`
                    : `Continue on ${activeDialog.hostName}…`
                  : 'Message to the fleet…'}
          disabled={!canSend}
        ></textarea>
        {#if lastDispatch}
          <button
            class="chain-btn"
            onclick={openThen}
            title="When the last task finishes, dispatch a follow-up agent"
          >⛓</button>
        {/if}
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

      <button type="button" class="algolia-trigger" onclick={() => openSearchModal()} title="Поиск по чатам и упоминаниям (Ctrl+K)">
        <span class="alg-left">🔍 <span>{searchQuery || 'Поиск по чатам и упоминаниям…'}</span></span>
        <kbd class="alg-kbd">Ctrl K</kbd>
      </button>

      {#if inProgress.length > 0}
        <div class="sec-title">In progress · {inProgress.length}</div>
        <div class="list compact-list">
          {#each inProgress as p}
            <div
              class="item progress"
              class:cron={p.kind === 'cron'}
              class:on={pendingChat && ((p.taskId && pendingChat.taskId === p.taskId) || pendingChat.title === `⏰ ${p.label}`)}
            >
              <button
                type="button"
                class="progress-open"
                title={p.kind === 'cron' ? `${p.label} (${p.detail}) — нажми для деталей` : `${p.prompt || p.label} — нажми, чтобы открыть`}
                onclick={() => openProgressItem(p)}
              >
                <span class="item-title">{p.kind === 'cron' ? '⏰' : '⚙️'} {p.label}</span>
                <span class="item-meta">
                  <span class="meta-host">{p.hostName}</span>
                  <span class="meta-dot">·</span>
                  <span class="meta-state" class:run={p.detail === 'running'}>{p.detail}</span>
                </span>
              </button>
              {#if p.kind === 'task' && p.taskId}
                <div class="progress-acts">
                  <button
                    type="button"
                    class="prog-act"
                    title="Дать подзадачу другому агенту"
                    aria-label="Chain subtask"
                    onclick={(e) => openSubtask(p, e)}
                  >⛓</button>
                  <button
                    type="button"
                    class="prog-act stop"
                    title="Остановить задачу"
                    aria-label="Stop task"
                    onclick={(e) => cancelTaskItem(p.host, p.taskId, e)}
                  >⏹</button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if hostChains.length > 0}
        <div class="sec-title" title="Chains live on the hosts (owner + replicas); firing happens there, not in this tab">⛓ Chains (on hosts)</div>
        <div class="list compact-list">
          {#each hostChains as hc (hc.host)}
            {@const armed = hc.chains.filter((c) => c.state === 'armed')}
            {@const doneCount = hc.chains.filter((c) => c.state !== 'armed').length}
            {#each armed as c (c.chain_id)}
              <div class="item progress chain" title={c.prompt}>
                <span class="item-title">
                  ⏳
                  {agents.find((a) => a.id === c.src_agent)?.name || c.src_agent}
                  → {agents.find((a) => a.id === c.dst_agent)?.name || c.dst_agent}
                </span>
                <span class="item-meta">
                  <span class="chain-state {c.state}">{c.state}</span>
                  <span class="meta-dot">·</span>
                  <span class="chain-prompt">{(c.prompt || '').slice(0, 40)}</span>
                  {#if c.note}
                    <span class="chain-note" title={c.note}>⚠ {c.note}</span>
                  {/if}
                  <button class="chain-x" onclick={() => cancelChain(hc.host, c.chain_id)}>✕</button>
                </span>
              </div>
            {/each}
            {#if doneCount > 0}
              <div class="muted chain-done" title="Отработанные цепочки (история) не показываются карточками">
                ✅ {doneCount} отработано · {hc.hostName}
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      <div class="sec-title" oncontextmenu={openHostMenu} title="Right-click to filter by provider">
        Dialogs
        {#if loading}<span class="muted">· loading…</span>{/if}
        {#if providerFilter.size}<span class="muted">· {[...providerFilter].join(', ')} ⏷</span>{/if}
        {#if waitingDialogs.size}
          <button class="wait-filter" class:on={onlyWaiting} title="Показать только сессии, ждущие твоего ответа"
            onclick={() => (onlyWaiting = !onlyWaiting)}>⏳ ждут · {waitingDialogs.size}</button>
        {/if}
      </div>
      {#if !loading && dialogs.length === 0}
        <div class="muted">No AI-chat history found in the fleet</div>
      {:else if !loading && visibleDialogs.length === 0}
        {#if onlyWaiting}
          <div class="muted">Никто не ждёт ответа 🎉 — живых сессий с открытым вопросом нет</div>
        {:else}
          <div class="muted">No history from the selected provider(s) · right-click to change</div>
        {/if}
      {/if}
      {#each hostErrors as he}
        <div class="host-err" title={he.error}>
          ⚠️ {he.hostName}: {he.error}
          {#if /decrypt|key/i.test(he.error)}<span class="muted"> — node is on a different token/key (or a stale socket is stuck under the same agent-id)</span>{/if}
        </div>
      {/each}
      <div class="list dialogs-list" oncontextmenu={openHostMenu}>
        {#each visibleDialogs as d}
          <div class="item" class:on={d.key === active}>
            <button class="item-open" onclick={() => openDialog(d)}>
              <span class="item-title">
                {#if d.live}{#if waitingDialogs.has(d.key)}🟠&nbsp;{:else}🟢&nbsp;{/if}{/if}{d.title}
              </span>
              <span class="item-meta">
                <span class="prov {d.provider}">{d.provider}</span> · {d.hostName}{#if d.alsoOn?.length} <span class="also-on" title={`Также на: ${d.alsoOn.join(', ')}`}>+{d.alsoOn.join(',')}</span>{/if}
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

    {#if hostMenu}
      <button class="ctx-backdrop" aria-label="Close menu" onclick={() => (hostMenu = null)}></button>
      <div class="ctx-menu" style="left:{hostMenu.x}px; top:{hostMenu.y}px" role="menu">
        <div class="ctx-head">Show providers</div>
        <button class="ctx-item" role="menuitemcheckbox" aria-checked={providerFilter.size === 0} onclick={clearProviderFilter}>
          <span class="ctx-check">{providerFilter.size === 0 ? '✓' : ''}</span> All providers
        </button>
        {#each filterProviders as p}
          <button class="ctx-item" role="menuitemcheckbox" aria-checked={providerFilter.has(p.provider)} onclick={() => toggleProvider(p.provider)}>
            <span class="ctx-check">{providerFilter.has(p.provider) ? '✓' : ''}</span>
            <span class="ctx-name prov {p.provider}">{p.provider}</span>
            <span class="ctx-dim">{p.count}</span>
          </button>
        {/each}
        {#if filterProviders.length === 0}
          <div class="ctx-head">no history yet</div>
        {/if}
      </div>
    {/if}
  </div>

  {#if showSearch}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="files-overlay search-overlay" onclick={(e) => { if (e.target === e.currentTarget) showSearch = false; }}>
      <div class="alg-modal" role="dialog" aria-label="Search dialogs and mentions" onkeydown={onSearchModalKey}>
        <div class="alg-bar">
          <span class="alg-icon">🔍</span>
          <input
            id="alg-search-input"
            name="search"
            type="text"
            aria-label="Поиск по чатам и сообщениям"
            bind:this={searchInputEl}
            bind:value={searchQuery}
            oninput={onSearchInput}
            placeholder="Искать слова в сообщениях, названия чатов, пути (например: veracrypt, kali, ssh)…"
            autocomplete="off"
          />
          {#if searching}
            <span class="alg-spin">⏳</span>
          {:else if searchQuery}
            <button type="button" class="alg-clear" aria-label="Очистить запрос" onclick={() => { clearSearch(); searchInputEl?.focus(); }}>✕</button>
          {/if}
          <button type="button" class="alg-esc" onclick={() => (showSearch = false)}>ESC</button>
        </div>

        <div class="alg-filters">
          <button type="button" class="alg-chip" class:on={!searchHostFilter} onclick={() => (searchHostFilter = '')}>
            Все хосты ({executors.length})
          </button>
          {#each executors as a}
            <button type="button" class="alg-chip" class:on={searchHostFilter === a.id} onclick={() => (searchHostFilter = searchHostFilter === a.id ? '' : a.id)}>
              @{a.name}
            </button>
          {/each}
        </div>

        <div class="alg-results">
          {#if !searchQuery.trim()}
            <div class="alg-empty">
              <div class="alg-empty-title">Полнотекстовый поиск по истории чатов</div>
              <p>Начни печатать — сразу увидишь упоминания внутри сообщений со всех хостов (BM25) и совпадения по названиям диалогов.</p>
              <div class="alg-recent-head">Недавние диалоги</div>
              {#each visibleDialogs.slice(0, 5) as d, idx}
                <button type="button" class="alg-hit" onclick={() => { showSearch = false; openDialog(d); }}>
                  <div class="alg-hit-top">
                    <span class="alg-hit-title">{d.title}</span>
                    <span class="alg-badges">
                      <span class="prov {d.provider}">{d.provider}</span>
                      <span class="alg-host">{d.hostName}{#if d.alsoOn?.length} +{d.alsoOn.join(',')}{/if}</span>
                    </span>
                  </div>
                  {#if d.cwd}<div class="alg-cwd">{d.cwd}</div>{/if}
                </button>
              {/each}
            </div>
          {:else}
            {#if visibleSearchHits.length > 0}
              <div class="alg-sec-head">
                💬 Упоминания в сообщениях · {visibleSearchHits.length}
                {#if searching}<span class="muted">· обновляется…</span>{/if}
              </div>
              {#each visibleSearchHits as h, idx (h.host + ':' + h.provider + ':' + h.session_id + ':' + (h.seq ?? idx))}
                <button
                  type="button"
                  class="alg-hit"
                  class:selected={searchCursor === idx}
                  onmouseenter={() => (searchCursor = idx)}
                  onclick={() => openSearchHit(h)}
                >
                  <div class="alg-hit-top">
                    <span class="alg-hit-title">
                      {#each highlightParts(h.title || h.session_id, searchQuery) as seg}{#if seg.mark}<mark class="hl">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
                    </span>
                    <span class="alg-badges">
                      <span class="alg-badge-count">{h.match_count || 1} упом. · #{h.seq ?? 0}</span>
                      <span class="prov {h.provider}">{h.provider}</span>
                      <span class="alg-host">{h.hostName}</span>
                    </span>
                  </div>
                  <div class="alg-snippet">
                    <span class="alg-role">{h.role === 'user' ? '👤' : '🤖'}</span>
                    <span>
                      {#each highlightParts(h.snippet || '', searchQuery) as seg}{#if seg.mark}<mark class="hl">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
                    </span>
                  </div>
                  {#if h.cwd}
                    <div class="alg-cwd">{h.cwd}</div>
                  {/if}
                </button>
              {/each}
            {/if}

            {#if titleMatches.length > 0}
              <div class="alg-sec-head">📂 Чаты по названию / пути · {titleMatches.length}</div>
              {#each titleMatches as d, tidx (d.key)}
                {@const rowIdx = visibleSearchHits.length + tidx}
                <button
                  type="button"
                  class="alg-hit"
                  class:selected={searchCursor === rowIdx}
                  onmouseenter={() => (searchCursor = rowIdx)}
                  onclick={() => { showSearch = false; activeMention = null; openDialog(d); }}
                >
                  <div class="alg-hit-top">
                    <span class="alg-hit-title">
                      {#each highlightParts(d.title, searchQuery) as seg}{#if seg.mark}<mark class="hl">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
                    </span>
                    <span class="alg-badges">
                      <span class="prov {d.provider}">{d.provider}</span>
                      <span class="alg-host">{d.hostName}{#if d.alsoOn?.length} +{d.alsoOn.join(',')}{/if}</span>
                    </span>
                  </div>
                  {#if d.cwd}
                    <div class="alg-cwd">
                      {#each highlightParts(d.cwd, searchQuery) as seg}{#if seg.mark}<mark class="hl">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
                    </div>
                  {/if}
                </button>
              {/each}
            {/if}

            {#if !searching && visibleSearchHits.length === 0 && titleMatches.length === 0}
              <div class="alg-empty">
                <div class="alg-empty-title">Ничего не найдено по запросу «{searchQuery}»</div>
                <p>{searchNote || 'Попробуй другое ключевое слово или часть команды/пути.'}</p>
              </div>
            {:else if searching && visibleSearchHits.length === 0 && titleMatches.length === 0}
              <div class="alg-empty">
                <div class="alg-empty-title">⏳ Ищем «{searchQuery}» по всем хостам…</div>
                <p>Первый поиск может занять несколько секунд, пока строится локальный BM25-индекс.</p>
              </div>
            {/if}
          {/if}
        </div>

        <footer class="alg-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> навигация</span>
          <span><kbd>↵</kbd> перейти к упоминанию</span>
          <span><kbd>esc</kbd> закрыть</span>
        </footer>
      </div>
    </div>
  {/if}

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

  {#if showGraph}
    <div class="files-overlay" onclick={(e) => { if (e.target === e.currentTarget) showGraph = false; }}>
      <div class="files-modal">
        <header class="bar">
          <strong>🕸 Agent graph</strong>
          <button class="ghost" onclick={() => (showGraph = false)}>✕ Close</button>
        </header>
        <FleetGraph {agents} fleets={fleetTasks} />
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
          <label for="set-relay">Relay URL</label>
          <input id="set-relay" name="relayUrl" bind:value={setRelay} placeholder="wss://relay-host" autocomplete="off" />
          <label for="set-room">Room</label>
          <input id="set-room" name="room" bind:value={setRoom} placeholder="gpu" autocomplete="off" />
          <label for="set-token">Room key (token)</label>
          <input id="set-token" name="token" bind:value={setToken} type="password" placeholder="••••••" autocomplete="off" />
          <label for="set-pin">New PIN (optional)</label>
          <input id="set-pin" name="newPin" bind:value={setNewPin} type="password" inputmode="numeric" placeholder="leave blank to keep the current one" autocomplete="off" />
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
          <label for="tun-host">Host</label>
          <select id="tun-host" name="tunHost" bind:value={tunHost} onchange={refreshTunnels}>
            {#each executors as a}
              <option value={a.id}>{a.name}</option>
            {/each}
          </select>
          <label for="tun-target">Local target (port or address)</label>
          <div class="tun-start">
            <input
              id="tun-target"
              name="tunTarget"
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

  {#if showThen && lastDispatch}
    <div class="files-overlay" onclick={(e) => { if (e.target === e.currentTarget) showThen = false; }}>
      <form class="settings-modal" onsubmit={submitThen}>
        <header class="bar">
          <strong>⛓ Chain a follow-up agent</strong>
          <button type="button" class="ghost" onclick={() => (showThen = false)}>✕ Close</button>
        </header>
        <div class="settings-body">
          <p class="hint">
            When the last dispatched task (on
            {agents.find((a) => a.id === lastDispatch.host)?.name || lastDispatch.host}) finishes,
            dispatch this prompt to the selected host with the previous result as context.
          </p>
          <label for="then-host">Follow-up host</label>
          <select id="then-host" name="thenHost" bind:value={thenHost}>
            {#each aiHosts as a}
              <option value={a.id}>{a.name}{a.id === lastDispatch.host ? ' (same)' : ''}</option>
            {/each}
          </select>
          <label for="then-prompt">Follow-up prompt</label>
          <textarea
            id="then-prompt"
            name="thenPrompt"
            class="then-text"
            bind:value={thenPrompt}
            placeholder="e.g. Analyze the build log above and fix the failing tests"
            rows="4"
          ></textarea>
          <div class="settings-actions">
            <button type="button" class="ghost" onclick={() => (showThen = false)}>Cancel</button>
            <button type="submit" class="primary" disabled={!thenPrompt.trim() || !thenHost}>
              Arm chain
            </button>
          </div>
        </div>
      </form>
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
    min-width: 0;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .copy-id {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text-dim);
    cursor: pointer;
  }
  .copy-id:hover {
    color: var(--text);
    background: var(--line);
  }
  .ctx-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    padding: 0;
    z-index: 60;
    cursor: default;
  }
  .ctx-menu {
    position: fixed;
    z-index: 61;
    min-width: 190px;
    max-height: 340px;
    overflow: auto;
    padding: 6px;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  }
  .ctx-head {
    font-size: 11px;
    color: var(--text-dim);
    padding: 4px 8px;
  }
  .ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 7px 8px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
  }
  .ctx-item:hover {
    background: var(--bg-hover);
  }
  .ctx-check {
    width: 12px;
    flex: none;
    color: var(--accent);
  }
  .ctx-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ctx-dim {
    flex: none;
    font-size: 11px;
    color: var(--text-dim);
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
  /* Each download card sits on its own full-width row below the bubble (like
     .chat-img) so it never gets pulled beside the bubble and stretched by the
     wrapping flex row. The row carries the 100% basis (no max-width, so it
     genuinely forces a line break); the card keeps its own compact max-width. */
  .file-row {
    flex-basis: 100%;
    display: flex;
  }
  .msg.user .file-row {
    justify-content: flex-end;
  }
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

  /* "Then…" chain button in the composer. */
  .chain-btn {
    background: var(--bg-3);
    border: 1px solid var(--line);
    border-radius: 8px;
    width: 34px;
    height: 34px;
    color: var(--text-dim);
    flex: none;
    display: grid;
    place-items: center;
    cursor: pointer;
    font-size: 15px;
  }
  .chain-btn:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  /* Remove-a-chain ✕ in the sidebar list. */
  .chain-x {
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    padding: 0 2px;
    font-size: 11px;
  }
  .chain-x:hover {
    color: #ff7a7a;
  }
  /* Follow-up prompt textarea in the chain modal. */
  .then-text {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
    color: var(--text);
    font-size: 14px;
    font-family: inherit;
    outline: none;
    resize: vertical;
    min-height: 84px;
  }
  .then-text:focus {
    border-color: var(--accent);
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
  /* Upper sidebar sections (In progress / Chains) must NEVER be crushed to 0px
     by the huge Dialogs list's flex-shrink calculation. */
  .compact-list {
    flex: 0 0 auto;
    max-height: 170px;
  }
  .dialogs-list {
    flex: 1 1 0;
    min-height: 120px;
  }
  .item {
    flex-shrink: 0;
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

  /* --- Fleet-wide dialog search --- */
  .search-box {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-3);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 3px 6px 3px 12px;
    margin-top: 8px;
  }
  .search-box input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: 13.5px;
    padding: 7px 0;
  }
  .search-box input::placeholder {
    color: var(--text-faint);
  }
  .search-go,
  .search-clear {
    background: transparent;
    border: none;
    padding: 6px 7px;
    font-size: 13px;
    cursor: pointer;
    border-radius: 7px;
    flex: none;
  }
  .search-go:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .search-go:hover:not(:disabled),
  .search-clear:hover {
    background: var(--bg-hover);
  }
  .search-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .item.hit {
    width: 100%;
    background: transparent;
    border: none;
    padding: 9px 11px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    text-align: left;
    cursor: pointer;
    border-radius: 9px;
  }
  .item.hit:hover {
    background: var(--bg-hover);
  }
  .hit-snippet {
    font-size: 12px;
    color: var(--text-dim, var(--text-faint));
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* In-progress / chain cards: the two spans STACK (the base `.item` is a
     flex ROW — with them as direct children the meta was pushed out of the
     narrow sidebar and became invisible). */
  .item.progress {
    opacity: 0.95;
    width: 100%;
    background: transparent;
    border-left: 2px solid #e0a23a66;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 4px;
    padding: 4px 6px 4px 10px;
  }
  .item.progress.chain {
    cursor: default;
    flex-direction: column;
    align-items: stretch;
    padding: 8px 11px;
  }
  .progress-open {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    text-align: left;
    padding: 4px 2px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .progress-acts {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .prog-act {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 3px 5px;
    font-size: 11px;
    opacity: 0.65;
    line-height: 1;
  }
  .prog-act:hover {
    opacity: 1;
    background: var(--bg-3);
    border-color: var(--line);
  }
  .prog-act.stop:hover {
    color: #ff8a8a;
    border-color: #ff8a8a55;
  }
  .item.progress.cron {
    border-left-color: var(--line);
  }
  .item.progress .item-title {
    font-size: 13px;
  }
  .item.progress .item-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
  }
  .meta-host {
    color: var(--text-dim);
  }
  .meta-dot {
    color: var(--text-faint);
  }
  .meta-state.run {
    color: #e0a23a;
  }
  .item.progress.chain {
    border-left-color: #3f8f5f55;
  }
  .chain-state.fired {
    color: #6fcf8e;
  }
  .chain-state.armed {
    color: #e0a23a;
  }
  .chain-state.cancelled {
    color: var(--text-faint);
  }
  .chain-prompt {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .chain-note {
    color: #ff8a8a;
    font-size: 10px;
  }
  .chain-done {
    font-size: 10px;
    padding: 4px 11px;
  }
  .also-on {
    font-size: 10px;
    color: var(--text-faint);
    opacity: 0.85;
  }

  /* Algolia-style search trigger & modal */
  .algolia-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 8px 10px;
    color: var(--text-dim);
    font-size: 13px;
    text-align: left;
    transition: border-color 0.15s, background 0.15s;
  }
  .algolia-trigger:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .alg-left {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .alg-kbd {
    flex: none;
    font-size: 10px;
    padding: 2px 5px;
    border-radius: 5px;
    background: var(--bg-3);
    border: 1px solid var(--line);
    color: var(--text-faint);
    font-family: inherit;
  }
  .search-overlay {
    align-items: flex-start;
    padding-top: 7vh;
  }
  .alg-modal {
    width: min(760px, 94vw);
    max-height: 82vh;
    background: var(--bg-2);
    border: 1px solid #4d6bfe55;
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .alg-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
  }
  .alg-icon {
    font-size: 16px;
  }
  .alg-bar input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 16px;
    outline: none;
  }
  .alg-clear,
  .alg-esc {
    background: var(--bg-3);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--text-dim);
    font-size: 11px;
    padding: 3px 7px;
  }
  .alg-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--bg-2);
  }
  .alg-chip {
    background: var(--bg-3);
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .alg-chip.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--text);
  }
  .alg-results {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .alg-sec-head,
  .alg-recent-head {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-faint);
    padding: 6px 6px 2px;
  }
  .alg-hit {
    width: 100%;
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 11px;
    padding: 10px 13px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    transition: border-color 0.12s, background 0.12s;
  }
  .alg-hit:hover,
  .alg-hit.selected {
    background: var(--bg-3);
    border-color: var(--accent);
  }
  .alg-hit-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .alg-hit-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .alg-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font-size: 11px;
  }
  .alg-badge-count {
    background: var(--accent-soft);
    color: #9bb0ff;
    border-radius: 5px;
    padding: 1px 6px;
    font-size: 10px;
  }
  .alg-host {
    color: var(--text-dim);
  }
  .alg-snippet {
    font-size: 13px;
    color: var(--text-dim);
    line-height: 1.45;
    display: flex;
    gap: 6px;
    align-items: baseline;
    word-break: break-word;
  }
  .alg-role {
    flex: none;
    font-size: 12px;
  }
  .alg-cwd {
    font-size: 11px;
    color: var(--text-faint);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .alg-empty {
    padding: 20px 10px;
    color: var(--text-dim);
    font-size: 13px;
  }
  .alg-empty-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 4px;
  }
  .alg-foot {
    display: flex;
    gap: 16px;
    padding: 9px 16px;
    border-top: 1px solid var(--line);
    background: var(--bg);
    font-size: 11px;
    color: var(--text-faint);
  }
  .alg-foot kbd {
    background: var(--bg-3);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 1px 5px;
    margin-right: 3px;
    font-size: 10px;
  }
  mark.hl {
    background: #4d6bfe3d;
    color: #fff;
    padding: 0 3px;
    border-radius: 4px;
    border-bottom: 1px solid #7d94ff;
  }
  mark.hl.current {
    background: #e0a23a66;
    border-bottom: 2px solid #ffd166;
  }
  .mention-bar {
    position: sticky;
    top: 8px;
    z-index: 15;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    margin: 4px 24px 8px;
    padding: 8px 12px;
    background: #1e2235ee;
    backdrop-filter: blur(8px);
    border: 1px solid #4d6bfe88;
    border-radius: 10px;
    font-size: 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .mention-acts {
    display: flex;
    gap: 6px;
  }
  .bubble.mention-hit {
    border: 1px solid #4d6bfeaa;
    box-shadow: 0 0 0 2px #4d6bfe22;
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
  .prov.cursor {
    color: #d6d6d6;
  }
  .prov.codex {
    color: #b8e986;
  }
  .prov.gemini,
  .prov.qwen {
    color: #9ab8ff;
  }
  .prov.goose,
  .prov.continue {
    color: #d6b8ff;
  }
  /* drag-and-drop overlay: covers the chat pane while files are held over
     it; pointer-events:none so the drop itself reaches the pane handler */
  .dropzone {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #4d6bfe1c;
    border: 2px dashed #4d6bfe;
    border-radius: 12px;
    pointer-events: none;
  }
  .dropzone-card {
    background: var(--bg-3);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 18px 26px;
    font-size: 14px;
    text-align: center;
    box-shadow: 0 8px 30px #00000066;
  }
  .dropzone-note {
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-faint);
  }
  .live-tag {
    color: #5ad17f;
  }
  /* needs-you: a live session blocked on a pending question / permission */
  .wait-tag {
    color: #e0a23a;
  }
  .bubble.waiting {
    border-color: #e0a23a88;
  }
  .wait-line {
    color: #e0a23a;
    font-size: 11px;
    margin-bottom: 4px;
  }
  .wait-banner {
    border-color: #e0a23a88;
  }
  .wait-filter {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: #e0a23a;
    font-size: 10px;
    padding: 1px 7px;
    cursor: pointer;
    margin-left: auto;
  }
  .wait-filter.on {
    background: #e0a23a22;
    border-color: #e0a23a;
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
      padding: 10px 12px;
      gap: 6px;
      flex-wrap: wrap;
    }
    .bar-left {
      flex: 1 1 100%;
      min-width: 0;
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
