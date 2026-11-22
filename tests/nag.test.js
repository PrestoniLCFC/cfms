'use strict';
// Unit 003, never a nag: at most one ask per gap (30 minutes by default), at most five
// changes per ask, "Skip" and "Not now" cost nothing, three skips in a row double the
// gap and the next ask says so, and no ask when the signs say nobody is there.
// Time comes from the input (CFMS_NOW), never from waiting.

const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

const START = Date.parse('2026-11-22T10:00:00.000Z');
// Minutes after START as an ISO time.
const M = (m) => new Date(START + m * 60000).toISOString();
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

// One Edit per relative path, a second apart, oldest first, starting at minute m.
function edit(dir, m, ...rels) {
  rels.forEach((rel, i) => {
    const obj = JSON.parse(h.input('edit.json', dir));
    obj.tool_input.file_path = path.join(dir, ...rel.split('/'));
    const at = new Date(Date.parse(M(m)) + i * 1000).toISOString();
    silent(h.runCapture(JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: at }));
  });
}

// A Stop input at minute m.
function stop(dir, m, opts) {
  const o = opts || {};
  const stdin = h.input(o.file || 'stop.json', dir);
  return h.runScript('ask.js', stdin, { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: M(m), ...(o.env || {}) });
}

// The CFMS dialog closing at minute m with this answer.
function answer(dir, m, text) {
  const obj = JSON.parse(h.input('answer-cfms.json', dir));
  for (const part of [obj.tool_input, obj.tool_response]) {
    for (const k of Object.keys(part.answers)) part.answers[k] = text;
  }
  return h.runScript('answer.js', JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: M(m) });
}

// The line the Stop hook gives, checked to be its whole output and one line.
function line(r) {
  assert.strictEqual(r.status, 0, 'exit code; stderr: ' + r.stderr);
  assert.strictEqual(r.stderr, '');
  assert.ok(r.stdout.length > 0, 'the Stop hook asked');
  assert.ok(!r.stdout.includes('\n'), 'stdout is one line');
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'Stop');
  const text = out.hookSpecificOutput.additionalContext;
  assert.ok(!/[\r\n]/.test(text), 'the line has no line break: ' + JSON.stringify(text));
  return text;
}

function checkins(dir) {
  return path.join(dir, 'cfms', 'CHECKINS.md');
}

function pendingPaths(dir) {
  return h.state(dir).pending.map((c) => c.path).sort();
}

test('C1 an ask 10 minutes after the last: nothing; changes keep collecting', () => {
  withFixture((dir) => {
    edit(dir, 1, 'a.js', 'b.js', 'c.js');
    line(stop(dir, 5));
    assert.strictEqual(h.state(dir).lastAsk, M(5));
    silent(answer(dir, 6, 'Not now'));
    edit(dir, 10, 'd.js');
    const before = h.snapshot(dir);
    silent(stop(dir, 15));
    assert.deepStrictEqual(h.snapshot(dir), before, 'nothing written inside the gap');
    assert.deepStrictEqual(pendingPaths(dir), ['a.js', 'b.js', 'c.js', 'd.js']);
  });
});

test('C2 after 31 minutes: the ask', () => {
  withFixture((dir) => {
    edit(dir, 1, 'a.js', 'b.js', 'c.js');
    line(stop(dir, 5));
    silent(answer(dir, 6, 'Not now'));
    silent(stop(dir, 34));
    const text = line(stop(dir, 36));
    assert.match(text, /^CFMS: 3 changes not yet in your words\. /);
    assert.strictEqual(h.state(dir).lastAsk, M(36), 'the time of the ask is set when the Stop hook asks');
  });
});

test('C1 C2 the time of an ask is set even when nobody answers', () => {
  withFixture((dir) => {
    edit(dir, 1, 'a.js', 'b.js', 'c.js');
    line(stop(dir, 5));
    silent(stop(dir, 20));
    line(stop(dir, 36));
  });
});

