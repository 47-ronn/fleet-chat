<script>
  // "Share room" modal: hand this room to another device in one scan.
  //
  //  - QR: an encrypted join link (#/app/join/<payload>) — AES-GCM under a
  //    PBKDF2 key from a 6-digit code, TTL 2 minutes. Scan with a phone,
  //    type the code, you're in the panel — the token never travels as plain
  //    base64 through a camera app.
  //  - Bootstrap scripts (sh / ps1): `remote-agent share`-style one-liners
  //    that install the agent binary on a fresh host and join this room.
  import { buildSharePayload, SHARE_TTL_MS } from './share.js';
  import { qrMatrix } from './qr.js';

  let { creds, onclose } = $props();

  let tab = $state('qr'); // 'qr' | 'sh' | 'ps1'
  let code = $state('');
  let joinUrl = $state('');
  let expires = $state(0);
  let ttlLeft = $state(0);
  let err = $state('');
  let busy = $state(false);

  let ttlTimer = null;

  // Regenerate: fresh code, fresh salt, fresh 2-minute window.
  async function regen() {
    busy = true;
    err = '';
    try {
      const { payload, code: c, exp } = await buildSharePayload(creds);
      code = c;
      expires = exp;
      const base = `${location.origin}${location.pathname}`;
      joinUrl = `${base}#/app/join/${payload}`;
      ttlLeft = Math.max(0, Math.ceil((exp - Date.now()) / 1000));
      clearInterval(ttlTimer);
      ttlTimer = setInterval(() => {
        ttlLeft = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
        if (ttlLeft <= 0) clearInterval(ttlTimer);
      }, 500);
    } catch (e) {
      err = String(e?.message || e);
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    regen();
    return () => clearInterval(ttlTimer);
  });

  // --- bootstrap scripts (mirror of `remote-agent share`, client-side) -----
  // The b64 config matches the CLI format: URL-safe JSON {room, token,
  // relay_url, ...} that `run --bootstrap` decodes.
  function b64cfg() {
    const obj = {
      room: creds.room,
      token: creds.token,
      relay_url: creds.relayUrl,
      accepts_commands: true,
    };
    const json = JSON.stringify(obj);
    const b = new TextEncoder().encode(json);
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const REPO = '47-ronn/remote-agents-mcp';
  const b64 = $derived(b64cfg());

  const shScript = $derived(`#!/bin/sh
set -eu
os="$(uname -s)"; arch="$(uname -m)"
case "$os:$arch" in
  Linux:x86_64)  target=x86_64-unknown-linux-musl ;;
  Linux:aarch64) target=aarch64-unknown-linux-musl ;;
  Darwin:x86_64) target=x86_64-apple-darwin ;;
  Darwin:arm64)  target=aarch64-apple-darwin ;;
  *) echo "unsupported platform: $os $arch" >&2; exit 1 ;;
esac
dir="\${TMPDIR:-/tmp}/remote-agent-bootstrap"
mkdir -p "$dir"
bin="$dir/remote-agent"
curl -fsSL --retry 3 -o "$bin" "https://github.com/${REPO}/releases/latest/download/remote-agent-$target"
chmod +x "$bin"
exec "$bin" run --bootstrap '${b64}'`);

  const ps1Script = $derived(`$ErrorActionPreference = 'Stop'
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') { throw "unsupported architecture: $arch" }
$dir = Join-Path $env:TEMP 'remote-agent-bootstrap'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bin = Join-Path $dir 'remote-agent.exe'
Invoke-WebRequest -Uri "https://github.com/${REPO}/releases/latest/download/remote-agent-x86_64-pc-windows-msvc.exe" -OutFile $bin -UseBasicParsing
& $bin run --bootstrap '${b64}'`);

  let copied = $state('');
  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      setTimeout(() => (copied = ''), 1500);
    } catch {
      err = 'clipboard unavailable — select and copy manually';
    }
  }

  // QR matrix (null while regenerating)
  let matrix = $state(null);
  $effect(() => {
    if (joinUrl && tab === 'qr') {
      try {
        matrix = qrMatrix(joinUrl);
      } catch {
        matrix = null;
      }
    }
  });
  $effect(() => {
    if (tab !== 'qr') matrix = null;
  });
</script>

