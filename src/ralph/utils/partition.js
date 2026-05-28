function partition(arr, predicate) {
  const matching = [];
  const nonMatching = [];

  for (const item of arr) {
    if (predicate(item)) {
      matching.push(item);
    } else {
      nonMatching.push(item);
    }
  }

  return [matching, nonMatching];
}

module.exports = { partition };
