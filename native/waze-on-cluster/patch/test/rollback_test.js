#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Every released carplay patcher against this one (PATCH.md "Rollback"): each
 * release's own carplay_patch.js and boot recovery, taken from its release
 * tag, acting on a carplay this version patched, and this version acting on
 * a carplay each release patched. Boot recovery is each release's own
 * restore code (what its boot step and watcher run once carplay failed
 * enough), called directly; the crash count that leads there is
 * recovery_test.js's.
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
 *   H 0.10.4-      G, writing F's URL again, and the ShowUI URL edit;
 *                  0.10.6 writes the safe area 476x306 at 306,72, every
 *                  other release and this version 504x368 at 286,72
 * Groups A-D know four edits, E-G five, H and this version six. E and F write
 * and know the map URL (`maps:/car/instrumentcluster/map`) only, G writes the
 * URL with `?showETA=yes` and restores either, H and this version write the
 * map URL and the ShowUI URL and restore either form of the map URL. Only H
 * and this version know the ShowUI URL edit.
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
if (!list.length) {
    /* a shallow checkout (CI) fetches them shallow; a full clone stays full */
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

/* ---- the patches -------------------------------------------------------- */

clear(); fs.writeFileSync(TGT, STOCK, { mode: 0o755 });
var r = apply(NEW);
ok('this version patches the build, the map URL and ShowUI URL edits included', r.code === 0 && mapUrlIn() && showUiIn(), r.out);
var NEW_PATCH = snapshot();
/* The patch 0.10.4-0.10.5 wrote, as run on the car (carplay 22.28.3). */
var CAR_PATCH_SHA = 'a241b0e9af9ac1eada5c5ebcf9fab06669a155376b0a5c70cd85f3c1459a88b5';
if (BIN) ok('this version\'s patch is byte for byte the one 0.10.4-0.10.5 wrote', require('crypto').createHash('sha256').update(NEW_PATCH['']).digest('hex') === CAR_PATCH_SHA);
ok('every release from ' + (BIN ? '0.5.0' : '0.7.0') + ' to 0.10.6 is tested', RELEASES.indexOf(BIN ? '0.5.0' : '0.7.0') >= 0 && RELEASES.indexOf('0.10.6') >= 0, RELEASES.join(' '));
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
/* The map URL a version writes: 'eta' (G), 'map' (E, F, H, this version). */
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

var table = [];
RELEASES.forEach(function (v) {
    var d = path.join(dir, 'rel', v), g = group(v), row = { v: v, g: g };

    /* 1. The deploy tool's rollback, downgrade or removal of this version:
     * its deactivate first, then the release's activate; a crash loop under
     * the release; its Remove patch; its removal. */
    put(NEW_PATCH);
    r = uninstall(NEW);
    var deact = r.code === 0 && holds() === 'stock' && !fs.existsSync(TGT + '.woc-orig');
    r = apply(d);
    var relPatched = r.code === 0 && holds() === 'patched' && mapUrlIn() === knowsMapUrl(v) && showUiIn() === knowsShowUi(v);
    var relPatch = snapshot();
    var rec = recover(d, g), recStock = holds() === 'stock';
    put(relPatch); r = removePatch(d); var rmStock = r.code === 0 && holds() === 'stock';
    put(relPatch); r = uninstall(d); var unStock = r.code === 0 && holds() === 'stock';
    ok(v + ' (' + g + ') after this version\'s deactivate: its patch, a crash loop ends stock, Remove patch and removal stock',
        deact && relPatched && recStock && rmStock && unStock, [deact, relPatched, rec, recStock, rmStock, unStock].join(' '));

    /* 2. This version over the release's patch (an update, one skipping
     * versions, the same patch installed again, an update cut short): a
     * crash loop, Remove patch, removal, and its activate. */
    put(relPatch);
    rec = recover(NEW, 'N');
    var newRec = holds() === 'stock';
    put(relPatch); r = removePatch(NEW); var newRm = r.code === 0 && holds() === 'stock';
    put(relPatch); r = uninstall(NEW); var newUn = r.code === 0 && holds() === 'stock';
    put(relPatch); r = apply(NEW); var newUp = r.code === 0 && fs.readFileSync(TGT).equals(NEW_PATCH['']);
    r = removePatch(NEW); var newUpRm = r.code === 0 && holds() === 'stock';
    ok(v + ' (' + g + ')\'s patch under this version: a crash loop ends stock, Remove patch and removal stock, an update writes this version\'s patch and reverts whole',
        newRec && newRm && newUn && newUp && newUpRm, [rec, newRec, newRm, newUn, newUp, newUpRm].join(' '));
    if (g === 'H') {
        /* 0.10.6's patch is this version's with its own safe area, which the
         * update rewrites, and nothing else; 0.10.4-0.10.5's is this version's. */
        var is0106 = v === '0.10.6', relB = relPatch[''], diffOk = relB.length === NEW_PATCH[''].length;
        for (var i = 0; diffOk && i < relB.length; i++)
            if (relB[i] !== NEW_PATCH[''][i] && !(is0106 && SAFE_OFFS.some(function (o) { return i >= o && i < o + 8; }))) diffOk = false;
        var safeOk = is0106 ? imm(relB, R.safe1).equals(SAFE_0106[0]) && imm(relB, R.safe2).equals(SAFE_0106[1]) : relB.equals(NEW_PATCH['']);
        ok(v + ' (' + g + ')\'s patch is this version\'s' + (is0106 ? ' but for the safe area 476x306, which an update rewrites' : ', byte for byte'),
            diffOk && safeOk, 'diff ' + diffOk + ' safe ' + safeOk);
    }

    /* 3. The release over this version's patch with no deactivate in
     * between (the open paths PATCH.md "Rollback" lists): what it does. */
    put(NEW_PATCH); rec = recover(d, g); row.recovery = holds() + (/error|not restorable/.test(rec) ? ' (' + rec + ')' : '');
    put(NEW_PATCH); r = removePatch(d); row.remove = r.code ? 'refused' : holds();
    put(NEW_PATCH); r = uninstall(d); row.uninstall = r.code ? 'refused' : holds();
    put(NEW_PATCH); r = apply(d); row.reapply = r.code ? 'refused' : holds() + (mapUrlIn() ? ', map URL kept' : '') + (showUiIn() ? ', ShowUI URL kept' : '');
    var after = fs.readFileSync(TGT), ownGeom = [LOC.res.mm, LOC.res.px, LOC.res.safe1, LOC.res.safe2].every(function (o) {
        return after.slice(o, o + 8).equals(relPatch[''].slice(o, o + 8)); });
    var wantRm = leftBy(v, 'this'), wantRec = wholeBackup(v) ? 'stock' : wantRm;
    ok(v + ' (' + g + ') over this version\'s full patch, no deactivate between: crash loop ' + wantRec + ', Remove patch and removal ' + wantRm +
        ', its activate writes its own geometry and keeps the URL edits', row.recovery === wantRec && row.remove === wantRm && row.uninstall === wantRm &&
        row.reapply === 'patched, map URL kept, ShowUI URL kept' && ownGeom, JSON.stringify(row) + ' own geometry ' + ownGeom);
    table.push(row);
});

/* 4. Release to release, both ways and to itself: the first and last
 * release of each group and this version. The one that patched is P, the
 * one installed after it Q, with no deactivate between: a crash loop under
 * Q, its Remove patch and its activate. Where P wrote the map URL edit and
 * Q does not know it, part 3 says what Q does. */
var REPS = [];
['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach(function (g) {
    var inG = RELEASES.filter(function (v) { return group(v) === g; });
    if (inG.length) REPS.push(inG[0]);
    if (inG.length > 1) REPS.push(inG[inG.length - 1]);
});
REPS.push('this');
function relDir(v) { return v === 'this' ? NEW : path.join(dir, 'rel', v); }
REPS.forEach(function (p) {
    clear(); fs.writeFileSync(TGT, STOCK, { mode: 0o755 });
    r = apply(relDir(p));
    var pPatch = snapshot();
    ok(p + ' patches', r.code === 0 && holds() === 'patched' && mapUrlIn() === knowsMapUrl(p) && showUiIn() === knowsShowUi(p), r.out);
    REPS.forEach(function (q) {
        var qd = relDir(q);
        put(pPatch); var rec = recover(qd, relGroup(q)), recH = holds();
        put(pPatch); r = removePatch(qd); var rmH = r.code ? 'refused' : holds();
        put(pPatch); r = apply(qd); var upOk = r.code === 0 && holds() === 'patched' && (q !== 'this' || fs.readFileSync(TGT).equals(NEW_PATCH['']));
        var wantRm = leftBy(q, p), wantRec = wholeBackup(q) ? 'stock' : wantRm;
        ok(p + '\'s patch under ' + q + ': a crash loop ends ' + wantRec + ', Remove patch ' + wantRm + ', its activate patches',
            recH === wantRec && rmH === wantRm && upOk, [rec, recH, rmH, upOk].join(' '));
    });
});

