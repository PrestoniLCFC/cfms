'use strict';
// Unit 005, decisions and the catch: his decisions and standing rules, saved only through
// the CFMS dialog into cfms/DECISIONS.md (append only), are in the session start context
// in his words under the catch line; the catch wording lives in the cfms:decisions skill.
// Time comes from the input (CFMS_NOW), never from waiting.

const { test, after } = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const lib = require('../scripts/lib');

const AT_MS = Date.parse('2026-11-22T12:00:00.000Z');
const AT = new Date(AT_MS).toISOString();
// Hours (and minutes) before AT as an ISO time.
const H = (hours, minutes) => new Date(AT_MS - hours * 3600000 - (minutes || 0) * 60000).toISOString();
const repoHadCfms = fs.existsSync(path.join(h.REPO, 'cfms'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

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

function fill(obj, text) {
  for (const part of [obj.tool_input, obj.tool_response]) {
    for (const k of Object.keys(part.answers)) part.answers[k] = text;
  }
  return JSON.stringify(obj);
}

function dialog(name, dir, at, text) {
  return h.runScript('answer.js', fill(JSON.parse(h.input(name, dir)), text), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: at });
}
const decision = (dir, at, text) => dialog('answer-decision.json', dir, at, text);
const rule = (dir, at, text) => dialog('answer-rule.json', dir, at, text);

function saved(r) {
  assert.strictEqual(context(r, 'PostToolUse'), 'Saved to cfms/DECISIONS.md');
}

function start(dir, at, change) {
  const obj = JSON.parse(h.input('session-start.json', dir));
  if (change) change(obj);
  return h.runScript('start.js', JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: at || AT });
}

// The decisions part of the session start context: everything after 004's part.
function part(text) {
  const cut = text.indexOf('\n\nCFMS decisions');
  assert.ok(cut > 0, 'the return comes first, then the decisions part');
  return text.slice(cut + 2);
}

function file(dir) {
  return path.join(dir, 'cfms', 'DECISIONS.md');
}

function edit(dir, at, ...rels) {
  rels.forEach((rel, i) => {
    const obj = JSON.parse(h.input('edit.json', dir));
    obj.tool_input.file_path = path.join(dir, ...rel.split('/'));
    const t = new Date(Date.parse(at) + i * 1000).toISOString();
    silent(h.runCapture(JSON.stringify(obj), { CLAUDE_PROJECT_DIR: dir, CFMS_NOW: t }));
  });
}

const RULE_A = 'No new dependencies: "Node built ins only" \u{1F642}\nbecause café plugins break, Zürich';
const RULE_B = 'Never write outside cfms/, it\'s his project; costs $& nothing';
const DEC_A = 'Keep the dialog to two options, because a third is noise';
const DEC_B = 'Ship the README last: 006 needs 004 and 005 — naïve';

test('C1 a fixture DECISIONS.md: each rule byte for byte, dated, under the catch line; nothing written', () => {
  withFixture(true, (dir) => {
    fs.writeFileSync(file(dir), '<!-- CFMS DECISIONS format 1 -->\n# Decisions and standing rules\n\nA note he wrote.\n\n'
      + '## Standing rules\n\n### 2026-11-20 09:15 UTC\n\n' + RULE_A + '\n\n### 2026-11-21 10:30 UTC\n\n' + RULE_B + '\n\n'
      + '## Decisions\n\n### 2026-11-20 11:00 UTC\n\n' + DEC_A + '\n\n### 2026-11-21 11:00 UTC\n\n' + DEC_B + '\n', 'utf8');
    const before = h.snapshot(dir);
    const text = context(start(dir), 'SessionStart');
    assert.match(text, /^CFMS recall\. /, '004\'s part comes first');
    const p = part(text);
    assert.ok(p.startsWith(lib.DECISIONS_LINE + '\n'), 'the catch line first');
    assert.ok(lib.DECISIONS_LINE.includes('Before you do anything that goes against one, stop, quote it with its date and ask whether it still holds'));
    assert.ok(!lib.DECISIONS_LINE.includes('\n'), 'one line');
    assert.ok(p.includes('Standing rule, 2026-11-20 09:15 UTC:\n' + RULE_A + '\n'), 'rule A byte for byte');
    assert.ok(p.includes('Standing rule, 2026-11-21 10:30 UTC:\n' + RULE_B + '\n'), 'rule B byte for byte');
    assert.ok(p.indexOf(RULE_A) < p.indexOf(RULE_B), 'rules oldest first');
    assert.ok(p.indexOf(RULE_B) < p.indexOf(DEC_B), 'rules before decisions');
    assert.ok(p.includes('Decision, 2026-11-21 11:00 UTC:\n' + DEC_B + '\nDecision, 2026-11-20 11:00 UTC:\n' + DEC_A), 'decisions newest first');
    assert.ok(!p.includes('A note he wrote'), 'only entries');
    assert.ok(!p.includes('left out') && !p.includes('not fit'));
    assert.ok(p.length <= 2000, 'within 2,000: ' + p.length);
    assert.deepStrictEqual(h.snapshot(dir), before, 'the session start hook writes nothing');
  });
});

