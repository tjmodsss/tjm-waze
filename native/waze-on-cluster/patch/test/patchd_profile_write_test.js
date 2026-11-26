#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* patchd's map settings written for a driver profile: a cluster, hud,
 * hud-size, hud-pos or hud-keep-shown command that names the profile and set
 * the app's page showed ("profile", "own") is saved into those settings
 * only. A write for a profile other than the one in effect, before any
 * profile is told since the start, for the own settings while the shared
 * ones are in effect or the other way round, is refused: nothing saved in
 * any profile's settings, the shared ones or map.state.conf, and the reply
 * carries the settings in effect. The guest profile is a profile like any
 * other. A write taken before a switch is saved into the settings it was
 * made for, also when the switch comes before the delayed write, in either
 * order on one connection. A write without "profile" (an earlier app) is
 * saved only while no driver has own settings, which the status and the
 * replies say. profiles.json and map.state.conf written by an earlier
 * release are kept as they are. */
'use strict';
var cp = require('child_process');
var fs = require('fs');
var net = require('net');
var path = require('path');
var tmp = require('./tmp.js');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var dir = tmp.dir();
var SOCK = path.join(dir, 'sock', 'patch.sock');
var CONF = path.join(dir, 'waze-on-cluster.local.conf');
var STATE = path.join(dir, 'map.state.conf');
var PROFILES = path.join(dir, 'profiles.json');
var SAVE_MS = 200;
fs.writeFileSync(CONF, 'upload_kb_per_s = 3000\n');

var ENV = Object.assign({}, process.env, {
    WOC_PATCH_SOCK: SOCK,
    WOC_PATCH_GROUP: '',
    WOC_LOCAL_CONF: CONF,
    WOC_STATE_DIR: dir,
    WOC_CARPLAY: path.join(dir, 'no-carplay'),
    WOC_STREAM_STATE: path.join(dir, 'no-stream.json'),
    WOC_RESYNC_FILE: path.join(dir, 'resync.json'),
    WOC_RECMGR_CONF: path.join(dir, 'no-recmgr'),
    WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
    WOC_PROC_STAT: path.join(dir, 'no-stat'),
    WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
    WOC_MOUNT: path.join(dir, 'no-mount'),
    WOC_PROC_MOUNTS: path.join(dir, 'no-mounts'),
    WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
    WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
    WOC_DLT_RETRY_MS: '600000',
    WOC_REMOUNT_LOCK: path.join(dir, 'remount.lock'),
    WOC_MAP_SAVE_MS: String(SAVE_MS),
    WOC_SAVE_RETRY_MS: '300',
});
var out = '';
var p = null;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function start() {
    var n = out.split('patchd listening').length;
    p = cp.spawn(process.execPath, [PATCHD], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', function (d) { out += d; });
    p.stderr.on('data', function (d) { out += d; });
    for (var t = 0; t < 5000 && out.split('patchd listening').length <= n; t += 50) await sleep(50);
}
async function stop() {
    var c = p;
    c.kill();
    await new Promise(function (resolve) { c.on('exit', resolve); });
}
/* Several requests on one connection, written at once; resolves to their replies. */
function askAll(list) {
    return new Promise(function (resolve, reject) {
        var s = net.connect(SOCK), buf = '', replies = [];
        s.setEncoding('utf8');
        s.on('connect', function () { s.write(list.map(function (o) { return JSON.stringify(o) + '\n'; }).join('')); });
        s.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var m = null;
                try { m = JSON.parse(buf.slice(0, i)); } catch (e) {}
                buf = buf.slice(i + 1);
                if (m && /-reply$/.test(m.ev)) replies.push(m);
            }
            if (replies.length === list.length) { s.end(); resolve(replies); }
        });
        s.on('error', reject);
        setTimeout(function () { reject(new Error('no replies to ' + JSON.stringify(list))); }, 5000);
    });
}
function ask(obj) { return askAll([obj]).then(function (r) { return r[0]; }); }
/* The status a new connection gets; statusNext: the next status after it. */
function statusNow(next) {
    return new Promise(function (resolve, reject) {
        var s = net.connect(SOCK), buf = '', seen = 0;
        s.setEncoding('utf8');
        s.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var m = null;
                try { m = JSON.parse(buf.slice(0, i)); } catch (e) {}
                buf = buf.slice(i + 1);
                if (m && m.ev === 'status' && seen++ === (next ? 1 : 0)) { s.end(); resolve(m); return; }
            }
        });
        s.on('error', reject);
        setTimeout(function () { reject(new Error('no status')); }, 5000);
    });
}
function statusNext() { return statusNow(true); }
function state() {
    var s = {};
    fs.readFileSync(STATE, 'utf8').split('\n').forEach(function (l) {
        var m = /^(\w+) = (-?\d+)$/.exec(l);
        if (m) s[m[1]] = Number(m[2]);
    });
    return s;
}
function profiles() { return JSON.parse(fs.readFileSync(PROFILES, 'utf8')); }
function settings(cluster, hud, pct, x, y, keep) {
    return { cluster: cluster, hud: hud, hud_width_pct: pct, hud_offset_x: x, hud_offset_y: y, hud_keep_shown: keep || 0 };
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
/* map.state.conf's settings, in whatever order its lines are */
function sameKeys(a, b) { return Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(function (k) { return a[k] === b[k]; }); }
function stateText(s) { return Object.keys(s).map(function (k) { return k + ' = ' + s[k]; }).join('\n') + '\n'; }
function files() { return fs.readFileSync(PROFILES, 'utf8') + '|' + fs.readFileSync(STATE, 'utf8'); }
/* For a check that nothing is written: past the save's delay. */
function saved() { return sleep(SAVE_MS + 150); }
/* For a check that something is written: until it holds, at most 10 s
 * (a save syncs the disk, which can take long on a busy machine). */
async function when(cond) {
    for (var end = Date.now() + 10000; ;) {
        var v = false;
        try { v = !!cond(); } catch (e) {}
        if (v || Date.now() > end) return v;
        await sleep(20);
    }
}

var passed = 0, total = 0;
function ok(name, cond, detail) {
    total++;
    if (cond) passed++;
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : ' (' + detail + ')') + '\n');
}

