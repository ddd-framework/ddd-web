import type { ResponseHandlerOverride } from './config';
import type { EndpointInfo } from './endpoints';
import type { OpenApiDocument } from './openapi';
import { listOperations, operationKey } from './openapi';
import { matchesOperation } from './operations';

/** How a generated endpoint reads a successful response. `json` is RTK's default (no handler injected). */
export type ResponseKind = 'json' | 'text' | 'blob';

/** Import specifier of the package's `api` entry, used by generated binary endpoints. */
export const DDD_WEB_API_IMPORT = '@mgamadeus/ddd-web/api';

const TEXT_CONTENT_TYPES = ['text/html', 'text/plain', 'text/xml'];
const FILE_CONTENT_TYPES = [
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/pdf',
  'application/msword',
  'application/vnd.',
  'text/csv',
  'image/',
  'audio/',
  'video/',
  'font/',
];

/** Media type without parameters, lower case (`Application/PDF; q=1` → `application/pdf`). */
const mediaType = (type: string): string => type.split(';')[0]!.trim().toLowerCase();

/** JSON media types (`application/json`, `application/problem+json`, `application/vnd.api+json`, …). */
const isJsonType = (type: string): boolean => /(^|\/|\+)json$/.test(mediaType(type));

export const isTextContentType = (type: string): boolean =>
  !isJsonType(type) && TEXT_CONTENT_TYPES.some((text) => mediaType(type).startsWith(text));

/** Binary / file media types: archives, PDF, office documents (`application/vnd.*`), CSV, images, audio, video, fonts. */
export const isFileContentType = (type: string): boolean =>
  !isJsonType(type) && FILE_CONTENT_TYPES.some((file) => mediaType(type).startsWith(file));

/**
 * Response kind of one operation from its 2xx content types: a 2xx response with only file types (or file and text
 * types) is `blob`, one with only text types is `text`, everything else `json`. `blob` wins over `text`.
 */
export function detectResponseKind(responses: Record<string, { content?: Record<string, unknown> } | undefined> | undefined): ResponseKind {
  let kind: ResponseKind = 'json';
  for (const [status, response] of Object.entries(responses ?? {})) {
    const code = Number.parseInt(status, 10);
    if (Number.isNaN(code) || code < 200 || code >= 300) continue;
    const types = Object.keys(response?.content ?? {});
    if (types.length === 0) continue;
    if (!types.every((type) => isFileContentType(type) || isTextContentType(type))) continue;
    if (types.some(isFileContentType)) return 'blob';
    kind = 'text';
  }
  return kind;
}

/**
 * Response kind per generated endpoint key, for endpoints that need a `responseHandler` (`text` or `blob`).
 * Config overrides (first match wins) take precedence over content-type detection; an override `json` keeps RTK's
 * JSON parsing even for a detected text or file response.
 */
export function detectResponseHandlerEndpoints(
  doc: OpenApiDocument,
  endpoints: EndpointInfo[],
  overrides: ResponseHandlerOverride[] = [],
): Map<string, Exclude<ResponseKind, 'json'>> {
  const kinds = new Map<string, ResponseKind>();
  for (const { method, path, operation } of listOperations(doc)) {
    const override = overrides.find((candidate) => matchesOperation(candidate, method, path));
    const kind = override ? override.handler : detectResponseKind(operation.responses);
    if (kind !== 'json') kinds.set(operationKey(method, path), kind);
  }
  const keys = new Map<string, Exclude<ResponseKind, 'json'>>();
  if (kinds.size === 0) return keys;
  for (const endpoint of endpoints) {
    const kind = kinds.get(operationKey(endpoint.method, endpoint.path));
    if (kind === 'text' || kind === 'blob') keys.set(endpoint.key, kind);
  }
  return keys;
}

const HANDLER_EXPRESSION: Record<Exclude<ResponseKind, 'json'>, string> = {
  text: '"text"',
  blob: 'blobResponseHandler',
};

/**
 * Inserts `responseHandler: "text"` / `responseHandler: blobResponseHandler` before the closing brace of each
 * endpoint's `query` return object, and imports `blobResponseHandler` from {@link DDD_WEB_API_IMPORT} when needed.
 */
export function injectResponseHandlers(source: string, endpointKinds: ReadonlyMap<string, Exclude<ResponseKind, 'json'>>): string {
  if (endpointKinds.size === 0) return source;
  const starts = [...endpointKinds].map(([key, kind]) => ({
    regex: new RegExp(`^\\s+${key}:\\s+build\\.(?:query|mutation)<`),
    expression: HANDLER_EXPRESSION[kind],
  }));
  const lines = source.split('\n');
  const out: string[] = [];
  let index = 0;
  let usesBlob = false;
  while (index < lines.length) {
    const line = lines[index]!;
    const start = starts.find(({ regex }) => regex.test(line));
    if (!start) {
      out.push(line);
      index++;
      continue;
    }
    const block: string[] = [line];
    index++;
    let depth = 0;
    let started = false;
    while (index < lines.length) {
      const current = lines[index]!;
      for (const char of current) {
        if (char === '(' || char === '{') {
          depth++;
          started = true;
        } else if (char === ')' || char === '}') depth--;
      }
      block.push(current);
      index++;
      if (started && depth <= 0) break;
    }
    if (start.expression === HANDLER_EXPRESSION.blob) usesBlob = true;
    out.push(...injectIntoQueryReturn(block, start.expression));
  }
  const result = out.join('\n');
  return usesBlob ? `import { blobResponseHandler } from '${DDD_WEB_API_IMPORT}';\n${result}` : result;
}

function injectIntoQueryReturn(block: string[], expression: string): string[] {
  const out: string[] = [];
  let inReturn = false;
  let injected = false;
  let depth = 0;
  for (const line of block) {
    if (!injected && !inReturn && /\bquery:\s*\(?\w*\)?\s*=>\s*\(/.test(line)) {
      const singleLine = line.match(/^(.*\bquery:.*=>\s*\(\{.*?)\s*\}\)(,?\s*)$/);
      if (singleLine) {
        out.push(`${singleLine[1]}, responseHandler: ${expression} })${singleLine[2]}`);
        injected = true;
        continue;
      }
      inReturn = true;
      depth = 0;
    }
    if (inReturn && !injected) {
      for (const char of line) {
        if (char === '(' || char === '{') depth++;
        else if (char === ')' || char === '}') depth--;
      }
      if (depth <= 0) {
        const indent = line.match(/^(\s*)/)?.[1] ?? '      ';
        out.push(`${indent}  responseHandler: ${expression},`);
        inReturn = false;
        injected = true;
      }
    }
    out.push(line);
  }
  return out;
}
