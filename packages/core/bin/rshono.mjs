#!/usr/bin/env node
// Thin launcher for the compiled CLI. Everything here has to happen before the CLI module graph loads, which is
// why the import at the bottom is dynamic.
const args = process.argv.slice(2);

// The production commands default NODE_ENV, which is read during config resolution and baked into the bundle.
if ((args[0] === 'build' || args[0] === 'start') && !process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// dist ships source maps, so framework stack traces point at the original TypeScript.
process.setSourceMapsEnabled(true);

await import('../dist/cli/index.js');
