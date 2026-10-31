/**
 * Error helpers.  Hosts never throw at the bus boundary: everything is
 * converted into an `ok: false` {@link HostExecResult} so a misbehaving host
 * can never take the dispatcher down with it.
 */
import { HostErrorCode, HostExecResult } from './types';

export class HostError extends Error {
  /** machine-readable code from {@link HostErrorCode} */
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export function isHostError(e: unknown): e is HostError {
  return e instanceof HostError;
}

/** Normalise any thrown value into a `{code, message}` pair. */
export function describeError(e: unknown): { code: string; message: string } {
  if (e instanceof HostError) return { code: e.code, message: e.message };
  if (e instanceof Error) return { code: HostErrorCode.HOST_ERROR, message: e.message || e.name };
  if (typeof e === 'string') return { code: HostErrorCode.HOST_ERROR, message: e };
  return { code: HostErrorCode.HOST_ERROR, message: `non-error rejection: ${JSON.stringify(e) ?? String(e)}` };
}

/** Build a failed result envelope. */
export function failedResult(
  hostId: string,
  code: string,
  message: string,
  durationMs: number,
  taskId?: string,
  extra?: Partial<Pick<HostExecResult, 'stdout' | 'stderr' | 'exitCode' | 'timedOut' | 'data'>>,
): HostExecResult {
  return {
    ok: false,
    hostId,
    taskId,
    stdout: extra?.stdout ?? '',
    stderr: extra?.stderr ?? '',
    exitCode: extra?.exitCode,
    data: extra?.data,
    durationMs,
    timedOut: extra?.timedOut,
    error: { code, message },
  };
}