/* 5. A write of the URL edits cut short: a file left with one map URL site
 * of a patched form and the other stock, or the two of different forms, the
 * ShowUI URL edit written; and with the map URL edit written, one ShowUI URL
 * site written and the other stock, or either cut short inside, either way
 * round. This version's crash loop, Remove patch and removal end stock and
 * its activate leaves it as it is; under every release from D on a crash
 * loop ends stock. */
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
        put(NEW_PATCH);
        var b = fs.readFileSync(TGT);
        c[1](b);
        fs.writeFileSync(TGT, b);
        var cut = snapshot(), name = c[0];
        var rec = recover(NEW, 'N'), recH = holds();
        put(cut); r = removePatch(NEW); var rmH = r.code ? 'refused' : holds();
        put(cut); r = uninstall(NEW); var unH = r.code ? 'refused' : holds();
        put(cut); r = apply(NEW); var upLeft = r.code !== 0 && fs.readFileSync(TGT).equals(cut['']);
        ok(name + ', this version: a crash loop, Remove patch and removal end stock, its activate leaves it',
            recH === 'stock' && rmH === 'stock' && unH === 'stock' && upLeft, [rec, recH, rmH, unH, upLeft].join(' '));
        RELEASES.filter(function (v) { return wholeBackup(v); }).forEach(function (v) {
            put(cut); var rr = recover(path.join(dir, 'rel', v), group(v));
            ok(name + ', ' + v + ' (' + group(v) + '): a crash loop ends stock', holds() === 'stock', rr + ' ' + holds());
        });
    });
})();