test('C1 recorded through the dialog: rules and decisions reach the next session start byte for byte', () => {
  withFixture(true, (dir) => {
    saved(decision(dir, H(5), DEC_A));
    saved(rule(dir, H(4), RULE_A));
    saved(decision(dir, H(3), DEC_B + '  \n'));
    saved(rule(dir, H(2), RULE_B));
    const p = part(context(start(dir), 'SessionStart'));
    assert.ok(p.includes('Standing rules, oldest first:\nStanding rule, 2026-11-22 08:00 UTC:\n' + RULE_A + '\nStanding rule, 2026-11-22 10:00 UTC:\n' + RULE_B + '\n'));
    assert.ok(p.endsWith('Decisions, newest first:\nDecision, 2026-11-22 09:00 UTC:\n' + DEC_B + '\nDecision, 2026-11-22 07:00 UTC:\n' + DEC_A), p);
    const t = fs.readFileSync(file(dir), 'utf8');
    assert.strictEqual(t.split('\n')[0], '<!-- CFMS DECISIONS format 1 -->');
    assert.strictEqual(t.match(/format 1/g).length, 1);
    assert.ok(t.indexOf('## Standing rules') < t.indexOf(RULE_A) && t.indexOf(RULE_B) < t.indexOf('## Decisions'), 'rules in their section');
    assert.ok(t.indexOf('## Decisions') < t.indexOf(DEC_A) && t.indexOf(DEC_A) < t.indexOf(DEC_B), 'decisions in theirs, in order');
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'cfms')).sort(), ['.gitignore', 'DECISIONS.md', 'state.json'], 'no temp file left');
  });
});

test('C2 a recorded decision is appended byte for byte; every earlier byte unchanged by hash', () => {
  withFixture(true, (dir) => {
    saved(rule(dir, H(3), RULE_A));
    saved(decision(dir, H(2), DEC_A));
    const b0 = fs.readFileSync(file(dir));
    const said = 'It\'s "final" \u{1F642}\r\ncafé, señor';
    saved(decision(dir, H(1), said + ' \t\n'));
    const b1 = fs.readFileSync(file(dir));
    assert.strictEqual(sha(b1.subarray(0, b0.length)), sha(b0), 'every earlier byte unchanged');
    assert.ok(b1.subarray(b0.length).equals(Buffer.from('\n### 2026-11-22 11:00 UTC\n\n' + said + '\n', 'utf8')), 'appended byte for byte');
    assert.deepStrictEqual(lib.readDecisions(dir).decisions.map((e) => e.text), [said, DEC_A]);
  });
});

test('C2 a recorded rule goes at the end of the rules section; the bytes before and after it unchanged by hash', () => {
  withFixture(true, (dir) => {
    saved(rule(dir, H(3), RULE_A));
    saved(decision(dir, H(2), DEC_A));
    const b0 = fs.readFileSync(file(dir));
    const cut = b0.indexOf('\n## Decisions\n');
    saved(rule(dir, H(1), RULE_B));
    const b1 = fs.readFileSync(file(dir));
    const entry = Buffer.from('\n### 2026-11-22 11:00 UTC\n\n' + RULE_B + '\n', 'utf8');
    assert.strictEqual(b1.length, b0.length + entry.length);
    assert.strictEqual(sha(b1.subarray(0, cut)), sha(b0.subarray(0, cut)), 'the bytes before unchanged');
    assert.ok(b1.subarray(cut, cut + entry.length).equals(entry), 'the rule byte for byte');
    assert.strictEqual(sha(b1.subarray(cut + entry.length)), sha(b0.subarray(cut)), 'the bytes after unchanged');
    assert.deepStrictEqual(lib.readDecisions(dir).rules.map((e) => e.text), [RULE_A, RULE_B]);
  });
});

