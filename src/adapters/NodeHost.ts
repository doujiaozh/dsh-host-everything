/**
 * NodeHost (the "Node Adapter") — wraps a plain JS/TS module as a host.
 *
 * Two isolation levels are supported:
 *   - `isolation: 'in-process'`: the handler runs inside the bus process.
 *     Cheapest and fastest — perfect for in-repo logic such as a ported
 *     utility module (e.g. the old GoWin7Fixer logic, now plain TypeScript).
 *   - `isolation: 'child'`: the handler runs in a forked `node-runner` child
 *     process.  The child is killed on timeout/abort, so a crashing or
 *     infinite-looping module can never take the bus down.
 *
 * Handshake protocol with node-runner (JSON over stdio, one line per message):
 *   bus → child : {kind:'run', taskId, payload}
 *   child → bus : {kind:'start', pid}                          (optional)
 *                 {kind:'log', message}                        (relay → stderr)
 *                 {kind:'result', ok, data|error, stdout?}     (terminal)
 * Anything the child prints outside the protocol is captured into stdout.
 */
import { fork } from 'child_process';
import * as path from 'path';
import { BaseHost } from './BaseHost';
import { HostErrorCode, HostExecParams, HostExecResult, HostType } from '../core/types';
import { HostError } from '../core/errors';

export type NodeHandler =
  | ((params: HostExecParams) => unknown | Promise<unknown>)
  | ((params: HostExecParams) => never);

export type IsolationLevel = 'in-process' | 'child';

export interface NodeHostOptions {
  id: string;
  /** module exporting a `default` or named `handler(params)` export. */
  modulePath: string;
  /** export name to invoke (default: `default`, falling back to `handler`). */
  exportName?: string;
  /** handler inlined by the programmatic API (beats modulePath when given). */
  handler?: NodeHandler;
  /** default 'standalone-app' — use 'dsh-builtin' for bus-native modules. */
  type?: HostType;
  description?: string;
  timeoutMs?: number;
  isolation?: IsolationLevel;
  /** extra argv passed to the forked child. */
  args?: string[];
  /** override the runner script path (defaults to <package>/bridge/node-runner.js). */
  runnerPath?: string;
}

interface ChildEnvelope {
  kind: string;
  taskId?: string;
  pid?: number;
  message?: string;
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message: string };
  stdout?: string;
  exitCode?: number;
}

export class NodeHost extends BaseHost {
  public readonly type: HostType;

  private readonly modulePath: string;
  private readonly exportName: string;
  private readonly inlineHandler?: NodeHandler;
  private readonly isolation: IsolationLevel;
  private readonly childArgs: string[];
  private readonly runnerPath: string;
  private childPid: number | undefined;

  constructor(options: NodeHostOptions) {
    super({ id: options.id, description: options.description, timeoutMs: options.timeoutMs });
    this.modulePath = path.resolve(options.modulePath);
    this.exportName = options.exportName ?? 'default';
    this.inlineHandler = options.handler as NodeHandler | undefined;
    this.isolation = options.isolation ?? 'in-process';
    this.childArgs = options.args ?? [];
    this.type = options.type ?? 'standalone-app';
    this.runnerPath = options.runnerPath ?? path.join(__dirname, '..', 'bridge', 'node-runner.js');
    if (options.description === undefined) {
      (this as { description: string }).description = `node host (${this.isolation}): ${this.modulePath}`;
    }
  }

  async execute(params: HostExecParams): Promise<HostExecResult> {
    const started = Date.now();
    this.trackStart();
    try {
      const out = await (this.isolation === 'child'
        ? this.runChild(params)
        : this.runInProcess(params));
      return this.trackResult(out);
    } catch (err) {
      return this.trackResult(this.caughtResult(params, started, err));
    }
  }

  private async runInProcess(params: HostExecParams): Promise<HostExecResult> {
    const started = Date.now();
    const stderr: string[] = [];
    const handler = await this.loadHandler(stderr);

    let value: unknown;
    try {
      value = await handler(params);
    } catch (err) {
      const code = err instanceof HostError ? err.code : HostErrorCode.HOST_ERROR;
      return this.errorResult(
        params,
        code,
        (err as Error).message ?? String(err),
        Date.now() - started,
        { stderr: stderr.join('\n') },
      );
    }

    const { valueToResult } = await import('../util/values');
    const result = valueToResult(this.id, params.taskId, Date.now() - started, value);
    if (stderr.length) result.stderr = (result.stderr + '\n' + stderr.join('\n')).trim();
    return result;
  }

