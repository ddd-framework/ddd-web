import { navigationBreadcrumb } from './breadcrumbs';
import type { CapturedBreadcrumb } from './types';

/** Dynamic route params as routers hand them out (`string` per segment, `string[]` for a catch-all). */
export type IssuesRouteParams = Record<string, string | readonly string[] | undefined>;

/**
 * The route PATTERN of a page, rebuilt from its path and its dynamic params: `/books/12/chapters/3` with
 * `{ bookId: '12', chapterId: '3' }` → `/books/[bookId]/chapters/[chapterId]`. The pattern names the issue (one bug on
 * every book's chapter page is one issue) and carries no slug, id or token.
 *
 * Params are matched left to right, each against the first unmatched segment equal to its value, so
 * `/books/3/chapters/3` with `{ bookId: '3', chapterId: '3' }` still comes out right. A catch-all (array value)
 * replaces the run of segments it spans with `[...key]`.
 */
export const buildRoutePattern = (pathname: string, params: IssuesRouteParams | null | undefined): string => {
  const segments = pathname.split('/');
  const decode = (segment: string): string => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  const decodedSegments = segments.map(decode);
  let searchFrom = 1;

  for (const [key, rawValue] of Object.entries(params ?? {})) {
    if (rawValue === undefined) continue;
    const isCatchAll = typeof rawValue !== 'string';
    const values = (isCatchAll ? [...rawValue] : [rawValue]).map(decode);
    if (values.length === 0) continue;
    for (let start = searchFrom; start + values.length <= segments.length; start++) {
      const isRun = values.every((value, offset) => decodedSegments[start + offset] === value);
      if (!isRun) continue;
      const placeholder = isCatchAll ? `[...${key}]` : `[${key}]`;
      segments.splice(start, values.length, placeholder);
      decodedSegments.splice(start, values.length, placeholder);
      searchFrom = start + 1;
      break;
    }
  }
  return segments.join('/') || '/';
};

/** The part of a reporter a route tracker drives. */
export interface IssuesRouteTarget {
  setRoute: (routePattern: string | null, url: string | null) => void;
  addBreadcrumb: (breadcrumb: CapturedBreadcrumb) => void;
}

export interface IssuesRouteTracker {
  /**
   * Call on every route change: sets the reporter's route pattern and URL (the URL defaults to the path) and adds a
   * navigation breadcrumb when the pattern changed. Returns the pattern.
   */
  trackRoute: (pathname: string, params?: IssuesRouteParams | null, url?: string | null) => string;
}

/** Platform-free: a web router, a React Native navigator or a test calls `trackRoute` itself. */
export const createIssuesRouteTracker = (
  target: IssuesRouteTarget,
  now: () => string = () => new Date().toISOString(),
): IssuesRouteTracker => {
  let previousRoutePattern: string | null = null;
  return {
    trackRoute: (pathname, params, url) => {
      const routePattern = buildRoutePattern(pathname, params);
      target.setRoute(routePattern, url === undefined ? pathname : url);
      if (routePattern !== previousRoutePattern) {
        target.addBreadcrumb(navigationBreadcrumb(now(), previousRoutePattern, routePattern));
        previousRoutePattern = routePattern;
      }
      return routePattern;
    },
  };
};
