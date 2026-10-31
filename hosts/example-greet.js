#!/usr/bin/env node
/**
 * example standalone-app host: a zero-dependency Node script that does
 * something genuinely useful and speaks the host protocol on stdout.
 *
 * `greet` builds a greeting from structured args. Run it directly to see the
 * machine-readable envelope it emits — exactly what the bus parses into
 * HostExecResult.data when CliHost is told to `parseJson`.
 *
 *   node hosts/example-greet.js --json --name Agent --lang en
 */
'use strict';

function parseArgs(argv) {
  const out = { json: false, name: 'world', lang: 'en', count: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--lang') out.lang = argv[++i];
    else if (a === '--count') out.count = Math.max(1, parseInt(argv[++i], 10) || 1);
  }
  return out;
}

const MESSAGES = {
  en: 'Hello',
  zh: '你好',
  ja: 'こんにちは',
  es: 'Hola',
};

function greet(options) {
  const word = MESSAGES[options.lang] || MESSAGES.en;
  const lines = [];
  for (let i = 0; i < options.count; i++) {
    lines.push(`${word}, ${options.name}!`);
  }
  return {
    message: lines.join(' '),
    meta: { lang: options.lang, count: options.count, generatedAt: Date.now() },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = { ok: true, hostId: 'greet', stdout: '', data: greet(options) };
  payload.stdout = payload.data.message;
  if (options.json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    process.stdout.write(payload.data.message + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { greet: greet, main: main };
module.exports.default = greet;
