// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The DLT capture's units through the deploy tool's update, Undo update
 * (rollback) and install of an earlier release, run as real processes
 * (rollback_test.js part 8). A world holds a units folder (the
 * waze-on-cluster-capture.service and waze-on-cluster-patchd.service files,
 * the capture unit's enablement), which files current points to (the
 * release's or this version's) and a fake DLT daemon (fake_dlt.js), and
 * plays systemd for them:
 *   - the capture unit, while its file is there and it is started, runs
 *     current/dlt_capture.js on its own; its stop is SIGTERM, then its
 *     ExecStopPost (`dlt_capture.js restore`);
 *   - the patchd unit runs current/patchd.js with its ExecStart's
 *     arguments: this version's patchd.js as a process, a release's
 *     patchd.js (which has no capture code, checked by the caller) as none;
 *     its stop is SIGTERM, then its ExecStopPost as the installed unit says;
 *   - systemctl is-active for the capture unit says whether that process
 *     runs;
 *   - a power cut SIGKILLs everything, then a boot starts the enabled units
 *     from what is on disk, in either order.
 * After each step of each change, and after a power cut there, it counts
 * the capture servers that listen (Linux /proc/net/unix: listening sockets
 * bound to control.sock or a name of its own beside it) over the next
 * moments, and asks control.sock for the status.
 *
 * The deploy tool's order (mgu-deploy installTool, cmdRollback): an update
 * switches current, stops the units the new version no longer lists (the
 * capture unit), copies the changed units and deletes the others in one
 * rootfs window, then restarts its restart[] units (patchd). Undo update
 * switches current, lays the units the version it goes back to lists and
 * misses (the capture unit; patchd's stays as it is), restarts its
 * restart[] units that were there (patchd), then starts those it laid (the
 * capture unit). An install of the earlier release switches current, copies
 * its units (patchd's, the capture unit) in one window and restarts its
 * restart[] units that run (patchd); the capture unit, not running, starts
 * at the next boot.
 *
 *   await require('./capture_units_model.js')({ dir, newDir, newUnit,
 *       relDlt, relUnit, name, ok })
 */
'use strict';

var fs = require('fs');
var net = require('net');
var path = require('path');
var cp = require('child_process');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function unitLines(text, key) {
    var re = new RegExp('^' + key + '=(.*)$', 'mg'), m, out = [];
    while ((m = re.exec(text || ''))) out.push(m[1]);
    return out;
}

module.exports = async function model(o) {
    var W = o.dir, UNITS = path.join(W, 'units'), BIN = path.join(W, 'bin'), PD = path.join(W, 'patchd');
    var REL = path.join(W, 'rel'), UNIT_STATE = path.join(W, 'unit-state');
    [UNITS, BIN, path.join(PD, 'state'), REL].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
    fs.writeFileSync(path.join(REL, 'dlt_capture.js'), fs.readFileSync(o.relDlt));
    var CAPU = path.join(UNITS, 'waze-on-cluster-capture.service'), PDU = path.join(UNITS, 'waze-on-cluster-patchd.service');
    fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(BIN, 'systemctl'), '#!/bin/sh\ncat ' + JSON.stringify(UNIT_STATE) + ' 2>/dev/null || echo inactive\n', { mode: 0o755 });
    fs.writeFileSync(path.join(BIN, 'systemctl-q'), '#!/bin/sh\ngrep -qx active ' + JSON.stringify(UNIT_STATE) + ' 2>/dev/null\n', { mode: 0o755 });
    var dlt = await require('./fake_dlt.js')(path.join(W, 'dlt'));
    var CTL = dlt.env.WOC_CAPTURE_SOCK;
    var CENV = Object.assign({}, process.env, dlt.env, { WOC_CAPTURE_MS: '60000', WOC_CAPTURE_RETRY_MS: '80' });
    var PENV = Object.assign({}, CENV, {
        PATH: BIN + path.delimiter + process.env.PATH,
        WOC_PATCH_SOCK: path.join(PD, 'shm', 'patch.sock'), WOC_PATCH_GROUP: '', WOC_PATCH_LOGS_GROUP: '',
        WOC_STATE_DIR: path.join(PD, 'state'), WOC_LOCAL_CONF: path.join(PD, 'state', 'local.conf'),
        WOC_CARPLAY: path.join(PD, 'no-carplay'), WOC_AAPD: path.join(PD, 'no-aapd'),
        WOC_RECMGR_CONF: path.join(PD, 'no-recmgr'), WOC_RECMGR_AT_BOOT: path.join(PD, 'no-recmgr-at-boot.json'),
        WOC_PROC_STAT: path.join(PD, 'no-stat'), WOC_PROC: path.join(PD, 'no-proc'), WOC_BOOT_ID: path.join(PD, 'no-boot-id'),
        WOC_MOUNT: '/usr/bin/false', WOC_PROC_MOUNTS: path.join(PD, 'no-mounts'),
        WOC_DLT_RECEIVE: path.join(PD, 'no-dlt-receive'), WOC_DLT_RETRY_MS: '600000',
        WOC_REMOUNT_LOCK: path.join(PD, 'remount.lock'), WOC_RECOVERY_STATE: path.join(PD, 'recovery.json'),
        WOC_CAPTURE_UNIT: CAPU, WOC_SYSTEMCTL: path.join(BIN, 'systemctl'), WOC_CAPTURE_RECHECK_MS: '200',
    });

    /* ---- what is on disk, and what runs ---- */
    var current = 'rel', capWanted = false, procs = [], cap = null, pd = null;
    function codeFile(f) { return current === 'new' ? path.join(o.newDir, f) : path.join(REL, f); }
    function spawn(args, env) {
        var c = cp.spawn(process.execPath, args, { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
        c.out = '';
        c.stdout.on('data', function (d) { c.out += d; });
        c.stderr.on('data', function (d) { c.out += d; });
        c.done = new Promise(function (r) { c.on('exit', function () { r(); }); });
        procs.push(c);
        return c;
    }
    function run(args, env) { return spawn(args, env).done; }
    function sh(cmd) {
        var c = cp.spawn('/bin/sh', ['-c', cmd], { env: CENV, stdio: 'ignore' });
        return new Promise(function (r) { c.on('exit', function () { r(); }); });
    }
    function setUnits(which, withCapture) {
        fs.writeFileSync(PDU, which === 'new' ? o.newUnit : o.relUnit);
        if (withCapture) { fs.writeFileSync(CAPU, '[Service]\n'); capWanted = true; }
        else { try { fs.unlinkSync(CAPU); } catch (e) {} capWanted = false; }
    }
    function startCap() {
        if (cap || !fs.existsSync(CAPU)) return;
        cap = spawn([codeFile('dlt_capture.js')], CENV);
        fs.writeFileSync(UNIT_STATE, 'active\n');
    }
    async function stopCap() {
        if (!cap) return;
        var c = cap;
        cap = null;
        c.kill('SIGTERM');
        await c.done;
        fs.writeFileSync(UNIT_STATE, 'inactive\n');
        await run([codeFile('dlt_capture.js'), 'restore'], CENV);
    }
    function startPd() {
        if (pd) return;
        var exec = unitLines(fs.readFileSync(PDU, 'utf8'), 'ExecStart')[0] || '';
        var args = exec.split(/\s+/).slice(2);
        pd = current === 'new' ? spawn([path.join(o.newDir, 'patchd.js')].concat(args), PENV) : 'release';
    }
    async function stopPd() {
        if (!pd) return;
        var p = pd;
        pd = null;
        if (p !== 'release') { p.kill('SIGTERM'); await p.done; }
        var post = unitLines(fs.readFileSync(PDU, 'utf8'), 'ExecStopPost');
        for (var i = 0; i < post.length; i++) {
            var m = /^-?\/bin\/sh -c '(.*)'$/.exec(post[i]), cmd = m ? m[1] : post[i].replace(/^-/, '');
            await sh(cmd.split('/etc/systemd/system/waze-on-cluster-capture.service').join(CAPU)
                .split('systemctl -q is-active').join(path.join(BIN, 'systemctl-q'))
                .split('/usr/bin/node').join(process.execPath)
                .split('/var/opt/waze-on-cluster/current/').join((current === 'new' ? o.newDir : REL) + '/'));
        }
    }
    async function powerCut() {
        procs.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
        await Promise.all(procs.map(function (c) { return c.done; }));
        procs = [];
        cap = null;
        pd = null;
        fs.writeFileSync(UNIT_STATE, 'inactive\n');
        [CTL, path.join(path.dirname(CTL), 'state.json')].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });   /* /run does not outlive a boot */
    }
    async function boot(capFirst) {
        if (capFirst) { if (capWanted) startCap(); await sleep(400); startPd(); }
        else { startPd(); await sleep(400); if (capWanted) startCap(); }
    }

    /* ---- counting ---- */
    function listening() {
        var n = 0;
        fs.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1).forEach(function (l) {
            var f = l.trim().split(/\s+/), p = f[7];
            if (p && (parseInt(f[3], 16) & 0x10000) && (p === CTL || p.indexOf(CTL + '.') === 0)) n++;
        });
        return n;
    }
    function status() {
        return new Promise(function (resolve) {
            var c = net.connect(CTL), buf = '';
            var t = setTimeout(function () { c.destroy(); resolve(false); }, 1500);
            c.on('error', function () { clearTimeout(t); resolve(false); });
            c.on('connect', function () { c.write('{"cmd":"status"}\n'); });
            c.on('data', function (d) { buf += d; if (buf.indexOf('\n') >= 0) { clearTimeout(t); c.destroy(); resolve(true); } });
        });
    }
    /* After a step: the most servers seen over the next moments (after
     * graceMs, for a handover the patchd check settles), the servers at the
     * end, and whether control.sock answers. */
    async function settle(want, graceMs) {
        var until = Date.now() + 3000;
        while (Date.now() < until && !(listening() === want && (want === 0 || await status()))) await sleep(50);
        var from = Date.now() + (graceMs || 0), most = 0;
        for (var t = Date.now(); Date.now() < from + 800; t = Date.now()) {
            if (t >= from) most = Math.max(most, listening());
            await sleep(40);
        }
        return { most: most, now: listening(), answers: await status() };
    }
    function check(what, r, want) {
        o.ok(o.name + ', ' + what + ': ' + (want ? 'one capture server, which answers' : 'no capture server') + ', never two',
            r.most <= 1 && r.now === want && r.answers === (want === 1), JSON.stringify(r));
    }

    /* ---- the changes ---- */
    /* Each change: its starting state (units, files, a boot) and steps; a
     * step changes disk and processes, and says how many servers it leaves
     * running and how many a boot from its disk state starts. */
    var CHANGES = [
        { name: 'an update', start: function () { current = 'rel'; setUnits('rel', true); }, steps: [
            ['current switched', function () { current = 'new'; }, 1, 1],
            ['the capture unit stopped', stopCap, 0, 1],
            ['the units changed (patchd\'s copied, the capture unit removed)', function () { setUnits('new', false); }, 0, 1],
            ['patchd restarted', async function () { await stopPd(); startPd(); }, 1, 1],
        ] },
        { name: 'an Undo update', start: function () { current = 'new'; setUnits('new', false); }, steps: [
            ['current switched', function () { current = 'rel'; }, 1, 0],
            ['the capture unit laid', function () { fs.writeFileSync(CAPU, '[Service]\n'); capWanted = true; }, 0, 1, 600],
            ['patchd restarted', async function () { await stopPd(); startPd(); }, 0, 1],
            ['the capture unit started', startCap, 1, 1],
        ] },
        { name: 'an Undo update starting the capture unit before patchd restarts', start: function () { current = 'new'; setUnits('new', false); }, steps: [
            ['current switched', function () { current = 'rel'; }, 1, 0],
            ['the capture unit laid and started at once', function () { fs.writeFileSync(CAPU, '[Service]\n'); capWanted = true; startCap(); }, 1, 1, 600],
            ['patchd restarted', async function () { await stopPd(); startPd(); }, 1, 1],
        ] },
        { name: 'an install of the release over this version', start: function () { current = 'new'; setUnits('new', false); }, steps: [
            ['current switched', function () { current = 'rel'; }, 1, 0],
            ['the units changed (patchd\'s, the capture unit laid)', function () { setUnits('rel', true); }, 0, 1, 600],
            ['patchd restarted', async function () { await stopPd(); startPd(); }, 0, 1],
        ] },
    ];
    /* Each run below starts from a power cut: o.unit (rollback_test.js
     * --part) may run only some of them. */
    var unit = o.unit || function (fn) { return fn(); };
    for (var i = 0; i < CHANGES.length; i++) {
        var ch = CHANGES[i];
        /* whole, step by step */
        await unit(async function () {
            await powerCut();
            ch.start();
            await boot(false);
            check(ch.name + ', at the start', await settle(1), 1);
            for (var j = 0; j < ch.steps.length; j++) {
                var s = ch.steps[j];
                await s[1]();
                check(ch.name + ', ' + s[0], await settle(s[2], s[4]), s[2]);
            }
        });
        /* cut short after each step: a power cut, then a boot in either order */
        for (var j = 0; j < ch.steps.length; j++) {
            for (var order = 0; order < 2; order++) {
                await unit(async function () {
                    await powerCut();
                    ch.start();
                    await boot(false);
                    await settle(1);
                    for (var k = 0; k <= j; k++) await ch.steps[k][1]();
                    await powerCut();
                    await boot(order === 1);
                    check(ch.name + ', a power cut after "' + ch.steps[j][0] + '", then a boot (' + (order ? 'capture unit' : 'patchd') + ' first)',
                        await settle(ch.steps[j][3]), ch.steps[j][3]);
                });
            }
        }
    }
    await powerCut();
    await dlt.close();
};
