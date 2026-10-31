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

function stableValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Builds a stable key from static query arguments (sorted by name, `name=value` joined by `&`), e.g. to reset paging
 * when they change. Non-primitive values are keyed by their JSON form.
 */
export function buildStaticArgsKey(staticArgs: Record<string, unknown> | null | undefined): string {
  if (!staticArgs) {
    return '';
  }
  return Object.entries(staticArgs)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${stableValue(value)}`)
    .join('&');
}

/** Builds a stable key from per-column search state (non-empty values, sorted by column key). */
export function buildColumnSearchesKey(searches: Record<string, string>): string {
  return Object.entries(searches)
    .filter(([, value]) => value.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}
