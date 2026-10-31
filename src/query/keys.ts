/** Removes leading whitespace from a search input (trailing whitespace is kept while the user is typing). */
export function sanitizeSearchInput(value: string): string {
  return value.replace(/^\s+/, '');
}

/** Sanitises every per-column search value and drops the empty ones. */
export function sanitizeColumnSearches(columnSearches: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(columnSearches)
      .map(([key, value]) => [key, sanitizeSearchInput(value)] as const)
      .filter(([, value]) => value.length > 0),
  );
}

/** JSON form of a key value; values JSON cannot represent (BigInt, cycles) fall back to their string form. */
function keyValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds a stable key from static query arguments, e.g. to reset paging when they change: the arguments sorted by
 * name, serialised as a JSON list of `[name, value]` pairs (collision-free: `{ a: '1&b=2' }` and `{ a: '1', b: '2' }`
 * differ). `undefined` counts as `null`. Empty for no arguments.
 */
export function buildStaticArgsKey(staticArgs: Record<string, unknown> | null | undefined): string {
  if (!staticArgs) {
    return '';
  }
  const entries = Object.entries(staticArgs).sort(byKey);
  return entries.length === 0 ? '' : JSON.stringify(entries.map(([key, value]) => [key, keyValue(value)]));
}

/** Builds a stable key from per-column search state (non-empty values, sorted by column key, JSON pairs). */
export function buildColumnSearchesKey(searches: Record<string, string>): string {
  const entries = Object.entries(searches)
    .filter(([, value]) => value.length > 0)
    .sort(byKey);
  return entries.length === 0 ? '' : JSON.stringify(entries);
}
