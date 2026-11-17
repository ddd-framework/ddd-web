import type { CapturedFrame } from './types';

/**
 * The CLIENT's de-duplication key: `name | normalised message | top frame file:function`. Only for folding repeats on
 * one device (sent as `clientFingerprint`, informational); the backend builds the group and issue hashes itself
 * (mgamadeus/ddd `ClientIssuesFingerprintBuilder`) and never trusts this one.
 */

/** URLs, UUIDs, hex ids and numbers become placeholders, so `order 41 failed` and `order 42 failed` are one key. */
export const normaliseIssueMessage = (message: string): string =>
  message
    .replace(/https?:\/\/\S+/g, '{url}')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{uuid}')
    .replace(/\b[0-9a-f]{8,}\b/gi, '{hex}')
    .replace(/\d+/g, '{n}');

/** The top frame is the innermost in-app frame, else the innermost frame. */
export const buildClientFingerprint = (name: string, message: string, frames: readonly CapturedFrame[]): string => {
  const topFrame = frames.find((frame) => frame.inApp) ?? frames[0];
  const callSite = topFrame ? `${topFrame.file}:${topFrame.function ?? ''}` : '';
  return `${name}|${normaliseIssueMessage(message)}|${callSite}`;
};
