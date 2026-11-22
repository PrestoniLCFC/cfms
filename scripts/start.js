'use strict';
// SessionStart hook on startup, resume and compact (unit 004, the return).
// Only where cfms/ exists. After a gap of 8 hours since the last capture or answer,
// or while cfms/NOW.md has no line yet, adds the recall: Claude asks the user in the
// CFMS dialog what the project is for, then shows his last lines and what changed.
// Otherwise, and always after a compact (unit 008), adds one line of counts. Then (unit 005) his standing rules and newest
// decisions from cfms/DECISIONS.md under the catch line, or one line naming the skill
// that records them. Writes nothing; on any error prints nothing.
// Exits 0 whatever happens.

function quit() {
  process.exit(0);
}

process.on('uncaughtException', () => quit());

try {
  const lib = require('./lib');
  const raw = lib.readStdin();
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    quit();
  }
  if (!input || typeof input !== 'object' || input.hook_event_name !== 'SessionStart') quit();
  if (!lib.START_SOURCES.includes(input.source)) quit();
  const project = lib.projectDir(input);
  if (!project || !lib.isOn(project)) quit();

  // Unit 005: his decisions and standing rules follow the return, with the catch line.
  // Unit 008: after a compact, the counts line and never the recall.
  const text = lib.returnContext(project, lib.now(), input.source) + '\n\n' + lib.decisionsContext(project);
  lib.emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
} catch {}
quit();
