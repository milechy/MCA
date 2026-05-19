const fs = require('node:fs');
const path = require('node:path');
const { recordKimiCall } = require('./kimi-cost-tracker');

const PLANNER_PROMPT_TEMPLATE = `You are a planning agent for an autonomous code-writing pipeline. Your job: take a vague human idea and produce a tight JSON story spec.

User idea:
{IDEA}

Repository context:
{REPO_CONTEXT}

Constraints:
- requested_paths must be 1-6 file paths (more = error-prone for the executor).
- requirement must use 'FILE N (CREATE)' or 'FILE N (MODIFY EXISTING)' headers for each path, with enough detail that a junior developer can implement without follow-up questions.
- difficulty must be one of: trivial, easy, medium, hard, architectural.
- recommended_executor:
  * trivial/easy -> openrouter/moonshotai/kimi-k2.6
  * medium -> openrouter/moonshotai/kimi-k2.6 (preferred for cost) or openrouter/anthropic/claude-haiku-4.5
  * hard -> openrouter/anthropic/claude-sonnet-4.6
  * architectural -> openrouter/anthropic/claude-sonnet-4.6 or openrouter/openai/gpt-5

Return ONLY valid JSON with this exact shape:
{
  "title": "string",
  "requirement": "string",
  "requested_paths": ["path1", "path2"],
  "difficulty": "easy",
  "recommended_executor": "openrouter/moonshotai/kimi-k2.6",
  "reasoning": "string"
}`;

const DEFAULT_PLANNER_MODEL = 'openrouter/anthropic/claude-sonnet-4.6';
const DEFAULT_MAX_RETRIES = 1;

const VALID_DIFFICULTIES = new Set(['trivial', 'easy', 'medium', 'hard', 'architectural']);

function buildRepoContext(rootDir) {
  try {
    const parts = [];
    let totalLength = 0;
    const cap = 6000;

    function addSection(header, content) {
      const section = `--- ${header} ---\n${content}\n`;
      if (totalLength + section.length > cap) {
        const remaining = cap - totalLength;
        if (remaining > header.length + 10) {
          const truncated = section.slice(0, remaining);
          parts.push(truncated);
          totalLength += truncated.length;
        }
        return false;
      }
      parts.push(section);
      totalLength += section.length;
      return true;
    }

    const readmePath = path.join(rootDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      const readme = fs.readFileSync(readmePath, 'utf8').slice(0, 2000);
      if (!addSection('README.md', readme)) {
        return parts.join('').slice(0, cap);
      }
    }

    const claudePath = path.join(rootDir, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      const claude = fs.readFileSync(claudePath, 'utf8').slice(0, 2000);
      if (!addSection('CLAUDE.md', claude)) {
        return parts.join('').slice(0, cap);
      }
    }

    const treeLines = [];
    const exclude = new Set(['.git', '.ralph', 'node_modules']);
    try {
      const topEntries = fs.readdirSync(rootDir, { withFileTypes: true });
      for (const entry of topEntries) {
        if (exclude.has(entry.name)) continue;
        if (entry.isDirectory()) {
          treeLines.push(`${entry.name}/`);
          try {
            const subEntries = fs.readdirSync(path.join(rootDir, entry.name), { withFileTypes: true });
            for (const sub of subEntries) {
              const name = sub.isDirectory() ? `${sub.name}/` : sub.name;
              treeLines.push(`  ${name}`);
            }
          } catch (_err) {
            treeLines.push(`  (unable to list)`);
          }
        } else {
          treeLines.push(entry.name);
        }
      }
    } catch (_err) {
      treeLines.push('(unable to list directory)');
    }

    const treeText = treeLines.join('\n');
    addSection('Directory tree (top 2 levels)', treeText);

    return parts.join('').slice(0, cap);
  } catch (_err) {
    return '';
  }
}

function validateStorySpec(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (typeof parsed.title !== 'string' || parsed.title.trim().length === 0) return false;
  // Case-insensitive check so planner output variations like "File 1" or
  // "## FILE 1" or "FILE 1:" all pass. The structural intent — at least
  // one FILE-N section — is what we're validating.
  if (typeof parsed.requirement !== 'string' || !/file\s*1/i.test(parsed.requirement)) return false;
  if (!Array.isArray(parsed.requested_paths) || parsed.requested_paths.length === 0) return false;
  if (!VALID_DIFFICULTIES.has(parsed.difficulty)) return false;
  if (typeof parsed.recommended_executor !== 'string' || parsed.recommended_executor.trim().length === 0) return false;
  if (typeof parsed.reasoning !== 'string' || parsed.reasoning.trim().length === 0) return false;
  return true;
}

