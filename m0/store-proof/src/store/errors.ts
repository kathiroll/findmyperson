/** Every way opening the store can go wrong is one of these, thrown, never swallowed. */
export class StoreOpenError extends Error {
  constructor(
    readonly code:
      | 'NOT_SQLCIPHER'
      | 'BAD_KEY_OR_PARAMS'
      | 'PARAM_MISMATCH'
      | 'OPEN_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'StoreOpenError';
  }
}
