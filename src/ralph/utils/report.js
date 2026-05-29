function aggregate(results = []) {
  const total = results.length;
  const succeeded = results.filter((r) => r.ok === true).length;
  const failed = results.filter((r) => r.ok === false).length;

  const totalDurationMs = results.reduce((sum, r) => sum + (r.durationMs || 0), 0);
  const avgDurationMs = total > 0 ? totalDurationMs / total : 0;

  const errors = results
    .filter((r) => r.ok === false && r.error)
    .map((r) => String(r.error));

  return {
    total,
    succeeded,
    failed,
    avgDurationMs,
    errors
  };
}

module.exports = { aggregate };
