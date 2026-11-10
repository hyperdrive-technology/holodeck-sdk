// Tests for scripts/dev-check.mjs: selection logic, output parsing, git diff collection, the
// pre-push hook, and the pin that keeps `dev-check.sh full` and .github/workflows/test.yml in
// step. Run: node --test "scripts/*.test.mjs" (also a dev-check and CI step).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { REPO_ROOT, RULES, STEPS, changedFiles, classify, parseArgs, passedCount, plan, summaryLine } from './dev-check.mjs';

const names = (p) => p.steps.map((s) => s.name);
const NON_INSTALL = STEPS.filter((s) => !s.install).map((s) => s.name);
const PUSH_SET = STEPS.filter((s) => !s.install && !s.fullOnly).map((s) => s.name);

describe('parseArgs', () => {
  it('defaults to fast against origin/main', () => {
    assert.deepEqual(parseArgs([]), { mode: 'fast', base: 'origin/main', list: false, e2e: false });
  });
  it('reads mode, --base (both forms), --list and --e2e', () => {
    assert.deepEqual(parseArgs(['full', '--base', 'abc', '--list', '--e2e']), { mode: 'full', base: 'abc', list: true, e2e: true });
    assert.equal(parseArgs(['push', '--base=main']).base, 'main');
  });
  it('rejects unknown arguments and a bare --base', () => {
    assert.throws(() => parseArgs(['--fast']), /unknown argument/);
    assert.throws(() => parseArgs(['--base']), /needs a ref/);
  });
});

describe('classify', () => {
  const cases = [
    ['ts/src/version.ts', 'owned', ['typecheck', 'test']],
    ['ts/src/new-file.test.ts', 'owned', ['typecheck', 'test']],
    ['schema/scenefile.schema.json', 'owned', ['schema', 'test']],
    ['examples/packages/holodeck-iso.holodeck.package.json', 'owned', ['schema', 'test']],
    ['docs/PACKAGING.md', 'owned', ['test']],
    ['ts/scripts/smoke-dist.mjs', 'owned', ['build', 'smoke-dist']],
    ['scripts/dev-check.mjs', 'owned', ['dev-check-selftest']],
    ['.githooks/pre-push', 'owned', ['dev-check-selftest']],
    ['README.md', 'inert', []],
    ['TESTING.md', 'inert', []],
    ['LICENSE', 'inert', []],
    ['.github/CODEOWNERS', 'inert', []],
    ['.github/workflows/test.yml', 'full', []],
    ['.node-version', 'full', []],
    ['ts/package.json', 'full', []],
    ['ts/pnpm-lock.yaml', 'full', []],
    ['ts/tsconfig.check.json', 'full', []],
    ['ts/vitest.config.ts', 'full', []],
    ['ts/README.md', 'unowned', []],
    ['brand-new-dir/thing.json', 'unowned', []],
  ];
  for (const [file, kind, select] of cases) {
    it(`${file} → ${kind}`, () => {
      const c = classify(file);
      assert.equal(c.kind, kind);
      assert.deepEqual(c.select, select);
    });
  }
  it('every rule selects only steps that exist', () => {
    const known = new Set(STEPS.map((s) => s.name));
    for (const rule of RULES) for (const name of rule.select ?? []) assert.ok(known.has(name), `${rule.pattern} selects unknown step ${name}`);
  });
});

