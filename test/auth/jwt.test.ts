import { describe, expect, it } from 'vitest';
import { decodeJwt, getTokenExpiry, isExpired } from '../../src/auth';
import { fakeJwt } from '../api/helpers';

const NOW = 1_800_000_000_000; // ms

describe('jwt', () => {
  it('decodes base64url payloads incl. UTF-8', () => {
    const token = fakeJwt({ accountId: 7, expiresAt: 1_800_000_100, name: 'Zoë?>' });
    expect(decodeJwt(token)).toEqual({ accountId: 7, expiresAt: 1_800_000_100, name: 'Zoë?>' });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeJwt(null)).toBeNull();
    expect(decodeJwt('abc')).toBeNull();
    expect(decodeJwt('a.%%%.c')).toBeNull();
    expect(decodeJwt(`x.${Buffer.from('[1]').toString('base64')}.y`)).toBeNull();
  });

  it('reads expiry from expiresAt, else exp', () => {
    expect(getTokenExpiry(fakeJwt({ expiresAt: 10, exp: 20 }))).toBe(10);
    expect(getTokenExpiry(fakeJwt({ exp: 20 }))).toBe(20);
    expect(getTokenExpiry(fakeJwt({ accountId: 1 }))).toBeNull();
    expect(getTokenExpiry({ expiresAt: 5 })).toBe(5);
  });

  it('isExpired honours the skew', () => {
    const token = fakeJwt({ expiresAt: NOW / 1000 + 20 });
    expect(isExpired(token, 0, NOW)).toBe(false);
    expect(isExpired(token, 30, NOW)).toBe(true);
    expect(isExpired(fakeJwt({ exp: NOW / 1000 - 1 }), 0, NOW)).toBe(true);
    expect(isExpired('garbage', 0, NOW)).toBe(true);
    expect(isExpired(fakeJwt({ accountId: 1 }), 0, NOW)).toBe(false);
  });
});
