function sumBy(arr, valueFn) {
  if (!Array.isArray(arr)) {
    throw new TypeError('First argument must be an array');
  }
  if (typeof valueFn !== 'function') {
    throw new TypeError('Second argument must be a function');
  }
  return arr.reduce((sum, item) => sum + valueFn(item), 0);
}

module.exports = { sumBy };