function refineIdea({
  idea,
  rootDir,
  env = process.env,
  plannerModel = DEFAULT_PLANNER_MODEL,
  maxRetries = DEFAULT_MAX_RETRIES,
  spawn = require('node:child_process').spawnSync,
  now = () => new Date()
} = {}) {
  const trimmedIdea = typeof idea === 'string' ? idea.trim() : '';
  if (trimmedIdea.length === 0 || trimmedIdea.length > 2000) {
    return { ok: false, reason: 'idea_invalid' };
  }

  let prompt = PLANNER_PROMPT_TEMPLATE.replace('{IDEA}', trimmedIdea).replace('{REPO_CONTEXT}', buildRepoContext(rootDir));
  let retryCount = 0;
  let lastRawPreview = '';
  let lastStderrPreview = '';
  let lastExitCode = null;

  const maxAttempts = maxRetries + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      prompt = 'PREVIOUS RESPONSE WAS INVALID JSON. Return ONLY valid JSON this time.\n' + prompt;
      retryCount = attempt;
    }

    // Phase 3 #2 review: align with src/ralph/opencode-kimi-dispatcher.js's
    // invocation pattern — `--dir <cwd> <prompt>` as the trailing args.
    // The original draft used `--print` which is not a documented opencode
    // flag and would have caused planner_dispatch_failed in production.
    // The `--dir` argument anchors opencode at the project root rather
    // than process.cwd, matching how the executor dispatcher works.
    const result = spawn('opencode', ['run', '--model', plannerModel, '--format', 'json', '--dir', rootDir, prompt], {
      encoding: 'utf8',
      timeout: 120000,
      env
    });

    lastStderrPreview = (result.stderr || '').slice(0, 500);
    lastExitCode = result.status;
    lastRawPreview = (result.stdout || '').slice(0, 1000);

    if (result.error || result.status !== 0) {
      return {
        ok: false,
        reason: 'planner_dispatch_failed',
        stderr_preview: lastStderrPreview,
        exit_code: lastExitCode ?? (result.error ? -1 : undefined)
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout || '');
    } catch (_err) {
      if (attempt === maxAttempts - 1) {
        return {
          ok: false,
          reason: 'planner_invalid_response',
          last_raw_preview: lastRawPreview,
          retry_count: retryCount
        };
      }
      continue;
    }

    if (!validateStorySpec(parsed)) {
      if (attempt === maxAttempts - 1) {
        return {
          ok: false,
          reason: 'planner_invalid_response',
          last_raw_preview: lastRawPreview,
          retry_count: retryCount
        };
      }
      continue;
    }

    // Success path
    let ledgerEntry;
    try {
      const recordResult = recordKimiCall({
        rootDir,
        story_id: null,
        prompt_text: prompt,
        output_text: result.stdout,
        model: plannerModel,
        now: now()
      });
      ledgerEntry = recordResult.entry;
    } catch (_err) {
      ledgerEntry = { cost_usd: 0 };
    }

    return {
      ok: true,
      story_spec: {
        title: parsed.title,
        requirement: parsed.requirement,
        requested_paths: parsed.requested_paths,
        difficulty: parsed.difficulty,
        recommended_executor: parsed.recommended_executor,
        reasoning: parsed.reasoning
      },
      planner_cost_usd: ledgerEntry ? ledgerEntry.cost_usd : 0,
      planner_model: plannerModel,
      retry_count: retryCount,
      raw_preview: lastRawPreview
    };
  }

  // Should never reach here, but defensive fallback
  return {
    ok: false,
    reason: 'planner_invalid_response',
    last_raw_preview: lastRawPreview,
    retry_count: retryCount
  };
}

module.exports = {
  PLANNER_PROMPT_TEMPLATE,
  DEFAULT_PLANNER_MODEL,
  DEFAULT_MAX_RETRIES,
  refineIdea,
  buildRepoContext
};
