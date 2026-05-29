/**
 * Run tasks from a queue with concurrency limit.
 * @param {Queue} queue - Queue instance pre-populated with zero-arg async functions
 * @param {number} concurrency - Maximum number of tasks to run in parallel
 * @returns {Promise<Result[]>} Results in enqueue order
 * @throws {Error} If concurrency is not a positive integer
 */
function run(queue, concurrency) {
  // Validate concurrency SYNCHRONOUSLY so callers can
  // `expect(() => run(q, 0)).toThrow(...)`. (The autonomous executor first
  // shipped this as an async fn, making the throw a rejected promise — its
  // own test then failed and merged red because there was no test gate;
  // Phase 16 adds that gate. This is the corrected impl.)
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error('concurrency must be a positive integer');
  }

  return (async () => {
  // Collect results in order
  const results = [];
  let taskIndex = 0;
  const lock = { index: 0 };

  // Create a worker that processes tasks from the queue
  const worker = async () => {
    while (true) {
      let task;
      let currentIndex;

      // Atomically get next task and assign index
      if (!queue.isEmpty) {
        task = queue.dequeue();
        currentIndex = lock.index++;
      } else {
        break;
      }

      if (!task) break;

      const startTime = Date.now();

      try {
        const value = await task();
        const durationMs = Date.now() - startTime;
        results[currentIndex] = { ok: true, value, durationMs };
      } catch (error) {
        const durationMs = Date.now() - startTime;
        results[currentIndex] = { ok: false, error, durationMs };
      }
    }
  };

  // Start concurrency workers
  const workers = Array.from({ length: concurrency }, () => worker());

  // Wait for all workers to complete
  await Promise.all(workers);

  return results;
  })();
}

module.exports = { run };
