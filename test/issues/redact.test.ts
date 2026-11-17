import { describe, expect, it } from 'vitest';
import { createIssuesRedactor, redactText, redactUrl } from '../../src/issues';

describe('issues redact', () => {
  it('redacts the segment after a token path segment (the backend defaults)', () => {
    expect(redactUrl('https://x.test/invitations/abc123?x=1')).toBe('https://x.test/invitations/[redacted]?x=1');
    expect(redactUrl('/reset-password/s3cret')).toBe('/reset-password/[redacted]');
    expect(redactUrl('/claim-account/k#top')).toBe('/claim-account/[redacted]#top');
  });

  it('redacts token query values', () => {
    expect(redactUrl('/reset?resetToken=s3cret&lang=en')).toBe('/reset?resetToken=[redacted]&lang=en');
    expect(redactUrl('/a?token=1&access_token=2')).toBe('/a?token=[redacted]&access_token=[redacted]');
  });

  it('redacts UUIDs and long hex path segments, keeps short ids', () => {
    expect(redactUrl('/api/public/bookings/0b7c2a6e-1f3d-4c8b-9a2e-5d6f7a8b9c0d/cancel')).toBe('/api/public/bookings/[uuid]/cancel');
    expect(redactUrl('/files/0123456789abcdef0123/view')).toBe('/files/[id]/view');
    expect(redactUrl('/books/12/chapters/abc')).toBe('/books/12/chapters/abc');
  });

  it('redacts e-mails, bearer tokens, JWTs and phone numbers in text', () => {
    expect(redactText('user ana@example.com Bearer abc.def call +44 20 7946 0958')).toBe(
      'user [email] Bearer [redacted] call [phone]',
    );
    expect(redactText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature-1 expired')).toBe('token [jwt] expired');
  });

  it('leaves a plain message alone and is idempotent', () => {
    const message = "Cannot read properties of undefined (reading 'name')";
    expect(redactText(message)).toBe(message);
    const once = redactUrl('/invitations/abc?token=x&mail=ana@example.com');
    expect(redactUrl(once)).toBe(once);
  });

  it('takes the app own token segments and extra rules', () => {
    const redactor = createIssuesRedactor({
      tokenPathSegments: ['r/confirm', '/magic-link/'],
      additionalRules: [{ pattern: /\b0\d{3}[\s-]\d{3}[\s-]\d{3,4}\b/g, replacement: '[phone]' }],
    });
    expect(redactor.redactUrl('/r/confirm/xyz?x=1')).toBe('/r/confirm/[redacted]?x=1');
    expect(redactor.redactUrl('/magic-link/abc')).toBe('/magic-link/[redacted]');
    expect(redactor.redactUrl('/invitations/abc')).toBe('/invitations/abc');
    expect(redactor.redactText('call 0712 345 678')).toBe('call [phone]');
    expect(createIssuesRedactor({ tokenPathSegments: [] }).redactUrl('/invitations/abc')).toBe('/invitations/abc');
  });

  it('ends a token at whitespace, quotes and closing brackets so the rest of the text keeps its rules', () => {
    expect(redactText('check: /reset-password/abc123secret call 0712 345 678 mail someone@example.com')).toBe(
      'check: /reset-password/[redacted] call 0712 345 678 mail [email]',
    );
    const redactor = createIssuesRedactor({
      tokenPathSegments: ['r/confirm'],
      additionalRules: [{ pattern: /\b0\d{3}[\s-]\d{3}[\s-]\d{3,4}\b/g, replacement: '[phone]' }],
    });
    expect(redactor.redactText('check: /r/confirm/abc123secret call 0712 345 678 mail someone@example.com')).toBe(
      'check: /r/confirm/[redacted] call [phone] mail [email]',
    );
    expect(redactor.redactText('https://x.test/r/confirm/tok123?x=1 failed for a@b.co')).toBe(
      'https://x.test/r/confirm/[redacted]?x=1 failed for [email]',
    );
    expect(redactText('failed at /invitations/abc123')).toBe('failed at /invitations/[redacted]');
    expect(redactUrl('/verify-email/abc123#frag')).toBe('/verify-email/[redacted]#frag');
    expect(redactText(`open '/invitations/abc123' and "/invitations/def456" or \`/invitations/ghi789\``)).toBe(
      `open '/invitations/[redacted]' and "/invitations/[redacted]" or \`/invitations/[redacted]\``,
    );
    expect(redactText('(see /claim-account/abc123) [/invitations/def456] </invitations/x>')).toBe(
      '(see /claim-account/[redacted]) [/invitations/[redacted]] </invitations/[redacted]>',
    );
    expect(redactText('loaded /x?token=abc123 then mail a@b.co')).toBe('loaded /x?token=[redacted] then mail [email]');
  });
});
