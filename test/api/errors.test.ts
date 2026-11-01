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

  it('gives network failures and timeouts a readable message, not the browser text', () => {
    const normalized = normalizeDddError({ status: 'FETCH_ERROR', error: 'TypeError: Failed to fetch' });
    expect(normalized).toMatchObject({ status: 'FETCH_ERROR', message: 'The server could not be reached', validationErrors: null });
    expect(getErrorStatus({ status: 'FETCH_ERROR', error: 'x' })).toBeNull();
    expect(getErrorMessage({ status: 'TIMEOUT_ERROR', error: 'AbortError: signal timed out' })).toBe('The request timed out');
    expect(getErrorStatus({ status: 'TIMEOUT_ERROR', error: 'x' })).toBeNull();
  });

  it('treats an unparsable response as an HTTP error and never shows the SyntaxError or the body', () => {
    const fatal = {
      status: 'PARSING_ERROR',
      originalStatus: 500,
      data: '<html><body><b>Fatal error</b>: Uncaught Error in /var/www/src/Foo.php:12</body></html>',
      error: "SyntaxError: Unexpected token '<', \"<html><bod\"... is not valid JSON",
    };
    const normalized = normalizeDddError(fatal);
    expect(normalized).toMatchObject({ status: 500, message: 'Server error (HTTP 500)', validationErrors: null, details: [] });
    expect(normalized.message).not.toContain('SyntaxError');
    expect(normalized.message).not.toContain('Fatal');
    expect(normalized.body).toBe(fatal.data);
    expect(getErrorStatus(fatal)).toBe(500);
    expect(getErrorMessage({ status: 'PARSING_ERROR', originalStatus: 502, data: '<html>Bad gateway</html>', error: 'SyntaxError: Unexpected token <' }))
      .toBe('Server error (HTTP 502)');
    expect(getErrorMessage({ status: 'PARSING_ERROR', originalStatus: 404, data: '<html>Not Found</html>', error: 'SyntaxError: x' }))
      .toBe('Request failed (HTTP 404)');
    expect(getErrorMessage({ status: 'PARSING_ERROR', data: '<html>', error: 'SyntaxError: x' }, 'Fallback')).toBe('Fallback');
  });

  it('takes custom (e.g. translated) texts for failures without a backend message', () => {
    const messages = { serverError: (status: number) => `Serverfehler (${status})`, networkError: 'Keine Verbindung' };
    expect(getErrorMessage({ status: 'PARSING_ERROR', originalStatus: 503, data: '<html>', error: 'SyntaxError: x' }, undefined, messages))
      .toBe('Serverfehler (503)');
    expect(getErrorMessage({ status: 'FETCH_ERROR', error: 'TypeError: Failed to fetch' }, undefined, messages)).toBe('Keine Verbindung');
    expect(getErrorMessage({ status: 'TIMEOUT_ERROR', error: 'x' }, undefined, messages)).toBe('The request timed out');
  });

  it('keeps a DDD JSON body and a custom error as they are', () => {
    expect(getErrorMessage({ status: 500, data: { error: 'Database unavailable' } })).toBe('Database unavailable');
    expect(getErrorMessage({ status: 'CUSTOM_ERROR', error: 'Handled by the app' })).toBe('Handled by the app');
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
