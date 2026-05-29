const fs = require('node:fs');
const path = require('node:path');

const { pricingForModel } = require('./kimi-cost-tracker');

// Phase 11-C: shadow the OpenRouter auto-router against our fixed ladder.
//
// "Buy not build" (Perplexity cross-check, §8.3): instead of hand-rolling a
// learning router, observe what OpenRouter's auto-router (NotDiamond-backed,
// model slug `openrouter/auto`) would pick for each task, and compare it to
// what executor-router.js's fixed DIFFICULTY_TIER_MODELS picks. Recommend-
// only — actual execution still uses the ladder. If auto-router
// consistently beats the ladder on cost-at-equal-success, that's the signal
// to delegate a tier to it (zero infra to maintain).
//
// The live probe confirmed (2026-05-29) that `openrouter/auto` returns the
// chosen underlying model in the response `.model` field plus cost in
// `.usage.cost`, so a true shadow comparison is possible.
//
// Pure logic + injected fetch so tests never hit the network.

const AUTO_MODEL = 'openrouter/auto';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Blended per-token rate (simple mean of input+output) used only to rank
// two models cheaper/pricier relative to each other. Not a cost forecast.
function blendedRate(model) {
  const p = pricingForModel(model);
  return ((Number(p.input) || 0) + (Number(p.output) || 0)) / 2;
}

// Is this model actually in our pricing table, or are we guessing with the
// Kimi fallback rate? The auto-router routinely picks bleeding-edge models
// (gemini-3-flash, gpt-5.5) we haven't priced — comparing those by blended
// rate is meaningless, so callers must know.
function isPriced(model) {
  return pricingForModel(model).label !== 'fallback_kimi_rates';
}

// Probe the auto-router with a routing-representative prompt. Returns the
// model it chose and the (tiny) probe cost. `fetchImpl` is injectable.
async function probeAutoRouter({ prompt, apiKey, fetchImpl = fetch, maxTokens = 16 } = {}) {
  if (!apiKey) return { ok: false, reason: 'api_key_required' };
  if (!prompt) return { ok: false, reason: 'prompt_required' };
  try {
    const res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AUTO_MODEL,
        // Route on the real task complexity but cap output: the auto-router
        // decides on the INPUT, so a small max_tokens doesn't change the pick
        // while keeping the probe cheap.
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens
      })
    });
    const json = await res.json();
    if (!json || !json.model) return { ok: false, reason: 'no_model_in_response', raw: json };
    return {
      ok: true,
      chosen_model: json.model,
      probe_cost_usd: json.usage && (json.usage.cost != null) ? Number(json.usage.cost) : null,
      id: json.id || null
    };
  } catch (err) {
    return { ok: false, reason: 'probe_failed', error: err.message };
  }
}

// Compare the ladder pick to the auto-router pick.
function compareRouting({ ladder_model, auto_model } = {}) {
  if (!ladder_model || !auto_model) {
    return { agree: false, comparable: false, note: 'missing_model' };
  }
  const agree = ladder_model === auto_model;
  const ladderRate = blendedRate(ladder_model);
  const autoRate = blendedRate(auto_model);
  const autoPriced = isPriced(auto_model);
  const ladderPriced = isPriced(ladder_model);
  let cost_relation;
  if (agree) {
    cost_relation = 'same';
  } else if (!autoPriced || !ladderPriced) {
    // can't honestly compare cost when a model isn't in our pricing table
    cost_relation = 'unpriced';
  } else if (autoRate < ladderRate) {
    cost_relation = 'auto_cheaper';
  } else if (autoRate > ladderRate) {
    cost_relation = 'auto_pricier';
  } else {
    cost_relation = 'equal_rate';
  }
  return {
    agree,
    comparable: true,
    ladder_model,
    auto_model,
    ladder_blended_rate: ladderRate,
    auto_blended_rate: autoRate,
    auto_priced: autoPriced,
    cost_relation,
    note: agree
      ? 'auto-router agrees with the fixed ladder'
      : cost_relation === 'unpriced'
        ? `auto-router picked ${auto_model} which is not in MODEL_PRICING — add it to compare cost`
        : `auto-router diverges: picks ${auto_model} (${cost_relation})`
  };
}

function recordShadow({ rootDir, story = {}, ladder_model, auto_result, comparison, now = new Date() }) {
  if (!rootDir) return { ok: false, reason: 'rootDir_required' };
  const ralphDir = path.join(rootDir, '.ralph');
  if (!fs.existsSync(ralphDir)) fs.mkdirSync(ralphDir, { recursive: true });
  const outPath = path.join(ralphDir, 'shadow-routing.jsonl');
  const entry = {
    at: now.toISOString(),
    story_id: story.story_id || null,
    difficulty: story.difficulty || null,
    ladder_model,
    auto_model: auto_result && auto_result.chosen_model ? auto_result.chosen_model : null,
    auto_probe_ok: !!(auto_result && auto_result.ok),
    auto_probe_cost_usd: auto_result ? auto_result.probe_cost_usd : null,
    comparison
  };
  fs.appendFileSync(outPath, JSON.stringify(entry) + '\n', 'utf8');
  return { ok: true, path: outPath, entry };
}

// Summarize a set of shadow entries: how often does auto agree / pick
// cheaper / pricier, by difficulty.
function summarizeShadow(entries = []) {
  const byDiff = {};
  let agree = 0, cheaper = 0, pricier = 0, unpriced = 0, diverge = 0, total = 0;
  for (const e of entries) {
    if (!e.comparison || !e.comparison.comparable) continue;
    total += 1;
    const d = e.difficulty || 'unknown';
    byDiff[d] = byDiff[d] || { agree: 0, auto_cheaper: 0, auto_pricier: 0, unpriced: 0, total: 0 };
    byDiff[d].total += 1;
    if (e.comparison.agree) { agree += 1; byDiff[d].agree += 1; }
    else {
      diverge += 1;
      if (e.comparison.cost_relation === 'auto_cheaper') { cheaper += 1; byDiff[d].auto_cheaper += 1; }
      else if (e.comparison.cost_relation === 'auto_pricier') { pricier += 1; byDiff[d].auto_pricier += 1; }
      else if (e.comparison.cost_relation === 'unpriced') { unpriced += 1; byDiff[d].unpriced += 1; }
    }
  }
  return {
    total,
    agree,
    diverge,
    auto_cheaper: cheaper,
    auto_pricier: pricier,
    unpriced,
    agree_rate: total ? Math.round((agree / total) * 1000) / 1000 : 0,
    by_difficulty: byDiff
  };
}

module.exports = {
  AUTO_MODEL,
  OPENROUTER_URL,
  blendedRate,
  isPriced,
  probeAutoRouter,
  compareRouting,
  recordShadow,
  summarizeShadow
};
