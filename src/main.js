import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { ensureWebCrypto } from './lib/webcrypto-fallback.js';

// The panel's E2E crypto runs on `crypto.subtle`, which browsers only expose
// in a secure context (https or localhost). Dev serves the panel over plain
// http://<LAN-IP> on purpose, so before mounting we make sure Web Crypto
// exists — installing a pure-JS fallback on insecure origins (see
// webcrypto-fallback.js). Wrapped in an async IIFE so `vite build`'s default
// ES2020 target compiles without needing top-level await.
const boot = (async () => {
  try {
    await ensureWebCrypto();
  } catch {
    /* fall through to the guard below */
  }

  if (crypto?.subtle) {
    return mount(App, { target: document.getElementById('app') });
  }
  document.getElementById('app').innerHTML = `
    <div style="max-width:640px;margin:15vh auto;padding:24px 28px;font-family:system-ui,sans-serif;
                line-height:1.5;color:#e6e6e6;background:#16181c;border:1px solid #333;border-radius:12px">
      <h2 style="margin-top:0">⚠ Web Crypto недоступен</h2>
      <p>Сквозное шифрование панели требует <code>crypto.subtle</code>
         (https:// или localhost), а JS-фолбэк не смог загрузиться.</p>
      <p>Проверь сеть или открой панель по <b>http://localhost:5180/</b>.</p>
    </div>`;
  return null;
})();

export default boot;
