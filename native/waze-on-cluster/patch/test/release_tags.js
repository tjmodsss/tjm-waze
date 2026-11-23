// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* This repository's waze-on-cluster release tags, for the tests that run
 * earlier releases' code: the ones at hand, and those fetched from origin
 * when missing. A shallow checkout (CI) fetches them shallow; a full clone
 * stays full.
 *
 * Test processes running side by side in one checkout fetch at the same
 * time, and git lets one write at a time (the shallow file, a tag's ref): a
 * fetch that fails on a lock another git holds is tried again, until it
 * succeeds or another error, or none for FETCH_MS. Any other failure (no
 * origin, no network) ends it at once.
 *
 *   var tags = require('./release_tags.js');
 *   tags.list()          ['waze-on-cluster@0.5.0', ...], or null outside a git checkout
 *   tags.has(tag)        whether the tag is at hand
 *   tags.fetch(pattern)  fetches refs/tags/<pattern> ('waze-on-cluster@0.10.12',
 *                        'waze-on-cluster@*'); '' when it worked, else git's words
 */
'use strict';

var path = require('path');
var cp = require('child_process');

var REPO = path.join(__dirname, '..', '..', '..', '..');
var FETCH_MS = 120000;
var LOCKED = /\.lock'?:? File exists|Unable to create '[^']*\.lock'|cannot lock ref|shallow file has changed|could not lock|is at [0-9a-f]+ but expected/i;

function git(args) { return cp.execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }); }

function list() {
    try { return git(['tag', '-l', 'waze-on-cluster@*']).split('\n').filter(Boolean); } catch (e) { return null; }
}

function has(tag) { var l = list(); return !!l && l.indexOf(tag) >= 0; }

/* Blocks this process for ms: the test scripts are synchronous here. */
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function fetch(pattern) {
    var shallow = false;
    try { shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'; } catch (e) {}
    var args = ['fetch', '--no-tags'].concat(shallow ? ['--depth=1'] : [], ['origin', '+refs/tags/' + pattern + ':refs/tags/' + pattern]);
    var end = Date.now() + FETCH_MS, wait = 50;
    for (;;) {
        var r = cp.spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
        if (r.status === 0) return '';
        var words = ((r.stderr || '') + (r.error ? r.error.message : '')).trim() || 'git fetch exited ' + r.status;
        if (!LOCKED.test(words) || Date.now() >= end) return words;
        pause(wait);
        wait = Math.min(wait * 2, 1000);
    }
}

module.exports = { list: list, has: has, fetch: fetch, REPO: REPO };
