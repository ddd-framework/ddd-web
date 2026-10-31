import { formatDddDate } from '../contract/datetime';
import type { DddExpandDefinition, DddFilterDefinition, DddQueryDefinition } from '../contract/extensions';
import { isFulltextOperator, NULL_OPERATORS, type FilterOperator } from '../contract/operators';
import type { QueryOptionsParams } from '../contract/query-options';
import { QueryOptionsError } from './errors';
import { toExpandTree, type ExpandInput, type ExpandTreeNode } from './expand';
import { assertValueFitsOperator, buildFieldFilter } from './filters';
import { filterScalarToString, type FilterScalar, type FilterValue } from './literals';
import { toOrderByEntries, type OrderByInput } from './order-by';
import { buildQueryOptions, type QueryOptionsInput } from './query-options';
import type { TopOverflow } from './paging';
import { isFilterValueValidForColumnKind } from './values';

/** Machine-readable reason of a {@link QueryIssue}. */
export type QueryIssueCode =
  | 'unknown-property'
  | 'operator-not-allowed'
  | 'fulltext-not-supported'
  | 'invalid-value-shape'
  | 'column-kind'
  | 'value-rule'
  | 'option-not-allowed'
  | 'expand-required'
  | 'unknown-expand'
  | 'computed-expand-clauses'
  | 'unknown-order-by'
  | 'select-not-supported'
  | 'unknown-select'
  | 'top-exceeds-max';

/** One problem found by the definition-driven validators; the backend would answer 400 for it. */
export interface QueryIssue {
  code: QueryIssueCode;
  message: string;
}

/** One filter condition before it is written as a string. */
export interface FilterCondition {
  property: string;
  operator: FilterOperator;
  value: FilterValue;
}

/** Context of a filter validation: the expands that will be sent with the filter. */
export interface FilterValidationContext {
  expand?: ExpandInput | null;
}

/** Thrown by the `buildDefined*` helpers; carries every issue found. */
export class QueryValidationError extends QueryOptionsError {
  readonly issues: QueryIssue[];

  constructor(issues: QueryIssue[]) {
    super(issues.map(issue => issue.message).join(' '));
    this.name = 'QueryValidationError';
    this.issues = issues;
  }
}

/** A resolved filter definition plus the expand chain it was reached through (`author.name` → `['author']`). */
export interface ResolvedFilterDefinition {
  definition: DddFilterDefinition;
  expandPath: string[];
}

/**
 * Finds the definition of a filter property. Mirrors `FiltersOptions::validateAgainstDefinitions()`: an exact name
 * match first; otherwise a dotted property (`author.name`) resolves through the expand definition of its first
 * segment and that expand's own filters, recursively.
 */
export function resolveFilterDefinition(
  query: Pick<DddQueryDefinition, 'filters' | 'expand'>,
  property: string,
): ResolvedFilterDefinition | undefined {
  const direct = query.filters?.find(filter => filter.name === property);
  if (direct) {
    return { definition: direct, expandPath: [] };
  }
  const dot = property.indexOf('.');
  if (dot < 0) {
    return undefined;
  }
  const first = property.slice(0, dot);
  const expandDefinition = query.expand?.find(expand => expand.name === first);
  if (!expandDefinition) {
    return undefined;
  }
  const nested = resolveFilterDefinition(expandDefinition, property.slice(dot + 1));
  return nested ? { definition: nested.definition, expandPath: [first, ...nested.expandPath] } : undefined;
}

/** Shorthand of {@link resolveFilterDefinition} returning only the definition. */
export function findFilterDefinition(
  query: Pick<DddQueryDefinition, 'filters' | 'expand'>,
  property: string,
): DddFilterDefinition | undefined {
  return resolveFilterDefinition(query, property)?.definition;
}

function scalarString(value: FilterScalar): string | null {
  return value === null ? null : filterScalarToString(value);
}

function isNullComparison(operator: FilterOperator, value: FilterValue): boolean {
  return (
    (NULL_OPERATORS as readonly string[]).includes(operator) &&
    (value === null || (typeof value === 'string' && value.toUpperCase() === 'NULL'))
  );
}

