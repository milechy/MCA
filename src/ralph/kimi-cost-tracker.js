const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DAILY_BUDGET_USD = 5.00;

const INPUT_COST_PER_TOKEN = 0.0000002;
const OUTPUT_COST_PER_TOKEN = 0.0000008;

function estimateTokens(text) {
  if (text == null) return 0;
  return Math.ceil(String(text).length / 4);
}

function estimateCostUsd({ input_tokens, output_tokens }) {
  const inputCost = (input_tokens || 0) * INPUT_COST_PER_TOKEN;
  const outputCost = (output_tokens || 0) * OUTPUT_COST_PER_TOKEN;
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
  const cost = estimateCostUsd({ input_tokens: it, output_tokens: ot });

  const entry = {
    at: now.toISOString(),
    story_id,
    model,
    input_tokens: it,
    output_tokens: ot,
    cost_usd: cost
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
  estimateTokens,
  estimateCostUsd,
  recordKimiCall,
  readDailySpend,
  dailyBudgetCap,
  isOverBudget
};
