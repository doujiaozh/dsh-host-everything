/**
 * Shared helpers for building host results from arbitrary return values.
 * Used by the Node adapter and the builtin hosts so every handler can simply
 * `return` a JSON value instead of assembling an envelope by hand.
 */
import { HostErrorCode, HostExecResult } from '../core/types';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a handler already returned something shaped like a HostExecResult. */
export function looksLikeResult(value: unknown): value is { ok: boolean } & Partial<HostExecResult> {
  return isPlainObject(value) && typeof value.ok === 'boolean';
}

/**
 * Convert a handler return value into a result envelope:
 *  - `HostExecResult`-shaped objects are normalised (hostId/taskId/durationMs filled in);
 *  - anything else becomes `data`, with a pretty JSON `stdout` (or `String(value)` fallback).
 */
export function valueToResult(
  hostId: string,
  taskId: string | undefined,
  durationMs: number,
  value: unknown,
): HostExecResult {
  if (looksLikeResult(value)) {
    const merged: HostExecResult = {
      ok: value.ok,
      hostId,
      taskId,
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : undefined,
      stdout: typeof value.stdout === 'string' ? value.stdout : '',
      stderr: typeof value.stderr === 'string' ? value.stderr : '',
      data: value.data,
      error:
        isPlainObject(value.error) && typeof (value.error as { message?: unknown }).message === 'string'
          ? {
              code:
                typeof (value.error as { code?: unknown }).code === 'string'
                  ? (value.error as { code: string }).code
                  : HostErrorCode.HOST_ERROR,
              message: (value.error as { message: string }).message,
            }
          : undefined,
      durationMs,
      timedOut: value.timedOut === true ? true : undefined,
    };
    return merged;
  }

  let data: unknown = value;
  let stdout = '';
  if (value === undefined) {
    data = undefined;
    stdout = '';
  } else {
    try {
      stdout = JSON.stringify(value, null, 2);
    } catch {
      // non-serialisable (functions, BigInt, circular …) — degrade to a string
      stdout = String(value);
      data = stdout;
    }
  }
  return { ok: true, hostId, taskId, stdout, stderr: '', data, durationMs };
}