<div class="modal-backdrop" onclick={onclose} role="presentation">
  <div class="share-modal card" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Share room">
    <header class="bar">
      <strong>🔗 Share room <span class="room">«{creds.room}»</span></strong>
      <button class="ghost ic icon-only" onclick={onclose} aria-label="Close">✕</button>
    </header>

    <div class="tabs">
      <button class:on={tab === 'qr'} onclick={() => (tab = 'qr')}>📱 Phone (QR)</button>
      <button class:on={tab === 'sh'} onclick={() => (tab = 'sh')}>🐧 sh (Linux/macOS)</button>
      <button class:on={tab === 'ps1'} onclick={() => (tab = 'ps1')}>🪟 ps1 (Windows)</button>
    </div>

    {#if tab === 'qr'}
      <div class="qr-pane">
        {#if ttlLeft > 0 && matrix}
          <div class="qr-frame">
            {#each matrix as row}
              <div class="qr-row">
                {#each row as dark}<span class:dark></span>{/each}
              </div>
            {/each}
          </div>
          <div class="code-line">
            code: <code class="code">{code.slice(0, 3)}&thinsp;{code.slice(3)}</code>
            <span class="ttl" class:expired={ttlLeft <= 30}>⏱ {Math.floor(ttlLeft / 60)}:{String(ttlLeft % 60).padStart(2, '0')}</span>
          </div>
          <p class="hint">
            Scan → открой ссылку → введи код → ты в комнате. Ссылка шифруется (AES-GCM + код)
            и живёт <b>2 минуты</b>. Токен не летит открытым текстом через камеру.
          </p>
          <div class="actions">
            <button class="ghost" onclick={() => copy(joinUrl, 'url')}>{copied === 'url' ? '✓ copied' : 'copy link'}</button>
            <button class="ghost" onclick={() => copy(code, 'code')}>{copied === 'code' ? '✓ copied' : 'copy code'}</button>
            <button class="ghost" disabled={busy} onclick={regen}>↻ new code</button>
          </div>
        {:else}
          <div class="expired-box">
            <p>⌛ Ссылка истекла (TTL 2 мин).</p>
            <button class="primary" onclick={regen}>Сгенерировать новую</button>
          </div>
        {/if}
      </div>
    {:else if tab === 'sh'}
      <div class="script-pane">
        <p class="hint">Вставь на чистом хосте — скачает последний бинарник с GitHub и сразу войдёт в комнату:</p>
        <pre><code>{shScript}</code></pre>
        <div class="actions">
          <button class="ghost" onclick={() => copy(shScript, 'sh')}>{copied === 'sh' ? '✓ copied' : 'copy script'}</button>
          <span class="hint-inline">bash: <code>ssh host sh &lt; script.sh</code> или просто вставь целиком</span>
        </div>
      </div>
    {:else}
      <div class="script-pane">
        <p class="hint">PowerShell (Windows) — вставь и запусти:</p>
        <pre><code>{ps1Script}</code></pre>
        <div class="actions">
          <button class="ghost" onclick={() => copy(ps1Script, 'ps1')}>{copied === 'ps1' ? '✓ copied' : 'copy script'}</button>
        </div>
      </div>
    {/if}

    {#if err}<div class="err">{err}</div>{/if}
    <p class="warn">⚠️ скрипт и ссылка несут room token открытым текстом (base64) — обращайся как с паролем.</p>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    z-index: 60;
  }
  .share-modal {
    width: 420px;
    max-width: 92vw;
    max-height: 88vh;
    overflow: auto;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 14px 18px 18px;
  }
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .room { color: var(--text-dim); font-weight: 400; }
  .tabs {
    display: flex;
    gap: 6px;
    margin: 12px 0;
  }
  .tabs button {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 8px 4px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .tabs button.on {
    border-color: var(--accent);
    color: var(--text);
  }
  .qr-pane { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .qr-frame {
    background: #fff;
    padding: 12px;
    border-radius: 12px;
  }
  .qr-row { display: flex; }
  .qr-row span { width: 3px; height: 3px; }
  .qr-row span.dark { background: #000; }
  .code-line { font-size: 16px; letter-spacing: 2px; display: flex; gap: 12px; align-items: center; }
  .code { font-size: 22px; font-weight: 700; color: var(--accent); }
  .ttl { font-size: 12px; color: var(--text-dim); }
  .ttl.expired { color: #ff7a7a; }
  .hint { color: var(--text-faint); font-size: 12px; line-height: 1.5; text-align: center; }
  .actions { display: flex; gap: 8px; margin-top: 6px; }
  .actions .ghost {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 8px 12px;
    color: var(--text);
    font-size: 13px;
  }
  .primary {
    background: var(--accent);
    border: none;
    border-radius: 9px;
    padding: 10px 16px;
    color: #fff;
    font-weight: 600;
  }
  .script-pane pre {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px;
    font-size: 11px;
    line-height: 1.45;
    overflow: auto;
    max-height: 34vh;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .hint-inline { font-size: 11px; color: var(--text-faint); align-self: center; }
  .expired-box { text-align: center; display: flex; flex-direction: column; gap: 10px; padding: 18px 0; }
  .err { color: #ff7a7a; font-size: 13px; margin-top: 8px; }
  .warn { color: #e8b34b; font-size: 11px; margin: 12px 0 0; text-align: center; }
</style>