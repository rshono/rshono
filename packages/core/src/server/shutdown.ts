/**
 * Registers `handler` for both `SIGINT` and `SIGTERM` — the two signals a process manager or `Ctrl-C` uses to
 * ask for a graceful stop. Shared by the server bundle and the `start` launcher.
 */
export function onShutdown(handler: (signal: NodeJS.Signals) => void): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => handler(signal));
  }
}
