import type { DddErrorBody, DddExceptionDetail } from '../contract/errors';

/** A DDD API error in one predictable shape, whatever produced it (RTK Query, a thrown Error, a raw body). */
export interface DddNormalizedError {
  /**
   * HTTP status, or RTK Query's string status for non-HTTP failures (`FETCH_ERROR`, `TIMEOUT_ERROR`,
   * `CUSTOM_ERROR`); a `PARSING_ERROR` reports the original HTTP status. `null` when unknown.
   */
  status: number | string | null;
  /** Human-readable message: the backend's `error` key first, then generic fallbacks. */
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
 * Normalises any API error into {@link DddNormalizedError}.
 *
 * Understands RTK Query's `FetchBaseQueryError` (`{ status, data }`, `{ status: 'FETCH_ERROR', error }`, …),
 * `SerializedError` / `Error` (`message`), errors carrying a parsed `responseBody`, and a bare DDD error body.
 * DDD error bodies put the message under `error` (not `message`).
 *
 * @param error whatever a request rejected with
 * @param fallbackMessage message when nothing usable is found
 */
export function normalizeDddError(error: unknown, fallbackMessage: string = DEFAULT_ERROR_MESSAGE): DddNormalizedError {
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
  const dddBody: DddErrorBody | null = isRecord(body) ? (body as DddErrorBody) : null;
  const bodyRecord: Record<string, unknown> | null = isRecord(body) ? body : null;

  const message =
    nonEmptyString(dddBody?.error) ??
    nonEmptyString(bodyRecord?.message) ??
    // RTK's non-HTTP errors carry the reason in `error` (e.g. "TypeError: Failed to fetch").
    (body === undefined || typeof body === 'string' ? nonEmptyString(error.error) : null) ??
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
 */
export function getErrorMessage(error: unknown, fallbackMessage: string = DEFAULT_ERROR_MESSAGE): string {
  return normalizeDddError(error, fallbackMessage).message;
}

/** HTTP status of an API error, or `null` for non-HTTP failures. */
export function getErrorStatus(error: unknown): number | null {
  const status = normalizeDddError(error).status;
  return typeof status === 'number' ? status : null;
}
