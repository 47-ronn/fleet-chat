import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

// Replace the heavy children with lightweight stubs so we can test App's routing
// in isolation (no WebSocket / crypto / three.js). The mock ids match App's own
// import specifiers ('./Chat.svelte', './Landing.svelte').
vi.mock('./Chat.svelte', async () => ({
  default: (await import('./__mocks__/Chat.stub.svelte')).default,
}));
vi.mock('./Landing.svelte', async () => ({
  default: (await import('./__mocks__/Landing.stub.svelte')).default,
}));

import App from './App.svelte';

// Set the hash and notify listeners deterministically (jsdom doesn't always fire
// hashchange on assignment).
function setHash(hash) {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

beforeEach(() => {
  window.location.hash = '';
});

describe('App routing', () => {
  it('renders Landing for the empty/default route', () => {
    render(App);
    expect(screen.getByTestId('landing')).toBeInTheDocument();
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
  });

  it('renders Chat when the initial hash is #/app', () => {
    window.location.hash = '#/app';
    render(App);
    expect(screen.getByTestId('chat')).toBeInTheDocument();
    expect(screen.queryByTestId('landing')).not.toBeInTheDocument();
  });

  it('renders Chat for a case-insensitive initial hash (#/APP)', () => {
    window.location.hash = '#/APP';
    render(App);
    expect(screen.getByTestId('chat')).toBeInTheDocument();
  });

  it('reacts to a hashchange: landing -> chat', async () => {
    render(App);
    expect(screen.getByTestId('landing')).toBeInTheDocument();

    setHash('#/app');
    await tick();

    expect(screen.getByTestId('chat')).toBeInTheDocument();
    expect(screen.queryByTestId('landing')).not.toBeInTheDocument();
  });

  it('reacts to a hashchange back to landing: chat -> landing', async () => {
    window.location.hash = '#/app';
    render(App);
    expect(screen.getByTestId('chat')).toBeInTheDocument();

    setHash('#/');
    await tick();

    expect(screen.getByTestId('landing')).toBeInTheDocument();
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
  });
});

describe('App listener lifecycle', () => {
  let addSpy;
  let removeSpy;

  beforeEach(() => {
    addSpy = vi.spyOn(window, 'addEventListener');
    removeSpy = vi.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('subscribes to hashchange on mount and unsubscribes on unmount', () => {
    const { unmount } = render(App);
    expect(addSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));

    // Capture the exact handler registered so we can assert it is removed.
    const handler = addSpy.mock.calls.find((c) => c[0] === 'hashchange')[1];

    unmount();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', handler);
  });
});
