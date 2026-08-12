/**
 * The one dependency check the framework makes on an app: that `react` and `react-dom` are the same build.
 *
 * React Server Components couple the two across bundles — `react-server-dom-rspack` reaches into
 * `ReactSharedInternals` and emits a flight payload the *matching* `react-dom` has to parse — so a split
 * resolution is not version skew to be tolerated. It is a crash inside minified React at render time, with
 * nothing in the message pointing at the cause.
 *
 * The monorepo prevents it with `overrides` in `pnpm-workspace.yaml` and `packages/create` pins both exactly
 * for the same reason, because a generated app has no overrides to rely on. Neither helps an app that grew
 * past its scaffold, which is why the check lives here — on the one path every `dev` and `build` takes.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * The React this release was tested against, read off the framework's own manifest rather than restated as a
 * constant — the pin and the check cannot drift apart that way. `undefined` if it cannot be read, which only
 * turns the advisory warning off.
 */
function testedReactVersion(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url)('../../package.json') as {
      devDependencies?: Record<string, string>;
    };
    return manifest.devDependencies?.react;
  } catch {
    return undefined;
  }
}

/** The version of an installed package as the *app* resolves it, or `undefined` if it has none. */
function installedVersion(require: NodeJS.Require, name: string): string | undefined {
  try {
    return (require(`${name}/package.json`) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** `19.2.8` → `19.2`, for comparing minors without pulling in a semver parser. */
function minor(version: string): string {
  return version.split('.', 2).join('.');
}

/**
 * Fails the build when `react` and `react-dom` resolve to different versions, and warns when they are not the
 * version this release was tested with.
 *
 * The mismatch is an error because it never works. A different minor is only a warning: upstream declares
 * `^19.1.0` and may well be right, and refusing to build would make rshono the reason an app cannot take a
 * React release — a worse failure than the one it would prevent.
 *
 * @param rootDir - The project root, so resolution follows the *app's* `node_modules` rather than the
 *   framework's.
 */
export function checkReactVersions(rootDir: string): void {
  // Resolved from the project's manifest, so a pnpm layout answers with what the app actually gets.
  const require = createRequire(join(rootDir, 'package.json'));
  const react = installedVersion(require, 'react');
  const reactDom = installedVersion(require, 'react-dom');
  // Missing altogether is the resolver's to report, against the import that needed it and with the path.
  if (!react || !reactDom) return;

  if (react !== reactDom) {
    throw new Error(
      `[rshono] react ${react} and react-dom ${reactDom} resolve to different versions.\n` +
        '  React Server Components couple them: the RSC runtime emits a payload the matching react-dom parses, ' +
        'so a split resolution fails inside React while rendering rather than here.\n' +
        '  Install both at the same version. If a transitive dependency is what split them, pin them — ' +
        '`overrides` in npm, `pnpm.overrides` in pnpm, `resolutions` in yarn.',
    );
  }

  const tested = testedReactVersion();
  if (tested && minor(tested) !== minor(react)) {
    console.warn(
      `  ⚠ react ${react} is not the ${minor(tested)}.x this rshono was tested against. The RSC runtime is pinned\n` +
        '    to an exact version and reaches into React internals, so a different minor can fail at render time.',
    );
  }
}