/* 6. A write of the geometry edit cut short, or one an earlier release
 * left: the safe area 0.10.6 wrote (476x306) under this version's other
 * edits, an update from it cut short between or inside the two safe-area
 * immediates, the size and physical size written with the safe area stock,
 * the safe area written with the size stock, and the safe height or the
 * safe x,y alone written. This version's crash loop, Remove
 * patch and removal end stock; its activate writes its patch where the
 * geometry reads as patched or stock (PATCH.md, Edit 4: a physical size,
 * the view area at 0,0 for ours, a safe area inside the frame), and leaves
 * one it does not recognise; under every release from D on a crash loop
 * ends stock. */
(function () {
    var NEWB = NEW_PATCH[''], REL_SAFE1 = SAFE_0106[0], REL_SAFE2 = SAFE_0106[1];
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
        ['geometry cut short (this version\'s safe width, 0.10.6\'s safe height and x,y)', mix({ safe2: REL_SAFE2 })],
        ['geometry cut short (0.10.6\'s safe width, this version\'s safe height and x,y)', mix({ safe1: REL_SAFE1 })],
        ['geometry cut short (0.10.6\'s safe width, 0.10.6\'s safe height with this version\'s first 2 bytes)', function (b) {
            REL_SAFE1.copy(b, R.safe1); REL_SAFE2.copy(b, R.safe2); imm(NEWB, R.safe2).copy(b, R.safe2, 0, 2); }],
        ['geometry cut short (this version\'s safe width, 0.10.6\'s safe height with this version\'s first 2 bytes)', function (b) {
            REL_SAFE2.copy(b, R.safe2); imm(NEWB, R.safe2).copy(b, R.safe2, 0, 2); }],
        ['geometry cut short (size written, safe area stock)', mix({ safe1: imm(STOCK, R.safe1), safe2: imm(STOCK, R.safe2) })],
        ['geometry cut short (safe area written, size stock)', mix({ mm: imm(STOCK, R.mm), px: imm(STOCK, R.px) })],
        ['geometry cut short (the safe height\'s first 2 bytes written, the rest stock)', function (b) {
            imm(STOCK, R.safe2).copy(b, R.safe2); imm(NEWB, R.safe2).copy(b, R.safe2, 0, 2); }],
        ['geometry cut short (the safe x,y written, the safe height stock)', function (b) { imm(STOCK, R.safe2).copy(b, R.safe2, 0, 4); }],
    ];
    CUT.forEach(function (c) {
        put(NEW_PATCH);
        var b = fs.readFileSync(TGT);
        c[1](b);
        fs.writeFileSync(TGT, b);
        var cut = snapshot(), name = c[0], want = outcome(b);
        var rec = recover(NEW, 'N'), recH = holds();
        put(cut); r = removePatch(NEW); var rmH = r.code ? 'refused' : holds();
        put(cut); r = uninstall(NEW); var unH = r.code ? 'refused' : holds();
        put(cut); r = apply(NEW);
        var up = want === 'patch' ? r.code === 0 && fs.readFileSync(TGT).equals(NEWB) : r.code !== 0 && fs.readFileSync(TGT).equals(cut['']);
        ok(name + ', this version: a crash loop, Remove patch and removal end stock, its activate ' + (want === 'patch' ? 'writes its patch' : 'leaves it'),
            recH === 'stock' && rmH === 'stock' && unH === 'stock' && up, [rec, recH, rmH, unH, up, r.out.slice(-160)].join(' '));
        RELEASES.filter(function (v) { return wholeBackup(v); }).forEach(function (v) {
            put(cut); var rr = recover(path.join(dir, 'rel', v), group(v));
            ok(name + ', ' + v + ' (' + group(v) + '): a crash loop ends stock', holds() === 'stock', rr + ' ' + holds());
        });
    });
})();

process.stdout.write('\nA release over this version\'s full patch with no deactivate between (part 3):\n');
table.forEach(function (row) {
    process.stdout.write('  ' + (row.v + ' (' + row.g + ')          ').slice(0, 14) + ' crash loop: ' + row.recovery + '; Remove patch: ' + row.remove +
        '; removal: ' + row.uninstall + '; activate: ' + row.reapply + '\n');
});
process.stdout.write((BIN ? '' : '\n(group A needs CARPLAY_BIN)\n') + (fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n'));
process.exit(fails ? 1 : 0);
