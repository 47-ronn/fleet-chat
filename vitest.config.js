import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';

// Separate from vite.config.js (which carries the GitHub Pages `base`): tests
// don't need a base path, and svelteTesting() wires up auto-cleanup + the
// browser export condition so @testing-library/svelte can mount components.
export default defineConfig({
  plugins: [svelte({ hot: false }), svelteTesting()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest-setup.js'],
    include: ['src/**/*.{test,spec}.{js,ts}'],
  },
});
