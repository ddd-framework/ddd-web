import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalStorageTokenStorage,
  createMemoryTokenStorage,
  createSafeStorage,
  safeLocalStorage,
  safeSessionStorage,
  type DddStorageLike,
} from '../../src/auth';

const mapStorage = (): DddStorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
};

describe('createLocalStorageTokenStorage', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('round-trips with default keys', () => {
    const storage = mapStorage();
    const tokens = createLocalStorageTokenStorage({ storage });
    tokens.write({ accessToken: 'a1', refreshToken: 'r1' });
    expect(storage.data.get('accessToken')).toBe('a1');
    expect(tokens.read()).toEqual({ accessToken: 'a1', refreshToken: 'r1' });
    tokens.write({ accessToken: 'a2' });
    expect(tokens.read()).toEqual({ accessToken: 'a2', refreshToken: 'r1' });
    tokens.write({ refreshToken: null });
    expect(tokens.read()).toEqual({ accessToken: 'a2', refreshToken: null });
    tokens.clear();
    expect(storage.data.size).toBe(0);
  });

  it('keeps an app format: access token inside JSON { user, jwt }, other fields preserved', () => {
    const storage = mapStorage();
    storage.data.set('session', JSON.stringify({ user: { id: 3 }, jwt: 'old' }));
    storage.data.set('session_refresh', '');
    const tokens = createLocalStorageTokenStorage({
      storage,
      accessKey: 'session',
      refreshKey: 'session_refresh',
      serialize: (jwt, previous) => JSON.stringify({ ...(previous ? JSON.parse(previous) : {}), jwt }),
      deserialize: (raw) => JSON.parse(raw).jwt,
    });
    expect(tokens.read()).toEqual({ accessToken: 'old', refreshToken: null }); // '' counts as no token
    tokens.write({ accessToken: 'new', refreshToken: 'r' });
    expect(JSON.parse(storage.data.get('session')!)).toEqual({ user: { id: 3 }, jwt: 'new' });
    expect(tokens.read()).toEqual({ accessToken: 'new', refreshToken: 'r' });
  });

  it('treats unreadable stored values as no token and recovers on write', () => {
    const storage = mapStorage();
    storage.data.set('session', '{not json');
    const tokens = createLocalStorageTokenStorage({
      storage,
      accessKey: 'session',
      serialize: (jwt, previous) => JSON.stringify({ ...(previous ? JSON.parse(previous) : {}), jwt }),
      deserialize: (raw) => JSON.parse(raw).jwt,
    });
    expect(tokens.read().accessToken).toBeNull();
    tokens.write({ accessToken: 'a' });
    expect(JSON.parse(storage.data.get('session')!)).toEqual({ jwt: 'a' });
  });

  it('is SSR-safe without window', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    const tokens = createLocalStorageTokenStorage();
    expect(() => tokens.write({ accessToken: 'a', refreshToken: 'r' })).not.toThrow();
    expect(tokens.read()).toEqual({ accessToken: null, refreshToken: null });
    expect(() => tokens.clear()).not.toThrow();
    expect(safeSessionStorage.getItem('x')).toBeNull();
  });

  it('swallows storage that throws (blocked storage)', () => {
    (globalThis as { window?: unknown }).window = {
      get localStorage(): Storage {
        throw new Error('SecurityError');
      },
    };
    expect(safeLocalStorage.getItem('x')).toBeNull();
    expect(() => safeLocalStorage.setItem('x', '1')).not.toThrow();
    const throwing = createSafeStorage(() => ({
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {
        throw new Error('x');
      },
    }));
    expect(throwing.getItem('a')).toBeNull();
    expect(() => throwing.setItem('a', 'b')).not.toThrow();
    expect(() => throwing.removeItem('a')).not.toThrow();
  });

  it('uses window.localStorage in a browser', () => {
    const storage = mapStorage();
    (globalThis as { window?: unknown }).window = { localStorage: storage };
    createLocalStorageTokenStorage().write({ accessToken: 'a' });
    expect(storage.data.get('accessToken')).toBe('a');
  });
});

describe('createMemoryTokenStorage', () => {
  it('round-trips', () => {
    const tokens = createMemoryTokenStorage({ refreshToken: 'r' });
    tokens.write({ accessToken: 'a' });
    expect(tokens.read()).toEqual({ accessToken: 'a', refreshToken: 'r' });
    tokens.clear();
    expect(tokens.read()).toEqual({ accessToken: null, refreshToken: null });
  });
});
