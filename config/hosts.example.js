/**
 * hosts.example.js — declarative host wiring for the bus.
 *
 * Copy me to `config/hosts.config.js` (which is git-ignored) and adapt: every
 * entry becomes one IHost on the bus.  `type` picks the adapter; the other
 * fields are that adapter's options.  Relative paths resolve against this
 * file's directory, so the config is location-independent.
 *
 * @type {import('../src/config/loader').HostDefinition[]}
 */
module.exports = [
  // ── system-native: talk to the OS's own commands ──────────────────────
  {
    id: 'cmd',
    type: 'system-native',
    command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    baseArgs: process.platform === 'win32' ? ['/c'] : ['-c'],
    shell: false,
    description: 'platform shell (Windows: cmd.exe /c, POSIX: sh -c)',
    timeoutMs: 20_000,
  },
  {
    id: 'powershell',
    type: 'system-native',
    command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    baseArgs: ['-NoProfile', '-Command'],
    description: 'PowerShell command host',
    timeoutMs: 30_000,
  },
  {
    id: 'git',
    type: 'system-native',
    command: 'git',
    description: 'git CLI host (run: git status / log …)',
    timeoutMs: 30_000,
  },
  {
    id: 'node',
    type: 'system-native',
    command: process.execPath,
    description: 'Node.js host (args are JS flags + script path)',
    timeoutMs: 60_000,
  },

  // ── dsh-builtin: logic that ships with the bus itself ─────────────────
  {
    id: 'echo',
    type: 'dsh-builtin',
    modulePath: '../hosts/builtin-echo.js',
    description: 'echo host: returns the request as structured data',
  },
  {
    id: 'clock',
    type: 'dsh-builtin',
    modulePath: '../hosts/builtin-time.js',
    description: 'clock host: now / iso / stamp / format',
  },
  {
    id: 'fs',
    type: 'dsh-builtin',
    modulePath: '../hosts/builtin-fs.js',
    description: 'read-only filesystem host: stat / read / list / exists',
  },
  {
    id: 'env',
    type: 'dsh-builtin',
    modulePath: '../hosts/builtin-env.js',
    description: 'environment + PATH lookup host: all / get / which / platform',
  },

  // ── standalone-app: independent local programs, wrapped ───────────────
  {
    id: 'greet',
    type: 'standalone-app',
    // run the script under Node explicitly so the example works identically
    // on Windows and POSIX (the CLI adapter would also do this for you)
    command: process.execPath,
    baseArgs: [require('path').join(__dirname, '..', 'hosts', 'example-greet.js'), '--json'],
    description: 'example JSON-speaking CLI host (greeting generator)',
    timeoutMs: 10_000,
  },
  {
    id: 'win7-checkup',
    type: 'standalone-app',
    modulePath: '../hosts/win7-checkup.js',
    isolation: 'in-process',
    description: 'read-only Win7-era machine health probe (Node adapter)',
  },

  // ── external-service: remote capabilities over HTTP ───────────────────
  // {
  //   id: 'httpbin',
  //   type: 'external-service',
  //   url: 'https://httpbin.org',
  //   path: 'post',
  //   method: 'POST',
  //   description: 'echo service for testing the HTTP adapter',
  //   timeoutMs: 15_000,
  // },
  // {
  //   id: 'example-rpc',
  //   type: 'external-service',
  //   url: 'http://127.0.0.1:4000/api',
  //   rpc: 'json-rpc',
  //   jsonRpcMethod: 'ping',
  //   description: 'sample JSON-RPC endpoint',
  //   timeoutMs: 15_000,
  // },
];

module.exports.default = module.exports;
