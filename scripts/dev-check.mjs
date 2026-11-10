#!/usr/bin/env node
/**
 * dev-check — the one local entry point for checks in this repo (holodeck-sdk).
 *
 *   scripts/dev-check.sh [fast|push|full] [--base <ref>] [--list] [--e2e]
 *
 * Tiers (see TESTING.md and ~/dev/hyperdrive/.agents/plans/dev-loop-shift-left.md):
 *   fast  (L1, pre-push hook) only the steps the diff selects
 *   push  (L2, before a PR/review) every step except the build/dist ones
 *   full  (L3, before merging a minor PR) every step PR CI runs (test.yml), whatever the diff
 *
 * The diff is HEAD + staged + unstaged + untracked-not-ignored files against the merge-base of
 * HEAD and `--base` (default origin/main). Fail closed: a changed file no rule owns selects the
 * whole `push` set; a toolchain / lockfile / workflow / root-config change selects `full`; an
 * unreadable diff selects `full`.
 *
 * The last line printed is exactly
 *   dev-check: <mode> PASS|FAIL in <N>s — <step>=<passed count or ok|FAIL>; …
 * and every run (not --list) writes .dev-check/last.json, which
 * ~/dev/hyperdrive/scripts/ci-local-status.sh reads to post `ci/local`.
 *
 * Single source of truth with CI: scripts/dev-check.test.mjs pins that every `run:` command in
 * .github/workflows/test.yml is a `full` step here (same directory, same command) and vice versa.
 *
 * The repo-specific part is STEPS + RULES below; the rest is shared in shape with
 * wormhole/scripts/dev-check.mjs (keep the two runners in step when changing one).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MODES = ['fast', 'push', 'full'];

/**
 * Every check this repo has, in run order.
 * - cwd: directory relative to the repo root (CI: the job's working-directory).
 * - fullOnly: skipped by `push` (build/dist steps; `full` and a selecting diff still run them).
 * - ci: false = local-only (not in test.yml); the pin test exempts it.
 * - install: the dependency install; run only when needed (see needsInstall).
 */
export const STEPS = [
  { name: 'install', cwd: 'ts', command: 'pnpm install --frozen-lockfile', install: true },
  { name: 'typecheck', cwd: 'ts', command: 'pnpm type-check' },
  { name: 'test', cwd: 'ts', command: 'pnpm exec vitest run' },
  { name: 'schema', cwd: 'ts', command: 'pnpm run validate:schema' },
  { name: 'dev-check-selftest', cwd: '.', command: 'node --test "scripts/*.test.mjs"' },
  { name: 'build', cwd: 'ts', command: 'pnpm build', fullOnly: true },
  { name: 'smoke-dist', cwd: 'ts', command: 'pnpm run smoke:dist', fullOnly: true },
];

/**
 * Path rules, first match wins. `escalate: 'full'` = the change can affect everything
 * (toolchain, lockfile, workflows, package/tool config). `select: []` = inert (nothing reads it).
 * A path matching no rule is unowned and selects the whole `push` set (fail closed).
 */
