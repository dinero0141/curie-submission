/** Graceful shutdown shared by the API and worker entrypoints. */
import type { Logger } from 'pino';

/**
 * On SIGTERM or SIGINT, run `close` once (a second signal is ignored), then exit 0, or 1 if it throws.
 */
export function onShutdown(log: Pick<Logger, 'info' | 'error'>, close: () => Promise<void>): void {
  let closing = false;
  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    try {
      await close();
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
