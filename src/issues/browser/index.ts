/**
 * `@mgamadeus/ddd-web/issues/browser` — the browser adapter of the issues reporter: a reporter with the page's
 * context and a keepalive / beacon transport, the global capture points (uncaught errors, unhandled rejections,
 * breadcrumbs from failed requests, `console.error` and clicks, flush on `pagehide`), a route tracker and render-error
 * reporting for error boundaries. No framework: a Next.js, Vite or any other app calls these from its own entry points.
 */
import {
  consoleBreadcrumb,
  createFetchIssuesTransport,
  createIssuesReporter,
  createIssuesRouteTracker,
  fetchBreadcrumb,
  uiBreadcrumb,
  type IssuesFetchFunction,
  type IssuesReporter,
  type IssuesReporterOptions,
  type IssuesRouteParams,
  type IssuesTransport,
} from '../index';
import { DDD_ISSUES_REPORT_PATH, type DddClientIssueEvent, type DddClientIssuesReportRequestBody } from '../wire';

type BrowserEventListener = (event: Event) => void;

/** The part of `window` the adapter uses; a test passes a fake (an `EventTarget` with `fetch`). */
export interface IssuesBrowserWindow {
  addEventListener: (type: string, listener: BrowserEventListener, options?: boolean | AddEventListenerOptions) => void;
  removeEventListener: (type: string, listener: BrowserEventListener, options?: boolean | EventListenerOptions) => void;
  fetch: typeof fetch;
  document?: {
    visibilityState: string;
    addEventListener: (type: string, listener: BrowserEventListener) => void;
    removeEventListener: (type: string, listener: BrowserEventListener) => void;
  };
  location?: { href: string; origin: string };
  navigator?: { webdriver?: boolean; language?: string; sendBeacon?: (url: string, data?: BodyInit | null) => boolean };
  innerWidth?: number;
  innerHeight?: number;
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  crypto?: { randomUUID?: () => string };
  console?: { error: (...args: unknown[]) => void };
}

const readBrowserWindow = (): IssuesBrowserWindow | null => {
  const candidate = globalThis as unknown as Partial<IssuesBrowserWindow>;
  return typeof candidate.addEventListener === 'function' && typeof candidate.fetch === 'function'
    ? (candidate as IssuesBrowserWindow)
    : null;
};

/** The `fetch` from before {@link installBrowserIssueCapture} wrapped it, per window: the reporter's own requests leave no breadcrumbs. */
const unwrappedFetchByWindow = new WeakMap<object, typeof fetch>();

const readUnwrappedFetch = (browserWindow: IssuesBrowserWindow): typeof fetch =>
  unwrappedFetchByWindow.get(browserWindow) ?? browserWindow.fetch.bind(browserWindow);

/** Default key of the per-tab id in `sessionStorage`. */
export const DDD_ISSUES_TAB_ID_STORAGE_KEY = 'ddd-issues-tab-id';

/**
 * The id of this tab, kept in `sessionStorage`: tells one user's repeats from many users, never a person. Null when
 * storage is blocked (private mode, a sandboxed frame).
 */
export const readOrCreateIssuesTabId = (
  storageKey: string = DDD_ISSUES_TAB_ID_STORAGE_KEY,
  browserWindow: IssuesBrowserWindow | null = readBrowserWindow(),
): string | null => {
  try {
    const storage = browserWindow?.sessionStorage;
    if (!storage) return null;
    const existingTabId = storage.getItem(storageKey);
    if (existingTabId) return existingTabId;
    const tabId =
      browserWindow?.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    storage.setItem(storageKey, tabId);
    return tabId;
  } catch {
    return null;
  }
};

export interface BeaconIssuesTransportOptions {
  /** Sends whatever the beacon does not: every request that is not unloading, or carries headers a beacon cannot. */
  fallback?: IssuesTransport;
  browserWindow?: IssuesBrowserWindow | null;
}

/**
 * Sends an unloading request (`flush({ unloading: true })`) with `navigator.sendBeacon` (as `text/plain`, no CORS preflight; the backend reads the
 * JSON body regardless of its type) and everything else with the fallback (default: `fetch` with keepalive). A beacon
 * carries no headers: a request with `Authorization` or a server token always goes through the fallback, so the
 * account attribution is never lost. A queued beacon answers 202.
 */
