'use strict';
// Unit 008, the walk fixes: after a compact there is no recall question, only the counts
// line and the decisions part; the recall dialog counts as an ask for 003's gap,
// whatever he picks, and is never a skip; the README opens with the one line install.
// Time comes from the input (CFMS_NOW), never from waiting.

const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const lib = require('../scripts/lib');

const T = Date.parse('2026-11-22T10:00:00.000Z');
// Minutes after T, and hours before T, as ISO times.
const M = (m) => new Date(T + m * 60000).toISOString();
const H = (hours) => new Date(T - hours * 3600000).toISOString();
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
  return out.hookSpecificOutput.additionalContext;
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

function dialog(name, dir, at, text) {
  return h.runScript('answer.js', fill(JSON.parse(h.input(name, dir)), text), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: at });
}
const recall = (dir, at, text) => dialog('answer-recall.json', dir, at, text);
const checkin = (dir, at, text) => dialog('answer-cfms.json', dir, at, text);
const rule = (dir, at, text) => dialog('answer-rule.json', dir, at, text);

function start(dir, at, source) {
  const obj = JSON.parse(h.input('session-start.json', dir));
  obj.source = source;
  return h.runScript('start.js', JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: at });
}

function stop(dir, at) {
  return h.runScript('ask.js', h.input('stop.json', dir), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: at });
}

// The Stop hook's one line, checked to be the ask.
function asks(r) {
  const text = context(r, 'Stop');
  assert.match(text, /^CFMS: (You skipped three times, so I now ask every \d+ minutes\. )?\d+ changes not yet in your words\. /);
  return text;
}

// The session start text split into the return and the decisions part.
function parts(text) {
  const cut = text.indexOf('\n\nCFMS decisions');
  assert.ok(cut > 0, 'the decisions part follows the return');
  return { ret: text.slice(0, cut), dec: text.slice(cut + 2) };
}

const RULE = 'Never ask twice in one turn; it\'s "a nag" \u{1F642} naïve';
const PICKS = ['The record of why, in my own words', 'Show my notes', 'Not now'];

test('C1 a compact 2 days after the last answer: no recall, the counts line, the decisions part as at startup; nothing written', () => {
  withFixture(true, (dir) => {
    edit(dir, H(49), 'src/a.js', 'src/b.js', 'src/c.js');
    context(checkin(dir, H(48), 'Why those three'), 'PostToolUse');
    context(recall(dir, H(48), 'What it is for'), 'PostToolUse');
    edit(dir, H(47), 'src/d.js', 'src/e.js');
    context(rule(dir, H(47), RULE), 'PostToolUse');
    const before = h.snapshot(dir);
    const text = context(start(dir, M(0), 'compact'), 'SessionStart');
    assert.ok(!text.includes('CFMS recall'), 'no recall instruction');
    assert.ok(!text.includes('AskUserQuestion'), 'no dialog asked for');
    const p = parts(text);
    assert.strictEqual(p.ret, 'CFMS: 2 changes not yet in your words; 3 of 5 this week are.');
    assert.strictEqual(p.dec, lib.decisionsContext(dir), 'the decisions part exactly as 005 built it');
    assert.ok(p.dec.includes('Standing rule, 2026-11-20 11:00 UTC:\n' + RULE), 'the rule byte for byte');
    assert.strictEqual(parts(context(start(dir, M(0), 'startup'), 'SessionStart')).dec, p.dec, 'the same part as at startup');
    assert.deepStrictEqual(h.snapshot(dir), before, 'the session start hook writes nothing');
  });
});

