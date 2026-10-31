/**
 * TaskQueue — a minimal dependency-free, concurrency-limited FIFO queue.
 *
 * The dispatcher runs host executions through this queue so that one blocked
 * host can never starve the bus: at most `concurrency` tasks run at once, the
 * rest wait in a bounded `pending` list, and everything is cancellable.
 * Pure in-memory: no Redis, no external broker, no native addons.
 */
import { HostErrorCode } from './types';
import { HostError } from './errors';

export interface TaskQueueOptions {
  /** how many tasks may execute in parallel (default 4) */
  concurrency?: number;
  /** hard cap on waiting tasks; excess `add()` calls reject with QUEUE_FULL (default 256) */
  maxPending?: number;
}

interface Task {
  id: string;
  /** kicks off `run()`; resolution flows through the outer promise. */
  exec: () => Promise<void>;
  reject: (error: Error) => void;
}

export class TaskQueue<T = unknown> {
  readonly concurrency: number;
  readonly maxPending: number;

  private readonly pending: Task[] = [];
  private readonly active = new Map<string, Promise<unknown>>();

  constructor(options: TaskQueueOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
    this.maxPending = Math.max(0, Math.floor(options.maxPending ?? 256));
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.active.size;
  }

  pendingIds(): string[] {
    return this.pending.map((t) => t.id);
  }

  activeIds(): string[] {
    return Array.from(this.active.keys());
  }

  /** Enqueue a task; resolves with its value, rejects on failure or cancellation. */
  add(id: string, run: () => Promise<T>): Promise<T> {
    if (this.active.has(id)) {
      return Promise.reject(new HostError(HostErrorCode.ABORTED, `task "${id}" is already active`));
    }
    if (this.pending.some((t) => t.id === id)) {
      return Promise.reject(new HostError(HostErrorCode.ABORTED, `task "${id}" is already queued`));
    }
    if (this.pendingCount >= this.maxPending) {
      return Promise.reject(
        new HostError(HostErrorCode.QUEUE_FULL, `queue is full (${this.maxPending} pending tasks)`),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        id,
        exec: () => run().then(resolve, reject),
        reject,
      };
      this.pending.push(task);
      this.pump();
    });
  }

  /** Cancel a still-waiting task. Returns true when the task was found & cancelled. */
  cancel(id: string, reason = 'cancelled'): boolean {
    const index = this.pending.findIndex((t) => t.id === id);
    if (index < 0) return false;
    const [task] = this.pending.splice(index, 1);
    task.reject(new HostError(HostErrorCode.ABORTED, `task "${id}" ${reason}`));
    return true;
  }

  /** Reject every waiting task (running tasks keep running — see {@link drain}). */
  clear(reason = 'cleared'): number {
    const tasks = this.pending.splice(0, this.pending.length);
    for (const task of tasks) {
      task.reject(new HostError(HostErrorCode.QUEUE_DRAINED, `task "${task.id}" ${reason}`));
    }
    return tasks.length;
  }

  /** Wait until no tasks are running; gives up (and resolves) after `timeoutMs`. */
  async drain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeCount > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled(Array.from(this.active.values())),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
    }
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) break;
      const running = Promise.resolve()
        .then(() => task.exec())
        .catch(() => {
          /* the outer promise was already rejected through exec()'s chain */
        })
        .then(() => {
          this.active.delete(task.id);
          this.pump();
        });
      this.active.set(task.id, running);
    }
  }
}
