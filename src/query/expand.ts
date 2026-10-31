import { QueryOptionsError } from './errors';
import { combineFilters } from './filters';
import { buildOrderBy, type OrderByInput } from './order-by';
import { normalizeSkip, normalizeTop } from './paging';
import { buildSelect, type SelectInput } from './select';

/** Clauses of one expand, written as `property(filters=…;orderBy=…;select=…;top=…;skip=…;expand=…)`. */
export interface ExpandClauses {
  /** Filter(s) on the expanded collection; a list is AND-combined. Cuts the expanded collection, not the roots. */
  filters?: string | ReadonlyArray<string | null | undefined | false>;
  orderBy?: OrderByInput;
  select?: SelectInput;
  top?: number;
  skip?: number;
  /** Nested expands. */
  expand?: ExpandInput;
}

/**
 * One expand item: a property name, a dotted path (`author.books` = `author(expand=books)`), or an object with
 * `property` and clauses.
 */
export type ExpandItem = string | ({ property: string } & ExpandClauses);

/** A map form: `{ author: true, reviews: { top: 5 } }`. */
export type ExpandMap = { readonly [property: string]: true | ExpandClauses };

/** Expand input: one item, a list of items, or a map. */
export type ExpandInput = ExpandItem | readonly ExpandItem[] | ExpandMap;

interface ExpandNode {
  filters: string[];
  orderBy?: OrderByInput;
  select?: SelectInput;
  top?: number;
  skip?: number;
  children: Map<string, ExpandNode>;
}

const EXPAND_PROPERTY = /^\w+$/;

function newNode(): ExpandNode {
  return { filters: [], children: new Map() };
}

function isItemObject(value: unknown): value is { property: string } & ExpandClauses {
  return typeof value === 'object' && value !== null && typeof (value as { property?: unknown }).property === 'string';
}

function childNode(parent: Map<string, ExpandNode>, property: string): ExpandNode {
  if (!EXPAND_PROPERTY.test(property)) {
    throw new QueryOptionsError(`Invalid expand property '${property}': use letters, digits and '_' only`);
  }
  let node = parent.get(property);
  if (!node) {
    node = newNode();
    parent.set(property, node);
  }
  return node;
}

/** Resolves a (possibly dotted) path to its deepest node, creating intermediate nodes. */
function nodeForPath(root: Map<string, ExpandNode>, path: string): ExpandNode {
  const segments = path.trim().split('.');
  let level = root;
  let node: ExpandNode | undefined;
  for (const segment of segments) {
    node = childNode(level, segment);
    level = node.children;
  }
  return node as ExpandNode;
}

function applyClauses(node: ExpandNode, clauses: ExpandClauses): void {
  if (clauses.filters !== undefined) {
    const list = typeof clauses.filters === 'string' ? [clauses.filters] : clauses.filters;
    for (const filter of list) {
      if (typeof filter === 'string' && filter.trim()) {
        node.filters.push(filter);
      }
    }
  }
  if (clauses.orderBy !== undefined) node.orderBy = clauses.orderBy;
  if (clauses.select !== undefined) node.select = clauses.select;
  if (clauses.top !== undefined) node.top = clauses.top;
  if (clauses.skip !== undefined) node.skip = clauses.skip;
  if (clauses.expand !== undefined) addInput(node.children, clauses.expand);
}

function addInput(level: Map<string, ExpandNode>, input: ExpandInput): void {
  if (typeof input === 'string') {
    for (const part of input.split(',')) {
      if (part.trim()) {
        nodeForPath(level, part);
      }
    }
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input as readonly ExpandItem[]) {
      addInput(level, item);
    }
    return;
  }
  if (isItemObject(input)) {
    applyClauses(nodeForPath(level, input.property), input);
    return;
  }
  for (const [path, clauses] of Object.entries(input as ExpandMap)) {
    const node = nodeForPath(level, path);
    if (clauses !== true) {
      applyClauses(node, clauses);
    }
  }
}

