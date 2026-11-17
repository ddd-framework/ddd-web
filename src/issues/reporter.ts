import { createBreadcrumbTrail, sanitizeBreadcrumb } from './breadcrumbs';
import { findIssueDropRule, ISSUE_DROP_RULES, type IssueDropRule } from './filters';
import { buildClientFingerprint } from './fingerprint';
import { type IssuesLimitsOverrides, mergeIssuesLimits } from './limits';
import { type InAppFileTest, normalizeError, truncate } from './normalize';
import { createIssuesRedactor, type IssuesRedactor } from './redact';
import type {
  CaptureExtra,
  CapturedBreadcrumb,
  CapturedIssueContext,
  CapturedIssueEvent,
  CapturedTag,
  IssueKind,
  IssuesRuntime,
  IssuesTransport,
  IssuesWireAdapter,
} from './types';
import {
  type DddClientIssueEvent,
  type DddClientIssuesReportRequestBody,
  dddIssuesWireAdapter,
} from './wire';

/**
 * The issues reporter: collect → redact → de-duplicate → cap → batch → send. Platform-free: the caller supplies the
 * transport, the context and optionally the wire adapter. It never throws into its caller and never reports its own
 * failures.
 */

/**
 * Header a client app's own server sends its shared secret in; the application's controller files such reports
 * under the section WEB_SERVER. The header name is the application's choice — `serverTokenHeader` overrides it.
 */
export const DDD_ISSUES_SERVER_TOKEN_HEADER = 'X-Issues-Server-Token';

/** How the reporter caps what it sends. */
export type IssuesRateLimitMode =
  /** One page session: per-fingerprint and per-session caps, a hard stop after repeated failed sends. */
  | 'session'
  /** A long-lived process or app: windowed caps and an exponential backoff. */
  | 'windowed';

export interface IssuesClock {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

interface TimerGlobals {
  setTimeout: (callback: () => void, delayMs: number) => { unref?: () => void } | number;
  clearTimeout: (handle: unknown) => void;
}

/** The running platform's timers, read when the reporter is created. On Node they are unref'd. */
export const createPlatformIssuesClock = (): IssuesClock => {
  const timers = globalThis as unknown as TimerGlobals;
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => {
      const handle = timers.setTimeout(callback, delayMs);
      if (typeof handle === 'object' && handle !== null) handle.unref?.();
      return handle;
    },
    clearTimeout: (handle) => timers.clearTimeout(handle),
  };
};

export type IssuesContextValues = Partial<Omit<CapturedIssueContext, 'runtime' | 'app'>>;

export interface IssuesReporterOptions<TWireEvent = DddClientIssueEvent, TRequestBody = DddClientIssuesReportRequestBody> {
  runtime: IssuesRuntime;
  /** The client app, e.g. `web`, `admin`, `mobile` */
  app: string;
  /** Full URL of the ingest endpoint, read at send time; null = not configured, nothing is sent. */
  endpoint: () => string | null;
  transport: IssuesTransport;
  /** Read at send time (the release may only be known after the first render). Missing fields are null. */
  context?: () => IssuesContextValues;
  /** Read at capture time: tags every event carries (e.g. the deployed commit); a capture's own tags win on a clash. */
  commonTags?: () => CaptureExtra['tags'];
  /** Default: the DDD contract (`@mgamadeus/ddd-web/issues/wire`). Pass your own to type the body with your models. */
  wire?: IssuesWireAdapter<TWireEvent, TRequestBody>;
  /** A signed-in session's access token, so the backend attributes the error to the account. */
  getAuthorization?: () => string | null | undefined;
  /** The client app's own server only: the shared secret that makes the backend file reports as WEB_SERVER. */
  serverToken?: string;
  /** Default {@link DDD_ISSUES_SERVER_TOKEN_HEADER} */
  serverTokenHeader?: string;
  isInAppFile?: InAppFileTest;
  /** True under automation (`navigator.webdriver`): nothing is reported. */
  isAutomated?: () => boolean;
  /** Default: `session` for `browser`, `windowed` for `node` and `react-native`. */
  rateLimitMode?: IssuesRateLimitMode;
  /** Attach the breadcrumb trail to events. Default: every runtime but `node` (a server's trail mixes requests). */
  attachBreadcrumbs?: boolean;
  /** Default {@link ISSUE_DROP_RULES}; spread them to add your own. */
  dropRules?: readonly IssueDropRule[];
  /** Default {@link createIssuesRedactor}() */
  redactor?: IssuesRedactor;
  limits?: IssuesLimitsOverrides;
  clock?: IssuesClock;
}

