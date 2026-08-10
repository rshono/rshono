import type { DeployTargetName } from '../options.js';
import type { PackageManager } from '../pm.js';
import { invoke } from '../scripts.js';
import { TOOL_VERSIONS } from '../versions.js';
import type { Feature } from './types.js';

/**
 * What a deploy target adds beyond the `deploy` line in `rshono.config.ts`, which the template carries.
 *
 * Deliberately thin: the framework arranges its own output for every platform, and `rshono build`
 * writes the one platform config that has to exist (`wrangler.jsonc`) if the project has none — a second
 * copy generated here would only go stale. So a target contributes the commands that run and ship the
 * build, the CLI they need, the directories to gitignore, and a note for the step no command covers.
 *
 * Which script names mean what is settled in `scripts.ts`, above `BASE_SCRIPTS`. In short: `start` runs an
 * existing build, `preview` builds and runs it here, `deploy` builds and ships it. The targets that have
 * one command to ship with have a `deploy`; the ones whose build is not a server locally have a `preview`,
 * since "does the production build work" is otherwise unanswerable without deploying it. Only `node` has a
 * `start`, and it needs no `preview`: `build` then `start` *is* the preview, and `rshono start` refuses a
 * bundle built for anywhere else rather than starting one with no listener in it.
 *
 * `pm` is here for two reasons — the Vercel CLI is not installed, so its script has to name the runner that
 * fetches it (see {@link PackageManager.dlx}), and every command in {@link Feature.platformSetup} is spelled
 * for the package manager the app got.
 */
function deployFeatures(pm: PackageManager): Record<DeployTargetName, Feature> {
  const build = invoke(pm, 'build');

  return {
    // Where a Node build goes from here is a Dockerfile or a process manager, neither of which this can
    // guess — so the target contributes only the command that runs what was built.
    node: {
      id: 'deploy-node',
      scripts: { start: 'rshono start' },
      scriptHelp: { start: 'run the build that exists — what your host calls' },
      platformSetup: [
        'Hosting it somewhere with two fields to fill in — Render, Railway, Fly, a PaaS:',
        '',
        `- **Build command** — \`${pm.name} install && ${build}\``,
        `- **Start command** — \`${invoke(pm, 'start')}\``,
        '',
        `A Dockerfile is the same pair: \`RUN ${build}\`, then \`CMD ["${pm.name}", "start"]\`.`,
      ].join('\n'),
    },
    cloudflare: {
      id: 'deploy-cloudflare',
      devDependencies: { wrangler: TOOL_VERSIONS.wrangler },
      // The only two install scripts a scaffolded app can end up with, and wrangler brings both. Each
      // one merely picks the platform binary out of the optional dependency that already carries it, so
      // neither needs to run — `workerd --version` and `esbuild --version` both answer without it.
      allowBuilds: { esbuild: false, workerd: false },
      // `wrangler dev` is the one preview that runs the code in the runtime it will actually run in:
      // workerd, not Node, serving the assets the build assembled. Both scripts read the wrangler.jsonc the
      // build wrote, so nothing here has to know where the bundle or the assets went.
      scripts: { preview: 'rshono build && wrangler dev', deploy: 'rshono build && wrangler deploy' },
      scriptHelp: {
        preview: 'build, then run it in workerd — port 8787',
        deploy: 'build, then ship it to Cloudflare',
      },
      gitignore: ['.wrangler/'],
      notes: ['The first build writes wrangler.jsonc — yours to edit after that.'],
      platformSetup: [
        'Building on Cloudflare from a git repo instead — the two commands Workers Builds asks for:',
        '',
        `- **Build command** — \`${build}\``,
        '- **Deploy command** — `npx wrangler deploy`, or `npx wrangler versions upload` on a preview branch',
        '',
        'Its build image installs your dependencies before running these, and has npm, pnpm, yarn and bun in it —',
        'so `npx` there runs the wrangler that install put in `node_modules`, whichever manager did the installing.',
      ].join('\n'),
    },
    vercel: {
      id: 'deploy-vercel',
      // `--prod` because the script is called `deploy`: without it the CLI uploads to a throwaway preview
      // URL, which is a useful thing to have but not what the word means. The local `preview` is a Node
      // build run here — the platform has no way to run its own prebuilt output on your machine.
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
        `Deploying from CI instead — the same \`${invoke(pm, 'deploy')}\`, with \`VERCEL_ORG_ID\` and`,
        '`VERCEL_PROJECT_ID` in the job environment and a token for the CLI to authenticate with. That is the',
        'route this target is for: the build has already assembled the deployment, which is what `--prebuilt`',
        'uploads, and the platform must not rebuild it.',
        '',
        'If you connect the repo to Vercel’s own builds instead, its settings have to be pointed here:',
        '**Framework Preset** — Other, because `hono` in the dependencies is otherwise detected as the Hono',
        `preset and would bring its build settings with it — and **Build Command** — \`${build}\`.`,
      ].join('\n'),
    },
    'aws-lambda': {
      id: 'deploy-aws-lambda',
      // No CLI to wrap: the upload is SAM, CDK, Terraform or the console, and guessing wrong would be
      // worse than saying nothing. `preview` still applies — the Lambda bundle is a Node handler.
      scripts: { preview: 'rshono build --deploy node && rshono start' },
      scriptHelp: { preview: 'build for Node and run that here' },
      notes: ['Use a Function URL in RESPONSE_STREAM mode — a buffered invoke mode drops the streaming.'],
      platformSetup: [
        'There is no dashboard to fill in here: the upload is SAM, CDK, Terraform or the console. What a CI job',
        `needs is \`${pm.name} install && ${build}\`, and then the function package — \`dist/\`, plus \`node_modules\` if the`,
        'app has dependencies of its own, which the server bundle leaves external rather than inlining.',
      ].join('\n'),
    },
  };
}

export function deployFeature(target: DeployTargetName, pm: PackageManager): Feature {
  return deployFeatures(pm)[target];
}
