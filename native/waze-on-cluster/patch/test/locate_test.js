#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves carplay_locate.js and carplay_patch.js on synthetic builds
 * (synthetic_carplay.js): every site found where the build put it, also with
 * other offsets, addresses and code order, and in its patched state; a
 * signature found twice refused as ambiguous; a damaged site, a broken
 * cross-check or a relocation over an edit refused with the reason; verify,
 * probe and revert of an earlier release's patch (earlier_patcher.js) on a
 * build outside the proven list, byte-exact; a file with carplay 21.27.4's
 * build-id but not its shipped bytes read as proven; the map URL sites found
 * by structure, patched with either URL, partly patched, and each of their
 * checks broken with the other edits patched; a patch with the URL with ETA
 * reverted; the ShowUI URL sites found by structure, stock, patched, one
 * written, cut short inside either site, each of their checks broken with
 * the other edits patched, a build that adds carplay.conf's options itself
 * left alone; carplay 22.28.3's stock bytes of both edits
 * checked against the code they encode. With CARPLAY_BIN, the reference
 * build's sites are the documented offsets; with CARPLAY_BINS (paths
 * separated by `:`), every other build is located or refused as recorded
 * in OTHER_BUILDS, and one not recorded is reported.
 *
 *   [CARPLAY_BIN=<carplay 22.28.3>] [CARPLAY_BINS=<carplay>:...] node locate_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit for every patcher and patchd this runs */

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var locator = require('../carplay_locate.js');
var synthetic = require('./synthetic_carplay.js');
var earlier = require('./earlier_patcher.js');

