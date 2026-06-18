import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// `base` matches the GitHub Pages project path for the production build AND for
// `vite preview` (which serves the built bundle, whose asset URLs are baked with
// this base) — otherwise preview serves the SPA fallback for every asset and the
// app never mounts. Plain `vite dev` stays at root. Pages URL:
// https://47-ronn.github.io/fleet-chat/
export default defineConfig(({ command, isPreview }) => ({
  plugins: [svelte()],
  base: command === 'build' || isPreview ? '/fleet-chat/' : '/',
  server: { port: 5180 },
}));
