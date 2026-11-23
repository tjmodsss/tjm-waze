#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The DLT capture service run inside another daemon (dlt_capture.js host,
 * patchd.js --dlt-capture) against a fake DLT daemon (its control socket,
 * its TCP listener, its /proc entries and iDLT records):
 *   - the same socket protocol and capture lifecycle as the service on its
 *     own; a stop restores a capture it owns before the daemon exits;
 *   - a failure of the service (a start or a restore that throws) restarts
 *     the service, never the daemon, with no limit on the restarts, and a
 *     capture left open is restored once it starts again;
 *   - patchd runs it only with --dlt-capture, and not while a
 *     waze-on-cluster-capture.service is installed or running, then takes it
 *     over once that is gone; patchd's capture commands reach it as before,
 *     and a SIGTERM restores an open capture before patchd exits;
 *   - when a capture unit starts while patchd serves the capture, patchd
 *     stops serving it and leaves that unit's socket and capture alone, also
 *     at its own SIGTERM;
 *   - the service's lines stay out of patchd's own log (the app's log view
 *     and its backlog) and go to the logs reply's "capture";
 *   - one restore at a time: a stop while the start's restore runs does not
 *     send the daemon a second one;
 *   - the registered-client check reads /proc asynchronously and checks the
 *     dlt-daemon it found first, without scanning /proc again;
 *   - the patchd unit's ExecStopPost restores a capture left open, except
 *     while a capture unit is installed or runs (its own ExecStopPost does
 *     then).
 *
 *   node capture_host_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit for the patchd this runs */

var fs = require('fs');
var net = require('net');
var path = require('path');
var tmp = require('./tmp.js');
var cp = require('child_process');

var HELPER = path.join(__dirname, '..', 'dlt_capture.js');
var PATCHD = path.join(__dirname, '..', 'patchd.js');
var UNIT = path.join(__dirname, '..', '..', 'systemd', 'waze-on-cluster-patchd.service');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}

var dir = tmp.dir();

var CAPTURE_UNIT = path.join(dir, 'units', 'waze-on-cluster-capture.service');
var UNIT_STATE = path.join(dir, 'unit-state');
var dlt = null, ENV = null, STATE = null, CTL = null;   /* the fake DLT daemon, set up first (below) */
var modes, state, command, trace;
function tcpOpen() { return dlt.open(); }

/* ---- helpers ---------------------------------------------------------------- */

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, ms) {
    for (var t = 0; t < (ms || 5000); t += 20) { if (await fn()) return true; await sleep(20); }
    return false;
}
function spawn(args, env) {
    var c = cp.spawn(process.execPath, args, { env: env || ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    c.out = '';
    c.stdout.on('data', function (d) { c.out += d; });
    c.stderr.on('data', function (d) { c.out += d; });
    c.done = new Promise(function (r) { c.on('exit', function (code, sig) { r({ code: code, signal: sig }); }); });
    return c;
}
function alive(c) { return c.exitCode === null && c.signalCode === null; }
/* The service hosted in a daemon of its own: SIGTERM stops it, then exits 0. */
function hostDaemon() {
    return spawn(['-e', 'var h = require(' + JSON.stringify(HELPER) + ').host(function (l) { console.log(l); });' +
        'process.on("SIGTERM", function () { h.stop(function (e) { console.log("stopped: " + (e ? e.message : "ok")); process.exit(0); }); });']);
}
async function openCapture(send) {
    trace(2);
    await send('start');
    return until(function () { return state().state === 'open'; });
}

var PD = path.join(dir, 'patchd'), BIN = path.join(dir, 'bin'), PSOCK = path.join(PD, 'shm', 'patch.sock'), PENV = null;
function patchd(args) { return spawn([PATCHD].concat(args || ['--dlt-capture']), PENV); }
/* One command on patchd's socket: the reply of type ev, or null. */
function pcmd(cmd, ev) {
    return new Promise(function (resolve) {
        var c = net.connect(PSOCK), buf = '';
        var t = setTimeout(function () { c.destroy(); resolve(null); }, 5000);
        c.on('error', function () { clearTimeout(t); resolve(null); });
        c.on('connect', function () { c.write(JSON.stringify({ cmd: cmd }) + '\n'); });
        c.setEncoding('utf8');
        c.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var m = null, line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                try { m = JSON.parse(line); } catch (e) {}
                if (m && m.ev === ev) { clearTimeout(t); c.destroy(); resolve(m); return; }
            }
        });
    });
}

