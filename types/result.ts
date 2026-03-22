/**
 * Standard Result type for agents — errors as values, no throws from agent boundaries.
 */
export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: string; context?: unknown };

export function ok<T>(data: T): Result<T> {
  return { success: true, data };
}

export function err<T = never>(error: string, context?: unknown): Result<T> {
  return { success: false, error, context };
}