/**
 * Column-kind rules of `FiltersOptions::validateValueAgainstColumnKind()`: skipped without a kind, for fulltext
 * operators and for null comparisons; a JSON column takes no comparison; a plain Translatable only `eq` / `ne` with a
 * `*` wildcard; a wildcard value on another kind is not type-checked; every other value must fit the kind.
 */
function columnKindIssues(definition: DddFilterDefinition, condition: FilterCondition): QueryIssue[] {
  const { property, operator, value } = condition;
  let kind = definition.columnKind ?? null;
  if (kind === null || isFulltextOperator(operator) || isNullComparison(operator, value)) {
    return [];
  }
  const usesWildcard = typeof value === 'string' && value.includes('*');
  if (kind === 'json') {
    return [{ code: 'column-kind', message: `'${property}' is a JSON column: no comparison matches it.` }];
  }
  if (kind === 'translatable') {
    if (usesWildcard && (operator === 'eq' || operator === 'ne')) {
      return [];
    }
    return [
      {
        code: 'column-kind',
        message: `'${property}' holds the translations of all languages: use eq / ne with a '*' wildcard.`,
      },
    ];
  }
  if (usesWildcard) {
    return [];
  }
  if (kind === 'translatable-searchable') {
    kind = 'string';
  }
  const elements: readonly FilterScalar[] = Array.isArray(value) ? value : [value as FilterScalar];
  for (const element of elements) {
    if (!isFilterValueValidForColumnKind(scalarString(element), kind)) {
      return [
        {
          code: 'column-kind',
          message: `Filter value '${String(scalarString(element))}' for '${property}' is not a valid ${kind}.`,
        },
      ];
    }
  }
  return [];
}

function valueRuleIssues(definition: DddFilterDefinition, condition: FilterCondition): QueryIssue[] {
  const rule = definition.valueRules?.[condition.operator];
  if (!rule || isNullComparison(condition.operator, condition.value)) {
    return [];
  }
  if (rule === 'wildcard-required' && !(typeof condition.value === 'string' && condition.value.includes('*'))) {
    return [
      { code: 'value-rule', message: `'${condition.property} ${condition.operator}' needs a value with a '*' wildcard.` },
    ];
  }
  if (rule === 'null-only') {
    return [{ code: 'value-rule', message: `'${condition.property} ${condition.operator}' only compares with null.` }];
  }
  return [];
}

/** `FiltersOptions::validateAgainstDefinitions()`: with `options`, every value (each list item) must be one of them. */
function optionIssues(definition: DddFilterDefinition, condition: FilterCondition): QueryIssue[] {
  const options = definition.options;
  if (!options || options.length === 0) {
    return [];
  }
  const allowed = new Set(options.map(String));
  const elements: readonly FilterScalar[] = Array.isArray(condition.value)
    ? condition.value
    : [condition.value as FilterScalar];
  const rejected = elements.filter(element => {
    const text = scalarString(element);
    return text === null || !allowed.has(text);
  });
  if (rejected.length === 0) {
    return [];
  }
  return [
    {
      code: 'option-not-allowed',
      message: `Value(s) [${rejected.map(element => String(scalarString(element))).join(', ')}] for '${condition.property}' are not allowed. Allowed values are: [${options.join(', ')}].`,
    },
  ];
}

/**
 * Validates a filter condition against an `x-ddd-query` definition and returns every issue (empty = the backend
 * accepts it). Rules mirrored: unknown property (`validateAgainstDefinitions`), declared operators, fulltext only
 * with `supportsFulltext` (strict fulltext default), the value shape (`FilterOptionsConstraintValidator`), column
 * kinds (`validateValueAgainstColumnKind`), contract `valueRules`, `options`, and required expands.
 */