  private async loadHandler(stderrSink: string[]): Promise<NodeHandler> {
    if (this.inlineHandler) return this.inlineHandler;
    let mod: Record<string, unknown>;
    try {
      mod = require(this.modulePath) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        throw new HostError(
          HostErrorCode.SPAWN_FAILED,
          `cannot load host module "${this.modulePath}": ${(err as Error).message}`,
        );
      }
      throw err;
    }
    const target = mod[this.exportName] ?? mod.handler ?? mod.default;
    if (typeof target !== 'function') {
      throw new HostError(
        HostErrorCode.INVALID_PARAMS,
        `host module "${this.modulePath}" does not export a function at "${this.exportName}" (or "handler"/"default")`,
      );
    }
    // swallow "did you forget to return" confusion for modules with a `log` export used by hosts
    if (typeof (mod as { log?: unknown }).log === 'function') {
      try {
        (mod as { log: (m: string) => void }).log = (m: string) => stderrSink.push(String(m));
      } catch {
        /* module may be frozen; ignore */
      }
    }
    return target as NodeHandler;
  }

  private runChild(params: HostExecParams): Promise<HostExecResult> {
    const started = Date.now();
    return new Promise<HostExecResult>((resolve) => {
      let child: ReturnType<typeof fork> | undefined;
      let settled = false;
      const finish = (result: HostExecResult) => {
        if (settled) return;
        settled = true;
        this.childPid = undefined;
        resolve(result);
      };
      const timeoutMs = params.timeoutMs ?? this.timeoutMs;
      let timedOut = false;
      let stdoutAcc = '';

      try {
        child = fork(this.runnerPath, this.childArgs, {
          silent: true,
          windowsHide: true,
          env: {
            ...process.env,
            HOSTBUS_MODULE: this.modulePath,
            HOSTBUS_EXPORT: this.exportName,
          },
        });
      } catch (err) {
        finish(
          this.errorResult(
            params,
            HostErrorCode.SPAWN_FAILED,
            `failed to fork node-runner: ${(err as Error).message ?? err}`,
            Date.now() - started,
          ),
        );
        return;
      }
      this.childPid = child.pid;

      const timer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              this.killChild(child, 'SIGKILL');
            }, timeoutMs)
          : undefined;

      const lineSplit = makeLineSplitter();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutAcc += chunk.toString('utf8');
      });

      child.on('message', (msg: ChildEnvelope) => {
        if (!msg || typeof msg.kind !== 'string') return;
        if (msg.kind === 'log') {
          if (typeof msg.message === 'string') stdoutAcc += `\n${msg.message}\n`;
          return;
        }
        if (msg.kind === 'result') {
          if (timer) clearTimeout(timer);
          const durationMs = Date.now() - started;
          if (msg.ok) {
            const { valueToResult } = require('../util/values') as typeof import('../util/values');
            const built = valueToResult(this.id, params.taskId, durationMs, msg.data);
            finished(resultFromEnvelope(built, msg));
          } else {
            finished(
              this.errorResult(
                params,
                msg.error?.code ?? HostErrorCode.HOST_ERROR,
                msg.error?.message ?? 'child host failed',
                durationMs,
                { stdout: msg.stdout ?? '', stderr: '' },
              ),
            );
          }
        }
      });

      child.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        finished(
          this.errorResult(
            params,
            HostErrorCode.SPAWN_FAILED,
            `node-runner crashed: ${err.message}`,
            Date.now() - started,
            { stdout: stdoutAcc },
          ),
        );
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        const durationMs = Date.now() - started;
        const stderrText = '';
        if (timedOut) {
          finished(
            this.errorResult(
              params,
              HostErrorCode.TIMEOUT,
              `node host "${this.id}" exceeded the ${timeoutMs}ms budget (child process killed)`,
              durationMs,
              { stdout: stdoutAcc, stderr: stderrText, timedOut: true, exitCode: code ?? undefined },
            ),
          );
          return;
        }
        const crashNote =
          signal ? `(killed by ${signal})` : code === 0 ? '' : `(exited with code ${code})`;
        finished(
          this.errorResult(
            params,
            HostErrorCode.HOST_ERROR,
            `node-runner closed without a result ${crashNote}`.trim(),
            durationMs,
            { stdout: stdoutAcc, stderr: stderrText, exitCode: code ?? undefined },
          ),
        );
      });

      const finished = (result: HostExecResult) => {
        this.childPid = undefined;
        finish(result);
      };

      try {
        child.send({ kind: 'run', taskId: params.taskId, payload: params });
      } catch (err) {
        finished(
          this.errorResult(
            params,
            HostErrorCode.HOST_ERROR,
            `failed to send run message to node-runner: ${(err as Error).message}`,
            Date.now() - started,
          ),
        );
      }
      void lineSplit;
    });
  }

  abort(reason?: string): void {
    if (this.childPid !== undefined) {
      // dispatcher watchdog already asked for a kill; nothing else to track here
      void reason;
    }
  }

  private killChild(child: ReturnType<typeof fork> | undefined, signal: NodeJS.Signals): void {
    try {
      child?.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

function resultFromEnvelope(
  built: import('../core/types').HostExecResult,
  msg: ChildEnvelope,
): import('../core/types').HostExecResult {
  if (typeof msg.stdout === 'string' && msg.stdout.length && !built.stdout) {
    built.stdout = msg.stdout;
  }
  if (typeof msg.exitCode === 'number') built.exitCode = msg.exitCode;
  return built;
}

function makeLineSplitter(): (chunk: string) => string[] {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    return lines;
  };
}
