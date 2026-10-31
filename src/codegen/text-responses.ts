import type { EndpointInfo } from './endpoints';
import type { OpenApiDocument } from './openapi';
import { listOperations } from './openapi';

const TEXT_CONTENT_TYPES = ['text/html', 'text/plain', 'text/xml'];

const normalizePath = (value: string): string => value.replace(/\$\{[^}]+\}/g, '{p}').replace(/\{[^}]+\}/g, '{p}');

/** Endpoints whose 2xx responses are text only; RTK must not JSON-parse them. */
export function detectTextResponseEndpoints(doc: OpenApiDocument, endpoints: EndpointInfo[]): Set<string> {
  const textOperations = new Set<string>();
  for (const { method, path, operation } of listOperations(doc)) {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      const code = Number.parseInt(status, 10);
      if (Number.isNaN(code) || code < 200 || code >= 300) continue;
      const types = Object.keys(response?.content ?? {});
      if (types.length > 0 && types.every((type) => TEXT_CONTENT_TYPES.some((text) => type.startsWith(text)))) {
        textOperations.add(`${method.toUpperCase()}:${normalizePath(path)}`);
      }
    }
  }
  const keys = new Set<string>();
  if (textOperations.size === 0) return keys;
  for (const endpoint of endpoints) {
    if (textOperations.has(`${endpoint.method.toUpperCase()}:${normalizePath(endpoint.url)}`)) keys.add(endpoint.key);
  }
  return keys;
}

/** Inserts `responseHandler: "text"` before the closing brace of the endpoint's `query` return object. */
export function injectTextResponseHandlers(source: string, endpointKeys: Set<string>): string {
  if (endpointKeys.size === 0) return source;
  const starts = [...endpointKeys].map((key) => new RegExp(`^\\s+${key}:\\s+build\\.(?:query|mutation)<`));
  const lines = source.split('\n');
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!starts.some((regex) => regex.test(line))) {
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
    out.push(...injectIntoQueryReturn(block));
  }
  return out.join('\n');
}

function injectIntoQueryReturn(block: string[]): string[] {
  const out: string[] = [];
  let inReturn = false;
  let injected = false;
  let depth = 0;
  for (const line of block) {
    if (!injected && !inReturn && /\bquery:\s*\(?\w*\)?\s*=>\s*\(/.test(line)) {
      const singleLine = line.match(/^(.*\bquery:.*=>\s*\(\{.*?)\s*\}\)(,?\s*)$/);
      if (singleLine) {
        out.push(`${singleLine[1]}, responseHandler: "text" })${singleLine[2]}`);
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
        out.push(`${indent}  responseHandler: "text",`);
        inReturn = false;
        injected = true;
      }
    }
    out.push(line);
  }
  return out;
}
