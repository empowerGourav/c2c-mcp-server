/**
 * Domain errors. Each carries a stable `code` for audit logs and a safe, user-facing message.
 * Internal causes (DB driver errors etc.) are kept on `cause` for logging and never returned to clients.
 */
export type ToolErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_AUTHORIZED'
  | 'VIEW_NOT_APPROVED'
  | 'RATE_LIMITED'
  | 'BUSY'
  | 'DATA_UNAVAILABLE'
  | 'RESPONSE_TOO_LARGE';

export class ToolError extends Error {
  override readonly name = 'ToolError';

  constructor(
    readonly code: ToolErrorCode,
    readonly safeMessage: string,
    options?: { cause?: unknown },
  ) {
    super(safeMessage, options);
  }
}
