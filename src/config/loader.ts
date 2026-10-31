/**
 * Config loader — turn a declarative `hosts.config.js` into a wired bus.
 *
 * The config file exports either an array of host definitions or
 * `{ hosts: [...] }`, where each definition has `id`, `type` and the fields
 * of the matching adapter.  This keeps the "what runs where" knowledge in one
 * declarative file while the adapters stay dumb.
 */
import * as fs from 'fs';
import * as path from 'path';
import { HostRegistry } from '../core/HostRegistry';
import { HOST_TYPES, HostType, IHost } from '../core/types';
import { CliHost } from '../adapters/CliHost';
import { HttpHost } from '../adapters/HttpHost';
import { NodeHost } from '../adapters/NodeHost';

export interface HostDefinition {
  id: string;
  type: HostType | 'cli';
  description?: string;
  timeoutMs?: number;
  /** adapter payload: one of these matches `type` */
  command?: string;
  baseArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  parseJson?: boolean;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  auth?: { user: string; password: string };
  rpc?: 'rest' | 'json-rpc';
  jsonRpcMethod?: string;
  modulePath?: string;
  exportName?: string;
  handler?: unknown;
  isolation?: 'in-process' | 'child';
  /** after the host object exists, store extra bits here */
  [key: string]: unknown;
}

export interface BusConfig {
  hosts?: HostDefinition[];
  /** dispatcher settings */
  concurrency?: number;
  maxPending?: number;
  defaultTimeoutMs?: number;
}

function resolveBasePath(fromConfig: string | undefined): string {
  return fromConfig ? path.resolve(fromConfig) : process.cwd();
}

/**
 * Load a config module (CommonJS) and build hosts from it.
 * Resolves relative module/command paths against the config file's directory,
 * because the bus may be started from anywhere (bin/, REPL, DSH plugin).
 */
export function loadHostDefinitions(configPath: string): { definitions: HostDefinition[]; basePath: string; config?: BusConfig } {
  const abs = path.resolve(configPath);
  let raw: BusConfig | HostDefinition[];
  try {
    delete require.cache[require.resolve(abs)];
  } catch {
    /* not yet required */
  }
  try {
    raw = require(abs);
  } catch (err) {
    throw new Error(`cannot load host config "${abs}": ${(err as Error).message}`);
  }
  const exported: BusConfig | HostDefinition[] = (raw as { default?: BusConfig | HostDefinition[] }).default ?? raw;
  const definitions = Array.isArray(exported) ? exported : exported.hosts ?? [];
  if (!Array.isArray(definitions)) {
    throw new Error(`host config "${abs}" must export an array of host defs or { hosts: [...] }`);
  }
  return { definitions, basePath: path.dirname(abs), config: Array.isArray(exported) ? undefined : exported };
}

/** Build one IHost from a definition. */
export function buildHost(def: HostDefinition, basePath: string): IHost {
  if (!def || !def.id) throw new Error('host definition needs an id');

  switch (def.type) {
    case 'system-native':
    case 'standalone-app':
    case 'cli': {
      const command = def.command ?? def.modulePath;
      if (!command) {
        throw new Error(`host "${def.id}" (${def.type}) needs "command"`);
      }
      return new CliHost({
        id: def.id,
        type: def.type === 'cli' ? undefined : def.type,
        command: resolveCommand(command, basePath),
        baseArgs: def.baseArgs,
        cwd: def.cwd,
        env: def.env,
        shell: def.shell,
        parseJson: def.parseJson,
        timeoutMs: def.timeoutMs,
        description: def.description,
      }) as IHost;
    }
    case 'dsh-builtin': {
      const modulePath = def.modulePath;
      if (!modulePath) {
        throw new Error(`host "${def.id}" (dsh-builtin) needs "modulePath" (a JS module exporting a handler)`);
      }
      return new NodeHost({
        id: def.id,
        type: 'dsh-builtin',
        modulePath: path.resolve(basePath, modulePath),
        exportName: def.exportName,
        handler: def.handler as never,
        isolation: def.isolation ?? 'in-process',
        timeoutMs: def.timeoutMs,
        description: def.description,
      });
    }
    case 'external-service': {
      if (!def.url) {
        throw new Error(`host "${def.id}" (external-service) needs "url"`);
      }
      return new HttpHost({
        id: def.id,
        url: def.url,
        path: def.path as string | undefined,
        method: def.method,
        headers: def.headers,
        auth: def.auth,
        rpc: def.rpc,
        jsonRpcMethod: def.jsonRpcMethod,
        timeoutMs: def.timeoutMs,
        description: def.description,
      });
    }
    default:
      throw new Error(`host "${def.id}" has unknown type "${def.type}" (expected ${HOST_TYPES.join(' | ')})`);
  }
}

/** Resolve a command that is relative to the config dir; leave PATH/shell commands alone. */
function resolveCommand(command: string, basePath: string): string {
  if (path.isAbsolute(command)) return command;
  if (!command.includes(path.sep) && !command.includes('/')) return command; // bare command → resolved by PATH
  const against = path.resolve(basePath, command);
  return fs.existsSync(against) ? against : command;
}

/** Build a registry from definitions (skipping individual failures with a warning). */
export function buildRegistry(
  definitions: HostDefinition[],
  basePath: string,
  onError?: (def: HostDefinition, err: Error) => void,
): HostRegistry {
  const registry = new HostRegistry();
  for (const def of definitions) {
    try {
      registry.register(buildHost(def, basePath));
    } catch (err) {
      if (onError) onError(def, err as Error);
    }
  }
  return registry;
}

export { resolveBasePath };
