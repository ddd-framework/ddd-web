import type { InvalidationOperation, InvalidationResolver, InvalidationTag } from './config';
import type { EndpointInfo } from './endpoints';
import { type Logger, SdkGenerationError } from './log';
import type { HttpMethod, OpenApiDocument, OpenApiOperation } from './openapi';
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
/** `accessor` reads the id from the endpoint argument, e.g. `arg.bookId` (or `arg` with `flattenArg`). */
const byArg = (tag: string, accessor: string): string => `{ type: '${tag}' as const, id: ${accessor} }`;
const withArg = (items: string): string => `(_result: unknown, _error: unknown, arg: any) => [${items}]`;

/** Provided tags from `x-ddd-entity`: a query provides by its path identity, otherwise LIST. */
function entityProvidesExpression(endpoint: EndpointInfo, info: OperationInfo, tag: string): TagExpression {
  const identity = info.entity?.identity?.startsWith('path:') ? info.entity.identity.slice('path:'.length) : null;
  const pathIdentity = identity ? (endpoint.pathArgs[identity] ?? null) : null;
  if (pathIdentity && info.entity?.action !== 'list') {
    return { key: 'providesTags', line: withArg(byArg(tag, pathIdentity)) };
  }
  return { key: 'providesTags', line: `[${list(tag)}]` };
}

/** Path heuristic: GET single (`/<collection>/{id}`) → provides by id; list / filter → provides LIST. */
function heuristicProvidesExpression(endpoint: EndpointInfo, tag: string): TagExpression {
  const trailing = trailingPlaceholder(endpoint.path);
  const single = trailing !== null && isPrimaryEntityPath(endpoint.path, tag) ? (endpoint.pathArgs[trailing] ?? null) : null;
  return single
    ? { key: 'providesTags', line: withArg(byArg(tag, single)) }
    : { key: 'providesTags', line: `[${list(tag)}]` };
}

// ── invalidation ────────────────────────────────────────────────────────────────────────────────────────────────

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DOTTED_PATH = /^([A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*)?$/;

/** `arg.foo.bar` → `foo.bar`; `arg` → `''`. */
function relativeAccessor(accessor: string): string | null {
  if (accessor === 'arg') return '';
  return accessor.startsWith('arg.') && DOTTED_PATH.test(accessor.slice(4)) ? accessor.slice(4) : null;
}

function joinPath(base: string, rest: string): string {
  return [base, rest].filter(Boolean).join('.');
}

const listTag = (type: string): InvalidationTag => ({ type, id: 'LIST' });
const argTag = (type: string, arg: string): InvalidationTag => ({ type, arg });

/** Lower-cased singular candidates of a tag (`Books` → `book`, `Categories` → `category`, `Media` → `media`). */
function singularForms(tag: string): string[] {
  const lower = tag.toLowerCase();
  const forms = new Set([lower]);
  if (lower.endsWith('ies')) forms.add(`${lower.slice(0, -3)}y`);
  if (lower.endsWith('es')) forms.add(lower.slice(0, -2));
  if (lower.endsWith('s')) forms.add(lower.slice(0, -1));
  return [...forms];
}

/**
 * The path parameter that identifies an entity of `tag`, or null:
 * - named after the tag's entity (`{bookId}` for `Books`), anywhere in the path — also with an action
 *   suffix (`/books/{bookId}/publish`);
 * - otherwise a parameter right after the tag's collection segment that does not name another entity
 *   (`/books/{id}`, `/books/{slug}`, but not `/books/{authorId}/…`).
 * The last qualifying parameter wins.
 */
export function identityPathParameter(path: string, tag: string): string | null {
  const singulars = singularForms(tag);
  const segments = path.split('/').filter(Boolean);
  let found: string | null = null;
  segments.forEach((segment, index) => {
    const name = segment.match(/^\{([^}]+)\}$/)?.[1];
    if (!name) return;
    const idMatch = name.match(/^(.+?)(Id|ID|_id)$/);
    if (idMatch && singulars.includes(idMatch[1]!.toLowerCase())) {
      found = name;
      return;
    }
    const previous = segments[index - 1];
    const namesOtherEntity = idMatch !== null;
    if (!namesOtherEntity && previous && !previous.startsWith('{') && segmentToPascal(previous).toLowerCase() === tag.toLowerCase()) {
      found = name;
    }
  });
  return found;
}

type JsonSchema = {
  $ref?: string;
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  content?: Record<string, { schema?: JsonSchema } | undefined>;
};

const SCHEMA_PREFIX = '#/components/schemas/';