export const createBeaconIssuesTransport = (options: BeaconIssuesTransportOptions = {}): IssuesTransport => {
  const fallback = options.fallback ?? createFetchIssuesTransport();
  return async (request) => {
    const browserWindow = options.browserWindow === undefined ? readBrowserWindow() : options.browserWindow;
    const sendBeacon = browserWindow?.navigator?.sendBeacon;
    const hasHeadersBeyondContentType = Object.keys(request.headers).some(
      (headerName) => !['content-type', 'accept'].includes(headerName.toLowerCase()),
    );
    if (request.unloading && typeof sendBeacon === 'function' && !hasHeadersBeyondContentType) {
      try {
        const isQueued = sendBeacon.call(
          browserWindow?.navigator,
          request.url,
          new Blob([request.body], { type: 'text/plain;charset=UTF-8' }),
        );
        if (isQueued) return { status: 202 };
      } catch {
        // Fall through to the fallback.
      }
    }
    return fallback(request);
  };
};

type BrowserReporterBaseOptions = Omit<
  IssuesReporterOptions<DddClientIssueEvent, DddClientIssuesReportRequestBody>,
  'runtime' | 'endpoint' | 'transport' | 'context' | 'serverToken' | 'serverTokenHeader'
>;

export interface BrowserIssuesReporterOptions extends BrowserReporterBaseOptions {
  /**
   * The ingest endpoint: a full URL, a path of this origin, or a function read at send time. Default
   * {@link DDD_ISSUES_REPORT_PATH} on this origin.
   */
  endpoint?: string | (() => string | null);
  /** The release the backend files the error under (and looks its source maps up by). Read at send time. */
  release?: () => string | null | undefined;
  /** Default `navigator.language`. */
  locale?: () => string | null | undefined;
  /** Default: beacon on unload, `fetch` (keepalive, no cookies) otherwise, with the fetch from before the capture wrapped it. */
  transport?: IssuesTransport;
  /** `sessionStorage` key of the tab id; null = no tab id. Default {@link DDD_ISSUES_TAB_ID_STORAGE_KEY}. */
  tabIdStorageKey?: string | null;
  browserWindow?: IssuesBrowserWindow;
}

/**
 * A reporter for the page: runtime `browser`, session caps, viewport / locale / tab id as context, in-app files =
 * this origin's scripts, nothing reported under automation (`navigator.webdriver`). Null outside a browser (SSR).
 */
export const createBrowserIssuesReporter = (options: BrowserIssuesReporterOptions): IssuesReporter | null => {
  const browserWindow = options.browserWindow ?? readBrowserWindow();
  if (!browserWindow) return null;
  const tabId =
    options.tabIdStorageKey === null
      ? null
      : readOrCreateIssuesTabId(options.tabIdStorageKey ?? DDD_ISSUES_TAB_ID_STORAGE_KEY, browserWindow);
  const configuredEndpoint = options.endpoint ?? DDD_ISSUES_REPORT_PATH;
  const resolveEndpoint = (): string | null => {
    const endpoint = typeof configuredEndpoint === 'function' ? configuredEndpoint() : configuredEndpoint;
    if (!endpoint) return null;
    const origin = browserWindow.location?.origin;
    return endpoint.startsWith('/') && !endpoint.startsWith('//') && origin ? `${origin}${endpoint}` : endpoint;
  };
  const origin = browserWindow.location?.origin;
  const isInAppFile = (file: string): boolean => (origin ? file.startsWith(`${origin}/`) : false) || file.startsWith('/');

  const { endpoint: _endpoint, release, locale, transport, tabIdStorageKey: _tabIdStorageKey, browserWindow: _browserWindow, ...reporterOptions } =
    options;
  return createIssuesReporter({
    isInAppFile,
    isAutomated: () => browserWindow.navigator?.webdriver === true,
    ...reporterOptions,
    runtime: 'browser',
    endpoint: resolveEndpoint,
    context: () => ({
      release: release?.() ?? null,
      tabId,
      // The backend reads a browser's user agent from the request header.
      userAgent: null,
      viewportWidth: browserWindow.innerWidth ?? null,
      viewportHeight: browserWindow.innerHeight ?? null,
      locale: (locale ? locale() : browserWindow.navigator?.language) || null,
    }),
    transport:
      transport ??
      createBeaconIssuesTransport({
        browserWindow,
        fallback: createFetchIssuesTransport({
          fetch: () => readUnwrappedFetch(browserWindow) as unknown as IssuesFetchFunction,
        }),
      }),
  });
};

