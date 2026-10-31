/**
 * HostCLI (the "host launcher") — one process, three faces:
 *
 *   1. REPL   — the interactive console: `run <host> [args...]`, `hosts`,
 *      `status [host]`, `stats`, `exec <json>`, `help`, `exit`.
 *   2. --rpc  — newline-delimited JSON over stdin/stdout, one request per
 *      line: `{"jsonrpc":"2.0","id":1,"method":"run","params":{...}}`.
 *      Designed for agent harnesses (DSH) to drive the bus as a subprocess.
 *   3. --serve host:port — a tiny TCP server speaking the same JSON-RPC
 *      line protocol, so other machines/tools can reach the bus too.
 *
 * REPL parsing note: `run host a b "c d"` is shell-tokenised, and when the
 * tokens do not make sense as args you can pass `--json {…}` (or `exec`)
 * to hand structured `params.data` to the host instead.
 */
import * as readline from 'readline';
import * as net from 'net';
import { HostDispatcher } from '../core/HostDispatcher';
import { DispatchRequest, HostExecParams, HostExecResult } from '../core/types';
import { buildHost, buildRegistry, loadHostDefinitions } from '../config/loader';

export interface HostCliOptions {
  configPath?: string;
  /** start the JSON-RPC stdio protocol instead of the REPL */
  rpc?: boolean;
  /** listen on host:port and serve the JSON-RPC protocol over TCP */
  serve?: string;
  /** prompt string for the REPL */
  prompt?: string;
  /** REPL history file (optional) */
  historyFile?: string;
  /** print banner on REPL start */
  banner?: boolean;
}

/** Split a command line the way a POSIX-ish shell would (quotes + escapes). */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escape = false;
  let has = false;

  for (const ch of line) {
    if (escape) {
      current += ch;
      escape = false;
      has = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        has = true;
        continue;
      }
      current += ch;
      has = true;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        tokens.push(current);
        current = '';
        has = false;
      }
      continue;
    }
    current += ch;
    has = true;
  }
  if (has) tokens.push(current);
  return tokens;
}

export class HostCLI {
  private readonly dispatcher: HostDispatcher;
  private readonly options: Required<Omit<HostCliOptions, 'serve' | 'configPath'>> &
    Pick<HostCliOptions, 'serve' | 'configPath'>;
  private rl?: readline.Interface;
  private server?: net.Server;

  constructor(dispatcher: HostDispatcher, options: HostCliOptions = {}) {
    this.dispatcher = dispatcher;
    this.options = {
      rpc: options.rpc ?? false,
      serve: options.serve,
      configPath: options.configPath,
      prompt: options.prompt ?? 'hostbus> ',
      historyFile: options.historyFile ?? '',
      banner: options.banner ?? true,
    };
  }

  /** Convenience entrypoint: build the bus from a config file and start it. */
  static async start(options: HostCliOptions): Promise<HostCLI> {
    let dispatcher: HostDispatcher;
    if (options.configPath) {
      const { definitions, basePath, config } = loadHostDefinitions(options.configPath);
      const registry = buildRegistry(definitions, basePath, (def, err) => {
        process.stderr.write(`[hostbus] skipping host "${def.id}": ${err.message}\n`);
      });
      dispatcher = new HostDispatcher({
        registry,
        concurrency: config?.concurrency,
        maxPending: config?.maxPending,
        defaultTimeoutMs: config?.defaultTimeoutMs,
      });
    } else {
      dispatcher = new HostDispatcher();
    }
    const cli = new HostCLI(dispatcher, options);
    await cli.run();
    return cli;
  }

  async run(): Promise<void> {
    if (this.options.serve) {
      await this.startServer(this.options.serve);
      return; // --serve implies machine protocol; REPL is not attached
    }
    if (this.options.rpc) {
      this.startStdioRpc();
      return;
    }
    await this.startRepl();
  }

  // ───────────────────────── REPL ─────────────────────────