test('C3 seven pending: the ask names five, newest first; the rest wait', () => {
  withFixture((dir) => {
    edit(dir, 1, 'f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js', 'f6.js', 'f7.js');
    const text = line(stop(dir, 5));
    assert.match(text, /^CFMS: 7 changes not yet in your words\. Ask about 5, newest first: f7\.js, f6\.js, f5\.js, f4\.js, f3\.js\. Use the cfms:ask skill\.$/);
    assert.deepStrictEqual(h.state(dir).ask.paths, ['f7.js', 'f6.js', 'f5.js', 'f4.js', 'f3.js']);
    assert.strictEqual(h.state(dir).pending.length, 7);
  });
});

test('C4 "Skip": nothing saved, the asked changes leave pending marked skipped, skip count 1', () => {
  withFixture((dir) => {
    edit(dir, 1, 'f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js', 'f6.js', 'f7.js');
    line(stop(dir, 5));
    silent(answer(dir, 6, 'Skip'));
    assert.ok(!fs.existsSync(checkins(dir)), 'nothing saved');
    const s = h.state(dir);
    assert.deepStrictEqual(s.pending.map((c) => c.path), ['f1.js', 'f2.js']);
    assert.deepStrictEqual(s.skipped.map((c) => c.path).sort(), ['f3.js', 'f4.js', 'f5.js', 'f6.js', 'f7.js']);
    for (const c of s.skipped) assert.strictEqual(c.skipped, M(6));
    assert.strictEqual(s.skips, 1);
    assert.strictEqual(s.ask, undefined);
  });
});

test('C4 skipped changes are never asked about again and never count as in his words', () => {
  withFixture((dir) => {
    edit(dir, 1, 'a.js', 'b.js', 'c.js');
    line(stop(dir, 5));
    silent(answer(dir, 6, 'Skip'));
    edit(dir, 10, 'd.js', 'e.js', 'f.js');
    const text = line(stop(dir, 40));
    assert.doesNotMatch(text, /\b[abc]\.js/);
    assert.match(text, /f\.js, e\.js, d\.js/);
    answer(dir, 41, 'Because the old layout hid the errors');
    const saved = fs.readFileSync(checkins(dir), 'utf8');
    assert.match(saved, /^Changes: f\.js, e\.js, d\.js$/m);
    assert.doesNotMatch(saved, /\b[abc]\.js/);
    assert.deepStrictEqual(h.state(dir).skipped.map((c) => c.path).sort(), ['a.js', 'b.js', 'c.js']);
  });
});

test('C4b "Not now": nothing saved, pending kept, skip count 1', () => {
  withFixture((dir) => {
    edit(dir, 1, 'a.js', 'b.js', 'c.js');
    line(stop(dir, 5));
    silent(answer(dir, 6, 'Not now'));
    assert.ok(!fs.existsSync(checkins(dir)), 'nothing saved');
    const s = h.state(dir);
    assert.deepStrictEqual(pendingPaths(dir), ['a.js', 'b.js', 'c.js']);
    assert.strictEqual(s.skipped, undefined);
    assert.strictEqual(s.skips, 1);
    assert.strictEqual(s.ask, undefined);
    assert.match(line(stop(dir, 36)), /c\.js, b\.js, a\.js/, 'asked again at the next ask');
  });
});

