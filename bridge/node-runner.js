#!/usr/bin/env node
/**
 * node-runner — the child-process bridge used by the Node adapter's
 * `isolation: 'child'` mode.  Plain CommonJS on purpose: it is loaded by
 * `fork()` straight from disk, so it must not depend on the compiled
 * TypeScript output being present.
 *
 * Protocol (JSON over Node's IPC channel, one object per message):
 *   parent → us  : {kind:'run', taskId, payload}
 *   us     → parent: {kind:'start', pid}
 *                    {kind:'log', message}      → relayed into stdout
 *                    {kind:'result', ok, data | error, stdout?}
 *
 * Safety rules implemented here:
 *   - the guest module is `require`d lazily, inside a try/catch: a module
 *     that cannot load becomes a structured failure, not a crash;
 *   - a rejecting/slow handler still produces exactly one `result`;
 *   - a top-level uncaughtException in the guest is converted into a result
 *     and the process exits 1 (the parent treats close-without-result as an
 *     error either way, so nothing is ever lost).
 */
'use strict';

const path = require('path');

const moduleId = process.env.HOSTBUS_MODULE;
const exportName = process.env.HOSTBUS_EXPORT || 'default';

function send(message) {
  try {
    process.send(message);
  } catch (e) {
    // parent gone — nothing left to do but die quietly
    process.exit(1);
  }
}

function fail(code, message) {
  send({ kind: 'result', ok: false, error: { code: code, message: String(message) } });
  setTimeout(() => process.exit(1), 50).unref();
}

function loadHandler() {
  if (!moduleId) {
    throw Object.assign(new Error('HOSTBUS_MODULE env var is not set'), { code: 'INVALID_PARAMS' });
  }
  let mod;
  try {
    mod = require(path.resolve(moduleId)); // eslint-disable-line @typescript-eslint/no-var-requires
  } catch (e) {
    throw Object.assign(new Error('cannot load host module "' + moduleId + '": ' + (e && e.message)), {
      code: 'MODULE_NOT_FOUND',
    });
  }
  const target = mod[exportName] || mod.handler || mod.default;
  if (typeof target !== 'function') {
    throw Object.assign(
      new Error('module "' + moduleId + '" does not export a function at "' + exportName + '"'),
      { code: 'INVALID_PARAMS' },
    );
  }
  return target;
}

async function runHandler(handler, payload) {
  // promise-or-value: await both; non-function exports are already rejected above
  const value = await handler(payload);
  return value;
}

function toPlain(value) {
  try {
    JSON.stringify(value === undefined ? null : value);
    return value === undefined ? null : value;
  } catch (e) {
    return String(value);
  }
}

process.on('uncaughtException', (e) => {
  fail('HOST_ERROR', 'uncaughtException in host module: ' + ((e && e.message) || e));
});
process.on('unhandledRejection', (e) => {
  fail('HOST_ERROR', 'unhandledRejection in host module: ' + ((e && (e.message || e)) || e));
});

process.on('message', (message) => {
  if (!message || message.kind !== 'run') return;
  const taskId = message.taskId;
  const payload = message.payload || {};

  let handler;
  try {
    handler = loadHandler();
  } catch (e) {
    return fail(e.code || 'SPAWN_FAILED', e.message);
  }

  const ctx = {
    hostId: moduleId,
    log: function (m) {
      send({ kind: 'log', message: String(m) });
    },
  };
  const params = Object.assign({}, payload, { taskId: taskId, ctx: undefined });
  // expose ctx as a non-enumerable housekeeping field the handler may import lazily
  Object.defineProperty(params, 'ctx', { value: ctx, enumerable: false, writable: true });

  runHandler(handler, params)
    .then(function (value) {
      send({ kind: 'result', ok: true, data: toPlain(value), taskId: taskId });
      setTimeout(function () {
        return process.exit(0);
      }, 20).unref();
    })
    .catch(function (e) {
      const code = (e && e.code) || 'HOST_ERROR';
      fail(code, (e && e.message) || String(e));
    });
});

if (typeof process.send === 'function') {
  send({ kind: 'start', pid: process.pid });
} else {
  // launched manually: print usage instead of hanging
  process.stderr.write('node-runner is a child-process bridge for dsh-host-everything; it speaks JSON over IPC.\n');
  process.exit(2);
}
