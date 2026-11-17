import { describe, expect, it } from 'vitest';
import { buildClientFingerprint, normaliseIssueMessage, type CapturedFrame } from '../../src/issues';

const frame = (file: string, inApp: boolean, functionName: string | null = 'render'): CapturedFrame => ({
  file,
  line: 1,
  column: 2,
  function: functionName,
  inApp,
});

describe('issues fingerprint', () => {
  it('replaces URLs, UUIDs, hex ids and numbers', () => {
    expect(normaliseIssueMessage('order 41 failed')).toBe(normaliseIssueMessage('order 42 failed'));
    expect(normaliseIssueMessage('GET https://api.example.com/x?id=1 failed')).toBe('GET {url} failed');
    expect(normaliseIssueMessage('book 0b7c2a6e-1f3d-4c8b-9a2e-5d6f7a8b9c0d gone')).toBe('book {uuid} gone');
    expect(normaliseIssueMessage('hash deadbeefcafe')).toBe('hash {hex}');
  });

  it('uses the innermost in-app frame, else the innermost frame, and never line or column', () => {
    const frames = [frame('/vendor.js', false, 'x'), frame('/app.js', true)];
    expect(buildClientFingerprint('TypeError', 'e is not a function', frames)).toBe('TypeError|e is not a function|/app.js:render');
    expect(buildClientFingerprint('TypeError', 'm', [frame('/vendor.js', false, null)])).toBe('TypeError|m|/vendor.js:');
    expect(buildClientFingerprint('TypeError', 'm', [])).toBe('TypeError|m|');
    const moved = [{ ...frame('/app.js', true), line: 99, column: 7 }];
    expect(buildClientFingerprint('E', 'm', moved)).toBe(buildClientFingerprint('E', 'm', [frame('/app.js', true)]));
  });
});
