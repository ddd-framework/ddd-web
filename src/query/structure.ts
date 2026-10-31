import type { FilterJoinOperator } from '../contract/operators';

/**
 * Returns the join operators (`and` / `or`) that occur at the top level of a filter expression — outside quoted
 * literals, bracket lists and parentheses. Tokenisation mirrors `FiltersOptionsParser`: single-quoted literals with
 * `\'` / `\\` escapes, double-quoted items inside lists, case-insensitive keywords that follow a term (whitespace
 * optional) and are followed by whitespace, a parenthesis or the end of input.
 */
export function topLevelJoinOperators(expression: string): Set<FilterJoinOperator> {
  const found = new Set<FilterJoinOperator>();
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index] as string;
    if (quote !== null) {
      if (char === '\\') {
        index++;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[') {
      depth++;
      continue;
    }
    if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) {
      continue;
    }
    // The backend tries `and` / `or` right after a term, with or without whitespace: after a closing quote,
    // bracket or parenthesis, a number literal or `null` (`a eq '1'or b eq '2'` is valid). A false positive (e.g. an
    // identifier ending in a digit) only adds parentheses; a missed keyword would change the meaning.
    const previous = index === 0 ? ' ' : (expression[index - 1] as string);
    if (!/[\s)\]'"0-9]/.test(previous) && !/null$/i.test(expression.slice(Math.max(0, index - 4), index))) {
      continue;
    }
    for (const keyword of ['and', 'or'] as const) {
      const candidate = expression.slice(index, index + keyword.length).toLowerCase();
      const next = expression[index + keyword.length];
      if (candidate === keyword && (next === undefined || /\s|\(|\)/.test(next))) {
        found.add(keyword);
      }
    }
  }
  return found;
}

/** Wraps a clause in parentheses. */
export function groupFilter(clause: string): string {
  return `(${clause})`;
}

/**
 * Joins clauses with `joinOperator`, parenthesising every clause that contains a top-level join operator other than
 * `joinOperator`. Needed because `FiltersOptionsParser::parseExpression()` has NO precedence: it reads strictly
 * left to right, so `x and a or b` means `(x and a) or b`.
 */
export function joinFilters(joinOperator: FilterJoinOperator, clauses: readonly string[]): string | undefined {
  const nonEmpty = clauses.map(clause => clause.trim()).filter(clause => clause.length > 0);
  if (nonEmpty.length === 0) {
    return undefined;
  }
  if (nonEmpty.length === 1) {
    return nonEmpty[0];
  }
  return nonEmpty
    .map(clause => {
      const operators = topLevelJoinOperators(clause);
      const mixesOtherOperator = [...operators].some(operator => operator !== joinOperator);
      return mixesOtherOperator ? groupFilter(clause) : clause;
    })
    .join(` ${joinOperator} `);
}
