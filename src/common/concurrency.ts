// Bounded concurrent reads shared by the contract readers and Guardian.

/**
 * Map `items` `concurrency` at a time, in their order. Every call of a wave settles before the first
 * failure in item order ends the call, so no call outlives it.
 */
export async function mapConcurrently<Item, Result>(
  concurrency: number,
  items: readonly Item[],
  map: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let from = 0; from < items.length; from += concurrency) {
    const wave = await Promise.allSettled(items.slice(from, from + concurrency).map(map));
    for (const outcome of wave) {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
      results.push(outcome.value);
    }
  }
  return results;
}
