/**
 * `process.exit`, once both output streams have drained.
 *
 * A piped stdout/stderr — every CI job, and any `rshono build | tee` — is asynchronous on POSIX, and exiting
 * drops whatever has not left the pipe buffer (64 KiB on Linux and macOS; a pipe write on Windows is
 * synchronous, so there the drain is a no-op). On the failure paths that is the report saying *why* the build
 * failed, cut mid-error. A zero-length write's callback fires behind the real ones, so awaiting one per stream
 * is enough.
 *
 * `Promise<never>`, so a caller can `return exit(1)` and keep the branch terminal for control-flow analysis.
 */
export async function exit(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write('', () => resolve()))));
  process.exit(code);
}
