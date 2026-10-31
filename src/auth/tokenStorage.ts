import { createSafeStorage, safeLocalStorage, type DddStorageLike } from './safeStorage';
import type { DddTokens, DddTokensUpdate } from './types';

/** Persists the token pair. Implementations must never throw. */
export interface TokenStorage {
  /** Reads both tokens; a missing token is `null`. */
  read(): DddTokens;
  /** Writes the given tokens; `undefined` leaves a value untouched, `null` removes it. */
  write(tokens: DddTokensUpdate): void;
  /** Removes both tokens. */
  clear(): void;
}

/** Options of {@link createLocalStorageTokenStorage}. */
export interface LocalStorageTokenStorageOptions {
  /** Storage key of the access token. Default `accessToken`. */
  accessKey?: string;
  /** Storage key of the refresh token. Default `refreshToken`. */
  refreshKey?: string;
  /**
   * Turns the access token into the stored string. Receives the currently stored raw value so a format that keeps more
   * than the token (e.g. `{ user, jwt }`) can preserve the other fields. Default: the token itself.
   */
  serialize?: (accessToken: string, previous: string | null) => string;
  /**
   * Extracts the access token from the stored string. May throw or return `null` for an unreadable value; that counts
   * as "no token". Default: the raw value.
   */
  deserialize?: (raw: string) => string | null | undefined;
  /** Backing storage. Default: SSR-safe `localStorage`. */
  storage?: DddStorageLike;
}

/**
 * A {@link TokenStorage} over Web Storage that can keep an app's existing storage format.
 *
 * @example
 * // Access token kept inside a JSON object `{ user, jwt }`, refresh token stored raw:
 * const storage = createLocalStorageTokenStorage({
 *   accessKey: 'session',
 *   refreshKey: 'session_refresh',
 *   serialize: (jwt, previous) => JSON.stringify({ ...(previous ? JSON.parse(previous) : {}), jwt }),
 *   deserialize: (raw) => JSON.parse(raw).jwt,
 * });
 */
export function createLocalStorageTokenStorage(options: LocalStorageTokenStorageOptions = {}): TokenStorage {
  const {
    accessKey = 'accessToken',
    refreshKey = 'refreshToken',
    serialize = (accessToken: string) => accessToken,
    deserialize = (raw: string) => raw,
  } = options;
  // An injected storage may throw as well; the TokenStorage contract says never throw.
  const injected = options.storage;
  const storage = injected ? createSafeStorage(() => injected) : safeLocalStorage;

  const readAccess = (): string | null => {
    const raw = storage.getItem(accessKey);
    if (!raw) return null;
    try {
      return deserialize(raw) || null;
    } catch {
      return null;
    }
  };

  const trySerialize = (accessToken: string, previous: string | null): string | null => {
    try {
      return serialize(accessToken, previous);
    } catch {
      return null;
    }
  };

  const writeAccess = (accessToken: string): void => {
    // An unreadable stored value: start from scratch. A serializer that fails on both: the old (stale) token is
    // removed rather than kept as if it were the new one.
    const value = trySerialize(accessToken, storage.getItem(accessKey)) ?? trySerialize(accessToken, null);
    if (value === null) storage.removeItem(accessKey);
    else storage.setItem(accessKey, value);
  };

  return {
    read: () => ({ accessToken: readAccess(), refreshToken: storage.getItem(refreshKey) || null }),
    write(tokens) {
      if (tokens.accessToken === null) storage.removeItem(accessKey);
      else if (tokens.accessToken !== undefined) writeAccess(tokens.accessToken);
      if (tokens.refreshToken === null) storage.removeItem(refreshKey);
      else if (tokens.refreshToken !== undefined) storage.setItem(refreshKey, tokens.refreshToken);
    },
    clear() {
      storage.removeItem(accessKey);
      storage.removeItem(refreshKey);
    },
  };
}

/** A non-persistent {@link TokenStorage} (tests, SSR, short-lived sessions). */
export function createMemoryTokenStorage(initial: DddTokensUpdate = {}): TokenStorage {
  let tokens: DddTokens = { accessToken: initial.accessToken ?? null, refreshToken: initial.refreshToken ?? null };
  return {
    read: () => ({ ...tokens }),
    write(update) {
      tokens = {
        accessToken: update.accessToken === undefined ? tokens.accessToken : update.accessToken,
        refreshToken: update.refreshToken === undefined ? tokens.refreshToken : update.refreshToken,
      };
    },
    clear() {
      tokens = { accessToken: null, refreshToken: null };
    },
  };
}
