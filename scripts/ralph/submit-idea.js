#!/usr/bin/env node

const { refineIdea, DEFAULT_PLANNER_MODEL } = require('../../src/ralph/idea-refiner');
const { createStory } = require('../../src/ralph/story-queue');
const { loadMode: defaultLoadMode } = require('../../src/ralph/mode-manager');

function readStdinSync() {
  const fs = require('node:fs');
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return '';
  }
}

function parseArgs(argv) {
  const result = {
    idea: '',
    plannerModel: DEFAULT_PLANNER_MODEL,
    maxRetries: 1,
    mode: 'fullauto',
    target_env: 'local',
    yes: false,
    root: process.cwd(),
    dry_run: false
  };

  const positional = [];
  const startIndex = (argv.length >= 2 && String(argv[1] || '').includes('.js')) ? 2 : 0;
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--planner-model') {
      result.plannerModel = argv[++i] || DEFAULT_PLANNER_MODEL;
    } else if (arg === '--max-retries') {
      const n = Number(argv[++i]);
      result.maxRetries = Number.isFinite(n) ? n : 1;
    } else if (arg === '--mode') {
      result.mode = argv[++i] || 'fullauto';
    } else if (arg === '--target-env') {
      result.target_env = argv[++i] || 'local';
    } else if (arg === '--yes') {
      result.yes = true;
    } else if (arg === '--root') {
      result.root = argv[++i] || process.cwd();
    } else if (arg === '--dry-run') {
      result.dry_run = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  result.idea = positional.join(' ').trim();
  return result;
}

function buildStoryId(now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const rand = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `STORY-IDEA-${stamp}-${rand}`;
}

async function runSubmitIdea({ argv, stdin, stderr, stdout, exit, refineIdea, createStory, now, loadMode = defaultLoadMode }) {
  const args = parseArgs(argv);

  // Phase 4 #2: surface mode + expiry so the operator notices stuck-daemon risk BEFORE submitting.
  try {
    const modeState = loadMode(args.root);
    const nowMs = (now && now.getTime ? now.getTime() : Date.now());
    if (modeState && modeState.mode === 'fullauto') {
      const expiresMs = modeState.effective_until ? new Date(modeState.effective_until).getTime() : null;
      if (expiresMs && expiresMs < nowMs) {
        stderr(`⚠ Ralph mode: fullauto EXPIRED at ${modeState.effective_until}. The daemon will stop at the first approval gate.\n`);
        stderr(` Fix: node src/ralph/cli.js mode fullauto-request 1 2 && node src/ralph/cli.js mode fullauto-confirm <token> 1\n`);
      } else if (expiresMs) {
        const remainingMin = Math.max(0, Math.floor((expiresMs - nowMs) / 60000));
        if (remainingMin < 60) {
          stderr(`⚠ Ralph mode: fullauto (expires in ${remainingMin} min). Extend before the daemon stops at approval.\n`);
        } else {
          const remainingHr = Math.floor(remainingMin / 60);
          const restMin = remainingMin % 60;
          stderr(`Ralph mode: fullauto (expires in ${remainingHr}h ${restMin}m).\n`);
        }
      } else {
        stderr(`Ralph mode: fullauto (no expiry recorded).\n`);
      }
    } else {
      stderr(`⚠ Ralph mode: approval. The daemon will require manual approval after each step. Run mode fullauto-request to switch.\n`);
    }
  } catch (_err) {
    // Mode file unreadable — non-fatal; just stay silent.
  }

  // Determine idea source: positional args first, then stdin if argv empty
  let idea = args.idea;
  if (!idea && typeof stdin === 'string') {
    idea = stdin.trim();
  }

  if (!idea) {
    stderr('USAGE: node scripts/ralph/submit-idea.js [--planner-model <slug>] [--max-retries <n>] [--mode approval|fullauto] [--target-env <env>] [--yes] [--root <dir>] [--dry-run] <idea text>\n');
    stderr('       echo "idea text" | node scripts/ralph/submit-idea.js [...flags]\n');
    return exit(1);
  }

  const result = refineIdea({
    idea,
    rootDir: args.root,
    plannerModel: args.plannerModel,
    maxRetries: args.maxRetries
  });

  if (!result.ok) {
    stderr(JSON.stringify({ ok: false, reason: result.reason }) + '\n');
    return exit(2);
  }

  const storySpec = result.story_spec;

  // Structured preview to stderr
  stderr(`Title: ${storySpec.title}\n`);
  stderr(`Difficulty: ${storySpec.difficulty}\n`);
  stderr(`Executor: ${storySpec.recommended_executor}\n`);
  stderr(`Requested paths:\n`);
  for (const p of storySpec.requested_paths) {
    stderr(`  - ${p}\n`);
  }
  stderr(`Planner cost USD: ${result.planner_cost_usd}\n`);

  const isNonInteractive = args.yes || (typeof process !== 'undefined' && process.stdin && !process.stdin.isTTY);

  if (!isNonInteractive) {
    stderr('Proceed? [Y/n]: ');
    // Read a single line from stdin synchronously
    const answer = await new Promise((resolve) => {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk;
        const idx = buffer.indexOf('\n');
        if (idx !== -1) {
          process.stdin.off('data', onData);
          resolve(buffer.slice(0, idx).trim());
        }
      };
      process.stdin.on('data', onData);
      // Safety timeout
      setTimeout(() => {
        process.stdin.off('data', onData);
        resolve(buffer.trim());
      }, 30000);
    });

    const normalized = answer.toLowerCase();
    if (normalized !== '' && normalized !== 'y' && normalized !== 'yes') {
      stderr('Aborted by user\n');
      return exit(0);
    }
  }

  if (args.dry_run) {
    stdout(JSON.stringify(storySpec, null, 2) + '\n');
    return exit(0);
  }

  const storyId = buildStoryId(now);
  const createResult = createStory({
    story_id: storyId,
    title: storySpec.title,
    requirement: storySpec.requirement,
    requested_paths: storySpec.requested_paths,
    mode: args.mode,
    target_env: args.target_env,
    priority: 50,
    max_attempts: 3,
    executor_model: storySpec.recommended_executor,
    difficulty: storySpec.difficulty,
    planner_model: result.planner_model,
    planner_cost_usd: result.planner_cost_usd,
    risk: { score: 2, category: 'low', label: 'RISK_2_SOURCE_CODE' }
  }, { rootDir: args.root, now });

  if (!createResult.ok) {
    stderr(JSON.stringify({ ok: false, reason: createResult.reason, stage: createResult.stage }) + '\n');
    return exit(3);
  }

  stdout(JSON.stringify({ ok: true, story_id: storyId }) + '\n');
  return exit(0);
}

async function main() {
  const stdinText = readStdinSync();
  await runSubmitIdea({
    argv: process.argv.slice(2),
    stdin: stdinText,
    stderr: (msg) => process.stderr.write(msg),
    stdout: (msg) => process.stdout.write(msg),
    exit: (code) => process.exit(code),
    refineIdea,
    createStory,
    now: new Date()
  });
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildStoryId,
  runSubmitIdea,
  main,
  defaultLoadMode
};
