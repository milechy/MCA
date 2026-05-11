const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildNemoClawPolicy, sanitizeGatewayResult, NEMOCLAW_ACTIONS, redactText } = require('./nemoclaw-policy');
const { defaultExternalAgentJobId, writeExternalAgentJob } = require('./external-agent-jobs');

const DEFAULT_TIMEOUT_MS = 60000;
const NEMOCLAW_COMMAND = 'nemoclaw';
const OPENSHELL_COMMAND = 'openshell';
const NEMOCLAW_SANDBOX_ENV = 'NEMOCLAW_SANDBOX_NAME';
const DEFAULT_NEMOCLAW_SANDBOX = 'mca-ralph';
const DEFAULT_OPENCLAW_SESSION_ID = 'ralph-opencode-candidate-patch';
const UNSUPPORTED_CANDIDATE_PATCH_REASON = 'nemoclaw_candidate_patch_command_unavailable';
const MAX_CONTEXT_FILE_CHARS = 4000;
const MAX_CONTEXT_TOTAL_CHARS = 12000;

function ensureSandboxDir(rootDir, sandboxRoot) {
  const resolved = path.resolve(rootDir, sandboxRoot);
  const expectedPrefix = path.resolve(rootDir, '.ralph', 'tmp');
  if (!resolved.startsWith(expectedPrefix)) return null;
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function buildNemoClawArgs({ task, candidate_patch_path, requested_paths }) {
  return ['opencode', 'run-candidate-patch', '--candidate-patch', 'candidate.patch', '--requested-paths', requested_paths.join(','), '--task', task];
}

function runtimeInstalled(command = NEMOCLAW_COMMAND, { spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(command, ['--version'], { encoding: 'utf8', env: { PATH: env.PATH, HOME: env.HOME }, timeout: 5000, maxBuffer: 1024 * 8 });
  return !(result.error && result.error.code === 'ENOENT');
}

function commandPreview(command, args = []) {
  return [command, ...args].map((item) => redactText(item, 120)).join(' ');
}

function boundedOutput(value, maxLength = 600) {
  return redactText(String(value || ''), maxLength);
}

function candidatePatchCommandAvailable(command = OPENSHELL_COMMAND, { spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(command, ['sandbox', 'exec', '--help'], { encoding: 'utf8', env: { PATH: env.PATH, HOME: env.HOME }, timeout: 5000, maxBuffer: 1024 * 16 });
  if (result.error && result.error.code === 'ENOENT') return { ok: false, reason: 'openshell_runtime_not_installed', stdout_preview: '', stderr_preview: boundedOutput(result.error.message || '') };
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/Execute a command in a running sandbox/i.test(text) || /sandbox exec/i.test(text)) return { ok: true, reason: null, stdout_preview: boundedOutput(result.stdout || ''), stderr_preview: boundedOutput(result.stderr || '') };
  return { ok: false, reason: UNSUPPORTED_CANDIDATE_PATCH_REASON, stdout_preview: boundedOutput(result.stdout || ''), stderr_preview: boundedOutput(result.stderr || '') };
}

function sandboxNameFromEnv(env = process.env) {
  return String(env[NEMOCLAW_SANDBOX_ENV] || env.OPENSHELL_SANDBOX_NAME || DEFAULT_NEMOCLAW_SANDBOX).trim() || DEFAULT_NEMOCLAW_SANDBOX;
}

function safeRequestedPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null;
  return normalized;
}

function pathExistsInRepo(rootDir, filePath) {
  const safePath = safeRequestedPath(filePath);
  if (!safePath) return false;
  const absolute = path.resolve(rootDir, safePath);
  if (!absolute.startsWith(path.resolve(rootDir))) return false;
  try { return fs.statSync(absolute).isFile(); } catch { return false; }
}

function escapeNewlinesForArg(value) {
  return String(value || '').replace(/\r\n/g, '\\n').replace(/[\r\n]/g, '\\n');
}

function buildRequestedFileContext({ rootDir = process.cwd(), requested_paths = [] } = {}) {
  const chunks = [];
  let total = 0;
  for (const requestedPath of requested_paths) {
    const safePath = safeRequestedPath(requestedPath);
    if (!safePath) continue;
    const absolutePath = path.resolve(rootDir, safePath);
    if (!absolutePath.startsWith(path.resolve(rootDir))) continue;
    let content;
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile() || stat.size > 1024 * 256) continue;
      content = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      content = '';
    }
    const bounded = content.length > MAX_CONTEXT_FILE_CHARS ? `${content.slice(0, MAX_CONTEXT_FILE_CHARS)}\n[TRUNCATED]\n` : content;
    const chunk = [`--- FILE ${safePath} ---`, bounded || '[missing or empty]', `--- END FILE ${safePath} ---`].join('\n');
    if (total + chunk.length > MAX_CONTEXT_TOTAL_CHARS) break;
    chunks.push(chunk);
    total += chunk.length;
  }
  return chunks.join('\n\n');
}

