'use strict';
// Unit 002, the natural stop: the ask at the end of Claude's turn, and his words
// saved only through the CFMS question dialog (DD-004).

const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

const T = (m) => '2026-11-22T10:' + String(m).padStart(2, '0') + ':00.000Z';
const ANSWER_AT = T(30);
const repoHadCfms = fs.existsSync(path.join(h.REPO, 'cfms'));

function withFixture(fn) {
  const dir = h.makeFixture(true);
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

// One Edit per relative path, a minute apart, oldest first.
function edit(dir, ...rels) {
  rels.forEach((rel, i) => {
    const obj = JSON.parse(h.input('edit.json', dir));
    obj.tool_input.file_path = path.join(dir, ...rel.split('/'));
    silent(h.runCapture(JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: T(i + 1) }));
  });
}

function stop(dir, change) {
  const obj = JSON.parse(h.input('stop.json', dir));
  if (change) change(obj);
  return h.runScript('ask.js', JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: T(20) });
}

// The CFMS dialog closing with this text in its free text box.
function answer(dir, text, change) {
  const obj = JSON.parse(h.input('answer-cfms.json', dir));
  for (const part of [obj.tool_input, obj.tool_response]) {
    for (const k of Object.keys(part.answers)) part.answers[k] = text;
  }
  if (change) change(obj);
  return h.runScript('answer.js', JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: ANSWER_AT });
}

function checkinsBytes(dir) {
  return fs.readFileSync(path.join(dir, 'cfms', 'CHECKINS.md'));
}

function noCheckins(dir) {
  assert.ok(!fs.existsSync(path.join(dir, 'cfms', 'CHECKINS.md')), 'CHECKINS.md must not exist');
}

function context(r, event) {
  assert.strictEqual(r.status, 0, 'exit code; stderr: ' + r.stderr);
  assert.strictEqual(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, event);
  return out.hookSpecificOutput.additionalContext;
}

test('C1 three pending and a Stop input: the context names the cfms:ask skill and lists them', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    const text = context(stop(dir), 'Stop');
    assert.ok(!/[\r\n]/.test(text), 'one line (003 R6)');
    assert.match(text, /^CFMS: 3 changes not yet in your words\./);
    assert.match(text, /Use the cfms:ask skill\.$/);
    assert.match(text, /src\/c\.js, src\/b\.js, src\/a\.js/, 'newest first');
    const s = h.state(dir);
    assert.deepStrictEqual(s.ask, { at: T(20), paths: ['src/c.js', 'src/b.js', 'src/a.js'] });
    assert.strictEqual(s.pending.length, 3, 'asking keeps them pending');
  });
});

test('C1 seven pending: the ask names the newest five', () => {
  withFixture((dir) => {
    edit(dir, 'f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js', 'f6.js', 'f7.js');
    const text = context(stop(dir), 'Stop');
    assert.match(text, /f7\.js, f6\.js, f5\.js, f4\.js, f3\.js\./);
    assert.doesNotMatch(text, /f2\.js|f1\.js/);
    assert.deepStrictEqual(h.state(dir).ask.paths, ['f7.js', 'f6.js', 'f5.js', 'f4.js', 'f3.js']);
  });
});

