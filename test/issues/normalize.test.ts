import { describe, expect, it } from 'vitest';
import { normalizeError, parseStack } from '../../src/issues';

const v8Stack = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  '    at renderRow (https://app.example.com/_next/static/chunks/0-7jpg.js:1:2345)',
  '    at https://app.example.com/_next/static/chunks/25yb.js:2:10',
  '    at async loadBooks (https://app.example.com/assets/index-3f2a.js:7:8)',
  '    at new BookList (https://app.example.com/assets/index-3f2a.js:9:1)',
  '    at Array.map (<anonymous>)',
  '    at chrome-extension://abc/content.js:1:1',
  '    at Object.read (/srv/app/node_modules/lib/index.js:3:4)',
].join('\n');

describe('issues normalize', () => {
  it('parses V8 frames innermost first and tells in-app from foreign files', () => {
    const frames = parseStack(v8Stack, (file) => file.startsWith('https://app.example.com/'));
    expect(frames).toHaveLength(7);
    expect(frames[0]).toEqual({
      file: 'https://app.example.com/_next/static/chunks/0-7jpg.js',
      line: 1,
      column: 2345,
      function: 'renderRow',
      inApp: true,
    });
    expect(frames[1]).toMatchObject({ function: null, line: 2, column: 10, inApp: true });
    expect(frames[2]).toMatchObject({ function: 'loadBooks' });
    expect(frames[3]).toMatchObject({ function: 'BookList' });
    expect(frames[4]).toMatchObject({ file: '<anonymous>', line: null, column: null, function: 'Array.map', inApp: false });
    expect(frames[5]).toMatchObject({ file: 'chrome-extension://abc/content.js', inApp: false });
    expect(frames[6]).toMatchObject({ inApp: false });
  });

  it('parses SpiderMonkey / JavaScriptCore frames', () => {
    const frames = parseStack('renderRow@https://app.example.com/a.js:1:20\n@https://app.example.com/b.js:3:4\n');
    expect(frames).toEqual([
      { file: 'https://app.example.com/a.js', line: 1, column: 20, function: 'renderRow', inApp: true },
      { file: 'https://app.example.com/b.js', line: 3, column: 4, function: null, inApp: true },
    ]);
  });

  it('caps the frames at 30', () => {
    const longStack = Array.from({ length: 40 }, (_, index) => `    at f${index} (https://app.example.com/a.js:${index + 1}:1)`).join('\n');
    expect(parseStack(longStack)).toHaveLength(30);
  });

  it('normalizes any thrown value', () => {
    expect(normalizeError('plain text')).toEqual({ name: 'Error', message: 'plain text', frames: [], rawStack: null });
    expect(normalizeError({ code: 7 })).toMatchObject({ name: 'NonError', message: '{"code":7}' });
    expect(normalizeError(undefined)).toMatchObject({ name: 'NonError', message: 'undefined' });
    expect(normalizeError(null)).toMatchObject({ message: 'null' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(normalizeError(circular)).toMatchObject({ name: 'NonError', message: '[object Object]' });
  });

  it('names a minified React error by its code', () => {
    const error = new Error('Minified React error #418; visit https://react.dev/errors/418 for the full message');
    expect(normalizeError(error).name).toBe('ReactError#418');
  });

  it('keeps a raw stack only when no frame could be parsed', () => {
    const error = Object.assign(new Error('boom'), { stack: 'Error: boom\nsomething unparseable\nmore' });
    expect(normalizeError(error)).toMatchObject({ frames: [], rawStack: 'Error: boom\nsomething unparseable\nmore' });
    const parsed = Object.assign(new Error('boom'), { stack: 'Error: boom\n    at f (https://x.test/a.js:1:2)' });
    expect(normalizeError(parsed).rawStack).toBeNull();
  });

  it('caps name, message and raw stack', () => {
    const error = Object.assign(new Error('m'.repeat(2000)), { name: 'N'.repeat(200), stack: `x\n${'s'.repeat(5000)}` });
    const normalized = normalizeError(error);
    expect(normalized.name).toHaveLength(128);
    expect(normalized.message).toHaveLength(1024);
    expect(normalized.rawStack).toHaveLength(4096);
  });
});