describe('plan', () => {
  it('one-file leaf change (fast): typecheck + test only', () => {
    const p = plan({ mode: 'fast', changed: ['ts/src/version.ts'] });
    assert.equal(p.mode, 'fast');
    assert.deepEqual(names(p), ['typecheck', 'test']);
    assert.match(p.steps[0].why, /ts\/src\/version\.ts/);
  });
  it('schema change (fast): schema + test (package.test.ts reads the schema)', () => {
    assert.deepEqual(names(plan({ mode: 'fast', changed: ['schema/holodeck-package.v1.schema.json'] })), ['test', 'schema']);
  });
  it('config change (fast) escalates to full: every CI step', () => {
    const p = plan({ mode: 'fast', changed: ['ts/src/version.ts', 'ts/vitest.config.ts'] });
    assert.equal(p.mode, 'full');
    assert.equal(p.requested, 'fast');
    assert.deepEqual(names(p), NON_INSTALL);
    assert.match(p.reasons.join('\n'), /vitest\.config\.ts.*full/);
  });
  it('an unowned file (fast) fails closed to the push set', () => {
    const p = plan({ mode: 'fast', changed: ['brand-new-dir/thing.json'] });
    assert.equal(p.mode, 'push');
    assert.deepEqual(names(p), PUSH_SET);
  });
  it('push runs every non-build step, plus build steps the diff selects', () => {
    assert.deepEqual(names(plan({ mode: 'push', changed: ['ts/src/version.ts'] })), PUSH_SET);
    assert.deepEqual(names(plan({ mode: 'push', changed: ['ts/scripts/smoke-dist.mjs'] })), [...PUSH_SET, 'build', 'smoke-dist']);
  });
  it('full runs every CI step whatever the diff, even with no diff', () => {
    assert.deepEqual(names(plan({ mode: 'full', changed: ['README.md'] })), NON_INSTALL);
    assert.deepEqual(names(plan({ mode: 'full', changed: [] })), NON_INSTALL);
  });
  it('inert-only changes select nothing', () => {
    const p = plan({ mode: 'fast', changed: ['README.md', 'LICENSE'] });
    assert.deepEqual(names(p), []);
    assert.equal(p.nothingChanged, false);
  });
  it('no change at all: fast and push do nothing', () => {
    for (const mode of ['fast', 'push']) {
      const p = plan({ mode, changed: [] });
      assert.deepEqual(names(p), []);
      assert.equal(p.nothingChanged, true);
    }
  });
  it('an unreadable diff fails closed to full', () => {
    const p = plan({ mode: 'fast', changed: null });
    assert.equal(p.mode, 'full');
    assert.deepEqual(names(p), NON_INSTALL);
  });
  it('a stale or missing node_modules adds the install step first', () => {
    const p = plan({ mode: 'fast', changed: ['ts/src/version.ts'], install: 'ts/node_modules/.modules.yaml missing' });
    assert.deepEqual(names(p), ['install', 'typecheck', 'test']);
    assert.deepEqual(names(plan({ mode: 'fast', changed: ['README.md'], install: 'stale' })), ['install']);
  });
});

describe('passedCount', () => {
  it('reads Vitest 1 and 3 summaries, ignoring skipped', () => {
    assert.equal(passedCount(' Test Files  11 passed (11)\n      Tests  347 passed (347)\n'), 347);
    assert.equal(passedCount('      Tests  163 passed | 6 skipped (169)'), 163);
  });
  it('sums several summaries (pnpm -r prefixes, verify scripts)', () => {
    const out = 'packages/a test:       Tests  10 passed (10)\npackages/b test:       Tests  5 passed (5)\n';
    assert.equal(passedCount(out), 15);
  });
  it('reads node:test spec and TAP reporters', () => {
    assert.equal(passedCount('ℹ tests 9\nℹ pass 9\nℹ fail 0\n'), 9);
    assert.equal(passedCount('# tests 4\n# pass 4\n'), 4);
  });
  it('strips colours', () => {
    assert.equal(passedCount('\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m12 passed\x1b[39m\x1b[22m'), 12);
  });
  it('is null when nothing reports a count', () => {
    assert.equal(passedCount('schema ../schema/x.json is valid\n'), null);
  });
});

describe('summaryLine', () => {
  it('has the contract shape', () => {
    const line = summaryLine('push', [{ name: 'typecheck', result: 'pass', passed: null }, { name: 'test', result: 'pass', passed: 347 }], 3.4);
    assert.equal(line, 'dev-check: push PASS in 3s — typecheck=ok; test=347');
    assert.equal(summaryLine('fast', [{ name: 'test', result: 'fail', passed: null }], 1), 'dev-check: fast FAIL in 1s — test=FAIL');
    assert.equal(summaryLine('fast', [], 0.2, 'nothing changed vs abc'), 'dev-check: fast PASS in 0s — nothing changed vs abc');
  });
});

