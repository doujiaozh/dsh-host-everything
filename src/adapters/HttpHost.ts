/**
 * HttpHost (the "external-service" adapter) — wraps a remote HTTP endpoint,
 * or a JSON-RPC 2.0 server, in the IHost contract.
 *
 * Transport modes (`rpc`):
 *   - 'rest'  : `POST` (or `method`) the params.data as a JSON body; the
 *               response — parsed when JSON — becomes result.data.
 *   - 'json-rpc': JSON-RPC 2.0 over HTTP. `params.data` is the RPC `params`
 *               object; `params.args[0]` (or `options.method`) is the RPC
 *               method name; the `result` field of the RPC response is
 *               returned as result.data, RPC errors become ok:false.
 *
 * Implemented on Node's core `http`/`https` modules — no axios, no
 * node-fetch, no native addons — so it runs on the oldest Node the bus
 * supports (>= 12).
 */
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { BaseHost } from './BaseHost';
import { HostErrorCode, HostExecParams, HostExecResult, HostType } from '../core/types';
import { HostError } from '../core/errors';

export type RpcMode = 'rest' | 'json-rpc';

export interface HttpHostOptions {
  id: string;
  /** base URL of the remote service; per-call paths can be appended via params.args[0]. */
  url: string;
  /** path appended to the base url (useful when params.args are dynamic elsewhere). */
  path?: string;
  /** default HTTP method (default 'POST') */
  method?: string;
  /** 'rest' or 'json-rpc' (default 'rest') */
  rpc?: RpcMode;
  /** default JSON-RPC method name, overridable per call via params.args[0]. */
  jsonRpcMethod?: string;
  headers?: Record<string, string>;
  /** basic auth credentials */
  auth?: { user: string; password: string };
  /** request timeout in ms; also the dispatcher watchdog fallback */
  timeoutMs?: number;
  description?: string;
  /** reject HTTP >= 400 as ok:false (default true; the HTTP error codes live in error.code like 'HTTP_404') */
  failOnHttpError?: boolean;
}

export class HttpHost extends BaseHost {
  public readonly type: HostType = 'external-service';

  private readonly baseUrl: string;
  private readonly fixedPath: string;
  private readonly defaultMethod: string;
  private readonly rpcMode: RpcMode;
  private readonly defaultRpcMethod?: string;
  private readonly fixedHeaders?: Record<string, string>;
  private readonly fixedAuth?: { user: string; password: string };
  private readonly failOnHttpError: boolean;

  constructor(options: HttpHostOptions) {
    super({ id: options.id, description: options.description, timeoutMs: options.timeoutMs });
    if (!options.url) throw new TypeError('HttpHost requires a url');
    this.baseUrl = options.url;
    this.fixedPath = options.path ?? '';
    this.defaultMethod = options.method ?? 'POST';
    this.rpcMode = options.rpc ?? 'rest';
    this.defaultRpcMethod = options.jsonRpcMethod;
    this.fixedHeaders = options.headers;
    this.fixedAuth = options.auth;
    this.failOnHttpError = options.failOnHttpError !== false;
    if (options.description === undefined) {
      (this as { description: string }).description = `http host (${this.rpcMode}): ${this.baseUrl}`;
    }
  }

  async execute(params: HostExecParams): Promise<HostExecResult> {
    const started = Date.now();
    this.trackStart();
    try {
      const out = await this.call(params);
      return this.trackResult(out);
    } catch (err) {
      return this.trackResult(this.caughtResult(params, started, err));
    }
  }

  private async call(params: HostExecParams): Promise<HostExecResult> {
    const started = Date.now();
    const timeoutMs = params.timeoutMs ?? this.timeoutMs;

    // resolve target url: base + fixed path (+ per-call path in args[0] when present)
    const argPath = params.args?.[0];
    let urlStr = this.baseUrl.replace(/\/+$/, '');
    const extra = argPath ?? this.fixedPath;
    if (extra) urlStr += '/' + String(extra).replace(/^\/+/, '');

    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      throw new HostError(HostErrorCode.INVALID_PARAMS, `invalid url "${urlStr}": ${(err as Error).message}`);
    }

