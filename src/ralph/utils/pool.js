/**
 * Run tasks from a queue with concurrency limit.
 * @param {Queue} queue - Queue instance pre-populated with zero-arg async functions
 * @param {number} concurrency - Maximum number of tasks to run in parallel
 * @returns {Promise<Result[]>} Results in enqueue order
 * @throws {Error} If concurrency is not a positive integer
 */
async function run(queue, concurrency) {
  // Validate concurrency
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error('concurrency must be a positive integer');
  }

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
}

module.exports = { run };
