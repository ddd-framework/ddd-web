/**
 * Web Storage wrappers that never throw: they return `null` / do nothing when `window` is undefined (SSR, workers,
 * tests) or when the browser blocks storage (privacy mode, quota exceeded, sandboxed iframe).
 */

/** The subset of the Web Storage API the helpers use. */
export interface DddStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** True in an environment with a `window` object. */
export const isBrowser = (): boolean => typeof window !== 'undefined';

/**
 * Wraps a lazily resolved storage so every access is guarded by try/catch.
 *
 * @param resolve returns the backing storage; called on every access, may throw or return `null`
 */
export function createSafeStorage(resolve: () => DddStorageLike | null | undefined): DddStorageLike {
  const storage = (): DddStorageLike | null => {
    try {
      return resolve() ?? null;
    } catch {
      return null;
    }
  };
  return {
    getItem(key) {
      try {
        return storage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        storage()?.setItem(key, value);
      } catch {
        // Storage blocked or full: the value simply is not persisted.
      }
    },
    removeItem(key) {
      try {
        storage()?.removeItem(key);
      } catch {
        // Storage blocked: nothing to remove.
      }
    },
  };
}

/** SSR-safe `window.localStorage`. */
export const safeLocalStorage: DddStorageLike = createSafeStorage(() => (isBrowser() ? window.localStorage : null));

/** SSR-safe `window.sessionStorage`. */
export const safeSessionStorage: DddStorageLike = createSafeStorage(() => (isBrowser() ? window.sessionStorage : null));
