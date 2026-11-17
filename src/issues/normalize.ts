import { ISSUES_LIMITS } from './limits';
import type { CapturedFrame } from './types';

/** The error-like value a reporter received, reduced to what a report carries. */
export interface NormalizedError {
  name: string;
  message: string;
  /** Innermost first */
  frames: CapturedFrame[];
  /** Only when the stack had lines but none could be parsed */
  rawStack: string | null;
}

/** Decides whether a frame's file is the application's own code. */
export type InAppFileTest = (file: string) => boolean;

export const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? value.slice(0, maxLength) : value;

/** Files that are never the app's: extensions, the runtime, libraries. */
const FOREIGN_FILE =
  /^(chrome-extension|moz-extension|safari-extension|safari-web-extension):|^node:|node_modules|^<anonymous>$|^native$|^\[native code\]$/;

export const isForeignFile = (file: string): boolean => FOREIGN_FILE.test(file);

/** V8 (Chrome, Edge, Node, Hermes): `    at fn (file:1:2)`, `    at file:1:2`, `    at async fn (file:1:2)` */
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
/** V8 frame without a position: `    at fn (native)`, `    at fn (<anonymous>)` */
const V8_FRAME_WITHOUT_POSITION = /^\s*at (?:(.+?) \()?([^():]+)\)?\s*$/;
/** SpiderMonkey / JavaScriptCore (Firefox, Safari): `fn@file:1:2`, `@file:1:2` */
const GECKO_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

const toFrame = (
  functionName: string | undefined,
  file: string,
  line: string | undefined,
  column: string | undefined,
  isInAppFile: InAppFileTest,
): CapturedFrame => {
  const cleanFunction = (functionName ?? '').replace(/^async /, '').replace(/^new /, '').trim();
  return {
    file: truncate(file, ISSUES_LIMITS.fileLength),
    line: line ? Number(line) : null,
    column: column ? Number(column) : null,
    function: cleanFunction ? truncate(cleanFunction, ISSUES_LIMITS.functionLength) : null,
    inApp: !isForeignFile(file) && isInAppFile(file),
  };
};

/** Parses a stack string into frames, innermost first. Lines that are not frames (the message) are skipped. */
export const parseStack = (
  stack: string,
  isInAppFile: InAppFileTest = () => true,
  maxFrames: number = ISSUES_LIMITS.framesPerEvent,
): CapturedFrame[] => {
  const frames: CapturedFrame[] = [];
  for (const line of stack.split('\n')) {
    if (frames.length >= maxFrames) break;
    const v8Match = V8_FRAME.exec(line);
    if (v8Match) {
      frames.push(toFrame(v8Match[1], v8Match[2] ?? '', v8Match[3], v8Match[4], isInAppFile));
      continue;
    }
    const v8MatchWithoutPosition = V8_FRAME_WITHOUT_POSITION.exec(line);
    if (v8MatchWithoutPosition) {
      frames.push(toFrame(v8MatchWithoutPosition[1], v8MatchWithoutPosition[2] ?? '', undefined, undefined, isInAppFile));
      continue;
    }
    const geckoMatch = GECKO_FRAME.exec(line);
    if (geckoMatch) {
      frames.push(toFrame(geckoMatch[1], geckoMatch[2] ?? '', geckoMatch[3], geckoMatch[4], isInAppFile));
    }
  }
  return frames;
};

/** `Minified React error #418; visit https://react.dev/errors/418…` → the code, so it survives grouping as a name. */
const MINIFIED_REACT_ERROR = /Minified React error #(\d+)/;

const describeNonError = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

const isErrorLike = (value: unknown): value is ErrorLike =>
  typeof value === 'object' && value !== null && typeof (value as ErrorLike).message === 'string';

/** Any thrown value (an Error, a string, a rejected object) → name, message, frames. */
export const normalizeError = (value: unknown, isInAppFile: InAppFileTest = () => true): NormalizedError => {
  if (!isErrorLike(value)) {
    const message = typeof value === 'string' ? value : describeNonError(value);
    return {
      name: typeof value === 'string' ? 'Error' : 'NonError',
      message: truncate(message, ISSUES_LIMITS.messageLength),
      frames: [],
      rawStack: null,
    };
  }

  const message = String(value.message);
  const reactErrorCode = MINIFIED_REACT_ERROR.exec(message)?.[1];
  const declaredName = typeof value.name === 'string' && value.name ? value.name : 'Error';
  const name = reactErrorCode ? `ReactError#${reactErrorCode}` : declaredName;
  const stack = typeof value.stack === 'string' ? value.stack : '';
  const frames = stack ? parseStack(stack, isInAppFile) : [];
  const hasStackLines = stack.split('\n').length > 1;

  return {
    name: truncate(name, ISSUES_LIMITS.nameLength),
    message: truncate(message, ISSUES_LIMITS.messageLength),
    frames,
    rawStack: frames.length === 0 && hasStackLines ? truncate(stack, ISSUES_LIMITS.rawStackLength) : null,
  };
};