var SCRIPT = path.join(__dirname, '..', 'carplay_patch.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
/* `apply`: an earlier release's patch of the file (this version has none). */
function run(args) {
    var r = cp.spawnSync(process.execPath, [earlier.scriptFor(args, SCRIPT)].concat(args), { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function json(x) { return JSON.stringify(x); }

/* The sites the locator reports, in the fixture's terms. */
function sites(loc) {
    return {
        buildId: loc.buildId, table: loc.variant.table, slot: loc.variant.slot,
        original: loc.variant.original, high: loc.variant.high, mid: loc.variant.mid, sink: loc.sink.offset,
        call: loc.selfstart.offset, setStreamStatus: loc.selfstart.setStreamStatus, requestStream: loc.selfstart.requestStream,
        onSuggestUi: loc.selfstart.onSuggestUi, callOriginal: loc.selfstart.original, callPatched: loc.selfstart.patched,
        builder: loc.res.builder, mm: loc.res.mm, px: loc.res.px, safe1: loc.res.safe1, safe2: loc.res.safe2,
    };
}
function expected(at) { var e = {}; Object.keys(sites({ variant: {}, sink: {}, selfstart: {}, res: {} })).forEach(function (k) { e[k] = at[k]; }); return e; }
/* The map URL sites the locator reports, and where the fixture put them. */
function mapSites(loc) { var m = loc.mapurl; return m.ok ? { spare: m.slot, urlLea: m.lea, info: m.builder, log: m.log } : m.reason; }
function mapExpected(at) { return { spare: at.spare, urlLea: at.urlLea, info: at.info, log: at.log }; }
/* The fixture's map URL edit written with the bytes the locator reports for
 * its form `form` (default 'current': the patched string and the lea at the
 * URL); patch_test.js checks those bytes against carplay 22.28.3's. */
function writeMapUrl(b, at, which, form) {
    var f = locator.locate(b).mapurl.forms.filter(function (x) { return x.name === (form || 'current'); })[0];
    if (which !== 'lea') Buffer.from(f.slotBytes, 'hex').copy(b, at.spare);
    if (which !== 'slot') Buffer.from(f.leaBytes, 'hex').copy(b, at.urlLea);
}
function mapIs(m) { return m.slotIs + '/' + m.leaIs; }
/* The ShowUI URL sites the locator reports, and where the fixture put them. */
function showSites(loc) { var m = loc.showui; return m.ok ? { showStr: m.str, showCall: m.call, altGetter: m.getter } : m.reason; }
function showExpected(at) { return { showStr: at.showStr, showCall: at.showCall, altGetter: at.altGetter }; }
function showIs(m) { return m.strIs + '/' + m.callIs; }
/* The fixture's ShowUI URL edit written ('str', 'call' or both) with the
 * bytes the locator reports; cut: the call site with only its first `cut`
 * bytes written. */
function writeShowUi(b, at, which, cut) {
    var m = locator.locate(b).showui, call = Buffer.from(m.callBytes, 'hex');
    if (which !== 'call') Buffer.from(m.strBytes, 'hex').copy(b, at.showStr);
    if (which !== 'str') call.slice(0, cut === undefined ? call.length : cut).copy(b, at.showCall);
}
function reasons(loc) { return ['variant', 'sink', 'selfstart', 'res'].filter(function (e) { return !loc[e].ok; }).map(function (e) { return loc[e].reason; }); }

var SHIFTED = { pad: 0x123, codeVa: 0x7a000, dataVa: 0x1234000, dataAt: 0x2800, highViaJne: true, midFirst: true };

/* Found where the build put them. */
[['synthetic build', {}], ['shifted build (other offsets, addresses, code order, jne branch)', SHIFTED]].forEach(function (t) {
    var s = synthetic.build(t[1]), loc = locator.locate(s.buf);
    ok(t[0] + ': every site found where it is', loc.ok && json(sites(loc)) === json(expected(s.at)), json(loc));
    ok(t[0] + ': the map URL sites found where they are, stock', json(mapSites(loc)) === json(mapExpected(s.at)) &&
        mapIs(loc.mapurl) === 'stock/stock', json(loc.mapurl));
    ok(t[0] + ': the ShowUI URL sites found where they are, stock', json(showSites(loc)) === json(showExpected(s.at)) &&
        showIs(loc.showui) === 'stock/stock', json(loc.showui));
});
[['the two movs swapped', { showSwapped: true }], ['mov rdi from another register', { showFrom: 'rbx' }]].forEach(function (t) {
    var s = synthetic.build(t[1]), loc = locator.locate(s.buf), b = Buffer.from(s.buf);
    ok('ShowUI URL (' + t[0] + '): found where it is, stock', json(showSites(loc)) === json(showExpected(s.at)) && showIs(loc.showui) === 'stock/stock', json(loc.showui));
    writeShowUi(b, s.at);
    loc = locator.locate(b);
    ok('ShowUI URL (' + t[0] + '): patched, found patched, its mov rdi kept', showIs(loc.showui) === 'patched/patched' &&
        b.slice(s.at.showCall, s.at.showCall + 3).equals(s.buf.slice(s.at.showCall + (t[1].showSwapped ? 8 : 5), s.at.showCall + (t[1].showSwapped ? 11 : 8))), json(loc.showui));
});
var plain = synthetic.build({}), shifted = synthetic.build(SHIFTED);
ok('the shifted build moves every site', ['slot', 'sink', 'call', 'mm'].every(function (k) { return plain.at[k] !== shifted.at[k]; }));

/* The patched state is found at the same sites. */
(function () {
    var s = synthetic.build(SHIFTED), b = Buffer.from(s.buf);
    b.writeUInt32LE(s.at.high, s.at.slot);
    Buffer.alloc(59).copy(b, s.at.sink); b.write('udp://127.0.0.1:20557?mime_type=video/H264', s.at.sink, 'latin1');
    Buffer.from(s.at.callPatched, 'hex').copy(b, s.at.call);
    b.writeUInt32LE(138, s.at.mm); b.writeUInt32LE(1088, s.at.px);
    writeMapUrl(b, s.at);
    var loc = locator.locate(b);
    ok('patched build: the same sites', loc.ok && json(sites(loc)) === json(expected(s.at)), json(loc));
    ok('patched build: the same map URL sites, both patched, the lea at the URL', json(mapSites(loc)) === json(mapExpected(s.at)) &&
        mapIs(loc.mapurl) === 'current/current' && locator.MAP_URL === 'maps:/car/instrumentcluster/map' &&
        b.toString('latin1', loc.mapurl.url, loc.mapurl.url + locator.MAP_URL.length + 1) === locator.MAP_URL + '\0' &&
        b.toString('latin1', s.at.spare, s.at.spare + 55) === 'Head-Unit: no AltDisp.\0' + locator.MAP_URL + '\0', json(loc.mapurl));
    writeShowUi(b, s.at);
    loc = locator.locate(b);
    var leaNext = s.at.showCall + 10, toUrl = (loc.showui.url - 0x2800 + 0x1234000) - (leaNext + 0x7a000);
    ok('patched build: the same ShowUI URL sites, both patched, the lea at the URL', json(showSites(loc)) === json(showExpected(s.at)) &&
        showIs(loc.showui) === 'patched/patched' && locator.SHOWUI_URL === 'maps:/car/instrumentcluster?showETA=yes' &&
        b.toString('latin1', s.at.showStr, s.at.showStr + 64) === 'mCinemoCarPlay->ShowUI(\0' + locator.SHOWUI_URL + '\0' &&
        b.toString('hex', s.at.showCall, s.at.showCall + 6) === '4c89e7488d35' && b[s.at.showCall + 10] === 0x90 &&
        b.readInt32LE(s.at.showCall + 6) === toUrl, json(loc.showui));
    ['str', 'call'].forEach(function (w) {
        var h = Buffer.from(s.buf);
        writeShowUi(h, s.at, w);
        var m = locator.locate(h).showui;
        ok('only the ShowUI ' + (w === 'str' ? 'log text' : 'call site') + ' patched: found, one site patched', m.ok &&
            showIs(m) === (w === 'str' ? 'patched/stock' : 'stock/patched'), json(m));
    });
    for (var k = 1; k < 11; k++) {
        var hc = Buffer.from(s.buf), hs = Buffer.from(s.buf);
        writeShowUi(hc, s.at, 'call', k);
        var m1 = locator.locate(hc).showui;
        writeShowUi(hs, s.at);
        s.buf.copy(hs, s.at.showCall, s.at.showCall, s.at.showCall + k);
        var m2 = locator.locate(hs).showui;
        ok('the ShowUI call site cut short at byte ' + k + ', either way: found, mixed', m1.ok && m2.ok && showIs(m1) === 'stock/mixed' && showIs(m2) === 'patched/mixed',
            json([m1, m2]));
    }
    [24, 40, 63].forEach(function (k) {
        var h = Buffer.from(s.buf), t = Buffer.from(s.buf);
        writeShowUi(h, s.at, 'str'); s.buf.copy(h, s.at.showStr + k, s.at.showStr + k, s.at.showStr + 64);
        writeShowUi(t, s.at, 'str'); s.buf.copy(t, s.at.showStr, s.at.showStr, s.at.showStr + k);
        var m1 = locator.locate(h).showui, m2 = locator.locate(t).showui;
        ok('the ShowUI log text cut short at byte ' + k + ', either way: found, mixed', m1.ok && m2.ok && showIs(m1) === 'mixed/stock' && showIs(m2) === 'mixed/stock',
            json([m1, m2]));
    });
    ['slot', 'lea'].forEach(function (w) {
        ['current', 'eta'].forEach(function (f) {
            var h = Buffer.from(s.buf);
            writeMapUrl(h, s.at, w, f);
            var m = locator.locate(h).mapurl;
            ok('only the ' + (w === 'slot' ? 'spare string' : 'lea') + ' patched (' + f + '): found, one site patched', m.ok &&
                mapIs(m) === (w === 'slot' ? f + '/stock' : 'stock/' + f), json(m));
        });
    });
    var o = Buffer.from(s.buf);
    writeMapUrl(o, s.at, null, 'eta');
    var om = locator.locate(o).mapurl;
    ok('the URL with ETA: the same map URL sites, both eta, the lea at that URL', json(mapSites(locator.locate(o))) === json(mapExpected(s.at)) &&
        mapIs(om) === 'eta/eta' && o.toString('latin1', s.at.spare, s.at.spare + 55) === 'No AltDisp\0maps:/car/instrumentcluster/map?showETA=yes\0',
        json(om));
    [['eta', 'current'], ['current', 'eta']].forEach(function (f) {
        var h = Buffer.from(s.buf);
        writeMapUrl(h, s.at, 'slot', f[0]); writeMapUrl(h, s.at, 'lea', f[1]);
        var m = locator.locate(h).mapurl;
        ok('the ' + f[0] + ' spare string, the ' + f[1] + ' lea: found, the forms differ', m.ok && mapIs(m) === f[0] + '/' + f[1], json(m));
    });
    b.writeUInt32LE(s.at.mid, s.at.slot);
    ok('slot 7 set to slot 10\'s value: found', locator.locate(b).variant.ok);
})();

/* A signature found twice is ambiguous. */
[['two sink URL slots', { twoSinks: true }, 'sink: URL slot found 2 times'],
 ['a second converter switch outside codingToInternal', { twoConverters: true }, 'variant: converter switch also outside codingToInternal']].forEach(function (t) {
    var loc = locator.locate(synthetic.build(t[1]).buf);
    ok(t[0] + ': refused as ambiguous, the other edits found', !loc.ok && json(reasons(loc)) === json([t[2]]), json(reasons(loc)));
});

/* Each map URL check broken: that edit refused with what is wrong, the
 * other four found. */
[
    ['the log string twice', { twoSpares: true }, 'map URL: log string found 2 times'],
    ['the log string read twice', { spareReadTwice: true }, 'map URL: log string loaded 2 times (want 1)'],
    ['a data pointer into the log string', { pointSpare: true }, 'map URL: a data pointer into the log string'],
    ['the gate not variant <= 1', { gateCmp: 2 }, 'map URL: log not on the alternate-display gate\'s false branch'],
    ['the log block fallen into', { logFallsIn: true }, 'map URL: log block entered by falling through'],
    ['the log block jumped to from elsewhere', { logJumpedTo: true }, 'map URL: log block entered from elsewhere'],
    ['the initial URL built twice', { urlBuiltTwice: true }, 'map URL: initial URL built 2 times'],
    ['the initial URL built from another string', { urlFrom: 's.maps' }, 'map URL: initial URL built from neither "" nor the URL'],
    ['the display builder loads no string global', { noUrlGlobal: true }, 'map URL: the cluster display builder loads 0 string globals (want 1)'],
    ['the initial URL global without a destructor', { noUrlDtor: true }, 'map URL: initial URL global not registered for destruction'],
    ['the initial URL built by a function no string global is built by', { urlCtorOther: true }, 'map URL: initial URL global not built like the other string globals'],
    ['a dynamic relocation over the initial URL\'s lea', { relocUrl: true }, 'map URL: a dynamic relocation over the edit'],
].forEach(function (t) {
    var loc = locator.locate(synthetic.build(t[1]).buf);
    ok('map URL (' + t[0] + '): ' + t[2], loc.ok && !loc.mapurl.ok && loc.mapurl.reason === t[2] && loc.showui.ok, json([reasons(loc), loc.mapurl]));
});

/* Each ShowUI URL check broken: that edit refused with what is wrong, the
 * other edits found. */
[
    ['ShowUI\'s URL read from another global', { showExpr: 'mCinemoCarPlay->ShowUI( mShowUiUrl.c_str(), ::carplay::CarPlayConstantsRepository::alternateDisplayUuid().c_str())' },
        'ShowUI URL: ShowUI not called with the alternate display URL'],
    ['the build adds carplay.conf\'s options itself', { setShowUi: true }, 'ShowUI URL: not applicable (the build adds carplay.conf\'s SHOW_UI_OPTIONS to it)'],
    ['the log text loaded twice', { showReadTwice: true }, 'ShowUI URL: log text loaded 2 times (want once, in requestStream)'],
    ['a data pointer into the log text', { pointShow: true }, 'ShowUI URL: a data pointer into the log text'],
    ['a dynamic relocation over the call site', { relocShow: true }, 'ShowUI URL: a dynamic relocation over the edit'],
    ['two getters of the URL global', { twoAltGetters: true }, 'ShowUI URL: URL getter found 2 times'],
    ['the getter calls a function', { altGetterCalls: true }, 'ShowUI URL: URL getter not found'],
    ['the URL global built twice', { altBuiltTwice: true }, 'ShowUI URL: the alternate display URL global built 2 times (want 1)'],
    ['the URL global built alone', { altAlone: true }, 'ShowUI URL: the alternate display URL global not built like the other string globals'],
    ['rax read before the call', { showRaxRead: true }, 'ShowUI URL: ShowUI arguments changed before the call'],
    ['rsi set again before the call', { showRsiSet: true }, 'ShowUI URL: ShowUI arguments changed before the call'],
    ['the result not checked', { showUnchecked: true }, 'ShowUI URL: ShowUI result not checked with its log text'],
    ['a jump into the call site', { showJumpedInto: true }, 'ShowUI URL: a branch into the call site'],
].forEach(function (t) {
    var loc = locator.locate(synthetic.build(t[1]).buf);
    ok('ShowUI URL (' + t[0] + '): ' + t[2], loc.ok && loc.mapurl.ok && !loc.showui.ok && loc.showui.reason === t[2] && !!loc.showui.na === /not applicable/.test(t[2]),
        json([reasons(loc), loc.showui]));
});
(function () {
    var s = synthetic.build({}), b = Buffer.from(s.buf);
    b[s.at.showCall + 9] = 0x3e;   /* mov rdi,[rsi] in place of mov rsi,[rax] */
    var loc = locator.locate(b);
    ok('ShowUI URL (another instruction at the call site): call site not found', loc.ok && loc.showui.reason === 'ShowUI URL: call site not found', json(loc.showui));
})();
(function () {
    var s = synthetic.build({}), b = Buffer.from(s.buf);
    b.write('Head-Unit does not support Alternate Displays Feature.', s.at.spare, 'latin1');
    var loc = locator.locate(b);
    ok('map URL (another log text): log string not found', loc.ok && loc.mapurl.reason === 'map URL: log string not found', json(loc.mapurl));
    b = Buffer.from(s.buf); b[s.at.getter2c + 3] = 0x2a;
    loc = locator.locate(b);
    ok('map URL (no cluster display builder): refused with the resolution edit', loc.mapurl.reason === 'map URL: no cluster display builder (resolution: geometry getters not found)', json(loc.mapurl));
})();

/* A damaged site is refused with what is wrong. */
[
    ['the IC_HIGH handler stores OTHER', function (b, at) { b.writeUInt32LE(2, at.highHandler + 2); }, 'variant: slot 9 is not IC_HIGH'],
    ['slot 7 points at the NOT_ACTIVE handler', function (b, at) { b.writeUInt32LE(b.readUInt32LE(at.table), at.slot); }, 'variant: slot 7 not OTHER/IC_HIGH/IC_MID'],
    ['another sink URL', function (b, at) { b.write('ws://', at.sink, 'latin1'); }, 'sink: URL slot not found'],
    ['no AVAILABLE argument', function (b, at) { b[at.call - 12] = 2; }, 'self-start: call has no AVAILABLE argument'],
    ['onSuggestUi calls something else', function (b, at) { b.writeInt32LE(b.readInt32LE(at.call + 1) + 0x40, at.call + 1); }, 'self-start: onSuggestUi call not found'],
    ['no ForceKeyframe check', function (b) { var i = b.indexOf('ForceKeyframe'); b.write('ForceKeyFrame', i, 'latin1'); }, 'self-start: ForceKeyframe string not found'],
    ['a geometry store broken', function (b, at) { b[at.px + 8] = 0x90; }, 'resolution: 1 geometry builders (want 2)'],
    ['requestStream only reached through onSuggestUi', function (b, at) { b.fill(0x90, at.cmdCall, at.cmdCall + 5); }, 'self-start: requestStream not called directly'],
    ['a getter reads another field', function (b, at) { b[at.getter2c + 3] = 0x2a; }, 'resolution: geometry getters not found'],
].forEach(function (t) {
    var s = synthetic.build({}), b = Buffer.from(s.buf);
    t[1](b, s.at);
    var loc = locator.locate(b);
    ok('damaged (' + t[0] + '): ' + t[2], json(reasons(loc)) === json([t[2]]), json(reasons(loc)));
});
(function () {
    var loc = locator.locate(synthetic.build({ noEhFrame: true }).buf);
    ok('no function table: variant, self-start and resolution say so',
        json(reasons(loc)) === json(['variant: no function table', 'self-start: no function table', 'resolution: no function table']), json(reasons(loc)));
    loc = locator.locate(synthetic.build({ relocSink: true }).buf);
    ok('a dynamic relocation over the sink slot: refused', json(reasons(loc)) === json(['sink: a dynamic relocation over the edit']), json(reasons(loc)));
    var rel = synthetic.build({ relocSink: true });
    rel.buf.writeUInt32LE(17, rel.at.dyn);   /* DT_REL in place of DT_RELA */
    loc = locator.locate(rel.buf);
    ok('relocations it cannot read: every edit refused', json(reasons(loc)) ===
        json(['variant: relocations not readable', 'sink: relocations not readable', 'self-start: relocations not readable', 'resolution: relocations not readable']), json(reasons(loc)));
    rel = synthetic.build({ relocSink: true });
    for (var ph = 64; rel.buf.readUInt32LE(ph) !== 2; ph += 56);
    rel.buf.writeUInt32LE(rel.buf.length - 8, ph + 8);   /* PT_DYNAMIC running past the end of the file */
    loc = locator.locate(rel.buf);
    ok('a dynamic segment outside the file: every edit refused, no throw', json(reasons(loc)) ===
        json(['variant: relocations not readable', 'sink: relocations not readable', 'self-start: relocations not readable', 'resolution: relocations not readable']), json(reasons(loc)));
    loc = locator.locate(Buffer.from('#!/bin/sh\nexec carplay "$@"\n'));
    ok('not an ELF', loc.elf === false && loc.reason === 'not an ELF file' && !loc.ok, json(loc));
})();

/* The patcher on a build outside the proven list. */
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-locate-'));
try {
    var tgt = path.join(dir, 'carplay'), orig = shifted.buf, at = shifted.at, r;
    fs.writeFileSync(tgt, orig, { mode: 0o755 });
    function hx(n) { return '0x' + n.toString(16); }

    r = run(['status', '--target', tgt]);
    ok('status: pristine by its stock sites, every edit ORIGINAL', /known:\s+yes, pristine build [0-9a-f]{40}/.test(r.out) &&
        /variant:\s+ORIGINAL/.test(r.out) && /sink:\s+ORIGINAL/.test(r.out) && /selfstart:\s+ORIGINAL/.test(r.out) &&
        /res:\s+ORIGINAL \(IC_HIGH advertises 1600x800\)/.test(r.out), r.out);
    r = run(['probe', tgt]);
    ok('probe: the sites, not proven, patchable', r.code === 0 && /proven:\s+no/.test(r.out) && /patchable:\s+yes/.test(r.out) &&
        r.out.indexOf('slot ' + hx(at.slot) + ' (table ' + hx(at.table) + ', 12 slots)') >= 0 && r.out.indexOf('slot ' + hx(at.sink) + ' (59 bytes)') >= 0 &&
        r.out.indexOf('call ' + hx(at.call) + ' in onSuggestUi ' + hx(at.onSuggestUi)) >= 0 &&
        r.out.indexOf('immediates ' + [at.mm, at.px, at.safe1, at.safe2].map(hx).join(' ')) >= 0 &&
        r.out.indexOf('build-id:  ' + at.buildId) >= 0, r.out);

    r = run(['apply', '--target', tgt, '--panel', 'high', '--sink', 'udp://127.0.0.1:20557?mime_type=video/H264', '--unproven', '--yes']);
    var b = fs.readFileSync(tgt), want = Buffer.from(orig);
    writeMapUrl(want, at); writeShowUi(want, at);
    ok('an earlier release\'s patch, high: every edit written where the locator finds its site', r.code === 0 &&
        b.readUInt32LE(at.slot) === at.high && b.toString('hex', at.call, at.call + 5) === at.callPatched && b.toString('latin1', at.sink, at.sink + 9) === 'udp://127' &&
        b.readUInt32LE(at.mm) === 138 && b.readUInt32LE(at.px) === 1088 &&
        b.slice(at.spare, at.spare + 55).equals(want.slice(at.spare, at.spare + 55)) && b.slice(at.urlLea, at.urlLea + 7).equals(want.slice(at.urlLea, at.urlLea + 7)) &&
        b.slice(at.showStr, at.showStr + 64).equals(want.slice(at.showStr, at.showStr + 64)) && b.slice(at.showCall, at.showCall + 11).equals(want.slice(at.showCall, at.showCall + 11)), r.out);
    r = run(['status', '--target', tgt]);
    ok('status: the map URL and the ShowUI URL PATCHED', /^mapurl:\s+PATCHED \(the phone streams the cluster map from connect: maps:\/car\/instrumentcluster\/map\)$/m.test(r.out) &&
        /^showui:\s+PATCHED \(ShowUI asks the phone for maps:\/car\/instrumentcluster\?showETA=yes, with the arrival-time card\)$/m.test(r.out), r.out);
    r = run(['verify', '--target', tgt]);
    ok('verify: enabled', r.code === 0 && /OK: variant IC_HIGH, sink udp:\/\/127\.0\.0\.1:20557\?mime_type=video\/H264, self-start on, res 1088x480, map URL on, ShowUI URL with ETA$/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('revert: byte-exact original', r.code === 0 && fs.readFileSync(tgt).equals(orig), r.out);

    /* One map URL site written and not the other: unrecognised; revert
     * writes the whole backup. */
    run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
    b = fs.readFileSync(tgt);
    orig.copy(b, at.spare, at.spare, at.spare + 55);
    fs.writeFileSync(tgt, b);
    r = run(['status', '--target', tgt]);
    ok('partly patched map URL: not known, restorable', /^mapurl:\s+UNKNOWN \(map URL: partly patched\)$/m.test(r.out) &&
        /known:\s+NO — map URL: partly patched/.test(r.out) && /^restorable:\s+yes$/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('partly patched map URL: revert writes the whole backup', r.code === 0 && fs.readFileSync(tgt).equals(orig), r.out);

    /* The ShowUI URL edit with one site written, or one cut short: unrecognised;
     * revert writes the whole backup. */
    run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
    var full = fs.readFileSync(tgt);
    [['the log text stock', function (x) { orig.copy(x, at.showStr, at.showStr, at.showStr + 64); }],
     ['the call site stock', function (x) { orig.copy(x, at.showCall, at.showCall, at.showCall + 11); }],
     ['the call site cut short', function (x) { orig.copy(x, at.showCall + 4, at.showCall + 4, at.showCall + 11); }],
     ['the log text cut short', function (x) { orig.copy(x, at.showStr + 30, at.showStr + 30, at.showStr + 64); }]].forEach(function (t) {
        b = Buffer.from(full); t[1](b);
        fs.writeFileSync(tgt, b);
        r = run(['status', '--target', tgt]);
        ok('ShowUI URL, ' + t[0] + ': not known, restorable', /^showui:\s+UNKNOWN \(ShowUI URL: partly patched\)$/m.test(r.out) &&
            /known:\s+NO — ShowUI URL: partly patched/.test(r.out) && /^restorable:\s+yes$/m.test(r.out), r.out);
        r = run(['revert', '--target', tgt, '--yes']);
        ok('ShowUI URL, ' + t[0] + ': revert writes the whole backup', r.code === 0 && fs.readFileSync(tgt).equals(orig), r.out);
        fs.writeFileSync(tgt, full);
    });
    r = run(['revert', '--target', tgt, '--yes']);

    /* The patch 0.10.2-0.10.3 wrote (the initial URL with ETA, no ShowUI
     * URL edit), and the one 0.9.11-0.10.1 wrote (this initial URL, no
     * ShowUI URL edit): known, status says so, verify passes; revert of
     * either restores the original. */
    run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
    var cur = fs.readFileSync(tgt), etaPatch = Buffer.from(cur), mapPatch = Buffer.from(cur);
    writeMapUrl(etaPatch, at, null, 'eta'); orig.copy(etaPatch, at.showStr, at.showStr, at.showStr + 64); orig.copy(etaPatch, at.showCall, at.showCall, at.showCall + 11);
    orig.copy(mapPatch, at.showStr, at.showStr, at.showStr + 64); orig.copy(mapPatch, at.showCall, at.showCall, at.showCall + 11);
    fs.writeFileSync(tgt, etaPatch);
    r = run(['status', '--target', tgt]);
    ok('0.10.2\'s patch: known, restorable, PATCHED WITH ETA, ShowUI URL ORIGINAL', /known:\s+yes, modified build/.test(r.out) && /^restorable:\s+yes$/m.test(r.out) &&
        /^mapurl:\s+PATCHED WITH ETA \(the phone streams the cluster map from connect: maps:\/car\/instrumentcluster\/map\?showETA=yes; the patch writes maps:\/car\/instrumentcluster\/map\)$/m.test(r.out) &&
        /^showui:\s+ORIGINAL \(ShowUI asks the phone for maps:\/car\/instrumentcluster\)$/m.test(r.out), r.out);
    r = run(['verify', '--target', tgt]);
    ok('0.10.2\'s patch: verify passes, map URL on with ETA, ShowUI URL stock', r.code === 0 && /map URL on with ETA, ShowUI URL stock$/m.test(r.out), r.out);
    [['0.10.2\'s patch', etaPatch, true], ['0.9.11\'s patch', mapPatch, false]].forEach(function (t) {
        fs.writeFileSync(tgt, t[1]);
        r = run(['revert', '--target', tgt, '--yes']);
        ok(t[0] + ': revert restores the original byte-exact', r.code === 0 && fs.readFileSync(tgt).equals(orig), r.out);
        fs.writeFileSync(tgt, cur);
    });
    /* The two sites holding different forms: unrecognised, like a write cut
     * short; revert writes the whole backup. */
    [['eta', 'current'], ['current', 'eta']].forEach(function (f) {
        var mixed = Buffer.from(cur);
        writeMapUrl(mixed, at, 'slot', f[0]); writeMapUrl(mixed, at, 'lea', f[1]);
        fs.writeFileSync(tgt, mixed);
        r = run(['status', '--target', tgt]);
        ok('the ' + f[0] + ' spare string with the ' + f[1] + ' lea: not known, restorable', /^mapurl:\s+UNKNOWN \(map URL: partly patched\)$/m.test(r.out) &&
            /^restorable:\s+yes$/m.test(r.out), r.out);
        r = run(['revert', '--target', tgt, '--yes']);
        ok('the ' + f[0] + ' spare string with the ' + f[1] + ' lea: revert writes the whole backup', r.code === 0 && fs.readFileSync(tgt).equals(orig), r.out);
    });

    /* The map URL edit written, then the target changed so the locator no
     * longer finds it there (its gate byte): revert still restores its
     * sites from the backup, and keeps that change. */
    run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
    b = fs.readFileSync(tgt);
    b[at.gateCmp + 2] = 2;
    fs.writeFileSync(tgt, b);
    r = run(['status', '--target', tgt]);
    ok('map URL no longer found in the target: NOT APPLIED, restorable', /^mapurl:\s+NOT APPLIED/m.test(r.out) && /^restorable:\s+yes$/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    var gated = Buffer.from(orig); gated[at.gateCmp + 2] = 2;
    ok('map URL no longer found in the target: revert restores its sites, the other change kept', r.code === 0 && fs.readFileSync(tgt).equals(gated), r.out);
    /* Likewise the ShowUI URL edit (its log text's check call changed). */
    fs.writeFileSync(tgt, orig);
    run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
    b = fs.readFileSync(tgt);
    var movEdi = b.indexOf(Buffer.from('89c7', 'hex'), at.showCall + 11);
    b[movEdi + 1] = 0xc6;
    fs.writeFileSync(tgt, b);
    r = run(['status', '--target', tgt]);
    ok('ShowUI URL no longer found in the target: NOT APPLIED, restorable', /^showui:\s+NOT APPLIED/m.test(r.out) && /^restorable:\s+yes$/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    gated = Buffer.from(orig); gated[movEdi + 1] = 0xc6;
    ok('ShowUI URL no longer found in the target: revert restores its sites, the other change kept', r.code === 0 && fs.readFileSync(tgt).equals(gated), r.out);
    fs.writeFileSync(tgt, orig);
    [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });

    /* A build where the map URL edit is not found: an earlier release's patch
     * holds the other four, which verify and revert as without it. */
    var nmBuild = synthetic.build({ gateCmp: 2 }), noMap = nmBuild.buf, nm = nmBuild.at;
    fs.writeFileSync(tgt, noMap);
    [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    r = run(['status', '--target', tgt]);
    ok('map URL not found: NOT APPLIED with the reason, the build pristine', /^mapurl:\s+NOT APPLIED \(map URL: log not on the alternate-display gate's false branch\)$/m.test(r.out) &&
        /known:\s+yes, pristine build/.test(r.out), r.out);
    r = run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
    b = fs.readFileSync(tgt);
    ok('map URL not found: an earlier release\'s patch holds the other edits, not it', r.code === 0 &&
        b.readUInt32LE(nm.slot) === nm.high && b.toString('hex', nm.call, nm.call + 5) === nm.callPatched, r.out);
    var dd = []; for (var i = 0; i < b.length; i++) if (b[i] !== noMap[i]) dd.push(i);
    ok('map URL not found: the diff stays out of the log string and the lea', dd.length > 0 && dd.every(function (x) {
        return !(x >= nm.spare && x < nm.spare + 55) && !(x >= nm.urlLea && x < nm.urlLea + 7); }));
    r = run(['verify', '--target', tgt]);
    ok('map URL not found: verify passes, map URL n/a', r.code === 0 && /map URL n\/a/.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('map URL not found: revert restores it byte-exact', r.code === 0 && fs.readFileSync(tgt).equals(noMap), r.out);
    fs.writeFileSync(tgt, orig);
    [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });

    /* A build where the ShowUI URL edit is not found, and one that adds
     * carplay.conf's options itself: an earlier release's patch holds the
     * other edits, which verify and revert as without it. */
    [['not found', { showUnchecked: true }, 'ShowUI URL: ShowUI result not checked with its log text'],
     ['not applicable', { setShowUi: true }, 'ShowUI URL: not applicable (the build adds carplay.conf\'s SHOW_UI_OPTIONS to it)']].forEach(function (t) {
        var nsBuild = synthetic.build(t[1]), noShow = nsBuild.buf, ns = nsBuild.at;
        fs.writeFileSync(tgt, noShow);
        [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
        r = run(['status', '--target', tgt]);
        ok('ShowUI URL ' + t[0] + ': NOT APPLIED with the reason, the build pristine', r.out.indexOf('showui:    NOT APPLIED (' + t[2] + ')') >= 0 &&
            /known:\s+yes, pristine build/.test(r.out), r.out);
        r = run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
        b = fs.readFileSync(tgt);
        ok('ShowUI URL ' + t[0] + ': an earlier release\'s patch holds the other edits, not it', r.code === 0 &&
            b.readUInt32LE(ns.slot) === ns.high && b.slice(ns.showStr, ns.showStr + 64).equals(noShow.slice(ns.showStr, ns.showStr + 64)) &&
            b.slice(ns.showCall, ns.showCall + 11).equals(noShow.slice(ns.showCall, ns.showCall + 11)), r.out);
        r = run(['verify', '--target', tgt]);
        ok('ShowUI URL ' + t[0] + ': verify passes, ShowUI URL n/a', r.code === 0 && /map URL on, ShowUI URL n\/a$/m.test(r.out), r.out);
        r = run(['revert', '--target', tgt, '--yes']);
        ok('ShowUI URL ' + t[0] + ': revert restores it byte-exact', r.code === 0 && fs.readFileSync(tgt).equals(noShow), r.out);
    });
    fs.writeFileSync(tgt, orig);
    [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });

    /* revert gives the target the original's mode recorded with the backup,
     * whatever mode the target has: carplay runs as a non-root user, which
     * needs group and other execute. */
    run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
    fs.chmodSync(tgt, 0o700);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('revert: restores the recorded 0755, not the target\'s 0700',
        r.code === 0 && fs.readFileSync(tgt).equals(orig) && (fs.statSync(tgt).mode & 0o777) === 0o755,
        r.out + ' mode=' + (fs.statSync(tgt).mode & 0o777).toString(8));

    /* A build without a GNU build-id: the same build is the same size and at
     * most a few hundred bytes apart from the backup. */
    var noId = Buffer.from(orig);
    noId.writeUInt32LE(0, 0x208);   /* the build-id note's type */
    [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    fs.writeFileSync(tgt, noId);
    r = run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
    ok('no build-id: an earlier release\'s patch with its backup and the backup\'s record', r.code === 0 && fs.existsSync(tgt + '.woc-orig') &&
        fs.existsSync(tgt + '.woc-orig.json'), r.out);
    var noIdPatched = fs.readFileSync(tgt), mangled = Buffer.from(noIdPatched);
    mangled[at.highHandler] = 0x90;   /* a site the locator now refuses */
    fs.writeFileSync(tgt, mangled);
    r = run(['status', '--target', tgt]);
    ok('no build-id: a patch the locator refuses is restorable', /known:\s+NO/.test(r.out) && /^restorable: yes$/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('no build-id: revert writes the original whole', r.code === 0 && fs.readFileSync(tgt).equals(noId), r.out);
    fs.writeFileSync(tgt + '.woc-orig.tmp', 'cut short');
    fs.writeFileSync(tgt + '.woc-orig.json.tmp', '{"sha');
    r = run(['revert', '--target', tgt, '--yes', '--drop-backup']);
    ok('a removal drops the backup, its record and any temporary file', r.code === 0 && !fs.existsSync(tgt + '.woc-orig') &&
        !fs.existsSync(tgt + '.woc-orig.json') && !fs.existsSync(tgt + '.woc-orig.tmp') && !fs.existsSync(tgt + '.woc-orig.json.tmp'), r.out);
    run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
    var far = Buffer.from(noId);
    for (var k = 0; k < 600; k++) far[0x300 + k] ^= 0xff;
    fs.writeFileSync(tgt, far);
    r = run(['status', '--target', tgt]);
    ok('no build-id: a binary hundreds of bytes away is another build', /^restorable: no \(another build: no build-id, and more than 474 bytes differ\)$/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('no build-id: revert refuses it without --force, saying why', r.code !== 0 && /another build than the backup \(no build-id, and more than 474 bytes differ\)/.test(r.out) &&
        fs.readFileSync(tgt).equals(far), r.out);

    /* A backup an older release left without its record, cut short: never
     * written, also with --force. */
    fs.writeFileSync(tgt, noIdPatched);
    fs.writeFileSync(tgt + '.woc-orig', noId.slice(0, noId.length - 4096));
    fs.unlinkSync(tgt + '.woc-orig.json');
    r = run(['revert', '--target', tgt, '--yes', '--force']);
    ok('a short backup with no record: revert --force refuses, no write', r.code !== 0 && /no record of the original/.test(r.out) &&
        fs.readFileSync(tgt).equals(noIdPatched), r.out);

    /* A backup whose build-id note cannot be read: status says why and goes on. */
    var badNote = Buffer.from(orig);
    badNote.writeUInt32LE(0x7ffffffe, 0x200);   /* the note's name size */
    fs.writeFileSync(tgt + '.woc-orig', badNote);
    r = run(['status', '--target', tgt]);
    ok('a backup with a malformed note: not restorable, with the reason, status complete', r.code === 0 && /^restorable: no \(.+\)$/m.test(r.out) &&
        /^backup: /m.test(r.out), r.out);
    [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });

    var amb = synthetic.build({ twoSinks: true }).buf;
    fs.writeFileSync(tgt, amb);
    r = run(['probe', tgt]);
    ok('probe of an ambiguous build: not patchable, with the reason', /patchable:\s+no — sink: URL slot found 2 times/.test(r.out), r.out);
    r = run(['status', '--target', tgt]);
    ok('status of an ambiguous build: known NO with the reason', /known:\s+NO — sink: URL slot found 2 times/.test(r.out), r.out);
    r = run(['plan', '--target', tgt, '--panel', 'high', '--unproven', '--out', path.join(dir, 'amb.plan')]);
    ok('plan refuses it with the reason, no plan written', r.code !== 0 && /sink: URL slot found 2 times/.test(r.out) && !fs.existsSync(path.join(dir, 'amb.plan')) &&
        fs.readFileSync(tgt).equals(amb), r.out);

    /* A file with carplay 21.27.4's build-id and every site stock, but not
     * that build's shipped file: on the proven list, so a plan needs the
     * shipped file, --unproven or not. */
    var b2127 = Buffer.from(orig);
    Buffer.from('389c1d0536f8cc9283c156410f2f2634a9f952c0', 'hex').copy(b2127, b2127.indexOf(Buffer.from(at.buildId, 'hex')));
    fs.writeFileSync(tgt, b2127);
    r = run(['probe', tgt]);
    ok('carplay 21.27.4 build-id: probe reads it proven and patchable', r.code === 0 && /proven:\s+yes, carplay 21\.27\.4/.test(r.out) &&
        /patchable:\s+yes/.test(r.out), r.out);
    r = run(['status', '--target', tgt]);
    ok('carplay 21.27.4 build-id: status proven, a modified build, the map URL found by structure', /^proven:\s+yes$/m.test(r.out) && /known:\s+yes, modified build/.test(r.out) &&
        /^mapurl:\s+ORIGINAL/m.test(r.out), r.out);
    [[], ['--unproven']].forEach(function (extra) {
        var out = path.join(dir, '2127.plan');
        r = run(['plan', '--target', tgt, '--panel', 'high', '--out', out].concat(extra));
        ok('carplay 21.27.4 build-id, not its shipped file: plan ' + (extra[0] ? extra[0] + ' ' : '') + 'refuses, no plan, no write', r.code !== 0 &&
            /in memory needs the pristine build on disk: sha256 fb5d6b179ad4f62a968697d21e84dbb80adc1ad8e618a6f02c6a9a0467aca1ac, got /.test(r.out) &&
            fs.readFileSync(tgt).equals(b2127) && !fs.existsSync(out), r.out);
    });

} finally {
    cp.execFileSync('rm', ['-rf', dir]);
}

/* carplay 22.28.3's stock bytes of the map URL sites, for a revert without
 * the backup: the log string at 0x257838 and the lea rsi at 0x7b533 loading
 * "" (0x294793; file offset is the address there); and of the ShowUI URL
 * sites: the log text at 0x2908a0 and, at 0x18188a, the call to the URL
 * getter at 0x1fe5e0, mov rdi,r12, mov rsi,[rax]. */
(function () {
    var p = require('../carplay_patch.js').PROVEN['5de62156575d737391ea42254e778a97dbbb51f8'];
    var lea = Buffer.from('488d3500000000', 'hex'); lea.writeInt32LE(0x294793 - (0x7b533 + 7), 3);
    var call = Buffer.from('e8000000004c89e7488b30', 'hex'); call.writeInt32LE(0x1fe5e0 - (0x18188a + 5), 1);
    ok('carplay 22.28.3: the map URL sites\' stock bytes on its stock list', p.stock.some(function (x) {
        return x[0] === 0x257838 && x[1] === Buffer.from('Head-Unit does not support Alternate Displays feature.\0', 'latin1').toString('hex'); }) &&
        p.stock.some(function (x) { return x[0] === 0x7b533 && x[1] === lea.toString('hex'); }), json(p.stock));
    ok('carplay 22.28.3: the ShowUI URL sites\' stock bytes on its stock list', p.stock.some(function (x) {
        return x[0] === 0x2908a0 && x[1] === Buffer.from('mCinemoCarPlay->ShowUI( ::carplay::CarPlayConstantsRepository::a', 'latin1').toString('hex'); }) &&
        p.stock.some(function (x) { return x[0] === 0x18188a && x[1] === call.toString('hex'); }), json(p.stock));
})();

/* carplay 21.27.4's stock bytes agree with its probe: the stock sink in the
 * sink slot, the call to setStreamStatus (0x1800d0) at 0x1802dc, and IC_HIGH
 * 1920x900 in the pixel-size immediate. */
(function () {
    var p = require('../carplay_patch.js').PROVEN['389c1d0536f8cc9283c156410f2f2634a9f952c0'];
    var call = Buffer.alloc(5), px = Buffer.alloc(8);
    call[0] = 0xe8; call.writeInt32LE(0x1800d0 - (0x1802dc + 5), 1);
    px.writeUInt32LE(1920, 0); px.writeUInt32LE(900, 4);
    ok('carplay 21.27.4: its stock bytes as its probe reads them', !!p && json(p.stock) ===
        json([[0x29bb10, Buffer.from(locator.SINK_STOCK, 'latin1').toString('hex')], [0x1802dc, call.toString('hex')], [0x20b484, px.toString('hex')]]), json(p));
})();

/* The reference build: the documented offsets. */
var SRC = process.env.CARPLAY_BIN || '';
if (fs.existsSync(SRC)) {
    var loc = locator.locate(fs.readFileSync(SRC));
    ok('reference build: the documented sites', loc.ok && loc.variant.table === 0x2ba4d4 && loc.variant.slot === 0x2ba4f0 &&
        loc.variant.original === 0xfff7f2ec && loc.variant.high === 0xfff7f2bc && loc.variant.mid === 0xfff7f30c &&
        loc.sink.offset === 0x2a20b0 && loc.sink.len === 59 &&
        loc.selfstart.offset === 0x18176c && loc.selfstart.original === 'e8effdffff' && loc.selfstart.patched === 'e89f000000' &&
        loc.selfstart.setStreamStatus === 0x181560 && loc.selfstart.requestStream === 0x181810 && loc.selfstart.onSuggestUi === 0x1816f0 &&
        loc.res.builder === 0x20ca30 && json([loc.res.mm, loc.res.px, loc.res.safe1, loc.res.safe2]) === json([0x20ca32, 0x20ca54, 0x20ca66, 0x20ca74]), json(loc));
    ok('reference build: the documented map URL sites', loc.mapurl.ok && loc.mapurl.slot === 0x257838 && loc.mapurl.len === 55 && loc.mapurl.lea === 0x7b533 &&
        loc.mapurl.url === 0x25784f && loc.mapurl.builder === 0x2078b0 && loc.mapurl.log === 0x88aa2 && loc.mapurl.leaBytes === '488d3515c31d00' &&
        json(loc.mapurl.forms.map(function (f) { return [f.name, f.leaBytes]; })) === json([['current', '488d3515c31d00'], ['eta', '488d3509c31d00']]) &&
        mapIs(loc.mapurl) === 'stock/stock', json(loc.mapurl));
    /* the URL at 0x2908b8: lea rsi at 0x18188d, next 0x181894 */
    ok('reference build: the documented ShowUI URL sites', loc.showui.ok && loc.showui.str === 0x2908a0 && loc.showui.len === 64 && loc.showui.call === 0x18188a &&
        loc.showui.callLen === 11 && loc.showui.url === 0x2908b8 && loc.showui.getter === 0x1fe5e0 && loc.showui.requestStream === 0x181810 &&
        loc.showui.callStock === 'e851cd07004c89e7488b30' && loc.showui.callBytes === '4c89e7488d3524f0100090' &&
        showIs(loc.showui) === 'stock/stock', json(loc.showui));
} else {
    process.stdout.write('skip reference build: set CARPLAY_BIN to a copy of the unit\'s /usr/bin/carplay (carplay 22.28.3)\n');
}

/* Builds, by build-id: what the locator finds in each. carplay 23.12.3 has
 * none of the CarPlay patch's sites but the variant slot, and builds the
 * ShowUI URL from carplay.conf's SHOW_UI_OPTIONS itself. */
var OTHER_BUILDS = {
    '5de62156575d737391ea42254e778a97dbbb51f8': { version: '22.28.3', ok: true, variant: true, showui: 'found' },
    'b5e23a5ae24bc38ff295a5c7c56b20bf932c13d5': { version: '23.12.3', ok: false, variant: true,
        showui: 'ShowUI URL: not applicable (the build adds carplay.conf\'s SHOW_UI_OPTIONS to it)' },
};
(process.env.CARPLAY_BINS || '').split(':').filter(Boolean).forEach(function (f) {
    var b = fs.readFileSync(f), loc = locator.locate(b), want = OTHER_BUILDS[loc.buildId];
    var got = { version: loc.version, ok: loc.ok, variant: loc.variant.ok, showui: loc.showui.ok ? 'found' : loc.showui.reason };
    if (!want) { process.stdout.write('note ' + f + ': build ' + loc.buildId + ' not recorded: ' + json(got) + '\n'); return; }
    ok('carplay ' + want.version + ': ' + (want.ok ? 'patchable' : 'refused') + ', the ShowUI URL edit: ' + want.showui, json(got) === json(want), json(got));
});

process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
process.exit(fails ? 1 : 0);
