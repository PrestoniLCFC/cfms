'use strict';
// Unit 004, the return: after a gap, or before his first line in NOW.md, the session
// start context has Claude ask in the CFMS dialog what the project is for, then show
// his last lines verbatim and what changed since. Within the gap: one line of counts.
// His recall answer is saved only through the dialog, to the top of cfms/NOW.md.
// Time comes from the input (CFMS_NOW), never from waiting.

const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const lib = require('../scripts/lib');

const AT_MS = Date.parse('2026-11-22T12:00:00.000Z');
const AT = new Date(AT_MS).toISOString();
// Hours (and minutes) before AT as an ISO time.
const H = (hours, minutes) => new Date(AT_MS - hours * 3600000 - (minutes || 0) * 60000).toISOString();
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

function context(r, event) {
  assert.strictEqual(r.status, 0, 'exit code; stderr: ' + r.stderr);
  assert.strictEqual(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, event);
  const text = out.hookSpecificOutput.additionalContext;
  if (event !== 'SessionStart') return text;
  // Unit 005 adds the decisions part after the return; these tests read the return only.
  const cut = text.indexOf('\n\nCFMS decisions');
  assert.ok(cut > 0, 'the decisions part follows the return');
  return text.slice(0, cut);
}

// One Edit per relative path, a second apart, oldest first, from time at.
function edit(dir, at, ...rels) {
  rels.forEach((rel, i) => {
    const obj = JSON.parse(h.input('edit.json', dir));
    obj.tool_input.file_path = path.join(dir, ...rel.split('/'));
    const t = new Date(Date.parse(at) + i * 1000).toISOString();
    silent(h.runCapture(JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: t }));
  });
}

function fill(obj, text) {
  for (const part of [obj.tool_input, obj.tool_response]) {
    for (const k of Object.keys(part.answers)) part.answers[k] = text;
  }
  return JSON.stringify(obj);
}

// The check in dialog (002) closing at time at with this text.
function checkin(dir, at, text) {
  return h.runScript('answer.js', fill(JSON.parse(h.input('answer-cfms.json', dir)), text), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: at });
}

// The recall dialog closing at time at with this text.
function recall(dir, at, text) {
  return h.runScript('answer.js', fill(JSON.parse(h.input('answer-recall.json', dir)), text), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: at });
}

// A SessionStart input at time at.
function start(dir, at, change, env) {
  const obj = JSON.parse(h.input('session-start.json', dir));
  if (change) change(obj);
  return h.runScript('start.js', JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: at || AT, ...(env || {}) });
}

function nowBytes(dir) {
  return fs.readFileSync(path.join(dir, 'cfms', 'NOW.md'));
}

function isRecall(text) {
  assert.match(text, /^CFMS recall\. /);
  assert.ok(text.includes('"Show my notes"') && text.includes('"Not now"'), 'the two options');
  assert.ok(text.length < 1500, 'under 1,500 characters: ' + text.length);
}

test('C1 last activity 2 days ago: the recall instruction and his last lines byte for byte; nothing written', () => {
  withFixture(true, (dir) => {
    const said = 'He said "keep it simple" \u{1F642}\ncafé, Zürich';
    const now = 'A plugin that keeps my reasons, so I can pick a project back up';
    edit(dir, H(49), 'src/a.js', 'src/b.js', 'src/c.js');
    context(checkin(dir, H(48), said), 'PostToolUse');
    assert.strictEqual(context(recall(dir, H(48, -1), now), 'PostToolUse'), 'Saved to cfms/NOW.md');
    edit(dir, H(47), 'src/d.js', 'src/e.js');
    const before = h.snapshot(dir);
    const text = context(start(dir), 'SessionStart');
    isRecall(text);
    assert.ok(text.includes('NOW.md, 2026-11-20 12:01 UTC:\n' + now), 'the NOW line, dated, byte for byte');
    assert.ok(text.includes('Check in, 2026-11-20 12:00 UTC:\n' + said), 'the check in, dated, byte for byte');
    assert.ok(text.indexOf(now) < text.indexOf(said), 'NOW first');
    assert.ok(text.endsWith('\nChanged since: 2 changes not yet in the user\'s words, newest: src/e.js, src/d.js.'), text);
    assert.deepStrictEqual(h.snapshot(dir), before, 'the session start hook writes nothing');
  });
});

