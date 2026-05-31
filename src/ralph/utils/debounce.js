function debounce(fn, wait = 0, immediate = false) {
  if (typeof fn !== 'function') {
    throw new TypeError('Expected a function');
  }

  let timeoutId = null;

  function debounced(...args) {
    const callNow = immediate && !timeoutId;

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (!immediate) {
        fn.apply(this, args);
      }
    }, wait);

    if (callNow) {
      fn.apply(this, args);
    }
  }

  debounced.cancel = function cancel() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return debounced;
}

export default debounce;
export { debounce };
