/**
 * The CAPTURE model of the issues reporter: what it collects, in plain arrays and with every field set.
 *
 * Not the wire format. The wire format is the backend's `ClientIssueReport` (mgamadeus/ddd value objects); the
 * {@link IssuesWireAdapter} turns captured values into it (`@mgamadeus/ddd-web/issues/wire` ships the adapter for the
 * DDD contract; an app may pass its own, typed with its generated SDK models).
 */

/** Where the reporter runs. The backend's controller picks the section (browser → WEB, server token → WEB_SERVER). */
export type IssuesRuntime = 'browser' | 'node' | 'react-native';

/** How the error reached the reporter. `manual` is the only kind the backend logs as handled. */
export type IssueKind = 'error' | 'unhandledrejection' | 'react-render' | 'server-request' | 'manual';

export type IssueLevel = 'error' | 'warning';

export type BreadcrumbCategory = 'navigation' | 'fetch' | 'console' | 'ui' | 'custom';

export interface CapturedFrame {
  file: string;
  line: number | null;
  column: number | null;
  function: string | null;
  inApp: boolean;
}

export interface CapturedBreadcrumb {
  /** ISO 8601, client clock */
  at: string;
  category: BreadcrumbCategory;
  message: string;
  url: string | null;
  from: string | null;
  to: string | null;
  status: number | null;
}

export interface CapturedTag {
  key: string;
  value: string;
}

export interface CapturedIssueEvent {
  /** ISO 8601, client clock */
  occurredAt: string;
  kind: IssueKind;
  level: IssueLevel;
  name: string;
  message: string;
  /** Innermost first */
  frames: CapturedFrame[];
  /** Only when no frame could be parsed */
  rawStack: string | null;
  url: string | null;
  routePattern: string | null;
  requestMethod: string | null;
  httpStatus: number | null;
  /** Oldest first */
  breadcrumbs: CapturedBreadcrumb[];
  tags: CapturedTag[];
  /** This event plus the repeats folded into it before it was sent */
  count: number;
  clientFingerprint: string;
}

export interface CapturedIssueContext {
  runtime: IssuesRuntime;
  app: string;
  release: string | null;
  tabId: string | null;
  /** Node / React Native only; the backend reads a browser's user agent from the request header. */
  userAgent: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  locale: string | null;
}

/** Turns captured values into the request body of the ingest endpoint. */
export interface IssuesWireAdapter<TWireEvent, TRequestBody> {
  toWireEvent: (event: CapturedIssueEvent) => TWireEvent;
  toRequestBody: (context: CapturedIssueContext, events: TWireEvent[]) => TRequestBody;
}

/** One POST, as the platform's transport receives it. */
export interface IssuesTransportRequest {
  url: string;
  headers: Record<string, string>;
  /** Serialized JSON */
  body: string;
  /** The request should survive a page unload (`fetch(…, { keepalive: true })`); browser only, one at a time. */
  keepalive: boolean;
  /** Sent by `flush({ unloading: true })`: the page is going away (a beacon transport takes these). */
  unloading: boolean;
}

/** The answer of the ingest endpoint, as far as the reporter needs it. */
export interface IssuesTransportResponse {
  status: number;
}

/** Sends one request. Resolves with the HTTP status; rejects on a network error. */
export type IssuesTransport = (request: IssuesTransportRequest) => Promise<IssuesTransportResponse>;

/** What a caller may add to one captured error. */
export interface CaptureExtra {
  level?: IssueLevel;
  /** Overrides the current route context (a server passes the request's own). */
  routePattern?: string | null;
  url?: string | null;
  requestMethod?: string | null;
  httpStatus?: number | null;
  tags?: Record<string, string | null | undefined>;
}