export function validateFilter(
  query: Pick<DddQueryDefinition, 'filters' | 'expand'>,
  condition: FilterCondition,
  context: FilterValidationContext = {},
): QueryIssue[] {
  const resolved = resolveFilterDefinition(query, condition.property);
  if (!resolved) {
    const allowed = (query.filters ?? []).map(filter => filter.name).join(', ');
    return [
      {
        code: 'unknown-property',
        message: `Property name used to filter '${condition.property}' is not allowed. Allowed property names are: [${allowed}].`,
      },
    ];
  }
  const { definition, expandPath } = resolved;
  const issues: QueryIssue[] = [];
  if (definition.operators && !definition.operators.includes(condition.operator)) {
    issues.push({
      code: 'operator-not-allowed',
      message: `Operator '${condition.operator}' is not available for '${condition.property}' (allowed: ${definition.operators.join(', ')}).`,
    });
  }
  if (isFulltextOperator(condition.operator) && definition.supportsFulltext !== true) {
    issues.push({
      code: 'fulltext-not-supported',
      message: `The fulltext operator '${condition.operator}' is not available for '${condition.property}': no FULLTEXT index.`,
    });
  }
  try {
    assertValueFitsOperator(condition.operator, condition.value);
  } catch (error) {
    issues.push({ code: 'invalid-value-shape', message: (error as Error).message });
    return issues;
  }
  issues.push(...columnKindIssues(definition, condition));
  issues.push(...valueRuleIssues(definition, condition));
  issues.push(...optionIssues(definition, condition));

  const tree = toExpandTree(context.expand);
  let level: ExpandTreeNode[] = tree;
  for (const segment of expandPath) {
    const node = level.find(candidate => candidate.property === segment);
    if (!node) {
      issues.push({
        code: 'expand-required',
        message: `Filter '${condition.property}' needs the expand '${expandPath.join('.')}'.`,
      });
      break;
    }
    level = node.children;
  }
  if (definition.requiresExpand && !level.some(node => node.property === definition.requiresExpand)) {
    issues.push({
      code: 'expand-required',
      message: `Filter '${condition.property}' needs the expand '${definition.requiresExpand}'.`,
    });
  }
  return issues;
}

/**
 * Validates and builds a filter clause from a definition; throws {@link QueryValidationError} with every issue. A
 * `Date` value on a `DAY` filter is written as `Y-m-d`; on other filters as a UTC DDD date-time.
 */
export function buildDefinedFilter(
  query: Pick<DddQueryDefinition, 'filters' | 'expand'>,
  property: string,
  operator: FilterOperator,
  value: FilterValue,
  context: FilterValidationContext = {},
): string {
  const definition = findFilterDefinition(query, property);
  const toDay = (scalar: FilterScalar): FilterScalar => (scalar instanceof Date ? formatDddDate(scalar) : scalar);
  const typedValue: FilterValue =
    definition?.temporalKind === 'DAY'
      ? Array.isArray(value)
        ? (value as readonly FilterScalar[]).map(toDay)
        : toDay(value as FilterScalar)
      : value;
  const issues = validateFilter(query, { property, operator, value: typedValue }, context);
  if (issues.length > 0) {
    throw new QueryValidationError(issues);
  }
  return buildFieldFilter(property, typedValue, operator);
}

function orderByAllowed(
  definition: Pick<DddQueryDefinition, 'filters' | 'orderBy' | 'expand'>,
  property: string,
): boolean {
  if (definition.orderBy?.includes(property)) {
    return true;
  }
  const score = /^(.+)Score$/.exec(property);
  if (score && definition.filters?.some(filter => filter.name === score[1] && filter.supportsFulltext === true)) {
    return true;
  }
  const dot = property.indexOf('.');
  if (dot < 0) {
    return false;
  }
  const expandDefinition = definition.expand?.find(expand => expand.name === property.slice(0, dot));
  return expandDefinition ? orderByAllowed(expandDefinition, property.slice(dot + 1)) : false;
}

/**
 * Validates sort input against `x-ddd-query.orderBy` (`OrderByOptions::validateAgainstDefinitions()`): declared
 * properties, `<filter>Score` for a fulltext filter, dotted paths through expands. Without an `orderBy` list nothing
 * is checked.
 */
