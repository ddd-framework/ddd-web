import type { FilterOperator } from './operators';

/**
 * Types of the `x-ddd-*` OpenAPI extensions emitted by DDD Core, plus the defaults that apply when an extension is
 * absent. All extensions are additive: a document without them is valid and is read with the defaults below.
 */

/** `info.x-ddd-contract`: contract number and the emitting `mgamadeus/ddd` version. */
export interface DddContractInfo {
  /** Contract number; bumped on every change of an `x-ddd-*` key, an implicit part or a default. */
  contract: number;
  /** Version of the `mgamadeus/ddd` package that emitted the document, e.g. `3.14.0`. */
  ddd: string;
}

/**
 * Column kind of a filter (`FiltersDefinition::COLUMN_KIND_*`): what a filter value is validated and bound as.
 * `translatable` is a plain `#[Translatable]` (JSON of all languages), `translatable-searchable` one with
 * `fullTextIndex: true` (comparisons run on its virtual search column).
 */
export type DddColumnKind =
  | 'int'
  | 'float'
  | 'bool'
  | 'string'
  | 'datetime'
  | 'json'
  | 'translatable'
  | 'translatable-searchable';

/**
 * Temporal kind of a filter (`FiltersDefinition::TEMPORAL_KIND_*`): `MOMENT` = an instant (date-time),
 * `DAY` = a calendar day (date, never zone-converted).
 */
export type DddTemporalKind = 'MOMENT' | 'DAY';

/**
 * A value rule for one operator of a filter. Known rules:
 * - `wildcard-required`: the value must contain `*` (plain Translatable `eq` / `ne`, a LIKE on the JSON text);
 * - `null-only`: only a null comparison is allowed (JSON columns).
 * Further rules may be added by the contract; unknown rules must be ignored by clients.
 */
export type DddFilterValueRule = 'wildcard-required' | 'null-only' | (string & {});

/** One filter definition inside `x-ddd-query.filters`. */
export interface DddFilterDefinition {
  /** Filter property name as used in `filters`, may be dotted (e.g. `author.name`). */
  name: string;
  /** Path of the filtered value in the response schema (e.g. `changeHistory.createdTime`); `null` if none. */
  path?: string | null;
  /** Column kind; absent or `null` = no value validation on the backend. */
  columnKind?: DddColumnKind | null;
  /** Temporal kind; absent or `null` = not temporal. */
  temporalKind?: DddTemporalKind | null;
  /** Whether `ft` / `fb` work on this filter (single-column FULLTEXT index). */
  supportsFulltext?: boolean;
  /** Allowed values (`FiltersDefinition::$options`); every value, also each list item, must be one of them. */
  options?: Array<string | number> | null;
  /** Operators allowed for this filter; absent = every operator the column kind accepts. */
  operators?: FilterOperator[];
  /** Value rules per operator. */
  valueRules?: Partial<Record<FilterOperator, DddFilterValueRule>>;
  /** Name of the expand that must be present in `expand` for this filter to be accepted; absent = none. */
  requiresExpand?: string | null;
}

/** One expand definition inside `x-ddd-query.expand`. */
export interface DddExpandDefinition {
  /** Property name to expand (no dots; nesting goes through `expand`). */
  name: string;
  /** `true` for a computed field (no relation, no clauses), e.g. a rendered SVG. */
  computed?: boolean;
  /** Default `top` inside the expand clause. */
  top?: number;
  /** Upper bound for `top` inside the expand clause. */
  maxTop?: number | null;
  /** Default `skip` inside the expand clause. */
  skip?: number;
  /** Filters available inside the expand clause (`filters=` in `(…)`). */
  filters?: DddFilterDefinition[];
  /** Sortable properties inside the expand clause. */
  orderBy?: string[];
  /** Nested expands (`expand=` in `(…)`). */
  expand?: DddExpandDefinition[];
}

/** `x-ddd-query` on an operation whose request DTO applies QueryOptions. */
export interface DddQueryDefinition {
  filters?: DddFilterDefinition[];
  /** Sortable property names. */
  orderBy?: string[];
  expand?: DddExpandDefinition[];
  /** `true` = `select` accepted (any property), a list = the selectable properties, `false`/absent = not exposed. */
  select?: boolean | string[];
  /** Default page size (backend default 50). */
  top?: number;
  /** Upper bound for `top` (`#[QueryOptions(maxTop: …)]`); a larger `top` answers 400. */
  maxTop?: number | null;
}

/** `x-ddd-entity.action`. DDD `#[Update]` is an upsert. */
export type DddEntityAction = 'list' | 'get' | 'upsert' | 'delete' | 'action';

