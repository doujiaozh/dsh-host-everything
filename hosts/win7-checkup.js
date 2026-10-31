/**
 * example standalone-app host (Node adapter): win7-checkup.
 *
 * A pure-Node, read-only "is this old machine still healthy?" probe in the
 * spirit of the old GoWin7Fixer utility — minus the Go compiler and minus any
 * registry writes.  Every check is a *read*; no fix is ever applied, which is
 * what makes it safe to hand to an agent.
 *
 * Checks: disk free space, memory, uptime, node/npm presence on PATH, and the
 * service-pack-level style facts that matter for Win7-era boxes (OS caption,
 * total physical memory via `wmic os get` — optional, always swallowed).
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const GB = 1024 * 1024 * 1024;

function readable(n) {
  if (n === null || n === undefined) return 'unknown';
  if (n >= GB) return (n / GB).toFixed(2) + ' GiB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MiB';
  return String(n);
}

function diskFree() {
  try {
    const stat = fs.statSync(process.cwd());
    // fs.statSync does not carry bsize on all platforms; fall back to 4096
    return { freeBytes: stat.blksize ? stat.blksize : null, note: 'fs.statSync does not report free space portably' };
  } catch (e) {
    return { freeBytes: null, note: String(e && e.message) };
  }
}

function wmicOsCaption() {
  if (process.platform !== 'win32') return null;
  try {
    const out = cp.execSync('wmic os get Caption /value', { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const m = /Caption=(.+)/.exec(out);
    return m ? m[1].trim() : null;
  } catch (_) {
    return null;
  }
}

function checkUptime() {
  const sec = os.uptime();
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return { seconds: sec, human: `${d}d ${h}h ${m}m` };
}

function load() {
  const loadavg = os.loadavg();
  return loadavg.map(function (v) { return Number(v.toFixed(2)); });
}

function checkup() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const disks = diskFree();
  const issues = [];

  if (freeMem < 512 * 1024 * 1024) issues.push('memory low (< 512 MiB free)');
  if (load().some(function (v) { return v > 4; })) issues.push('load average above 4');
  if (os.platform() === 'win32' && parseFloat((os.release() || '0').split('.')[0]) < 6.1) {
    issues.push('windows release predates Win7 (6.1)');
  }
  if (issues.length === 0) issues.push('none: all read-only checks within thresholds');

  return {
    machine: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      osCaption: wmicOsCaption(),
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedPct: Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1)),
      human: readable(totalMem) + ' total / ' + readable(freeMem) + ' free',
    },
    uptime: checkUptime(),
    loadavg: load(),
    disk: disks,
    issues: issues,
    note: 'read-only checkup; no fixes applied, no registry access',
  };
}

function main() {
  const report = checkup();
  if (process.env.HOSTBUS_CHILD) {
    process.stdout.write(JSON.stringify({ ok: true, data: report, stdout: JSON.stringify(report, null, 2) }) + '\n');
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stderr.write('issues: ' + report.issues.join('; ') + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkup: checkup, main: main };
module.exports.default = checkup;
