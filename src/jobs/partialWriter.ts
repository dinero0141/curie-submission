/**
 * Coalesces streamed text into at most one `content` write per interval (progressive polling). Writes run
 * one at a time, in order; `stop()` cancels the pending write and waits for the one in flight, so the final
 * update always lands after the last partial write. A failed partial write is reported through `onError`
 * and skipped (the final update is what counts); it never rejects the chain.
 */
export class PartialWriter {
  private text = '';
  private written = '';
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly write: (content: string) => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly onError: (err: unknown) => void,
  ) {}

  append(delta: string): void {
    if (this.stopped || delta === '') return;
    this.text += delta;
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  private flush(): void {
    this.timer = undefined;
    const snapshot = this.text;
    this.chain = this.chain.then(async () => {
      if (this.stopped || snapshot === this.written) return;
      try {
        await this.write(snapshot);
        this.written = snapshot;
      } catch (err) {
        this.onError(err);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.chain;
  }
}
