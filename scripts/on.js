'use strict';
// /cfms:on : turns CFMS on in the current project by creating cfms/,
// cfms/state.json and cfms/.gitignore. Running it again changes nothing.
// Then prints the CFMS recall (unit 004), which the skill tells Claude to ask at once.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const GITIGNORE = '# CFMS machine state, not for git\n' + lib.STATE + '\n' + lib.STATE + '.*.tmp\n';

function main() {
  // The skill passes the project root as the first argument; an unsubstituted
  // or empty argument falls back to CLAUDE_PROJECT_DIR, then the working folder.
  const arg = process.argv[2];
  const project = arg && arg.trim() && !arg.includes('${')
    ? path.resolve(arg)
    : lib.projectDir({ cwd: process.cwd() });
  const dir = lib.cfmsDir(project);
  const wasOn = lib.isOn(project);

  fs.mkdirSync(dir, { recursive: true });
  const made = [];
  if (!fs.existsSync(lib.statePath(project))) {
    lib.writeState(project, lib.emptyState());
    made.push(lib.DIR + '/' + lib.STATE);
  }
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, GITIGNORE, 'utf8');
    made.push(lib.DIR + '/.gitignore');
  }

  if (wasOn && made.length === 0) {
    console.log('CFMS is already on in ' + project + '.');
  } else {
    console.log('CFMS is on in ' + project + '. Created: ' + (wasOn ? made.join(', ') : lib.DIR + '/, ' + made.join(', ')) + '.');
    console.log('Every file Claude edits here is now noted in ' + lib.DIR + '/' + lib.STATE + '.');
  }
  return project;
}

let project = null;
try {
  project = main();
} catch (e) {
  console.log('CFMS could not turn on: ' + ((e && e.message) || e));
}
// Unit 004, R6: every run ends with the recall, already on or not. Reads only.
if (project) {
  try {
    const text = lib.recallContext(lib.returnData(project));
    console.log('');
    console.log(text);
  } catch {}
}
process.exit(0);
