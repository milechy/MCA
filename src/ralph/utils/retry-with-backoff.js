async function retryWithBackoff(fn, opts = {}) {
  const { attempts = 3, baseDelayMs = 50 } = opts;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('attempts must be a positive integer');
  }
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) {
    throw new Error('baseDelayMs must be a non-negative integer');
  }

  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        const delayMs = baseDelayMs * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

module.exports = { retryWithBackoff };