(async function () {
    dlt = await require('./fake_dlt.js')(path.join(dir, 'dlt'));
    ENV = Object.assign({}, process.env, dlt.env, { WOC_CAPTURE_MS: '60000', WOC_CAPTURE_RETRY_MS: '80', WOC_CAPTURE_RESTART_MS: '100',
        WOC_CAPTURE_RESTART_MAX_MS: '150' });
    STATE = path.join(dlt.env.WOC_CAPTURE_DIR, 'state.json');
    CTL = dlt.env.WOC_CAPTURE_SOCK;
    modes = dlt.modes; state = dlt.state; command = dlt.command; trace = dlt.trace;
    /* patchd in a temporary world, its capture's socket at CTL. */
    [PD, path.join(PD, 'state'), BIN, path.dirname(CAPTURE_UNIT)].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
    fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(BIN, 'systemctl'), '#!/bin/sh\ncat ' + JSON.stringify(UNIT_STATE) + ' 2>/dev/null || echo inactive\n', { mode: 0o755 });
    /* systemctl -q is-active <unit>: 0 while UNIT_STATE says active */
    fs.writeFileSync(path.join(BIN, 'systemctl-q'), '#!/bin/sh\ngrep -qx active ' + JSON.stringify(UNIT_STATE) + ' 2>/dev/null\n', { mode: 0o755 });
    PENV = Object.assign({}, ENV, {
        PATH: BIN + path.delimiter + process.env.PATH,
        WOC_PATCH_SOCK: PSOCK, WOC_PATCH_GROUP: '', WOC_PATCH_LOGS_GROUP: '',
        WOC_STATE_DIR: path.join(PD, 'state'), WOC_LOCAL_CONF: path.join(PD, 'state', 'local.conf'),
        WOC_CARPLAY: path.join(PD, 'no-carplay'), WOC_AAPD: path.join(PD, 'no-aapd'),
        WOC_RECMGR_CONF: path.join(PD, 'no-recmgr'), WOC_RECMGR_AT_BOOT: path.join(PD, 'no-recmgr-at-boot.json'),
        WOC_PROC_STAT: path.join(PD, 'no-stat'), WOC_PROC: path.join(PD, 'no-proc'), WOC_BOOT_ID: path.join(PD, 'no-boot-id'),
        WOC_MOUNT: '/usr/bin/false', WOC_PROC_MOUNTS: path.join(PD, 'no-mounts'),
        WOC_DLT_RECEIVE: path.join(PD, 'no-dlt-receive'), WOC_DLT_RETRY_MS: '600000',
        WOC_REMOUNT_LOCK: path.join(PD, 'remount.lock'), WOC_RECOVERY_STATE: path.join(PD, 'recovery.json'),
        WOC_CAPTURE_UNIT: CAPTURE_UNIT, WOC_SYSTEMCTL: path.join(BIN, 'systemctl'),
        WOC_CAPTURE_RECHECK_MS: '200',
    });

    /* 1. Hosted: the same protocol and lifecycle. */
    var h = hostDaemon();
    ok('hosted: the capture socket answers', await until(async function () { return !!(await command('status')); }), h.out);
    ok('hosted: a capture opens and closes, DLT put back as it was', await openCapture(command) && modes.join() === '1' &&
        !!(await command('stop')) && await until(function () { return state().state === 'closed'; }) && modes.join() === '1,2' && !tcpOpen(),
        modes.join() + ' ' + JSON.stringify(state()));

    /* 2. A stop with a capture open restores it before the daemon exits. */
    ok('hosted: a capture open', await openCapture(command));
    h.kill('SIGTERM');
    var r = await h.done;
    ok('hosted: SIGTERM restores the open capture, then the daemon exits 0', r.code === 0 && /stopped: ok/.test(h.out) &&
        state().state === 'closed' && state().owned === false && modes[modes.length - 1] === 2 && !tcpOpen(), JSON.stringify(r) + ' ' + h.out);

    /* 3. A start that fails restarts the service, never the daemon. */
    fs.unlinkSync(STATE);
    fs.mkdirSync(STATE);
    h = hostDaemon();
    await until(function () { return (h.out.match(/starts again/g) || []).length >= 3; });
    ok('hosted: a start that throws: the service starts again, the daemon stays up, nothing answers meanwhile',
        alive(h) && (h.out.match(/starts again/g) || []).length >= 3 && !(await command('status')), h.out.slice(-400));
    fs.rmdirSync(STATE);
    ok('hosted: once it can start, it answers', await until(async function () { return !!(await command('status')); }) && alive(h), h.out.slice(-300));

    /* 4. A restore that throws with a capture open: the service starts
     * again until it can, then restores the capture it left. */
    ok('hosted: a capture open before its restore fails', await openCapture(command));
    var before = (h.out.match(/starts again/g) || []).length;
    fs.mkdirSync(STATE + '.tmp');
    await command('stop');
    await until(function () { return (h.out.match(/starts again/g) || []).length >= before + 2; });
    ok('hosted: a restore that throws: the service starts again, the daemon stays up, DLT still as the capture left it',
        alive(h) && (h.out.match(/starts again/g) || []).length >= before + 2 && state().owned === true && !!tcpOpen(), h.out.slice(-400));
    fs.rmdirSync(STATE + '.tmp');
    ok('hosted: started again, it restores the capture it left', await until(function () { return state().state === 'closed' && !tcpOpen(); }) &&
        modes[modes.length - 1] === 2 && alive(h) && !!(await command('status')), JSON.stringify(state()) + ' ' + h.out.slice(-300));

    /* 4b. A restore that keeps failing past 20 restarts: the service keeps
     * trying, and restores the capture once it can. */
    ok('hosted: a capture open before a long restore failure', await openCapture(command));
    before = (h.out.match(/starts again/g) || []).length;
    fs.mkdirSync(STATE + '.tmp');
    await command('stop');
    await until(function () { return (h.out.match(/starts again/g) || []).length >= before + 25; }, 20000);
    ok('hosted: 25 restarts and more with the restore failing, the waits bounded, the capture still left',
        alive(h) && (h.out.match(/starts again/g) || []).length >= before + 25 && state().owned === true && !!tcpOpen() &&
        !/stays off/.test(h.out), h.out.slice(-300));
    fs.rmdirSync(STATE + '.tmp');
    ok('hosted: after them it restores the capture it left', await until(function () { return state().state === 'closed' && !tcpOpen(); }, 5000) &&
        modes[modes.length - 1] === 2 && alive(h), JSON.stringify(state()) + ' ' + h.out.slice(-300));
    h.kill('SIGTERM');
    await h.done;

    /* 5. patchd without --dlt-capture does not run it. */
    var p = patchd([]);
    await until(function () { return fs.existsSync(PSOCK); }, 10000);
    await sleep(600);
    ok('patchd without --dlt-capture: no capture service', alive(p) && !(await command('status')), p.out.slice(-300));
    p.kill('SIGKILL'); await p.done;

    /* 6. Not while a capture unit is installed or runs;
     * taken over once it is gone. */
    fs.writeFileSync(CAPTURE_UNIT, '[Service]\n');
    p = patchd();
    await until(function () { return /served by waze-on-cluster-capture\.service \(installed\)/.test(p.out); }, 10000);
    await sleep(500);
    ok('patchd --dlt-capture, the earlier capture unit installed: not served here', alive(p) && !(await command('status')) &&
        /served by waze-on-cluster-capture\.service \(installed\)/.test(p.out), p.out.slice(-300));
    fs.unlinkSync(CAPTURE_UNIT);
    fs.writeFileSync(UNIT_STATE, 'active\n');
    await sleep(700);
    ok('patchd --dlt-capture, the earlier capture unit still running: not served here', alive(p) && !(await command('status')), p.out.slice(-300));
    fs.writeFileSync(UNIT_STATE, 'inactive\n');
    ok('patchd --dlt-capture: served here once the earlier unit is gone',
        await until(async function () { return !!(await command('status')); }) && /DLT capture: served here/.test(p.out), p.out.slice(-300));

    /* 7. patchd's capture commands reach it; SIGTERM restores an open one. */
    var rep = await pcmd('capture-status', 'capture-reply');
    ok('patchd: capture-status answered by the service here', !!rep && rep.capture && rep.capture.state === 'closed', JSON.stringify(rep));
    trace(2);
    rep = await pcmd('capture-start', 'capture-reply');
    ok('patchd: capture-start opens a capture', !!rep && await until(function () { return state().state === 'open'; }) && !!tcpOpen(),
        JSON.stringify(rep) + ' ' + JSON.stringify(state()));
    p.kill('SIGTERM');
    r = await p.done;
    ok('patchd: SIGTERM restores the open capture, then patchd exits 0', r.code === 0 && state().state === 'closed' &&
        modes[modes.length - 1] === 2 && !tcpOpen(), JSON.stringify(r) + ' ' + JSON.stringify(state()) + ' ' + p.out.slice(-300));

    /* 8. The unit's ExecStopPost (its command with this test's paths):
     * restores a capture left open (patchd SIGKILLed), unless the earlier
     * capture unit is installed. */
    var stopPost = (/^ExecStopPost=-\/bin\/sh -c '(.*)'$/m.exec(fs.readFileSync(UNIT, 'utf8')) || [])[1] || '';
    ok('the patchd unit restores in ExecStopPost, guarded by the earlier unit', /dlt_capture\.js restore/.test(stopPost) &&
        stopPost.indexOf('/etc/systemd/system/waze-on-cluster-capture.service') >= 0, stopPost);
    var cmdline = stopPost.split('/etc/systemd/system/waze-on-cluster-capture.service').join(CAPTURE_UNIT)
        .split('systemctl -q is-active').join(path.join(BIN, 'systemctl-q'))
        .split('/usr/bin/node').join(process.execPath).split('/var/opt/waze-on-cluster/current/').join(path.join(__dirname, '..') + '/');
    p = patchd();
    await until(async function () { return !!(await command('status')); });
    ok('patchd: a capture open before a SIGKILL', await openCapture(command));
    p.kill('SIGKILL'); await p.done;
    /* run without blocking: the fake DLT daemon answers from this process */
    function stopPostRun() {
        var c = cp.spawn('/bin/sh', ['-c', cmdline], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }), out = '';
        c.stdout.on('data', function (d) { out += d; }); c.stderr.on('data', function (d) { out += d; });
        return new Promise(function (resolve) { c.on('exit', function (code) { resolve({ status: code, out: out }); }); });
    }
    fs.writeFileSync(CAPTURE_UNIT, '[Service]\n');
    var sr = await stopPostRun();
    ok('ExecStopPost, the earlier capture unit installed: leaves the capture to it', sr.status === 0 && state().owned === true && !!tcpOpen(),
        sr.status + ' ' + sr.out + ' ' + JSON.stringify(state()));
    fs.unlinkSync(CAPTURE_UNIT);
    sr = await stopPostRun();
    ok('ExecStopPost: restores the capture patchd left open', sr.status === 0 && state().state === 'closed' && !tcpOpen() &&
        modes[modes.length - 1] === 2, sr.status + ' ' + sr.out + ' ' + JSON.stringify(state()));
    p = patchd();
    await until(async function () { return !!(await command('status')); });
    ok('patchd: a capture open before a SIGKILL, again', await openCapture(command));
    p.kill('SIGKILL'); await p.done;
    fs.writeFileSync(UNIT_STATE, 'active\n');
    sr = await stopPostRun();
    ok('ExecStopPost, a capture unit running (its file gone): leaves the capture to it', sr.status === 0 && state().owned === true && !!tcpOpen(),
        sr.status + ' ' + sr.out + ' ' + JSON.stringify(state()));
    fs.writeFileSync(UNIT_STATE, 'inactive\n');
    sr = await stopPostRun();
    ok('ExecStopPost: restores it once no capture unit runs', sr.status === 0 && state().state === 'closed' && !tcpOpen(), sr.out);

    /* 9. A capture unit starts while patchd serves the capture (an Undo
     * update that starts it before patchd restarts): patchd stops serving it
     * at its next check, and neither then nor at its own SIGTERM removes the
     * unit's socket or restores the capture the unit opened. */
    p = patchd();
    await until(async function () { return !!(await command('status')); });
    var unitProc = spawn([HELPER]);
    fs.writeFileSync(UNIT_STATE, 'active\n');
    await until(function () { return /served by waze-on-cluster-capture\.service \(active\); stopped here/.test(p.out); });
    ok('a capture unit starts: patchd stops serving the capture, the unit\'s socket answers',
        /stopped here/.test(p.out) && await until(async function () { return !!(await command('status')); }) && alive(unitProc), p.out.slice(-300));
    ok('the capture unit opens a capture', await openCapture(command));
    p.kill('SIGTERM');
    r = await p.done;
    await sleep(300);
    ok('patchd\'s SIGTERM leaves the unit\'s socket and its open capture alone', r.code === 0 && fs.existsSync(CTL) &&
        !!(await command('status')) && state().owned === true && state().state === 'open' && !!tcpOpen() && alive(unitProc),
        JSON.stringify(r) + ' ' + JSON.stringify(state()) + ' ' + p.out.slice(-300));
    unitProc.kill('SIGTERM');
    await unitProc.done;
    await (function () { var c = spawn([HELPER, 'restore']); return c.done; })();
    fs.writeFileSync(UNIT_STATE, 'inactive\n');
    ok('the unit\'s ExecStopPost restores its capture', state().state === 'closed' && !tcpOpen(), JSON.stringify(state()));

    /* 10. A capture failing at every start: its lines go to the journal and
     * the logs reply's "capture" (at most 40), not to patchd's own log, which
     * the app shows and replays to each new client. */
    fs.unlinkSync(STATE);
    fs.mkdirSync(STATE);
    p = patchd();
    await until(function () { return (p.out.match(/dlt-capture: .*starts again/g) || []).length >= 70; }, 30000);
    var lr = await pcmd('logs', 'logs');
    var backlog = await (function () {
        return new Promise(function (resolve) {
            var c = net.connect(PSOCK), buf = '', lines = [];
            c.setEncoding('utf8');
            c.on('data', function (d) {
                buf += d;
                var i;
                while ((i = buf.indexOf('\n')) >= 0) { try { var m = JSON.parse(buf.slice(0, i)); if (m.ev === 'log') lines.push(m.line); } catch (e) {} buf = buf.slice(i + 1); }
            });
            c.on('error', function () {});
            setTimeout(function () { c.destroy(); resolve(lines); }, 700);
        });
    })();
    ok('a capture failing 70 times: patchd\'s own log keeps its lines, none of the capture\'s',
        (p.out.match(/dlt-capture: .*starts again/g) || []).length >= 70 && !!lr && lr.patchd.some(function (l) { return /patchd listening on/.test(l); }) &&
        !lr.patchd.some(function (l) { return /dlt-capture|DLT capture/.test(l); }), String(JSON.stringify(lr && lr.patchd)).slice(-400));
    ok('the app\'s backlog on connect has patchd\'s lines, none of the capture\'s', backlog.some(function (l) { return /patchd listening on/.test(l); }) &&
        !backlog.some(function (l) { return /dlt-capture|DLT capture/.test(l); }), JSON.stringify(backlog).slice(-300));
    ok('the logs reply (Save logs) has the capture\'s own lines, the newest 40', !!lr && Array.isArray(lr.capture) && lr.capture.length === 40 &&
        lr.capture.every(function (l) { return /dlt-capture|DLT capture/.test(l); }), String(JSON.stringify(lr && lr.capture)).slice(-300));
    p.kill('SIGKILL'); await p.done;
    fs.rmdirSync(STATE);

    /* 11. One restore at a time: a capture left open (its daemon killed),
     * then a daemon that starts and is stopped while its start's restore
     * waits for the DLT daemon: one mode request reaches the daemon. */
    h = hostDaemon();
    await until(async function () { return !!(await command('status')); });
    ok('hosted: a capture open, then its daemon killed', await openCapture(command));
    h.kill('SIGKILL'); await h.done;
    var sent = modes.length;
    dlt.delay = 400;
    h = hostDaemon();
    await until(function () { return modes.length > sent; }, 5000);
    h.kill('SIGTERM');
    r = await h.done;
    dlt.delay = 0;
    ok('a stop while the start\'s restore runs: one restore, DLT put back', r.code === 0 && modes.length === sent + 1 && modes[modes.length - 1] === 2 &&
        state().state === 'closed' && !tcpOpen(), modes.slice(sent).join() + ' ' + JSON.stringify(state()) + ' ' + h.out);

    /* 12. The registered-client check: asynchronous, and the dlt-daemon it
     * found is checked first, /proc not scanned again (a pid whose comm
     * cannot be read without blocking, added after, is never read). */
    var P2 = path.join(dir, 'proc2');
    fs.mkdirSync(path.join(P2, '9', 'fd'), { recursive: true });
    fs.writeFileSync(path.join(P2, '9', 'comm'), 'dlt-daemon\n');
    fs.symlinkSync('/run/dlt-files/dltpipes/dlt99', path.join(P2, '9', 'fd', '10'));
    var probe = spawn(['-e', [
        'var dc = require(' + JSON.stringify(HELPER) + '), fs = require("fs"), cp = require("child_process");',
        'var first = dc.registeredClient();',
        'if (!first || typeof first.then !== "function") { console.log("not a promise"); process.exit(1); }',
        'first.then(function (a) {',
        '    fs.mkdirSync(' + JSON.stringify(path.join(P2, '5')) + ');',
        '    cp.execFileSync("mkfifo", [' + JSON.stringify(path.join(P2, '5', 'comm')) + ']);',
        '    return dc.registeredClient().then(function (b) { console.log("result " + a + " " + b); process.exit(0); });',
        '});'].join('\n')], Object.assign({}, ENV, { WOC_DLT_PROC: P2 }));
    var probeTimer = setTimeout(function () { probe.kill('SIGKILL'); }, 5000);
    r = await probe.done;
    clearTimeout(probeTimer);
    ok('the registered-client check: a promise, the dlt-daemon found first checked again, /proc not scanned again',
        r.code === 0 && /result true true/.test(probe.out), JSON.stringify(r) + ' ' + probe.out);

    process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
    process.exit(fails ? 1 : 0);
})().catch(function (e) { process.stdout.write('FAIL ' + (e.stack || e) + '\n'); process.exit(1); });