function buildOpenClawCandidatePatchPrompt({ task, requested_paths = [], file_context = '' }) {
  const paths = requested_paths.length ? requested_paths.join(', ') : '(no requested paths supplied)';
  return [
    'You are OpenCode running inside a NemoClaw/OpenShell sandbox under Ralph control.',
    'Produce a candidate.patch for review only.',
    'Output contract: candidate.patch must exist in the current working directory, or your reply must contain a unified git diff. Any prose-only response is invalid.',
    'Preferred: create exactly one file named candidate.patch in the current working directory.',
    'Fallback: if file writing is unavailable, reply with a unified git diff only. Prefer including a diff --git header.',
    'For existing files in bounded file context, never use /dev/null as the old file; emit a context diff against the supplied content.',
    'Use the bounded file context below as the repository source of truth. Do not claim you read files from the sandbox unless they are included below.',
    'Do not apply the patch. Do not commit. Do not push. Do not create a PR. Do not deploy. Do not run migrations. Do not print secrets or raw logs.',
    `Requested paths: ${paths}`,
    `Task: ${String(task || '').slice(0, 4000)}`,
    file_context ? `Bounded file context:\n${file_context}` : 'Bounded file context: (none supplied)',
    'When finished, output only candidate.patch content or a short bounded status if the file was written.'
  ].join('\n');
}

function buildOpenClawDiffOnlyPrompt({ task, requested_paths = [], file_context = '' }) {
  const paths = requested_paths.length ? requested_paths.join(', ') : '(no requested paths supplied)';
  return [
    'Return ONLY a unified git diff. No prose. No markdown fence.',
    'The first line must begin with: diff --git',
    `Allowed paths: ${paths}`,
    `Task: ${String(task || '').slice(0, 4000)}`,
    file_context ? `File context:\n${file_context}` : 'File context: files may be missing or empty.',
    'Do not apply, commit, push, create a PR, deploy, run migrations, or print secrets.'
  ].join('\n');
}

function buildOpenShellAgentArgs({ sandbox_name, task, requested_paths = [], timeout_ms = DEFAULT_TIMEOUT_MS, file_context = '', session_id = DEFAULT_OPENCLAW_SESSION_ID, diff_only = false }) {
  const seconds = String(Math.max(1, Math.ceil(timeout_ms / 1000)));
  const prompt = diff_only
    ? buildOpenClawDiffOnlyPrompt({ task, requested_paths, file_context })
    : buildOpenClawCandidatePatchPrompt({ task, requested_paths, file_context });
  return ['sandbox', 'exec', '-n', sandbox_name, '--workdir', '/sandbox', '--timeout', seconds, '--no-tty', '--', 'openclaw', 'agent', '--session-id', session_id, '--message', escapeNewlinesForArg(prompt), '--json', '--timeout', seconds];
}

function buildOpenShellCatArgs({ sandbox_name }) {
  return ['sandbox', 'exec', '-n', sandbox_name, '--workdir', '/sandbox', '--timeout', '30', '--no-tty', '--', 'cat', 'candidate.patch'];
}

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:diff|patch)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function collectJsonStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectJsonStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectJsonStrings(item, output));
  return output;
}