/** Schema name referenced by a schema (directly or as the single member of allOf / oneOf / anyOf). */
function referencedName(schema: JsonSchema | undefined): string | null {
  if (!schema) return null;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith(SCHEMA_PREFIX)) return schema.$ref.slice(SCHEMA_PREFIX.length);
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const members = (schema[key] ?? []).filter((member) => member && !(member as { type?: string }).type?.includes('null'));
    if (members.length === 1) return referencedName(members[0]);
  }
  return null;
}

function schemaByName(doc: OpenApiDocument, name: string): JsonSchema | undefined {
  return (doc.components?.schemas as Record<string, JsonSchema> | undefined)?.[name];
}

/** The request body schema of an operation (first content type with a schema; `#/components/requestBodies` refs resolved). */
function requestBodySchema(doc: OpenApiDocument, operation: OpenApiOperation): JsonSchema | undefined {
  let body = operation.requestBody as JsonSchema | undefined;
  if (body?.$ref?.startsWith('#/components/requestBodies/')) {
    body = (doc.components?.requestBodies as Record<string, JsonSchema> | undefined)?.[body.$ref.slice('#/components/requestBodies/'.length)];
  }
  for (const media of Object.values(body?.content ?? {})) {
    if (media?.schema) return media.schema;
  }
  return undefined;
}

/**
 * Dotted path of the identity inside the request body, or null: the body is an entity of `tag` with an `id`
 * (`id`), or exactly one body property references the tag's entities and it is a single entity with an `id`
 * (`book.id` for `{ book: Book }`). A body that also carries a set or a second entity of the tag (merge, batch) has no
 * single identity.
 */
export function identityBodyPath(doc: OpenApiDocument, operation: OpenApiOperation, tag: string, lookup: Map<string, string>): string | null {
  const schema = requestBodySchema(doc, operation);
  if (!schema) return null;
  const isTag = (name: string): boolean => entityTag(name, lookup).toLowerCase() === tag.toLowerCase();
  const hasId = (name: string): boolean => !!schemaByName(doc, name)?.properties?.id;
  const bodyName = referencedName(schema);
  if (bodyName && isTag(bodyName) && hasId(bodyName)) return 'id';
  const resolved = bodyName ? schemaByName(doc, bodyName) : schema;
  let references = 0;
  let candidate: string | null = null;
  for (const [property, propertySchema] of Object.entries(resolved?.properties ?? {})) {
    const single = referencedName(propertySchema);
    const element = single ? null : referencedName(propertySchema?.items);
    const name = single ?? element;
    if (!name || !isTag(name)) continue;
    references++;
    if (single && hasId(single) && IDENTIFIER.test(property)) candidate = property;
  }
  return references === 1 && candidate ? `${candidate}.id` : null;
}

/** Tags from `x-ddd-entity` (authoritative): upsert / delete invalidate the identity + LIST, other writes the whole tag. */
function entityInvalidation(endpoint: EndpointInfo, info: OperationInfo, tag: string): InvalidationTag[] {
  const action = info.entity?.action;
  const identity = info.entity?.identity ?? '';
  if (action === 'upsert' || action === 'delete') {
    if (identity.startsWith('path:')) {
      const accessor = endpoint.pathArgs[identity.slice('path:'.length)];
      const relative = accessor !== undefined ? relativeAccessor(accessor) : null;
      if (relative !== null) return [argTag(tag, relative), listTag(tag)];
    }
    if (identity.startsWith('body:') && endpoint.bodyArg !== undefined) {
      const body = relativeAccessor(endpoint.bodyArg);
      const inner = identity.slice('body:'.length);
      if (body !== null && DOTTED_PATH.test(inner)) return [listTag(tag), argTag(tag, joinPath(body, inner))];
    }
  }
  return [listTag(tag), tag];
}

/**
 * Identity heuristic (no `x-ddd-entity`): a path parameter naming the entity → the entity + LIST; else the entity
 * property of the request body (`<entity>.id`) → LIST + the entity when the body carries an id (a create without id
 * only invalidates LIST); else no identity is known → LIST + the whole tag type.
 */
