import type { DeployTargetName } from '../options.js';
import type { PackageManager } from '../pm.js';
import { invoke } from '../scripts.js';
import { TOOL_VERSIONS } from '../versions.js';
import type { Feature } from './types.js';

/**
 * What a deploy target adds beyond the `deploy` line in `rshono.config.ts`, which the template carries.
 *
 * Thin on purpose: the framework arranges its own output for every platform, and `rshono build` writes the one
 * platform config that has to exist. So a target contributes the commands that run and ship the build, the CLI
 * they need, the directories to gitignore, and a note for the step no command covers.
 *
 * What the three script names promise is documented above `BASE_SCRIPTS` in `scripts.ts`. Only `node` has a
 * `start` — `rshono start` refuses a bundle built for anywhere else — and it needs no `preview`, since `build`
 * then `start` already is one.
 */
function deployFeatures(pm: PackageManager): Record<DeployTargetName, Feature> {
  const build = invoke(pm, 'build');

  return {
    // Where a Node build goes next is a Dockerfile or a process manager, neither of which this can guess.
    node: {
      id: 'deploy-node',
      scripts: { start: 'rshono start' },
      scriptHelp: { start: 'run the build that exists — what your host calls' },
      platformSetup: [
        'The two commands a host asks for:',
        '',
        `- **Build** — \`${pm.name} install && ${build}\``,
        `- **Start** — \`${invoke(pm, 'start')}\``,
        '',
        `In a Dockerfile, the same pair: \`RUN ${build}\`, then \`CMD ["${pm.name}", "start"]\`.`,
      ].join('\n'),
    },
    cloudflare: {
      id: 'deploy-cloudflare',
      devDependencies: { wrangler: TOOL_VERSIONS.wrangler },
      // The only two install scripts a scaffolded app can end up with, and wrangler brings both. Each merely
      // picks the platform binary out of the optional dependency already carrying it, so neither needs to run.
      allowBuilds: { esbuild: false, workerd: false },
      // `wrangler dev` is the one preview that runs the code in workerd rather than Node. Both scripts read the
      // wrangler.jsonc the build wrote, so nothing here has to know where the bundle went.
      scripts: { preview: 'rshono build && wrangler dev', deploy: 'rshono build && wrangler deploy' },
      scriptHelp: {
        preview: 'build, then run it in workerd — port 8787',
        deploy: 'build, then ship it to Cloudflare',
      },
      gitignore: ['.wrangler/'],
      notes: ['The first build writes wrangler.jsonc — yours to edit after that.'],
      platformSetup: [
        `Building from a git repo instead: set Workers Builds' **Build command** to \`${build}\`.`,
        'Its deploy command already defaults to `npx wrangler deploy`, and it installs dependencies itself.',
      ].join('\n'),
    },
    vercel: {
      id: 'deploy-vercel',
      // `--prod` because the script is called `deploy`: without it the CLI uploads to a throwaway preview URL.
      // `preview` is a Node build run here — the platform cannot run its own prebuilt output on your machine.
      scripts: {
        preview: 'rshono build --deploy node && rshono start',
        deploy: `rshono build && ${pm.dlx} vercel deploy --prebuilt --prod`,
      },
      scriptHelp: {
        preview: 'build for Node and run that here',
        deploy: 'build, then upload it to production',
      },
      gitignore: ['.vercel/'],
      notes: [
        '--prebuilt uploads what rshono build assembled; the platform must not rebuild it.',
        'Drop --prod from the deploy script for a preview URL instead.',
      ],
      platformSetup: [
        `Deploying from CI instead: the same \`${invoke(pm, 'deploy')}\`, with \`VERCEL_ORG_ID\`, \`VERCEL_PROJECT_ID\``,
        'and a CLI token in the environment.',
        '',
        `If you let Vercel build the repo itself, set **Framework Preset** to Other — \`hono\` is otherwise`,
        `detected as the Hono preset — and **Build Command** to \`${build}\`.`,
      ].join('\n'),
    },
    'aws-lambda': {
      id: 'deploy-aws-lambda',
      // No CLI to wrap and no upload to guess at, but `preview` still applies: the bundle is a Node handler.
      scripts: { preview: 'rshono build --deploy node && rshono start' },
      scriptHelp: { preview: 'build for Node and run that here' },
      notes: ['Use a Function URL in RESPONSE_STREAM mode — a buffered invoke mode drops the streaming.'],
      platformSetup: [
        `There is no settings page here; the upload is yours to script. A job needs \`${pm.name} install && ${build}\`,`,
        'then the function package: `dist/`, plus `node_modules` for any dependency of your own, which the server',
        'bundle leaves external.',
      ].join('\n'),
    },
  };
}

export function deployFeature(target: DeployTargetName, pm: PackageManager): Feature {
  return deployFeatures(pm)[target];
}
