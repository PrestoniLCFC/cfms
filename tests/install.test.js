'use strict';
// Unit 006, install from GitHub: the repo is its own marketplace, and the README's
// install lines name what the files declare. Reads repo files only; writes nothing.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(h.REPO, rel), 'utf8');
const market = () => JSON.parse(read('.claude-plugin/marketplace.json'));
const plugin = () => JSON.parse(read('.claude-plugin/plugin.json'));

test('the marketplace file has a name, an owner and one plugin entry, the plugin at the repo root', () => {
  const m = market();
  assert.strictEqual(m.name, 'cfms');
  assert.ok(m.owner && typeof m.owner.name === 'string' && m.owner.name.trim(), 'owner.name');
  assert.ok(typeof m.description === 'string' && m.description.trim(), 'description');
  assert.ok(Array.isArray(m.plugins) && m.plugins.length === 1, 'one plugin');
  const e = m.plugins[0];
  assert.strictEqual(e.source, './');
  assert.strictEqual(e.name, plugin().name, 'entry name matches plugin.json');
  assert.strictEqual(e.version, undefined, 'version only in plugin.json');
});

test('the README install lines name the marketplace and plugin the files declare', () => {
  const m = market();
  const id = m.plugins[0].name + '@' + m.name;
  const readme = read('README.md');
  const lines = readme.split(/\r?\n/);
  assert.ok(!readme.includes('<owner>/<repo>'), 'no placeholder left');
  const add = lines.indexOf('/plugin marketplace add ' + h.GITHUB);
  const install = lines.indexOf('/plugin install ' + id);
  assert.ok(add >= 0, 'marketplace add line');
  assert.ok(install > add, 'install line after the add line');
  assert.ok(!/cowork/i.test(readme), 'no Cowork anywhere in the README');
  assert.ok(lines.includes('/cfms:on'), '/cfms:on line');
  assert.ok(readme.includes('/plugin uninstall ' + id), 'uninstall line');
  assert.ok(readme.includes('/plugin marketplace remove ' + m.name), 'marketplace remove line');
});

test('the README says where it runs first, and names Node.js, cfms/, CFMS_QUIET=1 and git', () => {
  const readme = read('README.md');
  const firstPara = readme.split(/\r?\n\r?\n/)[1];
  assert.match(firstPara, /Claude Code/);
  assert.match(firstPara, /computer/);
  assert.match(firstPara, /does not run in the Claude app/);
  for (const s of ['Node.js', '`cfms/`', 'CFMS_QUIET=1', 'git repository', 'Skip', 'nothing over the network']) {
    assert.ok(readme.includes(s), 'README names ' + s);
  }
});
