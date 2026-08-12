#!/usr/bin/env node
// Thin launcher, deliberately old-syntax and dependency-free: it is the one file that has to parse and run on
// whatever Node the user happens to have. A version check inside the CLI bundle would be too late — its imports
// evaluate before any statement in it.
//
// Kept in step with `engines.node` in @rshono/core's manifest, which is what a scaffolded app pins.
var MINIMUM = [22, 18, 0];

var current = process.versions.node.split('.').map(Number);
var older = false;
for (var i = 0; i < MINIMUM.length; i++) {
  if (current[i] === MINIMUM[i]) continue;
  older = current[i] < MINIMUM[i];
  break;
}

if (older) {
  console.error(
    '\ncreate-rshono needs Node ' +
      MINIMUM.join('.') +
      ' or newer — you are on ' +
      process.versions.node +
      '.\n' +
      'rshono itself requires it (native TypeScript stripping loads rshono.config.ts, and the dev\n' +
      'server needs process.loadEnvFile and Promise.withResolvers), so scaffolding on this version\n' +
      'would produce an app that cannot start.\n',
  );
  process.exit(1);
}

import('../dist/cli.mjs');
