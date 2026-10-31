import type { EndpointInfo } from './endpoints';
import type { Logger } from './log';
import { operationKey } from './openapi';
import type { OperationIndex, OperationInfo } from './operations';
import { entityTag, GENERATED_HEADER, normalizeTag } from './tags';

/** kebab-case URL segment → PascalCase; segments that already contain capitals stay as they are. */
function segmentToPascal(segment: string): string {
  if (!segment) return '';
  if (/[A-Z]/.test(segment)) return segment;
  return segment
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** Fallback when the operation has no matching tag: the last path segment that names a known tag. */
function tagFromPath(path: string, lookup: Map<string, string>): string | null {
  let matched: string | null = null;
  for (const segment of path.replace(/\{[^}]+\}/g, '').split('/').filter(Boolean)) {
    matched = lookup.get(segmentToPascal(segment).toLowerCase()) ?? matched;
  }
  return matched;
}

function tagFromOperation(info: OperationInfo | undefined, audience: string, lookup: Map<string, string>): string | null {
  for (const raw of info?.operation.tags ?? []) {
    const found = lookup.get(normalizeTag(raw, audience).toLowerCase());
    if (found) return found;
  }
  return null;
}

/** Name of the placeholder that ends the path (`/books/{bookId}` → `bookId`). */
function trailingPlaceholder(path: string): string | null {
  return path.match(/\{([^}]+)\}\/?$/)?.[1] ?? null;
}

/** `/<collection>/{id}` where the collection segment names the tag → single entity; otherwise a filter arg. */
function isPrimaryEntityPath(path: string, tag: string): boolean {
  const segments = path
    .replace(/\{[^}]+\}\/?$/, '')
    .split('/')
    .filter(Boolean);
  const last = segments[segments.length - 1];
  return last !== undefined && segmentToPascal(last).toLowerCase() === tag.toLowerCase();
}

type TagKey = 'providesTags' | 'invalidatesTags';
interface TagExpression {
  key: TagKey;
  line: string;
}

const list = (tag: string): string => `{ type: '${tag}' as const, id: 'LIST' }`;
const broad = (tag: string): string => `{ type: '${tag}' as const }`;
/** `accessor` reads the id from the endpoint argument, e.g. `arg.bookId` (or `arg` with `flattenArg`). */
const byArg = (tag: string, accessor: string): string => `{ type: '${tag}' as const, id: ${accessor} }`;
const withArg = (items: string): string => `(_result: unknown, _error: unknown, arg: any) => [${items}]`;

/** Tags from `x-ddd-entity`: upsert/delete invalidate LIST + the entity, queries provide by id or LIST. */
function entityTagExpression(endpoint: EndpointInfo, info: OperationInfo, tag: string): TagExpression {
  const identity = info.entity?.identity?.startsWith('path:') ? info.entity.identity.slice('path:'.length) : null;
  const pathIdentity = identity ? (endpoint.pathArgs[identity] ?? null) : null;
  if (endpoint.buildType === 'query') {
    if (pathIdentity && info.entity?.action !== 'list') {
      return { key: 'providesTags', line: withArg(byArg(tag, pathIdentity)) };
    }
    return { key: 'providesTags', line: `[${list(tag)}]` };
  }
  if (pathIdentity && (info.entity?.action === 'upsert' || info.entity?.action === 'delete')) {
    return { key: 'invalidatesTags', line: withArg(`${byArg(tag, pathIdentity)}, ${list(tag)}`) };
  }
  return { key: 'invalidatesTags', line: `[${list(tag)}, ${broad(tag)}]` };
}

/**
 * Path-shape heuristic (specs without `x-ddd-entity`):
 *   GET single → provides by id;  GET list/filter → provides LIST;
 *   every write → invalidates LIST + the whole entity tag. Without entity metadata a write's reach is unknown (a POST
 *   may be an upsert of an existing entity, a PATCH may change what lists show), so it invalidates conservatively.
 */
function heuristicTagExpression(endpoint: EndpointInfo, tag: string): TagExpression {
  const trailing = trailingPlaceholder(endpoint.path);
  const single = trailing !== null && isPrimaryEntityPath(endpoint.path, tag) ? (endpoint.pathArgs[trailing] ?? null) : null;
  if (endpoint.buildType === 'query') {
    return single
      ? { key: 'providesTags', line: withArg(byArg(tag, single)) }
      : { key: 'providesTags', line: `[${list(tag)}]` };
  }
  return { key: 'invalidatesTags', line: `[${list(tag)}, ${broad(tag)}]` };
}

export interface EnhanceInput {
  stem: string;
  apiModuleImport: string;
  baseApiImport: string;
  baseApiName: string;
  audience: string;
  endpoints: EndpointInfo[];
  index: OperationIndex;
  /** Operation tags (normalised, sorted). */
  operationTags: string[];
  logger: Logger;
}

export interface EnhanceResult {
  source: string;
  /** Operation tags plus tags introduced by `x-ddd-entity`, sorted. */
  tagTypes: string[];
}

export function buildEnhancedEndpoints(input: EnhanceInput): EnhanceResult {
  const { endpoints, index, audience, logger } = input;
  const lookup = new Map(input.operationTags.map((tag) => [tag.toLowerCase(), tag]));
  const allTags = new Set(input.operationTags);
  const used = new Set<string>();
  const lines: string[] = [];
  let skipped = 0;
  let urlFallbacks = 0;

  for (const endpoint of endpoints) {
    const info = index.byKey.get(operationKey(endpoint.method, endpoint.path));
    let tag: string | null;
    if (info?.entity) {
      tag = entityTag(info.entity.schema, lookup);
      allTags.add(tag);
      lookup.set(tag.toLowerCase(), tag);
    } else {
      tag = tagFromOperation(info, audience, lookup);
      if (!tag) {
        tag = tagFromPath(endpoint.path, lookup);
        if (tag) urlFallbacks++;
      }
    }
    if (!tag) {
      logger.warn(`No tag for ${endpoint.key} (${endpoint.url}) — no cache tags generated.`);
      skipped++;
      continue;
    }

    let expression: TagExpression;
    if (endpoint.buildType === 'mutation' && info && !info.sideEffects) {
      expression = { key: 'invalidatesTags', line: '[]' };
    } else if (info?.entity) {
      expression = entityTagExpression(endpoint, info, tag);
    } else {
      expression = heuristicTagExpression(endpoint, tag);
    }
    lines.push(`    ${endpoint.key}: {`, `      ${expression.key}: ${expression.line},`, '    },');
    used.add(tag);
  }

  const varName = `${input.stem}Enhanced`;
  const source = [
    GENERATED_HEADER,
    '',
    `// Import ${input.stem} first (side effect: registers its endpoints on the base api).`,
    `import '${input.apiModuleImport}';`,
    `import { ${input.baseApiName} } from '${input.baseApiImport}';`,
    '',
    '// enhanceEndpoints mutates the endpoint definitions in place: import this file once (e.g. in the store)',
    `// and keep using the hooks from ${input.stem} — they pick up the tags.`,
    `export const ${varName} = ${input.baseApiName}.enhanceEndpoints({`,
    `  addTagTypes: [${[...used].sort().map((tag) => `'${tag}'`).join(', ')}],`,
    '  endpoints: {',
    ...lines,
    '  },',
    '});',
    '',
  ].join('\n');

  logger.info(
    `  enhanced ${endpoints.length - skipped} endpoints (${skipped} without tag, ${urlFallbacks} via URL fallback, ${used.size} tag types)`,
  );
  return { source, tagTypes: [...allTags].sort() };
}
