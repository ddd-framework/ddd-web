/**
 * `@mgamadeus/ddd-web/issues/node` — the server adapter of the issues reporter, for a client app's own Node server
 * (an SSR server, a BFF): windowed caps and backoff, the shared server token (the backend files the reports as
 * WEB_SERVER), a request-error handler in the shape of a framework's `onRequestError` hook, and opt-in process hooks.
 * Uses the global `fetch` (Node 18+) and reads `process` only when called — no `node:` import.
 */
import {
  createFetchIssuesTransport,
  createIssuesReporter,
  redactUrl,
  type IssuesReporter,
  type IssuesReporterOptions,
  type IssuesTransport,
} from '../index';
import type { DddClientIssueEvent, DddClientIssuesReportRequestBody } from '../wire';
import { DDD_ISSUES_REPORT_PATH } from '../wire';

interface NodeProcessLike {
  version?: string;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

const readNodeProcess = (): NodeProcessLike | null =>
  ((globalThis as { process?: NodeProcessLike }).process as NodeProcessLike | undefined) ?? null;

type NodeReporterBaseOptions<TWireEvent, TRequestBody> = Omit<
  IssuesReporterOptions<TWireEvent, TRequestBody>,
  'runtime' | 'endpoint' | 'transport' | 'context'
>;

/**
 * Generic over the wire types like {@link IssuesReporterOptions}: the defaults are the DDD contract; a `wire` built
 * from your generated models types the event and the body with them.
 */
export interface NodeIssuesReporterOptions<
  TWireEvent = DddClientIssueEvent,
  TRequestBody = DddClientIssuesReportRequestBody,
> extends NodeReporterBaseOptions<TWireEvent, TRequestBody> {
  /**
   * The full URL of the ingest endpoint (`https://api.example.com/api/public/common/issues/report`), or a function
   * returning it, read at send time. Wins over `apiBaseUrl` when both are set; a function returning null / empty sends
   * nothing. Unset (or null / empty) = `apiBaseUrl` decides.
   */
  endpoint?: string | null | (() => string | null | undefined);
  /**
   * The API origin (`https://api.example.com`, a cluster-internal URL): the report goes to `<apiBaseUrl><reportPath>`.
   * Kept for compatibility: as a FUNCTION it returns the full endpoint URL, not a base URL — use `endpoint` for that.
   * Ignored when `endpoint` is set. Null / empty = nothing is sent.
   */
  apiBaseUrl?: string | null | (() => string | null | undefined);
  /** Appended to a string `apiBaseUrl`. Default {@link DDD_ISSUES_REPORT_PATH} */
  reportPath?: string;
  /** The release the backend files the error under (and looks the server's source maps up by). */
  release?: () => string | null | undefined;
  /** Default `fetch` with a 10 s timeout. */
  transport?: IssuesTransport;
  /** Default 10 000 */
  requestTimeoutMs?: number;
}

/**
 * A reporter for a Node server: runtime `node`, windowed caps, no breadcrumbs, user agent `Node.js <version>`, in-app
 * files = everything outside `node_modules` and `node:` built-ins. Without `serverToken` the backend files the reports
 * as a browser's (WEB) — or drops them, when the application requires the token for server reports.
 */
export const createNodeIssuesReporter = <
  TWireEvent = DddClientIssueEvent,
  TRequestBody = DddClientIssuesReportRequestBody,
>(
  options: NodeIssuesReporterOptions<TWireEvent, TRequestBody>,
): IssuesReporter => {
  const { endpoint, apiBaseUrl, reportPath, release, transport, requestTimeoutMs, ...reporterOptions } = options;
  const resolveEndpoint = (): string | null => {
    if (endpoint !== undefined && endpoint !== null && endpoint !== '') {
      return (typeof endpoint === 'function' ? endpoint() : endpoint) || null;
    }
    if (typeof apiBaseUrl === 'function') return apiBaseUrl() || null;
    if (!apiBaseUrl) return null;
    return `${apiBaseUrl.replace(/\/+$/, '')}${reportPath ?? DDD_ISSUES_REPORT_PATH}`;
  };
  return createIssuesReporter<TWireEvent, TRequestBody>({
    isInAppFile: (file) => !file.includes('/node_modules/'),
    ...reporterOptions,
    runtime: 'node',
    endpoint: resolveEndpoint,
    context: () => {
      const nodeVersion = readNodeProcess()?.version;
      return { release: release?.() ?? null, userAgent: nodeVersion ? `Node.js ${nodeVersion}` : null };
    },
    transport: transport ?? createFetchIssuesTransport({ timeoutMs: requestTimeoutMs ?? 10_000 }),
  });
};

/** The request of a server-side error, as frameworks hand it to their request-error hook. */
export interface ServerIssueRequest {
  path: string;
  method: string;
}

/** Where in the server the error happened (fields of a framework's request-error context; all optional). */
export interface ServerIssueRequestContext {
  /** The route PATTERN (`/books/[bookId]`), never the URL */
  routePath?: string | null;
  routerKind?: string;
  routeType?: string;
  renderSource?: string;
}

/**
 * A request-error handler `(error, request, context) => void`, structurally compatible with a framework's
 * `onRequestError` hook (Next.js `instrumentation.ts`). Reports kind `server-request` with the route pattern, the
 * redacted path and the method; the error's `digest` goes in as a tag (an error boundary in the browser sees the same
 * digest and does not report it again). `getReporter` may return null (not configured).
 */
export const createServerRequestErrorHandler =
  (getReporter: () => IssuesReporter | null | undefined) =>
  (error: unknown, request: ServerIssueRequest, context: ServerIssueRequestContext = {}): void => {
    try {
      getReporter()?.captureError(error, 'server-request', {
        routePattern: context.routePath || null,
        url: redactUrl(request.path),
        requestMethod: request.method,
        tags: {
          digest: (error as { digest?: string } | null)?.digest,
          routerKind: context.routerKind,
          routeType: context.routeType,
          renderSource: context.renderSource,
        },
      });
    } catch {
      // Never into the framework.
    }
  };

export interface NodeIssueCaptureOptions {
  /**
   * Also report unhandled promise rejections. Off by default: a listener for `unhandledRejection` changes Node's
   * default behaviour (the process no longer exits on one). Turn it on only where that is wanted.
   */
  unhandledRejections?: boolean;
}

/**
 * Process hooks: uncaught exceptions are reported through `uncaughtExceptionMonitor` (observes only, Node's crash
 * behaviour is unchanged; the queue is flushed right away), `beforeExit` flushes. Returns the uninstall function.
 */
export const installNodeIssueCapture = (
  reporter: IssuesReporter,
  options: NodeIssueCaptureOptions = {},
): (() => void) => {
  const nodeProcess = readNodeProcess();
  if (!nodeProcess?.on) return () => undefined;
  const uninstallSteps: (() => void)[] = [];
  const listen = (event: string, listener: (...args: unknown[]) => void) => {
    nodeProcess.on?.(event, listener);
    uninstallSteps.push(() => nodeProcess.off?.(event, listener));
  };

  listen('uncaughtExceptionMonitor', (error) => {
    reporter.captureError(error, 'error');
    void reporter.flush();
  });
  listen('beforeExit', () => void reporter.flush());
  if (options.unhandledRejections) {
    listen('unhandledRejection', (reason) => reporter.captureError(reason, 'unhandledrejection'));
  }

  return () => {
    for (const uninstallStep of uninstallSteps.splice(0).reverse()) uninstallStep();
  };
};