function heuristicInvalidation(endpoint: EndpointInfo, info: OperationInfo | undefined, tag: string, doc: OpenApiDocument, lookup: Map<string, string>): InvalidationTag[] {
  const parameter = identityPathParameter(endpoint.path, tag);
  const accessor = parameter ? endpoint.pathArgs[parameter] : undefined;
  const relative = accessor !== undefined ? relativeAccessor(accessor) : null;
  if (relative !== null) return [argTag(tag, relative), listTag(tag)];
  if (info && endpoint.bodyArg !== undefined) {
    const body = relativeAccessor(endpoint.bodyArg);
    const inner = identityBodyPath(doc, info.operation, tag, lookup);
    if (body !== null && inner) return [listTag(tag), argTag(tag, joinPath(body, inner))];
  }
  return [listTag(tag), tag];
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Validates a resolver result; returns the tag types it uses. */
function checkTags(tags: unknown, key: string): InvalidationTag[] {
  if (!Array.isArray(tags)) throw new SdkGenerationError(`invalidation for ${key} must return an array or undefined.`);
  for (const tag of tags as unknown[]) {
    const type = typeof tag === 'string' ? tag : (tag as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || type === '') {
      throw new SdkGenerationError(`invalidation for ${key}: every tag needs a non-empty type (got ${JSON.stringify(tag)}).`);
    }
    if (typeof tag === 'object') {
      const candidate = tag as { id?: unknown; arg?: unknown };
      const hasId = typeof candidate.id === 'string' || typeof candidate.id === 'number';
      const hasArg = typeof candidate.arg === 'string' && DOTTED_PATH.test(candidate.arg);
      if (hasId === hasArg) {
        throw new SdkGenerationError(
          `invalidation for ${key}: tag ${JSON.stringify(tag)} needs either an id (string / number) or an arg (dotted path).`,
        );
      }
    }
  }
  return tags as InvalidationTag[];
}

/** Helper emitted into the enhanced file for ids that may be absent (body identities). */
const ID_HELPER = 'tagWithId';
const ID_HELPER_SOURCE = [
  '// `{ type, id }` only when the id is known: a tag with `id: undefined` would invalidate every entry of the type.',
  `const ${ID_HELPER} = <T extends string>(type: T, id: unknown): Array<{ type: T; id: string | number }> =>`,
  "  typeof id === 'string' || typeof id === 'number' ? [{ type, id }] : [];",
];

/** Renders invalidation tags; tags that read the argument make it a function. */
function renderInvalidation(tags: InvalidationTag[], endpoint: EndpointInfo): string {
  const pathArgs = new Set(Object.values(endpoint.pathArgs).map(relativeAccessor));
  let readsArg = false;
  const items = tags.map((tag) => {
    if (typeof tag === 'string') return `{ type: ${quote(tag)} as const }`;
    if ('id' in tag) return `{ type: ${quote(tag.type)} as const, id: ${typeof tag.id === 'number' ? tag.id : quote(tag.id)} }`;
    readsArg = true;
    if (pathArgs.has(tag.arg)) return `{ type: ${quote(tag.type)} as const, id: ${tag.arg === '' ? 'arg' : `arg.${tag.arg}`} }`;
    const optional = tag.arg === '' ? 'arg' : `arg?.${tag.arg.split('.').join('?.')}`;
    return `...${ID_HELPER}(${quote(tag.type)} as const, ${optional})`;
  });
  return readsArg ? withArg(items.join(', ')) : `[${items.join(', ')}]`;
}

/** Tag types named by a tag list. */
function tagTypes(tags: InvalidationTag[]): string[] {
  return tags.map((tag) => (typeof tag === 'string' ? tag : tag.type));
}

/**
 * `invalidation` resolver that restores the 0.2 default: writes without an identity from `x-ddd-entity` (a path
 * identity on an upsert / delete) invalidate LIST plus their whole tag type instead of the derived identity.
 * `defineConfig({ invalidation: broadInvalidation, … })`.
 */
export const broadInvalidation: InvalidationResolver = (operation) => {
  if (!operation.tag || !operation.sideEffects) return undefined;
  const entity = operation.entity;
  if (entity?.identity?.startsWith('path:') && (entity.action === 'upsert' || entity.action === 'delete')) return undefined;
  return [{ type: operation.tag, id: 'LIST' }, operation.tag];
};

export interface EnhanceInput {
  stem: string;
  /** `exportName` of the api entry (passed to `invalidation` resolvers). */
  apiName?: string;
  apiModuleImport: string;
  baseApiImport: string;
  baseApiName: string;
  audience: string;
  endpoints: EndpointInfo[];
  index: OperationIndex;
  /** The spec (request body schemas for the identity heuristic). */
  doc?: OpenApiDocument;
  /** Operation tags (normalised, sorted). */
  operationTags: string[];
  /** Resolvers checked in order; the first that returns a list wins. */
  invalidation?: InvalidationResolver[];
  logger: Logger;
}

export interface EnhanceResult {
  source: string;
  /** Operation tags plus tags introduced by `x-ddd-entity` or `invalidation`, sorted. */
  tagTypes: string[];
}

export function buildEnhancedEndpoints(input: EnhanceInput): EnhanceResult {
  const { endpoints, index, audience, logger } = input;
  const doc: OpenApiDocument = input.doc ?? {};
  const resolvers = input.invalidation ?? [];
  const lookup = new Map(input.operationTags.map((tag) => [tag.toLowerCase(), tag]));
  const allTags = new Set(input.operationTags);
  const used = new Set<string>();
  const lines: string[] = [];
  let skipped = 0;
  let urlFallbacks = 0;
  let identities = 0;
  let wholeType = 0;

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

    let expression: TagExpression | null = null;
    if (endpoint.buildType === 'query') {
      if (tag) expression = info?.entity ? entityProvidesExpression(endpoint, info, tag) : heuristicProvidesExpression(endpoint, tag);
    } else {
      let defaultTags: InvalidationTag[] = [];
      if (tag && (!info || info.sideEffects)) {
        defaultTags = info?.entity ? entityInvalidation(endpoint, info, tag) : heuristicInvalidation(endpoint, info, tag, doc, lookup);
      }
      let tags = defaultTags;
      if (resolvers.length > 0) {
        const operation: InvalidationOperation = {
          key: endpoint.key,
          api: input.apiName ?? input.stem,
          method: endpoint.method.toUpperCase() as Uppercase<HttpMethod>,
          path: endpoint.path,
          tag,
          ...(info ? { operation: info.operation } : {}),
          ...(info?.entity ? { entity: info.entity } : {}),
          sideEffects: info?.sideEffects ?? true,
          pathArgs: Object.fromEntries(
            Object.entries(endpoint.pathArgs).flatMap(([name, accessor]) => {
              const relative = relativeAccessor(accessor);
              return relative === null ? [] : [[name, relative]];
            }),
          ),
          ...(endpoint.bodyArg !== undefined && relativeAccessor(endpoint.bodyArg) !== null
            ? { bodyArg: relativeAccessor(endpoint.bodyArg)! }
            : {}),
          defaultTags: defaultTags.map((entry) => (typeof entry === 'string' ? entry : { ...entry })),
        };
        for (const resolver of resolvers) {
          const result = resolver(operation);
          if (result !== undefined) {
            tags = checkTags(result, endpoint.key);
            break;
          }
        }
      }
      if (tag || tags.length > 0) {
        expression = { key: 'invalidatesTags', line: renderInvalidation(tags, endpoint) };
        for (const type of tagTypes(tags)) {
          used.add(type);
          allTags.add(type);
        }
        if (tags.some((entry) => typeof entry !== 'string' && 'arg' in entry)) identities++;
        else if (tags.some((entry) => typeof entry === 'string')) wholeType++;
      }
    }
    if (!expression) {
      logger.warn(`No tag for ${endpoint.key} (${endpoint.url}) — no cache tags generated.`);
      skipped++;
      continue;
    }
    lines.push(`    ${endpoint.key}: {`, `      ${expression.key}: ${expression.line},`, '    },');
    if (tag) used.add(tag);
  }

  const varName = `${input.stem}Enhanced`;
  const source = [
    GENERATED_HEADER,
    '',
    `// Import ${input.stem} first (side effect: registers its endpoints on the base api).`,
    `import '${input.apiModuleImport}';`,
    `import { ${input.baseApiName} } from '${input.baseApiImport}';`,
    '',
    ...(lines.some((line) => line.includes(`...${ID_HELPER}(`)) ? [...ID_HELPER_SOURCE, ''] : []),
    '// enhanceEndpoints mutates the endpoint definitions in place: import this file once (e.g. in the store)',
    `// and keep using the hooks from ${input.stem} — they pick up the tags.`,
    `export const ${varName} = ${input.baseApiName}.enhanceEndpoints({`,
    `  addTagTypes: [${[...used].sort().map((tag) => quote(tag)).join(', ')}],`,
    '  endpoints: {',
    ...lines,
    '  },',
    '});',
    '',
  ].join('\n');

  logger.info(
    `  enhanced ${endpoints.length - skipped} endpoints (${skipped} without tag, ${urlFallbacks} via URL fallback, ${used.size} tag types; ` +
      `${identities} writes by identity, ${wholeType} invalidate a whole tag type)`,
  );
  return { source, tagTypes: [...allTags].sort() };
}
