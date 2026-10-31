/**
 * HostDispatcher — the single scheduling bus.
 *
 * Agent requests come in as {@link DispatchRequest} (`{hostId, params}`), get a
 * unique task id, are pushed through a bounded concurrency queue, and are
 * executed against the registered host.  Every execution is wrapped in a
 * per-task timeout watchdog: on expiry the host's optional `abort()` hook is
 * invoked (CLI hosts kill their child process) and the task resolves with an
 * `ok:false / timedOut:true` result instead of hanging the bus.
 *
 * Fault isolation rules (the point of this whole layer):
 *   1. hosts are invoked by id only — no direct references leak to callers;
 *   2. unknown host → structured HOST_NOT_FOUND result, never a throw;
 *   3. a stuck host times out and is aborted, the queue keeps serving others;
 *   4. every outcome is emitted as a typed event (dispatch:success/error/timeout).
 */
import { EventEmitter } from 'events';
import { HostRegistry, RegistryEventMap } from './HostRegistry';
import { TaskQueue } from './TaskQueue';
import { describeError, failedResult, HostError } from './errors';
import {
  DispatchEventMap,
  DispatchRequest,
  HostErrorCode,
  HostExecParams,
  HostExecResult,
  IHost,
} from './types';

export interface DispatcherOptions {
  registry?: HostRegistry;
  /** parallel executions the bus allows (default 4) */
  concurrency?: number;
  /** pending-task cap (default 256) */
  maxPending?: number;
  /** default per-task timeout in ms (default 30000) */
  defaultTimeoutMs?: number;
}

export interface DispatcherStats {
  dispatched: number;
  succeeded: number;
  failed: number;
  timeouts: number;
  cancelled: number;
  active: number;
  pending: number;
  hosts: number;
  uptimeMs: number;
}

export class HostDispatcher extends EventEmitter {
  readonly registry: HostRegistry;
  readonly defaultTimeoutMs: number;

  private readonly queue: TaskQueue<HostExecResult>;
  private seq = 0;
  private readonly startedAt = Date.now();
  private dispatched = 0;
  private succeeded = 0;
  private failed = 0;
  private timeouts = 0;
  private cancelled = 0;

  constructor(options: DispatcherOptions = {}) {
    super();
    this.setMaxListeners(64);
    this.registry = options.registry ?? new HostRegistry();
    this.defaultTimeoutMs = Math.max(1, Math.floor(options.defaultTimeoutMs ?? 30_000));
    this.queue = new TaskQueue<HostExecResult>({
      concurrency: options.concurrency,
      maxPending: options.maxPending,
    });
  }

