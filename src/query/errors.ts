/** Thrown by the builders for input the backend would answer with 400 (or parse differently than intended). */
export class QueryOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryOptionsError';
  }
}