export interface IssuesReporter {
  /** Reports anything thrown. `kind` says how it was caught; `manual` (default) is the one the backend counts as handled. */
  captureError: (error: unknown, kind?: IssueKind, extra?: CaptureExtra) => void;
  addBreadcrumb: (breadcrumb: CapturedBreadcrumb) => void;
  /** The current route pattern (`/books/[bookId]`) and URL; both name every event captured after it. */
  setRoute: (routePattern: string | null, url: string | null) => void;
  /** Replaces `getAuthorization`, e.g. once the session store exists. */
  setAuthorizationReader: (reader: (() => string | null | undefined) | null) => void;
  /** Sends what is queued. `unloading`: the page is going away — keepalive, every batch at once, no awaiting. */
  flush: (options?: { unloading?: boolean }) => Promise<void>;
  /** Events waiting to be sent. */
  getQueuedEventCount: () => number;
}

interface QueuedEvent {
  event: CapturedIssueEvent;
  attempts: number;
}

/** UTF-8 length of a string, without TextEncoder (not in every runtime this targets). */
export const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
};

/** Room left in a request for the context and the JSON around the events. */
const REQUEST_OVERHEAD_BYTES = 2048;
/** Frames kept when an event is too large (the backend keeps the same number). */
const FRAMES_KEPT_WHEN_SHRINKING = 10;
/** Message length kept when an event is still too large. */
const MESSAGE_LENGTH_KEPT_WHEN_SHRINKING = 256;

const NO_CONTEXT: Omit<CapturedIssueContext, 'runtime' | 'app'> = {
  release: null,
  tabId: null,
  userAgent: null,
  viewportWidth: null,
  viewportHeight: null,
  locale: null,
};

