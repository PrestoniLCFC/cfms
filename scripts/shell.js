'use strict';
// PreToolUse, PostToolUse and PostToolUseFailure hook for the Bash and PowerShell tools.
// Before a shell call it looks at git's list of changed and untracked files in the
// project, with each file's modified time and size, and keeps that look in cfms/.
// After the call it looks again and notes, as pending, every file that changed while
// the call ran. Git runs read only (--no-optional-locks). A project that is not in a
// git repo is not covered. Silent always: prints nothing and exits 0, whatever happens.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SHELLS = ['Bash', 'PowerShell'];
const LOOK_PREFIX = 'state.json.shell-'; // matches 001's cfms/.gitignore line state.json.*.tmp
const LOOK_SUFFIX = '.tmp';
const LOOK_MAX_AGE = 24 * 3600 * 1000; // looks left by denied or cancelled calls are cleared after a day
const SLACK = 2000; // ms: a file changed during the call has a modified time after the look before, less this

let project = null;
let lib = null;

function quit() {
  process.exit(0);
}

process.on('uncaughtException', (e) => {
  try { if (lib && project) lib.noteError(project, 'shell', e); } catch {}
  quit();
});

function git(args) {
  return spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

// The project's place in its git repo ('' at the root, 'sub/dir/' below it),
// or null when the project is not in a git repo (or git is missing).
function repoPrefix() {
  const r = git(['rev-parse', '--show-prefix']);
  if (r.error || r.status !== 0) return null;
  return r.stdout.replace(/\r?\n$/, '');
}

function statOf(rel) {
  try {
    const s = fs.statSync(path.join(project, ...rel.split('/')));
    return [s.mtimeMs, s.size];
  } catch {
    return null; // gone
  }
}

// Every changed, deleted or untracked file under the project that git lists
// (ignored files and submodules left out), relative to the project, with its stat
// and whether it is untracked.
function look(prefix) {
  const r = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all', '--', '.']);
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('git status exited ' + r.status + ': ' + String(r.stderr).trim().slice(0, 200));
  const files = {};
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const full = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the original path follows; not expected with --no-renames
    if (!full.startsWith(prefix)) continue;
    const rel = full.slice(prefix.length).replace(/\/$/, '');
    if (!rel || rel === '.git' || rel.startsWith('.git/') || lib.insideCfms(rel)) continue;
    files[rel] = { stat: statOf(rel), untracked: xy === '??' };
  }
  return files;
}

function lookFile(id) {
  return path.join(lib.cfmsDir(project), LOOK_PREFIX + id + LOOK_SUFFIX);
}

function clearOldLooks() {
  const dir = lib.cfmsDir(project);
  const limit = Date.now() - LOOK_MAX_AGE;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(LOOK_PREFIX) || !name.endsWith(LOOK_SUFFIX)) continue;
    try {
      const p = path.join(dir, name);
      if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p);
    } catch {}
  }
}

const same = (a, b) => (a === null && b === null) || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

// The files that changed between the look before and the look after.
function changed(before, after, startMs) {
  const out = [];
  for (const [rel, b] of Object.entries(before.files || {})) {
    const a = after[rel];
    // Listed both times: changed when its time or size moved. Listed before only
    // (committed, staged clean, reverted, deleted untracked): changed unless it is
    // still there exactly as it was.
    const now = a ? a.stat : statOf(rel);
    if (!same(b && b.stat, now)) out.push(rel);
  }
  for (const [rel, a] of Object.entries(after)) {
    if (before.files && rel in before.files) continue;
    // New to the list: a new untracked file, a deleted file, or a tracked file that
    // was clean before. That last one changed only if its time is after the look before
    // (a git command that moves only the index, such as a reset, leaves it older).
    if (a.untracked || a.stat === null || a.stat[0] >= startMs - SLACK) out.push(rel);
  }
  return out.sort();
}

try {
  lib = require('./lib');
  const raw = lib.readStdin();
  project = lib.projectDir(null);
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    if (project && lib.isOn(project)) lib.noteError(project, 'shell: input is not JSON', e);
    quit();
  }
  if (!project) project = lib.projectDir(input);
  if (!project || !lib.isOn(project)) quit();
  if (!input || !SHELLS.includes(input.tool_name)) quit();

  const id = String(input.tool_use_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120) || 'none';
  const event = input.hook_event_name;

  if (event === 'PreToolUse') {
    const prefix = repoPrefix();
    if (prefix === null) quit(); // not in a git repo: not covered
    clearOldLooks();
    const start = Date.now();
    const files = look(prefix);
    fs.writeFileSync(lookFile(id), JSON.stringify({ format: 1, start, prefix, files }), 'utf8');
    quit();
  }

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const file = lookFile(id);
    let before;
    try {
      before = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      quit(); // no look before: not in a git repo, or CFMS was turned on during the call
    }
    try {
      const after = look(typeof before.prefix === 'string' ? before.prefix : '');
      const rels = changed(before, after, Number(before.start) || 0);
      if (rels.length) {
        const state = lib.readState(project);
        const at = lib.now();
        for (const rel of rels) lib.addPending(state, rel, at);
        lib.writeState(project, state);
      }
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  }
} catch (e) {
  try { if (lib && project) lib.noteError(project, 'shell', e); } catch {}
}
quit();
