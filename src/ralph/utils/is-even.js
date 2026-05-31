function isEven(n) {
  return Number.isInteger(n) && n % 2 === 0;
}

module.exports = { isEven };
