'use strict';
// Shared helpers for CFMS hooks and commands. Node built ins only.
// CFMS writes only inside <project>/cfms/ and never over the network.

const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const DIR = 'cfms';
const STATE = 'state.json';
const ERROR_CAP = 20;

function projectDir(input) {
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env && env.trim()) return path.resolve(env);
  if (input && typeof input.cwd === 'string' && input.cwd) return path.resolve(input.cwd);
  return null;
}

function cfmsDir(project) {
  return path.join(project, DIR);
}

function isOn(project) {
  try {
    return !!project && fs.statSync(cfmsDir(project)).isDirectory();
  } catch {
    return false;
  }
}

// Time comes from CFMS_NOW when set (tests), else the clock.
function now() {
  const t = process.env.CFMS_NOW;
  if (t && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString();
  return new Date().toISOString();
}

function emptyState() {
  return { format: FORMAT, pending: [], errors: [] };
}

function statePath(project) {
  return path.join(cfmsDir(project), STATE);
}

function readState(project) {
  let raw;
  try {
    raw = fs.readFileSync(statePath(project), 'utf8');
  } catch {
    return emptyState();
  }
  const s = JSON.parse(raw);
  if (!s || typeof s !== 'object') return emptyState();
  if (!Array.isArray(s.pending)) s.pending = [];
  if (!Array.isArray(s.errors)) s.errors = [];
  if (!s.format) s.format = FORMAT;
  return s;
}

// Write through a temp file in cfms/ then rename, so a crash never leaves half a file.
function writeState(project, state) {
  const file = statePath(project);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// Notes an error in the state file. Only when CFMS is on; never throws.
function noteError(project, where, err) {
  try {
    if (!isOn(project)) return;
    let state;
    try { state = readState(project); } catch { state = emptyState(); }
    state.errors.push({ at: now(), where, message: String((err && err.message) || err).slice(0, 300) });
    if (state.errors.length > ERROR_CAP) state.errors = state.errors.slice(-ERROR_CAP);
    writeState(project, state);
  } catch {}
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Absolute or relative file path -> path relative to the project with forward slashes,
// or null when it lies outside the project.
function relativeToProject(project, filePath, cwd) {
  const abs = path.resolve(cwd || project, filePath);
  const rel = path.relative(project, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/').replace(/\\/g, '/');
}

function insideCfms(rel) {
  const r = process.platform === 'win32' ? rel.toLowerCase() : rel;
  return r === DIR || r.startsWith(DIR + '/');
}

// Notes one changed file as pending: new, or the same file again with its last time moved.
function addPending(state, rel, at) {
  const same = (p) => (process.platform === 'win32' ? p.toLowerCase() === rel.toLowerCase() : p === rel);
  const found = state.pending.find((c) => c && typeof c.path === 'string' && same(c.path));
  if (found) {
    found.last = at;
  } else {
    state.pending.push({ path: rel, first: at, last: at });
  }
}

// Hook JSON on stdout, written synchronously so exit never cuts it short.
function emit(obj) {
  fs.writeSync(1, JSON.stringify(obj));
}

// ---- The ask (unit 002) ----

const ASK_AT = 3; // pending changes needed before the Stop hook asks
const ASK_MAX = 5; // changes named in one ask
const HEADER = 'CFMS';
const SKIP = 'Skip';
const NOT_NOW = 'Not now';
const OPTIONS = [
  { label: SKIP, description: 'Save nothing and never ask about these again' },
  { label: NOT_NOW, description: 'Save nothing now and ask again later' },
];
const CHECKINS = 'CHECKINS.md';
const CHECKINS_HEAD = '<!-- CFMS CHECKINS format 1 -->\n# Check ins\n\nEach line below was typed or dictated by the user into the CFMS question dialog, saved exactly.\n';
const NOT_WORDS = ['yes', 'y', 'ok', 'okay', 'sure', 'fine', 'done'];
const SKILL = 'cfms:ask';

// ---- Never a nag (unit 003) ----

const GAP_DEFAULT = 30; // minutes between asks, unless CFMS_GAP_MINUTES says otherwise
const SKIPS_TO_DOUBLE = 3; // skips in a row that double the gap

function baseGap() {
  const v = process.env.CFMS_GAP_MINUTES;
  const n = v !== undefined && String(v).trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : GAP_DEFAULT;
}

function skipsOf(state) {
  const n = state && state.skips;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// The gap now: the setting, doubled for every three skips in a row.
function gapMinutes(state) {
  return baseGap() * Math.pow(2, Math.floor(skipsOf(state) / SKIPS_TO_DOUBLE));
}

// True while the last ask is less than the gap ago.
function withinGap(state, at) {
  const last = state && typeof state.lastAsk === 'string' ? Date.parse(state.lastAsk) : NaN;
  if (Number.isNaN(last)) return false;
  const elapsed = Date.parse(at) - last;
  return elapsed >= 0 && elapsed < gapMinutes(state) * 60000;
}

// Signs that nobody is at a natural stop: CFMS_QUIET=1 (loops), or the documented
// Stop input arrays showing background work in flight or a wakeup scheduled.
function quiet(input) {
  if (process.env.CFMS_QUIET === '1') return true;
  const busy = (v) => Array.isArray(v) && v.length > 0;
  return !!input && (busy(input.background_tasks) || busy(input.session_crons));
}

function skipLine(state) {
  return 'You skipped three times, so I now ask every ' + gapMinutes(state) + ' minutes.';
}

function newestFirst(pending) {
  return pending
    .filter((c) => c && typeof c.path === 'string')
    .map((c, i) => ({ c, i }))
    .sort((a, b) => String(b.c.last || '').localeCompare(String(a.c.last || '')) || b.i - a.i)
    .map((x) => x.c);
}

// What the Stop hook shows: one line. How Claude asks is in skills/ask/SKILL.md.
function askLine(paths, total, tell) {
  const one = (p) => String(p).replace(/[\r\n]+/g, ' ');
  return (tell ? 'CFMS: ' + tell + ' ' : 'CFMS: ')
    + total + ' changes not yet in your words. Ask about ' + paths.length + ', newest first: '
    + paths.map(one).join(', ') + '. Use the ' + SKILL + ' skill.';
}

// From a PostToolUse input on AskUserQuestion: the CFMS question's answer as given,
// or null when there is no CFMS question or no string answer.
function cfmsRaw(input) {
  if (!input || input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'AskUserQuestion') return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const tr = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const questions = Array.isArray(tr.questions) ? tr.questions : Array.isArray(ti.questions) ? ti.questions : [];
  const answers = tr.answers && typeof tr.answers === 'object' ? tr.answers : ti.answers && typeof ti.answers === 'object' ? ti.answers : null;
  if (!answers) return null;
  const q = questions.find((x) => x && x.header === HEADER && typeof x.question === 'string');
  if (!q) return null;
  const a = answers[q.question];
  if (typeof a !== 'string') return null;
  return { q, a };
}

// "skip" or "notnow" when the CFMS dialog closed on one of its two options, else null.
function cfmsChoice(input) {
  const r = cfmsRaw(input);
  if (!r) return null;
  const bare = r.a.trim().toLowerCase();
  if (bare === SKIP.toLowerCase()) return 'skip';
  if (bare === NOT_NOW.toLowerCase()) return 'notnow';
  return null;
}

// The free text typed into the CFMS question, or null. Option labels, "yes" and the
// like, and empty text are not his words.
function cfmsAnswer(input) {
  const r = cfmsRaw(input);
  if (!r) return null;
  const { q, a } = r;
  const text = a.replace(/\s+$/, '');
  const bare = text.trim().toLowerCase();
  if (!bare) return null;
  const labels = (Array.isArray(q.options) ? q.options : OPTIONS)
    .map((o) => o && typeof o.label === 'string' ? o.label.trim().toLowerCase() : null)
    .filter(Boolean);
  if (labels.includes(bare)) return null;
  if (NOT_WORDS.includes(bare.replace(/[.!]+$/, ''))) return null;
  return text;
}

function checkinsPath(project) {
  return path.join(cfmsDir(project), CHECKINS);
}

// "2026-11-22T10:00:00.000Z" -> "2026-11-22 10:00 UTC"
function stamp(iso) {
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC';
}

// Appends his line exactly, with the date and the changes it answers.
function appendCheckin(project, at, paths, text) {
  const file = checkinsPath(project);
  const head = fs.existsSync(file) ? '' : CHECKINS_HEAD;
  const entry = '\n## ' + stamp(at) + '\nChanges: ' + paths.join(', ') + '\n\n' + text + '\n';
  fs.appendFileSync(file, head + entry, 'utf8');
}

// ---- The return (unit 004) ----

const NOW_FILE = 'NOW.md';
const NOW_HEAD = '<!-- CFMS NOW format 1 -->\n# Now\n\nEach entry below was typed or dictated by the user into the CFMS recall dialog, saved exactly, newest first.\n';
const SHOW = 'Show my notes'; // the option that marks a CFMS dialog as the recall
const RECALL_OPTIONS = [
  { label: SHOW, description: 'Save nothing and show my notes now' },
  { label: NOT_NOW, description: 'Save nothing and go on' },
];
const START_SOURCES = ['startup', 'resume', 'compact'];
const RETURN_HOURS = 8; // a gap this long since the last capture or answer brings the recall
const RETURN_MAX = 1500; // the added context stays under this many characters
const SHOW_CHECKINS = 3; // newest check ins shown with the recall
const SHOW_PATHS = 5; // newest pending paths shown with the recall
const PATHS_MAX = 300; // the changes line never grows past this
const WEEK = 7 * 24 * 3600000;
const HEADING = /^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\r?$/gm;

const RECALL_HEAD = 'CFMS recall. Before anything else, open the question dialog (AskUserQuestion) once with one question: header "CFMS", multiSelect false, the question "From memory, in one line: what is this project for? Type or dictate it in the box; it is saved as you write it.", and exactly two options, "'
  + SHOW + '" (description "' + RECALL_OPTIONS[0].description + '") and "' + NOT_NOW + '" (description "' + RECALL_OPTIONS[1].description + '"). '
  + 'Never write the line for the user or offer one as an option. Wait for the answer. If it is "' + NOT_NOW + '", go on without a word about it. '
  + 'Otherwise show the user the lines below verbatim with their dates, then what changed since.';
const NO_LINES = 'No lines saved yet: after the answer, read the recent git log yourself and show what it says changed.';

function nowPath(project) {
  return path.join(cfmsDir(project), NOW_FILE);
}

// True when the CFMS dialog in this input is the recall: it has the "Show my notes" option.
function isRecall(input) {
  const r = cfmsRaw(input);
  if (!r || !Array.isArray(r.q.options)) return false;
  return r.q.options.some((o) => o && typeof o.label === 'string' && o.label.trim().toLowerCase() === SHOW.toLowerCase());
}

// Puts his line at the top of NOW.md, newest first, through a temp file and a rename.
// What is already in the file is kept byte for byte.
function prependNow(project, at, text) {
  const file = nowPath(project);
  let old = null;
  try {
    old = fs.readFileSync(file);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  const entry = Buffer.from('\n## ' + stamp(at) + '\n\n' + text + '\n', 'utf8');
  let out;
  if (old === null) {
    out = Buffer.concat([Buffer.from(NOW_HEAD, 'utf8'), entry]);
  } else {
    // The pattern is ASCII, so a latin1 index is a byte index.
    const m = /\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\r?\n/.exec(old.toString('latin1'));
    if (m) {
      out = Buffer.concat([old.subarray(0, m.index), entry, old.subarray(m.index)]);
    } else {
      const nl = old.length && old[old.length - 1] !== 0x0a ? Buffer.from('\n') : Buffer.alloc(0);
      out = Buffer.concat([old, nl, entry]);
    }
  }
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, out);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// The dated entries of NOW.md or CHECKINS.md, newest first: { at, changes, text }.
// NOW.md has its newest at the top, CHECKINS.md at the bottom. No file: none.
function readEntries(file, topIsNewest) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const heads = [...content.matchAll(HEADING)];
  const entries = heads.map((m, i) => {
    const start = m.index + m[0].length + 1;
    const end = i + 1 < heads.length ? heads[i + 1].index - 1 : content.length;
    let body = content.slice(start, Math.max(start, end));
    let changes = null;
    const c = /^Changes: (.*)\r?\n/.exec(body);
    if (c) {
      changes = c[1].split(', ').filter((p) => p && p !== 'none');
      body = body.slice(c[0].length);
    }
    body = body.replace(/^\r?\n/, '').replace(/\n$/, '');
    return { at: m[1] + 'T' + m[2] + ':00.000Z', changes, text: body, i };
  });
  return entries
    .sort((a, b) => b.at.localeCompare(a.at) || (topIsNewest ? a.i - b.i : b.i - a.i))
    .map(({ at, changes, text }) => ({ at, changes, text }));
}

// What the return needs. Throws on a corrupt state file.
function returnData(project) {
  const state = readState(project);
  return {
    state,
    now: readEntries(nowPath(project), true),
    checkins: readEntries(checkinsPath(project), false),
  };
}

// The newest of: the pending and skipped changes' last times, NOW.md's and CHECKINS.md's
// newest dated entries. Milliseconds, or null when there is none.
function lastActivity(d) {
  const skipped = Array.isArray(d.state.skipped) ? d.state.skipped : [];
  const times = [];
  for (const c of [...d.state.pending, ...skipped]) if (c && typeof c.last === 'string') times.push(Date.parse(c.last));
  for (const e of [...d.now, ...d.checkins]) times.push(Date.parse(e.at));
  const ok = times.filter(Number.isFinite);
  return ok.length ? Math.max(...ok) : null;
}

// The recall after a gap of RETURN_HOURS, or while NOW.md has no line yet.
function needsRecall(d, at) {
  if (!d.now.length) return true;
  const last = lastActivity(d);
  if (last === null) return true;
  return Date.parse(at) - last >= RETURN_HOURS * 3600000;
}

function validPending(state) {
  return state.pending.filter((c) => c && typeof c.path === 'string');
}

// The recall: the instruction, his last lines verbatim (whole or not at all), and the
// changes since, under RETURN_MAX characters. His lines come first; the paths of the
// changes get only the room left.
function recallContext(d) {
  const pending = validPending(d.state);
  const one = (p) => String(p).replace(/[\r\n]+/g, ' ');
  const count = 'Changed since: ' + pending.length + ' ' + (pending.length === 1 ? 'change' : 'changes') + ' not yet in the user\'s words';

  const blocks = [];
  if (d.now[0]) blocks.push({ file: DIR + '/' + NOW_FILE, text: 'NOW.md, ' + stamp(d.now[0].at) + ':\n' + d.now[0].text });
  for (const e of d.checkins.slice(0, SHOW_CHECKINS)) blocks.push({ file: DIR + '/' + CHECKINS, text: 'Check in, ' + stamp(e.at) + ':\n' + e.text });

  let out;
  if (!blocks.length) {
    out = RECALL_HEAD + '\n' + NO_LINES;
  } else {
    const readNote = (files) => 'Not all of them fit here: read ' + files.join(' and ') + ' yourself and show the newest entries verbatim, never shortened.';
    const reserve = readNote([DIR + '/' + NOW_FILE, DIR + '/' + CHECKINS]).length + 1 + count.length + 2;
    out = RECALL_HEAD + '\nThe user\'s last lines, newest first:';
    const missed = [];
    for (const b of blocks) {
      if (out.length + 1 + b.text.length + reserve < RETURN_MAX) {
        out += '\n' + b.text;
      } else if (!missed.includes(b.file)) {
        missed.push(b.file);
      }
    }
    if (missed.length) out += '\n' + readNote(missed);
  }

  let changes = count;
  let shown = 0;
  for (const c of newestFirst(pending).slice(0, SHOW_PATHS)) {
    const next = changes + (shown ? ', ' : ', newest: ') + one(c.path);
    if (next.length + 1 > PATHS_MAX || out.length + 1 + next.length + 1 >= RETURN_MAX) continue;
    shown++;
    changes = next;
  }
  return out + '\n' + changes + '.';
}

// Within the gap: one line of counts (R4). "This week" is the last seven days.
function returnLine(d, at) {
  const t = Date.parse(at);
  const inWeek = (iso) => {
    const x = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return Number.isFinite(x) && x <= t && t - x < WEEK;
  };
  const pending = validPending(d.state);
  const skipped = Array.isArray(d.state.skipped) ? d.state.skipped : [];
  const words = d.checkins.filter((e) => inWeek(e.at)).reduce((n, e) => n + (e.changes ? e.changes.length : 0), 0);
  const whole = words
    + pending.filter((c) => inWeek(c.last)).length
    + skipped.filter((c) => c && inWeek(c.skipped)).length;
  const head = 'CFMS: ' + pending.length + ' ' + (pending.length === 1 ? 'change' : 'changes') + ' not yet in your words; ';
  return head + (whole ? words + ' of ' + whole + ' this week are.' : 'none this week.');
}

// What the session start hook adds: the recall or the one line. After a compact
// (unit 008, R1) never the recall, whatever the gap: it comes only at a real return.
function returnContext(project, at, source) {
  const d = returnData(project);
  return source !== 'compact' && needsRecall(d, at) ? recallContext(d) : returnLine(d, at);
}

// Unit 008, R2: the recall dialog counts as an ask for 003's gap. Sets the time of the
// last ask only; the skip count, pending, skipped, the open ask and the skip line owed
// are left as they are. Throws on a corrupt state file, which it leaves as found.
function markAsked(project, at) {
  const state = readState(project);
  state.lastAsk = at;
  writeState(project, state);
}

// ---- Decisions and the catch (unit 005) ----

const DECISIONS = 'DECISIONS.md';
const NOT_DECISION = 'Not a decision'; // the option that marks a CFMS dialog as a decision
const NOT_RULE = 'Not a standing rule'; // the option that marks a CFMS dialog as a standing rule
const RULES_SECTION = '## Standing rules';
const DECISIONS_SECTION = '## Decisions';
const DECISIONS_HEAD = '<!-- CFMS DECISIONS format 1 -->\n# Decisions and standing rules\n\n'
  + 'Each entry below was typed or dictated by the user into the CFMS question dialog, saved exactly. '
  + 'Append only: no entry is ever edited or removed; a changed mind is a new entry saying which one it replaces.\n\n'
  + RULES_SECTION + '\n\n' + DECISIONS_SECTION + '\n';
const DECISIONS_SKILL = 'cfms:decisions';
const DECISIONS_MAX = 2000; // the decisions part stays within this while the rules fit
const START_ROOM = 10000 - RETURN_MAX - 100; // Claude Code files away any context over 10,000
const DECISIONS_LINE = 'CFMS decisions. Below are the user\'s standing rules and decisions in their own words, saved exactly, with their dates. '
  + 'Before you do anything that goes against one, stop, quote it with its date and ask whether it still holds; '
  + 'when the user says something is a decision or a standing rule, record it. Both through the ' + DECISIONS_SKILL + ' skill.';
const DECISIONS_NONE = 'CFMS decisions: none recorded yet. When the user says something is a decision or a standing rule, '
  + 'record it in their words through the ' + DECISIONS_SKILL + ' skill.';
const DECISION_MARK = /^(## Standing rules|## Decisions|### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC)\r?$/gm;

function decisionsPath(project) {
  return path.join(cfmsDir(project), DECISIONS);
}

// "rule" or "decision" when the CFMS dialog in this input is the one that records them,
// told by its marking option; else null.
function decisionKind(input) {
  const r = cfmsRaw(input);
  if (!r || !Array.isArray(r.q.options)) return null;
  const labels = r.q.options.map((o) => (o && typeof o.label === 'string' ? o.label.trim().toLowerCase() : ''));
  if (labels.includes(NOT_RULE.toLowerCase())) return 'rule';
  if (labels.includes(NOT_DECISION.toLowerCase())) return 'decision';
  return null;
}

// Adds his line, dated, to cfms/DECISIONS.md. A decision is appended at the end; a rule
// goes at the end of the rules section, before the decisions heading. Every byte already
// in the file is kept; no entry is ever edited or removed.
function addDecision(project, at, kind, text) {
  const file = decisionsPath(project);
  let old = null;
  try {
    old = fs.readFileSync(file);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  const entry = '\n### ' + stamp(at) + '\n\n' + text + '\n';
  if (old === null) {
    // New file: the format line and both sections, the entry in its own.
    const out = kind === 'rule'
      ? DECISIONS_HEAD.replace('\n' + DECISIONS_SECTION + '\n', () => entry + '\n' + DECISIONS_SECTION + '\n')
      : DECISIONS_HEAD + entry;
    fs.writeFileSync(file, out, { encoding: 'utf8', flag: 'wx' });
    return;
  }
  // The headings are ASCII, so a latin1 index is a byte index.
  const latin = old.toString('latin1');
  const nl = old.length && old[old.length - 1] !== 0x0a ? '\n' : '';
  const decHead = /\n## Decisions\r?\n/.exec(latin);
  if (kind === 'decision') {
    fs.appendFileSync(file, nl + (decHead ? '' : '\n' + DECISIONS_SECTION + '\n') + entry, 'utf8');
    return;
  }
  if (!decHead) {
    const rulesHead = /(^|\n)## Standing rules\r?\n/.test(latin);
    fs.appendFileSync(file, nl + (rulesHead ? '' : '\n' + RULES_SECTION + '\n') + entry, 'utf8');
    return;
  }
  // A file he made by hand may have a decisions heading and no rules heading before it.
  const rulesBefore = /(^|\n)## Standing rules\r?\n/.test(latin.slice(0, decHead.index + 1));
  const put = (rulesBefore ? '' : '\n' + RULES_SECTION + '\n') + entry;
  const out = Buffer.concat([old.subarray(0, decHead.index), Buffer.from(put, 'utf8'), old.subarray(decHead.index)]);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, out);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// The entries of cfms/DECISIONS.md: { rules (file order), decisions (newest first) },
// each { at, text }. An entry's kind is the section it is under; before any, a decision.
function readDecisions(project) {
  let content;
  try {
    content = fs.readFileSync(decisionsPath(project), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { rules: [], decisions: [] };
    throw e;
  }
  const marks = [...content.matchAll(DECISION_MARK)];
  const rules = [];
  const decisions = [];
  let section = 'decision';
  marks.forEach((m, i) => {
    if (m[1] === RULES_SECTION) { section = 'rule'; return; }
    if (m[1] === DECISIONS_SECTION) { section = 'decision'; return; }
    const start = m.index + m[0].length + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index - 1 : content.length;
    const text = content.slice(start, Math.max(start, end)).replace(/^\r?\n/, '').replace(/\r?\n\r?$/, '');
    const e = { at: m[2] + 'T' + m[3] + ':00.000Z', text, i };
    (section === 'rule' ? rules : decisions).push(e);
  });
  decisions.sort((a, b) => b.at.localeCompare(a.at) || b.i - a.i);
  const plain = (e) => ({ at: e.at, text: e.text });
  return { rules: rules.map(plain), decisions: decisions.map(plain) };
}

// What the session start adds for decisions (R3): the one instruction line, every
// standing rule whole, then the newest decisions whole within DECISIONS_MAX. Nothing is
// ever cut: what does not fit is named as left out, and it stays in the file.
function decisionsContext(project) {
  const d = readDecisions(project);
  if (!d.rules.length && !d.decisions.length) return DECISIONS_NONE;
  const where = DIR + '/' + DECISIONS;
  const ruleText = (e) => 'Standing rule, ' + stamp(e.at) + ':\n' + e.text;
  const decText = (e) => 'Decision, ' + stamp(e.at) + ':\n' + e.text;
  const rulesNote = (n) => n + ' more standing ' + (n === 1 ? 'rule does' : 'rules do') + ' not fit here: read them in ' + where + ' now.';
  const decNote = (n) => n + ' older ' + (n === 1 ? 'decision is' : 'decisions are') + ' left out here; every one is in ' + where + '.';
  const reserve = 1 + rulesNote(99999).length + 1 + decNote(99999).length;

  let out = DECISIONS_LINE;
  let missedRules = 0;
  if (d.rules.length) {
    out += '\nStanding rules, oldest first:';
    for (const e of d.rules) {
      const t = ruleText(e);
      if (out.length + 1 + t.length + reserve <= START_ROOM) out += '\n' + t;
      else missedRules++;
    }
  }
  const decReserve = (missedRules ? 1 + rulesNote(missedRules).length : 0) + 1 + decNote(99999).length;
  const shown = [];
  let len = out.length + '\nDecisions, newest first:'.length;
  for (const e of d.decisions) {
    const t = decText(e);
    if (len + 1 + t.length + decReserve > DECISIONS_MAX) break;
    shown.push(t);
    len += 1 + t.length;
  }
  if (shown.length) out += '\nDecisions, newest first:\n' + shown.join('\n');
  if (missedRules) out += '\n' + rulesNote(missedRules);
  if (d.decisions.length > shown.length) out += '\n' + decNote(d.decisions.length - shown.length);
  return out;
}

module.exports = {
  FORMAT, DIR, STATE, ASK_AT, ASK_MAX, HEADER, SKIP, NOT_NOW, OPTIONS, CHECKINS, NOT_WORDS, SKILL,
  DECISIONS, NOT_DECISION, NOT_RULE, DECISIONS_SKILL, DECISIONS_MAX, DECISIONS_LINE, DECISIONS_NONE,
  decisionsPath, decisionKind, addDecision, readDecisions, decisionsContext,
  GAP_DEFAULT, SKIPS_TO_DOUBLE,
  NOW_FILE, SHOW, RECALL_OPTIONS, START_SOURCES, RETURN_HOURS, RETURN_MAX,
  projectDir, cfmsDir, isOn, now, emptyState, statePath,
  readState, writeState, noteError, readStdin, relativeToProject, insideCfms, addPending, emit,
  newestFirst, askLine, cfmsAnswer, cfmsChoice, checkinsPath, appendCheckin,
  baseGap, skipsOf, gapMinutes, withinGap, quiet, skipLine,
  nowPath, isRecall, prependNow, readEntries, returnData, lastActivity, needsRecall,
  recallContext, returnLine, returnContext, markAsked,
};
