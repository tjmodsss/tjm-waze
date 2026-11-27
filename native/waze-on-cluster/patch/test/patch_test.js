#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves carplay_patch.js against the unit's carplay binary (CARPLAY_BIN): the
 * located sites are the documented ones; the app's plan laid over stock is
 * the patch earlier releases wrote; the plan's sinks, geometry and safe area,
 * and its refusals (a file not pristine, a damaged site, a build outside the
 * proven list, the cluster-coding gate); status, verify, foreign and
 * byte-exact revert of earlier releases' patches (earlier_patcher.js, and
 * the bytes of each release before it: the variant and sink alone, no
 * resolution, no URL edits, the URL with ETA, 0.10.6's safe area), one cut
 * short, bytes another tool left there kept; region-bounded diffs, a
 * read-only probe, and the record a revert writes. Without CARPLAY_BIN it
 * skips.
 *
 *   node patch_test.js
 */
'use strict';

var car = require('./head_unit_env.js');   /* a HIGH head unit, coded KI_KOMBI_VARIANT 7, for every patcher and patchd this runs */
var record = require('../patch_record.js');

var fs = require('fs');
var path = require('path');
var tmp = require('./tmp.js');
var crypto = require('crypto');
var cp = require('child_process');

var SCRIPT = path.join(__dirname, '..', 'carplay_patch.js');
var earlier = require('./earlier_patcher.js');
var SRC = process.env.CARPLAY_BIN || '';
var ORIG_SHA = 'ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50';
var SLOT = 0x2ba4f0, SINK = 0x2a20b0, SINK_LEN = 59;
/* Edit 3 (self-start): the 5-byte call at 0x18176c, stock -> setStreamStatus,
 * patched -> requestStream. Only its 4-byte rel32 differs. */
var CALL = 0x18176c, CALL_LEN = 5;
var CALL_STOCK = 'e8effdffff', CALL_SELF = 'e89f000000';
function callBytes(buf) { return buf.slice(CALL, CALL + CALL_LEN).toString('hex'); }
/* Edit 4 (resolution): the four movabs immediates of the IC_HIGH geometry
 * builder. Only the 8 immediate bytes after each 2-byte opcode change. */
var RES_OFFS = [0x20ca30, 0x20ca52, 0x20ca64, 0x20ca72];
function resImmediates(buf) { return RES_OFFS.map(function (o) { return buf.slice(o, o + 10).toString('hex'); }); }
var RES_STOCK = ['48baea0000006e000000', '48b88007000084030000', '48b80000000064020000', '48b80e0200000202c000'];
/* 1088x480 at 138x61 mm, view offset (0,0), safe 504x368 at (286,72). */
var RES_DEFAULT = ['48ba8a0000003d000000', '48b840040000e0010000', '48b800000000f8010000', '48b8700100001e014800'];
/* The geometry 0.10.6 wrote: the same with safe 476x306 at (306,72). */
var RES_0106 = ['48ba8a0000003d000000', '48b840040000e0010000', '48b800000000dc010000', '48b83201000032014800'];
/* The patch record's key of each (carplay_patch.js resKey). */
var GEOM_KEY = '1088x480/138x61/504x368+286+72', GEOM_KEY_0106 = '1088x480/138x61/476x306+306+72';
/* The same size with the safe area the whole frame (--safe full). */
var RES_FULLSAFE = ['48ba8a0000003d000000', '48b840040000e0010000', '48b80000000040040000', '48b8e001000000000000'];
function inResRegion(x) { return RES_OFFS.some(function (o) { return x >= o + 2 && x < o + 10; }); }
/* Edit 5 (map URL): the 55-byte log string at 0x257838 holds a shorter log
 * text and the URL (at 0x25784f), and the lea rsi at 0x7b533 loads the URL
 * instead of "" (0x294793). Index 1 stock, 2 patched (the bytes releases
 * 0.9.11-0.10.1 wrote too), 3 the URL with ETA releases 0.10.2-0.10.3 wrote
 * (at 0x257843). */
var MAPURL = [
    [0x257838, Buffer.from('Head-Unit does not support Alternate Displays feature.\0', 'latin1').toString('hex'),
        Buffer.from('Head-Unit: no AltDisp.\0maps:/car/instrumentcluster/map\0', 'latin1').toString('hex'),
        Buffer.from('No AltDisp\0maps:/car/instrumentcluster/map?showETA=yes\0', 'latin1').toString('hex')],
    [0x7b533, '488d3559922100', '488d3515c31d00', '488d3509c31d00'],
];
/* Edit 6 (ShowUI URL): the first 64 bytes of the ShowUI call's log text at
 * 0x2908a0 hold `mCinemoCarPlay->ShowUI(` and the URL (at 0x2908b8), and
 * requestStream's 11 bytes at 0x18188a load the URL (mov rdi,r12 ; lea
 * rsi,[0x2908b8] ; nop) instead of reading the cluster display's URL
 * (call 0x1fe5e0 ; mov rdi,r12 ; mov rsi,[rax]). Index 1 stock, 2 patched. */
var SHOWUI = [
    [0x2908a0, Buffer.from('mCinemoCarPlay->ShowUI( ::carplay::CarPlayConstantsRepository::a', 'latin1').toString('hex'),
        Buffer.from('mCinemoCarPlay->ShowUI(\0maps:/car/instrumentcluster?showETA=yes\0', 'latin1').toString('hex')],
    [0x18188a, 'e851cd07004c89e7488b30', '4c89e7488d3524f0100090'],
];
function rangeBytes(R, buf) { return R.map(function (m) { return buf.toString('hex', m[0], m[0] + m[1].length / 2); }); }
function rangesAre(R, buf, i) { return JSON.stringify(rangeBytes(R, buf)) === JSON.stringify(R.map(function (m) { return m[i]; })); }
function inRanges(R, x) { return R.some(function (m) { return x >= m[0] && x < m[0] + m[1].length / 2; }); }
function withRanges(R, buf, i) { var b = Buffer.from(buf); R.forEach(function (m) { Buffer.from(m[i], 'hex').copy(b, m[0]); }); return b; }
function mapUrlBytes(buf) { return rangeBytes(MAPURL, buf); }
function mapUrlIs(buf, i) { return rangesAre(MAPURL, buf, i); }
function showUiIs(buf, i) { return rangesAre(SHOWUI, buf, i); }
function inMapUrl(x) { return inRanges(MAPURL, x); }
/* In either URL edit's ranges. */
function inUrls(x) { return inRanges(MAPURL, x) || inRanges(SHOWUI, x); }
/* A copy of `buf` with the map URL ranges in form i (MAPURL's index). */
function withMapUrl(buf, i) { return withRanges(MAPURL, buf, i); }
function withShowUi(buf, i) { return withRanges(SHOWUI, buf, i); }
/* A copy of the app's patch `buf` with the URL edits as an earlier
 * release wrote them: 'none' (before 0.9.11), 'map' (0.9.11-0.10.1), 'eta'
 * (0.10.2-0.10.3). */
function asRelease(buf, rel) { return withMapUrl(withShowUi(buf, 1), rel === 'none' ? 1 : rel === 'map' ? 2 : 3); }
function withoutMapUrl(buf) { return asRelease(buf, 'none'); }
/* The geometry 0.10.6 wrote, in place of this version's. */
function safe0106(b) { RES_OFFS.forEach(function (o, i) { Buffer.from(RES_0106[i], 'hex').copy(b, o); }); return b; }
/* Build an "older patch" binary: variant + sink applied, self-start still
 * stock. Patches the bytes directly, bypassing the patcher. */