export const createIssuesReporter = <TWireEvent = DddClientIssueEvent, TRequestBody = DddClientIssuesReportRequestBody>(
  options: IssuesReporterOptions<TWireEvent, TRequestBody>,
): IssuesReporter => {
  const limits = mergeIssuesLimits(options.limits);
  const clock = options.clock ?? createPlatformIssuesClock();
  const wire = options.wire ?? (dddIssuesWireAdapter as unknown as IssuesWireAdapter<TWireEvent, TRequestBody>);
  const redactor = options.redactor ?? createIssuesRedactor();
  const dropRules = options.dropRules ?? ISSUE_DROP_RULES;
  const isInAppFile = options.isInAppFile ?? (() => true);
  const rateLimitMode: IssuesRateLimitMode =
    options.rateLimitMode ?? (options.runtime === 'browser' ? 'session' : 'windowed');
  const attachBreadcrumbs = options.attachBreadcrumbs ?? options.runtime !== 'node';
  const isBrowser = options.runtime === 'browser';
  const trail = createBreadcrumbTrail(limits.breadcrumbsPerEvent);
  let readAuthorization = options.getAuthorization ?? null;

  let route: { routePattern: string | null; url: string | null } = { routePattern: null, url: null };
  let queue: QueuedEvent[] = [];
  let flushTimer: unknown = null;
  let isSending = false;
  let isKeepaliveInFlight = false;

  // Rate limit mode `session`
  const sendsByFingerprint = new Map<string, number>();
  let sessionEvents = 0;
  let failedSends = 0;
  let isStopped = false;

  // Rate limit mode `windowed`
  const sendTimesByFingerprint = new Map<string, number[]>();
  let sendTimesOfLastMinute: number[] = [];
  let backoffMs = 0;
  let backoffUntil = 0;

  const measureEvent = (event: CapturedIssueEvent): number => utf8ByteLength(JSON.stringify(wire.toWireEvent(event)));

  /** Breadcrumbs go first, then frames beyond 10, the raw stack, and the message beyond 256 characters. */
  const shrinkToFit = (event: CapturedIssueEvent): CapturedIssueEvent => {
    const steps: ((current: CapturedIssueEvent) => CapturedIssueEvent)[] = [
      (current) => ({ ...current, breadcrumbs: [] }),
      (current) => ({ ...current, frames: current.frames.slice(0, FRAMES_KEPT_WHEN_SHRINKING) }),
      (current) => ({ ...current, rawStack: null }),
      (current) => ({ ...current, message: truncate(current.message, MESSAGE_LENGTH_KEPT_WHEN_SHRINKING) }),
    ];
    let shrunk = event;
    for (const step of steps) {
      if (measureEvent(shrunk) <= limits.eventBytes) return shrunk;
      shrunk = step(shrunk);
    }
    return shrunk;
  };

  /** Whether the caps let one more event with this fingerprint through; records it when they do. */
  const admit = (fingerprint: string): boolean => {
    if (rateLimitMode === 'session') {
      if (isStopped) return false;
      const sends = sendsByFingerprint.get(fingerprint) ?? 0;
      if (sends >= limits.session.sendsPerFingerprint) return false;
      if (sessionEvents >= limits.session.eventsPerSession) return false;
      sendsByFingerprint.set(fingerprint, sends + 1);
      sessionEvents += 1;
      return true;
    }
    const now = clock.now();
    const windowStart = now - limits.windowed.fingerprintWindowMs;
    const fingerprintTimes = (sendTimesByFingerprint.get(fingerprint) ?? []).filter((time) => time > windowStart);
    sendTimesOfLastMinute = sendTimesOfLastMinute.filter((time) => time > now - 60_000);
    if (fingerprintTimes.length >= limits.windowed.sendsPerFingerprintPerWindow) return false;
    if (sendTimesOfLastMinute.length >= limits.windowed.eventsPerMinute) return false;
    fingerprintTimes.push(now);
    sendTimesByFingerprint.set(fingerprint, fingerprintTimes);
    sendTimesOfLastMinute.push(now);
    // A long-lived process sees many one-off fingerprints: forget the expired ones.
    if (sendTimesByFingerprint.size > 500) {
      for (const [key, times] of sendTimesByFingerprint) {
        if (times.every((time) => time <= windowStart)) sendTimesByFingerprint.delete(key);
      }
    }
    return true;
  };

  const scheduleFlush = (delayMs: number) => {
    if (flushTimer !== null) return;
    flushTimer = clock.setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delayMs);
  };

  const recordFailure = () => {
    if (rateLimitMode === 'session') {
      failedSends += 1;
      if (failedSends >= limits.session.failedSendsBeforeStop) {
        isStopped = true;
        queue = [];
      }
      return;
    }
    backoffMs = backoffMs ? Math.min(backoffMs * 2, limits.windowed.backoffMaxMs) : limits.windowed.backoffStartMs;
    backoffUntil = clock.now() + backoffMs;
  };

  const recordSuccess = () => {
    backoffMs = 0;
    backoffUntil = 0;
  };

  /** Up to `eventsPerRequest` events and `requestBytes`, oldest first. */
  const takeBatch = (): QueuedEvent[] => {
    const batch: QueuedEvent[] = [];
    let bytes = REQUEST_OVERHEAD_BYTES;
    while (queue.length > 0 && batch.length < limits.eventsPerRequest) {
      const next = queue[0] as QueuedEvent;
      const eventBytes = measureEvent(next.event) + 1;
      if (batch.length > 0 && bytes + eventBytes > limits.requestBytes) break;
      bytes += eventBytes;
      batch.push(next);
      queue.shift();
    }
    return batch;
  };

  const buildHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    try {
      const accessToken = readAuthorization?.();
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    } catch {
      // No session to attribute: the report goes anonymous.
    }
    if (options.serverToken) headers[options.serverTokenHeader ?? DDD_ISSUES_SERVER_TOKEN_HEADER] = options.serverToken;
    return headers;
  };

  const buildContext = (): CapturedIssueContext => {
    let contextValues: IssuesContextValues = {};
    try {
      contextValues = options.context?.() ?? {};
    } catch {
      // A context that cannot be read leaves its fields null.
    }
    return { ...NO_CONTEXT, ...contextValues, runtime: options.runtime, app: options.app };
  };

  const sendBatch = async (batch: QueuedEvent[], unloading = false): Promise<void> => {
    if (batch.length === 0) return;
    let endpoint: string | null = null;
    try {
      endpoint = options.endpoint();
    } catch {
      endpoint = null;
    }
    if (!endpoint) return;
    const body = JSON.stringify(wire.toRequestBody(buildContext(), batch.map((queued) => wire.toWireEvent(queued.event))));
    const useKeepalive = isBrowser && !isKeepaliveInFlight;
    if (useKeepalive) isKeepaliveInFlight = true;

    let status: number | null = null;
    try {
      status = (await options.transport({ url: endpoint, headers: buildHeaders(), body, keepalive: useKeepalive, unloading })).status;
    } catch {
      status = null;
    } finally {
      if (useKeepalive) isKeepaliveInFlight = false;
    }

    if (status !== null && status < 400) {
      recordSuccess();
      return;
    }
    const isRetryable = status === null || status >= 500;
    const retryable = isRetryable ? batch.filter((queued) => queued.attempts === 0) : [];
    recordFailure();
    if (retryable.length > 0 && !isStopped) {
      queue = [...retryable.map((queued) => ({ ...queued, attempts: queued.attempts + 1 })), ...queue];
      scheduleFlush(Math.max(limits.retryDelayMs, backoffUntil - clock.now()));
    }
  };

  const flush = async (flushOptions?: { unloading?: boolean }): Promise<void> => {
    try {
      if (flushTimer !== null) {
        clock.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (queue.length === 0 || isStopped) return;
      if (rateLimitMode === 'windowed' && clock.now() < backoffUntil) {
        scheduleFlush(backoffUntil - clock.now());
        return;
      }
      if (flushOptions?.unloading) {
        // The page is going away: no awaiting, every batch now (only the first can ride keepalive).
        while (queue.length > 0) void sendBatch(takeBatch(), true);
        return;
      }
      if (isSending) return;
      isSending = true;
      try {
        await sendBatch(takeBatch());
      } finally {
        isSending = false;
      }
      if (queue.length > 0) scheduleFlush(limits.flushDelayMs);
    } catch {
      // Never into the caller.
    }
  };

  const toTags = (tags: CaptureExtra['tags']): CapturedTag[] =>
    Object.entries(tags ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .slice(0, limits.tagsPerEvent)
      .map(([key, value]) => ({
        key: truncate(key, limits.tagLength),
        value: truncate(redactor.redactText(value), limits.tagLength),
      }));

  const captureError = (error: unknown, kind: IssueKind = 'manual', extra: CaptureExtra = {}) => {
    try {
      const normalized = normalizeError(error, isInAppFile);
      let isAutomated = false;
      try {
        isAutomated = options.isAutomated?.() ?? false;
      } catch {
        isAutomated = false;
      }
      if (findIssueDropRule({ ...normalized, automated: isAutomated }, dropRules)) return;

      const message = truncate(redactor.redactText(normalized.message), limits.messageLength);
      const frames = normalized.frames.slice(0, limits.framesPerEvent);
      const fingerprint = truncate(buildClientFingerprint(normalized.name, message, frames), limits.clientFingerprintLength);

      const alreadyQueued = queue.find((candidate) => candidate.event.clientFingerprint === fingerprint);
      if (alreadyQueued) {
        alreadyQueued.event.count += 1;
        return;
      }
      if (!admit(fingerprint)) return;

      const url = extra.url !== undefined ? extra.url : route.url;
      const routePattern = extra.routePattern !== undefined ? extra.routePattern : route.routePattern;
      let commonTags: CaptureExtra['tags'] = {};
      try {
        commonTags = options.commonTags?.() ?? {};
      } catch {
        commonTags = {};
      }
      const event = shrinkToFit({
        occurredAt: new Date(clock.now()).toISOString(),
        kind,
        level: extra.level ?? 'error',
        name: truncate(normalized.name, limits.nameLength),
        message,
        frames,
        rawStack: normalized.rawStack ? truncate(redactor.redactText(normalized.rawStack), limits.rawStackLength) : null,
        url: url ? truncate(redactor.redactUrl(url), limits.urlLength) : null,
        routePattern: routePattern ? truncate(routePattern, limits.routePatternLength) : null,
        requestMethod: extra.requestMethod ? truncate(extra.requestMethod.toUpperCase(), limits.requestMethodLength) : null,
        httpStatus: extra.httpStatus ?? null,
        breadcrumbs: attachBreadcrumbs ? trail.snapshot() : [],
        tags: toTags({ ...commonTags, ...extra.tags }),
        count: 1,
        clientFingerprint: fingerprint,
      });

      queue.push({ event, attempts: 0 });
      if (queue.length > limits.queuedEvents) queue.shift();
      if (queue.length >= limits.flushAtEvents) void flush();
      else scheduleFlush(limits.flushDelayMs);
    } catch {
      // Never into the caller.
    }
  };

  return {
    captureError,
    addBreadcrumb: (breadcrumb) => {
      try {
        trail.add(sanitizeBreadcrumb(breadcrumb, redactor));
      } catch {
        // Never into the caller.
      }
    },
    setRoute: (routePattern, url) => {
      route = { routePattern, url };
    },
    setAuthorizationReader: (reader) => {
      readAuthorization = reader;
    },
    flush,
    getQueuedEventCount: () => queue.length,
  };
};
