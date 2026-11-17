import { describe, it, expect } from 'vitest';
import { buildSharePayload, openSharePayload, genShareCode, SHARE_TTL_MS } from './share.js';
import { parseRoute, parseJoinRoute } from './router.js';

// jsdom provides the WebCrypto via the fallback in vitest-setup? Use the global.
const creds = { relayUrl: 'wss://relay.example/', room: 'gpu', token: 'tok-1234567890abcdef' };

describe('share payload roundtrip', () => {
  it('roundtrips with the right code', async () => {
    const { payload, code, exp } = await buildSharePayload(creds, '482913');
    expect(code).toBe('482913');
    expect(exp).toBeGreaterThan(Date.now());
    const out = await openSharePayload(payload, '482913');
    expect(out).toEqual(creds);
  });

  it('rejects a wrong code', async () => {
    const { payload } = await buildSharePayload(creds, '111111');
    expect(await openSharePayload(payload, '111112')).toBeNull();
  });

  it('enforces TTL', async () => {
    const { payload } = await buildSharePayload(creds, '482913', 50); // 50 ms
    await new Promise((r) => setTimeout(r, 80));
    expect(await openSharePayload(payload, '482913')).toBeNull();
  });

  it('default TTL is 2 minutes', () => {
    expect(SHARE_TTL_MS).toBe(120_000);
  });

  it('generates 6-digit codes', () => {
    for (let i = 0; i < 20; i++) expect(genShareCode()).toMatch(/^\d{6}$/);
  });

  it('rejects garbage payloads', async () => {
    expect(await openSharePayload('!!!not-base64!!!', '123456')).toBeNull();
    const fake = btoa(JSON.stringify({ v: 1, exp: Date.now() + 60000, salt: [1], iv: [1], ct: [1] }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await openSharePayload(fake, '123456')).toBeNull();
  });
});

describe('join route parsing', () => {
  it('extracts the payload', () => {
    expect(parseJoinRoute('#/app/join/abcABC_-123')).toBe('abcABC_-123');
  });
  it('is null for non-join routes', () => {
    expect(parseJoinRoute('#/app')).toBeNull();
    expect(parseJoinRoute('#/')).toBeNull();
    expect(parseJoinRoute('')).toBeNull();
  });
});