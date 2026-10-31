/**
 * Test-only TypeScript port of the backend filter parser (DDD Core `FiltersOptionsParser`): left-to-right, no
 * precedence, `\'` / `\\` escapes in single-quoted literals, bracket and (after in/ni/bw) paren lists decoded as
 * JSON. Used to prove the builders produce strings the backend reads back as intended.
 */
export type ParsedFilter =
  | { join: 'and' | 'or'; left: ParsedFilter; right: ParsedFilter }
  | { property: string; operator: string; value: unknown };

const OPERATORS = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'in', 'ni', 'bw', 'ft', 'fb'];
const LIST_OPERATORS = ['in', 'ni', 'bw'];

export function parseFilter(input: string): ParsedFilter {
  const text = input.trim();
  let index = 0;
  const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);
  const skipSpace = () => {
    while (isSpace(text[index])) index++;
  };
  const fail = (what: string): never => {
    throw new Error(`parse error: ${what} at ${index} in ${text}`);
  };
  const match = (token: string): boolean => {
    skipSpace();
    if (text.slice(index, index + token.length).toLowerCase() !== token) return false;
    const next = text[index + token.length];
    if (token === '(' || token === ')' || next === undefined || isSpace(next) || next === '(' || next === ')') {
      index += token.length;
      return true;
    }
    return false;
  };
  const parseArray = (open: string, close: string): unknown => {
    let json = '';
    let depth = 0;
    let quote: string | null = null;
    for (; ; index++) {
      const char = text[index];
      if (char === undefined) fail('array');
      const c = char as string;
      if (quote !== null) {
        if (c === '\\') {
          const next = text[index + 1];
          if (quote === '"' && next !== undefined) {
            json += c + next;
            index++;
          } else if (next === "'" || next === '\\') {
            json += next === '\\' ? '\\\\' : "'";
            index++;
          } else json += '\\\\';
          continue;
        }
        if (c === quote) {
          json += '"';
          quote = null;
          continue;
        }
        json += c === '"' ? '\\"' : c;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        json += '"';
        continue;
      }
      if (c === open) {
        depth++;
        json += '[';
        continue;
      }
      if (c === close) {
        depth--;
        json += ']';
        if (depth === 0) {
          index++;
          return JSON.parse(json);
        }
        continue;
      }
      json += c;
    }
  };
  const parseLiteral = (operator: string): unknown => {
    skipSpace();
    const char = text[index];
    if (char !== undefined && /\d/.test(char)) {
      let literal = '';
      while (text[index] !== undefined && /[\d.]/.test(text[index] as string)) literal += text[index++];
      return Number(literal);
    }
    if (char !== undefined && char.toLowerCase() === 'n') {
      if (text.slice(index, index + 4).toLowerCase() === 'null') {
        index += 4;
        return null;
      }
      fail('literal');
    }
    if (char === "'") {
      let literal = '';
      for (;;) {
        index++;
        const c = text[index];
        if (c === undefined) fail('unterminated string');
        if (c === '\\') {
          const next = text[index + 1];
          if (next === "'" || next === '\\') {
            literal += next;
            index++;
            continue;
          }
          literal += c;
          continue;
        }
        if (c === "'") {
          index++;
          return literal;
        }
        literal += c;
      }
    }
    if (char === '[') return parseArray('[', ']');
    if (char === '(' && LIST_OPERATORS.includes(operator)) return parseArray('(', ')');
    return fail('literal');
  };
  const parseComparison = (): ParsedFilter => {
    skipSpace();
    let property = '';
    while (text[index] !== undefined && /[A-Za-z0-9._]/.test(text[index] as string)) property += text[index++];
    if (!property) fail('identifier');
    skipSpace();
    const operator = text.slice(index, index + 2).toLowerCase();
    if (!OPERATORS.includes(operator) || !(text[index + 2] === undefined || isSpace(text[index + 2]))) fail('operator');
    index += 2;
    return { property, operator, value: parseLiteral(operator) };
  };
  const parseTerm = (): ParsedFilter => {
    if (match('(')) {
      const expression = parseExpression();
      match(')');
      return expression;
    }
    return parseComparison();
  };
  const parseExpression = (): ParsedFilter => {
    let left = parseTerm();
    for (;;) {
      let join: 'and' | 'or';
      if (match('and')) join = 'and';
      else if (match('or')) join = 'or';
      else break;
      left = { join, left, right: parseTerm() };
    }
    return left;
  };
  const result = parseExpression();
  skipSpace();
  if (index !== text.length) fail('trailing input');
  return result;
}