test('C2 a file he edited by hand, with no last line break, keeps every byte', () => {
  withFixture(true, (dir) => {
    const hand = '# My decisions\n\nWritten by hand, no sections\n\n### 2026-11-01 08:00 UTC\n\nAn old one';
    fs.writeFileSync(file(dir), hand, 'utf8');
    saved(decision(dir, H(2), DEC_A));
    saved(rule(dir, H(1), RULE_A));
    const t = fs.readFileSync(file(dir), 'utf8');
    assert.ok(t.startsWith(hand + '\n'), 'his file kept byte for byte');
    const d = lib.readDecisions(dir);
    assert.deepStrictEqual(d.decisions.map((e) => e.text), [DEC_A, 'An old one']);
    assert.deepStrictEqual(d.rules.map((e) => e.text), [RULE_A]);
  });
});

test('C3 over the limit: every standing rule kept, the oldest decisions left out of the context, never out of the file', () => {
  withFixture(true, (dir) => {
    const rules = [1, 2, 3].map((i) => 'Rule ' + i + ': ' + 'keep it plain and short '.repeat(3).trim());
    rules.forEach((r, i) => saved(rule(dir, H(100 - i), r)));
    const decs = Array.from({ length: 30 }, (_, i) => 'Decision ' + i + ': ' + 'because it reads better for him '.repeat(3).trim());
    decs.forEach((d, i) => saved(decision(dir, H(90 - i), d)));
    const p = part(context(start(dir), 'SessionStart'));
    assert.ok(p.length <= 2000, 'within 2,000: ' + p.length);
    for (const r of rules) assert.ok(p.includes(r + '\n'), 'rule kept: ' + r);
    assert.ok(p.includes(decs[29]) && p.includes(decs[28]), 'the newest decisions shown');
    assert.ok(!p.includes(decs[0] + '\n') && !p.endsWith(decs[0]), 'the oldest left out');
    const shown = decs.filter((d) => p.includes(d));
    assert.deepStrictEqual(shown, decs.slice(30 - shown.length), 'a run of the newest, none skipped');
    assert.ok(p.endsWith('\n' + (30 - shown.length) + ' older decisions are left out here; every one is in cfms/DECISIONS.md.'), p.slice(-200));
    const t = fs.readFileSync(file(dir), 'utf8');
    for (const d of decs) assert.ok(t.includes('\n\n' + d + '\n'), 'in the file: ' + d);
    assert.strictEqual(lib.readDecisions(dir).decisions.length, 30);
  });
});

test('C3 rules alone past 2,000: every rule kept, no decision shown, the decisions named as left out', () => {
  withFixture(true, (dir) => {
    const rules = Array.from({ length: 25 }, (_, i) => 'Rule ' + i + ': ' + 'one more thing to keep '.repeat(4).trim());
    rules.forEach((r, i) => saved(rule(dir, H(100 - i), r)));
    saved(decision(dir, H(10), DEC_A));
    const p = part(context(start(dir), 'SessionStart'));
    for (const r of rules) assert.ok(p.includes(r + '\n'), 'rule kept: ' + r);
    assert.ok(!p.includes(DEC_A) && !p.includes('Decisions, newest first'));
    assert.ok(p.endsWith('\n1 older decision is left out here; every one is in cfms/DECISIONS.md.'));
  });
});

test('C3 rules past Claude Code\'s 10,000 cap: the context stays under it; the rest are named, never cut', () => {
  withFixture(true, (dir) => {
    const rules = Array.from({ length: 90 }, (_, i) => 'Rule ' + i + ': ' + 'a long standing rule he cares about '.repeat(3).trim());
    rules.forEach((r, i) => lib.addDecision(dir, H(200 - i), 'rule', r));
    const text = context(start(dir), 'SessionStart');
    assert.ok(text.length < 10000, 'under the cap: ' + text.length);
    const p = part(text);
    const kept = rules.filter((r) => p.includes(r + '\n'));
    assert.ok(kept.length > 50 && kept.length < 90, 'kept ' + kept.length);
    assert.ok(p.endsWith('\n' + (90 - kept.length) + ' more standing rules do not fit here: read them in cfms/DECISIONS.md now.'), p.slice(-200));
    for (const line of p.split('\n').filter((l) => l.startsWith('Rule '))) assert.ok(rules.includes(line), 'no rule cut: ' + line);
    assert.strictEqual(lib.readDecisions(dir).rules.length, 90);
  });
});

