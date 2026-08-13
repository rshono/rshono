/**
 * Nothing about this value matters except where it can be read from: an endpoint in the testbed returns it,
 * and the serverless suites assert on it after copying the build somewhere with no `node_modules`. If a
 * target ever stops bundling the app's dependencies, that request is what fails.
 */
export const EXTERNAL_DEP_MARKER = 'resolved-without-node-modules';
