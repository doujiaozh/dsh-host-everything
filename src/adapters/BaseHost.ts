/**
 * BaseHost — shared bookkeeping every adapter builds on.
 *
 * Subclasses only have to implement {@link execute}; metrics (runs, failures,
 * latency), lifecycle state and envelope assembly are handled here so the four
 * adapters stay thin.
 */
import { describeError, failedResult } from '../core/errors';
import {
  HostExecParams,
  HostExecResult,
  HostInfo,
  HostState,
  HostStatus,
  HostType,
  IHost,
} from '../core/types';

export interface BaseHostOptions {
  id: string;
  description?: string;
  timeoutMs?: number;
}

type PartialResult = Partial<
  Pick<HostExecResult, 'stdout' | 'stderr' | 'exitCode' | 'data' | 'timedOut' | 'error'>
>;

export abstract class BaseHost implements IHost {
  public readonly id: string;
  public abstract readonly type: HostType;
  public readonly description: string;
  public readonly timeoutMs?: number;

  private state: HostState = 'idle';
  private runs = 0;
  private failures = 0;
  private totalMs = 0;
  private lastRunAt?: number;
  private lastDurationMs?: number;
  private lastError?: string;

  constructor(options: BaseHostOptions) {
    if (!options || !options.id) throw new TypeError('host id is required');
    this.id = options.id;
    this.description = options.description ?? `${options.id} host`;
    this.timeoutMs = options.timeoutMs;
  }

  public abstract execute(params: HostExecParams): Promise<HostExecResult>;

  public status(): HostStatus {
    const info: HostInfo = {
      id: this.id,
      type: this.type,
      description: this.description,
    };
    if (this.timeoutMs !== undefined) info.timeoutMs = this.timeoutMs;
    const out: HostStatus = {
      ...info,
      state: this.state,
      runs: this.runs,
      failures: this.failures,
    };
    if (this.lastRunAt !== undefined) out.lastRunAt = this.lastRunAt;
    if (this.lastDurationMs !== undefined) out.lastDurationMs = this.lastDurationMs;
    if (this.runs > 0) out.avgDurationMs = Math.round(this.totalMs / this.runs);
    if (this.lastError !== undefined) out.lastError = this.lastError;
    return out;
  }

  /** mark the host busy; called by adapters at the start of execute(). */
  protected trackStart(): void {
    this.state = 'running';
  }

  /** fold metrics around a finished result and return it unchanged. */
  protected trackResult(result: HostExecResult): HostExecResult {
    this.runs++;
    this.totalMs += result.durationMs;
    this.lastRunAt = Date.now();
    this.lastDurationMs = result.durationMs;
    if (!result.ok) {
      this.failures++;
      this.lastError = result.error?.message ?? 'unknown failure';
      this.state = 'error';
    } else {
      this.state = 'idle';
    }
    return result;
  }

  protected buildResult(
    params: HostExecParams,
    ok: boolean,
    durationMs: number,
    fields: PartialResult,
  ): HostExecResult {
    return {
      ok,
      hostId: this.id,
      taskId: params.taskId,
      stdout: fields.stdout ?? '',
      stderr: fields.stderr ?? '',
      exitCode: fields.exitCode,
      data: fields.data,
      timedOut: fields.timedOut,
      error: fields.error,
      durationMs,
    };
  }

  protected errorResult(
    params: HostExecParams,
    code: string,
    message: string,
    durationMs: number,
    extra?: PartialResult,
  ): HostExecResult {
    return this.buildResult(params, false, durationMs, {
      ...extra,
      error: { code, message },
    });
  }

  /** convenience for adapter-level catches */
  protected caughtResult(
    params: HostExecParams,
    startedAt: number,
    err: unknown,
    extra?: PartialResult,
  ): HostExecResult {
    const d = describeError(err);
    return this.errorResult(params, d.code, d.message, Date.now() - startedAt, extra);
  }

  protected failedLike(hostId: string, code: string, message: string, durationMs: number, taskId?: string) {
    return failedResult(hostId, code, message, durationMs, taskId);
  }
}
