/**
 * dsh-host-everything — core type contracts.
 *
 * "Everything is a Host": every capability the agent can invoke — a native
 * command, a DSH builtin, a standalone script or a remote service — is
 * abstracted behind one single {@link IHost} interface.  Anything that can
 * `execute(params)` and `status()` is a host, and every host speaks the same
 * JSON-ish parameter/result protocol defined here.
 */

/** The four classes of hosts the bus recognises. */
export type HostType =
  | 'system-native' /** a native command shipped with the OS: cmd.exe, git.exe, python.exe … */
  | 'dsh-builtin' /** a capability built into the bus itself (echo, time, fs read …) */
  | 'standalone-app' /** an independently written local program/script wrapped by an adapter */
  | 'external-service'; /** a remote process reached over the network (HTTP/JSON-RPC …) */

export const HOST_TYPES: readonly HostType[] = [
  'system-native',
  'dsh-builtin',
  'standalone-app',
  'external-service',
];

/** Public, serialisable description of a registered host. */
export interface HostInfo {
  id: string;
  type: HostType;
  description: string;
  /** default timeout in ms applied when the call does not provide one. */
  timeoutMs?: number;
}

/** Observable lifecycle state of a host adapter. */
export type HostState = 'idle' | 'running' | 'error' | 'offline';

export interface HostStatus extends HostInfo {
  state: HostState;
  runs: number;
  failures: number;
  lastRunAt?: number;
  lastDurationMs?: number;
  avgDurationMs?: number;
  lastError?: string;
}

/**
 * Uniform request envelope handed to every host.
 * Adapters consume the fields that are meaningful to them and ignore the rest,
 * which keeps one shape usable across CLI / Node / HTTP hosts alike.
 */
export interface HostExecParams {
  /** task id assigned by the dispatcher (or by the caller); echoed in the result. */
  taskId?: string;
  /** argv-style arguments (consumed by CLI hosts). */
  args?: string[];
  /** raw stdin payload (consumed by CLI hosts). */
  input?: string;
  /** structured payload (Node hosts, HTTP bodies, `json-stdin` CLI arg style). */
  data?: unknown;
  /** working directory override (CLI hosts). */
  cwd?: string;
  /** environment overrides merged on top of the host environment (CLI hosts). */
  env?: Record<string, string>;
  /** per-call timeout in ms; beats the host default, which beats the dispatcher default. */
  timeoutMs?: number;
  /** hint to parse the host stdout as JSON into {@link HostExecResult.data}. */
  parseJson?: boolean;
}

/** Uniform response envelope produced by every host. */
export interface HostExecResult {
  ok: boolean;
  hostId: string;
  taskId?: string;
  /** process exit code when the host is process-backed. */
  exitCode?: number;
  stdout: string;
  stderr: string;
  /** structured return value when the host produced one. */
  data?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
  timedOut?: boolean;
}

/** Context handed to in-process host handlers (builtin / Node adapter). */
export interface HostContext {
  hostId: string;
  /** append a line to the result's stderr (survives isolation: relayed via IPC). */
  log(message: string): void;
}

/** The single contract every host must implement. */
export interface IHost {
  readonly id: string;
  readonly type: HostType;
  readonly description: string;
  readonly timeoutMs?: number;

  /** Execute one task. Never throws — failures are returned as `ok: false` results. */
  execute(params: HostExecParams): Promise<HostExecResult>;

  /** Cheap, synchronous health/metrics snapshot. */
  status(): HostStatus;

  /** Optional hard-abort hook; called by the dispatcher when a task times out. */
  abort?(reason?: string): void;

  /** Optional cleanup hook; called when the host is unregistered or the bus shuts down. */
  dispose?(): void | Promise<void>;
}

/** A dispatch request as accepted by {@link HostDispatcher.dispatch}. */
export interface DispatchRequest {
  hostId: string;
  params?: HostExecParams;
  /** override the auto-generated task id (must be unique per bus). */
  taskId?: string;
  /** dispatcher-level timeout override in ms. */
  timeoutMs?: number;
}

/** Stable machine-readable error codes used across adapters and the dispatcher. */
export const HostErrorCode = {
  HOST_NOT_FOUND: 'HOST_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  QUEUE_FULL: 'QUEUE_FULL',
  QUEUE_DRAINED: 'QUEUE_DRAINED',
  SPAWN_FAILED: 'SPAWN_FAILED',
  EXIT_CODE: 'EXIT_CODE',
  HOST_ERROR: 'HOST_ERROR',
  INVALID_PARAMS: 'INVALID_PARAMS',
  NETWORK: 'NETWORK',
  HTTP_STATUS: 'HTTP_STATUS',
  SHUTDOWN: 'SHUTDOWN',
} as const;

export type HostErrorCodeValue = typeof HostErrorCode[keyof typeof HostErrorCode];

/** Dispatcher events (typed via declaration merging on {@link HostDispatcher}). */
export interface DispatchEventMap {
  'dispatch:start': { taskId: string; hostId: string; params: HostExecParams };
  'dispatch:success': { taskId: string; hostId: string; result: HostExecResult };
  'dispatch:error': { taskId: string; hostId: string; result: HostExecResult };
  'dispatch:timeout': { taskId: string; hostId: string; result: HostExecResult };
  'dispatch:complete': { taskId: string; hostId: string; result: HostExecResult };
}

export type DispatchEventName = keyof DispatchEventMap;
