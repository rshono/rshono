// One bundled file, no runtime dependencies: `npx @rshono/create@latest` downloads this package before it can ask
// its first question, so anything left unbundled is latency the user waits through. @clack/prompts (MIT) and its
// own tree are compiled in instead.
import { rspack } from '@rspack/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dirname;
const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

export default {
  mode: 'production',
  target: 'node22',
  context: dir,
  // Two entries: the CLI, and the generator on its own — what the tests drive and what another tool would import.
  // Keeping them apart means importing the generator cannot start a prompt.
  entry: { cli: join(dir, 'src', 'cli.ts'), api: join(dir, 'src', 'api.ts') },
  output: {
    path: join(dir, 'dist'),
    filename: '[name].mjs',
    module: true,
    chunkFormat: 'module',
    library: { type: 'module' },
    clean: true,
  },
  experiments: { outputModule: true },
  externalsType: 'module-import',
  // `node:` builtins only — everything else belongs in the bundle.
  externals: [/^node:/],
  // `.js` specifiers pointing at `.ts` sources — the same ESM-correct style the framework is written in.
  resolve: { extensions: ['.ts', '.js', '.json'], extensionAlias: { '.js': ['.ts', '.js'] } },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'builtin:swc-loader',
          options: { jsc: { parser: { syntax: 'typescript' } }, env: { targets: ['node >= 22.18'] } },
        },
        type: 'javascript/auto',
      },
    ],
  },
  optimization: {
    // Readable stack traces are worth more than the kilobytes minification saves on a file downloaded once.
    minimize: false,
  },
  plugins: [
    new rspack.BannerPlugin({ banner: '// Bundled by rspack — edit src/ and rebuild. Includes @clack/prompts (MIT).', raw: true }),
    // This package's own manifest, not the framework's: the two ship together today, but `--version` should not
    // start lying the day one of them gets a patch release of its own.
    new rspack.DefinePlugin({ __CREATE_RSHONO_VERSION__: JSON.stringify(version) }),
  ],
  performance: false,
  stats: 'errors-warnings',
};
