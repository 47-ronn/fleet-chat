// Wire adapter: protobuf <-> the panel's internal message shapes used by
// relay.js. The relay protocol is binary protobuf (generated from the shared
// proto/remote_agents.proto, copied to ./gen). This mirrors the Rust
// `proto_convert.rs` / worker `wire.ts` strategy: relay.js keeps switching on
// `msg.type`, and only this module touches the protobuf encoding.
//
// The panel only SENDS auth / list_agents / command and RECEIVES the relay's
// server messages, so only those directions are implemented. Encrypted
// `payload`/`result` are raw bytes (Uint8Array) on the wire — no base64.

import * as pb from './gen/remote_agents.ts';

const MODE_FROM_PB = ['plan', 'edit', 'bypass', 'disabled'];
const STATUS_FROM_PB = ['queued', 'running', 'done', 'failed'];

function modeFromPb(m) {
  return MODE_FROM_PB[m] ?? 'plan';
}

function agentInfoFromPb(a) {
  if (!a) return null;
  return {
    id: a.id,
    name: a.name,
    mode: modeFromPb(a.mode),
    os: a.os,
    arch: a.arch,
    hostname: a.hostname,
    tags: a.tags ?? [],
    platform: a.platform
      ? {
          family: a.platform.family,
          arch: a.platform.arch,
          distro: a.platform.distro,
          kernel: a.platform.kernel,
          shell: a.platform.shell,
        }
      : undefined,
    autonomous: a.autonomous,
    accepts_commands: a.acceptsCommands,
    version: a.version,
    update_available: a.updateAvailable,
    connections: a.connections,
    connected_at: a.connectedAt,
    session_id: a.sessionId,
  };
}

function agentEventFromPb(e) {
  const tc = e?.kind?.$case === 'taskCompleted' ? e.kind.taskCompleted : undefined;
  return {
    event: 'task_completed',
    task_id: tc?.taskId ?? '',
    status: STATUS_FROM_PB[tc?.status ?? 0] ?? 'queued',
  };
}

function targetToPb(t) {
  switch (t?.type) {
    case 'agent':
      return { kind: { $case: 'agent', agent: { id: t.id } } };
    case 'tagged':
      return { kind: { $case: 'tagged', tagged: { tags: t.tags ?? [] } } };
    case 'platform':
      return { kind: { $case: 'platform', platform: { family: t.family } } };
    default:
      return { kind: { $case: 'all', all: {} } };
  }
}

/** Encode one of the panel's outbound messages (auth/list_agents/command). */
export function encodeClientMessage(m) {
  let kind;
  switch (m.type) {
    case 'auth':
      kind = { $case: 'auth', auth: { room: m.room, token: m.token, agentInfo: undefined } };
      break;
    case 'list_agents':
      kind = { $case: 'listAgents', listAgents: {} };
      break;
    case 'command':
      kind = {
        $case: 'command',
        command: {
          requestId: m.request_id,
          target: targetToPb(m.target),
          payload: m.payload, // Uint8Array (raw encrypted bytes)
        },
      };
      break;
    case 'ping':
      kind = { $case: 'ping', ping: {} };
      break;
    default:
      throw new Error(`cannot encode client message: ${m.type}`);
  }
  return pb.ClientMessage.encode(pb.ClientMessage.fromPartial({ kind })).finish();
}

/** Decode a binary ServerMessage frame into the panel's internal JS shape. */
export function decodeServerMessage(buf) {
  const m = pb.ServerMessage.decode(buf);
  const k = m.kind;
  switch (k?.$case) {
    case 'authOk':
      return { type: 'auth_ok', session_id: k.authOk.sessionId };
    case 'authFailed':
      return { type: 'auth_failed', reason: k.authFailed.reason };
    case 'agentList':
      return { type: 'agent_list', agents: (k.agentList.agents ?? []).map(agentInfoFromPb) };
    case 'agentJoined':
      return { type: 'agent_joined', agent: agentInfoFromPb(k.agentJoined.agent) };
    case 'agentLeft':
      return { type: 'agent_left', agent_id: k.agentLeft.agentId };
    case 'agentModeChanged':
      return {
        type: 'agent_mode_changed',
        agent_id: k.agentModeChanged.agentId,
        mode: modeFromPb(k.agentModeChanged.mode),
      };
    case 'commandResult':
      return {
        type: 'command_result',
        request_id: k.commandResult.requestId,
        agent_id: k.commandResult.agentId,
        result: k.commandResult.result, // Uint8Array (raw encrypted bytes)
      };
    case 'commandError':
      return {
        type: 'command_error',
        request_id: k.commandError.requestId,
        agent_id: k.commandError.agentId,
        error: k.commandError.error,
      };
    case 'event':
      return { type: 'event', agent_id: k.event.agentId, event: agentEventFromPb(k.event.event) };
    case 'yourEndpoint':
      return { type: 'your_endpoint' };
    case 'pong':
      return { type: 'pong' };
    case 'error':
      return { type: 'error', message: k.error.message };
    default:
      // udp_* and anything else the panel doesn't act on.
      return { type: k?.$case ?? 'unknown' };
  }
}