var A = 'a1b2c3d4-0000-4000-8000-000000000001', B = 'a1b2c3d4-0000-4000-8000-000000000002';
var GUEST = 'de.bmw.infotainment.personalization.UserAccountManager.guest';
/* A with its own settings (the HUD alone, 60 %), B with its own (both, 40 %),
 * the shared ones on the cluster alone; `active` in effect. */
var OWN_A = settings(0, 1, 60, 0, 0), OWN_B = settings(1, 1, 40, 10, 0), SHARED = settings(1, 0, 0, 0, 0);
function threeSets(active) {
    var own = {};
    own[A] = OWN_A;
    own[B] = OWN_B;
    fs.writeFileSync(PROFILES, JSON.stringify({ shared: SHARED, own: own, active: active }) + '\n');
    fs.writeFileSync(STATE, stateText(active ? own[active] : SHARED));
}

(async function () {
    /* Before any profile is told since the start: refused. */
    threeSets(A);
    await start();
    var before = files();
    var r = await ask({ cmd: 'hud', on: 0, profile: A, own: 1 });
    await saved();
    ok('before any profile is told since the start: a write for A refused, nothing saved, the settings in effect in the reply',
        r.ok === false && r.refused === 'profile' && /no driver profile told/.test(r.reason) && same(r.settings, OWN_A) && files() === before,
        JSON.stringify(r));

    /* B confirmed: a write for A refused; neither A's, B's nor the shared settings change. */
    await ask({ cmd: 'profile', id: B });
    await when(function () { return profiles().active === B && sameKeys(state(), OWN_B); });
    before = files();
    var writes = [
        { cmd: 'hud', on: 0, profile: A, own: 1 }, { cmd: 'cluster', on: 1, profile: A, own: 1 },
        { cmd: 'hud-size', hud_width_pct: 85, profile: A, own: 1 }, { cmd: 'hud-pos', hud_x: -50, hud_y: 5, profile: A, own: 1 },
        { cmd: 'hud-keep-shown', on: 1, profile: A, own: 1 }, { cmd: 'hud', on: 0, profile: A, own: 0 },
        { cmd: 'hud', on: 0, profile: null, own: 0 }];
    var refused = [];
    for (var i = 0; i < writes.length; i++) refused.push(await ask(writes[i]));
    await saved();
    var pf = profiles();
    ok('B in effect: every map setting written for A (own or shared) or for no profile refused, with B\'s settings in the reply',
        refused.every(function (x) { return x.ok === false && x.refused === 'profile' && same(x.settings, OWN_B); }),
        JSON.stringify(refused));
    ok('B in effect, writes for A refused: A\'s, B\'s and the shared settings and map.state.conf unchanged',
        files() === before && same(pf.own[A], OWN_A) && same(pf.own[B], OWN_B) && same(pf.shared, SHARED) && sameKeys(state(), OWN_B),
        JSON.stringify(pf));
    ok('a refused write is logged without the profile id', /not saved: hud for the own map settings of driver profile [0-9a-f]{8}: not the driver profile in effect/.test(out) &&
        out.indexOf(A) < 0);

    /* B's own settings while B is in effect: saved, A's and the shared untouched. */
    r = await ask({ cmd: 'hud-size', hud_width_pct: 50, profile: B, own: 1 });
    ok('a write for B\'s own settings while B is in effect: saved into B\'s and map.state.conf only', r.ok && await when(function () {
        pf = profiles();
        return pf.own[B].hud_width_pct === 50 && same(pf.own[A], OWN_A) && same(pf.shared, SHARED) && state().hud_width_pct === 50;
    }), JSON.stringify(profiles()));
    r = await ask({ cmd: 'hud-size', hud_width_pct: 70, profile: B, own: 0 });
    ok('a write for B\'s shared settings while B has its own: refused', r.ok === false && /has its own/.test(r.reason) &&
        profiles().own[B].hud_width_pct === 50 && same(profiles().shared, SHARED));
    r = await ask({ cmd: 'hud', on: 0, profile: 'a/b', own: 0 });
    var r2 = await ask({ cmd: 'hud', on: 0, profile: B, own: 2 });
    ok('a write naming no profile id, or own other than 0 or 1: refused', r.ok === false && /not a profile id/.test(r.reason) &&
        r2.ok === false && /own must be/.test(r2.reason));

    /* The profile sync and a page write on one connection, in both orders. */
    /* 85 % is in none of A's (60), B's (50) or the shared (0) settings */
    var bNow = profiles().own[B];
    var both = await askAll([{ cmd: 'profile', id: A }, { cmd: 'hud-size', hud_width_pct: 85, profile: B, own: 1 }]);
    await when(function () { return profiles().active === A && sameKeys(state(), OWN_A); });
    await saved();
    pf = profiles();
    ok('the switch to A first, then a write B\'s page made: refused; A\'s, B\'s and the shared settings unchanged',
        both[0].ok && both[1].ok === false && both[1].refused === 'profile' && same(both[1].settings, OWN_A) && same(pf.own[B], bNow) &&
        bNow.hud_width_pct === 50 && same(pf.own[A], OWN_A) && same(pf.shared, SHARED) && sameKeys(state(), OWN_A), JSON.stringify(both));
    both = await askAll([{ cmd: 'hud-keep-shown', on: 1, profile: A, own: 1 }, { cmd: 'profile', id: B }]);
    ok('a write for A, then the switch to B before the delayed write: saved into A\'s settings only, map.state.conf B\'s',
        both.every(function (x) { return x.ok; }) && await when(function () {
            pf = profiles();
            return pf.own[A].hud_keep_shown === 1 && pf.own[B].hud_keep_shown === 0 && same(pf.shared, SHARED) && pf.active === B &&
                sameKeys(state(), pf.own[B]);
        }), JSON.stringify(profiles()));

    /* The guest profile: a profile like any other, on the shared settings. */
    r = await ask({ cmd: 'profile', id: GUEST });
    ok('the guest profile: the shared settings in effect', r.ok && r.own === false && same(r.settings, SHARED));
    r = await ask({ cmd: 'hud', on: 1, profile: GUEST, own: 0 });
    ok('a write for the guest profile: saved into the shared settings, A\'s and B\'s untouched', r.ok && await when(function () {
        pf = profiles();
        return pf.shared.hud === 1 && pf.own[A].hud === 1 && pf.own[B].hud_width_pct === 50 && state().hud === 1 && state().cluster === 1;
    }), JSON.stringify(profiles()));
    before = files();
    r = await ask({ cmd: 'hud', on: 0, profile: A, own: 1 });
    r2 = await ask({ cmd: 'hud', on: 0, profile: GUEST, own: 1 });
    await saved();
    ok('the guest profile in effect: a write for A, or for the guest\'s own settings, refused, nothing saved',
        r.ok === false && r2.ok === false && files() === before);

    /* Own settings turned on and off mid-session. */
    await ask({ cmd: 'profile', id: 'driverC' });
    r = await ask({ cmd: 'profile-own', id: 'driverC', on: 1 });
    await when(function () { return 'driverC' in profiles().own; });
    before = files();
    r = await ask({ cmd: 'hud', on: 0, profile: 'driverC', own: 0 });
    await saved();
    ok('own settings ticked: a write the page made on the shared settings refused, nothing saved', r.ok === false &&
        /has its own/.test(r.reason) && files() === before && profiles().own.driverC.hud === 1);
    r = await ask({ cmd: 'hud', on: 0, profile: 'driverC', own: 1 });
    ok('own settings ticked: a write for them saved into them only', r.ok && await when(function () {
        pf = profiles();
        return pf.own.driverC.hud === 0 && pf.shared.hud === 1;
    }), JSON.stringify(profiles()));
    await ask({ cmd: 'profile-own', id: 'driverC', on: 0 });
    await when(function () { return !('driverC' in profiles().own) && state().hud === 1; });
    before = files();
    r = await ask({ cmd: 'hud', on: 0, profile: 'driverC', own: 1 });
    await saved();
    ok('own settings unticked: a write the page made on them refused, the shared settings unchanged', r.ok === false &&
        /uses the shared/.test(r.reason) && files() === before && profiles().shared.hud === 1);

    /* An earlier app: no "profile". Drivers with own settings: refused. */
    var st = await statusNow();
    before = files();
    r = await ask({ cmd: 'hud-size', hud_width_pct: 30 });
    await saved();
    ok('drivers with own settings: said in the status; a write without "profile" (an earlier app) refused, nothing saved',
        st.own_settings === true && r.ok === false && r.refused === 'profile' && /update Maps on cluster/.test(r.reason) &&
        r.own_settings === true && files() === before, JSON.stringify(r));
    await stop();

    /* No driver with own settings: the shared settings are the only ones, a
     * write without "profile" is saved; the first own settings ticked are said. */
    fs.unlinkSync(PROFILES);
    fs.writeFileSync(STATE, stateText(SHARED));
    await start();
    st = await statusNow();
    r = await ask({ cmd: 'hud-size', hud_width_pct: 30 });
    ok('no driver with own settings: said in the status; a write without "profile" saved', st.own_settings === false && r.ok &&
        r.settings.hud_width_pct === 30 && await when(function () { return state().hud_width_pct === 30; }), JSON.stringify(r));
    await ask({ cmd: 'profile', id: A });
    var told = statusNext();
    r = await ask({ cmd: 'profile-own', id: A, on: 1 });
    st = await told;
    ok('own settings ticked: the reply and a status say so', r.ok && r.own_settings === true && st.own_settings === true);
    await stop();

    /* profiles.json and map.state.conf of an earlier release: kept as they are. */
    threeSets(B);
    before = files();
    await start();
    r = await ask({ cmd: 'profile', id: B });
    await saved();
    ok('an earlier release\'s files: kept as they are at the start and when the profile in effect is told', r.ok && r.own && !r.changed &&
        files() === before);
    r = await ask({ cmd: 'profile', id: A });
    ok('then another driver: that driver\'s stored settings in effect, every set kept', r.ok && r.own && same(r.settings, OWN_A) &&
        await when(function () { pf = profiles(); return same(pf.own[A], OWN_A) && same(pf.own[B], OWN_B) && same(pf.shared, SHARED); }));
    await stop();
})().catch(function (e) {
    ok('no error: ' + e.message, false);
}).then(function () {
    if (p) p.kill();
    process.stdout.write(passed + '/' + total + ' passed\n');
    if (passed !== total) { process.stdout.write(out); process.exitCode = 1; }
});
