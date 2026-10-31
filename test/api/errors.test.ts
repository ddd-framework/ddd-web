import { describe, expect, it } from 'vitest';
import { getErrorMessage, getErrorStatus, normalizeDddError } from '../../src/api';

describe('normalizeDddError', () => {
  it('reads a DDD validation 400 and keeps validationErrors', () => {
    const validationErrors = { elements: [{ propertyPath: 'email', message: 'Invalid email' }] };
    const normalized = normalizeDddError({
      status: 400,
      data: {
        error: 'Validation failed',
        validationErrors,
        exceptionDetails: { elements: [{ message: 'email: Invalid email' }] },
      },
    });
    expect(normalized.status).toBe(400);
    expect(normalized.message).toBe('Validation failed');
    expect(normalized.validationErrors).toBe(validationErrors);
    expect(normalized.details).toEqual([{ message: 'email: Invalid email' }]);
  });

  it('prefers the DDD `error` key over `message`', () => {
    expect(getErrorMessage({ status: 403, data: { error: 'Insufficient permissions', message: 'x' } })).toBe(
      'Insufficient permissions',
    );
    expect(getErrorMessage({ status: 500, data: { message: 'From message' } })).toBe('From message');
  });

  it('handles RTK non-HTTP errors', () => {
    const normalized = normalizeDddError({ status: 'FETCH_ERROR', error: 'TypeError: Failed to fetch' });
    expect(normalized).toMatchObject({ status: 'FETCH_ERROR', message: 'TypeError: Failed to fetch', validationErrors: null });
    expect(getErrorStatus({ status: 'FETCH_ERROR', error: 'x' })).toBeNull();
  });

  it('reports the original status of a parsing error and does not use HTML as message', () => {
    const normalized = normalizeDddError({
      status: 'PARSING_ERROR',
      originalStatus: 502,
      data: '<html>Bad gateway</html>',
      error: 'SyntaxError: Unexpected token <',
    });
    expect(normalized.status).toBe(502);
    expect(normalized.message).toBe('SyntaxError: Unexpected token <');
  });

  it('handles thrown errors, bodies attached to errors, bare bodies and junk', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    const withBody = Object.assign(new Error('{"error":"x"}'), { responseBody: { error: 'Nope', validationErrors: [1] } });
    expect(normalizeDddError(withBody)).toMatchObject({ message: 'Nope', validationErrors: [1] });
    expect(getErrorMessage({ error: 'Bare body' })).toBe('Bare body');
    expect(getErrorMessage(undefined, 'Fallback')).toBe('Fallback');
    expect(getErrorMessage('plain string')).toBe('plain string');
    expect(normalizeDddError(null).details).toEqual([]);
  });
});
