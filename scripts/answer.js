'use strict';
// PostToolUse hook on AskUserQuestion: the only way his words enter the record (DD-004).
// If the dialog's question has header "CFMS" and its free text is not empty (and not
// an option label or "yes" and the like), appends it exactly to cfms/CHECKINS.md with
// the date and the changes it answers, and those changes leave the pending list.
// An answer sets the skip count back to 0, so the gap is the default again (unit 003).
// "Skip" (unit 003): nothing saved; the asked changes leave pending for good, kept
// under skipped. "Not now": nothing saved; they stay pending. Each counts one skip;
// every third skip in a row doubles the gap and the next ask says so.
// The recall dialog (unit 004, the one with a "Show my notes" option): free text goes
// to the top of cfms/NOW.md, dated; nothing else from it saves anything. Whatever he
// picks there, the time of the last ask is set (unit 008), never a skip.
// The decision and standing rule dialogs (unit 005, a "Not a decision" or "Not a
// standing rule" option): free text goes to cfms/DECISIONS.md, dated; nothing else.
// Adds one line to Claude's context when it saves; otherwise prints nothing. Exits 0.

let project = null;
let lib = null;

function quit() {
  process.exit(0);
}

process.on('uncaughtException', (e) => {
  try { if (lib && project) lib.noteError(project, 'answer', e); } catch {}
  quit();
});

try {
  lib = require('./lib');
  const raw = lib.readStdin();
  project = lib.projectDir(null);
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    if (project) lib.noteError(project, 'answer: input is not JSON', e);
    quit();
  }
  if (!project) project = lib.projectDir(input);
  if (!project || !lib.isOn(project)) quit();

  // The recall (unit 004): its free text goes to the top of cfms/NOW.md; its options
  // and anything else save nothing and touch neither pending nor the skip count.
  // Unit 008: whatever he picks, it counts as an ask for the gap (lastAsk only), set
  // after his line is saved; a corrupt state file is left as found and his line stands.
  if (lib.isRecall(input)) {
    const at = lib.now();
    const said = lib.cfmsAnswer(input);
    if (said !== null) lib.prependNow(project, at, said);
    try { lib.markAsked(project, at); } catch {}
    if (said === null) quit();
    lib.emit({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Saved to ' + lib.DIR + '/' + lib.NOW_FILE },
    });
    quit();
  }

  // Decisions and standing rules (unit 005): the dialog with a "Not a decision" or "Not a
  // standing rule" option. Its free text goes to cfms/DECISIONS.md; its options and
  // anything else save nothing and touch neither pending nor the skip count.
  const kind = lib.decisionKind(input);
  if (kind) {
    const said = lib.cfmsAnswer(input);
    if (said === null) quit();
    lib.addDecision(project, lib.now(), kind, said);
    lib.emit({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Saved to ' + lib.DIR + '/' + lib.DECISIONS },
    });
    quit();
  }

  const choice = lib.cfmsChoice(input);
  const text = choice ? null : lib.cfmsAnswer(input);
  if (!choice && text === null) quit();

  const state = lib.readState(project);
  const asked = state.ask && Array.isArray(state.ask.paths) && state.ask.paths.length
    ? state.ask.paths.filter((p) => typeof p === 'string')
    : lib.newestFirst(state.pending).slice(0, lib.ASK_MAX).map((c) => c.path);
  const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const answered = new Set(asked.map(key));
  const isAsked = (c) => c && typeof c.path === 'string' && answered.has(key(c.path));
  const at = lib.now();

  if (choice) {
    if (choice === 'skip') {
      const skipped = Array.isArray(state.skipped) ? state.skipped : [];
      for (const c of state.pending) if (isAsked(c)) skipped.push({ ...c, skipped: at });
      state.skipped = skipped;
      state.pending = state.pending.filter((c) => !isAsked(c));
    }
    state.skips = lib.skipsOf(state) + 1;
    if (state.skips % lib.SKIPS_TO_DOUBLE === 0) state.tell = true;
    delete state.ask;
    lib.writeState(project, state);
    quit();
  }

  lib.appendCheckin(project, at, asked.length ? asked : ['none'], text);

  state.pending = state.pending.filter((c) => !isAsked(c));
  delete state.ask;
  state.skips = 0;
  delete state.tell;
  lib.writeState(project, state);

  lib.emit({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Saved to ' + lib.DIR + '/' + lib.CHECKINS },
  });
} catch (e) {
  try { if (lib && project) lib.noteError(project, 'answer', e); } catch {}
}
quit();