test('C2 two pending: nothing', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js');
    const before = h.snapshot(dir);
    silent(stop(dir));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C3 stop_hook_active true: nothing', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    const before = h.snapshot(dir);
    silent(stop(dir, (o) => { o.stop_hook_active = true; }));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('a Stop input in a project without cfms/: nothing', () => {
  const dir = h.makeFixture(false);
  try {
    const before = h.snapshot(dir);
    silent(stop(dir));
    assert.deepStrictEqual(h.snapshot(dir), before);
  } finally {
    h.removeFixture(dir);
  }
});

test('C4 a CFMS answer with quotes, an emoji, accented letters and a line break: CHECKINS.md holds it byte for byte; the pending list cleared', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    context(stop(dir), 'Stop');
    const words = 'He said "keep it simple" and it\'s right \u{1F642}\ncafé, naïve, Zürich, señor';
    const r = answer(dir, words + '  \n');
    assert.strictEqual(context(r, 'PostToolUse'), 'Saved to cfms/CHECKINS.md');
    const bytes = checkinsBytes(dir);
    const want = Buffer.from(words, 'utf8');
    assert.ok(bytes.includes(want), 'his words byte for byte');
    assert.ok(bytes.includes(Buffer.from('\n\n' + words + '\n', 'utf8')), 'trailing whitespace aside, nothing added to his line');
    const text = bytes.toString('utf8');
    assert.match(text.split('\n')[0], /^<!-- CFMS CHECKINS format 1 -->$/, 'first line names the format');
    assert.match(text, /^## 2026-11-22 10:30 UTC$/m, 'the date');
    assert.match(text, /^Changes: src\/c\.js, src\/b\.js, src\/a\.js$/m, 'the changes it answers');
    const s = h.state(dir);
    assert.deepStrictEqual(s.pending, []);
    assert.strictEqual(s.ask, undefined);
  });
});

test('C4 a Windows line break is kept as typed', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    context(stop(dir), 'Stop');
    context(answer(dir, 'first\r\nsecond'), 'PostToolUse');
    assert.ok(checkinsBytes(dir).includes(Buffer.from('first\r\nsecond', 'utf8')));
  });
});

test('C4 only the changes asked about leave the pending list; a second answer appends', () => {
  withFixture((dir) => {
    edit(dir, 'f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js', 'f6.js', 'f7.js');
    context(stop(dir), 'Stop');
    context(answer(dir, 'One reason'), 'PostToolUse');
    assert.deepStrictEqual(h.state(dir).pending.map((c) => c.path), ['f1.js', 'f2.js']);
    context(answer(dir, 'Another reason'), 'PostToolUse');
    const text = checkinsBytes(dir).toString('utf8');
    assert.strictEqual(text.match(/^## /gm).length, 2);
    assert.ok(text.indexOf('One reason') < text.indexOf('Another reason'));
    assert.match(text, /^Changes: f2\.js, f1\.js$/m, 'with no recorded ask it answers the newest pending');
    assert.strictEqual(text.match(/format 1/g).length, 1, 'the format line once');
    assert.deepStrictEqual(h.state(dir).pending, []);
  });
});

test('C4 the answer is read from tool_input when tool_response is not an object', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    context(stop(dir), 'Stop');
    context(answer(dir, 'Because tests come first', (o) => { o.tool_response = 'User has answered your questions.'; }), 'PostToolUse');
    assert.ok(checkinsBytes(dir).includes(Buffer.from('Because tests come first')));
  });
});

for (const [label, text] of [['empty', ''], ['only spaces', '   \n ']]) {
  test('C5 an empty CFMS answer (' + label + '): nothing saved, pending kept', () => {
    withFixture((dir) => {
      edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
      context(stop(dir), 'Stop');
      const before = h.snapshot(dir);
      silent(answer(dir, text));
      noCheckins(dir);
      assert.deepStrictEqual(h.snapshot(dir), before);
    });
  });
}

test('C5 no answers at all (dialog closed without one): nothing saved, pending kept', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    const before = h.snapshot(dir);
    silent(answer(dir, 'x', (o) => { delete o.tool_input.answers; delete o.tool_response.answers; }));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C6 another dialog\'s answer: nothing saved', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    const before = h.snapshot(dir);
    silent(h.runScript('answer.js', h.input('answer-other.json', dir), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: ANSWER_AT }));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C6 a dialog with another header but CFMS-like text: nothing saved', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    const before = h.snapshot(dir);
    silent(answer(dir, 'A real reason', (o) => {
      for (const part of [o.tool_input, o.tool_response]) part.questions[0].header = 'cfms ';
    }));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

