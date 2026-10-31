/**
 * CliHost (the "CLI Adapter") — wraps any command-line program in the IHost
 * contract: git, python, a local .exe, a batch file, or even `cmd.exe` itself.
 *
 * Contract mapping (what "standardised stdin/stdout" means here):
 *   - params.args   → argv appended after `baseArgs`
 *   - params.input  → written to the child's stdin (use JSON.stringify(data)
 *                     when the CLI consumes a JSON document on stdin)
 *   - stdout/stderr → captured as utf-8 strings, capped at `maxBufferBytes`
 *                     per stream (excess truncated & flagged, never unbounded)
 *   - exit code     → non-zero is `ok:false` with error.code 'EXIT_CODE'
 *                     (output is still attached so the agent can read it)
 *   - timeout       → local watchdog kills the child; the dispatcher's own
 *                     watchdog is the outer safety net
 *
 * Nothing here requires native modules: child_process.spawn is a Node core
 * API, which is exactly why this layer runs anywhere Node does — Win7
 * included.
 */
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { BaseHost } from './BaseHost';
import { HostErrorCode } from '../core/types';
import { HostExecParams, HostExecResult, HostType } from '../core/types';

export type CliArgStyle = 'args' | 'json-stdin' | 'json-arg';

export interface CliHostOptions {
  id: string;
  /** executable or command to run (resolved through PATH unless absolute). */
  command: string;
  /** fixed prefix arguments prepended on every run (e.g. ['/c'] for cmd.exe). */
  baseArgs?: string[];
  /** host class; defaults to system-native for .exe/.cmd/.bat on Windows, standalone-app otherwise. */
  type?: HostType;
  description?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /**
   * run through the platform shell (cmd.exe /c on Windows, /bin/sh -c elsewhere).
   * Required for shell builtins (`dir`, `echo`, `ver`, redirection, `&&`).
   */
  shell?: boolean;
  /** JSON.parse the stdout into result.data when it parses (default false). */
  parseJson?: boolean;
  /** per-stream capture cap in bytes (default 8 MiB). */
  maxBufferBytes?: number;
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const TRUNCATION_NOTE = (cap: number) => `\n[hostbus] output truncated at ${cap} bytes`;

export class CliHost extends BaseHost {
  public readonly type: HostType;

  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly fixedCwd?: string;
  private readonly fixedEnv?: Record<string, string>;
  private readonly shell: boolean;
  private readonly parseJsonDefault: boolean;
  private readonly maxBufferBytes: number;

  private child: ChildProcess | null = null;

  constructor(options: CliHostOptions) {
    super({
      id: options.id,
      description: options.description,
      timeoutMs: options.timeoutMs,
    });
    this.command = options.command;
    this.baseArgs = options.baseArgs ? options.baseArgs.slice() : [];
    this.fixedCwd = options.cwd;
    this.fixedEnv = options.env;
    this.shell = options.shell ?? false;
    this.parseJsonDefault = options.parseJson ?? false;
    this.maxBufferBytes = Math.max(1024, options.maxBufferBytes ?? DEFAULT_MAX_BUFFER);
    this.type =
      options.type ??
      (process.platform === 'win32' && /\.(exe|com|cmd|bat)$/i.test(options.command)
        ? 'system-native'
        : 'standalone-app');
    if (options.description === undefined) {
      (this as { description: string }).description = `cli host: ${this.describeCommand()}`;
    }
  }

  /**
   * Decide what process to actually start.
   *
   * Windows cannot `spawn()` a `.js` file directly (EFTYPE / no shebang
   * support), so a JS entry point is transparently re-run under the current
   * Node — this is what makes `command: './my-tool.js'` work on Win7 out of
   * the box.  Explicit `shell: true` hosts are left alone: the shell is then
   * responsible for association.
   */
  private resolveSpawnTarget(params: HostExecParams): { command: string; args: string[] } {
    const args = this.buildArgs(params);
    const isJsEntry = !this.shell && /\.(?:[cm]js|js)$/i.test(path.extname(this.command));
    if (isJsEntry) {
      return { command: process.execPath, args: [this.command, ...args] };
    }
    return { command: this.command, args };
  }

