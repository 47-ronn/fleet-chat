import { describe, it, expect } from 'vitest';
import { parseRoute, isAppRoute } from './router.js';

describe('parseRoute', () => {
  it('returns empty string for no/empty hash', () => {
    expect(parseRoute('')).toBe('');
    expect(parseRoute()).toBe(''); // default arg
    expect(parseRoute('#')).toBe('');
    expect(parseRoute('#/')).toBe('');
  });

  it('strips a leading "#/"', () => {
    expect(parseRoute('#/app')).toBe('app');
    expect(parseRoute('#/landing')).toBe('landing');
  });

  it('strips a bare leading "#" (no slash)', () => {
    expect(parseRoute('#app')).toBe('app');
  });

  it('lowercases the route', () => {
    expect(parseRoute('#/App')).toBe('app');
    expect(parseRoute('#/APP')).toBe('app');
  });

  it('keeps sub-path segments', () => {
    expect(parseRoute('#/app/123')).toBe('app/123');
  });

  it('only strips the FIRST slash after the hash', () => {
    // '#//x' -> remove '#/' -> '/x'
    expect(parseRoute('#//x')).toBe('/x');
  });
});

describe('isAppRoute', () => {
  it('is true for the app route and its sub-paths', () => {
    expect(isAppRoute('app')).toBe(true);
    expect(isAppRoute('app/123')).toBe(true);
  });

  it('is false for the landing/empty route', () => {
    expect(isAppRoute('')).toBe(false);
    expect(isAppRoute('landing')).toBe(false);
    expect(isAppRoute('about')).toBe(false);
  });

  it('does NOT match unrelated "app"-prefixed routes', () => {
    // Segment-aware: only 'app' / 'app/...' count, not 'application' or 'apple'.
    expect(isAppRoute('application')).toBe(false);
    expect(isAppRoute('apple')).toBe(false);
    expect(isAppRoute('apps')).toBe(false);
  });
});
