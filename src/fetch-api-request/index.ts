/**
 * The Fetch API's `Request` constructor for pages whose global `Request` is something else (MooTools 1.x and Prototype
 * replace `window.Request` with their Ajax class). RTK Query's `fetchBaseQuery` builds every request with the global
 * `Request`; in such a page the request leaves for `<page>/[object Object]`. A build step that hands the toolkit's query
 * module {@link FetchApiRequest} instead fixes it (see `@mgamadeus/ddd-web/vite`).
 *
 * This module imports nothing from Redux Toolkit, so the toolkit's own module can import it without a cycle.
 */

/** True for a Request object of the Fetch API, from this window or another one (a frame). */
export const isFetchApiRequest = (candidate: unknown): candidate is Request =>
  !!candidate && typeof candidate === 'object' && Object.prototype.toString.call(candidate) === '[object Request]';

/** True for the Fetch API's `Request` constructor (its prototype says `[object Request]`), from any window. */
export const isFetchApiRequestConstructor = (candidate: unknown): candidate is typeof Request =>
  typeof candidate === 'function' &&
  !!(candidate as { prototype?: unknown }).prototype &&
  Object.prototype.toString.call((candidate as { prototype: unknown }).prototype) === '[object Request]';

let resolvedRequestConstructor: typeof Request | null = null;
/** The frame the resolved constructor belongs to; null while the global constructor is the Fetch API's. */
let resolvedRequestFrame: HTMLIFrameElement | null = null;

const readRequestConstructorOfFrame = (frame: HTMLIFrameElement): unknown =>
  (frame.contentWindow as { Request?: unknown } | null)?.Request;

/**
 * Adds a hidden frame without an address, whose globals no script of the page has replaced. The frame stays in the
 * document: the constructors of a removed frame are not guaranteed to keep working.
 */
const addFrameWithFetchApiRequestConstructor = (): HTMLIFrameElement | null => {
  const document = (globalThis as { document?: Document }).document;
  if (!document?.createElement || !(document.body || document.documentElement)) return null;
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  (document.body ?? document.documentElement).appendChild(frame);
  if (isFetchApiRequestConstructor(readRequestConstructorOfFrame(frame))) return frame;
  frame.remove();
  return null;
};

/**
 * The Fetch API's `Request` constructor: the global one when it is genuine, else the one of a hidden frame without an
 * address that this module adds (same origin). Resolved once per page, again when a script removed the frame. A request
 * built with it is still sent by the page's `fetch`, so cookies and referrer are the page's.
 *
 * @throws Error when neither the global nor a frame provides one (no DOM, or the frame offers none).
 */
export function resolveFetchApiRequest(): typeof Request {
  const isFrameStillInPage = resolvedRequestFrame === null || resolvedRequestFrame.isConnected;
  if (resolvedRequestConstructor && isFrameStillInPage) return resolvedRequestConstructor;
  resolvedRequestConstructor = null;
  resolvedRequestFrame = null;
  const globalRequest = (globalThis as { Request?: unknown }).Request;
  if (isFetchApiRequestConstructor(globalRequest)) {
    resolvedRequestConstructor = globalRequest;
    return globalRequest;
  }
  const frame = addFrameWithFetchApiRequestConstructor();
  if (!frame) {
    throw new Error(
      "ddd-web: the global `Request` is not the Fetch API's (a library such as MooTools or Prototype replaced it), and no frame provides one.",
    );
  }
  resolvedRequestFrame = frame;
  resolvedRequestConstructor = readRequestConstructorOfFrame(frame) as typeof Request;
  return resolvedRequestConstructor;
}

/** Forgets the resolved constructor: the next request resolves it again (tests). */
export const forgetFetchApiRequest = (): void => {
  resolvedRequestConstructor = null;
  resolvedRequestFrame = null;
};

/**
 * A relative address resolved against the page: a frame's constructor would resolve it against the frame's
 * `about:blank`.
 */
const resolveAgainstPage = (input: RequestInfo | URL): RequestInfo | URL => {
  if (typeof input !== 'string') return input;
  const baseUri = (globalThis as { document?: Document }).document?.baseURI;
  return baseUri ? new URL(input, baseUri).href : input;
};

/**
 * Drop-in for the global `Request` that always builds a Fetch API request ({@link resolveFetchApiRequest}); the
 * constructor is resolved on the first `new`, not when the module loads.
 *
 * @example
 * const request = new FetchApiRequest('/api/client/items', { method: 'GET' });
 */
export const FetchApiRequest = function FetchApiRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  const RequestConstructor = resolveFetchApiRequest();
  return new RequestConstructor(RequestConstructor === (globalThis as { Request?: unknown }).Request ? input : resolveAgainstPage(input), init);
} as unknown as typeof Request;
