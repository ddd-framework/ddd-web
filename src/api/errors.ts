// The error normalization lives in `/contract` (no RTK Query runtime); `/api` re-exports it unchanged.
export {
  normalizeDddError,
  getErrorMessage,
  getErrorStatus,
  DEFAULT_ERROR_MESSAGE,
  DEFAULT_ERROR_MESSAGES,
} from '../contract/error-normalization';
export type { DddNormalizedError, DddErrorMessages } from '../contract/error-normalization';