test('no DECISIONS.md, or an empty cfms/: one line naming the skill that records them', () => {
  withFixture(true, (dir) => {
    assert.strictEqual(part(context(start(dir), 'SessionStart')), lib.DECISIONS_NONE);
  });
  withFixture(false, (dir) => {
    fs.mkdirSync(path.join(dir, 'cfms'));
    const before = h.snapshot(dir);
    assert.strictEqual(part(context(start(dir), 'SessionStart')), lib.DECISIONS_NONE);
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
  assert.ok(lib.DECISIONS_NONE.includes('cfms:decisions') && !lib.DECISIONS_NONE.includes('\n'));
});

for (const [name, run, label] of [['decision', decision, 'Not a decision'], ['standing rule', rule, 'Not a standing rule']]) {
  for (const text of [label, label.toLowerCase(), 'Not now', 'not now', '', '   ', 'yes', 'OK.']) {
    test('the ' + name + ' dialog closing on "' + text + '": nothing saved, nothing changed', () => {
      withFixture(true, (dir) => {
        edit(dir, H(3), 'src/a.js', 'src/b.js', 'src/c.js');
        const before = h.snapshot(dir);
        silent(run(dir, H(2), text));
        assert.deepStrictEqual(h.snapshot(dir), before);
      });
    });
  }
}

test('a recorded decision or rule touches neither pending nor the skip count, nor the other files', () => {
  withFixture(true, (dir) => {
    edit(dir, H(3), 'src/a.js', 'src/b.js', 'src/c.js');
    silent(dialog('answer-cfms.json', dir, H(2, 30), 'Not now'));
    const stateBefore = h.snapshot(dir)['cfms/state.json'];
    assert.strictEqual(h.state(dir).skips, 1);
    saved(decision(dir, H(2), DEC_A));
    saved(rule(dir, H(1), RULE_A));
    assert.strictEqual(h.snapshot(dir)['cfms/state.json'], stateBefore, 'state untouched');
    assert.ok(!fs.existsSync(path.join(dir, 'cfms', 'CHECKINS.md')) && !fs.existsSync(path.join(dir, 'cfms', 'NOW.md')));
  });
});

test('the check in and the recall dialogs never write DECISIONS.md', () => {
  withFixture(true, (dir) => {
    edit(dir, H(3), 'src/a.js', 'src/b.js', 'src/c.js');
    context(dialog('answer-cfms.json', dir, H(2), 'A reason'), 'PostToolUse');
    context(dialog('answer-recall.json', dir, H(1), 'What it is for'), 'PostToolUse');
    assert.ok(!fs.existsSync(file(dir)));
  });
});

test('no cfms/: a decision answer writes nothing and the session start prints nothing', () => {
  withFixture(false, (dir) => {
    const before = h.snapshot(dir);
    silent(decision(dir, H(2), DEC_A));
    silent(rule(dir, H(1), RULE_A));
    silent(start(dir));
    assert.deepStrictEqual(h.snapshot(dir), before);
  });
});

test('resume and compact carry the decisions; clear and fork add nothing, as 004 built', () => {
  withFixture(true, (dir) => {
    saved(rule(dir, H(1), RULE_A));
    for (const source of ['startup', 'resume', 'compact']) {
      assert.ok(part(context(start(dir, AT, (o) => { o.source = source; }), 'SessionStart')).includes(RULE_A), source);
    }
    for (const source of ['clear', 'fork']) silent(start(dir, AT, (o) => { o.source = source; }));
  });
});

test('the skill holds the catch in R4\'s words and the record dialog the inputs and answer.js expect', () => {
  const skill = fs.readFileSync(path.join(h.REPO, 'skills', 'decisions', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: decisions\n/);
  assert.match(skill, /\nuser-invocable: false\n/);
  assert.ok(skill.includes('\nOn <date> you said: \'<his words>\'. This goes against it. Does it still hold?\n'), 'R4 wording');
  assert.ok(lib.DECISIONS_LINE.includes(lib.DECISIONS_SKILL) && lib.DECISIONS_SKILL === 'cfms:decisions');
  for (const name of ['answer-decision.json', 'answer-rule.json']) {
    const q = JSON.parse(fs.readFileSync(path.join(__dirname, 'inputs', name), 'utf8')).tool_input.questions[0];
    assert.strictEqual(q.header, 'CFMS');
    assert.ok(skill.includes('the question "' + q.question + '"'), name + ': the question');
    for (const o of q.options) assert.ok(skill.includes('"' + o.label + '" (description "' + o.description + '")'), name + ': ' + o.label);
  }
  assert.ok(skill.includes('"' + lib.NOT_DECISION + '"') && skill.includes('"' + lib.NOT_RULE + '"'));
});

after(() => {
  // C4: every fixture is gone, and the run wrote nothing into this repo.
  assert.deepStrictEqual(h.leftovers(), [], 'fixtures left behind');
  assert.strictEqual(fs.existsSync(path.join(h.REPO, 'cfms')), repoHadCfms, 'the run touched cfms/ in this repo');
});
