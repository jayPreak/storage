// Tiny concurrency limiter. Thumbnail generation for HEIC means fetching,
// decrypting and decoding the full-size original in the browser, so firing
// one per library entry at once (the old behavior) held hundreds of
// multi-MB buffers in memory simultaneously and crashed the tab -- this
// caps how many run at a time.
//
// Each job may carry a priority function, evaluated when a slot frees up
// (not when the job was queued), and the lowest value runs next. The
// gallery uses the tile's current on-screen position, so whatever is at
// the top of what the user is looking at *right now* loads first, even
// after they've scrolled. Jobs without one fall back to newest-first.
export function createLimiter(concurrency: number) {
  let active = 0;
  let seq = 0;
  const queue: { start: () => void; priority: () => number }[] = [];

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const score = queue[i].priority();
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    const [job] = queue.splice(best, 1);
    active++;
    job.start();
  }

  return function run<T>(task: () => Promise<T>, priority?: () => number): Promise<T> {
    const order = -seq++;
    return new Promise<T>((resolve, reject) => {
      queue.push({
        priority: priority ?? (() => order),
        start: () => {
          task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        },
      });
      next();
    });
  };
}
