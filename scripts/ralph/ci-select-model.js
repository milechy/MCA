#!/usr/bin/env node
// CI model selector for the production Aider workflow.
//
// Replaces the fixed LLM_MODEL with a learning + classifier + escalation choice
// so the model is NOT a hardcoded Claude default:
//   1. classify the issue (heuristic backend — zero deps, no model download)
//   2. look up the learned best model for this context bucket in Cloudflare D1
//   3. ask the NemoClaw brain to decide (learned > classifier tier), escalating
//      one rung per failed attempt up to Opus.
//
// Prints the chosen model slug to stdout; a decision JSON to stderr for logs.
//
// Usage:
//   node scripts/ralph/ci-select-model.js --title "..." --body-file /tmp/body.txt \
//        --paths "src/x.js,tests/x.spec.js" --attempt 0 --last-failure ""
const fs = require('node:fs');
const { extractContext } = require('../../src/ralph/task-outcome-recorder');
const { selectModel, tierForComplexity, effectiveComplexity } = require('../../src/ralph/nemoclaw-brain');
const { recommendForBucket, isConfigured } = require('../../src/ralph/d1-learning-store');
const { classifyPrompt } = require('../../src/ralph/complexity-classifier');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] || fallback);
}

// classifier complexity → a stable difficulty label so the context bucket is
// consistent across runs (the bucket is the learning key).
function difficultyForComplexity(score) {
  const t = tierForComplexity(score);
  return ['easy', 'medium', 'hard', 'architectural'][t] || 'easy';
}

async function main() {
  const title = arg('--title');
  const bodyFile = arg('--body-file');
  const body = bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : arg('--body');
  const paths = arg('--paths').split(',').map((p) => p.trim()).filter(Boolean);
  const attempt = Number(arg('--attempt', '0')) || 0;
  const lastFailure = arg('--last-failure') || null;
  const requirement = `${title}\n${body}`.trim();

  // 1. classify (heuristic in CI: no torch/model download).
  const classifierSignal = classifyPrompt({
    prompt: requirement,
    env: {
      ...process.env,
      NEMOCLAW_CLASSIFIER_BACKEND: process.env.NEMOCLAW_CLASSIFIER_BACKEND || 'heuristic',
      NEMOCLAW_CLASSIFIER_PYTHON: process.env.NEMOCLAW_CLASSIFIER_PYTHON || 'python3',
      NEMOCLAW_CLASSIFIER: 'on'
    }
  });

  const complexity = classifierSignal ? Number(classifierSignal.prompt_complexity_score) : null;
  const effective = classifierSignal ? effectiveComplexity(classifierSignal) : null;
  const difficulty = effective != null ? difficultyForComplexity(effective) : 'easy';
  const story = { story_id: arg('--story-id') || 'ci', requirement, requested_paths: paths, difficulty };
  const ctx = extractContext(story);

  // 2. learned recommendation from D1 (null if unconfigured / no data).
  let learnedRec = null;
  if (isConfigured(process.env)) {
    try { learnedRec = await recommendForBucket({ contextBucket: ctx.context_bucket, env: process.env }); }
    catch { learnedRec = null; }
  }

  // 3. brain decides.
  const decision = selectModel({
    story: { ...story, context_bucket: ctx.context_bucket },
    classifierSignal,
    learnedRec,
    attempt,
    lastFailureClass: lastFailure
  });

  const summary = {
    context_bucket: ctx.context_bucket,
    difficulty,
    task_type: classifierSignal && classifierSignal.task_type,
    complexity, effective_complexity: effective,
    attempt, last_failure: lastFailure,
    learned: learnedRec, source: decision.source, tier: decision.tier,
    model: decision.model, escalate_to_human: decision.escalate_to_human,
    rationale: decision.rationale
  };
  process.stderr.write(JSON.stringify(summary) + '\n');
  const outFile = arg('--out');
  if (outFile) { try { fs.writeFileSync(outFile, JSON.stringify(summary)); } catch { /* best effort */ } }

  // stdout = just the model slug for `MODEL=$(...)`.
  process.stdout.write(decision.model + '\n');
  // Signal ladder-exhaustion / cost-cap to the caller via exit code 3.
  process.exit(decision.escalate_to_human ? 3 : 0);
}

main().catch((e) => { process.stderr.write('ci-select-model error: ' + e.message + '\n'); process.exit(1); });
