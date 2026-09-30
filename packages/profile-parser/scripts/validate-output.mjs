#!/usr/bin/env node
/**
 * validate-output.mjs — structural validation of a coredoc ParsedRepo JSON.
 *
 * Self-contained (no @coredoc dependency) so the generate-parser skill works
 * independently of the package it replaces. Ported from
 * packages/parser-gen/src/tools/validate-output.ts + the count-based done
 * criteria from check-completion.ts.
 *
 * Usage:  node validate-output.mjs <path-to-parsed-repo.json>
 * Output: JSON { valid, errors[], warnings[], stats{}, doneCriteria{} } to stdout.
 * Exit:   0 when valid (errors.length === 0), 1 otherwise.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';

const outputFile = process.argv[2];
if (!outputFile) {
  console.error('Usage: node validate-output.mjs <path-to-parsed-repo.json>');
  process.exit(2);
}

const errors = [];
const warnings = [];
const stats = {
  files: 0,
  functions: 0,
  classes: 0,
  entrypoints: 0,
  entities: 0,
  calls: 0,
  externalCalls: 0,
  imports: 0,
};

function fail(msg) {
  console.log(JSON.stringify({ valid: false, errors: [msg], warnings, stats }, null, 2));
  process.exit(1);
}

if (!existsSync(outputFile)) fail('Output file does not exist');
const sizeBytes = statSync(outputFile).size;

let data;
try {
  data = JSON.parse(readFileSync(outputFile, 'utf-8'));
} catch (e) {
  fail(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
}

// Required by the ParsedRepo contract. `type` is optional in the schema
// (type?: RepoType) — many valid parsers omit it — so it's a warning, not an error.
const requiredFields = [
  'id',
  'name',
  'path',
  'files',
  'functions',
  'classes',
  'entrypoints',
  'entities',
  'calls',
  'imports',
];
for (const field of requiredFields) {
  if (!(field in data)) errors.push(`Missing required field: ${field}`);
}
if (!('type' in data)) warnings.push('Missing optional field: type (repo type not set)');

const files = data.files ?? [];
const functions = data.functions ?? [];
const classes = data.classes ?? [];
const entrypoints = data.entrypoints ?? [];
const entities = data.entities ?? [];
const calls = data.calls ?? [];
const externalCalls = data.externalCalls ?? [];
const imports = data.imports ?? [];

stats.files = files.length;
stats.functions = functions.length;
stats.classes = classes.length;
stats.entrypoints = entrypoints.length;
stats.entities = entities.length;
stats.calls = calls.length;
stats.externalCalls = externalCalls.length;
stats.imports = imports.length;

const fileIds = new Set(files.map((f) => f.id));
const functionIds = new Set(functions.map((f) => f.id));

for (const fn of functions) {
  if (!fn.id) errors.push('Function missing id');
  if (!fn.versionedId) errors.push(`Function ${fn.id} missing versionedId`);
  if (fn.fileId && !fileIds.has(fn.fileId)) {
    warnings.push(`Function ${fn.id} references non-existent fileId: ${fn.fileId}`);
  }
}

for (const cls of classes) {
  if (cls.methods) {
    for (const methodId of cls.methods) {
      if (typeof methodId !== 'string') {
        errors.push(`Class ${cls.id} has non-string method entry (ClassNode.methods must be string[])`);
      } else if (!functionIds.has(methodId)) {
        warnings.push(`Class ${cls.id} references non-existent method: ${methodId}`);
      }
    }
  }
}

for (const ep of entrypoints) {
  if (ep.handlerId && !functionIds.has(ep.handlerId)) {
    errors.push(`Entrypoint ${ep.id} references non-existent handlerId: ${ep.handlerId}`);
  }
}

for (const call of calls) {
  if (call.callerId && !functionIds.has(call.callerId)) {
    errors.push(`Call ${call.id} references non-existent callerId: ${call.callerId}`);
  }
  if (call.calleeId && !functionIds.has(call.calleeId)) {
    errors.push(`Call ${call.id} references non-existent calleeId: ${call.calleeId}`);
  }
}

for (const ext of externalCalls) {
  if (ext.callerId && !functionIds.has(ext.callerId)) {
    errors.push(`ExternalCall ${ext.id} references non-existent callerId: ${ext.callerId}`);
  }
}

if (stats.functions === 0) warnings.push('No functions found in output');
if (stats.entrypoints === 0) warnings.push('No entrypoints found in output');
if (stats.calls === 0) warnings.push('No calls found in output');

const valid = errors.length === 0;

// Count-based done criteria (mirror of check-completion.ts; coverage judgment is the agent's job).
const doneCriteria = {
  outputHasData: sizeBytes > 100,
  hasFunctions: stats.functions > 0,
  hasEntrypoints: stats.entrypoints > 0,
  hasEntities: stats.entities > 0,
  hasCalls: stats.calls > 0,
  validationPassed: valid,
  callDensity: stats.functions > 0 ? Math.round((stats.calls / stats.functions) * 100) / 100 : null,
};

console.log(JSON.stringify({ valid, errors, warnings, stats, doneCriteria, sizeBytes }, null, 2));
process.exit(valid ? 0 : 1);