  private async startRepl(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.options.prompt,
      historySize: 500,
    });
    this.rl = rl;

    rl.on('SIGINT', () => rl.pause());
    process.stdin.on('keypress', () => undefined); // wake readline on some Windows terminals

    if (this.options.banner) process.stdout.write(this.bannerText());
    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        return;
      }
      try {
        const stop = await this.handleLine(input);
        if (stop) {
          await this.close();
          return;
        }
      } catch (err) {
        this.writeErr(String((err as Error).message ?? err));
      }
      rl.prompt();
    });

    rl.on('close', async () => {
      await this.close();
    });
  }

  bannerText(): string {
    const d = this.dispatcher;
    const lines = [
      '╔═ dsh-host-everything — everything is a host ═══════════════════╗',
      '║  a universal scheduling bus for commands, scripts & services   ║',
      '╚════════════════════════════════════════════════════════════════╝',
      '',
      `  hosts: ${d.registry.size}   concurrency: ${d.stats().active}+${d.stats().pending}   timeout: ${d.defaultTimeoutMs}ms`,
      '',
      '  commands:',
      '    run <hostId> [args...] [--json <data>]   dispatch a task',
      '    exec <hostId> <json params>              dispatch with full params',
      '    hosts                                    list registered hosts',
      '    status [hostId]                          host health snapshot',
      '    stats                                    bus traffic counters',
      '    cancel <taskId>                          cancel a queued task',
      '    help                                     this banner',
      '    exit / quit                              stop the bus',
      '',
    ];
    return lines.join('\n') + '\n';
  }

  /** Handle one REPL line. Returns true when the REPL should stop. */
  async handleLine(input: string): Promise<boolean> {
    const tokens = tokenize(input);
    const cmd = (tokens[0] || '').toLowerCase();

    switch (cmd) {
      case 'exit':
      case 'quit':
        return true;
      case 'help':
      case '?':
        process.stdout.write(this.bannerText());
        return false;
      case 'hosts':
      case 'ls': {
        const hosts = this.dispatcher.registry.list();
        if (!hosts.length) {
          process.stdout.write('  (no hosts registered)\n');
          return false;
        }
        const rows = hosts.map((h) => {
          const s = h.status();
          return `  ${s.type.padEnd(16)} ${s.id.padEnd(24)} ${s.state.padEnd(8)} runs=${s.runs}  ${s.description}`;
        });
        process.stdout.write(rows.join('\n') + '\n');
        return false;
      }
      case 'status': {
        const id = tokens[1];
        if (id) {
          const host = this.dispatcher.registry.get(id);
          if (!host) {
            this.writeErr(`host "${id}" is not registered`);
            return false;
          }
          process.stdout.write(JSON.stringify(host.status(), null, 2) + '\n');
          return false;
        }
        const all = this.dispatcher.registry.list().map((h) => h.status());
        process.stdout.write(JSON.stringify(all, null, 2) + '\n');
        return false;
      }
      case 'stats': {
        process.stdout.write(JSON.stringify(this.dispatcher.stats(), null, 2) + '\n');
        return false;
      }
      case 'cancel': {
        const taskId = tokens[1];
        if (!taskId) {
          this.writeErr('usage: cancel <taskId>');
          return false;
        }
        const ok = this.dispatcher.cancel(taskId);
        process.stdout.write(ok ? `cancelled ${taskId}\n` : `no queued task "${taskId}" (running tasks cannot be unscheduled)\n`);
        return false;
      }
      case 'run': {
        const req = parseRun(tokens.slice(1));
        if (!req) {
          this.writeErr('usage: run <hostId> [args...] [--json <data>] [--input <text>] [--timeout <ms>]');
          return false;
        }
        const result = await this.dispatcher.dispatch(req);
        this.writeResult(result);
        return false;
      }
      case 'exec': {
        const req = parseExec(tokens.slice(1));
        if (!req) {
          this.writeErr('usage: exec <hostId> {"args":[...],"data":{...}}');
          return false;
        }
        const result = await this.dispatcher.dispatch(req);
        this.writeResult(result);
        return false;
      }
      default:
        this.writeErr(`unknown command "${cmd}" — try "help"`);
        return false;
    }
  }

  private writeResult(result: HostExecResult): void {
    const head = `◆ ${result.ok ? 'ok' : 'FAIL'} ${result.hostId}${result.taskId ? ' ' + result.taskId : ''} (${result.durationMs}ms)`;
    process.stdout.write(head + '\n');
    if (result.stdout) process.stdout.write(indent(result.stdout, '  ') + '\n');
    if (result.stderr) process.stdout.write(indent(result.stderr, '  ⚠ ').trimEnd() + '\n');
    if (result.data !== undefined && result.data !== null) {
      const json = safeStringify(result.data);
      if (json && json !== result.stdout.trim()) {
        process.stdout.write(indent(json, '  · ') + '\n');
      }
    }
    if (!result.ok && result.error) {
      process.stdout.write(`  error: ${result.error.code} — ${result.error.message}\n`);
    }
  }

  private writeErr(message: string): void {
    process.stderr.write(`✗ ${message}\n`);
  }

  // ─────────────────────── JSON-RPC (stdio) ───────────────────────

  private startStdioRpc(): void {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      void this.handleJsonRpc(line).then((response) => {
        if (response) process.stdout.write(safeStringify(response) + '\n');
      });
    });
    rl.on('close', () => {
      void this.close();
    });
    process.on('uncaughtException', () => undefined);
  }

  private async handleJsonRpc(line: string): Promise<unknown | null> {
    let msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: not valid JSON' } };
    }
    const id = msg.id ?? null;
    const method = msg.method;
    if (!method) {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request: method missing' } };
    }

    try {
      const result = await this.invokeMethod(method, msg.params ?? {});
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return {
        jsonrpc: '2.0',
        id,
        error: { code: e.code ?? 'INTERNAL', message: e.message ?? String(err) },
      };
    }
  }

  private async invokeMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'run':
      case 'dispatch': {
        const req = params as DispatchRequest & Record<string, unknown>;
        if (!req.hostId) throw new Error('params.hostId is required');
        return this.dispatcher.dispatch({ hostId: String(req.hostId), params: req.params as HostExecParams, taskId: req.taskId as string, timeoutMs: req.timeoutMs as number });
      }
      case 'hosts':
        return this.dispatcher.registry.list().map((h) => h.status());
      case 'status':
        return this.dispatcher.registry.list().map((h) => h.status());
      case 'stats':
        return this.dispatcher.stats();
      case 'cancel': {
        const taskId = params.taskId as string;
        if (!taskId) throw new Error('params.taskId is required');
        return { cancelled: this.dispatcher.cancel(taskId) };
      }
      case 'shutdown':
        setImmediate(() => void this.close());
        return { shutting: true };
      case 'ping':
        return { pong: Date.now() };
      case 'help':
        return { methods: ['run', 'hosts', 'status', 'stats', 'cancel', 'shutdown', 'ping', 'help'] };
      default:
        throw new Error(`unknown method "${method}"`);
    }
  }

  // ───────────────────────── TCP server ─────────────────────────

  private async startServer(spec: string): Promise<void> {
    const [host, portText] = spec.split(':');
    const port = Number.parseInt(portText, 10);
    if (!port || Number.isNaN(port)) {
      process.stderr.write(`invalid --serve spec "${spec}" (expected host:port)\n`);
      process.exit(2);
    }

    await new Promise<void>((resolve) => {
      const server = net.createServer((socket) => {
        const rl = readline.createInterface({ input: socket, output: socket, terminal: false });
        socket.setEncoding('utf8');
        rl.on('line', (line) => {
          if (!line.trim()) return;
          void this.handleJsonRpc(line).then((response) => {
            if (response) socket.write(safeStringify(response) + '\n');
          });
        });
        socket.on('error', () => socket.destroy());
        rl.on('close', () => socket.destroy());
      });
      server.on('error', (err) => {
        process.stderr.write(`hostbus tcp server failed: ${err.message}\n`);
        process.exit(3);
      });
      server.listen(port, host, () => {
        process.stderr.write(`hostbus listening on tcp ${host}:${port} (JSON-RPC over line protocol)\n`);
        resolve();
      });
      this.server = server;
    });

    const shutdown = async () => {
      this.server?.close();
      await this.close();
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  }

  async close(): Promise<void> {
    this.rl?.close();
    this.server?.close();
    await this.dispatcher.shutdown(3000);
    if (this.options.historyFile && this.rl) {
      // libfb-lessENOENT-free persist: rely on readline historySize in-process only
    }
  }
}