describe('changedFiles', () => {
  const sh = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  it('collects committed, staged, unstaged and untracked-not-ignored files vs the merge-base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-check-git-'));
    try {
      sh(dir, 'init', '-q', '-b', 'main');
      sh(dir, 'config', 'user.email', 't@example.com');
      sh(dir, 'config', 'user.name', 't');
      for (const f of ['a.txt', 'b.txt', 'c.txt', '.gitignore']) writeFileSync(join(dir, f), f === '.gitignore' ? 'ignored.txt\n' : 'x\n');
      sh(dir, 'add', '.');
      sh(dir, 'commit', '-qm', 'base');
      sh(dir, 'checkout', '-qb', 'feature');
      writeFileSync(join(dir, 'a.txt'), 'committed\n');
      sh(dir, 'commit', '-qam', 'change a');
      writeFileSync(join(dir, 'b.txt'), 'staged\n');
      sh(dir, 'add', 'b.txt');
      writeFileSync(join(dir, 'c.txt'), 'unstaged\n');
      writeFileSync(join(dir, 'new.txt'), 'untracked\n');
      writeFileSync(join(dir, 'ignored.txt'), 'ignored\n');
      const { base, changed } = changedFiles('main', dir);
      assert.equal(base, sh(dir, 'rev-parse', 'main').trim());
      assert.deepEqual(changed, ['a.txt', 'b.txt', 'c.txt', 'new.txt']);
      assert.deepEqual(changedFiles('no-such-ref', dir).changed, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Minimal reader for the workflow shapes used in this repo: per job, `defaults.run.working-directory`,
 * and per step `run:` (single line or `|` block, one command per line) with an optional
 * step-level `working-directory:`. Returns [{ job, cwd, command }].
 */
function workflowRunCommands(yaml) {
  const out = [];
  const lines = yaml.split('\n');
  let job = null;
  let jobCwd = '.';
  let step = null;
  const flush = () => {
    if (!step) return;
    for (const command of step.commands) out.push({ job, cwd: step.cwd ?? jobCwd, command });
    step = null;
  };
  let inJobs = false;
  let inSteps = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^jobs:\s*$/.test(line)) inJobs = true;
    if (!inJobs) continue;
    let m;
    if ((m = /^ {2}([\w-]+):\s*$/.exec(line))) {
      flush();
      job = m[1];
      jobCwd = '.';
      inSteps = false;
      continue;
    }
    if (/^ {4}steps:\s*$/.test(line)) inSteps = true;
    // defaults.run.working-directory sits at the same indent as a step key; it comes before steps:.
    if (!inSteps && (m = /^ {8}working-directory:\s*(\S+)\s*$/.exec(line))) jobCwd = m[1];
    if (/^ {6}- /.test(line)) {
      flush();
      step = { commands: [], cwd: undefined };
    }
    if (!step) continue;
    if ((m = /^ {6}(?:- | {2})working-directory:\s*(\S+)\s*$/.exec(line))) step.cwd = m[1];
    if ((m = /^ {6}(?:- | {2})run:\s*(.*)$/.exec(line))) {
      if (m[1] === '|') {
        while (i + 1 < lines.length && /^ {10}/.test(lines[i + 1])) {
          i += 1;
          const cmd = lines[i].trim();
          if (cmd && !cmd.startsWith('#')) step.commands.push(cmd);
        }
      } else step.commands.push(m[1].trim());
    }
  }
  flush();
  return out;
}

describe('dev-check full ⇔ test.yml (one source of truth)', () => {
  const yaml = readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8');
  const ci = workflowRunCommands(yaml).filter((c) => c.command !== 'pnpm install --frozen-lockfile');
  const key = (cwd, command) => `[${cwd}] ${command}`;

  it('the reader finds the CI commands', () => {
    assert.ok(ci.length >= 5, JSON.stringify(ci));
    assert.ok(ci.some((c) => c.job === 'validate-schema' && c.command === 'pnpm run validate:schema' && c.cwd === 'ts'));
  });
  it('every CI command is a dev-check full step (same directory, same command)', () => {
    const full = new Set(plan({ mode: 'full', changed: [] }).steps.map((s) => key(s.cwd, s.command)));
    for (const c of ci) assert.ok(full.has(key(c.cwd, c.command)), `${c.job}: ${key(c.cwd, c.command)} is not a dev-check full step`);
  });
  it('every dev-check full step runs in CI unless marked local-only', () => {
    const inCi = new Set(ci.map((c) => key(c.cwd, c.command)));
    for (const s of STEPS.filter((s) => !s.install && s.ci !== false)) assert.ok(inCi.has(key(s.cwd, s.command)), `${key(s.cwd, s.command)} missing from test.yml`);
  });
  it('PR runs start only from a label event (heavy CI once, before merge)', () => {
    assert.match(yaml, /pull_request:\n {4}types: \[labeled\]\n/);
    assert.match(yaml, /contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci'\)/);
  });
});

describe('entry points', () => {
  it('--list runs nothing and exits 0; a bad argument exits 2', () => {
    const list = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/dev-check.mjs'), 'push', '--list', '--base', 'HEAD'], { encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^dev-check push/);
    const bad = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/dev-check.mjs'), '--nope'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  });
  it('the pre-push hook can be skipped for checkpoints', () => {
    const r = spawnSync(join(REPO_ROOT, '.githooks/pre-push'), [], { encoding: 'utf8', env: { ...process.env, HYPERDRIVE_SKIP_HOOKS: '1' }, cwd: REPO_ROOT });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /skipping dev-check/);
  });
});
