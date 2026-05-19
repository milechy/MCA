const { MODEL_PRICING, pricingForModel, estimateCostUsd } = require('./kimi-cost-tracker');

const FALLBACK_EXECUTOR_MODEL = 'openrouter/moonshotai/kimi-k2.6';

function estimateCostFromContext({ prompt_chars, model, expected_output_chars = 12000 } = {}) {
  const input_tokens = Math.ceil((prompt_chars || 0) / 4);
  const output_tokens = Math.ceil((expected_output_chars || 0) / 4);
  return estimateCostUsd({ input_tokens, output_tokens, model });
}

function routeExecutor({ story, env = process.env, rootDir, prompt_chars = 0 } = {}) {
  const specified = story && story.executor_model;
  let executor_model;
  let fallback_applied = false;
  let reason = null;
  let ok = true;

  if (specified) {
    if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, specified)) {
      executor_model = specified;
      fallback_applied = false;
      reason = null;
    } else {
      executor_model = FALLBACK_EXECUTOR_MODEL;
      fallback_applied = true;
      reason = 'executor_model_not_allowed';
      ok = false;
    }
  } else {
    executor_model = FALLBACK_EXECUTOR_MODEL;
    fallback_applied = true;
    reason = 'no_executor_specified';
  }

  const estimated_cost_usd = estimateCostFromContext({ prompt_chars, model: executor_model });

  return { ok, executor_model, estimated_cost_usd, reason, fallback_applied };
}

module.exports = {
  FALLBACK_EXECUTOR_MODEL,
  estimateCostFromContext,
  routeExecutor
};