export const RULES = [
  { pattern: /^\.github\/workflows\//, escalate: 'full', why: 'CI workflow' },
  { pattern: /^\.node-version$/, escalate: 'full', why: 'Node toolchain pin' },
  { pattern: /^ts\/(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/, escalate: 'full', why: 'dependencies / lockfile' },
  { pattern: /^ts\/(tsconfig[^/]*\.json|vitest\.config\.ts)$/, escalate: 'full', why: 'TypeScript / Vitest config' },
  { pattern: /^ts\/src\//, select: ['typecheck', 'test'], why: 'package source or test' },
  { pattern: /^ts\/scripts\/smoke-dist\.mjs$/, select: ['build', 'smoke-dist'], why: 'dist smoke test' },
  // package.test.ts validates the schema and every example manifest too.
  { pattern: /^(schema|examples)\//, select: ['schema', 'test'], why: 'JSON schema / example manifest' },
  // docs.test.ts pins docs/PACKAGING.md §7 against the flow runtime.
  { pattern: /^docs\//, select: ['test'], why: 'docs read by docs.test.ts' },
  { pattern: /^(scripts|\.githooks)\//, select: ['dev-check-selftest'], why: 'dev tooling' },
  { pattern: /^[^/]+\.md$/, select: [], why: 'top-level Markdown' },
  { pattern: /^(LICENSE|\.gitignore)$/, select: [], why: 'inert' },
  { pattern: /^\.github\/(CODEOWNERS|dependabot\.yml|actionlint\.yaml)$/, select: [], why: 'inert GitHub config' },
];

/**
 * The install step runs only when node_modules is missing or older than the lockfile: pnpm
 * rewrites INSTALL_MARKER on every install, so a lockfile edited (or checked out) after the
 * last install is newer than it.
 */
const INSTALL_MARKER = 'ts/node_modules/.modules.yaml';
const INSTALL_INPUT = 'ts/pnpm-lock.yaml';

/** @returns {string | undefined} why an install is needed, or undefined when node_modules is current */
export function installReason(root = REPO_ROOT) {
  const marker = join(root, INSTALL_MARKER);
  if (!existsSync(marker)) return `${INSTALL_MARKER} missing`;
  if (statSync(join(root, INSTALL_INPUT)).mtimeMs > statSync(marker).mtimeMs) return `${INSTALL_INPUT} is newer than the last install`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Pure planning logic (unit-tested in dev-check.test.mjs).
// ---------------------------------------------------------------------------------------------

/** @returns {{ mode: string, base: string, list: boolean, e2e: boolean }} */
export function parseArgs(argv) {
  const out = { mode: 'fast', base: 'origin/main', list: false, e2e: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (MODES.includes(arg)) out.mode = arg;
    else if (arg === '--list') out.list = true;
    else if (arg === '--e2e') out.e2e = true;
    else if (arg === '--base') {
      if (!argv[i + 1]) throw new Error('--base needs a ref');
      out.base = argv[++i];
    } else if (arg.startsWith('--base=')) out.base = arg.slice('--base='.length);
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg} (usage: dev-check.sh [fast|push|full] [--base <ref>] [--list] [--e2e])`);
  }
  return out;
}

/** Classifies one changed path. */
export function classify(file) {
  const rule = RULES.find((r) => r.pattern.test(file));
  if (!rule) return { kind: 'unowned', select: [], why: 'no rule owns it' };
  if (rule.escalate) return { kind: 'full', select: [], why: rule.why };
  return { kind: rule.select.length ? 'owned' : 'inert', select: rule.select, why: rule.why };
}

const RANK = { fast: 0, push: 1, full: 2 };

/**
 * Decides what to run.
 * @param {{ mode: string, changed: string[] | null, install?: string }} input
 *   changed: changed paths, or null when the diff could not be read (fail closed → full).
 *   install: why node_modules needs an install (adds the install step), if it does.
 * @returns {{ mode: string, requested: string, reasons: string[], nothingChanged: boolean,
 *   steps: Array<typeof STEPS[number] & { why: string }> }}
 */
export function plan({ mode, changed, install }) {
  const reasons = [];
  let effective = mode;
  const escalate = (to, reason) => {
    reasons.push(reason);
    if (RANK[to] > RANK[effective]) effective = to;
  };
  /** step name → first reason it was selected */
  const selected = new Map();
  const select = (name, why) => {
    if (!selected.has(name)) selected.set(name, why);
  };

  if (changed === null) escalate('full', 'could not read the diff: full (fail closed)');
  const files = changed ?? [];
  const nothingChanged = changed !== null && files.length === 0;

  for (const file of files) {
    const c = classify(file);
    if (c.kind === 'full') escalate('full', `${file}: ${c.why} → full`);
    else if (c.kind === 'unowned') escalate('push', `${file}: ${c.why} → push (fail closed)`);
    for (const name of c.select) select(name, `${file} (${c.why})`);
  }

  const steps = [];
  for (const step of STEPS) {
    let why;
    if (step.install) why = install;
    else if (effective === 'full') why = selected.get(step.name) ?? 'full: every CI step';
    else if (effective === 'push') why = step.fullOnly ? selected.get(step.name) : (selected.get(step.name) ?? 'push: every non-build step');
    else why = selected.get(step.name);
    if (why) steps.push({ ...step, why });
  }
  // fast/push with no change at all: nothing to do. `full` always runs (it is the merge gate).
  if (nothingChanged && effective !== 'full') return { mode: effective, requested: mode, reasons, nothingChanged, steps: [] };
  return { mode: effective, requested: mode, reasons, nothingChanged, steps };
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Passed-test count from a step's output, or null when it printed none. Sums every summary
 * line, so recursive (`pnpm -r`) runs and multi-file `node --test` runs add up.
 * Recognises Vitest (`Tests  12 passed (12)`, `Tests  163 passed | 6 skipped (169)`) and
 * node:test (`ℹ pass 12` spec reporter, `# pass 12` TAP reporter).
 */
export function passedCount(output) {
  const text = output.replace(ANSI, '');
  let total = null;
  for (const re of [/\bTests\s+(\d+) passed\b/g, /^[ℹ#] pass (\d+)$/gm]) {
    for (const m of text.matchAll(re)) total = (total ?? 0) + Number(m[1]);
  }
  return total;
}

/** The contract's last line. */
export function summaryLine(mode, results, seconds, note) {
  const pass = results.every((r) => r.result === 'pass');
  const parts = results.map((r) => `${r.name}=${r.result === 'pass' ? (r.passed ?? 'ok') : 'FAIL'}`);
  const tail = parts.length ? parts.join('; ') : note;
  return `dev-check: ${mode} ${pass ? 'PASS' : 'FAIL'} in ${Math.round(seconds)}s — ${tail}`;
}

// ---------------------------------------------------------------------------------------------
// Git and process plumbing.
// ---------------------------------------------------------------------------------------------

function git(args, cwd = REPO_ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Changed paths vs the merge-base of HEAD and `base`: committed, staged and unstaged changes
 * (`git diff <merge-base>` compares the working tree) plus untracked files that are not ignored.
 * Returns { base: <merge-base sha or the ref>, changed: string[] | null } (null = unreadable).
 */
export function changedFiles(baseRef, cwd = REPO_ROOT) {
  const mergeBase = git(['merge-base', 'HEAD', baseRef], cwd)?.trim();
  if (!mergeBase) return { base: baseRef, changed: null };
  const diff = git(['diff', '--name-only', '--no-renames', mergeBase], cwd);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd);
  if (diff === null || untracked === null) return { base: mergeBase, changed: null };
  const files = new Set([...diff.split('\n'), ...untracked.split('\n')].filter(Boolean));
  return { base: mergeBase, changed: [...files].sort() };
}

function runStep(step) {
  return new Promise((resolve) => {
    const started = performance.now();
    const env = { ...process.env };
    if (process.stdout.isTTY && !env.NO_COLOR) env.FORCE_COLOR = '1';
    const child = spawn('sh', ['-c', step.command], { cwd: join(REPO_ROOT, step.cwd), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      output += d;
      process.stderr.write(d);
    });
    child.on('close', (code) => {
      const seconds = (performance.now() - started) / 1000;
      resolve({ name: step.name, command: step.command, seconds: Number(seconds.toFixed(2)), result: code === 0 ? 'pass' : 'fail', passed: code === 0 ? passedCount(output) : null });
    });
  });
}

function writeLast(record) {
  const dir = join(REPO_ROOT, '.dev-check');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last.json'), `${JSON.stringify(record, null, 2)}\n`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`dev-check: ${error.message}`);
    return 2;
  }
  if (args.help) {
    console.log('usage: scripts/dev-check.sh [fast|push|full] [--base <ref>] [--list] [--e2e]\nSee TESTING.md.');
    return 0;
  }
  const started = performance.now();
  const { base, changed } = changedFiles(args.base);
  const p = plan({ mode: args.mode, changed, install: installReason() });

  const header = p.mode === p.requested ? p.mode : `${p.requested} → ${p.mode}`;
  console.log(`dev-check ${header} (base ${base.slice(0, 12)}, ${changed === null ? 'diff unreadable' : `${changed.length} changed file(s)`})`);
  for (const reason of p.reasons) console.log(`  escalated: ${reason}`);
  if (args.e2e) console.log('  --e2e: this repo has no browser/service e2e steps');

  if (args.list) {
    if (!p.steps.length) console.log('  nothing to run');
    for (const step of p.steps) console.log(`  ${step.name.padEnd(20)} [${step.cwd}] ${step.command}\n  ${''.padEnd(20)} ← ${step.why}`);
    return 0;
  }

  const results = [];
  for (const step of p.steps) {
    console.log(`\n▶ ${step.name}: (cd ${step.cwd} && ${step.command})   ← ${step.why}`);
    const r = await runStep(step);
    console.log(`${r.result === 'pass' ? '✔' : '✘'} ${step.name} ${r.seconds.toFixed(1)}s${r.passed !== null ? ` (${r.passed} passed)` : ''}`);
    results.push(r);
  }
  const seconds = (performance.now() - started) / 1000;
  const note = p.nothingChanged ? `nothing changed vs ${base.slice(0, 12)}` : 'nothing selected (inert files only)';
  const summary = summaryLine(p.mode, results, seconds, note);
  const pass = results.every((r) => r.result === 'pass');
  writeLast({
    mode: p.mode,
    requested: p.requested,
    result: pass ? 'PASS' : 'FAIL',
    head: git(['rev-parse', 'HEAD'])?.trim() ?? null,
    dirty: (git(['status', '--porcelain']) ?? 'unknown').trim() !== '',
    base,
    seconds: Number(seconds.toFixed(1)),
    steps: results,
    summary,
  });
  console.log(`\n${summary}`);
  return pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
