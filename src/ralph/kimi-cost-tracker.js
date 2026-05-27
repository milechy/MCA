const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DAILY_BUDGET_USD = 5.00;

// Phase 2 #5 default (Kimi K2.6 only) — kept as the fallback for any model
// not in MODEL_PRICING below.
const INPUT_COST_PER_TOKEN = 0.0000002;   // $0.20 / 1M tokens
const OUTPUT_COST_PER_TOKEN = 0.0000008;  // $0.80 / 1M tokens

// Phase 3 #1: per-model pricing table. All rates are USD per token (not per
// 1M). Rates approximate OpenRouter listed prices as of 2026-05; review
// quarterly. If a model name is not in this table, fall back to Kimi rates
// (defined above). The fallback is intentionally an UNDER-COUNT for
// expensive models, which means a missing pricing entry is a SPEND LEAK
// the operator must catch and patch. Phase 3 #5 surfaces fallback usage
// in ledger entry metadata so dashboards can highlight stale entries.
const MODEL_PRICING = Object.freeze({
  // Cheap executors (Phase 2 default)
  'openrouter/moonshotai/kimi-k2.6': { input: 0.0000002, output: 0.0000008, label: 'kimi-k2.6' },
  'openrouter/moonshotai/kimi-k2': { input: 0.0000002, output: 0.0000008, label: 'kimi-k2' },

  // Anthropic Claude family on OpenRouter
  'openrouter/anthropic/claude-sonnet-4.5': { input: 0.000003, output: 0.000015, label: 'claude-sonnet-4.5' },
  'openrouter/anthropic/claude-sonnet-4.6': { input: 0.000003, output: 0.000015, label: 'claude-sonnet-4.6' },
  'openrouter/anthropic/claude-opus-4.7': { input: 0.000015, output: 0.000075, label: 'claude-opus-4.7' },
  'openrouter/anthropic/claude-haiku-4.5': { input: 0.000001, output: 0.000005, label: 'claude-haiku-4.5' },

  // OpenAI GPT-5 family on OpenRouter
  'openrouter/openai/gpt-5': { input: 0.000005, output: 0.000015, label: 'gpt-5' },
  'openrouter/openai/gpt-5-mini': { input: 0.0000015, output: 0.000006, label: 'gpt-5-mini' },

  // Google Gemini on OpenRouter
  'openrouter/google/gemini-3.0-pro': { input: 0.0000035, output: 0.0000105, label: 'gemini-3.0-pro' },

  // Phase 8 #2: DeepSeek family — extremely cheap, capable planner/reviewer.
  // Pricing reflects OpenRouter listed rates as of 2026-05 (verify quarterly).
  // V3 (chat): planner default after Phase 8 smoke proved 26× cheaper than
  // Sonnet at equivalent JSON-spec quality. R1.x (reasoning): tested as
  // reviewer alternative — verdict correct, issue detection shallower.
  'openrouter/deepseek/deepseek-chat': { input: 0.00000027, output: 0.0000011, label: 'deepseek-v3-chat' },
  'openrouter/deepseek/deepseek-r1': { input: 0.00000055, output: 0.00000219, label: 'deepseek-r1' }
});

function pricingForModel(model) {
  if (model && Object.prototype.hasOwnProperty.call(MODEL_PRICING, model)) {
    return MODEL_PRICING[model];
  }
  return { input: INPUT_COST_PER_TOKEN, output: OUTPUT_COST_PER_TOKEN, label: 'fallback_kimi_rates' };
}

function estimateTokens(text) {
  if (text == null) return 0;
  return Math.ceil(String(text).length / 4);
}

function estimateCostUsd({ input_tokens, output_tokens, model } = {}) {
  const rates = pricingForModel(model);
  const inputCost = (input_tokens || 0) * rates.input;
  const outputCost = (output_tokens || 0) * rates.output;
  const total = inputCost + outputCost;
  return Math.round(total * 1_000_000) / 1_000_000;
}

function recordKimiCall({ rootDir, story_id, prompt_text, output_text, model, now = new Date(), input_tokens, output_tokens }) {
  if (!rootDir) {
    return { ok: false, entry: null, ledger_path: null };
  }

  const ralphDir = path.join(rootDir, '.ralph');
  if (!fs.existsSync(ralphDir)) {
    fs.mkdirSync(ralphDir, { recursive: true });
  }

  const ledgerPath = path.join(ralphDir, 'cost-ledger.jsonl');

  const it = input_tokens != null ? input_tokens : estimateTokens(prompt_text);
  const ot = output_tokens != null ? output_tokens : estimateTokens(output_text);
  // Phase 3 #1: pass model into pricing so per-model rates apply.
  const cost = estimateCostUsd({ input_tokens: it, output_tokens: ot, model });
  const rates = pricingForModel(model);
  const pricingSource = rates.label === 'fallback_kimi_rates' ? 'fallback_kimi_rates' : rates.label;

  const entry = {
    at: now.toISOString(),
    story_id,
    model,
    input_tokens: it,
    output_tokens: ot,
    cost_usd: cost,
    pricing_source: pricingSource
  };

  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');

  return { ok: true, entry, ledger_path: ledgerPath };
}

function readDailySpend({ rootDir, date = new Date() }) {
  const dateIso = date.toISOString().slice(0, 10);
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');

  if (!fs.existsSync(ledgerPath)) {
    return {
      date_iso: dateIso,
      entries: [],
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      story_count: 0
    };
  }

  const raw = fs.readFileSync(ledgerPath, 'utf8');
  const lines = raw.split('\n');
  const entries = [];
  const seenStories = new Set();
  let input_tokens = 0;
  let output_tokens = 0;
  let cost_usd = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.at && entry.at.startsWith(dateIso)) {
        entries.push(entry);
        input_tokens += entry.input_tokens || 0;
        output_tokens += entry.output_tokens || 0;
        cost_usd += entry.cost_usd || 0;
        if (entry.story_id) seenStories.add(entry.story_id);
      }
    } catch (err) {
      console.error('Skipping malformed cost-ledger line:', line, err.message);
    }
  }

  return {
    date_iso: dateIso,
    entries,
    input_tokens,
    output_tokens,
    cost_usd,
    story_count: seenStories.size
  };
}

function dailyBudgetCap({ env = process.env } = {}) {
  const raw = env.RALPH_KIMI_DAILY_BUDGET_USD;
  const parsed = parseFloat(raw);
  if (!Number.isNaN(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_DAILY_BUDGET_USD;
}

function isOverBudget({ rootDir, env = process.env, now = new Date() } = {}) {
  const daily_spend = readDailySpend({ rootDir, date: now }).cost_usd;
  const daily_cap = dailyBudgetCap({ env });

  let fraction;
  if (daily_cap === 0) {
    fraction = 0;
  } else {
    fraction = daily_spend / daily_cap;
  }

  return {
    over: daily_spend > daily_cap,
    daily_spend,
    daily_cap,
    fraction
  };
}

module.exports = {
  DEFAULT_DAILY_BUDGET_USD,
  MODEL_PRICING,
  pricingForModel,
  estimateTokens,
  estimateCostUsd,
  recordKimiCall,
  readDailySpend,
  dailyBudgetCap,
  isOverBudget
};
