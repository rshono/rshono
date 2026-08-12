import type { Hono } from 'hono';
import { streamHandle } from 'hono/aws-lambda';
import type { DeployRuntime } from '../contract.js';
import { fileSystemRuntime } from '../filesystem.js';

/**
 * AWS Lambda behind a Function URL, in streaming mode.
 *
 * `streamHandle` wraps the app with `awslambda.streamifyResponse`, the only way a Lambda writes a response
 * progressively — which is the whole point of a streamed SSR shell. It requires the Function URL's invoke mode
 * to be `RESPONSE_STREAM`; the buffered `handle` would work anywhere but hold every page until its last byte.
 *
 * The filesystem capabilities are Node's: a Lambda unpacks the deployment package onto a read-only disk.
 */
export const runtime: DeployRuntime = {
  ...fileSystemRuntime,

  serveApp(app: Hono): unknown {
    // A global the Lambda runtime injects, so it is absent when the build imports this bundle to prerender.
    if (typeof (globalThis as { awslambda?: unknown }).awslambda === 'undefined') return undefined;
    return streamHandle(app);
  },
};
