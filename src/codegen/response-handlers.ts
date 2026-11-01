import type { ResponseHandlerOverride } from './config';
import type { EndpointInfo } from './endpoints';
import type { OpenApiDocument } from './openapi';
import { listOperations, operationKey } from './openapi';
import type TypeScript from 'typescript';
import { SdkGenerationError } from './log';
import { matchesOperation } from './operations';
import { loadTypeScript } from './typescript';

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
 * Inserts `responseHandler: "text"` / `responseHandler: blobResponseHandler` into the object returned by each
 * endpoint's `query` function, and imports `blobResponseHandler` from {@link DDD_WEB_API_IMPORT} when needed.
 *
 * Endpoints are located on the TypeScript syntax tree (property `key: build.query<…>(…)` /
 * `build.mutation<…>(…)`), so the result does not depend on how the source is formatted or wrapped. Throws an
 * {@link SdkGenerationError} listing every endpoint whose handler could not be injected — the generated result type
 * already assumes the handler, so a silent skip would produce an SDK that lies about its responses.
 */
export function injectResponseHandlers(source: string, endpointKinds: ReadonlyMap<string, Exclude<ResponseKind, 'json'>>): string {
  if (endpointKinds.size === 0) return source;
  const ts = loadTypeScript();
  const file = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: { position: number; text: string }[] = [];
  const found = new Set<string>();
  const failed = new Map<string, string>();
  let usesBlob = false;

  const visit = (node: TypeScript.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(ts, node.name);
      const kind = key === undefined ? undefined : endpointKinds.get(key);
      if (key !== undefined && kind && isBuildCall(ts, node.initializer)) {
        if (found.has(key)) {
          failed.set(key, 'defined more than once');
          return;
        }
        found.add(key);
        const target = queryReturnObject(ts, node.initializer);
        if (typeof target === 'string') {
          failed.set(key, target);
          return;
        }
        const edit = insertProperty(source, target, `responseHandler: ${HANDLER_EXPRESSION[kind]}`);
        if (typeof edit === 'string') {
          failed.set(key, edit);
          return;
        }
        edits.push(...edit);
        if (kind === 'blob') usesBlob = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  for (const key of endpointKinds.keys()) {
    if (!found.has(key) && !failed.has(key)) failed.set(key, 'no `build.query` / `build.mutation` definition found');
  }
  if (failed.size > 0) {
    const list = [...failed].map(([key, reason]) => `  - ${key} (${endpointKinds.get(key)}): ${reason}`).join('\n');
    throw new SdkGenerationError(`Could not inject the responseHandler into ${failed.size} endpoint(s):\n${list}`);
  }

  let result = source;
  for (const { position, text } of edits.sort((a, b) => b.position - a.position)) {
    result = result.slice(0, position) + text + result.slice(position);
  }
  return usesBlob ? `import { blobResponseHandler } from '${DDD_WEB_API_IMPORT}';\n${result}` : result;
}

function propertyName(ts: typeof TypeScript, name: TypeScript.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

/** `build.query<…>(…)` or `build.mutation<…>(…)`. */
function isBuildCall(ts: typeof TypeScript, node: TypeScript.Expression): node is TypeScript.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === 'query' || node.expression.name.text === 'mutation')
  );
}

/** The object literal returned by the endpoint's `query` function, or the reason it could not be found. */
function queryReturnObject(ts: typeof TypeScript, call: TypeScript.CallExpression): TypeScript.ObjectLiteralExpression | string {
  const definition = call.arguments[0];
  if (!definition || !ts.isObjectLiteralExpression(definition)) return 'endpoint definition is not an object literal';
  const query = definition.properties.find(
    (property) => property.name !== undefined && propertyName(ts, property.name) === 'query',
  );
  if (!query) return 'no `query` property';
  let fn: TypeScript.Expression | undefined;
  if (ts.isPropertyAssignment(query)) fn = query.initializer;
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return '`query` is not a function';
  let body: TypeScript.Node = fn.body;
  if (ts.isBlock(body)) {
    const returns = body.statements.filter(ts.isReturnStatement);
    if (returns.length !== 1 || !returns[0]!.expression) return '`query` does not have exactly one return statement';
    body = returns[0]!.expression;
  }
  while (ts.isParenthesizedExpression(body as TypeScript.Expression)) body = (body as TypeScript.ParenthesizedExpression).expression;
  if (!ts.isObjectLiteralExpression(body)) return '`query` does not return an object literal';
  if (body.properties.some((property) => property.name !== undefined && propertyName(ts, property.name) === 'responseHandler')) {
    return '`query` already returns a responseHandler';
  }
  return body;
}

/** Text edits that add `property` as the last member of `object`, matching its single- or multi-line layout. */
function insertProperty(
  source: string,
  object: TypeScript.ObjectLiteralExpression,
  property: string,
): { position: number; text: string }[] | string {
  const close = object.end - 1;
  if (source[close] !== '}') return 'unexpected object literal end';
  const last = object.properties[object.properties.length - 1];
  if (!last) return [{ position: close, text: ` ${property} ` }];
  const trailingComma = object.properties.hasTrailingComma === true;
  const lineStart = source.lastIndexOf('\n', close) + 1;
  const indent = source.slice(lineStart, close);
  if (lineStart > last.end && /^[ \t]*$/.test(indent)) {
    // closing brace on its own line: a new member line above it
    const edits = [{ position: lineStart, text: `${indent}  ${property},\n` }];
    if (!trailingComma) edits.push({ position: last.end, text: ',' });
    return edits;
  }
  // `{ url: … }` → `{ url: …, responseHandler: … }`
  return trailingComma ? [{ position: close, text: `${property} ` }] : [{ position: last.end, text: `, ${property}` }];
}
