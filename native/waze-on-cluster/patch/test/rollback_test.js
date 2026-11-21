#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Every released carplay patcher against this version (PATCH.md
 * "Rollback"): each release's own carplay_patch.js and boot recovery, taken
 * from its release tag, acting on carplay as this version leaves it (stock
 * on disk, the patch in memory), and this version acting on a carplay each
 * release patched: its boot recovery, Remove patch and removal end stock,
 * and its activate puts carplay back to stock and plans the patch in
 * memory. This version never writes a patch into the file. Boot recovery is
 * each release's own restore code (what its boot step and watcher run once
 * carplay failed enough), called directly; the crash count that leads there
 * is recovery_test.js's.
 *
 * The releases, grouped by what their patcher and boot recovery do:
 *   A 0.5.0-0.6.3  fixed 22.28.3 offsets; revert restores the edits' bytes
 *                  of a file it recognises, refuses one it does not; boot
 *                  recovery runs that revert
 *   B 0.7.0-0.7.6  located sites, else as A
 *   C 0.7.7-0.8.4  revert writes the whole backup over a file it does not
 *                  recognise; boot recovery runs that revert
 *   D 0.8.5-0.9.10 boot recovery writes the whole trusted backup
 *   E 0.9.11       D, and knows the map URL edit at carplay 22.28.3's
 *                  offsets
 *   F 0.9.12-0.10.1 E, and writes the map URL edit wherever its sites are
 *                  found
 *   G 0.10.2-0.10.3 F, with the URL with `?showETA=yes` as the initial URL;
 *                  knows F's URL too
 *   H 0.10.4-0.10.12 G, writing F's URL again, and the ShowUI URL edit;
 *                  0.10.6 writes the safe area 476x306 at 306,72, every
 *                  other release and this version's plan 504x368 at 286,72
 * Groups A-D know four edits, E-G five, H and this version six. E and F write
 * and know the map URL (`maps:/car/instrumentcluster/map`) only, G writes the
 * URL with `?showETA=yes` and restores either, H writes the map URL and the
 * ShowUI URL, and H and this version restore either form of the map URL.
 * Only H and this version know the ShowUI URL edit. The app's patch on disk
 * is the one the last of them (earlier_patcher.js) writes.
 *
 * With CARPLAY_BIN every release runs on a copy of carplay 22.28.3; without
 * it B-G run on a synthetic build (synthetic_carplay.js), A not at all.
 * The release tags come from the repository's git, fetched when missing.
 *
 *   [CARPLAY_BIN=<carplay 22.28.3>] node rollback_test.js
 */
'use strict';

var car = require('./head_unit_env.js');   /* a HIGH head unit coded KI_KOMBI_VARIANT 7 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var synthetic = require('./synthetic_carplay.js');
var earlier = require('./earlier_patcher.js');
var locator = require('../carplay_locate.js');

var NEW = path.join(__dirname, '..');
var REPO = path.join(__dirname, '..', '..', '..', '..');
var BIN = process.env.CARPLAY_BIN || '';

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function git(args) { return cp.execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

/* ---- the releases ------------------------------------------------------- */

function semver(v) { return v.split('.').map(Number); }
function cmp(a, b) { a = semver(a); b = semver(b); for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }
function group(v) {
    return cmp(v, '0.6.3') <= 0 ? 'A' : cmp(v, '0.7.6') <= 0 ? 'B' : cmp(v, '0.8.4') <= 0 ? 'C' : cmp(v, '0.9.10') <= 0 ? 'D' :
        cmp(v, '0.9.11') <= 0 ? 'E' : cmp(v, '0.10.1') <= 0 ? 'F' : cmp(v, '0.10.3') <= 0 ? 'G' : 'H';
}

