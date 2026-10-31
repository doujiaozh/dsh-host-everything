/**
 * HostRegistry — the "service directory" of the bus.
 *
 * Every host (native command, builtin, standalone app, external service) is
 * registered here under a stable id.  The registry is intentionally dumb: it
 * does not execute anything, it only owns lifecycle (register / unregister /
 * dispose) and emits events so the dispatcher, CLI or DSH plugins can react.
 */
import { EventEmitter } from 'events';
import { HOST_TYPES, HostType, IHost } from './types';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface RegistryEventMap {
  /** a host became available on the bus */
  register: IHost;
  /** a host was removed; dispose() has been invoked (async result not awaited) */
  unregister: { host: IHost; reason?: string };
  /** a host dispose() rejected */
  error: { error: Error; host: IHost };
}

export class HostRegistry extends EventEmitter {
  private readonly hosts = new Map<string, IHost>();

  constructor() {
    super();
    this.setMaxListeners(64);
  }

  /** Register a host. Throws on invalid id shape, missing contract or duplicate id. */
  register(host: IHost): this {
    if (!host || typeof host.id !== 'string' || !host.id) {
      throw new TypeError('register(): host.id (string) is required');
    }
    if (!ID_PATTERN.test(host.id)) {
      throw new TypeError(
        `register(): invalid host id "${host.id}" — allowed: letters, digits, '.', '_', ':', '-'`,
      );
    }
    if (!HOST_TYPES.includes(host.type)) {
      throw new TypeError(`register(): host "${host.id}" has unknown type "${host.type}"`);
    }
    if (typeof host.execute !== 'function' || typeof host.status !== 'function') {
      throw new TypeError(`register(): host "${host.id}" must implement execute() and status()`);
    }
    if (this.hosts.has(host.id)) {
      throw new Error(`register(): host "${host.id}" is already registered`);
    }
    this.hosts.set(host.id, host);
    this.emit('register', host);
    return this;
  }

  /** Remove a host; invokes its optional dispose(). Returns the removed host, if any. */
  unregister(id: string, reason?: string): IHost | undefined {
    const host = this.hosts.get(id);
    if (!host) return undefined;
    this.hosts.delete(id);
    const dispose = host.dispose;
    if (dispose) {
      Promise.resolve(dispose.call(host)).catch((error: Error) => {
        this.emit('error', { error, host });
      });
    }
    this.emit('unregister', { host, reason });
    return host;
  }

  get(id: string): IHost | undefined {
    return this.hosts.get(id);
  }

  has(id: string): boolean {
    return this.hosts.has(id);
  }

  /** resolved host, or undefined — alias of {@link get} */
  resolve(id: string): IHost | undefined {
    return this.hosts.get(id);
  }

  ids(): string[] {
    return Array.from(this.hosts.keys());
  }

  get size(): number {
    return this.hosts.size;
  }

  /** all hosts, sorted by id */
  list(): IHost[] {
    return Array.from(this.hosts.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  listByType(type: HostType): IHost[] {
    return this.list().filter((h) => h.type === type);
  }

  /** Remove every host (dispose is invoked asynchronously). */
  clear(reason?: string): number {
    const ids = this.ids();
    for (const id of ids) this.unregister(id, reason);
    return ids.length;
  }
}

// typed EventEmitter surface (declaration merging)
export interface HostRegistry {
  on(event: 'register', listener: (host: IHost) => void): this;
  on(event: 'unregister', listener: (payload: RegistryEventMap['unregister']) => void): this;
  on(event: 'error', listener: (payload: RegistryEventMap['error']) => void): this;
  once(event: 'register', listener: (host: IHost) => void): this;
  once(event: 'unregister', listener: (payload: RegistryEventMap['unregister']) => void): this;
  off(event: 'register', listener: (host: IHost) => void): this;
  off(event: 'unregister', listener: (payload: RegistryEventMap['unregister']) => void): this;
  off(event: 'error', listener: (payload: RegistryEventMap['error']) => void): this;
  emit(event: 'register', host: IHost): boolean;
  emit(event: 'unregister', payload: RegistryEventMap['unregister']): boolean;
  emit(event: 'error', payload: RegistryEventMap['error']): boolean;
}
