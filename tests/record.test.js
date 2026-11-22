'use strict';
// Unit 001, the record: /cfms:on, then every edit is noted.

const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

const T1 = '2026-11-22T10:00:00.000Z';
const T2 = '2026-11-22T10:05:00.000Z';
const READS = ['NOW.md', 'DECISIONS.md', 'CHECKINS.md'];
const repoHadCfms = fs.existsSync(path.join(h.REPO, 'cfms'));

function withFixture(withCfms, fn) {
  const dir = h.makeFixture(withCfms);
  try {
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

function capture(dir, name, now) {
  return h.runCapture(h.input(name, dir), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: now || T1 });
}

test('C1 /cfms:on on an empty fixture creates cfms/ with the state file and its .gitignore, and nothing else', () => {
  withFixture(false, (dir) => {
    const before = h.snapshot(dir);
    const r = h.runOn(dir);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /CFMS is on/);
    const afterSnap = h.snapshot(dir);
    const added = Object.keys(afterSnap).filter((k) => !(k in before)).sort();
    assert.deepStrictEqual(added, ['cfms/', 'cfms/.gitignore', 'cfms/state.json']);
    for (const k of Object.keys(before)) assert.strictEqual(afterSnap[k], before[k], 'changed: ' + k);
    assert.deepStrictEqual(h.state(dir), { format: 1, pending: [], errors: [] });
    assert.match(afterSnap['cfms/.gitignore'], /^state\.json$/m);
  });
});

test('C1 /cfms:on run again changes nothing', () => {
  withFixture(true, (dir) => {
    capture(dir, 'edit.json');
    const before = h.snapshot(dir);
    const r = h.runOn(dir);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /already on/);
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C1 /cfms:on with the project argument left unsubstituted falls back to CLAUDE_PROJECT_DIR', () => {
  withFixture(false, (dir) => {
    const r = h.runOn(dir, ['${CLAUDE_PROJECT_DIR}'], { CLAUDE_PROJECT_DIR: dir });
    assert.strictEqual(r.status, 0);
    assert.ok(fs.existsSync(path.join(dir, 'cfms', 'state.json')));
  });
});

test('C2 a recorded Edit input adds one pending change with its relative, forward slash path', () => {
  withFixture(true, (dir) => {
    const raw = h.input('edit.json', dir);
    if (process.platform === 'win32') assert.ok(raw.includes('\\\\src\\\\app.js'), 'input carries backslashes');
    silent(capture(dir, 'edit.json'));
    assert.deepStrictEqual(h.state(dir).pending, [{ path: 'src/app.js', first: T1, last: T1 }]);
  });
});

test('C2 Write and NotebookEdit inputs are noted too', () => {
  withFixture(true, (dir) => {
    silent(capture(dir, 'write.json'));
    silent(capture(dir, 'notebook.json', T2));
    assert.deepStrictEqual(h.state(dir).pending.map((c) => c.path), ['README.md', 'notes/explore.ipynb']);
  });
});

test('C3 the same file again adds nothing new', () => {
  withFixture(true, (dir) => {
    silent(capture(dir, 'edit.json', T1));
    silent(capture(dir, 'edit.json', T2));
    assert.deepStrictEqual(h.state(dir).pending, [{ path: 'src/app.js', first: T1, last: T2 }]);
  });
});

test('C4 an edit inside cfms/ adds nothing', () => {
  withFixture(true, (dir) => {
    const before = h.snapshot(dir);
    silent(capture(dir, 'edit-in-cfms.json'));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('an edit outside the project adds nothing', () => {
  withFixture(true, (dir) => {
    const before = h.snapshot(dir);
    silent(capture(dir, 'edit-outside.json'));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C5 the same Edit input in a fixture without cfms/ leaves the fixture unchanged', () => {
  withFixture(false, (dir) => {
    const before = h.snapshot(dir);
    silent(capture(dir, 'edit.json'));
    assert.deepStrictEqual(h.snapshot(dir), before);
    assert.ok(!fs.existsSync(path.join(dir, 'cfms')));
  });
});

test('without CLAUDE_PROJECT_DIR the project comes from the input cwd', () => {
  withFixture(true, (dir) => {
    silent(h.runCapture(h.input('edit.json', dir), { CFMS_NOW: T1 }));
    assert.deepStrictEqual(h.state(dir).pending.map((c) => c.path), ['src/app.js']);
  });
});

for (const [label, stdin] of [
  ['not JSON', (dir) => h.input('malformed.txt', dir)],
  ['empty', () => ''],
  ['JSON with no file path', (dir) => h.input('no-path.json', dir)],
]) {
  test('C6 a malformed input (' + label + ') exits 0 and changes nothing he reads', () => {
    withFixture(true, (dir) => {
      silent(capture(dir, 'edit.json'));
      const pending = h.state(dir).pending;
      silent(h.runCapture(stdin(dir), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: T2 }));
      const s = h.state(dir);
      assert.deepStrictEqual(s.pending, pending);
      assert.strictEqual(s.errors.length, 1, 'the error is noted in the state file');
      for (const f of READS) assert.ok(!fs.existsSync(path.join(dir, 'cfms', f)), f + ' must not exist');
      assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'cfms')).sort(), ['.gitignore', 'state.json']);
    });
  });
}

test('C6 a malformed input without cfms/ writes nothing', () => {
  withFixture(false, (dir) => {
    const before = h.snapshot(dir);
    silent(h.runCapture('not json', { CLAUDE_PROJECT_DIR: dir }));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C6 a corrupt state file still exits 0 and prints nothing', () => {
  withFixture(true, (dir) => {
    fs.writeFileSync(path.join(dir, 'cfms', 'state.json'), '{ broken');
    silent(capture(dir, 'edit.json'));
    for (const f of READS) assert.ok(!fs.existsSync(path.join(dir, 'cfms', f)));
  });
});

test('the plugin files point at the scripts that exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(h.REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(manifest.name, 'cfms');
  const hooks = JSON.parse(fs.readFileSync(path.join(h.REPO, 'hooks', 'hooks.json'), 'utf8'));
  const post = hooks.hooks.PostToolUse.filter((e) => e.hooks.some((x) => x.command.includes('capture.js')));
  assert.strictEqual(post.length, 1);
  assert.deepStrictEqual(post[0].matcher.split('|').sort(), ['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  const cmd = post[0].hooks[0].command;
  assert.ok(cmd.includes('${CLAUDE_PLUGIN_ROOT}/scripts/capture.js'));
  assert.ok(fs.existsSync(path.join(h.REPO, 'scripts', 'capture.js')));
  const skill = fs.readFileSync(path.join(h.REPO, 'skills', 'on', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: on$/m);
  assert.ok(skill.includes('${CLAUDE_PLUGIN_ROOT}/scripts/on.js'));
  assert.ok(fs.existsSync(path.join(h.REPO, 'scripts', 'on.js')));
});

after(() => {
  // C7: every fixture is gone, and the run wrote nothing into this repo.
  assert.deepStrictEqual(h.leftovers(), [], 'fixtures left behind');
  assert.strictEqual(fs.existsSync(path.join(h.REPO, 'cfms')), repoHadCfms, 'the run touched cfms/ in this repo');
});
