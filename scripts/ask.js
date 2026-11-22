'use strict';
// Stop hook. With three or more changes not yet in his words, keeps the turn going
// once through hookSpecificOutput.additionalContext: one line that names the changes
// and the cfms:ask skill, which holds how Claude asks (unit 003, R6).
// Records the ask in cfms/state.json (ask.at, ask.paths, lastAsk).
// Never a nag (unit 003): no ask within the gap of the last ask (CFMS_GAP_MINUTES,
// default 30, doubled for every three skips in a row), none when CFMS_QUIET=1, and
// none when the Stop input shows background tasks or session crons.
// Never twice in one stop: stop_hook_active true lets Claude stop.
// Silent otherwise; exits 0 whatever happens.

let project = null;
let lib = null;

function quit() {
  process.exit(0);
}

process.on('uncaughtException', (e) => {
  try { if (lib && project) lib.noteError(project, 'ask', e); } catch {}
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
    if (project) lib.noteError(project, 'ask: input is not JSON', e);
    quit();
  }
  if (!input || typeof input !== 'object' || input.hook_event_name !== 'Stop') quit();
  if (!project) project = lib.projectDir(input);
  if (!project || !lib.isOn(project)) quit();
  if (input.stop_hook_active === true) quit();
  if (lib.quiet(input)) quit();

  const state = lib.readState(project);
  if (state.pending.length < lib.ASK_AT) quit();
  const at = lib.now();
  if (lib.withinGap(state, at)) quit();

  const paths = lib.newestFirst(state.pending).slice(0, lib.ASK_MAX).map((c) => c.path);
  const tell = state.tell === true ? lib.skipLine(state) : '';
  state.ask = { at, paths };
  state.lastAsk = at;
  delete state.tell;
  lib.writeState(project, state);

  lib.emit({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: lib.askLine(paths, state.pending.length, tell) },
  });
} catch (e) {
  try { if (lib && project) lib.noteError(project, 'ask', e); } catch {}
}
quit();
