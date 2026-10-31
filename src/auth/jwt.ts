/**
 * JWT helpers. They DECODE only — no signature verification; never base an authorisation decision on them.
 */

/** Claims of a decoded JWT. DDD tokens carry `accountId` and `expiresAt` (unix seconds). */
export interface DddJwtClaims {
  accountId?: number | string;
  /** Unix timestamp in seconds, set by the DDD backend on every token. */
  expiresAt?: number;
  /** Standard JWT expiry (unix seconds); used when `expiresAt` is absent. */
  exp?: number;
  [claim: string]: unknown;
}

const decodeBase64Url = (segment: string): string => {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/**
 * Decodes the payload of a JWT without verifying it.
 *
 * @returns the claims, or `null` when the token is missing or malformed.
 */
export function decodeJwt<T extends object = DddJwtClaims>(token: string | null | undefined): T | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(decodeBase64Url(payload));
    return claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? (claims as T) : null;
  } catch {
    return null;
  }
}

/**
 * Expiry of a token in unix seconds, read from `expiresAt` (DDD) or else `exp` (standard claim).
 *
 * @param tokenOrClaims a raw JWT or already decoded claims
 * @returns the expiry, or `null` when the token is malformed or carries no expiry claim.
 */
export function getTokenExpiry(tokenOrClaims: string | DddJwtClaims | null | undefined): number | null {
  const claims = typeof tokenOrClaims === 'string' ? decodeJwt(tokenOrClaims) : (tokenOrClaims ?? null);
  if (!claims) return null;
  const expiry = claims.expiresAt ?? claims.exp;
  const seconds = typeof expiry === 'string' ? Number(expiry) : expiry;
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
}

/**
 * True when the token is expired or expires within `skewSeconds`.
 *
 * A missing or malformed token counts as expired. A well-formed token without any expiry claim never expires.
 *
 * @param token raw JWT
 * @param skewSeconds safety margin; e.g. `30` treats a token that expires in 20 s as expired
 * @param now current time in milliseconds (injectable for tests)
 */
export function isExpired(token: string | null | undefined, skewSeconds = 0, now: number = Date.now()): boolean {
  const claims = decodeJwt(token);
  if (!claims) return true;
  const expiry = getTokenExpiry(claims);
  if (expiry === null) return false;
  return now / 1000 + skewSeconds >= expiry;
}