/**
 * Throws for a clause value the backend's expand regexes cannot carry: `ExpandOption::parseExpandParameters()` cuts
 * every clause at the first `;` (quotes are not honoured), finds `expand=` anywhere in the clause text, and
 * `ExpandOptions::fromString()` needs balanced parentheses (also inside quoted literals).
 */
function assertClauseValue(name: string, value: string): void {
  if (value.includes(';')) {
    throw new QueryOptionsError(`Expand ${name} must not contain ';' (got "${value}")`);
  }
  if (/expand\s*=/i.test(value)) {
    throw new QueryOptionsError(`Expand ${name} must not contain 'expand=' (got "${value}")`);
  }
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) {
    throw new QueryOptionsError(`Expand ${name} must have balanced parentheses (got "${value}")`);
  }
}

function serializeLevel(level: Map<string, ExpandNode>): string {
  return [...level.entries()].map(([property, node]) => serializeNode(property, node)).join(',');
}

function serializeNode(property: string, node: ExpandNode): string {
  const clauses: string[] = [];
  const filters = combineFilters(...node.filters);
  if (filters) {
    assertClauseValue('filters', filters);
    clauses.push(`filters=${filters}`);
  }
  const orderBy = buildOrderBy(node.orderBy);
  if (orderBy) clauses.push(`orderBy=${orderBy}`);
  const select = buildSelect(node.select);
  if (select) clauses.push(`select=${select}`);
  const top = normalizeTop(node.top);
  if (top !== undefined) clauses.push(`top=${top}`);
  const skip = normalizeSkip(node.skip);
  if (skip !== undefined) clauses.push(`skip=${skip}`);
  if (node.children.size > 0) clauses.push(`expand=${serializeLevel(node.children)}`);
  return clauses.length > 0 ? `${property}(${clauses.join(';')})` : property;
}

/**
 * Builds the `expand` value, e.g. `author(select=id,name),reviews(filters=rating ge '4';orderBy=created desc;top=5)`;
 * `undefined` for no items. Grammar of `ExpandOptions::fromString()` / `ExpandOption::parseExpandParameters()`:
 * comma-separated property names (`\w+`), each with optional `;`-separated clauses in parentheses — `filters`,
 * `orderBy`, `select`, `top`, `skip` and a recursive `expand`. Dotted paths (`author.books`) become nested expands;
 * repeated properties are merged (filters AND-combined, later clause values win).
 */
export function buildExpand(input: ExpandInput | null | undefined): string | undefined {
  if (input === null || input === undefined) {
    return undefined;
  }
  const root = new Map<string, ExpandNode>();
  addInput(root, input);
  return root.size > 0 ? serializeLevel(root) : undefined;
}

/** A normalised expand: one property with its merged clauses and nested expands. */
export interface ExpandTreeNode {
  property: string;
  filters?: string;
  orderBy?: OrderByInput;
  select?: SelectInput;
  top?: number;
  skip?: number;
  children: ExpandTreeNode[];
}

function toTreeNodes(level: Map<string, ExpandNode>): ExpandTreeNode[] {
  return [...level.entries()].map(([property, node]) => {
    const treeNode: ExpandTreeNode = { property, children: toTreeNodes(node.children) };
    const filters = combineFilters(...node.filters);
    if (filters) treeNode.filters = filters;
    if (node.orderBy !== undefined) treeNode.orderBy = node.orderBy;
    if (node.select !== undefined) treeNode.select = node.select;
    if (node.top !== undefined) treeNode.top = node.top;
    if (node.skip !== undefined) treeNode.skip = node.skip;
    return treeNode;
  });
}

/** Normalises expand input into a tree (dotted paths nested, repeated properties merged). */
export function toExpandTree(input: ExpandInput | null | undefined): ExpandTreeNode[] {
  if (input === null || input === undefined) {
    return [];
  }
  const root = new Map<string, ExpandNode>();
  addInput(root, input);
  return toTreeNodes(root);
}

/** Top-level property names of an expand input (e.g. to check a filter's `requiresExpand`). */
export function expandedProperties(input: ExpandInput | null | undefined): string[] {
  return toExpandTree(input).map(node => node.property);
}
