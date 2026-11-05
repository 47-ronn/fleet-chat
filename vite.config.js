import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// `base` matches the GitHub Pages project path for the production build AND for
// `vite preview` (which serves the built bundle, whose asset URLs are baked with
// this base) — otherwise preview serves the SPA fallback for every asset and the
// app never mounts. Plain `vite dev` stays at root. Pages URL:
// https://47-ronn.github.io/fleet-chat/
//
// Dev deliberately serves plain http (the panel is opened from LAN/VMs via
// the libvirt bridge, http://192.168.122.1:5180) — browsers hide
// `crypto.subtle` on such origins, so src/lib/webcrypto-fallback.js installs
// a pure-JS WebCrypto and the app works over http. host:true listens on all
// interfaces so those clients can reach it.
export default defineConfig(({ command, isPreview }) => ({
  plugins: [svelte()],
  base: command === 'build' || isPreview ? '/fleet-chat/' : '/',
  server: { port: 5180, host: true },
}));
