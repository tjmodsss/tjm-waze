// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* inmem.js — the carplay patch applied in memory (PATCH.md "In memory").
 * /usr/bin/carplay stays as it ships; libwocpatch.so, preloaded into a
 * carplay start the boot step armed, applies the same edits to the process
 * before carplay's own code runs.
 *
 * On /var/opt (no remount of / for any of it):
 *   inmem-carplay.plan   the plan (carplay_patch.js plan): the build-id and,
 *                        per edit region, its address, stock and patched
 *                        bytes
 *   inmem-carplay.json   the record: {v, enabled, target, ino, size, mtime,
 *                        sha256, build, planSha256, edits, args, writes,
 *                        proven, trial, at, and when turned off by: "user" |
 *                        "recovery" | "refused" (recovery also fails, why)}
 *     It describes the target only while its inode, size and modification
 *     time are the recorded ones, and the plan only while its SHA-256 is.
 *     A plan that could not be made: {v, enabled, needsPlan, args, error}.
 *
 * In /run (gone at every head-unit start), written by arm() before carplay
 * starts, only while the record is current and enabled:
 *   /run/woc-preload/carplay.plan    the plan, readable by carplay's user
 *   /run/woc-preload/carplay.result  empty, owned by carplay's user: the
 *                                    library writes its result there
 *   /run/woc-preload/carplay.env     LD_PRELOAD (the unit's own preloads,
 *                                    then this version's library),
 *                                    WOC_PATCH_PLAN, WOC_PATCH_RESULT;
 *                                    written last. The tool's carplay.service
 *                                    drop-in reads it with EnvironmentFile=-,
 *                                    so without it carplay starts stock.
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');

var STATE_DIR = process.env.WOC_STATE_DIR || '/var/opt/waze-on-cluster';
var RUN_DIR = process.env.WOC_PRELOAD_DIR || '/run/woc-preload';
var LIB = process.env.WOC_PRELOAD_LIB || path.join(__dirname, 'libwocpatch.so');
var PROC = process.env.WOC_PROC || '/proc';
var SYSTEMCTL = process.env.WOC_SYSTEMCTL || 'systemctl';
var PASSWD = process.env.WOC_PASSWD || '/etc/passwd';

var TARGETS = {
    carplay: { name: 'carplay', unit: 'carplay.service', target: process.env.WOC_CARPLAY || '/usr/bin/carplay' },
};

function paths(name) {
    return {
        record: path.join(STATE_DIR, 'inmem-' + name + '.json'),
        armError: path.join(STATE_DIR, 'inmem-' + name + '.armerror'),
        plan: path.join(STATE_DIR, 'inmem-' + name + '.plan'),
        env: path.join(RUN_DIR, name + '.env'),
        runPlan: path.join(RUN_DIR, name + '.plan'),
        result: path.join(RUN_DIR, name + '.result'),
    };
}

/* The folder, made where it is missing (Node 8: no recursive mkdir). */
function ensureDir(d) {
    try { fs.mkdirSync(d, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readOr(f, enc) { try { return fs.readFileSync(f, enc); } catch (e) { return null; } }

function fsyncPath(p) {
    var fd = fs.openSync(p, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/* Writes data to file whole: a temporary file, fsynced, renamed, the folder
 * synced. Throws when it cannot; the previous file then stays. */
function writeWhole(file, data, mode) {
    var tmp = file + '.tmp';
    try {
        fs.writeFileSync(tmp, data, { mode: mode || 0o644 });
        fs.chmodSync(tmp, mode || 0o644);
        fsyncPath(tmp);
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        throw e;
    }
    try { fsyncPath(path.dirname(file)); } catch (e) {}
}

/* The record as written, or null. */
function readRecord(name) {
    var r = null;
    try { r = JSON.parse(fs.readFileSync(paths(name).record, 'utf8')); } catch (e) { return null; }
    return r && typeof r === 'object' && r.v === 1 ? r : null;
}

/* Whether the record describes the target as it is now and the plan on
 * /var/opt is the one it names. */
function describes(name, rec) {
    var st, t = TARGETS[name], plan = readOr(paths(name).plan);
    try { st = fs.statSync(t.target); } catch (e) { return false; }
    return !!rec && rec.ino === st.ino && rec.size === st.size && rec.mtime === st.mtime.getTime() && !!plan && sha256(plan) === rec.planSha256;
}

/* The record while it describes the target and is enabled, else null. */
function current(name) {
    var rec = readRecord(name);
    return rec && rec.enabled === true && describes(name, rec) ? rec : null;
}

/* What boot recovery counts the patch as: 'proven', 'unproven' (on trial,
 * or a build outside the proven list or a car coded otherwise), or null
 * when nothing is to be armed. */
function kind(name) {
    var rec = current(name);
    return !rec ? null : rec.proven === true && rec.trial !== true ? 'proven' : 'unproven';
}

/* The record with fields merged in, written whole. Throws. */
function update(name, fields) {
    var rec = readRecord(name);
    if (!rec) throw new Error('no in-memory record for ' + name);
    writeWhole(paths(name).record, JSON.stringify(Object.assign(rec, fields)) + '\n');
    return rec;
}

/* Whether the patcher's error words are a refusal of the file (not
 * patchable, not the pristine build, not a proven build, the head unit, the
 * coding), as opposed to a failure a later try may not meet (the file
 * unreadable, the coding not published yet, a check of the plan itself). */
function refusal(words) {
    return /^refusing: (?!the edited image|the plan does not|the cluster coding cannot be read)/.test(words) ||
        /in memory needs the pristine build|is not a proven build/.test(words);
}

/* Makes the plan for the target as it is on disk (carplay_patch.js plan,
 * the same checks as the edits it plans), and on success writes it with a
 * record, enabled. cb(err, rec): err.refused with the patcher's own words
 * when it refuses the file (a conflict, not a failure). */
function makePlan(name, args, timeoutMs, cb) {
    var t = TARGETS[name], p = paths(name), tmp = p.plan + '.new.' + process.pid, st0, from = t.target;
    try { st0 = fs.statSync(from); ensureDir(STATE_DIR); } catch (e) { cb(e); return; }
    cp.execFile(process.execPath, [path.join(__dirname, 'carplay_patch.js'), 'plan', '--target', from, '--out', tmp].concat(args),
        { timeout: timeoutMs || 60000 }, function (err, out, errOut) {
        var m = /^error: (.*)$/m.exec((errOut || '') + ''), sum = null;
        if (err) {
            try { fs.unlinkSync(tmp); } catch (e) {}
            var e = new Error(m ? m[1] : err.message);
            if (m && refusal(m[1])) e.refused = m[1];
            cb(e);
            return;
        }
        try { sum = JSON.parse(((out || '') + '').trim().split('\n').pop()); } catch (e2) { cb(new Error('plan: no summary')); return; }
        var st1;
        try { st1 = fs.statSync(from); } catch (e3) { cb(e3); return; }
        if (st1.ino !== st0.ino || st1.size !== st0.size || st1.mtime.getTime() !== st0.mtime.getTime()) {
            try { fs.unlinkSync(tmp); } catch (e) {}
            cb(new Error(from + ' changed while the plan was made'));
            return;
        }
        var prior = readRecord(name);
        var same = !!prior && prior.planSha256 === sum.planSha256 && prior.ino === st1.ino && prior.mtime === st1.mtime.getTime();
        /* Proven carries over only from a patch that ran healthy here and is
         * on, or that the user turned off (Remove patch); one boot recovery
         * turned off goes on trial again. */
        var proven = sum.provenBuild && sum.coding === 'ok' && ((same && prior.proven === true && prior.trial !== true &&
            (prior.enabled === true || prior.by === 'user')));
        var onTrial = !proven && sum.provenBuild && sum.coding !== 'refused';
        var rec = { v: 1, enabled: true, target: t.target, ino: st1.ino, size: st1.size, mtime: st1.mtime.getTime(), sha256: sum.sha256,
            build: sum.build, version: sum.version, planSha256: sum.planSha256, edits: sum.edits, writes: sum.writes, args: args,
            proven: proven, trial: onTrial, at: new Date().toISOString() };
        try {
            var text = fs.readFileSync(tmp);
            fsyncPath(tmp);
            fs.renameSync(tmp, p.plan);
            writeWhole(p.record, JSON.stringify(rec) + '\n');
            /* Both read back as written, or nothing is relied on. */
            if (!fs.readFileSync(p.plan).equals(text) || sha256(text) !== rec.planSha256 || JSON.stringify(readRecord(name)) !== JSON.stringify(rec))
                throw new Error('the plan or its record does not read back as written');
        } catch (e4) { cb(e4); return; }
        cb(null, rec);
    });
}

/* An enabled record whose file was written again with the same bytes (a
 * stray patch of the file that boot recovery put back, a restore of the
 * same file) describes it again once the target holds exactly the bytes
 * the plan was made from (their SHA-256): the stat it then has is recorded.
 * Root only (boot recovery, patchd). true when the record describes the
 * target after the call. */
function adopt(name) {
    var rec = readRecord(name), t = TARGETS[name];
    if (!rec || rec.enabled !== true || !rec.planSha256 || describes(name, rec)) return !!rec && describes(name, rec);
    var plan = readOr(paths(name).plan), buf, st;
    if (!plan || sha256(plan) !== rec.planSha256) return false;
    try { st = fs.statSync(t.target); buf = fs.readFileSync(t.target); } catch (e) { return false; }
    if (buf.length !== rec.size || sha256(buf) !== rec.sha256) return false;
    try { update(name, { ino: st.ino, mtime: st.mtime.getTime() }); } catch (e) { return false; }
    return describes(name, readRecord(name));
}

/* A plan that could not be made: the record keeps the arguments and why,
 * enabled, with no plan, so nothing is armed and the next try (the
 * watcher at the next head-unit start, the Patch button) plans it. */
function planFailed(name, args, why) {
    var t = TARGETS[name], p = paths(name);
    /* A plan left that cannot be removed is never used: the record names no plan. */
    try { fs.unlinkSync(p.plan); } catch (e) {}
    ensureDir(STATE_DIR);
    writeWhole(p.record, JSON.stringify({ v: 1, enabled: true, needsPlan: true, target: t.target, args: args, error: why, at: new Date().toISOString() }) + '\n');
}

/* Turns the patch off for later starts: the record enabled false with why
 * (fields: {by, ...}). The running process keeps what it applied until it
 * ends; disarm() keeps the next start of this boot stock. Throws. */
function disable(name, fields) {
    var rec = readRecord(name);
    if (!rec) return null;
    return update(name, Object.assign({ enabled: false, at: new Date().toISOString() }, fields));
}

/* Removes the record, the plan and this boot's files in RUN_DIR (a
 * removal of the tool). */
function remove(name) {
    var p = paths(name);
    [p.record, p.plan, p.record + '.tmp', p.armError, p.env, p.runPlan, p.result].forEach(function (f) {
        try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    });
    try { fs.rmdirSync(RUN_DIR); } catch (e) {}
}

/* The LD_PRELOAD the unit sets itself (carplay.service's Environment=,
 * BMW's libschedconfig), kept in front of ours. */
function unitPreload(unit) {
    var out = '';
    try { out = cp.execFileSync(SYSTEMCTL, ['show', unit, '-p', 'Environment'], { timeout: 10000, encoding: 'utf8' }); } catch (e) { return null; }
    var m = /(?:^Environment=|\s)LD_PRELOAD=(\S+)/m.exec(out);
    return m ? m[1] : '';
}

function unitUser(unit) {
    var out = '';
    try { out = cp.execFileSync(SYSTEMCTL, ['show', unit, '-p', 'User'], { timeout: 10000, encoding: 'utf8' }); } catch (e) { return null; }
    var m = /^User=(\S+)/m.exec(out);
    return m ? m[1] : null;
}

function uidOf(user) {
    var lines = (readOr(PASSWD, 'utf8') || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
        var f = lines[i].split(':');
        if (f[0] === user && f.length > 3) return { uid: parseInt(f[2], 10), gid: parseInt(f[3], 10) };
    }
    return null;
}

/* Whether this boot's next start is armed with the current plan and this
 * version's library. */
function armed(name) {
    var rec = current(name), p = paths(name), plan = readOr(p.runPlan), env = readOr(p.env, 'utf8');
    return !!rec && !!env && !!plan && sha256(plan) === rec.planSha256 && env.split('\n')[0].split(/[=\s]/).indexOf(LIB) >= 0;
}

/* Why the last arm failed (kept on /var/opt for the status), or null. */
function armError(name) { return readOr(paths(name).armError, 'utf8'); }

/* Arms the service's next starts this boot: the plan, the result file and
 * last the env file in RUN_DIR. Nothing when the record is not current or
 * enabled, or this boot is armed with it already (the result of a run is
 * kept). {armed: true} or {armed: false, why}. Never throws. */
function arm(name, opts) {
    opts = opts || {};
    var t = TARGETS[name], p = paths(name), rec = current(name);
    if (!rec) return { armed: false, why: 'no enabled in-memory patch for ' + t.target + ' as it is' };
    if (armed(name)) return { armed: true, already: true };
    /* Armed with this plan, the library path aside (an update in this boot):
     * only the env file is written again, so a run's result is kept. */
    var plan0 = readOr(p.runPlan), keepResult = !!plan0 && sha256(plan0) === rec.planSha256 && !!readOr(p.result);
    try {
        if (!fs.existsSync(LIB)) throw new Error(LIB + ' missing');
        var pre = opts.preload !== undefined ? opts.preload : unitPreload(t.unit);
        if (pre === null) throw new Error('cannot read ' + t.unit + '\'s environment');
        if (/\s/.test(LIB)) throw new Error('unusable preload path ' + LIB);
        pre = pre.split(/[\s:]+/).filter(function (x) { return x && x !== LIB; }).join(' ');
        var user = opts.user !== undefined ? opts.user : unitUser(t.unit), ids = user ? uidOf(user) : null;
        if (!ids) throw new Error('no user for ' + t.unit);
        try { fs.mkdirSync(RUN_DIR, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        var rd = fs.lstatSync(RUN_DIR);
        if (!rd.isDirectory() || rd.uid !== (process.getuid ? process.getuid() : rd.uid)) throw new Error(RUN_DIR + ' is not our folder');
        fs.chmodSync(RUN_DIR, 0o755);
        if (!keepResult) {
            writeWhole(p.runPlan, fs.readFileSync(p.plan), 0o644);
            try { fs.unlinkSync(p.result); } catch (e) {}
            var fd = fs.openSync(p.result, 'wx', 0o644);
            fs.closeSync(fd);
            fs.chmodSync(p.result, 0o644);
            if (process.getuid && process.getuid() === 0) fs.chownSync(p.result, ids.uid, ids.gid);
        }
        writeWhole(p.env, 'LD_PRELOAD=' + (pre ? pre + ' ' : '') + LIB + '\nWOC_PATCH_PLAN=' + p.runPlan + '\nWOC_PATCH_RESULT=' + p.result + '\n', 0o644);
        try { fs.unlinkSync(p.armError); } catch (e) {}
        return { armed: true };
    } catch (e) {
        disarm(name);
        try { ensureDir(STATE_DIR); writeWhole(p.armError, e.message + '\n'); } catch (e2) {}
        return { armed: false, why: e.message };
    }
}

/* The next start runs stock: the env file goes first. Never throws;
 * false when it could not be removed. */
function disarm(name) {
    var p = paths(name), ok = true;
    [p.env, p.runPlan].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') ok = false; } });
    return ok;
}

/* The library's result of this boot: {pid, applied, edits, why}, or null. */
function result(name) {
    var r = null;
    try { r = JSON.parse(fs.readFileSync(paths(name).result, 'utf8')); } catch (e) { return null; }
    return r && r.v === 1 ? r : null;
}

/* The plan's edits ([{name, va, stock, patched}]), or null. */
function planEdits(text) {
    var p = require('./carplay_patch.js').parsePlan(text);
    return p.err ? null : p.edits;
}

/* What the process pid holds at the plan's sites, read from
 * /proc/<pid>/mem (root, read-only): 'patched' (every site), 'stock'
 * (every site), 'mixed', or null when it cannot be read. The base is the
 * first mapping, at file offset 0, of the file the process runs: its
 * /proc/<pid>/exe, or (a binary translator's exe) the target or a file a
 * change replaced while it ran (<target>.woc-running*). */
function memState(name, pid, planText) {
    var t = TARGETS[name], edits = planEdits(planText || readOr(paths(name).plan, 'utf8') || '');
    if (!edits || !(pid > 0)) return null;
    var inodes = [], exe = path.join(PROC, String(pid), 'exe'), exeName = '';
    try { exeName = path.basename(fs.readlinkSync(exe)); } catch (e) {}
    [exeName.indexOf(path.basename(t.target)) === 0 ? exe : null, t.target, t.target + '.woc-running', t.target + '.woc-running.1', t.target + '.woc-running.2'].forEach(function (f) {
        if (f) try { inodes.push(fs.statSync(f).ino); } catch (e) {}
    });
    var maps = readOr(path.join(PROC, String(pid), 'maps'), 'utf8');
    if (!maps) return null;
    var base = null;
    maps.split('\n').some(function (l) {
        var f = l.split(/\s+/);
        if (f.length < 6 || parseInt(f[2], 16) !== 0 || inodes.indexOf(Number(f[4])) < 0) return false;
        base = parseInt(f[0].split('-')[0], 16);
        return true;
    });
    if (base === null) return null;
    /* A region the plan leaves as it ships (the sink in the avb mode) must
     * read so either way: a process running another mode's sink is
     * neither. */
    var fd, seen = { patched: 0, stock: 0, other: 0 }, changed = 0;
    try {
        fd = fs.openSync(path.join(PROC, String(pid), 'mem'), 'r');
        edits.forEach(function (e) {
            var b = Buffer.alloc(e.stock.length);
            fs.readSync(fd, b, 0, b.length, base + e.va);
            if (e.stock.equals(e.patched)) { if (!b.equals(e.stock)) seen.other++; return; }
            changed++;
            seen[b.equals(e.patched) ? 'patched' : b.equals(e.stock) ? 'stock' : 'other']++;
        });
    } catch (e) { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
    return seen.other ? 'mixed' : seen.patched === changed ? 'patched' : seen.stock === changed ? 'stock' : 'mixed';
}

module.exports = {
    TARGETS: TARGETS, paths: paths, readRecord: readRecord, current: current, kind: kind, describes: describes, update: update,
    makePlan: makePlan, refusal: refusal, armError: armError, adopt: adopt, planFailed: planFailed, disable: disable, remove: remove, arm: arm, armed: armed, disarm: disarm, result: result, memState: memState,
    LIB: LIB, RUN_DIR: RUN_DIR,
};