function tags() {
    try { return git(['tag', '-l', 'waze-on-cluster@*']).split('\n').filter(Boolean); } catch (e) { return null; }
}
var list = tags();
if (list === null) { process.stdout.write('SKIP: not in a git checkout\n'); process.exit(0); }
if (list.indexOf('waze-on-cluster@0.7.0') < 0) {
    /* none, or only the one earlier_patcher.js fetched: a shallow checkout
     * (CI) fetches them shallow; a full clone stays full */
    var shallow = false;
    try { shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'; } catch (e) {}
    try { git(['fetch', '--no-tags'].concat(shallow ? ['--depth=1'] : [], ['origin', '+refs/tags/waze-on-cluster@*:refs/tags/waze-on-cluster@*'])); } catch (e) {}
    list = tags() || [];
}
ok('the release tags are at hand', list.length > 0, 'no waze-on-cluster@* tag, and fetching them failed');
if (!list.length) process.exit(1);

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rollback-'));
process.on('exit', function () { try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {} });
var RELEASES = list.map(function (t) { return t.slice('waze-on-cluster@'.length); }).filter(function (v) { return /^\d+\.\d+\.\d+$/.test(v); })
    .sort(cmp).filter(function (v) { return BIN || group(v) !== 'A'; });
RELEASES.forEach(function (v) {
    var d = path.join(dir, 'rel', v);
    fs.mkdirSync(d, { recursive: true });
    cp.execSync('git archive "waze-on-cluster@' + v + '" native/waze-on-cluster/patch | tar -x -C "' + d + '" --strip-components=3', { cwd: REPO });
});

/* ---- a world: carplay, its backup and the fakes the patchers and boot
 * recovery run against ---------------------------------------------------- */

var STOCK = BIN ? fs.readFileSync(BIN) : synthetic.build({}).buf;
var W = path.join(dir, 'world'), TGT = path.join(W, 'carplay');
fs.mkdirSync(path.join(W, 'proc'), { recursive: true });
var MOUNTS = path.join(W, 'mounts');
fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
fs.writeFileSync(path.join(W, 'mount'), '#!/bin/sh\ncase "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '";; ' +
    '*remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + MOUNTS + '";; esac\n', { mode: 0o755 });
var ENV = Object.assign({}, process.env, {
    WOC_CARPLAY: TGT, WOC_MOUNT: path.join(W, 'mount'), WOC_PROC_MOUNTS: MOUNTS, WOC_PROC: path.join(W, 'proc'),
    WOC_REMOUNT_LOCK: path.join(W, 'remount.lock'), WOC_PROC_STAT: path.join(W, 'no-stat'), WOC_SYSTEMCTL: '/usr/bin/false',
    WOC_RECOVERY_STATE: path.join(W, 'recovery.json'), WOC_PATCH_SOCK: path.join(W, 'patch.sock'),
});
var FILES = ['', '.woc-orig', '.woc-orig.json', '.woc-patch.json', '.woc-running'];
function clear() { FILES.forEach(function (s) { try { fs.unlinkSync(TGT + s); } catch (e) {} }); }
function snapshot() { var o = {}; FILES.forEach(function (s) { try { o[s] = fs.readFileSync(TGT + s); } catch (e) {} }); return o; }
function put(snap) { clear(); Object.keys(snap).forEach(function (s) { fs.writeFileSync(TGT + s, snap[s], { mode: s ? 0o600 : 0o755 }); }); }

function patcher(d, args) {
    var r = cp.spawnSync(process.execPath, [path.join(d, 'carplay_patch.js')].concat(args), { encoding: 'utf8', env: ENV });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
/* The patch each version writes: the app's (high panel, stock AVB sink),
 * --unproven on a synthetic build (Patch button). */
function apply(d) { return patcher(d, ['apply', '--panel', 'high', '--target', TGT, '--yes'].concat(BIN ? [] : ['--unproven'])); }
function removePatch(d) { return patcher(d, ['revert', '--target', TGT, '--yes']); }
function uninstall(d) { return patcher(d, ['revert', '--target', TGT, '--yes', '--drop-backup']); }

/* Boot recovery's restore of each release, as its boot step and watcher run
 * it once carplay failed enough: D-G plan from the trusted backup
 * (restoreTarget), C and earlier classify carplay with their patcher's
 * status and, when it is restorable, run their realRestore. */
var DRIVER = path.join(dir, 'recover.js');
fs.writeFileSync(DRIVER, [
    '"use strict";',
    'var d = process.argv[2], g = process.argv[3], cp = require("child_process"), rec = require(d + "/recovery.js");',
    'function done(e, r) { process.stdout.write("RESULT " + (e ? "error " + e.message : "ok " + (r || "")) + "\\n"); process.exit(0); }',
    'if (/^[DEFGHN]$/.test(g)) {',
    '    var t = rec.TARGETS.carplay;',
    '    rec.restoreTarget(t, false, 3, done);',
    '} else {',
    '    var out = cp.spawnSync(process.execPath, [d + "/carplay_patch.js", "status", "--target", process.env.WOC_CARPLAY], { encoding: "utf8" }).stdout || "";',
    '    var restorable = g === "C" ? /^restorable:\\s+yes$/m.test(out) : /variant:\\s+PATCHED/.test(out) && !/known:\\s+NO/.test(out) && /^backup:\\s+\\//m.test(out);',
    '    if (!restorable) { process.stdout.write("RESULT not restorable\\n"); process.exit(0); }',
    '    if (rec.realRestore.length >= 2) rec.realRestore(false, done); else rec.realRestore(done);',
    '}'].join('\n'));
function recover(d, g) {
    var r = cp.spawnSync(process.execPath, [DRIVER, d, g], { encoding: 'utf8', env: ENV, timeout: 60000 });
    var m = /^RESULT (.*)$/m.exec(r.stdout || '');
    return m ? m[1] : 'no result: ' + ((r.stdout || '') + (r.stderr || '')).slice(-200);
}


/* ---- what carplay holds ------------------------------------------------- */

var LOC = locator.locate(STOCK), REF = LOC.mapurl, SHOW = LOC.showui;
if (!REF.ok || !SHOW.ok) { process.stdout.write('FAIL the URL edits are not located in the build the test runs on: ' + (REF.reason || SHOW.reason) + '\n'); process.exit(1); }
var MAPURL = [[REF.slot, REF.len], [REF.lea, 7]], SHOWUI = [[SHOW.str, SHOW.len], [SHOW.call, SHOW.callLen]];
function inRanges(R, i) { return R.some(function (m) { return i >= m[0] && i < m[0] + m[1]; }); }
/* 'stock'; what is left when every byte but some of the URL edits' is stock:
 * 'map URL left', 'ShowUI URL left', 'URL edits left'; 'patched' (other
 * bytes changed) */
function holds() {
    var b = fs.readFileSync(TGT), map = false, show = false;
    if (b.equals(STOCK)) return 'stock';
    for (var i = 0; i < b.length; i++) {
        if (b[i] === STOCK[i]) continue;
        if (inRanges(MAPURL, i)) map = true; else if (inRanges(SHOWUI, i)) show = true; else return 'patched';
    }
    return map && show ? 'URL edits left' : map ? 'map URL left' : 'ShowUI URL left';
}
function rangesIn(R) { var b = fs.readFileSync(TGT); return R.every(function (m) { return !b.slice(m[0], m[0] + m[1]).equals(STOCK.slice(m[0], m[0] + m[1])); }); }
function mapUrlIn() { return rangesIn(MAPURL); }
function showUiIn() { return rangesIn(SHOWUI); }

/* ---- this version's patch in memory --------------------------------------
 * The plan and its record live in WOC_STATE_DIR (on the car /var/opt),
 * which no release reads. */
var SD = path.join(W, 'var');
fs.mkdirSync(SD, { recursive: true });
var IENV = Object.assign({}, ENV, { WOC_STATE_DIR: SD, WOC_PRELOAD_DIR: path.join(W, 'run'), WOC_CODING: car.CODING });
function clearInmem() { fs.readdirSync(SD).forEach(function (f) { try { fs.unlinkSync(path.join(SD, f)); } catch (e) {} }); }
function inmemKind() {
    var r = cp.spawnSync(process.execPath, ['-e', 'console.log(String(require(process.argv[1]).kind("carplay")))', path.join(NEW, 'inmem.js')], { encoding: 'utf8', env: IENV });
    return (r.stdout || '').trim();
}
function makePlan() {
    var r = cp.spawnSync(process.execPath, ['-e', 'require(process.argv[1]).makePlan("carplay", ["--panel", "high", "--coding", process.argv[2]].concat(process.argv[3] ? ["--unproven"] : []), 60000, function (e) { console.log(e ? "ERR " + e.message : "OK"); })',
        path.join(NEW, 'inmem.js'), car.CODING, BIN ? '' : '1'], { encoding: 'utf8', env: IENV });
    return (r.stdout || '').trim();
}
/* This version's activate, as its patcher steps (patchd.js inmemApply;
 * patchd_activate_test.js runs patchd itself): a file the patcher does not
 * recognise, or with another tool's change besides ours, is left as it is;
 * an earlier release's patch, or our backup, is put back to stock with the
 * backup dropped; then the plan is made from the stock file. 'planned'
 * (carplay stock, no backup, the plan and its record), 'left' (nothing
 * written), or what failed. */
function activateNew() {
    var st = patcher(NEW, ['status', '--target', TGT]).out;
    if (/known:\s+NO/.test(st) || /^foreign:\s+yes$/m.test(st)) return 'left';
    if (/^restorable:\s+yes$/m.test(st) || fs.existsSync(TGT + '.woc-orig')) {
        var rv = uninstall(NEW);
        if (rv.code !== 0) return 'revert failed: ' + rv.out.slice(-160);
    }
    var mp = makePlan();
    if (mp !== 'OK') return 'plan: ' + mp;
    return holds() === 'stock' && !fs.existsSync(TGT + '.woc-orig') && inmemKind() !== 'null' ? 'planned' : 'not stock: ' + holds();
}

/* ---- the patches -------------------------------------------------------- */

/* The app's patch as the last release that patched the file wrote it. */
var LAST = earlier.dir();
clear(); clearInmem(); fs.writeFileSync(TGT, STOCK, { mode: 0o755 });
var r = apply(LAST);
ok(earlier.TAG + ', the last release that patches the file, patches the build, the map URL and ShowUI URL edits included', r.code === 0 && mapUrlIn() && showUiIn(), r.out);
var APP_PATCH = snapshot();
/* The patch 0.10.4-0.10.5 wrote, as run on the car (carplay 22.28.3). */
var CAR_PATCH_SHA = 'a241b0e9af9ac1eada5c5ebcf9fab06669a155376b0a5c70cd85f3c1459a88b5';
if (BIN) ok('that patch is byte for byte the one 0.10.4-0.10.5 wrote', require('crypto').createHash('sha256').update(APP_PATCH['']).digest('hex') === CAR_PATCH_SHA);
clear(); fs.writeFileSync(TGT, STOCK, { mode: 0o755 });
(function () {
    var mp = makePlan(), laid = null;
    try { laid = require(path.join(NEW, 'carplay_patch.js')).overlay(STOCK, fs.readFileSync(path.join(SD, 'inmem-carplay.plan'), 'utf8')); } catch (e) { laid = { err: e.message }; }
    ok('this version\'s plan of the app\'s patch laid over stock is that patch, carplay untouched', mp === 'OK' && !laid.err && laid.buf.equals(APP_PATCH['']) && holds() === 'stock',
        mp + ' ' + (laid.err || ''));
    clearInmem();
})();
ok('every release from ' + (BIN ? '0.5.0' : '0.7.0') + ' to ' + earlier.TAG.split('@')[1] + ' is tested', RELEASES.indexOf(BIN ? '0.5.0' : '0.7.0') >= 0 && RELEASES.indexOf('0.10.6') >= 0 &&
    RELEASES.indexOf(earlier.TAG.split('@')[1]) >= 0, RELEASES.join(' '));
var R = LOC.res, SAFE_OFFS = [R.safe1, R.safe2];
function imm(buf, o) { return buf.slice(o, o + 8); }
/* The safe area 0.10.6 wrote (476x306 at 306,72): the view x,y and safe
 * width, then the safe height and x,y. */
var SAFE_0106 = [Buffer.from('00000000dc010000', 'hex'), Buffer.from('3201000032014800', 'hex')];

function relGroup(v) { return v === 'this' ? 'N' : group(v); }
/* Whether a version writes the map URL edit on the build the test runs on:
 * 0.9.11 knows it at carplay 22.28.3's offsets only, 0.9.12 and later
 * wherever its sites are found. */
function knowsMapUrl(v) { return /^[FGHN]$/.test(relGroup(v)) || (group(v) === 'E' && !!BIN); }
/* The map URL a version writes: 'eta' (G), 'map' (E, F, H). */
function mapForm(v) { return relGroup(v) === 'G' ? 'eta' : 'map'; }
/* Whether version q restores the map URL edit version p wrote: q knows the
 * edit, and p's URL (G, H and this version know both). */
function restoresMapOf(q, p) { return knowsMapUrl(q) && (/^[GHN]$/.test(relGroup(q)) || mapForm(p) === 'map'); }
/* Whether a version writes, and so restores, the ShowUI URL edit: H and
 * this version. */
function knowsShowUi(v) { return /^[HN]$/.test(relGroup(v)); }
/* What a revert by version q leaves of version p's patch: 'stock' or what
 * holds() calls the URL edits left. */
function leftBy(q, p) {
    var map = knowsMapUrl(p) && !restoresMapOf(q, p), show = knowsShowUi(p) && !knowsShowUi(q);
    return map && show ? 'URL edits left' : map ? 'map URL left' : show ? 'ShowUI URL left' : 'stock';
}
/* Whether version q's boot recovery writes the whole trusted backup: D on. */
function wholeBackup(q) { return /^[DEFGHN]$/.test(relGroup(q)); }

RELEASES.forEach(function (v) {
    var d = path.join(dir, 'rel', v), g = group(v);

    /* 1. The deploy tool's rollback, downgrade or removal of this version:
     * its deactivate leaves carplay stock with no backup; then the release's
     * activate, a crash loop under the release, its Remove patch, its
     * removal. */
    clear(); clearInmem(); fs.writeFileSync(TGT, STOCK, { mode: 0o755 });
    r = apply(d);
    var relPatched = r.code === 0 && holds() === 'patched' && mapUrlIn() === knowsMapUrl(v) && showUiIn() === knowsShowUi(v);
    var relPatch = snapshot();
    var rec = recover(d, g), recStock = holds() === 'stock';
    put(relPatch); r = removePatch(d); var rmStock = r.code === 0 && holds() === 'stock';
    put(relPatch); r = uninstall(d); var unStock = r.code === 0 && holds() === 'stock';
    ok(v + ' (' + g + ') after this version\'s deactivate: its patch, a crash loop ends stock, Remove patch and removal stock',
        relPatched && recStock && rmStock && unStock, [relPatched, rec, recStock, rmStock, unStock].join(' '));

    /* 2. This version over the release's patch (an update, one skipping
     * versions, an update cut short): a crash loop, Remove patch and
     * removal end stock, and its activate puts carplay back to stock and
     * plans the patch in memory. */
    put(relPatch);
    rec = recover(NEW, 'N');
    var newRec = holds() === 'stock';
    put(relPatch); r = removePatch(NEW); var newRm = r.code === 0 && holds() === 'stock';
    put(relPatch); r = uninstall(NEW); var newUn = r.code === 0 && holds() === 'stock';
    put(relPatch); clearInmem(); var newUp = activateNew();
    ok(v + ' (' + g + ')\'s patch under this version: a crash loop ends stock, Remove patch and removal stock, its activate puts carplay back to stock and plans in memory',
        newRec && newRm && newUn && newUp === 'planned', [rec, newRec, newRm, newUn, newUp].join(' '));
    if (g === 'H') {
        /* 0.10.6's patch is the app's patch with its own safe area, and
         * nothing else; every other H release's is the app's patch. */
        var is0106 = v === '0.10.6', relB = relPatch[''], diffOk = relB.length === APP_PATCH[''].length;
        for (var i = 0; diffOk && i < relB.length; i++)
            if (relB[i] !== APP_PATCH[''][i] && !(is0106 && SAFE_OFFS.some(function (o) { return i >= o && i < o + 8; }))) diffOk = false;
        var safeOk = is0106 ? imm(relB, R.safe1).equals(SAFE_0106[0]) && imm(relB, R.safe2).equals(SAFE_0106[1]) : relB.equals(APP_PATCH['']);
        ok(v + ' (' + g + ')\'s patch is the app\'s patch' + (is0106 ? ' but for the safe area 476x306' : ', byte for byte'),
            diffOk && safeOk, 'diff ' + diffOk + ' safe ' + safeOk);
    }
});

/* 3. Release to release, both ways and to itself: the first and last
 * release of each group. The one that patched is P, the one installed after
 * it Q (a release, or this version), with no deactivate between: a crash
 * loop under Q, its Remove patch and its activate. */
var REPS = [];
['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach(function (g) {
    var inG = RELEASES.filter(function (v) { return group(v) === g; });
    if (inG.length) REPS.push(inG[0]);
    if (inG.length > 1) REPS.push(inG[inG.length - 1]);
});
function relDir(v) { return v === 'this' ? NEW : path.join(dir, 'rel', v); }
REPS.forEach(function (p) {
    clear(); clearInmem(); fs.writeFileSync(TGT, STOCK, { mode: 0o755 });
    r = apply(relDir(p));
    var pPatch = snapshot();
    ok(p + ' patches', r.code === 0 && holds() === 'patched' && mapUrlIn() === knowsMapUrl(p) && showUiIn() === knowsShowUi(p), r.out);
    REPS.concat(['this']).forEach(function (q) {
        var qd = relDir(q);
        put(pPatch); var rec = recover(qd, relGroup(q)), recH = holds();
        put(pPatch); r = removePatch(qd); var rmH = r.code ? 'refused' : holds();
        put(pPatch); clearInmem();
        var up = q === 'this' ? activateNew() : (r = apply(qd), r.code === 0 && holds() === 'patched' ? 'patched' : 'failed');
        var wantRm = leftBy(q, p), wantRec = wholeBackup(q) ? 'stock' : wantRm, wantUp = q === 'this' ? 'planned' : 'patched';
        ok(p + '\'s patch under ' + q + ': a crash loop ends ' + wantRec + ', Remove patch ' + wantRm + ', its activate ' + (q === 'this' ? 'plans in memory over stock' : 'patches'),
            recH === wantRec && rmH === wantRm && up === wantUp, [rec, recH, rmH, up].join(' '));
    });
});

/* 4. An earlier release's write of the URL edits cut short: a file left
 * with one map URL site of a patched form and the other stock, or the two
 * of different forms, the ShowUI URL edit written; and with the map URL
 * edit written, one ShowUI URL site written and the other stock, or either
 * cut short inside, either way round. This version's crash loop, Remove
 * patch and removal end stock and its activate leaves it as it is; under
 * every release from D on a crash loop ends stock. */
(function () {
    function form(n) { return REF.forms.filter(function (f) { return f.name === n; })[0]; }
    var call = Buffer.from(SHOW.callBytes, 'hex'), callStock = STOCK.slice(SHOW.call, SHOW.call + SHOW.callLen), str = Buffer.from(SHOW.strBytes, 'hex');
    var CUT = [['current', null], [null, 'current'], ['eta', 'current'], ['current', 'eta'], ['eta', null], [null, 'eta']].map(function (c) {
        return ['map URL cut short (log string ' + (c[0] || 'stock') + ', lea ' + (c[1] || 'stock') + ')', function (b) {
            STOCK.copy(b, REF.slot, REF.slot, REF.slot + REF.len); STOCK.copy(b, REF.lea, REF.lea, REF.lea + 7);
            if (c[0]) Buffer.from(form(c[0]).slotBytes, 'hex').copy(b, REF.slot);
            if (c[1]) Buffer.from(form(c[1]).leaBytes, 'hex').copy(b, REF.lea);
        }];
    }).concat([
        ['ShowUI URL cut short (log text written, call site stock)', function (b) { callStock.copy(b, SHOW.call); }],
        ['ShowUI URL cut short (log text stock, call site written)', function (b) { STOCK.copy(b, SHOW.str, SHOW.str, SHOW.str + SHOW.len); }],
        ['ShowUI URL cut short (log text stock, the call site\'s first 5 bytes written)', function (b) {
            STOCK.copy(b, SHOW.str, SHOW.str, SHOW.str + SHOW.len); callStock.copy(b, SHOW.call); call.copy(b, SHOW.call, 0, 5); }],
        ['ShowUI URL cut short (log text written, the call site\'s first 3 bytes stock)', function (b) { callStock.copy(b, SHOW.call, 0, 3); }],
        ['ShowUI URL cut short (the log text\'s first 40 bytes written, call site stock)', function (b) {
            STOCK.copy(b, SHOW.str, SHOW.str, SHOW.str + SHOW.len); str.copy(b, SHOW.str, 0, 40); callStock.copy(b, SHOW.call); }],
        ['ShowUI URL cut short (the log text\'s first 40 bytes stock, call site written)', function (b) { STOCK.copy(b, SHOW.str, SHOW.str, SHOW.str + 40); }],
    ]);
    CUT.forEach(function (c) {
        put(APP_PATCH);
        var b = fs.readFileSync(TGT);
        c[1](b);
        fs.writeFileSync(TGT, b);
        var cut = snapshot(), name = c[0];
        var rec = recover(NEW, 'N'), recH = holds();
        put(cut); r = removePatch(NEW); var rmH = r.code ? 'refused' : holds();
        put(cut); r = uninstall(NEW); var unH = r.code ? 'refused' : holds();
        put(cut); clearInmem(); var up = activateNew(), upLeft = up === 'left' && fs.readFileSync(TGT).equals(cut['']) && inmemKind() === 'null';
        ok(name + ', this version: a crash loop, Remove patch and removal end stock, its activate leaves it',
            recH === 'stock' && rmH === 'stock' && unH === 'stock' && upLeft, [rec, recH, rmH, unH, up].join(' '));
        RELEASES.filter(function (v) { return wholeBackup(v); }).forEach(function (v) {
            put(cut); var rr = recover(path.join(dir, 'rel', v), group(v));
            ok(name + ', ' + v + ' (' + group(v) + '): a crash loop ends stock', holds() === 'stock', rr + ' ' + holds());
        });
    });
})();

/* 5. An earlier release's write of the geometry edit cut short, or one it
 * left: the safe area 0.10.6 wrote (476x306) under the app's other edits,
 * an update from it cut short between or inside the two safe-area
 * immediates, the size and physical size written with the safe area stock,
 * the safe area written with the size stock, and the safe height or the
 * safe x,y alone written. This version's crash loop, Remove patch and
 * removal end stock; its activate puts carplay back to stock and plans in
 * memory where the geometry reads as patched or stock (PATCH.md, Edit 4: a
 * physical size, the view area at 0,0 for ours, a safe area inside the
 * frame), and leaves one it does not recognise; under every release from D
 * on a crash loop ends stock. */
(function () {
    var APPB = APP_PATCH[''], REL_SAFE1 = SAFE_0106[0], REL_SAFE2 = SAFE_0106[1];
    function mix(over) { return function (b) { Object.keys(over).forEach(function (k) { over[k].copy(b, R[k]); }); }; }
    /* 'patch' when the geometry in b reads as this tool's or as stock, else 'left' */
    function outcome(b) {
        var mmw = b.readUInt32LE(R.mm), mmh = b.readUInt32LE(R.mm + 4), w = b.readUInt32LE(R.px), h = b.readUInt32LE(R.px + 4);
        var vx = b.readUInt16LE(R.safe1), vy = b.readUInt16LE(R.safe1 + 2), sw = b.readUInt32LE(R.safe1 + 4);
        var sh = b.readUInt32LE(R.safe2), sx = b.readUInt16LE(R.safe2 + 4), sy = b.readUInt16LE(R.safe2 + 6);
        var inside = w > 0 && h > 0 && sw > 0 && sh > 0 && sx + sw <= w && sy + sh <= h, ours = mmw === 138 && mmh === 61;
        return inside && (ours ? vx === 0 && vy === 0 : mmw > 0 && mmh > 0) ? 'patch' : 'left';
    }
    var CUT = [
        ['the safe area 476x306 of 0.10.6', mix({ safe1: REL_SAFE1, safe2: REL_SAFE2 })],
        ['geometry cut short (the app\'s safe width, 0.10.6\'s safe height and x,y)', mix({ safe2: REL_SAFE2 })],
        ['geometry cut short (0.10.6\'s safe width, the app\'s safe height and x,y)', mix({ safe1: REL_SAFE1 })],
        ['geometry cut short (0.10.6\'s safe width, 0.10.6\'s safe height with the app\'s first 2 bytes)', function (b) {
            REL_SAFE1.copy(b, R.safe1); REL_SAFE2.copy(b, R.safe2); imm(APPB, R.safe2).copy(b, R.safe2, 0, 2); }],
        ['geometry cut short (the app\'s safe width, 0.10.6\'s safe height with the app\'s first 2 bytes)', function (b) {
            REL_SAFE2.copy(b, R.safe2); imm(APPB, R.safe2).copy(b, R.safe2, 0, 2); }],
        ['geometry cut short (size written, safe area stock)', mix({ safe1: imm(STOCK, R.safe1), safe2: imm(STOCK, R.safe2) })],
        ['geometry cut short (safe area written, size stock)', mix({ mm: imm(STOCK, R.mm), px: imm(STOCK, R.px) })],
        ['geometry cut short (the safe height\'s first 2 bytes written, the rest stock)', function (b) {
            imm(STOCK, R.safe2).copy(b, R.safe2); imm(APPB, R.safe2).copy(b, R.safe2, 0, 2); }],
        ['geometry cut short (the safe x,y written, the safe height stock)', function (b) { imm(STOCK, R.safe2).copy(b, R.safe2, 0, 4); }],
    ];
    CUT.forEach(function (c) {
        put(APP_PATCH);
        var b = fs.readFileSync(TGT);
        c[1](b);
        fs.writeFileSync(TGT, b);
        var cut = snapshot(), name = c[0], want = outcome(b);
        var rec = recover(NEW, 'N'), recH = holds();
        put(cut); r = removePatch(NEW); var rmH = r.code ? 'refused' : holds();
        put(cut); r = uninstall(NEW); var unH = r.code ? 'refused' : holds();
        put(cut); clearInmem(); var up = activateNew();
        var upOk = want === 'patch' ? up === 'planned' : up === 'left' && fs.readFileSync(TGT).equals(cut['']);
        ok(name + ', this version: a crash loop, Remove patch and removal end stock, its activate ' + (want === 'patch' ? 'puts carplay back to stock and plans in memory' : 'leaves it'),
            recH === 'stock' && rmH === 'stock' && unH === 'stock' && upOk, [rec, recH, rmH, unH, up].join(' '));
        RELEASES.filter(function (v) { return wholeBackup(v); }).forEach(function (v) {
            put(cut); var rr = recover(path.join(dir, 'rel', v), group(v));
            ok(name + ', ' + v + ' (' + group(v) + '): a crash loop ends stock', holds() === 'stock', rr + ' ' + holds());
        });
    });
})();

/* 6. The patch in memory (PATCH.md "In memory"): this version leaves
 * carplay stock on disk with a plan and a record on /var/opt, which no
 * release reads. Each release then meets a stock carplay with no backup:
 * its crash loop and Remove patch leave it stock, and its activate writes
 * its own patch, as on a car it is installed on first. That patch is
 * another file than the record describes, so this version's boot recovery
 * never arms the plan over it and restores it as its own (stock), and its
 * deactivate reverts it. This version over its own layout: a crash loop and
 * Remove patch leave carplay stock and the plan armable, and its activate
 * plans again over stock. */
(function () {
    clear(); clearInmem(); fs.writeFileSync(TGT, STOCK, { mode: 0o755 });
    var mp = makePlan();
    ok('this version plans the patch in memory over stock carplay, writing nothing to it', mp === 'OK' && fs.readFileSync(TGT).equals(STOCK) && inmemKind() !== 'null', mp);
    var inmemState = snapshot();
    /* Each case starts from carplay as this version leaves it, its record
     * describing that very file (planned again after the file is put). */
    function fresh() { put(inmemState); return makePlan() === 'OK' && inmemKind() !== 'null'; }
    RELEASES.forEach(function (v) {
        var vd = relDir(v), g = relGroup(v), live = true;
        live = fresh() && live; var rec = recover(vd, g), recH = holds(), recKind = inmemKind();
        live = fresh() && live; r = removePatch(vd); var rmH = r.code ? 'refused-' + holds() : holds(), rmKind = inmemKind();
        live = fresh() && live; r = apply(vd); var apH = r.code === 0 ? holds() : 'failed';
        var kind = inmemKind();
        var thisRec = recover(NEW, 'N'), backH = holds();
        live = fresh() && live; apply(vd); r = uninstall(NEW); var unH = r.code ? 'refused' : holds();
        ok(v + ' (' + g + ') over the patch in memory: a crash loop and Remove patch leave carplay stock and the plan armable, its activate patches the file; ' +
            'this version then arms nothing over that patch and restores or removes it to stock',
            live && recH === 'stock' && recKind !== 'null' && (rmH === 'stock' || rmH === 'refused-stock') && rmKind !== 'null' &&
            apH === 'patched' && kind === 'null' && backH === 'stock' && unH === 'stock',
            [live, rec, recH, recKind, rmH, rmKind, apH, kind, thisRec, backH, unH].join(' '));
    });
    var live = fresh(), rec = recover(NEW, 'N'), recH = holds(), recKind = inmemKind();
    live = fresh() && live; r = removePatch(NEW); var rmH = r.code ? 'refused-' + holds() : holds(), rmKind = inmemKind();
    live = fresh() && live; var up = activateNew();
    ok('this version over the patch in memory: a crash loop and Remove patch leave carplay stock and the plan armable, its activate plans again over stock',
        live && recH === 'stock' && recKind !== 'null' && (rmH === 'stock' || rmH === 'refused-stock') && rmKind !== 'null' && up === 'planned',
        [live, rec, recH, recKind, rmH, rmKind, up].join(' '));
})();

process.stdout.write((BIN ? '' : '\n(group A needs CARPLAY_BIN)\n') + (fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n'));
process.exit(fails ? 1 : 0);