// ─────────────────────── parsing helpers ───────────────────────

function parseRun(tokens: string[]): DispatchRequest | null {
  if (!tokens.length) return null;
  const hostId = tokens[0];
  const args: string[] = [];
  let data: unknown;
  let input: string | undefined;
  let timeoutMs: number | undefined;
  let collectingJson = false;
  let jsonStart = -1;
  const jsonParts: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (collectingJson) {
      jsonParts.push(t);
      collectingJson = false;
      continue;
    }
    if (t === '--json') {
      collectingJson = true;
      jsonStart = i;
      continue;
    }
    if (t === '--input') {
      input = tokens[++i];
      continue;
    }
    if (t === '--timeout') {
      timeoutMs = Number(tokens[++i]);
      continue;
    }
    args.push(t);
  }
  if (collectingJson || (jsonStart >= 0 && !jsonParts.length)) {
    return null; // dangling --json
  }
  if (jsonParts.length) {
    const text = jsonParts.join(' ');
    try {
      data = JSON.parse(text);
    } catch {
      return null; // malformed --json payload
    }
  }
  void data;
  const params: HostExecParams = { args, data, input, timeoutMs };
  if (data === undefined) delete params.data;
  if (input === undefined) delete params.input;
  if (timeoutMs === undefined) delete params.timeoutMs;
  return { hostId, params };
}

function parseExec(tokens: string[]): DispatchRequest | null {
  if (tokens.length < 2) return null;
  const hostId = tokens[0];
  try {
    const params = JSON.parse(tokens.slice(1).join(' ')) as HostExecParams;
    if (typeof params !== 'object' || params === null) return null;
    return { hostId, params };
  } catch {
    return null;
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export { buildHost };