for (const text of ['Yes', 'y', 'OK', 'okay', 'Sure', 'fine', 'DONE', 'yes.', ' ok! ']) {
  test('C7 "' + text + '" alone: nothing saved, pending kept', () => {
    withFixture((dir) => {
      edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
      context(stop(dir), 'Stop');
      const before = h.snapshot(dir);
      silent(answer(dir, text));
      assert.deepStrictEqual(h.snapshot(dir), before);
    });
  });
}

for (const label of ['Skip', 'Not now', 'skip', 'NOT NOW']) {
  test('choosing "' + label + '": nothing saved as his words (what it does to pending is 003)', () => {
    withFixture((dir) => {
      edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
      context(stop(dir), 'Stop');
      silent(answer(dir, label));
      noCheckins(dir);
    });
  });
}

test('"yes, because the old names confused me" is his words and is saved', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    context(answer(dir, 'yes, because the old names confused me'), 'PostToolUse');
    assert.ok(checkinsBytes(dir).includes(Buffer.from('yes, because the old names confused me')));
  });
});

test('C8 any UserPromptSubmit input: nothing saved, by any CFMS script', () => {
  withFixture((dir) => {
    edit(dir, 'src/a.js', 'src/b.js', 'src/c.js');
    const before = h.snapshot(dir);
    const stdin = h.input('user-prompt.json', dir);
    for (const script of ['answer.js', 'ask.js', 'capture.js']) {
      const r = h.runScript(script, stdin, { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: ANSWER_AT });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, '', script + ' printed something');
    }
    noCheckins(dir);
    assert.deepStrictEqual(h.state(dir).pending, before['cfms/state.json'] && JSON.parse(before['cfms/state.json']).pending);
    const hooks = JSON.parse(fs.readFileSync(path.join(h.REPO, 'hooks', 'hooks.json'), 'utf8'));
    assert.ok(!('UserPromptSubmit' in hooks.hooks), 'CFMS has no UserPromptSubmit hook');
  });
});

test('a CFMS answer in a project without cfms/: nothing written', () => {
  const dir = h.makeFixture(false);
  try {
    const before = h.snapshot(dir);
    silent(answer(dir, 'A real reason'));
    assert.deepStrictEqual(h.snapshot(dir), before);
  } finally {
    h.removeFixture(dir);
  }
});

for (const script of ['ask.js', 'answer.js']) {
  test(script + ': a malformed input or a corrupt state file exits 0 and prints nothing', () => {
    withFixture((dir) => {
      silent(h.runScript(script, 'not json', { CLAUDE_PROJECT_DIR: dir }));
      fs.writeFileSync(path.join(dir, 'cfms', 'state.json'), '{ broken');
      silent(script === 'ask.js' ? stop(dir) : answer(dir, 'A real reason'));
    });
  });
}

test('the plugin wires the Stop hook to ask.js and AskUserQuestion to answer.js', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(h.REPO, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.strictEqual(hooks.Stop.length, 1);
  assert.ok(hooks.Stop[0].hooks[0].command.includes('${CLAUDE_PLUGIN_ROOT}/scripts/ask.js'));
  const post = hooks.PostToolUse.filter((e) => e.matcher === 'AskUserQuestion');
  assert.strictEqual(post.length, 1);
  assert.ok(post[0].hooks[0].command.includes('${CLAUDE_PLUGIN_ROOT}/scripts/answer.js'));
  for (const f of ['ask.js', 'answer.js']) assert.ok(fs.existsSync(path.join(h.REPO, 'scripts', f)));
});

after(() => {
  // C9: every fixture is gone, and the run wrote nothing into this repo.
  assert.deepStrictEqual(h.leftovers(), [], 'fixtures left behind');
  assert.strictEqual(fs.existsSync(path.join(h.REPO, 'cfms')), repoHadCfms, 'the run touched cfms/ in this repo');
});
