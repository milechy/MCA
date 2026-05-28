function range(start, end, step = 1) {
  if (step <= 0) {
    throw new Error('step must be greater than 0');
  }

  const result = [];
  for (let i = start; i < end; i += step) {
    result.push(i);
  }
  return result;
}

module.exports = { range };
