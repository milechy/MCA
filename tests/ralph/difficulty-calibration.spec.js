const { test, expect } = require('@playwright/test');

const {
  rank,
  pairs,
  confusionMatrix,
  classBias,
  calibrationAdjustments,
  correctionExamples
} = require('../../src/ralph/difficulty-calibration');

function outcome(story_id, predicted, actual, task_kind = 'modify') {
  return {
    task: { story_id, predicted_difficulty: predicted, actual_difficulty: actual, task_kind, context_bucket: `${predicted}|${task_kind}|js|2-3f` }
  };
}

test('rank orders the difficulty scale', () => {
  expect(rank('trivial')).toBe(0);
  expect(rank('architectural')).toBe(4);
  expect(rank('bogus')).toBe(null);
});

test('pairs extracts predicted/actual from outcomes that have both', () => {
  const set = [
    outcome('S1', 'easy', 'medium'),
    outcome('S2', 'medium', 'medium'),
    { task: { story_id: 'S3', predicted_difficulty: 'easy' } } // no actual → dropped
  ];
  const ps = pairs(set);
  expect(ps.length).toBe(2);
});

test('confusionMatrix counts predicted×actual', () => {
  const ps = pairs([
    outcome('S1', 'easy', 'medium'),
    outcome('S2', 'easy', 'medium'),
    outcome('S3', 'easy', 'easy')
  ]);
  const m = confusionMatrix(ps);
  expect(m.easy.medium).toBe(2);
  expect(m.easy.easy).toBe(1);
});

test('classBias detects systematic under-estimation', () => {
  // planner says 'easy' but everything is actually 'hard' (rank 1 → 3, +2)
  const ps = pairs([
    outcome('S1', 'easy', 'hard'),
    outcome('S2', 'easy', 'hard'),
    outcome('S3', 'easy', 'hard')
  ]);
  const bias = classBias(ps, { minSamples: 3 });
  expect(bias.easy.direction).toBe('under_estimates');
  expect(bias.easy.mean_rank_error).toBe(2);
  expect(bias.easy.low_confidence).toBe(false);
});

test('classBias detects over-estimation', () => {
  // planner says 'hard' but everything is actually 'easy' (rank 3 → 1, -2)
  const ps = pairs([outcome('S1', 'hard', 'easy'), outcome('S2', 'hard', 'easy')]);
  const bias = classBias(ps, { minSamples: 2 });
  expect(bias.hard.direction).toBe('over_estimates');
  expect(bias.hard.mean_rank_error).toBe(-2);
});

test('classBias marks calibrated when predictions match', () => {
  const ps = pairs([outcome('S1', 'medium', 'medium'), outcome('S2', 'medium', 'medium')]);
  const bias = classBias(ps, { minSamples: 2 });
  expect(bias.medium.direction).toBe('calibrated');
  expect(bias.medium.accuracy).toBe(1);
});

test('classBias flags low confidence under minSamples', () => {
  const ps = pairs([outcome('S1', 'easy', 'hard')]);
  const bias = classBias(ps, { minSamples: 3 });
  expect(bias.easy.low_confidence).toBe(true);
});

test('calibrationAdjustments suggests a shifted tier for biased classes', () => {
  const ps = pairs([
    outcome('S1', 'easy', 'hard'),
    outcome('S2', 'easy', 'hard'),
    outcome('S3', 'easy', 'hard')
  ]);
  const adj = calibrationAdjustments(classBias(ps, { minSamples: 3 }));
  expect(adj.easy.suggested).toBe('hard'); // easy(1) + round(+2) = hard(3)
  expect(adj.easy.direction).toBe('under_estimates');
});

test('calibrationAdjustments emits nothing for calibrated classes', () => {
  const ps = pairs([outcome('S1', 'medium', 'medium'), outcome('S2', 'medium', 'medium')]);
  const adj = calibrationAdjustments(classBias(ps, { minSamples: 2 }));
  expect(Object.keys(adj).length).toBe(0);
});

test('correctionExamples surfaces the worst mis-estimates first', () => {
  const set = [
    outcome('S1', 'trivial', 'architectural'), // err 4
    outcome('S2', 'easy', 'medium'),           // err 1
    outcome('S3', 'medium', 'medium')          // err 0 → excluded
  ];
  const ex = correctionExamples(pairs(set), set, { limit: 5 });
  expect(ex.length).toBe(2);
  expect(ex[0].story_id).toBe('S1'); // biggest error first
  expect(ex[0].lesson).toMatch(/architectural/);
});

test('correctionExamples respects limit', () => {
  const set = [
    outcome('S1', 'trivial', 'hard'),
    outcome('S2', 'trivial', 'hard'),
    outcome('S3', 'trivial', 'hard')
  ];
  const ex = correctionExamples(pairs(set), set, { limit: 2 });
  expect(ex.length).toBe(2);
});
