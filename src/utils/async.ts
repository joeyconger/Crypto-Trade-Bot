export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A FIFO queue for async work that must never overlap for the same key --
 * each call waits for the prior call sharing that key to settle (resolve
 * OR reject) before starting, so at most one is ever in flight per key at
 * once. A rejection doesn't jam the queue for calls behind it.
 *
 * Built for two call sites that both learned this the hard way: live
 * trade execution (src/tail/liveExecution.ts) measures real proceeds via
 * a before/after balance delta on the shared wallet -- two trades
 * executing "at the same time" could have one's real balance movement
 * land inside the other's measurement window and get misattributed,
 * corrupting the recorded fill price (confirmed live: a tailed wallet
 * dumping several tokens within seconds produced a fill price 7-8x the
 * real one on more than one trade in that burst). Helius webhook config
 * updates (src/data/heliusWebhook.ts) do a read-then-full-replace against
 * one shared remote resource -- two near-simultaneous add/remove calls can
 * otherwise silently drop one of the two changes.
 */
export function createKeyedSerializer<K>() {
  const chains = new Map<K, Promise<unknown>>();
  return function serialize<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(key) ?? Promise.resolve();
    const result = prior.then(fn, fn);
    chains.set(
      key,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  };
}

/** A single unkeyed FIFO queue -- for when there's only ever one shared resource to protect, not several distinguished by key. */
export function createSerializer() {
  const serializeByKey = createKeyedSerializer<0>();
  return function serialize<T>(fn: () => Promise<T>): Promise<T> {
    return serializeByKey(0, fn);
  };
}
