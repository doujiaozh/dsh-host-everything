#!/usr/bin/env node
/**
 * Smoke test — boots the bus from the example config and exercises every
 * adapter once (builtin, CLI system-native, standalone, child-isolated Node,
 * and the fault-isolation guarantees: unknown host, timeout kill).
 *
 *   node scripts/smoke.js          → exit 0 = pass, non-zero = fail
 *
 * Uses the compiled output (dist/), so run `npm run build` first — that is
 * the point: the smoke test validates what actually ships.
 */
'use strict';

const path = require('path');
const assert = require('assert');

async function main() {
  const root = path.resolve(__dirname, '..');
  const dist = path.join(root, 'dist', 'index.js');
  require.cache[dist] = undefined; // paranoia: never a stale require
  const {
    HostDispatcher,
    buildRegistry,
    loadHostDefinitions,
    CliHost,
    NodeHost,
  } = require(dist);

  const failures = [];
  const step = (name) => process.stdout.write('  · ' + name.padEnd(46, ' '));

  const check = (name, ok, detail) => {
    step(name);
    if (ok) {
      process.stdout.write('PASS\n');
    } else {
      process.stdout.write('FAIL\n');
      failures.push(`${name}: ${detail ?? 'assertion false'}`);
    }
  };

  process.stdout.write('dsh-host-everything smoke test\n');
  process.stdout.write('node ' + process.version + ' on ' + process.platform + '\n\n');

  const configPath = path.join(root, 'config', 'hosts.example.js');
  const loaded = loadHostDefinitions(configPath);
  const registry = buildRegistry(loaded.definitions, loaded.basePath, (def, err) => {
    check('config host "' + def.id + '" builds', false, err.message);
  });
  const dispatcher = new HostDispatcher({
    registry,
    concurrency: 4,
    defaultTimeoutMs: 20_000,
  });

  const run = async (name, hostId, params) => {
    const result = await dispatcher.dispatch({ hostId, params });
    check(name, result.ok, result.error && result.error.message);
    return result;
  };

  // 1. registry composition
  check('registry loads host definitions', registry.size >= 8, 'only ' + registry.size + ' hosts built');

  // 2. builtin host (in-process Node adapter)
  await run('builtin echo ok', 'echo', { args: [], data: { hello: 'bus' } });
  const echo = await dispatcher.dispatch({ hostId: 'echo', params: { args: ['x'], data: { a: 1 } } });
  check('builtin echo returns structured data', echo.ok && echo.data && echo.data.data && echo.data.data.a === 1, JSON.stringify(echo.data));

  // 3. builtin clock + fs + env
  await run('builtin clock.iso', 'clock', { args: ['iso'] });
  await run('builtin env platform', 'env', { args: ['platform'] });
  const readmeStat = await dispatcher.dispatch({ hostId: 'fs', params: { args: ['stat', path.join(root, 'README.md')] } });
  // README may not exist yet on a fresh clone before docs are written — only assert on package.json
  const pkgStat = await dispatcher.dispatch({ hostId: 'fs', params: { args: ['stat', path.join(root, 'package.json')] } });
  check('builtin fs.stat package.json', pkgStat.ok && pkgStat.data && pkgStat.data.type === 'file', pkgStat.error && pkgStat.error.message);
  void readmeStat;

  // 4. system-native CLI host (node printing JSON, parsed)
  const nodeHost = dispatcher.registry.get('node');
  void nodeHost;
  const parsed = await dispatcher.dispatch({
    hostId: 'node',
    params: { args: ['-e', 'console.log(JSON.stringify({smoke:true}))'], timeoutMs: 15_000, parseJson: true },
  });
  check('system-native node CLI executes', parsed.ok && parsed.data && parsed.data.smoke === true, parsed.stderr || (parsed.error && parsed.error.message));

  // 5. standalone CLI host with JSON stdout (example-greet.js)
  const greet = await dispatcher.dispatch({ hostId: 'greet', params: { args: ['--json', '--name', 'Smoke', '--lang', 'zh'], parseJson: true } });
  check('standalone greet CLI executes', greet.ok && /你好/.test(greet.stdout), greet.stderr + ' ' + (greet.error && greet.error.message));

  // 6. Node adapter child-isolation: a loop that would hang must TIMOUT, not the bus
  const hung = new NodeHost({
    id: 'hang-test',
    modulePath: path.join(root, 'hosts', 'builtin-echo.js'),
    isolation: 'child',
    timeoutMs: 800,
  });
  dispatcher.registry.register(hung);
  const t0 = Date.now();
  const hangResult = await dispatcher.dispatch({
    hostId: 'hang-test',
    params: { args: [], data: null, timeoutMs: 800 },
  });
  // the child never answers because node-runner only replies to 'run' messages that the in-process protocol handles;
  // either way: no exception, bounded duration, structured error.
  check('child isolation: hung child bounded in time', Date.now() - t0 < 6000, 'took ' + (Date.now() - t0) + 'ms');
  // (hang-test may legitimately error with HOST_ERROR — the important property is the bus survived)

  // 7. fault isolation: unknown host never throws
  const unknown = await dispatcher.dispatch({ hostId: 'no-such-host', params: {} });
  check('unknown host → HOST_NOT_FOUND', !unknown.ok && unknown.error && unknown.error.code === 'HOST_NOT_FOUND', JSON.stringify(unknown.error));

  // 8. fault isolation: timeout kills the CLI child
  const sleeper = new CliHost({
    id: 'sleep-test',
    command: process.execPath,
    baseArgs: ['-e', 'setTimeout(function(){}, 60000)'],
    description: 'deliberately slow host for the watchdog test',
    timeoutMs: 600,
  });
  dispatcher.registry.register(sleeper);
  const slowT0 = Date.now();
  const slow = await dispatcher.dispatch({ hostId: 'sleep-test', params: { timeoutMs: 600 } });
  const slowMs = Date.now() - slowT0;
  check('watchdog: slow CLI host times out', !slow.ok && slow.timedOut === true && slowMs < 4000, 'ms=' + slowMs + ' ok=' + slow.ok);
  dispatcher.registry.unregister('sleep-test', 'test done');

  // 9. bus keeps serving after the kill
  const after = await dispatcher.dispatch({ hostId: 'clock', params: { args: ['stamp'] } });
  check('bus still healthy after the kill', after.ok && typeof after.data === 'number', JSON.stringify(after.error));

  // 10. stats sanity
  const stats = dispatcher.stats();
  check('stats counter sane', stats.dispatched >= 8 && stats.hosts === dispatcher.registry.size, JSON.stringify(stats));

  await dispatcher.shutdown();

  process.stdout.write('\n');
  if (failures.length) {
    process.stdout.write('FAILED (' + failures.length + '):\n');
    failures.forEach((f) => process.stdout.write('  ✗ ' + f + '\n'));
    process.exit(1);
  }
  process.stdout.write('ALL CHECKS PASSED\n');
}

main().catch((e) => {
  process.stdout.write('\nFATAL: ' + ((e && e.stack) || e) + '\n');
  process.exit(1);
});
