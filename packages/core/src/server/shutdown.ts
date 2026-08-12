/**
 * Registers `handler` for both `SIGINT` and `SIGTERM` — the two signals a process manager or `Ctrl-C` uses to
 * ask for a graceful stop.
 *
 * Registered by the server bundle itself, which is why `rshono start` needs no supervisor to forward signals
 * to: it imports the bundle into its own process, so these handlers are already the process's.
 */
export function onShutdown(handler: (signal: NodeJS.Signals) => void): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => handler(signal));
  }
}