test('C2 last activity 1 hour ago: the one line only', () => {
  withFixture(true, (dir) => {
    context(recall(dir, H(2), 'What it is for'), 'PostToolUse');
    edit(dir, H(1, 3), 'src/a.js', 'src/b.js', 'src/c.js');
    context(checkin(dir, H(1, 2), 'Why those'), 'PostToolUse');
    edit(dir, H(1), 'd.js', 'e.js', 'f.js', 'g.js');
    const before = h.snapshot(dir);
    const r = start(dir);
    assert.ok(!r.stdout.includes('\n'), 'stdout is one line');
    assert.strictEqual(context(r, 'SessionStart'), 'CFMS: 4 changes not yet in your words; 3 of 7 this week are.');
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C2 the gap is 8 hours: 7 hours 59 gives the line, 8 hours the recall', () => {
  withFixture(true, (dir) => {
    context(recall(dir, H(8), 'What it is for'), 'PostToolUse');
    assert.strictEqual(context(start(dir, H(0, 1)), 'SessionStart'), 'CFMS: 0 changes not yet in your words; none this week.');
    isRecall(context(start(dir, AT), 'SessionStart'));
  });
});

test('C2 this week: check ins older than seven days are left out; skipped changes count in the whole', () => {
  withFixture(true, (dir) => {
    edit(dir, H(8 * 24, 1), 'a.js', 'b.js', 'c.js');
    context(checkin(dir, H(8 * 24), 'Old reason'), 'PostToolUse');
    edit(dir, H(3 * 24, 1), 'd.js', 'e.js', 'f.js');
    silent(checkin(dir, H(3 * 24), 'Skip'));
    edit(dir, H(2 * 24, 1), 'g.js', 'h.js', 'i.js');
    context(checkin(dir, H(2 * 24), 'Newer reason'), 'PostToolUse');
    context(recall(dir, H(1, 1), 'What it is for'), 'PostToolUse');
    edit(dir, H(1), 'j.js');
    assert.strictEqual(context(start(dir), 'SessionStart'), 'CFMS: 1 change not yet in your words; 3 of 7 this week are.');
  });
});

test('within the gap but no NOW.md line yet: the recall', () => {
  withFixture(true, (dir) => {
    edit(dir, H(1, 1), 'src/a.js', 'src/b.js', 'src/c.js');
    context(checkin(dir, H(1), 'A reason'), 'PostToolUse');
    const text = context(start(dir), 'SessionStart');
    isRecall(text);
    assert.ok(text.includes('Check in, 2026-11-22 11:00 UTC:\nA reason'));
  });
});

test('C3 no cfms/: nothing printed, nothing written', () => {
  withFixture(false, (dir) => {
    const before = h.snapshot(dir);
    silent(start(dir));
    silent(start(dir, AT, null, { CLAUDE_PROJECT_DIR: undefined }));
    assert.deepStrictEqual(h.snapshot(dir), before);
    assert.ok(!fs.existsSync(path.join(dir, 'cfms')));
  });
});

test('C4 an empty cfms/: the recall, no error, the git log for what changed, nothing written', () => {
  withFixture(false, (dir) => {
    fs.mkdirSync(path.join(dir, 'cfms'));
    const before = h.snapshot(dir);
    const text = context(start(dir), 'SessionStart');
    isRecall(text);
    assert.ok(text.includes('No lines saved yet: after the answer, read the recent git log yourself'));
    assert.ok(text.endsWith('\nChanged since: 0 changes not yet in the user\'s words.'));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C5 200 check ins and long paths: under 1,500 characters, the newest three whole', () => {
  withFixture(true, (dir) => {
    for (let i = 199; i >= 0; i--) {
      lib.appendCheckin(dir, H(72, i), ['src/a' + i + '.js', 'src/b' + i + '.js'], 'Check in number ' + i + ': ' + 'because it reads better '.repeat(4).trim());
    }
    lib.prependNow(dir, H(72, 300), 'An older line about what the project is for');
    const long = 'deep/' + 'folder/'.repeat(30);
    edit(dir, H(71), ...[1, 2, 3, 4, 5, 6, 7].map((i) => long + 'f' + i + '.js'));
    const text = context(start(dir), 'SessionStart');
    isRecall(text);
    for (const i of [0, 1, 2]) assert.ok(text.includes('Check in number ' + i + ': because it reads better because'), 'check in ' + i);
    assert.ok(!text.includes('Check in number 3:'), 'three check ins at most');
    assert.ok(text.includes('An older line about what the project is for'));
    assert.match(text, /Changed since: 7 changes not yet in the user's words/);
  });
});

test('C5 a line too long to fit is never cut: Claude is told to read the file', () => {
  withFixture(true, (dir) => {
    const huge = Array.from({ length: 400 }, (_, i) => 'w' + i).join(' ');
    context(recall(dir, H(30), huge), 'PostToolUse');
    edit(dir, H(29, 1), 'src/a.js', 'src/b.js', 'src/c.js');
    context(checkin(dir, H(29), 'A short reason'), 'PostToolUse');
    const text = context(start(dir), 'SessionStart');
    isRecall(text);
    assert.ok(!text.includes('w0 w1'), 'no part of the long line');
    assert.ok(text.includes('read cfms/NOW.md yourself'));
    assert.ok(!text.includes('cfms/CHECKINS.md yourself'));
    assert.ok(text.includes('Check in, 2026-11-21 07:00 UTC:\nA short reason'));
  });
});

test('C6 his recall answer lands in NOW.md byte for byte, dated, newest first; pending and skips untouched', () => {
  withFixture(true, (dir) => {
    edit(dir, H(3), 'src/a.js', 'src/b.js', 'src/c.js');
    const stateBefore = h.state(dir);
    const first = 'It\'s "the record" \u{1F642}\r\ncafé, naïve, señor';
    assert.strictEqual(context(recall(dir, H(2), first + '  \n'), 'PostToolUse'), 'Saved to cfms/NOW.md');
    const b1 = nowBytes(dir);
    assert.ok(b1.includes(Buffer.from('\n\n' + first + '\n', 'utf8')), 'his words byte for byte');
    const t1 = b1.toString('utf8');
    assert.strictEqual(t1.split('\n')[0], '<!-- CFMS NOW format 1 -->', 'first line names the format');
    assert.match(t1, /^## 2026-11-22 10:00 UTC$/m);
    context(recall(dir, H(1), 'Second answer'), 'PostToolUse');
    const b2 = nowBytes(dir);
    const t2 = b2.toString('utf8');
    assert.ok(t2.indexOf('Second answer') < t2.indexOf('the record'), 'newest first');
    assert.strictEqual(t2.match(/format 1/g).length, 1, 'the format line once');
    const headLen = t1.indexOf('\n## ');
    assert.ok(b2.subarray(b2.length - (b1.length - headLen)).equals(b1.subarray(headLen)), 'the older entries kept byte for byte');
    // Unit 008: the recall counts as an ask, so only the time of the last ask changes.
    const stateAfter = h.state(dir);
    assert.strictEqual(stateAfter.lastAsk, H(1));
    assert.deepStrictEqual({ ...stateAfter, lastAsk: undefined }, { ...stateBefore, lastAsk: undefined }, 'pending and skips untouched');
    assert.ok(!fs.existsSync(path.join(dir, 'cfms', 'CHECKINS.md')));
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'cfms')).sort(), ['.gitignore', 'NOW.md', 'state.json'], 'no temp file left');
    assert.deepStrictEqual(lib.readEntries(path.join(dir, 'cfms', 'NOW.md'), true).map((e) => e.text), ['Second answer', first]);
  });
});

for (const text of ['Show my notes', 'Not now', 'not now', '', '   ', 'yes', 'OK.']) {
  test('C6 the recall closing on "' + text + '": nothing saved, no skip counted, pending kept', () => {
    withFixture(true, (dir) => {
      edit(dir, H(3), 'src/a.js', 'src/b.js', 'src/c.js');
      const before = h.snapshot(dir);
      const stateBefore = h.state(dir);
      silent(recall(dir, H(2), text));
      // Unit 008: only the time of the last ask changes in the state file.
      const after = h.snapshot(dir);
      assert.deepStrictEqual({ ...after, 'cfms/state.json': null }, { ...before, 'cfms/state.json': null }, 'nothing saved');
      assert.deepStrictEqual(h.state(dir), { ...stateBefore, lastAsk: H(2) });
    });
  });
}

test('C6 the check in dialog is not the recall: its answer still goes to CHECKINS.md, not NOW.md', () => {
  withFixture(true, (dir) => {
    edit(dir, H(3), 'src/a.js', 'src/b.js', 'src/c.js');
    context(checkin(dir, H(2), 'A reason'), 'PostToolUse');
    assert.ok(!fs.existsSync(path.join(dir, 'cfms', 'NOW.md')));
    assert.ok(fs.existsSync(path.join(dir, 'cfms', 'CHECKINS.md')));
  });
});

test('the recall answer in a project without cfms/: nothing written', () => {
  withFixture(false, (dir) => {
    const before = h.snapshot(dir);
    silent(recall(dir, H(2), 'A real line'));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('R1 resume and compact add the context; clear, fork and other events add nothing', () => {
  withFixture(true, (dir) => {
    isRecall(context(start(dir, AT, (o) => { o.source = 'resume'; }), 'SessionStart'));
    // Unit 008, R1: after a compact the counts line, never the recall.
    assert.strictEqual(context(start(dir, AT, (o) => { o.source = 'compact'; }), 'SessionStart'), 'CFMS: 0 changes not yet in your words; none this week.');
    for (const source of ['clear', 'fork', undefined]) silent(start(dir, AT, (o) => { o.source = source; }));
    silent(start(dir, AT, (o) => { o.hook_event_name = 'Stop'; }));
  });
});

test('without CLAUDE_PROJECT_DIR the project comes from the input cwd', () => {
  withFixture(true, (dir) => {
    isRecall(context(start(dir, AT, null, { CLAUDE_PROJECT_DIR: undefined }), 'SessionStart'));
  });
});

test('a malformed input or a corrupt state file: exit 0, prints nothing, writes nothing', () => {
  withFixture(true, (dir) => {
    silent(h.runScript('start.js', 'not json', { CLAUDE_PROJECT_DIR: dir }));
    silent(h.runScript('start.js', '', { CLAUDE_PROJECT_DIR: dir }));
    fs.writeFileSync(path.join(dir, 'cfms', 'state.json'), '{ broken');
    const before = h.snapshot(dir);
    silent(start(dir));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('R6 /cfms:on ends with the recall, the first time and every time after; running it again changes nothing', () => {
  withFixture(false, (dir) => {
    const r1 = h.runOn(dir, undefined, { CFMS_NOW: AT });
    assert.strictEqual(r1.status, 0);
    const lines = r1.stdout.split(/\r?\n/);
    assert.match(lines[0], /^CFMS is on in /);
    const at = r1.stdout.indexOf('CFMS recall. ');
    assert.ok(at > 0, 'the recall follows the on line');
    isRecall(r1.stdout.slice(at).trim());
    assert.ok(r1.stdout.includes('No lines saved yet'));

    context(recall(dir, H(1), 'What it is for'), 'PostToolUse');
    const before = h.snapshot(dir);
    const r2 = h.runOn(dir, undefined, { CFMS_NOW: AT });
    assert.match(r2.stdout, /^CFMS is already on in /);
    assert.ok(r2.stdout.includes('CFMS recall. '), 'asked again although on and within the gap');
    assert.ok(r2.stdout.includes('NOW.md, 2026-11-22 11:00 UTC:\nWhat it is for'));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('the plugin wires SessionStart to start.js on startup, resume and compact; the on skill asks the recall', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(h.REPO, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.strictEqual(hooks.SessionStart.length, 1);
  assert.deepStrictEqual(hooks.SessionStart[0].matcher.split('|').sort(), ['compact', 'resume', 'startup']);
  assert.ok(hooks.SessionStart[0].hooks[0].command.includes('${CLAUDE_PLUGIN_ROOT}/scripts/start.js'));
  assert.ok(fs.existsSync(path.join(h.REPO, 'scripts', 'start.js')));
  const skill = fs.readFileSync(path.join(h.REPO, 'skills', 'on', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('"CFMS recall"'));
});

after(() => {
  // C7: every fixture is gone, and the run wrote nothing into this repo.
  assert.deepStrictEqual(h.leftovers(), [], 'fixtures left behind');
  assert.strictEqual(fs.existsSync(path.join(h.REPO, 'cfms')), repoHadCfms, 'the run touched cfms/ in this repo');
});
