const fs = require('node:fs');
const path = require('node:path');
const { recordKimiCall } = require('./kimi-cost-tracker');

const PLANNER_PROMPT_TEMPLATE = `You are a PLANNING agent for an autonomous code-writing pipeline. Your job: take a vague human idea and produce a tight JSON story spec.

⚠️ CRITICAL — PLANNING ONLY:
- DO NOT write, edit, create, or delete any file. Do NOT use file-write tools, shell tools, or any side-effect tool. A different executor agent will implement the spec later. If you write files yourself, the executor cannot do its job and the patch is rejected.
- Your ONLY output is the JSON object below. Nothing else. No prose, no markdown fence, no "here is the file I created", no apology.
- If the idea says "create file X" / "modify file X" / etc., treat that as a description of what the EXECUTOR should do. You describe it in the JSON; you do NOT do it.

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

// Phase 3 E2E fix: opencode run --format json emits NDJSON (one JSON event
// per line: step_start, text, step_finish, etc.). The actual assistant text
// lives inside `text` events under `.part.text`, and may be wrapped in a
// ```json ... ``` markdown fence. extractPlannerJson handles both that
// streaming envelope AND the simpler "stdout is already pure JSON" case
// (which is what unit-test fake spawns return).
function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractPlannerJson(stdout) {
  if (stdout == null) return null;
  const raw = String(stdout).trim();
  if (raw.length === 0) return null;

  // Fast path: stdout is already a pure JSON object (test mocks, or future
  // opencode versions that emit non-streaming output).
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct) && typeof direct.title === 'string') {
      return direct;
    }
    // If direct parse succeeded but it doesn't look like a story spec, fall
    // through to streaming-envelope handling (it might have been a single
    // step_start event with no surrounding lines).
  } catch (_err) {
    // not pure JSON; fall through to NDJSON path
  }

  // Streaming-envelope path: concatenate text from every `type:"text"` event.
  const textChunks = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const event = JSON.parse(t);
      if (event && event.type === 'text' && event.part && typeof event.part.text === 'string') {
        textChunks.push(event.part.text);
      }
    } catch (_err) {
      // Skip non-JSON lines.
    }
  }

  if (textChunks.length === 0) return null;
  const assembled = stripCodeFence(textChunks.join(''));
  try {
    return JSON.parse(assembled);
  } catch (_err) {
    return null;
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

// Phase 4 #2.1: when the planner is invoked with --dir=rootDir, an unruly
// model can use opencode's file-write tool to literally create the files
// the idea describes — leaving orphan files in the project worktree that
// then break the executor's CREATE-vs-MODIFY-EXISTING classification.
// Phase 4 PR_REVIEW smoke caught this with idea text 'Create a new file
// docs/...'. Defense-in-depth: (1) prompt explicitly forbids file writes,
// (2) point --dir at a throwaway tmpdir so any rogue writes are isolated
// and discarded.
function makePlannerSandboxDir(now = new Date()) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15);
  return fs.mkdtempSync(path.join(os.tmpdir(), `ralph-planner-${stamp}-`));
}

function cleanupPlannerSandboxDir(dir) {
  if (!dir) return;
  try {
    const fs = require('node:fs');
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) { /* best-effort */ }
}

function refineIdea({
  idea,
  rootDir,
  env = process.env,
  plannerModel = DEFAULT_PLANNER_MODEL,
  maxRetries = DEFAULT_MAX_RETRIES,
  spawn = require('node:child_process').spawnSync,
  now = () => new Date(),
  // Phase 4 #2.1: injectable for tests — production uses tmpdir.
  makeSandboxDir = makePlannerSandboxDir,
  cleanupSandboxDir = cleanupPlannerSandboxDir
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

  // Phase 4 #2.1: isolated --dir so a rogue planner cannot pollute the
  // project worktree by writing files via opencode tools. The planner
  // only needs repo *context*, which is already inlined into the prompt
  // via buildRepoContext above.
  const plannerSandbox = makeSandboxDir(now());

  const maxAttempts = maxRetries + 1;

  try {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      prompt = 'PREVIOUS RESPONSE WAS INVALID JSON. Return ONLY valid JSON this time.\n' + prompt;
      retryCount = attempt;
    }

    // Phase 3 #2 review: align with src/ralph/opencode-kimi-dispatcher.js's
    // invocation pattern — `--dir <cwd> <prompt>` as the trailing args.
    // Phase 4 #2.1: --dir points at an isolated tmpdir (plannerSandbox),
    // not rootDir. The planner only emits JSON; it must never write files
    // into the project tree. The sandbox is rm'd after the call returns
    // (best-effort, see cleanupSandboxDir).
    const result = spawn('opencode', ['run', '--model', plannerModel, '--format', 'json', '--dir', plannerSandbox, prompt], {
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

    // Phase 3 E2E fix: opencode emits NDJSON; extractPlannerJson handles
    // both the streaming envelope and the legacy pure-JSON shape used by
    // unit-test fake spawns.
    const parsed = extractPlannerJson(result.stdout);
    if (parsed == null) {
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
  } finally {
    cleanupSandboxDir(plannerSandbox);
  }
}

module.exports = {
  PLANNER_PROMPT_TEMPLATE,
  DEFAULT_PLANNER_MODEL,
  DEFAULT_MAX_RETRIES,
  refineIdea,
  buildRepoContext,
  extractPlannerJson,
  stripCodeFence,
  makePlannerSandboxDir,
  cleanupPlannerSandboxDir
};