  async execute(params: HostExecParams): Promise<HostExecResult> {
    const started = Date.now();
    this.trackStart();

    const { command, args } = this.resolveSpawnTarget(params);
    const cwd = params.cwd ?? this.fixedCwd;
    const env = { ...process.env, ...this.fixedEnv, ...params.env };
    const timeoutMs = params.timeoutMs ?? this.timeoutMs;

    let resolved = false;
    return new Promise<HostExecResult>((resolve) => {
      const finish = (result: HostExecResult) => {
        if (resolved) return;
        resolved = true;
        this.child = null;
        resolve(this.trackResult(result));
      };

      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd,
          env,
          shell: this.shell,
          windowsHide: true,
        });
      } catch (err) {
        finish(
          this.errorResult(
            params,
            HostErrorCode.SPAWN_FAILED,
            `failed to spawn "${this.command}": ${(err as Error).message ?? err}`,
            Date.now() - started,
          ),
        );
        return;
      }
      this.child = child;
      let timedOut = false;

      const timer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              this.killChild();
            }, timeoutMs)
          : undefined;

      const stdoutBuf: Buffer[] = [];
      const stderrBuf: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const push = (target: Buffer[], chunk: Buffer, cap: number): { bytes: number; truncated: boolean } => {
        const bytes = target === stdoutBuf ? stdoutBytes : stderrBytes;
        if (bytes >= cap) return { bytes, truncated: true };
        let truncated = false;
        const remaining = cap - bytes;
        if (chunk.length > remaining) {
          target.push(chunk.slice(0, remaining));
          truncated = true;
        } else {
          target.push(chunk);
        }
        return { bytes: bytes + Math.min(chunk.length, remaining), truncated };
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        const r = push(stdoutBuf, chunk, this.maxBufferBytes);
        stdoutBytes = r.bytes;
        if (r.truncated) stdoutTruncated = true;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const r = push(stderrBuf, chunk, this.maxBufferBytes);
        stderrBytes = r.bytes;
        if (r.truncated) stderrTruncated = true;
      });

      const stdinPayload = this.stdinPayload(params);
      if (stdinPayload != null && child.stdin) {
        try {
          child.stdin.end(stdinPayload, 'utf8');
        } catch {
          /* child closed stdin early — nothing to do */
        }
      }

      child.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        finish(
          this.errorResult(
            params,
            HostErrorCode.SPAWN_FAILED,
            `"${this.command}" failed: ${err.message} (ENOENT usually means the command is not on PATH)`,
            Date.now() - started,
          ),
        );
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - started;

        let stdout = Buffer.concat(stdoutBuf).toString('utf8');
        let stderr = Buffer.concat(stderrBuf).toString('utf8');
        if (stdoutTruncated) stdout += TRUNCATION_NOTE(this.maxBufferBytes);
        if (stderrTruncated) stderr += TRUNCATION_NOTE(this.maxBufferBytes);

        if (timedOut) {
          finish(
            this.errorResult(
              params,
              HostErrorCode.TIMEOUT,
              `"${this.describeCommand()}" exceeded the ${timeoutMs}ms budget (child process killed)`,
              durationMs,
              { stdout, stderr, exitCode: code ?? undefined, timedOut: true },
            ),
          );
          return;
        }

        const data = this.maybeParseJson(stdout, params);

        if (code === 0) {
          finish(this.buildResult(params, true, durationMs, { stdout, stderr, exitCode: 0, data }));
          return;
        }
        // code !== 0, or code === null (killed child: 'error' handler above already spoke for ENOENT)
        const detail = code === null ? `was terminated (signal ${signal ?? 'unknown'})` : `exited with code ${code}`;
        finish(
          this.errorResult(params, HostErrorCode.EXIT_CODE, `"${this.describeCommand()}" ${detail}`, durationMs, {
            stdout,
            stderr,
            exitCode: code ?? undefined,
            data,
          }),
        );
      });
    });
  }

  /** kill the backing child (best-effort): dispatcher watchdog calls this on timeout. */
  abort(reason?: string): void {
    if (this.child) {
      this.child.kill();
      void reason;
    }
  }

  dispose(): void {
    this.killChild('host disposed');
  }

  private killChild(_reason?: string): void {
    try {
      if (this.child && this.child.pid != null) this.child.kill();
    } catch {
      /* process may already be gone */
    }
  }

  private buildArgs(params: HostExecParams): string[] {
    const args = this.baseArgs.slice();
    args.push(...(params.args ?? []));
    return args;
  }

  private stdinPayload(params: HostExecParams): string | undefined {
    if (params.input !== undefined) return params.input;
    return undefined;
  }

  private maybeParseJson(stdout: string, params: HostExecParams): unknown {
    const want = params.parseJson ?? this.parseJsonDefault;
    if (!want) return undefined;
    const text = stdout.trim();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private describeCommand(): string {
    return [this.command, ...this.baseArgs].join(' ');
  }
}
