export type JevErrorCode =
  | 'no_key'
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'invalid_request'
  | 'network'
  | 'server'
  | 'schema'
  | 'timeout'
  | 'aborted'
  | 'unknown';

export interface JevErrorOptions {
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

/** Error type shared by the provider, parser, and service worker. */
export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: JevErrorCode, message: string, options: JevErrorOptions = {}) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }

  /** Transient failures worth retrying with backoff. */
  get retryable(): boolean {
    return (
      this.code === 'rate_limit' ||
      this.code === 'overloaded' ||
      this.code === 'network' ||
      this.code === 'server' ||
      this.code === 'timeout'
    );
  }

  /** Short, user-facing message for the status bar. */
  get friendly(): string {
    switch (this.code) {
      case 'no_key':
        return 'No API key set. Open the extension popup.';
      case 'auth':
        return 'API key rejected (401). Check the key in the popup.';
      case 'rate_limit':
        return 'Rate limited (429). Retrying with backoff.';
      case 'overloaded':
        return 'Jev is overloaded (529). Retrying shortly.';
      case 'invalid_request':
        return 'Jev rejected the request (422). Check categories.';
      case 'network':
        return 'Network error. Offline?';
      case 'schema':
        return 'Unexpected Jev response schema.';
      default:
        return this.message;
    }
  }
}
