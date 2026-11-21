// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* An earlier release's carplay patcher, for the tests that need carplay as
 * an earlier release patched it in the file: waze-on-cluster 0.10.12, the
 * last release whose carplay_patch.js has `apply`. Its patch folder comes
 * from the release tag (fetched when missing) into a temporary folder, once
 * per process, removed at exit.
 *
 *   var earlier = require('./earlier_patcher.js');
 *   earlier.script()            its carplay_patch.js
 *   earlier.scriptFor(args, cur) its carplay_patch.js for an `apply`, else cur
 *   earlier.run(args, env)      {code, out} of its carplay_patch.js
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var TAG = 'waze-on-cluster@0.10.12';
var REPO = path.join(__dirname, '..', '..', '..', '..');
var dir = null;

function git(args) { return cp.execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

function hasTag() {
    try { return git(['tag', '-l', TAG]).trim() === TAG; } catch (e) { return false; }
}

/* The release's patch folder. */
function patchDir() {
    if (dir) return dir;
    if (!hasTag()) {
        /* a shallow checkout (CI) fetches it shallow; a full clone stays full */
        var shallow = false;
        try { shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'; } catch (e) {}
        try { git(['fetch', '--no-tags'].concat(shallow ? ['--depth=1'] : [], ['origin', '+refs/tags/' + TAG + ':refs/tags/' + TAG])); } catch (e) {}
        if (!hasTag()) throw new Error('earlier_patcher: no ' + TAG + ' tag, and fetching it failed');
    }
    var d = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-earlier-'));
    process.on('exit', function () { try { cp.execFileSync('rm', ['-rf', d]); } catch (e) {} });
    cp.execSync('git archive "' + TAG + '" native/waze-on-cluster/patch | tar -x -C "' + d + '" --strip-components=3', { cwd: REPO });
    dir = d;
    return dir;
}

function script() { return path.join(patchDir(), 'carplay_patch.js'); }

/* The patcher that runs args: the release's for an apply (this version has
 * none), cur for every other command. */
function scriptFor(args, cur) { return args[0] === 'apply' ? script() : cur; }

function run(args, env) {
    var r = cp.spawnSync(process.execPath, [script()].concat(args), { encoding: 'utf8', env: env || process.env });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

module.exports = { TAG: TAG, dir: patchDir, script: script, scriptFor: scriptFor, run: run };
