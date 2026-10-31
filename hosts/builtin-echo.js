/**
 * builtin: echo — the "hello world" host.
 * Echoes the incoming params back as structured data; invaluable for smoke
 * testing the bus, the CLI and the RPC layer end to end.
 *
 * Exports a default handler compatible with the Node adapter (`in-process`),
 * and a `create` factory for the programmatic API.
 */
'use strict';

/** @param {import('../../src/core/types').HostExecParams} params */
function echo(params) {
  return {
    ok: true,
    data: {
      taskId: params.taskId,
      args: params.args ?? [],
      input: params.input,
      data: params.data ?? null,
      at: Date.now(),
    },
    stdout: JSON.stringify(params.data ?? (params.args ?? [])),
  };
}

function create() {
  return echo;
}

echo.create = create;
module.exports = echo;
module.exports.default = echo;
