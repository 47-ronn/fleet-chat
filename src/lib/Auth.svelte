<script>
  import { hasStoredCreds, loadCreds, clearCreds } from './creds.js';

  let { onConnect } = $props();

  // 'pin'   — an encrypted cookie exists → ask only for the PIN.
  // 'setup' — no cookie (or "use other") → full form + create a PIN.
  let mode = $state(hasStoredCreds() ? 'pin' : 'setup');

  let relayUrl = $state('wss://remote-agents-relay.pointg.workers.dev');
  let room = $state('');
  let token = $state('');
  let pin = $state('');
  let pin2 = $state('');
  let busy = $state(false);
  let error = $state('');

  const PIN_MIN = 4;

  // Returning visit: decrypt the cookie with the PIN, then connect.
  async function submitPin(e) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      const creds = await loadCreds(pin); // throws 'invalid PIN'
      await onConnect({ ...creds, pin }); // connect (+ refresh the cookie)
    } catch (err) {
      error = err.message || String(err);
    } finally {
      busy = false;
    }
  }

  // First visit: validate the new PIN, connect, then the parent stores the cookie.
  async function submitSetup(e) {
    e.preventDefault();
    error = '';
    if (pin.length < PIN_MIN) {
      error = `PIN must be at least ${PIN_MIN} characters`;
      return;
    }
    if (pin !== pin2) {
      error = 'PINs do not match';
      return;
    }
    busy = true;
    try {
      await onConnect({ relayUrl, room, token, pin });
    } catch (err) {
      error = err.message || String(err);
    } finally {
      busy = false;
    }
  }

  function useOther() {
    clearCreds();
    mode = 'setup';
    error = '';
    pin = '';
    pin2 = '';
  }
</script>

<div class="auth-wrap">
  {#if mode === 'pin'}
    <form class="card" onsubmit={submitPin}>
      <h1>Fleet&nbsp;Chat</h1>
      <p class="sub">Enter your PIN to decrypt your saved data</p>

      <label>PIN</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={pin}
        type="password"
        inputmode="numeric"
        autocomplete="off"
        placeholder="••••"
        autofocus
      />

      {#if error}<div class="err">{error}</div>{/if}

      <button type="submit" disabled={busy || !pin}>
        {busy ? 'Connecting…' : 'Sign in'}
      </button>
      <button type="button" class="link" onclick={useOther}>
        Use different credentials
      </button>
    </form>
  {:else}
    <form class="card" onsubmit={submitSetup}>
      <h1>Fleet&nbsp;Chat</h1>
      <p class="sub">Connect to the fleet and create a PIN</p>

      <label>Relay URL</label>
      <input bind:value={relayUrl} placeholder="wss://relay-host" autocomplete="off" />

      <label>Room</label>
      <input bind:value={room} placeholder="room name" autocomplete="off" />

      <label>Room key (token)</label>
      <input bind:value={token} type="password" placeholder="••••••" autocomplete="off" />

      <label>Create a PIN (≥{PIN_MIN})</label>
      <input
        bind:value={pin}
        type="password"
        inputmode="numeric"
        placeholder="••••"
        autocomplete="off"
      />

      <label>Repeat PIN</label>
      <input
        bind:value={pin2}
        type="password"
        inputmode="numeric"
        placeholder="••••"
        autocomplete="off"
      />

      <p class="hint">
        The token is encrypted with your PIN and stored in a cookie for 180 days.
        The PIN itself is never saved — without it, the cookie is useless.
      </p>

      {#if error}<div class="err">{error}</div>{/if}

      <button type="submit" disabled={busy || !room.trim() || !token || !pin}>
        {busy ? 'Connecting…' : 'Save and sign in'}
      </button>
    </form>
  {/if}
</div>

<style>
  .auth-wrap {
    display: grid;
    place-items: center;
    height: 100%;
  }
  .card {
    width: 360px;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 32px 28px;
    display: flex;
    flex-direction: column;
  }
  h1 {
    margin: 0;
    font-size: 26px;
    letter-spacing: -0.5px;
  }
  .sub {
    margin: 6px 0 22px;
    color: var(--text-dim);
    font-size: 14px;
  }
  label {
    font-size: 12px;
    color: var(--text-dim);
    margin: 12px 0 6px;
  }
  input {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 11px 13px;
    color: var(--text);
    font-size: 14px;
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
  }
  .hint {
    margin: 14px 0 0;
    color: var(--text-faint);
    font-size: 12px;
    line-height: 1.5;
  }
  button {
    margin-top: 22px;
    background: var(--accent);
    border: none;
    border-radius: 10px;
    padding: 12px;
    color: #fff;
    font-size: 15px;
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.link {
    margin-top: 10px;
    background: transparent;
    color: var(--text-dim);
    font-weight: 400;
    font-size: 13px;
  }
  button.link:hover {
    color: var(--text);
  }
  .err {
    margin-top: 14px;
    color: #ff7a7a;
    font-size: 13px;
  }
</style>