export interface BrowserIssueCaptureOptions {
  browserWindow?: IssuesBrowserWindow;
  /** Breadcrumb per failed request (status ≥ 400 or no answer). Default true. */
  captureFetch?: boolean;
  /** Breadcrumb per `console.error` (its first argument). Default true. */
  captureConsoleErrors?: boolean;
  /** Breadcrumb per click (`data-issues-action`, else tag and role; never text). Default true. */
  captureClicks?: boolean;
  /** Requests that leave no breadcrumb. Default: URLs containing {@link DDD_ISSUES_REPORT_PATH}. */
  isIgnoredRequestUrl?: (url: string) => boolean;
  now?: () => string;
}

const describeConsoleArgument = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

interface ElementLike {
  tagName: string;
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => ElementLike | null;
}

const isElementLike = (value: unknown): value is ElementLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ElementLike).closest === 'function' &&
  typeof (value as ElementLike).getAttribute === 'function' &&
  typeof (value as ElementLike).tagName === 'string';

/** `data-issues-action` of the clicked element or an ancestor, else its tag and role — never text. */
export const describeIssuesClickTarget = (target: unknown): string | null => {
  if (!isElementLike(target)) return null;
  const withAction = target.closest('[data-issues-action]');
  if (withAction) return withAction.getAttribute('data-issues-action');
  const interactive = target.closest('button, a, [role], input, select, textarea, label') ?? target;
  const role = interactive.getAttribute('role');
  return `${interactive.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}`;
};

const describeRequest = (input: unknown, init?: RequestInit): { method: string; url: string } => {
  if (typeof input === 'object' && input !== null && 'url' in input && typeof (input as Request).url === 'string') {
    const request = input as Request;
    return { method: init?.method ?? request.method ?? 'GET', url: request.url };
  }
  return { method: init?.method ?? 'GET', url: String(input) };
};

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

/**
 * Installs the browser capture points once per window (before hydration, e.g. in the client instrumentation file):
 * - uncaught errors (`error`) and unhandled rejections → reported;
 * - failed requests, `console.error` and clicks → breadcrumbs only, never reports of their own;
 * - `pagehide` / tab hidden → flush with keepalive.
 * Render crashes come from the app's error boundaries ({@link captureRenderError}). Returns the uninstall function.
 */
