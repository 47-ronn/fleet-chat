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

## Run

```bash
npm install
npm run dev      # http://localhost:5180
npm run build    # static bundle in dist/ (host anywhere, e.g. a CF Pages site)
```

Log in with the relay URL, room name, and the room token (e.g.
`wss://<relay>` / `gpu` / `<token>`).

## Status / limitations

- Multi-turn: each message currently creates one autonomous task (one
  prompt → one result); threading several turns into a task chain is a TODO.
- The AI provider token lives **on the answering host** (its autonomous runner),
  never in the browser — the browser only sends the prompt.
- Result is polled via `task_get` until the host marks the task done/failed.
