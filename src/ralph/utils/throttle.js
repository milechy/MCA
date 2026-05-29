function throttle(fn, ms) {
  let lastCallTime = 0;
  let lastResult = undefined;

  return function throttled(...args) {
    const now = Date.now();
    if (now - lastCallTime >= ms) {
      lastCallTime = now;
      lastResult = fn(...args);
    }
    return lastResult;
  };
}

module.exports = { throttle };