test('C2 a compact with an empty NOW.md: no recall instruction, the counts line', () => {
  withFixture(true, (dir) => {
    edit(dir, M(-5), 'src/a.js', 'src/b.js', 'src/c.js');
    const text = context(start(dir, M(0), 'compact'), 'SessionStart');
    assert.ok(!text.includes('CFMS recall'));
    assert.strictEqual(parts(text).ret, 'CFMS: 3 changes not yet in your words; 0 of 3 this week are.');
    assert.ok(!fs.existsSync(path.join(dir, 'cfms', 'NOW.md')));
  });
  withFixture(false, (dir) => {
    fs.mkdirSync(path.join(dir, 'cfms'));
    const before = h.snapshot(dir);
    const text = context(start(dir, M(0), 'compact'), 'SessionStart');
    assert.ok(!text.includes('CFMS recall'), 'an empty cfms/ after a compact: no recall');
    assert.strictEqual(parts(text).ret, 'CFMS: 0 changes not yet in your words; none this week.');
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C3 startup and resume 2 days after the last answer: the recall instruction, as before', () => {
  withFixture(true, (dir) => {
    context(recall(dir, H(48), 'What it is for'), 'PostToolUse');
    for (const source of ['startup', 'resume']) {
      const ret = parts(context(start(dir, M(0), source), 'SessionStart')).ret;
      assert.match(ret, /^CFMS recall\. /, source);
      assert.ok(ret.includes('NOW.md, 2026-11-20 10:00 UTC:\nWhat it is for'), source);
    }
    // And within the gap, the line, as before.
    context(recall(dir, M(-60), 'Still what it is for'), 'PostToolUse');
    for (const source of ['startup', 'resume']) {
      assert.match(parts(context(start(dir, M(0), source), 'SessionStart')).ret, /^CFMS: 0 changes not yet in your words; /, source);
    }
  });
});

for (const pick of PICKS) {
  test('C4 C6 the recall answered with "' + pick + '": a Stop with three pending 10 minutes later does not ask; 31 minutes later it does', () => {
    withFixture(true, (dir) => {
      edit(dir, M(0), 'src/a.js', 'src/b.js', 'src/c.js');
      recall(dir, M(1), pick);
      assert.strictEqual(h.state(dir).lastAsk, M(1), 'the time of the last ask is the recall');
      const before = h.snapshot(dir);
      silent(stop(dir, M(11)));
      assert.deepStrictEqual(h.snapshot(dir), before, 'nothing written inside the gap');
      silent(stop(dir, M(30.9)));
      asks(stop(dir, M(32)));
      assert.strictEqual(h.state(dir).lastAsk, M(32));
    });
  });
}

for (const pick of ['', '   ', 'yes', 'OK.']) {
  test('C4 the recall closing on "' + pick + '" counts as the ask too, and saves nothing', () => {
    withFixture(true, (dir) => {
      edit(dir, M(0), 'src/a.js', 'src/b.js', 'src/c.js');
      silent(recall(dir, M(1), pick));
      assert.strictEqual(h.state(dir).lastAsk, M(1));
      assert.ok(!fs.existsSync(path.join(dir, 'cfms', 'NOW.md')));
      silent(stop(dir, M(11)));
    });
  });
}

test('C4 the recall from /cfms:on counts as the ask', () => {
  withFixture(false, (dir) => {
    const r = h.runOn(dir, undefined, { CFMS_NOW: M(0) });
    assert.ok(r.stdout.includes('CFMS recall. '));
    edit(dir, M(1), 'src/a.js', 'src/b.js', 'src/c.js');
    assert.strictEqual(context(recall(dir, M(2), 'A plugin that keeps my reasons'), 'PostToolUse'), 'Saved to cfms/NOW.md');
    silent(stop(dir, M(12)));
    asks(stop(dir, M(33)));
  });
});

test('C4 the return as the walk does it: 8 hours away, three pending, recall answered from memory: no second box at the end of that turn', () => {
  withFixture(true, (dir) => {
    context(recall(dir, H(9), 'What it is for'), 'PostToolUse');
    edit(dir, H(8.5), 'src/a.js', 'src/b.js', 'src/c.js', 'src/d.js');
    assert.match(parts(context(start(dir, M(0), 'startup'), 'SessionStart')).ret, /^CFMS recall\. /);
    context(recall(dir, M(1), 'From memory: the record of why'), 'PostToolUse');
    silent(stop(dir, M(2)));
    // Then /compact in the same session: no recall box.
    assert.ok(!context(start(dir, M(3), 'compact'), 'SessionStart').includes('CFMS recall'));
  });
});

for (const pick of PICKS) {
  test('C5 the recall answered with "' + pick + '" leaves the skip count, the pending and skipped lists, the ask and the skip line as they were', () => {
    withFixture(true, (dir) => {
      edit(dir, M(0), 'a.js', 'b.js', 'c.js');
      asks(stop(dir, M(1)));
      silent(checkin(dir, M(2), 'Skip'));
      edit(dir, M(3), 'd.js', 'e.js', 'f.js');
      asks(stop(dir, M(33)));
      silent(checkin(dir, M(34), 'Not now'));
      edit(dir, M(35), 'g.js');
      asks(stop(dir, M(65)));
      silent(checkin(dir, M(66), 'Not now'));
      // Three skips in a row: the skip line is owed to the next ask.
      const first = h.state(dir);
      assert.strictEqual(first.skips, 3);
      assert.strictEqual(first.tell, true);
      assert.ok(first.skipped.length === 3 && first.pending.length === 4);
      recall(dir, M(67), pick);
      const second = h.state(dir);
      assert.strictEqual(second.lastAsk, M(67));
      assert.deepStrictEqual({ ...second, lastAsk: first.lastAsk }, first, 'only the time of the last ask changed');
      // An ask left open, so state.ask is there too; the doubled gap of 60 counts from the recall.
      edit(dir, M(70), 'h.js');
      silent(stop(dir, M(126)));
      assert.match(asks(stop(dir, M(130))), /^CFMS: You skipped three times, so I now ask every 60 minutes\. /, 'the skip line still comes');
      const before = h.state(dir);
      assert.ok(before.ask && before.pending.length === 5);
      recall(dir, M(131), pick);
      const after = h.state(dir);
      assert.strictEqual(after.lastAsk, M(131));
      assert.deepStrictEqual({ ...after, lastAsk: before.lastAsk }, before, 'only the time of the last ask changed');
      assert.ok(!fs.existsSync(path.join(dir, 'cfms', 'CHECKINS.md')), 'nothing saved as a check in');
    });
  });
}

test('C5 the recall in a project with cfms/ but no state file makes one holding only the time', () => {
  withFixture(false, (dir) => {
    fs.mkdirSync(path.join(dir, 'cfms'));
    silent(recall(dir, M(1), 'Not now'));
    const s = h.state(dir);
    assert.strictEqual(s.lastAsk, M(1));
    assert.deepStrictEqual(s.pending, []);
    assert.strictEqual(s.skips, undefined);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'cfms')).sort(), ['state.json'], 'no temp file left');
  });
});