function normalizePatchPath(filePath) {
  return String(filePath || '').replace(/^a\//, '').replace(/^b\//, '').replace(/^\/dev\/null$/, '').trim();
}

function synthesizeGitHeaderForUnifiedDiff(diff) {
  const text = String(diff || '').trim();
  if (!/^--- /m.test(text) || !/^\+\+\+ /m.test(text)) return '';
  if (/^diff --git /m.test(text)) return `${text}\n`;
  const oldLine = text.match(/^---\s+(\S+)/m);
  const newLine = text.match(/^\+\+\+\s+(\S+)/m);
  const oldPath = normalizePatchPath(oldLine && oldLine[1]);
  const newPath = normalizePatchPath(newLine && newLine[1]);
  const target = newPath || oldPath;
  if (!target || target.startsWith('/') || target.includes('..')) return '';
  return `diff --git a/${target} b/${target}\n${text}\n`;
}

function extractUnifiedDiffFromText(text) {
  const raw = String(text || '');
  const candidates = [raw];
  try { candidates.push(...collectJsonStrings(JSON.parse(raw))); } catch {}
  for (const candidate of candidates) {
    const stripped = stripCodeFence(candidate);
    const gitIndex = stripped.indexOf('diff --git ');
    if (gitIndex !== -1) {
      const diff = stripped.slice(gitIndex).trim();
      if (/^diff --git /m.test(diff) && /^--- /m.test(diff) && /^\+\+\+ /m.test(diff)) return `${diff}\n`;
    }
    const oldIndex = stripped.search(/^---\s+/m);
    if (oldIndex !== -1) {
      const normalized = synthesizeGitHeaderForUnifiedDiff(stripped.slice(oldIndex));
      if (normalized) return normalized;
    }
  }
  return '';
}

function validPatchText(text) {
  const patch = String(text || '');
  return /^diff --git /m.test(patch) && /^--- /m.test(patch) && /^\+\+\+ /m.test(patch) && !/^```/m.test(patch.trim());
}

function parsePatchFileSections(patchText) {
  const lines = String(patchText || '').split(/\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const diff = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
    if (diff) {
      current = { a_path: normalizePatchPath(diff[1]), b_path: normalizePatchPath(diff[2]), old_path: null, new_path: null, old_is_null: false, new_is_null: false };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const oldLine = line.match(/^---\s+(\S+)/);
    if (oldLine) {
      current.old_is_null = oldLine[1] === '/dev/null';
      current.old_path = normalizePatchPath(oldLine[1]);
      continue;
    }
    const newLine = line.match(/^\+\+\+\s+(\S+)/);
    if (newLine) {
      current.new_is_null = newLine[1] === '/dev/null';
      current.new_path = normalizePatchPath(newLine[1]);
    }
  }
  return sections;
}

function validateCandidatePatchAgainstRepository({ rootDir = process.cwd(), patchText, requested_paths = [] } = {}) {
  if (!validPatchText(patchText)) return { ok: false, reason: 'candidate_patch_invalid' };
  const requested = new Set(requested_paths.map(safeRequestedPath).filter(Boolean));
  for (const section of parsePatchFileSections(patchText)) {
    const target = section.new_path || section.b_path || section.old_path || section.a_path;
    if (!target || target.startsWith('/') || target.includes('..')) return { ok: false, reason: 'candidate_patch_path_forbidden', path: target || null };
    if (requested.size > 0 && !requested.has(target)) return { ok: false, reason: 'candidate_patch_unrequested_path', path: target };
    if (section.old_is_null && pathExistsInRepo(rootDir, target)) return { ok: false, reason: 'candidate_patch_existing_file_marked_new', path: target };
  }
  return { ok: true, reason: null };
}

function outputLooksRateLimited(outputText = '') {
  return /rate limit|ratelimit|too many requests|quota exceeded|resource exhausted|429/i.test(String(outputText || ''));
}

function classifyNemoClawFailureReason({ timedOut = false, ok = false, patchLooksValid = false, patchValidation = {}, catExitCode = null, stdoutPatchText = '', outputText = '' } = {}) {
  if (ok) return null;
  if (outputLooksRateLimited(outputText)) return 'provider_rate_limited';
  if (timedOut) return 'nemoclaw_runtime_timeout';
  if (patchLooksValid && patchValidation && patchValidation.ok === false) return patchValidation.reason || 'candidate_patch_invalid';
  if (catExitCode !== 0 && !stdoutPatchText) return 'candidate_patch_missing';
  if (!patchLooksValid) return 'candidate_patch_invalid';
  return 'nemoclaw_runtime_failed';
}

function nextActionForNemoClawFailure(reason) {
  if (reason === 'provider_rate_limited') return 'retry_after_provider_rate_limit';
  if (reason === 'candidate_patch_missing') return 'retry_after_agent_output_contract_violation';
  if (reason === 'candidate_patch_invalid') return 'repair_agent_candidate_patch_output';
  return 'fix_nemoclaw_gateway_failure';
}

function makeBase(overrides = {}) {
  return { ok: false, stage: 'nemoclaw_opencode_gateway', reason: null, mediator: 'nemoclaw', opencode_runtime_mode: 'nemoclaw-mediated', gateway_type: 'nemoclaw', gateway_name: 'nemoclaw', job_id: null, approval_id: null, sandbox_root: null, candidate_patch_path: null, command_preview: null, exit_code: null, stdout_preview: '', stderr_preview: '', duration_ms: 0, timeout_ms: DEFAULT_TIMEOUT_MS, runtime_installed: false, candidate_patch_command_available: false, execution_connected: false, real_gateway_process_started: false, opencode_execution_started: false, apply_allowed: false, commit_allowed: false, push_allowed: false, pr_allowed: false, merge_allowed: false, deploy_allowed: false, migration_allowed: false, unrestricted_shell_allowed: false, raw_log_allowed: false, secret_display_allowed: false, secret_persistence_allowed: false, bounded_metadata_only: true, commands_executed: [], files_modified: [], repository_files_modified: [], job: null, next_action: 'fix_nemoclaw_gateway_failure', ...overrides };
}

function writeGatewayJob(rootDir, result, { task_preview, started_at, finished_at, status }) {
  if (!result.job_id) return result;
  const written = writeExternalAgentJob(rootDir, { job_id: result.job_id, status, approval_id: result.approval_id, gateway_type: 'nemoclaw', gateway_name: 'nemoclaw', sandbox_root: result.sandbox_root, candidate_patch_path: result.candidate_patch_path, task_preview, started_at, updated_at: finished_at, finished_at, exit_code: result.exit_code, stdout_preview: result.stdout_preview, stderr_preview: result.stderr_preview, execution_connected: result.execution_connected, real_gateway_process_started: result.real_gateway_process_started, commands_executed: result.commands_executed, files_modified: result.files_modified, next_action: result.next_action });
  return { ...result, job: written.ok ? written.summary : null };
}

function runOpenShellAgentAttempt({ spawn, cwd, env, args, timeout_ms }) {
  return spawn(OPENSHELL_COMMAND, args, { cwd, env: { PATH: env.PATH, HOME: env.HOME, CI: env.CI, OPENSHELL_GATEWAY: env.OPENSHELL_GATEWAY || 'nemoclaw' }, encoding: 'utf8', timeout: timeout_ms, maxBuffer: 1024 * 256 });
}

function runOpenShellCatAttempt({ spawn, cwd, env, args }) {
  return spawn(OPENSHELL_COMMAND, args, { cwd, env: { PATH: env.PATH, HOME: env.HOME, CI: env.CI, OPENSHELL_GATEWAY: env.OPENSHELL_GATEWAY || 'nemoclaw' }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 256 });
}

function resultOutput(result = {}) {
  return `${result.stdout || ''}\n${result.stderr || result.error?.message || ''}`;
}

function runNemoClawOpenCodeCandidatePatch({ rootDir = process.cwd(), approval_id = null, job_id, sandbox_root, requested_paths = [], task, command = NEMOCLAW_COMMAND, args = null, env = process.env, timeout_ms = DEFAULT_TIMEOUT_MS, spawn = spawnSync, now = () => new Date(), record_job = true } = {}) {
  const allocatedJobId = job_id || defaultExternalAgentJobId(now());
  const policyArgs = args || buildNemoClawArgs({ task, candidate_patch_path: 'candidate.patch', requested_paths });
  const policy = buildNemoClawPolicy({ action: NEMOCLAW_ACTIONS.RUN_CANDIDATE_PATCH, sandbox_root, requested_paths, task, args: policyArgs });
  if (!policy.ok) return makeBase({ job_id: allocatedJobId, approval_id, reason: policy.reason, sandbox_root, timeout_ms });
  if (command !== NEMOCLAW_COMMAND) return makeBase({ job_id: allocatedJobId, approval_id, reason: 'nemoclaw_command_required', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const cwd = ensureSandboxDir(rootDir, policy.sandbox_root);
  if (!cwd) return makeBase({ job_id: allocatedJobId, approval_id, reason: 'sandbox_root_not_allowed', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });
  const candidateAbs = path.join(cwd, 'candidate.patch');
  try { fs.rmSync(candidateAbs, { force: true }); } catch {}

  const installed = runtimeInstalled(command, { spawn, env });
  if (!installed) return makeBase({ job_id: allocatedJobId, approval_id, reason: 'nemoclaw_runtime_not_installed', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, runtime_installed: false, timeout_ms, next_action: 'install_nemoclaw_or_use_approved_dev_only_direct_path' });

  const availability = candidatePatchCommandAvailable(OPENSHELL_COMMAND, { spawn, env });
  if (!availability.ok) return makeBase({ job_id: allocatedJobId, approval_id, reason: availability.reason || UNSUPPORTED_CANDIDATE_PATCH_REASON, sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, stdout_preview: availability.stdout_preview || '', stderr_preview: availability.stderr_preview || '', runtime_installed: true, candidate_patch_command_available: false, execution_connected: false, timeout_ms, next_action: 'install_openshell_or_configure_nemoclaw_sandbox' });

  const sandboxName = sandboxNameFromEnv(env);
  const fileContext = buildRequestedFileContext({ rootDir, requested_paths });
  const agentArgs = buildOpenShellAgentArgs({ sandbox_name: sandboxName, task, requested_paths, timeout_ms, file_context: fileContext });
  const retryAgentArgs = buildOpenShellAgentArgs({ sandbox_name: sandboxName, task, requested_paths, timeout_ms, file_context: fileContext, session_id: `${DEFAULT_OPENCLAW_SESSION_ID}-retry`, diff_only: true });
  const catArgs = buildOpenShellCatArgs({ sandbox_name: sandboxName });
  const started = now();
  const commands = [commandPreview(OPENSHELL_COMMAND, agentArgs), commandPreview(OPENSHELL_COMMAND, catArgs)];
  if (record_job) writeExternalAgentJob(rootDir, { job_id: allocatedJobId, status: 'running', approval_id, gateway_type: 'nemoclaw', gateway_name: 'nemoclaw', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, task_preview: policy.task_preview, started_at: started.toISOString(), updated_at: started.toISOString(), execution_connected: true, real_gateway_process_started: true, commands_executed: commands, next_action: 'openshell_openclaw_candidate_patch_running' });

  const runResult = runOpenShellAgentAttempt({ spawn, cwd, env, args: agentArgs, timeout_ms });
  const catResult = runOpenShellCatAttempt({ spawn, cwd, env, args: catArgs });
  let retryResult = null;
  let retryCatResult = null;
  const firstCombinedOutput = `${resultOutput(runResult)}\n${resultOutput(catResult)}`;
  const firstTimedOut = (runResult.error && runResult.error.code === 'ETIMEDOUT') || (catResult.error && catResult.error.code === 'ETIMEDOUT');
  const firstPatchText = validPatchText(catResult.stdout || '') ? String(catResult.stdout || '') : extractUnifiedDiffFromText(runResult.stdout || '');
  if (!firstPatchText && !firstTimedOut && !outputLooksRateLimited(firstCombinedOutput)) {
    try { fs.rmSync(candidateAbs, { force: true }); } catch {}
    retryResult = runOpenShellAgentAttempt({ spawn, cwd, env, args: retryAgentArgs, timeout_ms });
    retryCatResult = runOpenShellCatAttempt({ spawn, cwd, env, args: catArgs });
    commands.push(commandPreview(OPENSHELL_COMMAND, retryAgentArgs), commandPreview(OPENSHELL_COMMAND, catArgs));
  }

  const finished = now();
  const allRunResults = [runResult, retryResult].filter(Boolean);
  const allCatResults = [catResult, retryCatResult].filter(Boolean);
  const timedOut = allRunResults.concat(allCatResults).some((result) => result && result.error && result.error.code === 'ETIMEDOUT');
  const lastRunResult = retryResult || runResult;
  const lastCatResult = retryCatResult || catResult;
  const exitCode = typeof lastRunResult.status === 'number' ? lastRunResult.status : null;
  const catExitCode = typeof lastCatResult.status === 'number' ? lastCatResult.status : null;
  const stdoutPatchText = allRunResults.map((result) => extractUnifiedDiffFromText(result.stdout || '')).find(Boolean) || '';
  const catPatchText = allCatResults.map((result) => String(result.stdout || '')).find((text) => validPatchText(text)) || '';
  const patchText = validPatchText(catPatchText) ? catPatchText : stdoutPatchText;
  const patchSource = validPatchText(catPatchText) ? 'sandbox_file' : stdoutPatchText ? (retryResult ? 'agent_stdout_retry' : 'agent_stdout') : null;
  const patchLooksValid = validPatchText(patchText);
  const patchValidation = patchLooksValid ? validateCandidatePatchAgainstRepository({ rootDir, patchText, requested_paths }) : { ok: false, reason: 'candidate_patch_invalid' };
  if (patchLooksValid && patchValidation.ok) fs.writeFileSync(candidateAbs, patchText);
  const ok = exitCode === 0 && !timedOut && patchLooksValid && patchValidation.ok;
  const combinedOutput = allRunResults.concat(allCatResults).map(resultOutput).join('\n');
  const reason = classifyNemoClawFailureReason({ timedOut, ok, patchLooksValid, patchValidation, catExitCode, stdoutPatchText, outputText: combinedOutput });
  const raw = makeBase({ ok, reason, job_id: allocatedJobId, approval_id, sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, command_preview: commandPreview(OPENSHELL_COMMAND, retryResult ? retryAgentArgs : agentArgs), exit_code: exitCode, stdout_preview: allRunResults.concat(allCatResults).map((result) => result.stdout || '').join('\n'), stderr_preview: allRunResults.concat(allCatResults).map((result) => result.stderr || result.error?.message || '').join('\n'), duration_ms: Math.max(0, finished.getTime() - started.getTime()), timeout_ms, runtime_installed: true, candidate_patch_command_available: true, execution_connected: true, real_gateway_process_started: true, opencode_execution_started: true, retry_attempted: Boolean(retryResult), patch_source: patchSource, patch_validation: patchValidation, commands_executed: commands, files_modified: ok ? [policy.candidate_patch_path] : [], repository_files_modified: [], next_action: ok ? 'preview_candidate_patch_before_apply' : nextActionForNemoClawFailure(reason) });
  const safe = sanitizeGatewayResult(raw, policy);
  if (!record_job) return safe;
  return writeGatewayJob(rootDir, safe, { task_preview: policy.task_preview, started_at: started.toISOString(), finished_at: finished.toISOString(), status: ok ? 'completed' : 'failed' });
}

module.exports = { DEFAULT_TIMEOUT_MS, NEMOCLAW_COMMAND, OPENSHELL_COMMAND, NEMOCLAW_SANDBOX_ENV, DEFAULT_NEMOCLAW_SANDBOX, DEFAULT_OPENCLAW_SESSION_ID, UNSUPPORTED_CANDIDATE_PATCH_REASON, MAX_CONTEXT_FILE_CHARS, MAX_CONTEXT_TOTAL_CHARS, ensureSandboxDir, buildNemoClawArgs, runtimeInstalled, candidatePatchCommandAvailable, sandboxNameFromEnv, escapeNewlinesForArg, buildRequestedFileContext, buildOpenClawCandidatePatchPrompt, buildOpenClawDiffOnlyPrompt, buildOpenShellAgentArgs, buildOpenShellCatArgs, synthesizeGitHeaderForUnifiedDiff, extractUnifiedDiffFromText, validPatchText, parsePatchFileSections, validateCandidatePatchAgainstRepository, classifyNemoClawFailureReason, nextActionForNemoClawFailure, commandPreview, runNemoClawOpenCodeCandidatePatch };
