#!/usr/bin/env node
/**
 * hostbus — the dsh-host-everything launcher binary.
 *
 *   hostbus                 → interactive REPL, auto-loads ./config/hosts.config.js when present
 *   hostbus --rpc           → newline-delimited JSON-RPC over stdin/stdout (for agent harnesses)
 *   hostbus --serve h:p     → JSON-RPC over TCP
 *   hostbus --config path   → use a different host config file
 *   hostbus run host args…  → one-shot dispatch, print result, exit (non-zero on failure)
 *   hostbus hosts           → list configured hosts, then exit
 *
 * Everything the binary does is also reachable from the library API
 * (`require('dsh-host-everything')`), so the CLI is a convenience, not a
 * capability the framework hides behind a process boundary.
 */
'use strict';

const path = require('path');
const fs = require('fs');

function parseArgv(argv) {
  const out = { positional: [], flags: {}, values: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out.values[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out.values[a.slice(2)] = next;
          i++;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out.positional.push(a);
    }
    i++;
  }
  return out;
}

function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(explicit);
  const dir = path.dirname(process.argv[1]);
  const repoConfig = path.resolve(dir, '..', 'config', 'hosts.config.js');
  const cwdConfig = path.resolve('config', 'hosts.config.js');
  const cwdExample = path.resolve('config', 'hosts.example.js');
  for (const candidate of [cwdConfig, repoConfig, cwdExample]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function printUsage() {
  process.stdout.write(
    [
      'hostbus — dsh-host-everything universal host bus',
      '',
      'usage:',
      '  hostbus                          interactive REPL',
      '  hostbus --rpc                    JSON-RPC over stdin/stdout',
      '  hostbus --serve host:port        JSON-RPC over TCP',
      '  hostbus --config <file>          use a host config file',
      '  hostbus run <id> [args …]        one-shot dispatch',
      '  hostbus hosts                    list registered hosts',
      '  hostbus --help                   this text',
      '',
    ].join('\n') + '\n',
  );
}

function loadDispatcher(configPath) {
  const { loadHostDefinitions, buildRegistry } = require('../dist/config/loader');
  const { HostDispatcher } = require('../dist/core/HostDispatcher');
  if (!configPath) return new HostDispatcher();
  const loaded = loadHostDefinitions(configPath);
  return new HostDispatcher({ registry: buildRegistry(loaded.definitions, loaded.basePath) });
}

async function main() {
  const args = parseArgv(process.argv.slice(2));

  if (args.flags.help || args.flags.h) {
    printUsage();
    process.exit(0);
  }

  const mode = args.positional[0];

  // one-shot mode: `hostbus run <id> [args…]` / `hostbus hosts`
  if (mode === 'run' || mode === 'hosts') {
    const dispatcher = loadDispatcher(resolveConfigPath(args.values.config));

    if (mode === 'hosts') {
      const rows = dispatcher.registry.list().map(function (h) {
        const s = h.status();
        return [s.type, s.id, s.description].join('\t');
      });
      process.stdout.write((rows.length ? rows.join('\n') : '(no hosts registered)') + '\n');
      await dispatcher.shutdown();
      process.exit(0);
    }

    const hostId = args.positional[1];
    if (!hostId) {
      process.stderr.write('usage: hostbus run <hostId> [args ...]\n');
      await dispatcher.shutdown();
      process.exit(2);
    }
    const rest = args.positional.slice(2);
    const params = rest.length ? { args: rest } : { args: [] };
    const result = await dispatcher.dispatch({ hostId: hostId, params: params });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) {
      process.stderr.write('✗ ' + (result.error && result.error.message) + '\n');
      await dispatcher.shutdown();
      process.exit(1);
    }
    await dispatcher.shutdown();
    process.exit(0);
  }

  // long-running mode: REPL / RPC / TCP server
  const { HostCLI } = require('../dist/cli/HostCLI');
  await HostCLI.start({
    configPath: resolveConfigPath(args.values.config),
    rpc: Boolean(args.flags.rpc),
    serve: args.values.serve,
  });
}

main().catch(function (e) {
  process.stderr.write('hostbus: ' + ((e && e.stack) || e) + '\n');
  process.exit(1);
});