    const isJsonRpc = this.rpcMode === 'json-rpc';
    const httpMethod = isJsonRpc ? 'POST' : params.args?.[1] ?? this.defaultMethod;
    const rpcMethod = (params.args?.[0] ?? this.defaultRpcMethod) as string | undefined;

    if (isJsonRpc && !rpcMethod) {
      throw new HostError(
        HostErrorCode.INVALID_PARAMS,
        `json-rpc host "${this.id}" needs a method (options.jsonRpcMethod or params.args[0])`,
      );
    }

    let body: string | undefined;
    if (httpMethod !== 'GET' && httpMethod !== 'HEAD') {
      const payload = isJsonRpc
        ? {
            jsonrpc: '2.0',
            id: 1,
            method: rpcMethod,
            params: params.data ?? null,
          }
        : (params.data ?? {});
      try {
        body = JSON.stringify(payload);
      } catch (err) {
        throw new HostError(HostErrorCode.INVALID_PARAMS, `cannot serialise request body: ${(err as Error).message}`);
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/*;q=0.5, */*;q=0.1',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...this.fixedHeaders,
    };
    if (this.fixedAuth) {
      const token = Buffer.from(`${this.fixedAuth.user}:${this.fixedAuth.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }

    return new Promise<HostExecResult>((resolve) => {
      const transport = parsed.protocol === 'https:' ? https : http;
      let req: http.ClientRequest;
      try {
        req = transport.request(
          {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : undefined,
            path: parsed.pathname + parsed.search,
            method: httpMethod,
            headers,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const durationMs = Date.now() - started;
              const raw = Buffer.concat(chunks).toString('utf8');
              const httpStatus = res.statusCode ?? 0;
              const parsedBody = parseIfJson(raw);
              let stdout = raw;

              const httpFailure = httpStatus >= 400 && this.failOnHttpError;
              if (isJsonRpc && parsedBody && typeof parsedBody === 'object') {
                const rpc = parsedBody as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
                if (rpc.error) {
                  resolve(
                    this.errorResult(params, HostErrorCode.HOST_ERROR, `rpc error ${rpc.error.code ?? -1}: ${rpc.error.message ?? 'unknown'}`, durationMs, {
                      stdout,
                      exitCode: httpStatus,
                      data: rpc.error.data,
                    }),
                  );
                  return;
                }
                const { valueToResult } = require('../util/values') as typeof import('../util/values');
                const built = valueToResult(this.id, params.taskId, durationMs, rpc.result);
                built.exitCode = httpStatus;
                built.stdout = stdout;
                resolve(httpFailure ? { ...built, ok: false, error: { code: `HTTP_${httpStatus}`, message: `http ${httpStatus}` } } : built);
                return;
              }

              const ok = !httpFailure;
              resolve(
                this.buildResult(params, ok, durationMs, {
                  stdout,
                  data: parsedBody,
                  exitCode: httpStatus,
                  ...(ok ? {} : { error: { code: `HTTP_${httpStatus}`, message: `http ${httpStatus} from ${parsed.hostname}` } }),
                }),
              );
            });
          },
        );
      } catch (err) {
        resolve(
          this.errorResult(params, HostErrorCode.NETWORK, `request failed: ${(err as Error).message}`, Date.now() - started),
        );
        return;
      }

      if (timeoutMs && timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new HostError(HostErrorCode.TIMEOUT, `http host "${this.id}" exceeded the ${timeoutMs}ms budget`));
        });
      }

      req.on('error', (err: NodeJS.ErrnoException) => {
        const code =
          err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT'
            ? HostErrorCode.TIMEOUT
            : err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EAI_AGAIN'
              ? HostErrorCode.NETWORK
              : HostErrorCode.NETWORK;
        resolve(
          this.errorResult(params, code, `http host "${this.id}": ${err.message}`, Date.now() - started),
        );
      });

      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

function parseIfJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) return undefined;
  if (!(text.startsWith('{') || text.startsWith('['))) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