export function validateOrderBy(
  query: Pick<DddQueryDefinition, 'filters' | 'orderBy' | 'expand'>,
  input: OrderByInput | null | undefined,
): QueryIssue[] {
  if (!query.orderBy) {
    return [];
  }
  return toOrderByEntries(input)
    .filter(entry => !orderByAllowed(query, entry.property))
    .map(entry => ({
      code: 'unknown-order-by' as const,
      message: `Sorting by '${entry.property}' is not allowed. Allowed: [${(query.orderBy ?? []).join(', ')}].`,
    }));
}

function expandIssues(definitions: DddExpandDefinition[] | undefined, nodes: ExpandTreeNode[], prefix: string): QueryIssue[] {
  const issues: QueryIssue[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}.${node.property}` : node.property;
    const definition = definitions?.find(candidate => candidate.name === node.property);
    if (!definition) {
      issues.push({ code: 'unknown-expand', message: `'${path}' cannot be expanded.` });
      continue;
    }
    const hasClauses =
      node.filters !== undefined ||
      node.orderBy !== undefined ||
      node.select !== undefined ||
      node.top !== undefined ||
      node.skip !== undefined ||
      node.children.length > 0;
    if (definition.computed && hasClauses) {
      issues.push({ code: 'computed-expand-clauses', message: `'${path}' is a computed field and takes no clauses.` });
      continue;
    }
    if (node.top !== undefined && definition.maxTop !== undefined && definition.maxTop !== null && node.top > definition.maxTop) {
      issues.push({ code: 'top-exceeds-max', message: `top in '${path}' may be at most ${definition.maxTop}.` });
    }
    if (node.orderBy !== undefined) {
      issues.push(...validateOrderBy(definition, node.orderBy));
    }
    issues.push(...expandIssues(definition.expand, node.children, path));
  }
  return issues;
}

/**
 * Validates expand input against `x-ddd-query.expand` (`ExpandOptions::validateAgainstDefinitionsFromReferenceClass()`):
 * declared names at every nesting level, no clauses on computed fields, `top` within an expand's `maxTop`, sort
 * properties of the expand. Without an `expand` list every expand is reported unknown.
 */
export function validateExpand(query: Pick<DddQueryDefinition, 'expand'>, input: ExpandInput | null | undefined): QueryIssue[] {
  return expandIssues(query.expand, toExpandTree(input), '');
}

/** Validates `select` fields against `x-ddd-query.select` (`true` = any field, a list = those fields). */
export function validateSelect(query: Pick<DddQueryDefinition, 'select'>, fields: readonly string[] | string | null | undefined): QueryIssue[] {
  const list = (typeof fields === 'string' ? fields.split(',') : [...(fields ?? [])]).map(field => field.trim()).filter(Boolean);
  if (list.length === 0) {
    return [];
  }
  if (!query.select) {
    return [{ code: 'select-not-supported', message: 'This operation does not accept select.' }];
  }
  if (query.select === true) {
    return [];
  }
  const allowed = query.select;
  return list
    .filter(field => !allowed.includes(field))
    .map(field => ({ code: 'unknown-select' as const, message: `'${field}' cannot be selected.` }));
}

/** Options of {@link buildDefinedQueryOptions}. */
export interface DefinedQueryOptionsOptions {
  /** Above `maxTop`: `throw` (default) or `clamp`. */
  topOverflow?: TopOverflow;
}

/**
 * {@link buildQueryOptions} checked against an `x-ddd-query` definition: validates `orderBy`, `expand` and `select`
 * and honours `maxTop`; throws {@link QueryValidationError} with every issue. `filters` are taken as given — build
 * the clauses with {@link buildDefinedFilter} to validate them.
 */
export function buildDefinedQueryOptions(
  query: DddQueryDefinition,
  input: QueryOptionsInput,
  options: DefinedQueryOptionsOptions = {},
): QueryOptionsParams {
  const issues = [
    ...validateOrderBy(query, input.orderBy),
    ...validateExpand(query, input.expand),
    ...validateSelect(query, typeof input.select === 'string' || Array.isArray(input.select) ? input.select : null),
  ];
  if (issues.length > 0) {
    throw new QueryValidationError(issues);
  }
  return buildQueryOptions(input, { maxTop: query.maxTop, topOverflow: options.topOverflow });
}
