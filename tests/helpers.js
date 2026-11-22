'use strict';
// Test helpers: fixture projects in a temp folder, recorded hook inputs, and runners
// that call the real scripts as Claude Code would (stdin JSON, env, exit code, stdout).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO, 'scripts');
const INPUTS = path.join(__dirname, 'inputs');
// His GitHub repo, the marketplace the README's install lines add. Written here only.
const GITHUB = 'PrestoniLCFC/cfms';
const made = new Set();

function makeFixture(withCfms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfms-fixture-'));
  // Never this repo, never a real project.
  assert.ok(!path.resolve(dir).toLowerCase().startsWith(REPO.toLowerCase() + path.sep), 'fixture is inside the repo');
  made.add(dir);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'const a = 1;\n');
  if (withCfms) {
    const r = runOn(dir);
    assert.strictEqual(r.status, 0);
  }
  return dir;
}

function removeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(dir), 'fixture still exists: ' + dir);
  made.delete(dir);
}

function leftovers() {
  return [...made].filter((d) => fs.existsSync(d));
}

// Every file under dir, relative with forward slashes, mapped to its content.
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (fs.statSync(p).isDirectory()) {
        out[rel + '/'] = null;
        walk(p);
      } else {
        out[rel] = fs.readFileSync(p, 'utf8');
      }
    }
  })(dir);
  return out;
}

// A recorded input with __PROJECT__ replaced by the fixture, in the platform's own
// separators (Windows paths arrive with backslashes).
function input(name, project) {
  const raw = fs.readFileSync(path.join(INPUTS, name), 'utf8');
  if (!name.endsWith('.json')) return raw;
  const fill = (v) => path.normalize(v.split('__PROJECT__').join(project));
  const obj = JSON.parse(raw);
  // Only path fields are normalised; other strings are left byte for byte.
  const pathy = new Set(['cwd', 'transcript_path', 'file_path', 'notebook_path', 'filePath']);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pathy.has(k) && typeof x === 'string' ? fill(x) : walk(x)]));
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}

function cleanEnv(extra) {
  const env = { ...process.env };
  // The suite may run inside a Claude Code session whose project is this repo:
  // never let that leak into a script under test.
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CFMS_NOW;
  // A loop may run the suite with these set; a test sets them itself when it needs them.
  delete env.CFMS_QUIET;
  delete env.CFMS_GAP_MINUTES;
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runCapture(stdin, env) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'capture.js')], {
    input: stdin,
    env: cleanEnv(env),
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 15000,
  });
}

// Any hook script, called as Claude Code calls it.
function runScript(name, stdin, env) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, name)], {
    input: stdin,
    env: cleanEnv(env),
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 15000,
  });
}

function runOn(project, args, env) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'on.js'), ...(args === undefined ? [project] : args)], {
    env: cleanEnv(env),
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 15000,
  });
}

function state(project) {
  return JSON.parse(fs.readFileSync(path.join(project, 'cfms', 'state.json'), 'utf8'));
}

module.exports = { REPO, GITHUB, makeFixture, removeFixture, leftovers, snapshot, input, runCapture, runScript, runOn, state };
