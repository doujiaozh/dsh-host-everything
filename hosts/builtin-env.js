/**
 * builtin: env — read the bus process environment, a diagnostic host.
 *   'all'              → every variable (data, sorted)
 *   'get' <NAME>       → one variable, or null when unset
 *   'which' <command>  → PATH search for an executable (fs-free, uses rvagg/which logic inline)
 * Hosts like CliHost depend on PATH resolution; this one lets the agent ask
 * "is python actually installed?" without shelling out.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const EXTENSIONS = process.platform === 'win32'
  ? ['.exe', '.cmd', '.bat', '.com', '.ps1']
  : [''];

function which(command) {
  if (!command) return null;
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.F_OK | fs.constants.X_OK);
      return path.resolve(command);
    } catch (_) {
      return null;
    }
  }
  const pathList = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathList) {
    if (!dir) continue;
    for (const ext of EXTENSIONS) {
      const candidate = path.join(dir, command + ext);
      try {
        fs.accessSync(candidate, fs.constants.F_OK | (process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK));
        return candidate;
      } catch (_) {
        /* keep scanning */
      }
    }
  }
  return null;
}

function envHost(params) {
  const args = params.args ?? [];
  const cmd = (args[0] || 'all').toLowerCase();

  switch (cmd) {
    case 'all': {
      const all = {};
      Object.keys(process.env)
        .sort()
        .forEach(function (k) {
          all[k] = process.env[k];
        });
      return { ok: true, data: all, stdout: Object.keys(all).map(function (k) { return k + '=' + all[k]; }).join('\n') };
    }
    case 'get': {
      const name = args[1];
      if (!name) return { ok: false, error: { code: 'INVALID_PARAMS', message: '"get" needs a variable name' } };
      const value = process.env[name];
      return { ok: true, data: value === undefined ? null : value, stdout: value === undefined ? '' : value };
    }
    case 'which': {
      const name = args[1];
      if (!name) return { ok: false, error: { code: 'INVALID_PARAMS', message: '"which" needs a command name' } };
      const found = which(name);
      return { ok: true, data: found, stdout: found || '(not found)' };
    }
    case 'platform': {
      const info = { platform: process.platform, arch: process.arch, node: process.version };
      return { ok: true, data: info, stdout: JSON.stringify(info) };
    }
    default:
      return { ok: false, error: { code: 'INVALID_PARAMS', message: 'unknown sub-command "' + cmd + '" (all|get|which|platform)' } };
  }
}

module.exports = envHost;
module.exports.default = envHost;
