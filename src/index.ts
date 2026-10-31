/**
 * dsh-host-everything — "Everything is a Host".
 *
 * A dependency-free TypeScript framework that abstracts native commands, DSH
 * builtins, standalone programs and remote services behind one IHost
 * contract, then schedules them over a single fault-isolating bus.
 *
 * Public API surface (framework consumers):
 *   - contracts:  IHost, HostType, HostExecParams/Result, HostStatus
 *   - core:       HostRegistry, HostDispatcher, TaskQueue
 *   - adapters:   CliHost, NodeHost, HttpHost, BaseHost
 *   - launcher:   HostCLI (REPL / JSON-RPC stdio / TCP server)
 *   - wiring:     loadHostDefinitions, buildRegistry, buildHost
 */
export {
  HOST_TYPES,
  HostContext,
  HostErrorCode,
  HostErrorCodeValue,
  HostExecParams,
  HostExecResult,
  HostInfo,
  HostState,
  HostStatus,
  HostType,
  IHost,
  DispatchRequest,
  DispatchEventMap,
  DispatchEventName,
} from './core/types';

export { HostError, describeError, failedResult, isHostError } from './core/errors';
export { HostRegistry, RegistryEventMap } from './core/HostRegistry';
export { TaskQueue, TaskQueueOptions } from './core/TaskQueue';
export {
  HostDispatcher,
  DispatcherOptions,
  DispatcherStats,
} from './core/HostDispatcher';

export { BaseHost, BaseHostOptions } from './adapters/BaseHost';
export { CliHost, CliHostOptions } from './adapters/CliHost';
export { NodeHost, NodeHostOptions, NodeHandler, IsolationLevel } from './adapters/NodeHost';
export { HttpHost, HttpHostOptions, RpcMode } from './adapters/HttpHost';

export { HostCLI, HostCliOptions, tokenize } from './cli/HostCLI';
export {
  BusConfig,
  HostDefinition,
  buildHost,
  buildRegistry,
  loadHostDefinitions,
} from './config/loader';

/** Sensible defaults for programmatic boot. */
export const DEFAULTS = {
  concurrency: 4,
  maxPending: 256,
  timeoutMs: 30_000,
  cliPort: 8421,
} as const;
