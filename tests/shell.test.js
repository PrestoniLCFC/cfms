'use strict';
// Unit 007, the record sees shell changes: a file Claude creates, changes or deletes
// through a Bash or PowerShell call is noted as pending, like an edit. Each test runs
// the real hook before the call, makes the call's changes itself, then runs the real
// hook after, on a git fixture in the temp folder.

const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('./helpers');

const T1 = '2026-11-22T10:00:00.000Z';
const T2 = '2026-11-22T10:05:00.000Z';
const repoHadCfms = fs.existsSync(path.join(h.REPO, 'cfms'));

// Git with no global or system config (no signing, hooks or line ending rules from
// this machine), and no looking above the temp folder (a home folder may be a repo),
// for the fixtures and for the hook under test alike.
function gitEnv(dir) {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(dir),
    GIT_CONFIG_GLOBAL: path.join(dir, '.no-such-gitconfig'),
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}

function git(dir, ...args) {
  // No automatic gc or maintenance: they would run on after the big commit.
  const r = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: dir, env: { ...process.env, ...gitEnv(dir) }, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout;
}

function write(dir, rel, text) {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

// A fixture that is a git repo with src/app.js, docs/old.md and a .gitignore committed,
// then CFMS turned on (unless withCfms is false). extra(dir) adds files before the commit.
function withGit(withCfms, fn, extra) {
  const dir = h.makeFixture(false);
  try {
    write(dir, '.gitignore', 'build/\n*.log\n');
    write(dir, 'docs/old.md', '# old\n');
    if (extra) extra(dir);
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture');
    if (withCfms) assert.strictEqual(h.runOn(dir).status, 0);
    fn(dir);
  } finally {
    h.removeFixture(dir);
  }
}

function silent(r) {
  assert.strictEqual(r.status, 0, 'exit code; stderr: ' + r.stderr);
  assert.strictEqual(r.stdout, '', 'stdout must be empty');
  assert.strictEqual(r.stderr, '', 'stderr must be empty');
}

function hook(dir, stdin, now, project) {
  return h.runScript('shell.js', stdin, { CLAUDE_PROJECT_DIR: project || dir, CFMS_NOW: now || T1, ...gitEnv(dir) });
}

// One shell call: the hook before, the call's changes, the hook after.
function call(dir, changes, opts) {
  const o = opts || {};
  const project = o.project || dir;
  const pre = h.input(o.pre || 'bash-pre.json', project);
  const post = h.input(o.post || 'bash-post.json', project);
  silent(hook(dir, pre, o.now, project));
  changes(project);
  silent(hook(dir, post, o.now, project));
}

function pending(project) {
  return h.state(project).pending.map((c) => c.path).sort();
}

function looksLeft(project) {
  return fs.readdirSync(path.join(project, 'cfms')).filter((n) => n.startsWith('state.json.shell-'));
}

test('C1 a command that creates two files: both pending, and the look before is gone', () => {
  withGit(true, (dir) => {
    call(dir, (p) => { write(p, 'a.txt', 'a\n'); write(p, 'b/c.txt', 'c\n'); });
    assert.deepStrictEqual(h.state(dir).pending, [
      { path: 'a.txt', first: T1, last: T1 },
      { path: 'b/c.txt', first: T1, last: T1 },
    ]);
    assert.deepStrictEqual(looksLeft(dir), []);
    assert.deepStrictEqual(h.state(dir).errors, []);
  });
});

test('C1 the look before is kept in cfms/ between the two hooks, under a name its .gitignore covers', () => {
  withGit(true, (dir) => {
    silent(hook(dir, h.input('bash-pre.json', dir)));
    assert.deepStrictEqual(looksLeft(dir), ['state.json.shell-toolu_01BASH.tmp']);
    assert.strictEqual(git(dir, 'status', '--porcelain', '--untracked-files=all', '--', 'cfms'), '?? cfms/.gitignore\n', 'git sees only cfms/.gitignore');
    silent(hook(dir, h.input('bash-post.json', dir)));
    assert.deepStrictEqual(looksLeft(dir), []);
  });
});

test('C2 a file already changed before the call and not touched by it is not noted', () => {
  withGit(true, (dir) => {
    write(dir, 'src/app.js', 'const a = 2;\n');
    write(dir, 'notes.txt', 'his own file\n');
    call(dir, (p) => write(p, 'new.txt', 'n\n'));
    assert.deepStrictEqual(pending(dir), ['new.txt']);
  });
});

test('C3 a file already changed before the call and changed again during it is noted', () => {
  withGit(true, (dir) => {
    write(dir, 'src/app.js', 'const a = 2;\n');
    write(dir, 'notes.txt', 'his own file\n');
    call(dir, (p) => { write(p, 'src/app.js', 'const a = 33;\n'); write(p, 'notes.txt', 'changed by the command\n'); });
    assert.deepStrictEqual(pending(dir), ['notes.txt', 'src/app.js']);
  });
});

test('a tracked file that was clean before the call and changed during it is noted', () => {
  withGit(true, (dir) => {
    call(dir, (p) => write(p, 'docs/old.md', '# new\n'));
    assert.deepStrictEqual(pending(dir), ['docs/old.md']);
  });
});

test('C4 a deleted file is noted: tracked, and untracked that was there before', () => {
  withGit(true, (dir) => {
    write(dir, 'scratch.txt', 'untracked\n');
    call(dir, (p) => { fs.unlinkSync(path.join(p, 'src', 'app.js')); fs.unlinkSync(path.join(p, 'scratch.txt')); });
    assert.deepStrictEqual(pending(dir), ['scratch.txt', 'src/app.js']);
  });
});

test('C5 paths in cfms/, .git/ and ignored by .gitignore are not noted', () => {
  withGit(true, (dir) => {
    call(dir, (p) => {
      write(p, 'cfms/scratch.md', 'x\n');
      write(p, '.git/cfms-test', 'x\n');
      write(p, 'build/out.js', 'x\n');
      write(p, 'run.log', 'x\n');
      write(p, 'src/debug.log', 'x\n');
    });
    assert.deepStrictEqual(pending(dir), []);
    assert.deepStrictEqual(looksLeft(dir), []);
  });
});

test('C6 without cfms/ the fixture is unchanged but for what the command did', () => {
  withGit(false, (dir) => {
    const before = h.snapshot(dir);
    call(dir, (p) => write(p, 'a.txt', 'a\n'));
    const afterSnap = h.snapshot(dir);
    delete afterSnap['a.txt'];
    assert.deepStrictEqual(afterSnap, before);
    assert.ok(!fs.existsSync(path.join(dir, 'cfms')));
  });
});

test('the hooks never write into .git/: git runs read only', () => {
  withGit(true, (dir) => {
    write(dir, 'src/app.js', 'const a = 2;\n');
    const gitDir = (d) => Object.fromEntries(Object.entries(h.snapshot(d)).filter(([k]) => k.startsWith('.git/')));
    const before = gitDir(dir);
    call(dir, (p) => write(p, 'a.txt', 'a\n'));
    assert.deepStrictEqual(gitDir(dir), before);
  });
});

test('R4 the same file changed by a second command is still one entry, its last time moved', () => {
  withGit(true, (dir) => {
    call(dir, (p) => write(p, 'a.txt', 'a\n'), { now: T1 });
    call(dir, (p) => write(p, 'a.txt', 'a again\n'), { now: T2 });
    assert.deepStrictEqual(h.state(dir).pending, [{ path: 'a.txt', first: T1, last: T2 }]);
  });
});

test('a PowerShell call that fails after creating a file: the file is noted (PostToolUseFailure)', () => {
  withGit(true, (dir) => {
    call(dir, (p) => write(p, 'g.txt', 'g\n'), { pre: 'powershell-pre.json', post: 'powershell-post-failure.json' });
    assert.deepStrictEqual(pending(dir), ['g.txt']);
    assert.deepStrictEqual(looksLeft(dir), []);
  });
});

test('a git commit during the call is not a change: the committed files are not noted', () => {
  withGit(true, (dir) => {
    write(dir, 'src/app.js', 'const a = 2;\n');
    call(dir, (p) => git(p, 'commit', '-q', '-am', 'by the command'));
    assert.deepStrictEqual(pending(dir), []);
  });
});

test('a project in a subfolder of a git repo: only its own files are noted, relative to it', () => {
  withGit(false, (dir) => {
    const project = path.join(dir, 'app');
    write(dir, 'app/main.js', 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'app');
    assert.strictEqual(h.runOn(project).status, 0);
    call(dir, (p) => { write(p, 'lib/new.js', 'n\n'); write(p, 'main.js', 'yy\n'); write(dir, 'outside.txt', 'o\n'); }, { project });
    assert.deepStrictEqual(pending(project), ['lib/new.js', 'main.js']);
  });
});

test('R3 a project that is not a git repo: no look kept, nothing noted, nothing in errors', () => {
  const dir = h.makeFixture(true);
  try {
    call(dir, (p) => write(p, 'a.txt', 'a\n'));
    assert.deepStrictEqual(h.state(dir), { format: 1, pending: [], errors: [] });
    assert.deepStrictEqual(looksLeft(dir), []);
  } finally {
    h.removeFixture(dir);
  }
});

test('other tools are ignored, and an after with no before notes nothing', () => {
  withGit(true, (dir) => {
    const monitor = JSON.parse(h.input('bash-pre.json', dir));
    monitor.tool_name = 'Monitor';
    silent(hook(dir, JSON.stringify(monitor)));
    assert.deepStrictEqual(looksLeft(dir), []);
    write(dir, 'a.txt', 'a\n');
    silent(hook(dir, h.input('bash-post.json', dir)));
    assert.deepStrictEqual(h.state(dir), { format: 1, pending: [], errors: [] });
  });
});

test('R5 a malformed input exits 0, prints nothing, and the error is noted', () => {
  withGit(true, (dir) => {
    silent(hook(dir, 'not json'));
    const s = h.state(dir);
    assert.deepStrictEqual(s.pending, []);
    assert.strictEqual(s.errors.length, 1);
    assert.match(s.errors[0].where, /^shell/);
  });
});

test('R5 a corrupt state file: exit 0, prints nothing, the look before still cleared', () => {
  withGit(true, (dir) => {
    fs.writeFileSync(path.join(dir, 'cfms', 'state.json'), '{ broken');
    call(dir, (p) => write(p, 'a.txt', 'a\n'));
    assert.deepStrictEqual(looksLeft(dir), []);
  });
});

test('a look before left by a denied or cancelled call is cleared after a day', () => {
  withGit(true, (dir) => {
    const stale = path.join(dir, 'cfms', 'state.json.shell-toolu_OLD.tmp');
    fs.writeFileSync(stale, '{}');
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(stale, old, old);
    call(dir, (p) => write(p, 'a.txt', 'a\n'));
    assert.ok(!fs.existsSync(stale));
    assert.deepStrictEqual(pending(dir), ['a.txt']);
  });
});

test('C7 a fixture of 20,000 files: each hook under one second', () => {
  withGit(true, (dir) => {
    write(dir, 'src/app.js', 'const a = 2;\n');
    write(dir, 'untracked/one.txt', '1\n');
    const pre = h.input('bash-pre.json', dir);
    const post = h.input('bash-post.json', dir);
    // Warm the file cache once, as in a session that has been running.
    silent(hook(dir, pre));
    silent(hook(dir, post));
    const t0 = process.hrtime.bigint();
    silent(hook(dir, pre));
    const t1 = process.hrtime.bigint();
    write(dir, 'd100/new.txt', 'n\n');
    const t2 = process.hrtime.bigint();
    silent(hook(dir, post));
    const t3 = process.hrtime.bigint();
    const preMs = Number(t1 - t0) / 1e6;
    const postMs = Number(t3 - t2) / 1e6;
    console.log('C7 20,000 files: before ' + preMs.toFixed(0) + ' ms, after ' + postMs.toFixed(0) + ' ms');
    assert.ok(preMs < 1000, 'before took ' + preMs + ' ms');
    assert.ok(postMs < 1000, 'after took ' + postMs + ' ms');
    assert.deepStrictEqual(pending(dir), ['d100/new.txt']);
  }, (dir) => {
    for (let d = 0; d < 200; d++) {
      fs.mkdirSync(path.join(dir, 'd' + d));
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, 'd' + d, 'f' + f + '.txt'), 'x\n'); // one blob for all, for a quick commit
    }
  });
});

test('the plugin files point the shell hook at the script that exists', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(h.REPO, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    const e = (hooks[event] || []).filter((x) => x.hooks.some((y) => y.command.includes('${CLAUDE_PLUGIN_ROOT}/scripts/shell.js')));
    assert.strictEqual(e.length, 1, event);
    assert.deepStrictEqual(e[0].matcher.split('|').sort(), ['Bash', 'PowerShell'], event);
  }
  assert.ok(fs.existsSync(path.join(h.REPO, 'scripts', 'shell.js')));
});

after(() => {
  // C8: every fixture is gone, and the run wrote nothing into this repo.
  assert.deepStrictEqual(h.leftovers(), [], 'fixtures left behind');
  assert.strictEqual(fs.existsSync(path.join(h.REPO, 'cfms')), repoHadCfms, 'the run touched cfms/ in this repo');
});