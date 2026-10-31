/** One entry of `ExceptionDetails.elements` in a DDD error response. */
export interface DddExceptionDetail {
  message?: string | null;
  details?: unknown[] | null;
  objectType?: string | null;
}

/** `DDD.Infrastructure.Exceptions.ExceptionDetails`. */
export interface DddExceptionDetails {
  elements?: DddExceptionDetail[];
  objectType?: string | null;
}

/**
 * Body of every DDD error response (`DDD.Infrastructure.Exceptions.*Exception`, e.g. BadRequestException).
 * `validationErrors` is present on 400 responses caused by DTO/entity validation.
 */
export interface DddErrorBody {
  error?: string | null;
  validationErrors?: unknown;
  exceptionDetails?: DddExceptionDetails | null;
}
