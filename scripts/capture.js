'use strict';
// PostToolUse hook for Edit, Write, MultiEdit and NotebookEdit.
// Notes the edited file, relative to the project, in cfms/state.json pending.
// Silent always: prints nothing and exits 0, whatever happens.

let project = null;
let lib = null;

function quit() {
  process.exit(0);
}

process.on('uncaughtException', (e) => {
  try { if (lib && project) lib.noteError(project, 'capture', e); } catch {}
  quit();
});

try {
  lib = require('./lib');
  const raw = lib.readStdin();
  // Project first, so a malformed input can still be noted when CFMS is on.
  project = lib.projectDir(null);
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    if (project) lib.noteError(project, 'capture: input is not JSON', e);
    quit();
  }
  if (!project) project = lib.projectDir(input);
  if (!project || !lib.isOn(project)) quit();

  const ti = input && input.tool_input;
  const filePath = ti && (ti.file_path || ti.notebook_path);
  if (typeof filePath !== 'string' || !filePath) {
    lib.noteError(project, 'capture: no file path in tool_input', 'tool ' + (input && input.tool_name));
    quit();
  }

  const rel = lib.relativeToProject(project, filePath, input.cwd);
  if (rel === null || lib.insideCfms(rel)) quit();

  const state = lib.readState(project);
  const at = lib.now();
  lib.addPending(state, rel, at);
  lib.writeState(project, state);
} catch (e) {
  try { if (lib && project) lib.noteError(project, 'capture', e); } catch {}
}
quit();
