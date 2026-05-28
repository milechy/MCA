async function asyncMap(arr, asyncFn, concurrency = Infinity) {
  if (!Array.isArray(arr)) {
    throw new TypeError('First argument must be an array');
  }
  if (typeof asyncFn !== 'function') {
    throw new TypeError('Second argument must be a function');
  }
  if ((concurrency !== Infinity && !Number.isFinite(concurrency)) || concurrency < 1) {
    throw new TypeError('Concurrency must be a positive number');
  }

  const results = new Array(arr.length);
  const executing = new Set();
  let index = 0;

  return new Promise((resolve, reject) => {
    const enqueue = async () => {
      if (index >= arr.length && executing.size === 0) {
        resolve(results);
        return;
      }

      if (index >= arr.length || executing.size >= concurrency) {
        return;
      }

      const currentIndex = index;
      index += 1;

      const promise = Promise.resolve()
        .then(() => asyncFn(arr[currentIndex], currentIndex, arr))
        .then((result) => {
          results[currentIndex] = result;
        })
        .catch((error) => {
          reject(error);
        })
        .finally(() => {
          executing.delete(promise);
          enqueue();
        });

      executing.add(promise);
      enqueue();
    };

    enqueue();
  });
}

module.exports = { asyncMap };
