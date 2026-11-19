import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartialWriter } from '../../src/jobs/partialWriter.js';

describe('PartialWriter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces deltas into at most one write per interval, each with the full text so far', async () => {
    const writes: string[] = [];
    const w = new PartialWriter(async (c) => void writes.push(c), 100, () => {});
    w.append('a');
    w.append('b');
    await vi.advanceTimersByTimeAsync(99);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(['ab']);
    w.append('c');
    w.append('');
    await vi.advanceTimersByTimeAsync(100);
    expect(writes).toEqual(['ab', 'abc']);
    await w.stop();
  });

  it('runs writes one at a time, in order, and stop() waits for the one in flight', async () => {
    const events: string[] = [];
    let finishSlow!: () => void;
    const write = vi.fn(async (c: string) => {
      events.push(`start ${c}`);
      if (c === 'a') await new Promise<void>((r) => (finishSlow = r));
      events.push(`end ${c}`);
    });
    const w = new PartialWriter(write, 10, () => {});
    w.append('a');
    await vi.advanceTimersByTimeAsync(10); // slow write of 'a' starts
    w.append('b');
    await vi.advanceTimersByTimeAsync(10); // 'ab' is queued behind it, not started
    expect(events).toEqual(['start a']);

    let stopped = false;
    const stopping = w.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false); // still waiting for the in-flight write
    finishSlow();
    await stopping;
    // The queued write was dropped by stop(): the final update must be the last write to land.
    expect(events).toEqual(['start a', 'end a']);
  });

  it('cancels a pending write on stop() and ignores appends after it', async () => {
    const write = vi.fn(async () => {});
    const w = new PartialWriter(write, 100, () => {});
    w.append('a');
    await w.stop();
    w.append('b');
    await vi.advanceTimersByTimeAsync(500);
    expect(write).not.toHaveBeenCalled();
  });

  it('reports a failed write and keeps going without rejecting', async () => {
    const onError = vi.fn();
    const writes: string[] = [];
    let fail = true;
    const w = new PartialWriter(
      async (c) => {
        if (fail) {
          fail = false;
          throw new Error('db blip');
        }
        writes.push(c);
      },
      10,
      onError,
    );
    w.append('a');
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db blip' }));
    w.append('b');
    await vi.advanceTimersByTimeAsync(10);
    expect(writes).toEqual(['ab']);
    await expect(w.stop()).resolves.toBeUndefined();
  });
});