  stats(): DispatcherStats {
    return {
      dispatched: this.dispatched,
      succeeded: this.succeeded,
      failed: this.failed,
      timeouts: this.timeouts,
      cancelled: this.cancelled,
      active: this.queue.activeCount,
      pending: this.queue.pendingCount,
      hosts: this.registry.size,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  pendingIds(): string[] {
    return this.queue.pendingIds();
  }

  activeIds(): string[] {
    return this.queue.activeIds();
  }

  /**
   * Dispatch one task to its host.  Never throws: every failure (unknown host,
   * timeout, queue full, host crash) is returned as a structured result with
   * `ok:false` and an `error.code`.
   */
  async dispatch(req: DispatchRequest): Promise<HostExecResult> {
    if (!req || typeof req.hostId !== 'string' || !req.hostId) {
      throw new HostError(HostErrorCode.INVALID_PARAMS, 'dispatch(): hostId (string) is required');
    }
    const host = this.registry.get(req.hostId);
    if (!host) {
      return failedResult(
        req.hostId,
        HostErrorCode.HOST_NOT_FOUND,
        `host "${req.hostId}" is not registered — try registry.list`,
        0,
        req.taskId,
      );
    }

    const taskId = req.taskId || this.genTaskId();
    const params: HostExecParams = { ...(req.params ?? {}), taskId };
    const timeoutMs = Math.max(
      1,
      params.timeoutMs ?? req.timeoutMs ?? host.timeoutMs ?? this.defaultTimeoutMs,
    );

    this.dispatched++;
    this.emit('dispatch:start', { taskId, hostId: host.id, params });

    let result: HostExecResult;
    try {
      result = await this.queue.add(taskId, () => this.runTask(host, params, timeoutMs));
    } catch (err) {
      const d = describeError(err);
      if (d.code === HostErrorCode.ABORTED) this.cancelled++;
      result = failedResult(host.id, d.code, d.message, 0, taskId);
      this.emit('dispatch:error', { taskId, hostId: host.id, result });
      this.emit('dispatch:complete', { taskId, hostId: host.id, result });
      return result;
    }

    if (result.ok) this.succeeded++;
    else if (result.timedOut) this.timeouts++;
    else this.failed++;

    const event = result.timedOut
      ? 'dispatch:timeout'
      : result.ok
        ? 'dispatch:success'
        : 'dispatch:error';
    this.emit(event, { taskId, hostId: host.id, result });
    this.emit('dispatch:complete', { taskId, hostId: host.id, result });
    return result;
  }

  /** Cancel a task that is still waiting in the queue (running tasks cannot be unscheduled). */
  cancel(taskId: string, reason = 'cancelled by client'): boolean {
    const cancelled = this.queue.cancel(taskId, reason);
    if (cancelled) this.cancelled++;
    return cancelled;
  }

  /** Stop the bus: reject queued tasks, wait (bounded) for active ones, dispose hosts. */
  async shutdown(timeoutMs = 5000): Promise<void> {
    this.emit('shutdown' as 'dispatch:complete', { taskId: '', hostId: '', result: failedResult('', HostErrorCode.SHUTDOWN, 'bus shutting down', 0) } as { taskId: string; hostId: string; result: HostExecResult });
    const dropped = this.queue.clear('bus shutting down');
    this.cancelled += dropped;
    await this.queue.drain(timeoutMs);
    this.registry.clear('bus shutdown');
  }

  private async runTask(
    host: IHost,
    params: HostExecParams,
    timeoutMs: number,
  ): Promise<HostExecResult> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new HostError(HostErrorCode.TIMEOUT, `host "${host.id}" exceeded the ${timeoutMs}ms budget`)),
        timeoutMs,
      );
    });

    try {
      const result = await Promise.race([host.execute(params), watchdog]);
      result.hostId = host.id;
      result.taskId = params.taskId;
      return result;
    } catch (err) {
      // last line of defence: ask the host to hard-abort its backing process
      // (CLI hosts kill their child; isolated Node hosts kill their fork).
      try {
        host.abort?.(`dispatcher watchdog (${timeoutMs}ms)`);
      } catch {
        /* abort must never propagate */
      }

      const duration = Date.now() - started;
      if (err instanceof HostError && err.code === HostErrorCode.TIMEOUT) {
        return failedResult(host.id, HostErrorCode.TIMEOUT, err.message, duration, params.taskId, {
          timedOut: true,
        });
      }
      const d = describeError(err);
      return failedResult(host.id, d.code, d.message, duration, params.taskId);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private genTaskId(): string {
    const seq = (this.seq++).toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `t${Date.now().toString(36)}-${seq}${rand}`;
  }
}

// typed EventEmitter surface (declaration merging)
export interface HostDispatcher {
  on<K extends keyof DispatchEventMap>(event: K, listener: (payload: DispatchEventMap[K]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once<K extends keyof DispatchEventMap>(event: K, listener: (payload: DispatchEventMap[K]) => void): this;
  off<K extends keyof DispatchEventMap>(event: K, listener: (payload: DispatchEventMap[K]) => void): this;
  emit<K extends keyof DispatchEventMap>(event: K, payload: DispatchEventMap[K]): boolean;
}

// registry events re-exported for convenience of api consumers
export type { RegistryEventMap };