/**
 * `x-ddd-entity` on an operation. Absent = unknown entity: clients derive the identity from the path or the request body
 * and invalidate the whole tag type only when none is found.
 */
export interface DddEntityInfo {
  /** Entity schema name, e.g. `App.Domain.Library.Entities.Books.Book`. */
  schema: string;
  action: DddEntityAction;
  /** Identity source, `path:<parameter>` or `body:<dotted.path>` (e.g. `body:book.id`). */
  identity?: string;
  /** `true` when derived by DDD Core, `false` when set explicitly via `#[OperationEntity]`. */
  derived: boolean;
}

/** Field-level `x-ddd-translatable` (from `#[Translatable]`). */
export interface DddTranslatableInfo {
  fullTextIndex?: boolean;
  fullTextMode?: string;
}

/** Extensions on the document `info` object. */
export interface DddInfoExtensions {
  'x-ddd-contract'?: DddContractInfo;
}

/** Extensions on an operation object. */
export interface DddOperationExtensions {
  'x-ddd-query'?: DddQueryDefinition;
  /** Absent = default by HTTP method (see {@link hasSideEffects}). */
  'x-ddd-side-effects'?: boolean;
  'x-ddd-entity'?: DddEntityInfo;
  /** Cache TTL in seconds from `#[RequestCache]`. */
  'x-ddd-cache-ttl'?: number;
}

/** Extensions on a schema property. */
export interface DddPropertyExtensions {
  'x-ddd-translatable'?: DddTranslatableInfo;
  /** `#[HideProperty]`: never in responses, accepted in requests (write-only). Absent = visible. */
  'x-ddd-hidden'?: boolean;
  /** The stored value is kept when the property is omitted on an update of an existing entity. */
  'x-ddd-preserve-on-omission'?: boolean;
}

/** Extensions on an entity schema. */
export interface DddSchemaExtensions {
  /** Roles required to write the entity (`RolesRequiredForUpdate`). */
  'x-ddd-roles-required-for-update'?: string[];
}

/** HTTP methods of OpenAPI operations (lowercase or uppercase accepted by the helpers). */
export type HttpMethod = 'get' | 'head' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'trace';

/**
 * Whether an operation has side effects (contract defaults, Appendix A.6): `x-ddd-side-effects` wins when present,
 * otherwise `false` for GET/HEAD/OPTIONS/TRACE and `true` for POST/PUT/PATCH/DELETE.
 */
export function hasSideEffects(method: string, operation?: Pick<DddOperationExtensions, 'x-ddd-side-effects'> | null): boolean {
  const explicit = operation?.['x-ddd-side-effects'];
  if (typeof explicit === 'boolean') {
    return explicit;
  }
  return !['get', 'head', 'options', 'trace'].includes(method.toLowerCase());
}

/** Whether a property is write-only (`x-ddd-hidden: true`). Absent = visible. */
export function isHiddenProperty(property?: DddPropertyExtensions | null): boolean {
  return property?.['x-ddd-hidden'] === true;
}

/** Whether a property keeps its stored value when omitted on an update (`x-ddd-preserve-on-omission: true`). */
export function isPreservedOnOmission(property?: DddPropertyExtensions | null): boolean {
  return property?.['x-ddd-preserve-on-omission'] === true;
}

/** Whether a property is `#[Translatable]` (`x-ddd-translatable` present). */
export function isTranslatableProperty(property?: DddPropertyExtensions | null): boolean {
  return property?.['x-ddd-translatable'] !== undefined && property['x-ddd-translatable'] !== null;
}

/** Parsed `x-ddd-entity.identity`. */
export interface DddEntityIdentity {
  source: 'path' | 'body';
  /** Path parameter name (`source: 'path'`) or dotted body path (`source: 'body'`). */
  name: string;
}

/** Parses `x-ddd-entity.identity` (`path:bookId`, `body:book.id`); `null` for an absent or malformed value. */
export function parseEntityIdentity(identity: string | null | undefined): DddEntityIdentity | null {
  if (!identity) {
    return null;
  }
  const match = /^(path|body):(.+)$/.exec(identity);
  if (!match) {
    return null;
  }
  return { source: match[1] as 'path' | 'body', name: match[2] as string };
}

/** Reads `info.x-ddd-contract` from an OpenAPI document; `null` when the document carries no contract version. */
export function getContractInfo(document: { info?: DddInfoExtensions | null } | null | undefined): DddContractInfo | null {
  const contract = document?.info?.['x-ddd-contract'];
  if (!contract || typeof contract.contract !== 'number' || typeof contract.ddd !== 'string') {
    return null;
  }
  return contract;
}
