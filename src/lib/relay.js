// WebSocket client to a remote-agents relay, joining as an ANONYMOUS observer
// (no agent_info → the peer-model relay registers it as an unlisted observer
// that can list the room, send commands, and receive results routed back).
//
// Protocol mirror of crates/shared/src/protocol.rs:
//   ClientMessage tag = "type" (snake_case); Command envelope tag = "cmd";
//   CommandResult tag = "result_type". Command/result payloads are E2E-encrypted.

import { deriveKey, encryptStr, decryptStr } from './crypto.js';

let reqCounter = 0;
const nextReqId = () => `web-${Date.now()}-${reqCounter++}`;

// Decode a base64 string to raw bytes (file chunks arrive base64'd in JSON).
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export class Relay {
  constructor(relayUrl, room, token, overrideKey) {
    this.relayUrl = relayUrl.replace(/\/$/, '');
    this.room = room;
    this.token = token;
    this.overrideKey = overrideKey || null;
    this.ws = null;
    this.key = null;
    this.sessionId = null;
    this.pendingCmds = new Map(); // request_id -> { resolve, reject }
    this.pendingList = null; // resolver for the next agent_list
    this.onError = () => {};
    // Push notifications from the relay so the UI can react live (no polling):
    //   onAgentChange({kind:'joined'|'left'|'mode', agent?, id?, mode?})
    //   onEvent(msg)  — an agent's unsolicited event (e.g. task_completed)
    this.onAgentChange = () => {};
    this.onEvent = () => {};
  }

  async connect() {
    this.key = await deriveKey(this.token, this.overrideKey);
    const url = `${this.relayUrl}/ws/room/${encodeURIComponent(
      this.room
    )}?token=${encodeURIComponent(this.token)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('connection timeout')), 10000);

      ws.onopen = () => {
        // Auth as an anonymous observer (no agent_info).
        ws.send(JSON.stringify({ type: 'auth', room: this.room, token: this.token }));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('websocket error (check relay URL / network)'));
      };
      ws.onclose = () => {
        this.onError(new Error('connection closed'));
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === 'auth_ok') {
          this.sessionId = msg.session_id;
          clearTimeout(timer);
          resolve(this.sessionId);
          return;
        }
        if (msg.type === 'auth_failed') {
          clearTimeout(timer);
          reject(new Error(msg.reason || 'auth failed'));
          return;
        }
        this._dispatch(msg);
      };
    });
  }

  _dispatch(msg) {
    switch (msg.type) {
      case 'agent_list':
        if (this.pendingList) {
          this.pendingList(msg.agents || []);
          this.pendingList = null;
        }
        break;
      case 'command_result': {
        const p = this.pendingCmds.get(msg.request_id);
        if (p) {
          this.pendingCmds.delete(msg.request_id);
          p.resolve(msg.result);
        }
        break;
      }
      case 'command_error': {
        const p = this.pendingCmds.get(msg.request_id);
        if (p) {
          this.pendingCmds.delete(msg.request_id);
          p.reject(new Error(msg.error || 'command error'));
        }
        break;
      }
      case 'agent_joined':
        if (msg.agent) this.onAgentChange({ kind: 'joined', agent: msg.agent });
        break;
      case 'agent_left':
        this.onAgentChange({ kind: 'left', id: msg.agent_id });
        break;
      case 'agent_mode_changed':
        this.onAgentChange({ kind: 'mode', id: msg.agent_id, mode: msg.mode });
        break;
      case 'event':
        this.onEvent(msg);
        break;
      // your_endpoint — ignored.
    }
  }

  listAgents(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      this.pendingList = resolve;
      this.ws.send(JSON.stringify({ type: 'list_agents' }));
      setTimeout(() => {
        if (this.pendingList) {
          this.pendingList = null;
          reject(new Error('list_agents timed out'));
        }
      }, timeoutMs);
    });
  }

  // Send an encrypted command to a single agent and await its decrypted result.
  async sendCommand(agentId, command, timeoutMs = 30000) {
    const requestId = nextReqId();
    const payload = await encryptStr(this.key, JSON.stringify(command));
    const result = await new Promise((resolve, reject) => {
      this.pendingCmds.set(requestId, { resolve, reject });
      this.ws.send(
        JSON.stringify({
          type: 'command',
          request_id: requestId,
          target: { type: 'agent', id: agentId },
          payload,
        })
      );
      setTimeout(() => {
        if (this.pendingCmds.has(requestId)) {
          this.pendingCmds.delete(requestId);
          reject(new Error('command timed out'));
        }
      }, timeoutMs);
    });
    return JSON.parse(await decryptStr(this.key, result));
  }

  async taskList(agentId) {
    const res = await this.sendCommand(agentId, { cmd: 'task_list' }, 8000);
    return res.result_type === 'task_list' ? res.tasks || [] : [];
  }

  async taskDispatch(agentId, prompt) {
    const res = await this.sendCommand(agentId, {
      cmd: 'task_dispatch',
      prompt,
      initiator: 'browser',
    });
    return res.result_type === 'task_queued' ? res.id : null;
  }

  async taskGet(agentId, id) {
    const res = await this.sendCommand(agentId, { cmd: 'task_get', id });
    return res.result_type === 'task' ? res.task : null;
  }

  async scheduleList(agentId) {
    const res = await this.sendCommand(agentId, { cmd: 'schedule_list' }, 8000);
    return res.result_type === 'schedule' ? res.tasks || [] : [];
  }

  // --- AI-provider sessions (claude / opencode history) ---

  async sessionList(agentId) {
    const res = await this.sendCommand(agentId, { cmd: 'session_list' }, 20000);
    if (res.result_type !== 'session_list') return { sessions: [], active: [] };
    return { sessions: res.sessions || [], active: res.active || [] };
  }

  async sessionGet(agentId, provider, id) {
    const res = await this.sendCommand(
      agentId,
      { cmd: 'session_get', provider, id },
      20000
    );
    return res.result_type === 'session_transcript' ? res.messages || [] : [];
  }

  async sessionResume(agentId, provider, id, prompt) {
    const res = await this.sendCommand(agentId, {
      cmd: 'session_resume',
      provider,
      id,
      prompt,
    });
    return res.result_type === 'task_queued' ? res.id : null;
  }

  async sessionTerminate(agentId, id) {
    await this.sendCommand(agentId, { cmd: 'session_terminate', id });
  }

  // --- File search, preview, and chunked download ---

  // Search files on a host. kind = 'name' | 'content' | 'image'. Empty roots →
  // the host's default roots (home + Pictures/Documents/Downloads/Desktop).
  async fileSearch(agentId, query, kind = 'name', roots = []) {
    const res = await this.sendCommand(
      agentId,
      { cmd: 'file_search', roots, query, kind },
      30000
    );
    return res.result_type === 'file_search' ? res.hits || [] : [];
  }

  // Metadata for one file (size / mime / is_image), no body.
  async fileStat(agentId, path) {
    const res = await this.sendCommand(agentId, { cmd: 'file_stat', path }, 15000);
    return res.result_type === 'file_meta' ? res.meta : null;
  }

  // Base64 JPEG preview of an image (or null if it isn't a decodable image).
  async fileThumb(agentId, path, maxPx = 256) {
    try {
      const res = await this.sendCommand(
        agentId,
        { cmd: 'file_thumb', path, max_px: maxPx },
        20000
      );
      return res.result_type === 'file_thumb'
        ? { data: res.data, w: res.w, h: res.h }
        : null;
    } catch {
      return null; // not an image / no decoder on the host
    }
  }

  // One binary-safe slice [offset, offset+len) → { bytes: Uint8Array, eof }.
  async fileChunk(agentId, path, offset, len) {
    const res = await this.sendCommand(
      agentId,
      { cmd: 'file_chunk', path, offset, len },
      30000
    );
    if (res.result_type !== 'file_chunk') throw new Error('unexpected chunk reply');
    return { bytes: b64ToBytes(res.data), eof: res.eof };
  }

  // Pull a whole file and assemble a Blob. Each chunk is its own request (fits
  // the relay's ~1 MiB frame limit). onProgress(received, total).
  //
  // When `size` is known, requests run in a bounded concurrent window so the
  // round-trips overlap (a large file no longer pays full relay latency per
  // chunk); chunks are reassembled in offset order. Without a size, falls back
  // to a sequential eof-driven loop.
  async downloadFile(agentId, path, { mime, size, onProgress, concurrency = 4 } = {}) {
    const CHUNK = 256 * 1024;

    if (!size) {
      const parts = [];
      let offset = 0;
      for (;;) {
        const { bytes, eof } = await this.fileChunk(agentId, path, offset, CHUNK);
        parts.push(bytes);
        offset += bytes.length;
        if (onProgress) onProgress(offset, 0);
        if (eof || bytes.length === 0) break;
      }
      return new Blob(parts, mime ? { type: mime } : undefined);
    }

    const nChunks = Math.ceil(size / CHUNK);
    const parts = new Array(nChunks);
    let received = 0;
    // Process in windows of `concurrency` so at most N requests are in flight.
    for (let base = 0; base < nChunks; base += concurrency) {
      const batch = [];
      for (let j = base; j < Math.min(base + concurrency, nChunks); j++) {
        batch.push(
          this.fileChunk(agentId, path, j * CHUNK, CHUNK).then(({ bytes }) => {
            parts[j] = bytes;
            received += bytes.length;
            if (onProgress) onProgress(received, size);
          })
        );
      }
      await Promise.all(batch);
    }
    return new Blob(parts, mime ? { type: mime } : undefined);
  }

  // --- Host↔host transfer ---

  // Ask `agentId` to send one of its local files to another host. Returns a
  // transfer id; poll progress with transferGet(agentId, id).
  async sendFileTo(agentId, srcPath, destId, destPath) {
    const res = await this.sendCommand(agentId, {
      cmd: 'send_file_to',
      src_path: srcPath,
      dest_id: destId,
      dest_path: destPath,
    });
    return res.result_type === 'transfer_queued' ? res.id : null;
  }

  async transferGet(agentId, id) {
    const res = await this.sendCommand(agentId, { cmd: 'transfer_get', id }, 8000);
    return res.result_type === 'transfer' ? res.status : null;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}