test('a corrupt state file: his recall line is still saved and reported; the state file is left as found', () => {
  withFixture(true, (dir) => {
    fs.writeFileSync(path.join(dir, 'cfms', 'state.json'), '{ broken');
    assert.strictEqual(context(recall(dir, M(1), 'What it is for'), 'PostToolUse'), 'Saved to cfms/NOW.md');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'cfms', 'state.json'), 'utf8'), '{ broken');
    assert.ok(fs.readFileSync(path.join(dir, 'cfms', 'NOW.md'), 'utf8').includes('\n\nWhat it is for\n'));
    silent(recall(dir, M(2), 'Not now'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'cfms', 'state.json'), 'utf8'), '{ broken');
  });
});

test('the recall in a project without cfms/: nothing written', () => {
  withFixture(false, (dir) => {
    const before = h.snapshot(dir);
    for (const pick of PICKS) silent(recall(dir, M(1), pick));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('C7 the README\'s install section opens with the one line form and the version sentence; the two lines follow', () => {
  const readme = fs.readFileSync(path.join(h.REPO, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const plugin = JSON.parse(fs.readFileSync(path.join(h.REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(h.REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const from = readme.indexOf('## Install in Claude Code\n');
  assert.ok(from >= 0);
  const section = readme.slice(from, readme.indexOf('\n## ', from + 1));
  const blocks = [...section.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1].split('\n').filter(Boolean));
  const one = '/plugin install ' + plugin.name + ' --marketplace ' + h.GITHUB;
  assert.deepStrictEqual(blocks[0], [one], 'the first install line is the one line form');
  assert.deepStrictEqual(blocks[1], ['/plugin marketplace add ' + h.GITHUB,'/plugin install ' + plugin.name + '@' + market.name], 'the two lines below');
  const between = section.slice(section.indexOf(one), section.indexOf('/plugin marketplace add'));
  assert.ok(between.includes('v2.1.275 or later') && between.includes('`claude --version`'), 'the version sentence follows the one line');
  assert.ok(section.indexOf('Claude Code v2.1.275') < section.indexOf('/plugin marketplace add'));
});

after(() => {
  // C8: every fixture is gone, and the run wrote nothing into this repo.
  assert.deepStrictEqual(h.leftovers(), [], 'fixtures left behind');
  assert.strictEqual(fs.existsSync(path.join(h.REPO, 'cfms')), repoHadCfms, 'the run touched cfms/ in this repo');
});
