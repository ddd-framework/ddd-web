export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const PREFIX = '[ddd-web-sdk]';

export const consoleLogger: Logger = {
  info: (message) => console.log(`${PREFIX} ${message}`),
  warn: (message) => console.warn(`${PREFIX} ${message}`),
  error: (message) => console.error(`${PREFIX} ${message}`),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Thrown for expected aborts (bad spec, bad config); the CLI prints the message without a stack. */
export class SdkGenerationError extends Error {
  override name = 'SdkGenerationError';
}
