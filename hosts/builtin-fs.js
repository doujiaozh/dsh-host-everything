/**
 * builtin: fs — dependency-free filesystem peek host.
 * Sub-commands (params.args[0]):
 *   - 'stat'  <path>    : size/mtime/birthtime/type
 *   - 'read'  <path>    : utf-8 contents into stdout (capped)
 *   - 'list'  <dir>     : entries with type/size
 *   - 'exists' <path>   : boolean in data
 * Refuses to read beyond MAX_BYTES of any single file: the bus is an agent
 * surface, not a file-dump service.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024; // 1 MiB read cap per call

function fail(message, code) {
  return { ok: false, error: { code: code || 'HOST_ERROR', message: message } };
}

function fsHost(params) {
  const args = params.args ?? [];
  const cmd = (args[0] || 'stat').toLowerCase();
  const target = args[1];

  if (!target && (cmd === 'stat' || cmd === 'read' || cmd === 'exists')) {
    return fail(`"${cmd}" needs a path argument (args[1])`, 'INVALID_PARAMS');
  }
  const p = path.resolve(target || '.');

  try {
    switch (cmd) {
      case 'exists': {
        const exists = fs.existsSync(p);
        return { ok: true, data: exists, stdout: exists ? 'true' : 'false' };
      }
      case 'stat': {
        const st = fs.statSync(p);
        return {
          ok: true,
          data: {
            path: p,
            type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
            size: st.size,
            mtime: st.mtime.toISOString(),
            birthtime: st.birthtime.toISOString(),
            mode: st.mode,
          },
          stdout: JSON.stringify({ path: p, size: st.size, type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other' }),
        };
      }
      case 'read': {
        const size = fs.statSync(p).size;
        if (size > MAX_BYTES) {
          return fail(`file is ${size} bytes, read cap is ${MAX_BYTES} bytes`, 'INVALID_PARAMS');
        }
        const text = fs.readFileSync(p, 'utf8');
        return { ok: true, data: text, stdout: text };
      }
      case 'list':
      case 'ls': {
        const dir = path.resolve(args[1] || '.');
        const entries = fs.readdirSync(dir, { withFileTypes: true }).map(function (e) {
          let size = -1;
          try {
            size = e.isFile() ? fs.statSync(path.join(dir, e.name)).size : -1;
          } catch (_) {
            /* permission-denied entries keep size -1 */
          }
          return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size: size };
        });
        return { ok: true, data: entries, stdout: entries.map(function (e) { return e.name; }).join('\n') };
      }
      default:
        return fail(`unknown sub-command "${cmd}" (expected stat|read|list|exists)`, 'INVALID_PARAMS');
    }
  } catch (e) {
    const code = e && e.code === 'ENOENT' ? 'HOST_NOT_FOUND' : 'HOST_ERROR';
    return fail(String((e && e.message) || e), code);
  }
}

module.exports = fsHost;
module.exports.default = fsHost;
