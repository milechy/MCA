function once(fn) {
  let called = false;
  let cachedResult;

  return function (...args) {
    if (!called) {
      cachedResult = fn(...args);
      called = true;
    }
    return cachedResult;
  };
}

module.exports = { once };
