#!/usr/bin/env node
/**
 * In-process TypeScript build — runs the compiler via its public API instead
 * of the CLI.  The stock `tsc` entrypoint on this machine crashes the process
 * (a Go runtime fault in whatever it spawns), so we do everything in-process:
 * same compiler, same tsconfig, no child processes involved.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'tsconfig.json');

const raw = fs.readFileSync(configPath, 'utf8');
const parsed = ts.parseConfigFileTextToJson(configPath, raw);
if (parsed.error) {
  console.error('tsconfig parse error:', ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  process.exit(1);
}
// tsconfig is fixed for this repo (include: src/**/*.ts), so expand the root
// names ourselves with a tiny recursive walk — keeps the build script free of
// ts.matchFiles internals and dependency-free.
const basePath = path.dirname(configPath);
const cfg = parsed.config || {};
// convertCompilerOptionsFromJson turns 'target': 'ES2019' / 'module': 'commonjs'
// / 'lib': [...] into the enums createProgram expects.
const converted = ts.convertCompilerOptionsFromJson(cfg.compilerOptions || {}, basePath);
for (const diag of converted.errors) {
  console.error('tsconfig:', ts.flattenDiagnosticMessageText(diag.messageText, '\n'));
}
const options = converted.options;
const include = Array.isArray(cfg.include) ? cfg.include : ['src/**/*.ts'];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/i.test(entry.name)) out.push(full);
  }
  return out;
}
const fileNames = [];
for (const pattern of include) {
  // this repo only uses directory wildcards like 'src/**/*.ts'
  const dir = pattern.replace(/\/\*\*.*$/, '').replace(/\/\*.*$/, '');
  const root = path.resolve(basePath, dir);
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) walk(root, fileNames);
}
[...new Set(fileNames)];

const noEmit = process.argv.slice(2).includes('--no-emit');

const program = ts.createProgram({
  rootNames: fileNames,
  options: Object.assign({}, options, {
    // emit alongside checking; noEmitOnError keeps broken builds out of dist/
    noEmitOnError: true,
    noEmit,
  }),
});

const diagnostics = ts.getPreEmitDiagnostics(program);
const emitResult = noEmit ? { diagnostics: [] } : program.emit();

const all = diagnostics.concat(emitResult.diagnostics);
let hadError = false;
for (const diag of all) {
  const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
  if (diag.file && diag.start !== undefined) {
    const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
    const file = path.relative(root, diag.file.fileName);
    const text = `  ${file}:${line + 1}:${character + 1} — ${message}`;
    console.error(diag.category === ts.DiagnosticCategory.Error ? 'ERR ' + text : 'WARN' + text);
  } else {
    console.error(message);
  }
  if (diag.category === ts.DiagnosticCategory.Error) hadError = true;
}

const count = program.getRootFileNames().length;
console.log(hadError ? `build failed (${count} files checked)` : `build ok: ${count} files → ${options.outDir || 'dist'}`);
process.exit(hadError ? 1 : 0);
