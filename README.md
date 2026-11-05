# Fleet Chat

**Live:** https://47-ronn.github.io/fleet-chat/

Browser chat client for a **remote-agents** fleet. A DeepSeek/GPT-style dark UI
where the conversation list sits on the **right**; you authenticate with a
**room key**, every dialog stored in the fleet's databases is fetched and
listed, and writing a message dispatches an autonomous task to the answering
host (which runs the AI provider). Select `@hosts` in the composer to have that
host's AI delegate sub-tasks to specific peers.

> This is a **separate project** from the `remote-agents` repository (which is
> published to npm). It must not live inside that repo. Keep it here.

## How it talks to the fleet

- Connects to the relay over WebSocket as an **anonymous observer** (the peer
  model registers a connection without `agent_info` as an unlisted observer
  that can still list the room, send commands, and receive results).
- Command/result payloads are **end-to-end encrypted** in the browser
  (Web Crypto, AES-256-GCM, key = `SHA-256("remote-agents/v1:" + roomToken)`),
  byte-for-byte compatible with the Rust `Cipher`.
- Dialogs = each host's autonomous tasks (`task_list`); sending = `task_dispatch`.
- The dialog sidebar has a **fleet-wide full-text search** (🔍): every host
  answers from its local BM25 index of provider transcripts
  (`session_search`), hits merge by score, and a click opens the cited
  context window (`session_get { around_seq }`).

## Run

```bash
npm install
npm run dev      # http://localhost:5180 (also reachable from LAN/VMs,
                 #  e.g. http://192.168.122.1:5180)
npm run build    # static bundle in dist/ (host anywhere, e.g. a CF Pages site)
```

Browsers only expose `crypto.subtle` (the E2E engine) in secure contexts —
https or localhost. On plain http (dev from LAN/VMs) the app transparently
falls back to a pure-JS WebCrypto (`@peculiar/webcrypto`, wire-compatible
AES-256-GCM/SHA-256/PBKDF2); on https it stays native. Relay URLs may then be
`ws://` (no mixed-content blocks on an http page).

Log in with the relay URL, room name, and the room token (e.g.
`wss://<relay>` / `gpu` / `<token>`).

## Status / limitations

- Multi-turn: each message currently creates one autonomous task (one
  prompt → one result); threading several turns into a task chain is a TODO.
- **Live-session parallel write:** a dialog that is live on its host (a human
  or agent drives it there) can now ALSO be written to from the web — each
  message spawns its own headless resume (`claude -p --resume` /
  `opencode run -s`) writing into the same session store. Turns may interleave;
  that is the debugging trade-off (🟡 badge in the header).
- **Agent graph** (🕸 button): nodes = fleet hosts + a virtual `🌐 browser`
  node; edges = autonomous tasks aggregated consumer → executor (from each
  task's `initiator`), colored by status (running/queued/done/failed). Click a
  node to list its tasks split by role: executes (executor), ordered on peers
  (consumer), or sub-agent (executes only, never orders).
- **Chains (⛓):** after sending a new-chat task, the ⛓ button arms a
  follow-up — when the source task finishes, the panel dispatches your prompt
  to a chosen host with the previous result as context. Chains persist in
  localStorage per room; the sidebar shows waiting/fired chains.
- The AI provider token lives **on the answering host** (its autonomous runner),
  never in the browser — the browser only sends the prompt.
- Result is polled via `task_get` until the host marks the task done/failed.