function makeEdit12Only(panel, sinkUrl) {
    var b = Buffer.from(SRCBUF);
    b.writeUInt32LE((panel === 'mid' ? 0xfff7f30c : 0xfff7f2bc) >>> 0, SLOT);
    var s = Buffer.alloc(SINK_LEN, 0); s.write(sinkUrl, 'latin1'); s.copy(b, SINK);
    return b;   /* CALL left stock */
}

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function sha256(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
/* `apply`: an earlier release's patch of the file (this version has none). */
function run(args) {
    var r = cp.spawnSync(process.execPath, [earlier.scriptFor(args, SCRIPT)].concat(args), { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function diffs(a, b) { var d = []; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i); return d; }
function inRegion(d, off, len) { return d.every(function (x) { return x >= off && x < off + len; }); }

if (!fs.existsSync(SRC)) { process.stdout.write('SKIP: set CARPLAY_BIN to a copy of the unit\'s /usr/bin/carplay (carplay 22.28.3)\n'); process.exit(0); }
ok('source is the known pristine build', sha256(SRC) === ORIG_SHA, sha256(SRC));

var dir = tmp.dir();
var tgt = path.join(dir, 'carplay');
fs.writeFileSync(tgt, fs.readFileSync(SRC));
var SRCBUF = fs.readFileSync(SRC);


/* `plan` of target with args into a fresh plan file: {code, out, plan}
 * (plan: its path when one was written). */
var PLAN_OUT = null;
function plan(target, args) {
    try { fs.unlinkSync(PLAN_OUT); } catch (e) {}
    var r = run(['plan', '--target', target, '--out', PLAN_OUT].concat(args));
    r.plan = fs.existsSync(PLAN_OUT) ? PLAN_OUT : null;
    return r;
}
/* The plan laid over target, as `overlay` reads it (the edit lines of
 * status for what a process the plan was applied to runs). */
function overlaid(target, args) {
    var p = plan(target, args);
    if (p.code !== 0 || !p.plan) return { code: p.code === 0 ? 1 : p.code, out: p.out };
    var o = run(['overlay', '--target', target, '--plan', p.plan]);
    return { code: o.code, out: o.out };
}

try {
    PLAN_OUT = path.join(dir, 'carplay.plan');
    var r;
    r = run(['status', '--target', tgt]);
    ok('status: pristine, variant ORIGINAL, sink ORIGINAL, selfstart ORIGINAL, res ORIGINAL, mapurl ORIGINAL',
        /variant:\s+ORIGINAL/.test(r.out) && /sink:\s+ORIGINAL/.test(r.out) && /selfstart:\s+ORIGINAL/.test(r.out) && /res:\s+ORIGINAL \(IC_HIGH advertises 1920x900\)/.test(r.out) &&
        /^mapurl:\s+ORIGINAL \(the phone streams the cluster map once a route starts\)$/m.test(r.out) &&
        /^showui:\s+ORIGINAL \(ShowUI asks the phone for maps:\/car\/instrumentcluster\)$/m.test(r.out) && /pristine/.test(r.out), r.out);
    ok('stock map URL bytes are the proven ones', mapUrlIs(SRCBUF, 1), JSON.stringify(mapUrlBytes(SRCBUF)));
    ok('stock ShowUI URL bytes are the proven ones', showUiIs(SRCBUF, 1), JSON.stringify(rangeBytes(SHOWUI, SRCBUF)));
    ok('status: version 22.28.3, no list of builds named', !/proven:/.test(r.out) && /version:\s+22\.28\.3/.test(r.out), r.out);
    ok('stock res immediates are the proven ones', JSON.stringify(resImmediates(SRCBUF)) === JSON.stringify(RES_STOCK), JSON.stringify(resImmediates(SRCBUF)));

    r = run(['verify', '--target', tgt]);
    ok('verify: original exits 0, self-start off, res stock, map URL off, ShowUI URL stock', r.code === 0 &&
        /variant original, sink original \(AVB 15\), self-start off, res stock, map URL off, ShowUI URL stock$/m.test(r.out), r.out);

    /* The app's patch (high, stock AVB sink, default geometry): this
     * version's plan laid over stock is byte for byte the patch 0.10.4-0.10.5
     * wrote, as run on the car; that without the ShowUI URL edit, the patch
     * 0.9.11-0.10.1 wrote, with the URL with ETA in place of the map URL, the
     * one 0.10.2-0.10.3 wrote, and with the safe area 476x306, the one 0.10.6
     * wrote. */
    function shaOf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
    r = plan(tgt, ['--panel', 'high']);
    var appPatch = r.plan ? require('../carplay_patch.js').overlay(SRCBUF, fs.readFileSync(r.plan, 'utf8')) : { err: 'no plan' };
    ok('the app\'s plan laid over stock: the patch 0.10.4-0.10.5 wrote, the file untouched', r.code === 0 && !appPatch.err &&
        shaOf(appPatch.buf) === 'a241b0e9af9ac1eada5c5ebcf9fab06669a155376b0a5c70cd85f3c1459a88b5' && sha256(tgt) === ORIG_SHA, r.out + (appPatch.err || ''));

    /* An earlier release's patch of the file: the same bytes. */
    r = run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    ok('an earlier release\'s app patch: the patch 0.10.4-0.10.5 wrote', r.code === 0 && sha256(tgt) === 'a241b0e9af9ac1eada5c5ebcf9fab06669a155376b0a5c70cd85f3c1459a88b5', sha256(tgt));
    ok('the app\'s patch without the ShowUI URL edit: the patch 0.9.11-0.10.1 wrote', shaOf(asRelease(fs.readFileSync(tgt), 'map')) ===
        '035c35a40fae0af00ef4bd5ff69d3ce7ff00202d6ad99d770d8b6f1fdc8bed05');
    ok('the app\'s patch with the URL with ETA: the patch 0.10.2-0.10.3 wrote', shaOf(asRelease(fs.readFileSync(tgt), 'eta')) ===
        '99aefe0b40be8c607f077d643086ac52e7d35d99b33fcdbcc757706cf228ba91');
    ok('the app\'s patch with the safe area 476x306: the patch 0.10.6 wrote', shaOf(safe0106(fs.readFileSync(tgt))) ===
        'dcc5f89c3d8b27ae0a8873f08b2d40dafe57a19018c9f3450b396629a25d5356');
    ok('backup is pristine', sha256(tgt + '.woc-orig') === ORIG_SHA);
    var d = diffs(SRCBUF, fs.readFileSync(tgt));
    ok('avb-mode diff stays in the slot, the call rel32, the res immediates and the URL edits\' ranges', d.length >= 2 &&
        d.every(function (x) { return (x >= SLOT && x < SLOT + 4) || (x >= CALL && x < CALL + CALL_LEN) || inResRegion(x) || inUrls(x); }),
        JSON.stringify(d.map(function (x){return '0x'+x.toString(16);})));
    ok('slot = IC_HIGH (bcf2f7ff)', fs.readFileSync(tgt).slice(SLOT, SLOT + 4).toString('hex') === 'bcf2f7ff');
    ok('call retargeted to requestStream', callBytes(fs.readFileSync(tgt)) === CALL_SELF, callBytes(fs.readFileSync(tgt)));
    ok('map URL ranges patched', mapUrlIs(fs.readFileSync(tgt), 2), JSON.stringify(mapUrlBytes(fs.readFileSync(tgt))));
    ok('ShowUI URL ranges patched', showUiIs(fs.readFileSync(tgt), 2), JSON.stringify(rangeBytes(SHOWUI, fs.readFileSync(tgt))));
    ok('res immediates advertise 1088x480 at 138x61mm, safe 504x368 at 286,72',
        JSON.stringify(resImmediates(fs.readFileSync(tgt))) === JSON.stringify(RES_DEFAULT), JSON.stringify(resImmediates(fs.readFileSync(tgt))));
    r = run(['status', '--target', tgt]);
    ok('status: avb mode is SELF-START + sink ORIGINAL + res PATCHED + mapurl PATCHED + showui PATCHED', /selfstart:\s+SELF-START/.test(r.out) && /sink:\s+ORIGINAL/.test(r.out) && /res:\s+PATCHED \(IC_HIGH advertises 1088x480 at 138x61mm, safe 504x368 at 286,72\)/.test(r.out) &&
        /^mapurl:\s+PATCHED \(the phone streams the cluster map from connect: maps:\/car\/instrumentcluster\/map\)$/m.test(r.out) &&
        /^showui:\s+PATCHED \(ShowUI asks the phone for maps:\/car\/instrumentcluster\?showETA=yes, with the arrival-time card\)$/m.test(r.out), r.out);
    ok('status: our patch alone is not foreign', /^foreign:\s+no$/m.test(r.out), r.out);
    r = run(['verify', '--target', tgt]);
    ok('verify: high avb exits 0 with res 1088x480, the map URL on and the ShowUI URL with ETA', r.code === 0 && /res 1088x480, map URL on, ShowUI URL with ETA$/m.test(r.out), r.out);
    r = plan(tgt, ['--panel', 'high']);
    ok('plan refuses a patched file: it needs the pristine build on disk, no plan written', r.code !== 0 && /in memory needs the pristine build on disk/.test(r.out) && !r.plan, r.out);

    r = run(['revert', '--target', tgt, '--yes']);
    ok('revert restores byte-exact original (every edit)', r.code === 0 && sha256(tgt) === ORIG_SHA && callBytes(fs.readFileSync(tgt)) === CALL_STOCK &&
        JSON.stringify(resImmediates(fs.readFileSync(tgt))) === JSON.stringify(RES_STOCK) && mapUrlIs(fs.readFileSync(tgt), 1) && showUiIs(fs.readFileSync(tgt), 1));

    /* Without a backup, the URL edits' ranges are rebuilt from the proven
     * build's shipped bytes with the rest. */
    run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { fs.unlinkSync(f); });
    r = run(['status', '--target', tgt]);
    ok('no backup: the patch with the URL edits is restorable', /^restorable:\s+yes$/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('no backup: revert rebuilds the shipped file, the URL edits\' ranges included', r.code === 0 && /shipped bytes/.test(r.out) && sha256(tgt) === ORIG_SHA, r.out);

    /* An earlier release's mid patch with the FIFO sink */
    var fifo = '/run/woc/alt.h264';
    r = run(['apply', '--target', tgt, '--panel', 'mid', '--capture', fifo, '--yes']);
    var b = fs.readFileSync(tgt);
    ok('slot = IC_MID (0cf3f7ff)', r.code === 0 && b.slice(SLOT, SLOT + 4).toString('hex') === '0cf3f7ff', r.out);
    var nul = b.slice(SINK, SINK + SINK_LEN).indexOf(0);
    var url = b.slice(SINK, SINK + (nul >= 0 ? nul : SINK_LEN)).toString('latin1');
    ok('sink url redirected to the FIFO', url === 'file://' + fifo + '?mime_type=video/H264', url);
    ok('redirect NUL-padded, no overrun into the next string', b.slice(SINK + SINK_LEN, SINK + SINK_LEN + 5).equals(SRCBUF.slice(SINK + SINK_LEN, SINK + SINK_LEN + 5)) && b.slice(SINK + SINK_LEN + 5, SINK + SINK_LEN + 16).toString('latin1') === 'mCarPlay->G');
    ok('call retargeted to requestStream', callBytes(b) === CALL_SELF, callBytes(b));
    var d2 = diffs(SRCBUF, b);
    ok('all diffs within slot, sink, call or URL edits\' regions', d2.every(function (x) { return (x >= SLOT && x < SLOT + 4) || (x >= SINK && x < SINK + SINK_LEN) || (x >= CALL && x < CALL + CALL_LEN) || inUrls(x); }), 'n=' + d2.length);
    ok('mid holds the URL edits too', mapUrlIs(b, 2) && showUiIs(b, 2), JSON.stringify(mapUrlBytes(b)));
    ok('mid leaves the res immediates stock', JSON.stringify(resImmediates(fs.readFileSync(tgt))) === JSON.stringify(RES_STOCK));
    r = run(['status', '--target', tgt]);
    ok('status: PATCHED IC_MID + REDIRECTED + SELF-START + res ORIGINAL', /variant:\s+PATCHED -> IC_MID/.test(r.out) && /sink:\s+REDIRECTED -> file:\/\//.test(r.out) && /selfstart:\s+SELF-START/.test(r.out) && /res:\s+ORIGINAL/.test(r.out), r.out);
    r = run(['verify', '--target', tgt]);
    ok('verify: patched exits 0, slot matches live IC target, self-start on, res stock', r.code === 0 && /IC_MID/.test(r.out) && /self-start on/.test(r.out) && /res stock/.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('revert undoes both edits byte-exact', r.code === 0 && sha256(tgt) === ORIG_SHA);

    /* The plan's sinks: the FIFO and the stream sink, read back over stock;
     * a path too long for the slot, an unknown scheme or a flag without its
     * value refused before any plan. */
    r = overlaid(tgt, ['--panel', 'mid', '--capture', fifo]);
    ok('plan mid + capture: IC_MID, the FIFO sink, self-start, res stock', r.code === 0 && /variant:\s+PATCHED -> IC_MID/.test(r.out) &&
        /sink:\s+REDIRECTED -> file:\/\/\/run\/woc\/alt\.h264/.test(r.out) && /selfstart:\s+SELF-START/.test(r.out) && /res:\s+ORIGINAL/.test(r.out) && /^overlay:\s+ok$/m.test(r.out), r.out);
    var udp = 'udp://127.0.0.1:20557?mime_type=video/H264';
    r = overlaid(tgt, ['--panel', 'high', '--sink', udp]);
    ok('plan high + udp sink: IC_HIGH, REDIRECTED udp://', r.code === 0 && /variant:\s+PATCHED -> IC_HIGH/.test(r.out) && /sink:\s+REDIRECTED -> udp:\/\//.test(r.out), r.out);
    r = plan(tgt, ['--panel', 'high', '--capture', '/run/woc/' + 'x'.repeat(60) + '.h264']);
    ok('over-long capture path: plan refused, no plan', r.code !== 0 && /too long/.test(r.out) && !r.plan && sha256(tgt) === ORIG_SHA, r.out);
    r = plan(tgt, ['--panel', 'high', '--sink', 'ws://x']);
    ok('unknown sink scheme: plan refused, no plan', r.code !== 0 && /--sink needs/.test(r.out) && !r.plan, r.out);
    r = plan(tgt, ['--panel', 'high', '--capture']);
    ok('--capture without a value: plan refused', r.code !== 0 && /--capture needs/.test(r.out) && !r.plan, r.out);

    /* An earlier release's udp patch: status and verify read it. */
    r = run(['apply', '--target', tgt, '--panel', 'high', '--sink', udp, '--yes']);
    r = run(['status', '--target', tgt]);
    ok('status: PATCHED IC_HIGH + REDIRECTED udp://', /variant:\s+PATCHED -> IC_HIGH/.test(r.out) && /sink:\s+REDIRECTED -> udp:\/\//.test(r.out), r.out);
    ok('udp sink bytes are the url, NUL-padded', fs.readFileSync(tgt).slice(SINK, SINK + udp.length).toString('latin1') === udp &&
        fs.readFileSync(tgt)[SINK + udp.length] === 0);
    r = run(['verify', '--target', tgt]);
    ok('verify: udp sink exits 0', r.code === 0 && /udp:\/\//.test(r.out), r.out);
    run(['revert', '--target', tgt, '--yes']);
    ok('revert after udp mode restores original', sha256(tgt) === ORIG_SHA);

    /* carplay 22.28.3's build-id with other bytes than the shipped file: the
     * locator's checks at the sites decide, not the whole file's SHA-256;
     * probe names the part that differs. */
    var other = path.join(dir, 'other');
    function otherFile(edit) { var b = Buffer.from(SRCBUF); edit(b); fs.writeFileSync(other, b); return sha256(other); }
    [['another .gnu_debuglink CRC, which no segment loads', function (b) { b[0x352448] ^= 0x5a; }, 'the bytes no segment loads'],
     ['a code byte away from the sites', function (b) { b[0x1000] ^= 0xff; }, 'loaded segment 1 (r-x, file 0x0-0x338d21)']].forEach(function (m) {
        var oSha = otherFile(m[1]);
        r = run(['status', '--target', other]);
        ok(m[0] + ': status pristine', /known:\s+yes, pristine/.test(r.out), r.out);
        r = run(['probe', other]);
        ok(m[0] + ': probe names the part that differs, patchable', new RegExp('^differs:\\s+' + m[2].replace(/[()]/g, '\\$&') + '$', 'm').test(r.out) &&
            /^patchable:\s+yes$/m.test(r.out), r.out);
        r = plan(other, ['--panel', 'high']);
        ok(m[0] + ': planned in memory, the file untouched', r.code === 0 && !!r.plan && sha256(other) === oSha, r.out);
    });
    /* geometry immediates the classifier reads as stock holding other bytes
     * than the shipped file: this tool's safe area (504x368 at 286,72) over a
     * stock geometry, as another tool's restore of its own backup leaves it
     * (the file reported in #245), and another physical size. The locator's
     * checks decide: planned, the file untouched. */
    [['this tool\'s safe area over a stock geometry', function (b) {
        Buffer.from('00000000f8010000', 'hex').copy(b, 0x20ca66); Buffer.from('700100001e014800', 'hex').copy(b, 0x20ca74); },
        'fed8e394ffd1aa1da24b4a537409d58723cf6e8c67b78f97967a6d43c0cc7b37'],
     ['another physical size', function (b) { b[0x20ca36] ^= 0x01; }, null]].forEach(function (m) {
        var siteSha = otherFile(m[1]);
        if (m[2]) ok(m[0] + ': the file reported in #245', siteSha === m[2], siteSha);
        r = run(['status', '--target', other]);
        ok(m[0] + ': status pristine, res ORIGINAL', /known:\s+yes, pristine/.test(r.out) && /^res:\s+ORIGINAL/m.test(r.out), r.out);
        r = run(['probe', other]);
        ok(m[0] + ': probe patchable, no differs line (the bytes are at a site)', !/^differs:/m.test(r.out) && /^patchable:\s+yes$/m.test(r.out), r.out);
        r = plan(other, ['--panel', 'high']);
        ok(m[0] + ': planned in memory, the file untouched', r.code === 0 && !!r.plan && sha256(other) === siteSha, r.out);
    });
    /* the shipped file: no differs line */
    r = run(['probe', tgt]);
    ok('the shipped file: probe prints no differs line', r.code === 0 && !/^differs:/m.test(r.out), r.out);
    /* a loaded segment fewer than the shipped file: the count named */
    (function () {
        var loc = require('../carplay_locate.js'), S = require('../carplay_patch.js').SHIPPED['5de62156575d737391ea42254e778a97dbbb51f8'];
        var b = Buffer.from(SRCBUF), phoff = b.readUInt32LE(0x20), n = b.readUInt16LE(0x38), es = b.readUInt16LE(0x36), last = -1;
        for (var i = 0; i < n; i++) if (b.readUInt32LE(phoff + i * es) === 1) last = i;
        b.writeUInt32LE(0, phoff + last * es);
        var d = loc.partsDiffering(S, b);
        ok('a loaded segment fewer: the count named', JSON.stringify(d) === JSON.stringify(['loaded segments: 1, the shipped file has 2']), JSON.stringify(d));
    })();
    fs.unlinkSync(other);

    /* A binary of the backup's build the locator does not recognise: revert
     * writes the whole backup. */
    run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    var mangled = Buffer.from(fs.readFileSync(tgt));
    mangled.writeUInt32LE(0x11223344, 0x2ba4d4);   /* corrupt the converter table -> unknown variant */
    fs.writeFileSync(tgt, mangled);
    r = run(['status', '--target', tgt]);
    ok('status: an unrecognised binary of the backup\'s build is restorable', /known:\s+NO/.test(r.out) && /restorable:\s+yes/.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes', '--drop-backup']);
    ok('revert restores it whole, without --force, and drops the backup', r.code === 0 && sha256(tgt) === ORIG_SHA &&
        !fs.existsSync(tgt + '.woc-orig') && !fs.existsSync(tgt + '.woc-orig.json'), r.out);

    /* Another build over the backup (a firmware update replaced carplay and
     * left the backup behind): refused; --force writes the backup. */
    run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    var replaced = Buffer.from(fs.readFileSync(tgt));
    replaced[replaced.indexOf(Buffer.from('5de62156575d737391ea42254e778a97dbbb51f8', 'hex'))] ^= 0xff;
    fs.writeFileSync(tgt, replaced);
    r = run(['status', '--target', tgt]);
    ok('status: another build is not restorable', /restorable:\s+no/.test(r.out), r.out);
    ok('status: another build is foreign unknown', /^foreign:\s+unknown$/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('revert refuses another build, keeping it and the backup', r.code !== 0 && /another build/.test(r.out) &&
        fs.readFileSync(tgt).equals(replaced) && fs.existsSync(tgt + '.woc-orig'), r.out);
    r = run(['revert', '--target', tgt, '--yes', '--force']);
    ok('revert --force restores it to the backed-up original', r.code === 0 && sha256(tgt) === ORIG_SHA, r.out);

    /* Another tool's edit outside our regions, made after our patch: status
     * says foreign; revert restores our regions only and keeps it; with only
     * theirs left there is nothing to revert. */
    run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    var withTheirs = Buffer.from(fs.readFileSync(tgt));
    Buffer.from('e900000000', 'hex').copy(withTheirs, 0x9f9a0);
    fs.writeFileSync(tgt, withTheirs);
    r = run(['status', '--target', tgt]);
    ok('our patch beside another tool\'s edit: foreign yes', /^foreign:\s+yes$/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    var reverted = fs.readFileSync(tgt);
    ok('revert keeps another tool\'s edit outside our regions', r.code === 0 && /changes outside them kept/.test(r.out) &&
        reverted.slice(0x9f9a0, 0x9f9a5).toString('hex') === 'e900000000' && /variant original, sink original \(AVB 15\), self-start off, res stock/.test(run(['verify', '--target', tgt]).out), r.out);
    var expect = Buffer.from(SRCBUF);
    Buffer.from('e900000000', 'hex').copy(expect, 0x9f9a0);
    ok('revert: the result is the original with only their edit', reverted.equals(expect));
    r = run(['status', '--target', tgt]);
    ok('status with only their edit left: not restorable', /^restorable: no\b/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('revert with only their edit left: nothing to do, the file untouched', r.code === 0 && /nothing to do/.test(r.out) && fs.readFileSync(tgt).equals(expect), r.out);
    r = run(['revert', '--target', tgt, '--yes', '--force']);
    ok('revert --force writes the whole original', r.code === 0 && sha256(tgt) === ORIG_SHA, r.out);

    /* --drop-backup (a removal of the tool): the backup goes once the target
     * is the original, whether the revert restored it or found it so. */
    run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    r = run(['revert', '--target', tgt, '--yes', '--drop-backup']);
    ok('revert --drop-backup restores, then drops the backup and its record', r.code === 0 && sha256(tgt) === ORIG_SHA &&
        !fs.existsSync(tgt + '.woc-orig') && !fs.existsSync(tgt + '.woc-orig.json'), r.out);
    run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    run(['revert', '--target', tgt, '--yes']);
    r = run(['revert', '--target', tgt, '--yes', '--drop-backup']);
    ok('revert --drop-backup on the original drops the backup', r.code === 0 && sha256(tgt) === ORIG_SHA &&
        !fs.existsSync(tgt + '.woc-orig'), r.out);
    run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    fs.writeFileSync(tgt, Buffer.concat([fs.readFileSync(tgt).slice(0, 0x9f9a0), Buffer.from('e900000000', 'hex'), fs.readFileSync(tgt).slice(0x9f9a5)]));
    r = run(['revert', '--target', tgt, '--yes', '--drop-backup']);
    ok('revert --drop-backup with another tool\'s edit: our edits gone, theirs kept, the backup dropped', r.code === 0 &&
        fs.readFileSync(tgt).equals(expect) && !fs.existsSync(tgt + '.woc-orig'), r.out);
    fs.writeFileSync(tgt, SRCBUF);

    /* An Edit-1/2-only binary (what the car ran before self-start): variant +
     * sink patched, self-start still stock. It must NOT read as fully
     * patched, and revert restores stock. */
    var e12 = path.join(dir, 'carplay_edit12');
    fs.writeFileSync(e12, makeEdit12Only('high', 'udp://127.0.0.1:20557?mime_type=video/H264'));
    fs.writeFileSync(e12 + '.woc-orig', SRCBUF);   /* the car keeps the pristine backup */
    fs.writeFileSync(e12 + '.woc-orig.json', JSON.stringify({ sha256_original: ORIG_SHA }) + '\n');
    r = run(['status', '--target', e12]);
    ok('edit-1/2-only: variant+sink patched but self-start and res ORIGINAL', /variant:\s+PATCHED -> IC_HIGH/.test(r.out) && /sink:\s+REDIRECTED -> udp/.test(r.out) && /selfstart:\s+ORIGINAL/.test(r.out) && /res:\s+ORIGINAL/.test(r.out), r.out);
    ok('edit-1/2-only: ours, not foreign', /^foreign:\s+no$/m.test(r.out) && /^restorable:\s+yes$/m.test(r.out), r.out);
    r = run(['verify', '--target', e12]);
    ok('edit-1/2-only: verify FAILS as partially patched', r.code !== 0 && /partially patched/.test(r.out), r.out);
    r = run(['revert', '--target', e12, '--yes']);
    ok('edit-1/2-only: revert restores byte-exact stock', r.code === 0 && sha256(e12) === ORIG_SHA);

    /* The pre-resolution patch shape (variant + sink + self-start, stock
     * geometry): verify calls it partial on the high panel; revert restores
     * stock. */
    var e123 = path.join(dir, 'carplay_edit123');
    fs.writeFileSync(e123, SRCBUF);
    run(['apply', '--target', e123, '--panel', 'high', '--yes']);
    var b123 = Buffer.from(fs.readFileSync(e123));
    [0x20ca30, 0x20ca52, 0x20ca64, 0x20ca72].forEach(function (o, i) {
        Buffer.from(RES_STOCK[i], 'hex').copy(b123, o);   /* geometry back to stock, the rest patched */
    });
    fs.writeFileSync(e123, b123);
    r = run(['status', '--target', e123]);
    ok('pre-resolution patch: SELF-START but res ORIGINAL', /selfstart:\s+SELF-START/.test(r.out) && /res:\s+ORIGINAL/.test(r.out), r.out);
    r = run(['verify', '--target', e123]);
    ok('pre-resolution patch: verify FAILS as partially patched', r.code !== 0 && /partially patched/.test(r.out) && /res original/.test(r.out), r.out);
    r = run(['revert', '--target', e123, '--yes']);
    ok('pre-resolution patch: revert restores byte-exact stock', r.code === 0 && sha256(e123) === ORIG_SHA, r.out);

    /* The patch of each earlier release (every other edit; the URL edits'
     * ranges stock before 0.9.11, the map URL of 0.9.11-0.10.1, the URL with
     * ETA of 0.10.2-0.10.3, the ShowUI URL stock): status and verify say so,
     * and a revert restores stock from the backup and, without one, from the
     * shipped bytes. */
    var e1234 = path.join(dir, 'carplay_edit1234');
    fs.writeFileSync(e1234, SRCBUF);
    run(['apply', '--target', e1234, '--panel', 'high', '--yes']);
    var full = fs.readFileSync(e1234);
    [['pre-map-URL patch', 'none', /^mapurl:\s+ORIGINAL /m, /map URL off, ShowUI URL stock$/m],
     ['0.9.11-0.10.1 patch', 'map', /^mapurl:\s+PATCHED \(the phone streams the cluster map from connect: maps:\/car\/instrumentcluster\/map\)$/m, /map URL on, ShowUI URL stock$/m],
     ['0.10.2-0.10.3 patch', 'eta', /^mapurl:\s+PATCHED WITH ETA \(the phone streams the cluster map from connect: maps:\/car\/instrumentcluster\/map\?showETA=yes; the patch writes maps:\/car\/instrumentcluster\/map\)$/m,
        /map URL on with ETA, ShowUI URL stock$/m]].forEach(function (t) {
        var rel = asRelease(full, t[1]);
        fs.writeFileSync(e1234, rel);
        r = run(['status', '--target', e1234]);
        ok(t[0] + ': known, res PATCHED, its map URL, ShowUI URL ORIGINAL, not foreign', /res:\s+PATCHED/.test(r.out) && t[2].test(r.out) && /^showui:\s+ORIGINAL /m.test(r.out) &&
            /known:\s+yes, modified build/.test(r.out) && /^restorable:\s+yes$/m.test(r.out) && /^foreign:\s+no$/m.test(r.out), r.out);
        r = run(['verify', '--target', e1234]);
        ok(t[0] + ': verify passes, says so', r.code === 0 && t[3].test(r.out), r.out);
        r = run(['revert', '--target', e1234, '--yes']);
        ok(t[0] + ': revert restores byte-exact stock', r.code === 0 && sha256(e1234) === ORIG_SHA, r.out);
        fs.writeFileSync(e1234, rel);
        var bakAside = fs.readFileSync(e1234 + '.woc-orig'), metaAside = fs.readFileSync(e1234 + '.woc-orig.json');
        [e1234 + '.woc-orig', e1234 + '.woc-orig.json'].forEach(function (f) { fs.unlinkSync(f); });
        r = run(['revert', '--target', e1234, '--yes']);
        ok(t[0] + ', no backup: revert rebuilds the shipped file', r.code === 0 && /shipped bytes/.test(r.out) && sha256(e1234) === ORIG_SHA, r.out);
        fs.writeFileSync(e1234 + '.woc-orig', bakAside, { mode: 0o600 }); fs.writeFileSync(e1234 + '.woc-orig.json', metaAside, { mode: 0o600 });
    });
    /* The ranges holding different forms (a log string of one, the lea of
     * the other): unrecognised; revert writes the whole backup. */
    [[2, 3], [3, 2]].forEach(function (f) {
        var mixed = Buffer.from(full);
        Buffer.from(MAPURL[0][f[0]], 'hex').copy(mixed, MAPURL[0][0]); Buffer.from(MAPURL[1][f[1]], 'hex').copy(mixed, MAPURL[1][0]);
        fs.writeFileSync(e1234, mixed);
        r = run(['status', '--target', e1234]);
        var what = 'the ' + (f[0] === 2 ? 'log string' : 'log string with ETA') + ' with the ' + (f[1] === 2 ? 'lea' : 'lea at the URL with ETA');
        ok(what + ': not known, restorable', /^mapurl:\s+UNKNOWN \(map URL: partly patched\)$/m.test(r.out) && /^restorable:\s+yes$/m.test(r.out), r.out);
        r = run(['revert', '--target', e1234, '--yes']);
        ok(what + ': revert writes the whole backup', r.code === 0 && sha256(e1234) === ORIG_SHA, r.out);
    });

    /* One map URL range patched and the other stock (a write of ours cut
     * short): unrecognised, as a located site that reads as neither; a plan
     * refuses it and revert writes the whole backup. */
    var half = Buffer.from(SRCBUF);
    Buffer.from(MAPURL[1][2], 'hex').copy(half, MAPURL[1][0]);
    fs.writeFileSync(e1234, half);
    r = run(['status', '--target', e1234]);
    ok('half a map URL edit: not known, restorable', /^mapurl:\s+UNKNOWN \(map URL: partly patched\)$/m.test(r.out) &&
        /known:\s+NO — map URL: partly patched/.test(r.out) && /^restorable:\s+yes$/m.test(r.out), r.out);
    r = plan(e1234, ['--panel', 'high']);
    ok('half a map URL edit: plan refuses, no plan, no write', r.code !== 0 && /refusing: map URL: partly patched/.test(r.out) && !r.plan && fs.readFileSync(e1234).equals(half), r.out);
    r = run(['verify', '--target', e1234]);
    ok('half a map URL edit: verify fails', r.code !== 0 && /map URL: partly patched/.test(r.out), r.out);
    r = run(['revert', '--target', e1234, '--yes']);
    ok('half a map URL edit: revert writes the whole backup', r.code === 0 && sha256(e1234) === ORIG_SHA, r.out);

    /* The ShowUI URL edit with one range written, or a range cut short at
     * any byte (either way round), the rest of the patch in place:
     * unrecognised; verify fails, revert writes the whole backup. */
    var showCuts = [['the log text alone', function (x) { Buffer.from(SHOWUI[0][2], 'hex').copy(x, SHOWUI[0][0]); }],
        ['the call site alone', function (x) { Buffer.from(SHOWUI[1][2], 'hex').copy(x, SHOWUI[1][0]); }]];
    for (var ck = 1; ck < 11; ck++) (function (k) {
        showCuts.push(['the call site\'s first ' + k + ' bytes', function (x) { Buffer.from(SHOWUI[1][2], 'hex').slice(0, k).copy(x, SHOWUI[1][0]); }]);
        showCuts.push(['the patch with the call site\'s first ' + k + ' bytes stock', function (x) {
            Buffer.from(SHOWUI[0][2], 'hex').copy(x, SHOWUI[0][0]); Buffer.from(SHOWUI[1][2], 'hex').copy(x, SHOWUI[1][0]); Buffer.from(SHOWUI[1][1], 'hex').slice(0, k).copy(x, SHOWUI[1][0]); }]);
    })(ck);
    [24, 40, 63].forEach(function (k) {
        showCuts.push(['the log text\'s first ' + k + ' bytes', function (x) { Buffer.from(SHOWUI[0][2], 'hex').slice(0, k).copy(x, SHOWUI[0][0]); }]);
        showCuts.push(['the log text from byte ' + k, function (x) { Buffer.from(SHOWUI[0][2], 'hex').slice(k).copy(x, SHOWUI[0][0] + k); }]);
    });
    showCuts.forEach(function (t) {
        var cut = asRelease(full, 'map'); t[1](cut);
        fs.writeFileSync(e1234, cut);
        r = run(['status', '--target', e1234]);
        var known = /^showui:\s+UNKNOWN \(ShowUI URL: partly patched\)$/m.test(r.out) && /^restorable:\s+yes$/m.test(r.out);
        r = run(['verify', '--target', e1234]);
        var vfail = r.code !== 0;
        r = run(['revert', '--target', e1234, '--yes']);
        ok('ShowUI URL with ' + t[0] + ' written: unknown and restorable, verify fails, revert writes the whole backup',
            known && vfail && r.code === 0 && sha256(e1234) === ORIG_SHA, r.out);
    });

    /* Another tool's bytes in the log string (neither stock nor ours): an
     * earlier release's patch left the edit alone and wrote the others,
     * which verify and revert as ever, and those bytes stay. */
    var foreign = Buffer.from(SRCBUF);
    foreign[MAPURL[0][0] + 4] ^= 0x20;
    fs.writeFileSync(e1234, foreign);
    r = run(['status', '--target', e1234]);
    ok('foreign map URL bytes: NOT APPLIED, the build pristine (the locator decides)', /^mapurl:\s+NOT APPLIED \(map URL: log string not found\)$/m.test(r.out) &&
        /known:\s+yes, pristine/.test(r.out), r.out);
    r = run(['apply', '--target', e1234, '--panel', 'high', '--yes']);
    ok('foreign map URL bytes: an earlier release\'s patch holds the other edits, those bytes as found', r.code === 0 &&
        JSON.stringify(mapUrlBytes(fs.readFileSync(e1234))) === JSON.stringify(mapUrlBytes(foreign)), r.out);
    r = run(['verify', '--target', e1234]);
    ok('foreign map URL bytes: verify passes, map URL n/a', r.code === 0 && /map URL n\/a/.test(r.out), r.out);
    r = run(['revert', '--target', e1234, '--yes']);
    ok('foreign map URL bytes: revert restores the other edits and keeps those bytes', r.code === 0 && fs.readFileSync(e1234).equals(foreign), r.out);
    /* Likewise in the ShowUI log text. */
    foreign = Buffer.from(SRCBUF);
    foreign[SHOWUI[0][0] + 40] ^= 0x20;
    fs.writeFileSync(e1234, foreign);
    r = run(['status', '--target', e1234]);
    ok('foreign ShowUI log text bytes: NOT APPLIED, the build pristine (the locator decides)', /^showui:\s+NOT APPLIED \(ShowUI URL: ShowUI not called with the alternate display URL\)$/m.test(r.out) &&
        /known:\s+yes, pristine/.test(r.out), r.out);
    r = run(['apply', '--target', e1234, '--panel', 'high', '--yes']);
    ok('foreign ShowUI log text bytes: an earlier release\'s patch holds the other edits, those bytes as found', r.code === 0 &&
        JSON.stringify(rangeBytes(SHOWUI, fs.readFileSync(e1234))) === JSON.stringify(rangeBytes(SHOWUI, foreign)), r.out);
    r = run(['revert', '--target', e1234, '--yes']);
    ok('foreign ShowUI log text bytes: revert restores the other edits and keeps those bytes', r.code === 0 && fs.readFileSync(e1234).equals(foreign), r.out);

    /* The plan's geometry: mid keeps the stock geometry, a custom --res
     * lands in the immediates at the same physical size, --safe full and
     * --safe WxH+X+Y write other safe areas; values out of range, or for
     * the mid panel, or missing, are refused before any plan. */
    var pt = path.join(dir, 'carplay_plan');
    fs.writeFileSync(pt, SRCBUF);
    r = overlaid(pt, ['--panel', 'mid']);
    ok('plan mid: the stock geometry', r.code === 0 && /res:\s+ORIGINAL/.test(r.out), r.out);
    r = overlaid(pt, ['--panel', 'high', '--res', '800x360']);
    ok('plan --res 800x360: at 138x61mm with the safe area scaled', r.code === 0 && /res:\s+PATCHED \(IC_HIGH advertises 800x360 at 138x61mm, safe 371x276 at 210,54\)/.test(r.out), r.out);
    r = overlaid(pt, ['--panel', 'high', '--res', '1920x1080']);
    ok('plan --res 1920x1080: labelled by its size, not stock', r.code === 0 && /res:\s+PATCHED \(IC_HIGH advertises 1920x1080 at 138x61mm/.test(r.out), r.out);
    r = overlaid(pt, ['--panel', 'high', '--safe', 'full']);
    ok('plan --safe full: the full-frame safe area', r.code === 0 && /safe 1088x480 at 0,0/.test(r.out), r.out);
    r = overlaid(pt, ['--panel', 'high', '--safe', '600x400+244+40']);
    ok('plan --safe WxH+X+Y: that safe area', r.code === 0 && /safe 600x400 at 244,40/.test(r.out), r.out);
    [[['--panel', 'high', '--res', '719x320'], /out of range/, 'odd --res'],
     [['--panel', 'mid', '--res', '720x320'], /--panel high/, '--res with --panel mid'],
     [['--panel', 'high', '--res'], /--res needs/, '--res without a value'],
     [['--panel', 'high', '--safe', '600x400+500+40'], /out of range/, '--safe outside the frame'],
     [['--panel', 'high', '--safe', '600x400'], /--safe needs/, 'malformed --safe'],
     [['--panel', 'mid', '--safe', 'full'], /--panel high/, '--safe with --panel mid']].forEach(function (t) {
        r = plan(pt, t[0]);
        ok(t[2] + ': plan refused, no plan', r.code !== 0 && t[1].test(r.out) && !r.plan && sha256(pt) === ORIG_SHA, r.out);
    });

    /* An earlier release's patch at 1088x480 with the whole frame as the safe
     * area reads as patched (res still 1088x480). */
    var fs1 = path.join(dir, 'carplay_fullsafe');
    fs.writeFileSync(fs1, SRCBUF);
    run(['apply', '--target', fs1, '--panel', 'high', '--yes']);
    var bfs = Buffer.from(fs.readFileSync(fs1));
    [0x20ca30, 0x20ca52, 0x20ca64, 0x20ca72].forEach(function (o, i) {
        Buffer.from(RES_FULLSAFE[i], 'hex').copy(bfs, o);
    });
    fs.writeFileSync(fs1, bfs);
    r = run(['status', '--target', fs1]);
    ok('full-frame safe: status PATCHED 1088x480 with safe 1088x480 at 0,0',
        /res:\s+PATCHED \(IC_HIGH advertises 1088x480 at 138x61mm, safe 1088x480 at 0,0\)/.test(r.out) && /known:\s+yes/.test(r.out), r.out);
    r = run(['verify', '--target', fs1]);
    ok('full-frame safe: verify passes', r.code === 0 && /res 1088x480/.test(r.out), r.out);
    r = run(['revert', '--target', fs1, '--yes']);
    ok('full-frame safe: revert restores byte-exact stock', r.code === 0 && sha256(fs1) === ORIG_SHA, r.out);

    /* The safe area 0.10.6 wrote (476x306 at 306,72) reads as patched, and
     * revert restores stock from it. */
    var rel = path.join(dir, 'carplay_0106_safe');
    fs.writeFileSync(rel, SRCBUF);
    run(['apply', '--target', rel, '--panel', 'high', '--yes']);
    var brel = safe0106(Buffer.from(fs.readFileSync(rel)));
    fs.writeFileSync(rel, brel);
    r = run(['status', '--target', rel]);
    ok('0.10.6 safe: status PATCHED 1088x480 with safe 476x306 at 306,72, known',
        /res:\s+PATCHED \(IC_HIGH advertises 1088x480 at 138x61mm, safe 476x306 at 306,72\)/.test(r.out) && /known:\s+yes/.test(r.out), r.out);
    r = run(['verify', '--target', rel]);
    ok('0.10.6 safe: verify passes', r.code === 0 && /res 1088x480/.test(r.out), r.out);
    r = run(['revert', '--target', rel, '--yes']);
    ok('0.10.6 safe: revert restores byte-exact stock', r.code === 0 && sha256(rel) === ORIG_SHA, r.out);
    /* A safe area that overruns the frame is not this tool's geometry. */
    run(['apply', '--target', fs1, '--panel', 'high', '--yes']);
    var bad = Buffer.from(fs.readFileSync(fs1));
    Buffer.from('48b800000000f8010000', 'hex').copy(bad, 0x20ca64);   /* safe width 504 */
    Buffer.from('48b870010000a0024800', 'hex').copy(bad, 0x20ca72);   /* safe x 672: 672+504 > 1088 */
    fs.writeFileSync(fs1, bad);
    r = run(['status', '--target', fs1]);
    ok('safe area outside the frame: status res UNKNOWN', /res:\s+UNKNOWN/.test(r.out), r.out);

    /* a corrupted resolution anchor is refused before any plan */
    var badres = Buffer.from(SRCBUF); badres[0x20ca5c] ^= 0xff;   /* the store after the px movabs */
    var br = path.join(dir, 'carplay_badres'); fs.writeFileSync(br, badres);
    r = run(['status', '--target', br]);
    ok('bad res anchor: status reports res UNKNOWN', /res:\s+UNKNOWN/.test(r.out), r.out);
    r = plan(br, ['--panel', 'high']);
    ok('bad res anchor: plan refused, no plan', r.code !== 0 && /resolution/.test(r.out) && !r.plan && fs.readFileSync(br).equals(badres), r.out);

    /* a self-start call without its AVAILABLE argument is refused before any plan */
    var badcall = Buffer.from(SRCBUF); badcall[CALL - 12] = 0x02;   /* mov dword [rsp+8],1 -> 2 */
    var bc = path.join(dir, 'carplay_badcall'); fs.writeFileSync(bc, badcall);
    r = run(['status', '--target', bc]);
    ok('damaged self-start site: status reports selfstart UNKNOWN with the reason', /selfstart:\s+UNKNOWN \(self-start: call has no AVAILABLE argument\)/.test(r.out) &&
        /known:\s+NO — self-start: call has no AVAILABLE argument/.test(r.out), r.out);
    r = plan(bc, ['--panel', 'high']);
    ok('damaged self-start site: plan refused, no plan', r.code !== 0 && /refusing: self-start: call has no AVAILABLE argument/.test(r.out) && !r.plan, r.out);

    /* An Edit-1-only binary (the variant slot alone): partially patched, and
     * a plan refuses it (not the pristine build). */
    var e1 = path.join(dir, 'carplay_edit1');
    var e1buf = Buffer.from(SRCBUF); e1buf.writeUInt32LE(0xfff7f2bc >>> 0, SLOT);
    fs.writeFileSync(e1, e1buf);
    r = run(['status', '--target', e1]);
    ok('edit-1-only: variant PATCHED, the rest ORIGINAL, a modified build', /variant:\s+PATCHED -> IC_HIGH/.test(r.out) && /sink:\s+ORIGINAL/.test(r.out) &&
        /selfstart:\s+ORIGINAL/.test(r.out) && /res:\s+ORIGINAL/.test(r.out) && /known:\s+yes, modified build/.test(r.out), r.out);
    r = run(['verify', '--target', e1]);
    ok('edit-1-only: verify FAILS as partially patched', r.code !== 0 && /partially patched — variant patched, self-start original, res original/.test(r.out), r.out);
    r = plan(e1, ['--panel', 'high']);
    ok('edit-1-only: plan refuses it', r.code !== 0 && /in memory needs the pristine build on disk: variant edited/.test(r.out) && !r.plan && fs.readFileSync(e1).equals(e1buf), r.out);

    /* probe reads only, and names the documented sites */
    var before = fs.statSync(SRC).mtime.getTime();
    r = run(['probe', SRC]);
    ok('probe: the documented sites, proven, patchable', r.code === 0 && /variant:\s+slot 0x2ba4f0 \(table 0x2ba4d4, 12 slots\): ORIGINAL/.test(r.out) &&
        /^mapurl:\s+string 0x257838 \(55 bytes, log 0x88aa2\), initial URL 0x7b533 \(display builder 0x2078b0\): ORIGINAL/m.test(r.out) &&
        /^showui:\s+log text 0x2908a0 \(64 bytes\), call site 0x18188a \(11 bytes, requestStream 0x181810, URL getter 0x1fe5e0\): ORIGINAL/m.test(r.out) &&
        /sink:\s+slot 0x2a20b0 \(59 bytes\): ORIGINAL/.test(r.out) &&
        /selfstart:\s+call 0x18176c in onSuggestUi 0x1816f0 \(setStreamStatus 0x181560, requestStream 0x181810\): ORIGINAL/.test(r.out) &&
        /res:\s+immediates 0x20ca32 0x20ca54 0x20ca66 0x20ca74 \(builder 0x20ca30\): ORIGINAL/.test(r.out) &&
        !/proven:/.test(r.out) && /patchable:\s+yes/.test(r.out) && /build-id:\s+5de62156/.test(r.out), r.out);
    ok('probe: the file untouched', sha256(SRC) === ORIG_SHA && fs.statSync(SRC).mtime.getTime() === before);
    r = run(['probe', bc]);
    ok('probe: a damaged site makes the build not patchable, with the reason', /patchable:\s+no — self-start: call has no AVAILABLE argument/.test(r.out), r.out);

    /* A build no list names (another build-id) with every site stock:
     * planned as any other; an earlier release's patch of it verifies and
     * reverts byte-exact. */
    var other = Buffer.from(SRCBUF);
    var bid = other.indexOf(Buffer.from('5de62156575d737391ea42254e778a97dbbb51f8', 'hex'));
    other[bid] ^= 0xff;
    other[0x9f9a0] ^= 0xff;   /* and a byte that differs from the proven build elsewhere */
    var ot = path.join(dir, 'carplay_other');
    fs.writeFileSync(ot, other);
    r = run(['status', '--target', ot]);
    ok('another build: pristine by its stock sites, its version, the URL edits found', /known:\s+yes, pristine build a2e62156/.test(r.out) &&
        !/proven:/.test(r.out) && /version:\s+22\.28\.3/.test(r.out) && /^mapurl:\s+ORIGINAL/m.test(r.out) && /^showui:\s+ORIGINAL/m.test(r.out), r.out);
    r = plan(ot, ['--panel', 'high']);
    var summary = null; try { summary = JSON.parse(r.out.trim().split('\n').pop()); } catch (e) {}
    ok('another build: planned without --unproven, its build and version in the summary, no list named', r.code === 0 && !!r.plan && !!summary &&
        summary.build === 'a2e62156575d737391ea42254e778a97dbbb51f8' && summary.version === 'carplay 22.28.3' && !('provenBuild' in summary) && summary.coding === 'ok', r.out);
    r = run(['apply', '--target', ot, '--panel', 'high', '--sink', 'udp://127.0.0.1:20557?mime_type=video/H264', '--unproven', '--yes']);
    ok('another build: an earlier release\'s patch holds every edit', r.code === 0 && mapUrlIs(fs.readFileSync(ot), 2) && showUiIs(fs.readFileSync(ot), 2), r.out);
    var od = diffs(other, fs.readFileSync(ot));
    ok('another build: the diff stays in the edit regions', od.length > 0 && od.every(function (x) {
        return (x >= SLOT && x < SLOT + 4) || (x >= SINK && x < SINK + SINK_LEN) || (x >= CALL && x < CALL + CALL_LEN) || inResRegion(x) || inUrls(x); }));
    r = run(['verify', '--target', ot]);
    ok('another build: verify passes, map URL on, ShowUI URL with ETA', r.code === 0 && /IC_HIGH, sink udp:\/\/127\.0\.0\.1:20557/.test(r.out) && /map URL on, ShowUI URL with ETA$/m.test(r.out), r.out);
    r = run(['revert', '--target', ot, '--yes']);
    ok('another build: revert restores it byte-exact', r.code === 0 && fs.readFileSync(ot).equals(other), r.out);

    /* A backup of another build is never restored over the target. */
    fs.writeFileSync(tgt, SRCBUF);
    [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    fs.writeFileSync(tgt + '.woc-orig', other);
    fs.unlinkSync(tgt + '.woc-orig.json');
    var tSha = sha256(tgt);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('a backup of another build: revert refuses, no write', r.code !== 0 && /another build/.test(r.out) && sha256(tgt) === tSha, r.out);

    codingAndRecord();
} finally {
    try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
}

/* The cluster coding and the patch record: the plan's summary says how the
 * coding read; a revert of an earlier release's patch records whether it ran
 * healthy, with the URLs and the geometry it held. */
function codingAndRecord() {
    var r, ct = path.join(dir, 'carplay_coding');
    function fresh() {
        [ct, ct + '.woc-orig', ct + '.woc-orig.json', record.recordPath(ct)].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
        fs.writeFileSync(ct, SRCBUF);
    }
    function rec() { var x = record.current(ct); return x ? JSON.stringify({ patched: x.patched, proven: x.proven, trial: x.trial, healthy: x.healthy, mapurl: x.mapurl, showui: x.showui, res: x.res }) : 'none'; }
    function want(o) { return JSON.stringify({ patched: o.patched, proven: o.proven, trial: o.trial, healthy: o.healthy, mapurl: o.mapurl, showui: o.showui, res: o.res }); }
    function summaryOf(out) { try { return JSON.parse(out.trim().split('\n').pop()); } catch (e) { return null; } }
    /* The patch of an earlier release ('none': no URL edits, 'map': the map
     * URL of 0.9.11-0.10.1, 'eta': the URL with ETA of 0.10.2-0.10.3) that
     * ran healthy. */
    function earlierHealthy(rel) {
        fresh();
        run(['apply', '--target', ct, '--panel', 'high', '--yes']);
        fs.writeFileSync(ct + '.tmp', asRelease(fs.readFileSync(ct), rel || 'none'), { mode: 0o755 });
        fs.renameSync(ct + '.tmp', ct);
        record.write(ct, { patched: true, proven: true });
    }
    try {
        fresh();
        r = run(['status', '--target', ct]);
        ok('coding: status names it', /^coding:\s+KI_KOMBI_VARIANT 7$/m.test(r.out), r.out);
        r = plan(ct, ['--panel', 'high']);
        ok('coding: variant 7, the plan says the coding is ok', r.code === 0 && !!r.plan && (summaryOf(r.out) || {}).coding === 'ok', r.out);
        /* KI_KOMBI_VARIANT 7 and a coding that cannot be read (as 7) are
         * planned, the summary naming the coding; 0 (no cluster display)
         * and every other cluster are refused, --unproven (what earlier
         * releases' records pass) or not. */
        ok('coding: variant 7, the summary names it', (summaryOf(r.out) || {}).variant === 7, r.out);
        [[function () { car.coding(7, 0x0b); }, /^coding:\s+unreadable \(coding not valid/m],
         [function () { car.coding(null); }, /^coding:\s+unreadable \(.* unreadable\)$/m]].forEach(function (c) {
            fresh();
            c[0]();
            r = run(['status', '--target', ct]);
            ok('coding: status reads ' + c[1], c[1].test(r.out), r.out);
            r = plan(ct, ['--panel', 'high']);
            var sum = summaryOf(r.out) || {};
            ok('coding: ' + c[1] + ' planned as 7, the coding unreadable', r.code === 0 && !!r.plan && sum.coding === 'unreadable' && sum.variant === null &&
                sha256(ct) === ORIG_SHA && rec() === 'none', r.out);
            car.coding(7);
        });
        [[0, 'not supported on this car (KI_KOMBI_VARIANT 0: no cluster display is coded)'],
         [9, 'built in on this cluster (KI_KOMBI_VARIANT 9: CarPlay and Android Auto stream the cluster map themselves)'],
         [10, 'built in on this cluster (KI_KOMBI_VARIANT 10: CarPlay and Android Auto stream the cluster map themselves)'],
         [4, 'not supported on this cluster (KI_KOMBI_VARIANT 4; the map is made for KI_KOMBI_VARIANT 7)'],
         [12, 'not supported on this cluster (KI_KOMBI_VARIANT 12; the map is made for KI_KOMBI_VARIANT 7)']].forEach(function (c) {
            fresh();
            car.coding(c[0]);
            [[], ['--unproven']].forEach(function (extra) {
                r = plan(ct, ['--panel', 'high'].concat(extra));
                ok('coding: KI_KOMBI_VARIANT ' + c[0] + ' refused' + (extra.length ? ' with --unproven too' : '') + ', no plan, nothing written',
                    r.code !== 0 && r.out.indexOf('error: refusing: ' + c[1] + '\n') >= 0 && !r.plan && sha256(ct) === ORIG_SHA, r.out);
            });
        });
        car.coding(7);

        /* An earlier release's first patch, recorded on trial: its revert
         * leaves no healthy mark. */
        fresh();
        run(['apply', '--target', ct, '--panel', 'high', '--yes']);
        ok('record: an earlier release\'s first patch on a variant-7 car is on trial', rec() === want({ patched: true, proven: false, trial: true }), rec());
        r = run(['revert', '--target', ct, '--yes']);
        ok('record: reverting a patch on trial leaves no healthy mark', r.code === 0 && rec() === want({ patched: false }), r.out + rec());

        /* The watcher's record once carplay ran it healthy. */
        run(['apply', '--target', ct, '--panel', 'high', '--yes']);
        record.write(ct, { patched: true, proven: true });
        r = run(['revert', '--target', ct, '--yes']);
        var HEALTHY = { patched: false, healthy: true, mapurl: 'maps:/car/instrumentcluster/map', showui: 'maps:/car/instrumentcluster?showETA=yes', res: GEOM_KEY };
        ok('record: its revert remembers it ran healthy, with the URLs', r.code === 0 && sha256(ct) === ORIG_SHA && rec() === want(HEALTHY), r.out + rec());
        r = run(['revert', '--target', ct, '--yes']);
        ok('record: a revert with nothing to do keeps that', /already at the original/.test(r.out) && rec() === want(HEALTHY), r.out + rec());

        /* The revert of a healthy patch without both URL edits as this
         * version writes them records the URL it held. */
        [['without the URL edits', 'none', { mapurl: false, showui: false }], ['with the map URL alone (0.9.11-0.10.1)', 'map', { mapurl: 'maps:/car/instrumentcluster/map', showui: false }],
         ['with the URL with ETA (0.10.2-0.10.3)', 'eta', { mapurl: false, showui: false }]].forEach(function (t) {
            earlierHealthy(t[1]);
            r = run(['revert', '--target', ct, '--yes']);
            ok('record: the revert of a healthy patch ' + t[0] + ' records the URLs it held as this version writes them', r.code === 0 && sha256(ct) === ORIG_SHA &&
                rec() === want({ patched: false, healthy: true, mapurl: t[2].mapurl, showui: t[2].showui, res: GEOM_KEY }), r.out + rec());
        });
        /* The patch of 0.10.6 (the safe area 476x306) that ran healthy: its
         * revert's record keeps the geometry it held. */
        fresh();
        run(['apply', '--target', ct, '--panel', 'high', '--yes']);
        fs.writeFileSync(ct + '.tmp', safe0106(fs.readFileSync(ct)), { mode: 0o755 });
        fs.renameSync(ct + '.tmp', ct);
        record.write(ct, { patched: true, proven: true });
        r = run(['revert', '--target', ct, '--yes']);
        ok('record: the revert of a healthy patch with 0.10.6\'s safe area records that geometry', r.code === 0 && sha256(ct) === ORIG_SHA &&
            rec() === want({ patched: false, healthy: true, mapurl: 'maps:/car/instrumentcluster/map', showui: 'maps:/car/instrumentcluster?showETA=yes', res: GEOM_KEY_0106 }), r.out + rec());
    } finally {
        car.coding(7);
        [ct, ct + '.woc-orig', ct + '.woc-orig.json', record.recordPath(ct)].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    }
}

process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
process.exit(fails ? 1 : 0);