export const installBrowserIssueCapture = (
  reporter: IssuesReporter,
  options: BrowserIssueCaptureOptions = {},
): (() => void) => {
  const browserWindow = options.browserWindow ?? readBrowserWindow();
  if (!browserWindow || unwrappedFetchByWindow.has(browserWindow)) return () => undefined;
  const now = options.now ?? (() => new Date().toISOString());
  const isIgnoredRequestUrl = options.isIgnoredRequestUrl ?? ((url: string) => url.includes(DDD_ISSUES_REPORT_PATH));
  const uninstallSteps: (() => void)[] = [];

  const listen = (type: string, listener: BrowserEventListener, listenerOptions?: AddEventListenerOptions) => {
    browserWindow.addEventListener(type, listener, listenerOptions);
    uninstallSteps.push(() => browserWindow.removeEventListener(type, listener, listenerOptions));
  };

  listen('error', (event) => {
    const errorEvent = event as ErrorEvent;
    // A script error without an Error object (cross-origin, old browsers): the position comes from the event.
    const error =
      errorEvent.error ??
      Object.assign(new Error(errorEvent.message || 'Script error.'), {
        stack: errorEvent.filename
          ? `Error: ${errorEvent.message}\n    at ${errorEvent.filename}:${errorEvent.lineno}:${errorEvent.colno}`
          : undefined,
      });
    reporter.captureError(error, 'error');
  });

  listen('unhandledrejection', (event) => {
    reporter.captureError((event as PromiseRejectionEvent).reason, 'unhandledrejection');
  });

  if (options.captureClicks !== false) {
    listen(
      'click',
      (event) => {
        const action = describeIssuesClickTarget(event.target);
        if (action) reporter.addBreadcrumb(uiBreadcrumb(now(), action));
      },
      { capture: true, passive: true },
    );
  }

  const originalFetch = browserWindow.fetch;
  unwrappedFetchByWindow.set(browserWindow, originalFetch.bind(browserWindow));
  uninstallSteps.push(() => unwrappedFetchByWindow.delete(browserWindow));
  if (options.captureFetch !== false) {
    const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const { method, url } = describeRequest(input, init);
      try {
        const response = await originalFetch.call(browserWindow, input, init);
        if (response.status >= 400 && !isIgnoredRequestUrl(url)) {
          reporter.addBreadcrumb(fetchBreadcrumb(now(), method, url, response.status));
        }
        return response;
      } catch (error) {
        if (!isAbortError(error) && !isIgnoredRequestUrl(url)) {
          reporter.addBreadcrumb(fetchBreadcrumb(now(), method, url, 'network-error'));
        }
        throw error;
      }
    };
    browserWindow.fetch = wrappedFetch as typeof fetch;
    uninstallSteps.push(() => {
      if (browserWindow.fetch === wrappedFetch) browserWindow.fetch = originalFetch;
    });
  }

  const browserConsole = browserWindow.console ?? (globalThis as { console?: { error: (...args: unknown[]) => void } }).console;
  if (options.captureConsoleErrors !== false && browserConsole) {
    const originalConsoleError = browserConsole.error;
    const wrappedConsoleError = (...args: unknown[]) => {
      reporter.addBreadcrumb(consoleBreadcrumb(now(), describeConsoleArgument(args[0])));
      originalConsoleError.apply(browserConsole, args);
    };
    browserConsole.error = wrappedConsoleError;
    uninstallSteps.push(() => {
      if (browserConsole.error === wrappedConsoleError) browserConsole.error = originalConsoleError;
    });
  }

  const flushOnLeave = () => void reporter.flush({ unloading: true });
  listen('pagehide', flushOnLeave);
  const browserDocument = browserWindow.document;
  if (browserDocument) {
    const flushWhenHidden = () => {
      if (browserDocument.visibilityState === 'hidden') flushOnLeave();
    };
    browserDocument.addEventListener('visibilitychange', flushWhenHidden);
    uninstallSteps.push(() => browserDocument.removeEventListener('visibilitychange', flushWhenHidden));
  }

  return () => {
    for (const uninstallStep of uninstallSteps.splice(0).reverse()) uninstallStep();
  };
};

/**
 * Route tracking for a browser router: call `trackRoute(pathname, params)` on every route change (e.g. from an
 * effect on the router's path and params). The URL is the page's `location.href`, redacted by the reporter.
 */
export const createBrowserIssuesRouteTracker = (
  reporter: IssuesReporter,
  browserWindow: IssuesBrowserWindow | null = readBrowserWindow(),
): { trackRoute: (pathname: string, params?: IssuesRouteParams | null) => string } => {
  const routeTracker = createIssuesRouteTracker(reporter);
  return {
    trackRoute: (pathname, params) => routeTracker.trackRoute(pathname, params, browserWindow?.location?.href ?? pathname),
  };
};

/**
 * A render crash caught by an error boundary. An error with a `digest` was thrown on the SERVER (React server
 * components): the browser only gets a placeholder message and the server's reporter has the real one, so it is not
 * reported twice unless `reportServerDigests` is set.
 */
export const captureRenderError = (
  reporter: IssuesReporter | null | undefined,
  error: unknown,
  options: { reportServerDigests?: boolean } = {},
): void => {
  const digest = typeof error === 'object' && error !== null ? (error as { digest?: unknown }).digest : undefined;
  if (digest && !options.reportServerDigests) return;
  reporter?.captureError(error, 'react-render');
};
