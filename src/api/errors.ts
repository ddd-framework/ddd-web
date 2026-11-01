import type { DddErrorBody, DddExceptionDetail } from '../contract/errors';

/** A DDD API error in one predictable shape, whatever produced it (RTK Query, a thrown Error, a raw body). */
export interface DddNormalizedError {
  /**
   * HTTP status, or RTK Query's string status for non-HTTP failures (`FETCH_ERROR`, `TIMEOUT_ERROR`,
   * `CUSTOM_ERROR`); a `PARSING_ERROR` reports the original HTTP status. `null` when unknown.
   */
  status: number | string | null;
  /** Human-readable message: the backend's `error` key first, then a text body, then generic fallbacks. */
  message: string;
  /** The backend's `validationErrors` exactly as received (present on validation 400s), else `null`. */
  validationErrors: unknown;
  /** `exceptionDetails.elements` of the backend body; empty when absent. */
  details: DddExceptionDetail[];
  /** The raw response body (parsed JSON, text, or `undefined`). */
  body: unknown;
}

/** Message used when an error carries no message at all. */
export const DEFAULT_ERROR_MESSAGE = 'Request failed';

/**
 * Messages for failures that carry no usable backend message. Pass your own (e.g. translated) texts as the third
 * argument of {@link normalizeDddError} / {@link getErrorMessage}.
 */
export interface DddErrorMessages {
  /** A response that is not JSON (an HTML error page, a PHP fatal) with an HTTP status ≥ 500. */
  serverError: (status: number) => string;
  /** A response that is not JSON with an HTTP status < 500. */
  httpError: (status: number) => string;
  /** The request never reached the server or got no response (`FETCH_ERROR`). */
  networkError: string;
  /** The request timed out (`TIMEOUT_ERROR`). */
  timeoutError: string;
}

/** The default {@link DddErrorMessages}. */
export const DEFAULT_ERROR_MESSAGES: DddErrorMessages = {
  serverError: (status) => `Server error (HTTP ${status})`,
  httpError: (status) => `Request failed (HTTP ${status})`,
  networkError: 'The server could not be reached',
  timeoutError: 'The request timed out',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** Unwraps the places a response body can sit: RTK `data`, an Error's `responseBody`, or the value itself. */
const extractBody = (error: Record<string, unknown>): unknown => {
  if ('data' in error) return error.data;
  if ('responseBody' in error) return error.responseBody;
  if ('error' in error || 'validationErrors' in error || 'exceptionDetails' in error) return error;
  return undefined;
};

const extractStatus = (error: Record<string, unknown>): number | string | null => {
  if (error.status === 'PARSING_ERROR' && typeof error.originalStatus === 'number') return error.originalStatus;
  if (typeof error.status === 'number' || typeof error.status === 'string') return error.status;
  if (typeof error.statusCode === 'number') return error.statusCode;
  return null;
};

/**
 * The message of an RTK Query failure that is not a DDD response: an unparsable body (`PARSING_ERROR`), no response
 * (`FETCH_ERROR`), a timeout (`TIMEOUT_ERROR`); `null` for everything else.
 */
const transportFailureMessage = (
  error: Record<string, unknown>,
  texts: DddErrorMessages,
  fallbackMessage: string,
): string | null => {
  switch (error.status) {
    case 'PARSING_ERROR': {
      const status = typeof error.originalStatus === 'number' ? error.originalStatus : null;
      if (status === null) return fallbackMessage;
      return status >= 500 ? texts.serverError(status) : texts.httpError(status);
    }
    case 'FETCH_ERROR':
      return texts.networkError;
    case 'TIMEOUT_ERROR':
      return texts.timeoutError;
    default:
      return null;
  }
};

/**
 * Normalises any API error into {@link DddNormalizedError}.
 *
 * Understands RTK Query's `FetchBaseQueryError` (`{ status, data }`, `{ status: 'FETCH_ERROR', error }`, …),
 * `SerializedError` / `Error` (`message`), errors carrying a parsed `responseBody`, and a bare DDD error body.
 * DDD error bodies put the message under `error` (not `message`).
 *
 * A response the client could not parse (`PARSING_ERROR`: an HTML error page, a PHP fatal, a proxy's 502) is an HTTP
 * error: `status` is the HTTP status and the message is {@link DddErrorMessages.serverError} /
 * {@link DddErrorMessages.httpError} — never the parser's `SyntaxError` text and never the raw body, which may show
 * internals (the body stays available in `body`). `FETCH_ERROR` and `TIMEOUT_ERROR` get
 * {@link DddErrorMessages.networkError} / {@link DddErrorMessages.timeoutError} instead of the browser's text.
 *
 * @param error whatever a request rejected with
 * @param fallbackMessage message when nothing usable is found
 * @param messages texts for failures without a backend message (default {@link DEFAULT_ERROR_MESSAGES})
 */
export function normalizeDddError(
  error: unknown,
  fallbackMessage: string = DEFAULT_ERROR_MESSAGE,
  messages: Partial<DddErrorMessages> = {},
): DddNormalizedError {
  const texts: DddErrorMessages = { ...DEFAULT_ERROR_MESSAGES, ...messages };
  if (!isRecord(error)) {
    return {
      status: null,
      message: nonEmptyString(error) ?? fallbackMessage,
      validationErrors: null,
      details: [],
      body: undefined,
    };
  }

  const body = extractBody(error);
  const failure = transportFailureMessage(error, texts, fallbackMessage);
  if (failure !== null) {
    return { status: extractStatus(error), message: failure, validationErrors: null, details: [], body };
  }
  const dddBody: DddErrorBody | null = isRecord(body) ? (body as DddErrorBody) : null;
  const bodyRecord: Record<string, unknown> | null = isRecord(body) ? body : null;

  const message =
    nonEmptyString(dddBody?.error) ??
    nonEmptyString(bodyRecord?.message) ??
    // RTK's non-HTTP errors carry the reason in `error` (e.g. "TypeError: Failed to fetch").
    (body === undefined || typeof body === 'string' ? nonEmptyString(error.error) : null) ??
    // A non-JSON error body (e.g. a download endpoint answering with plain text) is the message itself.
    nonEmptyString(body)?.trim() ??
    nonEmptyString(error.message) ??
    fallbackMessage;

  return {
    status: extractStatus(error),
    message,
    validationErrors: dddBody?.validationErrors ?? null,
    details: dddBody?.exceptionDetails?.elements ?? [],
    body,
  };
}

/**
 * The message to show for an API error (`normalizeDddError(error).message`).
 *
 * @param error whatever a request rejected with
 * @param fallbackMessage message when nothing usable is found
 * @param messages texts for failures without a backend message
 */
export function getErrorMessage(
  error: unknown,
  fallbackMessage: string = DEFAULT_ERROR_MESSAGE,
  messages: Partial<DddErrorMessages> = {},
): string {
  return normalizeDddError(error, fallbackMessage, messages).message;
}

/** HTTP status of an API error (also of an unparsable response), or `null` for non-HTTP failures. */
export function getErrorStatus(error: unknown): number | null {
  const status = normalizeDddError(error).status;
  return typeof status === 'number' ? status : null;
}
