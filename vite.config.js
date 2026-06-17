import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// `base` is set only for production builds so assets resolve under the GitHub
// Pages project path (https://47-ronn.github.io/fleet-chat/). Dev stays at root.
export default defineConfig(({ command }) => ({
  plugins: [svelte()],
  base: command === 'build' ? '/fleet-chat/' : '/',
  server: { port: 5180 },
}));