test('C5 the third skip in a row: the gap 60, and the next ask carries the line', () => {
  withFixture((dir) => {
    edit(dir, 0, 'a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'i.js');
    line(stop(dir, 1));
    silent(answer(dir, 2, 'Not now'));
    line(stop(dir, 32));
    silent(answer(dir, 33, 'Skip'));
    const third = line(stop(dir, 63));
    assert.doesNotMatch(third, /skipped/, 'no line before the third skip');
    silent(answer(dir, 64, 'Not now'));
    const s = h.state(dir);
    assert.strictEqual(s.skips, 3);
    assert.strictEqual(s.tell, true);
    // The gap is now 60: nothing at 93 or 122, the ask at 123.
    silent(stop(dir, 93));
    silent(stop(dir, 122));
    const next = line(stop(dir, 123));
    assert.match(next, /^CFMS: You skipped three times, so I now ask every 60 minutes\. \d+ changes not yet in your words\./);
    assert.strictEqual(h.state(dir).tell, undefined, 'said once');
    // Said only by the ask after the doubling.
    silent(answer(dir, 124, 'Not now'));
    assert.doesNotMatch(line(stop(dir, 184)), /skipped/);
  });
});

test('C5 six skips in a row: the gap 120, said once more', () => {
  withFixture((dir) => {
    edit(dir, 0, 'a.js', 'b.js', 'c.js');
    const lines = [];
    for (const m of [1, 31, 61, 121, 181, 241]) {
      lines.push(line(stop(dir, m)));
      silent(answer(dir, m + 1, 'Not now'));
    }
    assert.match(lines[3], /^CFMS: You skipped three times, so I now ask every 60 minutes\. /);
    for (const i of [0, 1, 2, 4, 5]) assert.doesNotMatch(lines[i], /skipped/);
    assert.strictEqual(h.state(dir).skips, 6);
    silent(stop(dir, 360));
    assert.match(line(stop(dir, 361)), /^CFMS: You skipped three times, so I now ask every 120 minutes\. /);
  });
});

test('C6 an answer: skip count 0, gap 30', () => {
  withFixture((dir) => {
    edit(dir, 0, 'a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'i.js');
    for (const m of [1, 31, 61]) {
      line(stop(dir, m));
      silent(answer(dir, m + 1, 'Not now'));
    }
    assert.strictEqual(h.state(dir).skips, 3);
    line(stop(dir, 121));
    const r = answer(dir, 122, 'The names now match the screens he sees');
    assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, 'Saved to cfms/CHECKINS.md');
    const s = h.state(dir);
    assert.strictEqual(s.skips, 0);
    assert.strictEqual(s.tell, undefined);
    // The gap is 30 again: nothing at 150, the ask at 151, with no skip line.
    silent(stop(dir, 150));
    assert.doesNotMatch(line(stop(dir, 151)), /skipped/);
  });
});

test('C6 an answer after the doubling but before the next ask: no skip line', () => {
  withFixture((dir) => {
    edit(dir, 0, 'a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'i.js');
    for (const m of [1, 31, 61]) {
      line(stop(dir, m));
      silent(answer(dir, m + 1, 'Not now'));
    }
    answer(dir, 70, 'A real reason');
    assert.doesNotMatch(line(stop(dir, 121)), /skipped/);
  });
});

test('C7 CFMS_QUIET=1: no ask, pending kept', () => {
  withFixture((dir) => {
    edit(dir, 1, 'a.js', 'b.js', 'c.js');
    const before = h.snapshot(dir);
    silent(stop(dir, 5, { env: { CFMS_QUIET: '1' } }));
    assert.deepStrictEqual(h.snapshot(dir), before);
    assert.deepStrictEqual(pendingPaths(dir), ['a.js', 'b.js', 'c.js']);
    // Quiet costs no gap: without it the ask comes at once.
    line(stop(dir, 6));
  });
});

test('C8 a Stop input with a background task or a session cron: no ask, pending kept', () => {
  withFixture((dir) => {
    edit(dir, 1, 'a.js', 'b.js', 'c.js');
    const busy = JSON.parse(h.input('stop-busy.json', dir));
    const run = (obj) => h.runScript('ask.js', JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: M(5) });
    const before = h.snapshot(dir);
    for (const c of [busy, { ...busy, session_crons: [] }, { ...busy, background_tasks: [] }]) silent(run(c));
    assert.deepStrictEqual(h.snapshot(dir), before);
    assert.deepStrictEqual(pendingPaths(dir), ['a.js', 'b.js', 'c.js']);
    // Both empty, as the docs say when nothing is in flight: the ask.
    line(run({ ...busy, background_tasks: [], session_crons: [] }));
  });
});

test('C8b the Stop hook\'s output is one line, naming the skill', () => {
  withFixture((dir) => {
    edit(dir, 1, 'a.js', 'b.js', 'c.js', 'd.js');
    const text = line(stop(dir, 5));
    assert.strictEqual(text, 'CFMS: 4 changes not yet in your words. Ask about 4, newest first: d.js, c.js, b.js, a.js. Use the cfms:ask skill.');
  });
});

test('C8b the instructions for how Claude asks are in the cfms:ask skill, not in the line', () => {
  const skill = fs.readFileSync(path.join(h.REPO, 'skills', 'ask', 'SKILL.md'), 'utf8');
  const front = skill.split('---')[1];
  assert.match(front, /^name: ask$/m);
  assert.match(front, /^user-invocable: false$/m);
  assert.doesNotMatch(front, /disable-model-invocation/, 'Claude must be able to invoke it');
  assert.match(front, /Use the cfms:ask skill/);
  assert.match(skill, /AskUserQuestion/);
  assert.match(skill, /header: "CFMS"/);
  assert.match(skill, /"Skip" \(description "Save nothing and never ask about these again"\) and "Not now" \(description "Save nothing now and ask again later"\)/);
  assert.match(skill, /free text box/);
  assert.match(skill, /next session/);
  assert.match(skill, /Never write the line for the user/);
  assert.match(skill, /begins with that same sentence/);
});

test('the gap setting: CFMS_GAP_MINUTES=1 asks a minute later; unset or nonsense means 30', () => {
  withFixture((dir) => {
    edit(dir, 0, 'a.js', 'b.js', 'c.js');
    const one = { env: { CFMS_GAP_MINUTES: '1' } };
    line(stop(dir, 1, one));
    silent(answer(dir, 1.5, 'Not now'));
    line(stop(dir, 2, one));
    silent(stop(dir, 3, { env: { CFMS_GAP_MINUTES: 'soon' } }));
    silent(stop(dir, 31));
    line(stop(dir, 32));
  });
});

test('the nag test, as the walk does it: gap 1 minute, three skips, it says it will ask less', () => {
  withFixture((dir) => {
    edit(dir, 0, 'a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'i.js', 'j.js', 'k.js', 'l.js', 'm.js', 'n.js', 'o.js', 'p.js', 'q.js', 'r.js');
    const one = { env: { CFMS_GAP_MINUTES: '1' } };
    for (const m of [1, 2, 3]) {
      line(stop(dir, m, one));
      silent(answer(dir, m + 0.5, 'Skip'));
    }
    silent(stop(dir, 4.5, one));
    assert.match(line(stop(dir, 5, one)), /^CFMS: You skipped three times, so I now ask every 2 minutes\. /);
  });
});

test('another dialog\'s "Skip" counts nothing', () => {
  withFixture((dir) => {
    edit(dir, 1, 'a.js', 'b.js', 'c.js');
    line(stop(dir, 5));
    const obj = JSON.parse(h.input('answer-other.json', dir));
    for (const part of [obj.tool_input, obj.tool_response]) {
      for (const k of Object.keys(part.answers)) part.answers[k] = 'Skip';
    }
    const before = h.snapshot(dir);
    silent(h.runScript('answer.js', JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: M(6) }));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('Skip and an ask in a project without cfms/: nothing written', () => {
  const dir = h.makeFixture(false);
  try {
    const before = h.snapshot(dir);
    silent(answer(dir, 1, 'Skip'));
    silent(stop(dir, 1, { env: { CFMS_GAP_MINUTES: '0' } }));
    assert.deepStrictEqual(h.snapshot(dir), before);
  } finally {
    h.removeFixture(dir);
  }
});

after(() => {
  // C9: every fixture is gone, and the run wrote nothing into this repo.
  assert.deepStrictEqual(h.leftovers(), [], 'fixtures left behind');
  assert.strictEqual(fs.existsSync(path.join(h.REPO, 'cfms')), repoHadCfms, 'the run touched cfms/ in this repo');
});
