#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* recovery.js — the safety net for the carplay and aapd patches (PATCH.md
 * "Boot recovery"). A patch that makes the head unit restart, whether the
 * patched binary crashes or another process does, loops it with the patched
 * binary still on disk and no HMI to turn the patch off. Each service has
 * its own counter. On a head unit that refuses our parts (head_unit.js) a
 * patch of ours is restored before its service starts, whatever the
 * counter.
 *
 *   recovery.js boot [carplay|aapd]
 *                      waze-on-cluster-boot.service (carplay) and
 *                      waze-on-cluster-aa-boot.service (aapd), oneshots
 *                      ordered before their service: count the previous
 *                      boot, record this one before the service starts
 *                      and, at the threshold, restore the original first.
 *                      The carplay step also keeps a copy of recmgr's and
 *                      crashhandler's restart records for Save logs
 *                      (keepRestartRecords).
 *   recovery.js        waze-on-cluster-recovery.service: watches both for
 *                      the rest of the boot, records each crash the moment
 *                      it is seen and a healthy start once the service has
 *                      run HEALTHY_MS. A run that healthy of a patch on
 *                      trial (patch_record.js) records the patch proven.
 *                      Where recmgr loaded a service's entry
 *                      it also restores at the threshold and starts the
 *                      service again, for as long as the head unit stays up.
 *
 * The boot step decides from small files only: the backup's presence, the
 * patch record (patch_record.js: whether the binary about to start is our
 * patch, and whether it counts as proven), the service's state file, the previous
 * boot's shutdown mark and, without one, the restart records of recmgr and
 * crashhandler. It reads a binary only to restore it.
 *
 * A service's state ({fails, unknown, arm, prev, starts, ended, log}): fails,
 * the failed patched boots and crashes since the last healthy boot;
 * unknown, the patched boots in a row since then that ended with no
 * record; arm, this boot's record ({boot, at, patch, crashes, ran,
 * confirmed, seen, lastAt, crashKey, clean}), written before a patched
 * binary starts; prev,
 * the last boot counted; starts ({boot, n}), the starts made this boot;
 * ended ({boot, run}), the last run whose end was handled; log, the newest
 * LOG_MAX lines of how each boot was counted, crashes and restores, for
 * Save logs. At the next boot the armed boot counts only on evidence
 * (tally): a crash of the service, or a restart recmgr or crashhandler
 * recorded. A healthy boot clears the count, an orderly one (a switch-off,
 * a restart asked for) or one the service never ran in keeps it, and two
 * boots in a row with no record at all count one, unless the head unit
 * was off OFF_MS after it (offOf). A proven patch is restored at 2 failed boots
 * or crashes with no healthy boot between, an unproven one at 1
 * (THRESHOLD).
 *
 * shutdown_mark.sh (a var-opt-ro.service drop-in) records at each NSM
 * shutdown, before /var/opt goes read-only, whether each service was
 * running, failed or stopped, "crash" when recmgr or crashhandler asked
 * for that restart, and the boot's uptime. An orderly reboot stops the
 * watcher while the system is stopping (arm.clean); patchd records a
 * restart the user asked for in restart-requested.
 *
 * The restore writes the backup whole, verified against the SHA-256 its
 * record took (or, with no record, the shipped file's SHA-256), over a
 * target of the backup's own build, atomically and
 * fsynced, with the original's mode and owner set explicitly (file_mode.js),
 * under the remount lock shared with patchd, with / read-write
 * only for the write. Before anything else each boot step gives a file
 * that holds exactly its original but lacks the access the service's user
 * needs (carplay or aapd not readable and executable by group and other,
 * aapd.conf not readable by them, as a write
 * under umask 077 leaves them) its original's mode and owner, nothing
 * else. Each remount is bounded (STEP_MS); a boot step gives
 * up at BOOT_BOUND_MS whatever hangs and exits by BOOT_EXIT_MS, after one
 * bounded try to put / back read-only. It never kills, restarts or reboots
 * anything; the only start is `systemctl start` of the service after a
 * crash or a SIGKILL patchd did not send, never stop or restart: carplay's
 * bounded by START_DELAYS_MS per boot, aapd's after every end of it, a
 * clean exit too, spaced by AA_START_DELAYS_MS. A crash of the patched aapd
 * turns its patch off at once (crashThreshold), before that start, so
 * Android Auto comes back stock and stays so until its Patch button or an
 * update with a newer patch revision applies the patch again.
 *
 * Both patches are applied in memory (inmem.js): a restore of one turns it
 * off, and only a patch an earlier release wrote to the files is put back
 * by writing them.
 *
 * Node 8.16.2 on the unit. No dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var record = require('./patch_record.js');
var lock = require('./remount_lock.js');
var headUnit = require('./head_unit.js');
var recmgr = require('./recmgr_list.js');
var fileMode = require('./file_mode.js');
var inmem = require('./inmem.js');

/* ExecMainCode of a main process a signal ended without a core dump. */
var CLD_KILLED = '2';

/* aapd's starts after its ends, by the ends in a row with no healthy run
 * between (the last delay repeats; a healthy run starts the row again):
 * quick at first, never more often than once a minute after that, and with
 * no limit, so Android Auto comes back whenever aapd can run. */
var AA_START_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];

/* What is watched and restored, per service. state: the counter; mark:
 * written by shutdown_mark.sh; restart: patchd's record of a restart the
 * user asked for; pending: patchd's marker of a change waiting for the next
 * start; killed: the run (InvocationID) patchd kills to activate a change,
 * whose end is not a crash; running: the patched binary, kept hard-linked
 * while restoring so replacing the target by rename does not leave an
 * unlinked-but-open file that blocks the read-only remount (patchd.js keeps
 * the same link); files: what a restore writes, the binary first; check(i,
 * cur): files[i]'s verified backup by the patcher's own checks, {buf, other
 * (why cur is not its build or file, or null), orig (its record: the
 * original's mode and owner, when kept)} or {err}, null without one;
 * stock(i, cur): whether cur is files[i] as a build the patcher knows the
 * shipped file of (SHIPPED) ships it;
 * floors: the bits each file must have for the service's user (file_mode.js);
 * killedRun: how a SIGKILL
 * that is no crash ends the run. carplay's drop-in makes SIGKILL a
 * success; aapd.service has none, so SIGKILL ends it failed with
 * Result=signal. */
function targets(o) {
    var dir = path.dirname(o.state), shm = path.dirname(o.sock), restart = path.join(dir, 'restart-requested');
    var sin = o.sin || '/var/opt/public/sin', restartInfo = [path.join(sin, 'recmgr', 'restartInfo.xml'), path.join(sin, 'crashhandler', 'restartInfo.xml')];
    var t = {
        carplay: {
            name: 'carplay', unit: 'carplay.service', target: o.carplay, files: [o.carplay], floors: [fileMode.EXEC],
            /* the patch applied in memory (inmem.js): armed per start, never written to the file */
            inmem: true,
            /* our edits in the file beside another change (a conflict) */
            foreignIn: function () { return require('./carplay_patch.js').foreignIn(o.carplay); },
            /* the plan's arguments for a patch in the file put back (drec, its record) */
            planArgs: function (drec) {
                return ['--panel', 'high', '--coding', CODING];
            },
            check: function (i, cur) {
                if (!exists(o.carplay + '.woc-orig')) return null;
                var cpp = require('./carplay_patch.js'), b = cpp.trustedBackup(o.carplay, cur || Buffer.alloc(0));
                var stock = Object.keys(cpp.SHIPPED).some(function (id) { return cpp.SHIPPED[id].sha256 === b.hash; });
                if (b.err) return b;
                if ((!b.meta || !b.meta.sha256_original) && !stock) return { err: 'no record of its SHA-256' };
                return { buf: b.buf, other: cur ? b.other : null, orig: b.meta };
            },
            stock: function (i, cur) {
                var cpp = require('./carplay_patch.js'), h = sha256(cur);
                return Object.keys(cpp.SHIPPED).some(function (id) { return cpp.SHIPPED[id].sha256 === h; });
            },
            backups: [o.carplay + '.woc-orig'], state: o.state, mark: path.join(dir, 'shutdown'), restart: restart, restartInfo: restartInfo,
            pending: path.join(shm, 'activation-pending'), killed: path.join(shm, 'carplay-killed'), running: o.carplay + '.woc-running',
            killedRun: function (i) { return i.state === 'inactive' && i.result === 'success' && i.code === CLD_KILLED && i.status === '9'; },
        },
        aapd: {
            name: 'aapd', unit: 'aapd.service', target: o.aapd, files: [o.aapd, o.aapdConf], floors: [fileMode.EXEC, fileMode.READ],
            inmem: true,
            foreignIn: function () { return require('./aapd_patch.js').foreignIn({ target: o.aapd, conf: o.aapdConf, coding: CODING }); },
            /* the owner's density and turn-card setting, as patchd plans them */
            planArgs: function (drec) {
                var ac = require('./aapd_conf.js'), dpi = parseInt(readText(path.join(dir, 'aa-density')), 10), card = readText(path.join(dir, 'aa-card')).trim();
                if (ac.DENSITIES.indexOf(dpi) < 0) dpi = ac.DEFAULT_DPI;
                if (ac.CARDS.indexOf(card) < 0) card = ac.DEFAULT_CARD;
                return ['--conf', o.aapdConf, '--coding', CODING, '--dpi', String(dpi), '--card', card];
            },
            check: function (i, cur) {
                var ap = require('./aapd_patch.js'), f = i ? o.aapdConf : o.aapd;
                var b = exists(f + '.woc-orig.json') ? ap.trusted(f) : stockBackup(f, aapdStock(i));
                if (!b || b.err) return b;
                return { buf: b.buf, other: !cur ? null : i ? require('./aapd_conf.js').otherFile(cur.toString('utf8'), b.buf.toString('utf8'))
                    : require('./aapd_patch.js').binOther(cur, b.buf), orig: b.meta || null };
            },
            stock: function (i, cur) { return aapdStock(i).indexOf(sha256(cur)) >= 0; },
            backups: [o.aapd + '.woc-orig', o.aapdConf + '.woc-orig'], state: path.join(dir, 'aa-boot-recovery.json'),
            mark: path.join(dir, 'shutdown-aapd'), restart: restart, restartInfo: restartInfo,
            pending: path.join(shm, 'aa-pending'), killed: path.join(shm, 'aapd-killed'), running: o.aapd + '.woc-running',
            killedRun: function (i) { return (i.state === 'failed' || i.state === 'inactive') && i.result === 'signal' && i.code === CLD_KILLED && i.status === '9'; },
            /* Android Auto must not stay down: a crash of the patched aapd
             * restores the original at once, and every end of aapd is
             * followed by a start (AA_START_DELAYS_MS), a clean exit too. */
            crashThreshold: 1, startDelays: AA_START_DELAYS_MS, restartOnExit: true,
        },
    };
    t.carplay.other = t.aapd;
    t.aapd.other = t.carplay;
    return t;
}
function sha256(buf) { return require('crypto').createHash('sha256').update(buf).digest('hex'); }

/* The SHA-256 of each shipped aapd (i 0) or aapd.conf (1) the patcher
 * knows (SHIPPED). */
function aapdStock(i) {
    if (i) return [require('./aapd_conf.js').SHIPPED.sha256];
    var shipped = require('./aapd_patch.js').SHIPPED;
    return Object.keys(shipped).map(function (id) { return shipped[id].sha256; });
}

/* A backup without its record ({buf}, or {err}), null without one: trusted
 * only when it is a shipped file the patcher knows (hashes). */
function stockBackup(file, hashes) {
    var buf;
    try { buf = fs.readFileSync(file + '.woc-orig'); } catch (e) { return null; }
    return hashes.indexOf(sha256(buf)) >= 0 ? { buf: buf } : { err: file + '.woc-orig has no record and is not a shipped file' };
}

var TARGETS = targets({
    state: process.env.WOC_RECOVERY_STATE || path.join(process.env.WOC_STATE_DIR || '/var/opt/waze-on-cluster', 'boot-recovery.json'),
    sock: process.env.WOC_PATCH_SOCK || '/dev/shm/waze-on-cluster/patch.sock',
    carplay: process.env.WOC_CARPLAY || '/usr/bin/carplay',
    aapd: process.env.WOC_AAPD || '/usr/bin/aapd',
    aapdConf: process.env.WOC_AAPD_CONF || '/etc/aapd.conf',
    sin: process.env.WOC_SIN_DIR,
});
/* recmgr's and crashhandler's restart records, which each deletes at its
 * start, kept for Save logs by the carplay boot step (keepRestartRecords),
 * each scrubbed of VINs and cut at RECORD_MAX bytes, those of the newest
 * RECORD_BOOTS boots. */
var RECORDS = process.env.WOC_RESTART_RECORDS || '/var/opt/waze-on-cluster/restart-records';
var RECORD_MAX = 64 * 1024;
var RECORD_BOOTS = 5;
var MOUNT = process.env.WOC_MOUNT || '/bin/mount';
/* The cluster coding the plan reads (carplay_patch.js plan --coding). */
var CODING = process.env.WOC_CODING || '/dev/shm/rawcodingdata';
var PROC_MOUNTS = process.env.WOC_PROC_MOUNTS || '/proc/mounts';
var PROC = process.env.WOC_PROC || '/proc';
var boot = require('./boot_id.js');
var SYSTEMCTL = process.env.WOC_SYSTEMCTL || 'systemctl';

/* Copies t's restart records into dir as <n>-<id>-<who>.xml (n counts the
 * boots that kept one, so the order needs no clock: this step runs before
 * the head unit sets it), each VIN-scrubbed and cut to RECORD_MAX as Save
 * logs does (logs_extra.js), 0640 in a 2770 folder of group systemd-journal
 * (group_dir.js; opts its uid and group file, for tests), a temporary file
 * renamed into place. Drops those of all but the newest RECORD_BOOTS boots
 * and stray temporary files; returns how many it copied. Without a record
 * it writes nothing. */
function keepRestartRecords(t, dir, id, opts) {
    if (!t.restartInfo.some(exists)) return 0;
    var extra = require('./logs_extra.js'), found = [];
    t.restartInfo.forEach(function (f) {
        var src = extra.readSource(f, RECORD_MAX);
        if (src) found.push({ who: path.basename(path.dirname(f)), buf: extra.redact(src.text, RECORD_MAX, src.more) });
    });
    if (!found.length) return 0;
    require('./group_dir.js').groupDir(dir, 'systemd-journal', opts);
    id = id || 'unknown';
    var kept = [];
    fs.readdirSync(dir).forEach(function (name) {
        if (/\.xml\.tmp$/.test(name)) { fs.unlinkSync(path.join(dir, name)); return; }
        var m = /^(\d+)-(.+)-[a-z]+\.xml$/.exec(name);
        if (m) kept.push({ name: name, n: Number(m[1]), boot: m[2] });
    });
    var mine = kept.filter(function (k) { return k.boot === id; })[0];
    var n = mine ? mine.n : kept.reduce(function (max, k) { return Math.max(max, k.n); }, 0) + 1, copied = 0;
    found.forEach(function (r) {
        var name = n + '-' + id + '-' + r.who + '.xml', dest = path.join(dir, name);
        if (exists(dest)) return;
        fs.writeFileSync(dest + '.tmp', r.buf, { mode: 0o640 });
        fs.chmodSync(dest + '.tmp', 0o640);
        fs.renameSync(dest + '.tmp', dest);
        kept.push({ name: name, n: n, boot: id });
        copied++;
    });
    var newest = kept.map(function (k) { return k.n; }).filter(function (v, i, all) { return all.indexOf(v) === i; })
        .sort(function (a, b) { return b - a; }).slice(0, RECORD_BOOTS);
    kept.forEach(function (k) { if (newest.indexOf(k.n) < 0) fs.unlinkSync(path.join(dir, k.name)); });
    return copied;
}

/* Failed boots or crashes before a restore: a patch the record does not
 * call proven (a patch on trial, which every build is until it ran healthy
 * on this car) is restored at its first, a proven
 * one at its second; a binary of the backup's build the record does not
 * describe counts as proven. */
var THRESHOLD = { proven: 2, unknown: 2, unproven: 1 };
/* A start is healthy once the service has run this long without a break:
 * past the head unit's own start-up (its services up and connected) and a
 * phone's CarPlay or Android Auto session, which an attached phone opens
 * within it. */
var HEALTHY_MS = parseInt(process.env.WOC_RECOVERY_HEALTHY_MS, 10) || 60000;
/* While the patched service runs healthy, the watcher records when it
 * last saw it so (arm.seen, the wall clock), this often. */
var SEEN_MS = parseInt(process.env.WOC_RECOVERY_SEEN_MS, 10) || 60000;
/* A start that ended with no record, its patched service last seen healthy
 * at least this long before the next start began, ended as a parked car's
 * does. A loop's reset comes at most SEEN_MS after the last seen time, and
 * its next start seconds after the reset (offOf). */
var OFF_MS = parseInt(process.env.WOC_RECOVERY_OFF_MS, 10) || 3 * 60000;
/* The time the head unit keeps from its last shutdown, which it can start
 * on before it gets the real time, is no later than this after the last
 * time a start before was seen or armed: a heartbeat, the shutdown after
 * it and the next boot's start-up (offOf). */
var KEPT_MS = SEEN_MS + 60000;
/* No wall clock before this is a set one: the head unit starts at its
 * software's build time until the time is set. */
var CLOCK_FLOOR_MS = Date.UTC(2025, 0, 1);
/* recmgr's crash table, where every service failure it handles adds a row
 * (its newest key read with the firmware's sqlite3, killed after
 * SQLITE_MS). */
var RECMGR_DB = (process.env.WOC_SIN_DIR || '/var/opt/public/sin') + '/recmgr/recmgr_stats.db';
var SQLITE = process.env.WOC_SQLITE || 'sqlite3';
var SQLITE_MS = 2000;
/* The entries the state keeps of how each start was counted and what was
 * restored (state.log), for Save logs: the newest LOG_MAX, each at most
 * LOG_LINE characters. */
var LOG_MAX = 16;
var LOG_LINE = 240;
var TICK_MS = parseInt(process.env.WOC_RECOVERY_TICK_MS, 10) || 1000;
/* systemctl is asked this often while the service is down; while its main
 * PID is in /proc, which every tick checks, only every ALIVE_PROBE_MS, as a
 * backstop. */
var PROBE_MS = 5000;
var ALIVE_PROBE_MS = 60000;
var START_DELAYS_MS = [5000, 15000, 60000];
/* A patch on trial that could not be recorded proven (the remount lock
 * held, a remount that failed) is tried again this much later. */
var PROVE_RETRY_MS = 60000;
/* How far a file's modification time may stray from the clock: file
 * systems stamp with a coarser one. */
var FS_CLOCK_MS = 1000;
/* The bound on each remount. */
var STEP_MS = parseInt(process.env.WOC_RECOVERY_STEP_MS, 10) || 10000;
var RO_TRIES = 2;
/* Reading, hashing and writing the files of one restore. */
var IO_MS = STEP_MS / 2;
/* A restore: remount rw, the writes, two read-only tries 500 ms apart. */
var RESTORE_BOUND_MS = STEP_MS * (1 + RO_TRIES) + 500 * (RO_TRIES - 1) + IO_MS;
/* The two boot steps run side by side and share the remount lock: a boot
 * step waits this long for the other's restore. */
var BOOT_LOCK_WAIT_MS = STEP_MS;
/* A boot step gives up at BOOT_BOUND_MS whatever hangs, then takes up to
 * STEP_MS more to put / back read-only: it exits by BOOT_EXIT_MS, which the
 * boot units' timeouts cover. */
var BOOT_BOUND_MS = BOOT_LOCK_WAIT_MS + RESTORE_BOUND_MS;
var BOOT_EXIT_MS = BOOT_BOUND_MS + STEP_MS + 500;
/* A plan still to make, at the boot step: the coding waited for, the plan's
 * own bound (both well inside BOOT_BOUND_MS). */
var BOOT_CODING_WAIT_MS = 5000;
var BOOT_PLAN_MS = 15000;

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }
function monoMs() { var t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }
function exists(f) { return fs.existsSync(f); }
function log(line) { process.stdout.write('[' + new Date().toISOString() + '] recovery: ' + line + '\n'); }

/* What t's target holds, from the backup's presence and the patch record:
 * 'none' (no backup of ours), 'original', our patch of a 'proven' or
 * 'unproven' build, or 'unknown' (a backup of ours beside a target the
 * record does not describe). */
function patchKind(t) {
    var k = inmemKind(t);
    if (k) return k;
    if (!t.backups.some(exists)) return 'none';
    var rec = record.current(t.target);
    return !rec ? 'unknown' : !rec.patched ? 'original' : rec.proven ? 'proven' : 'unproven';
}

/* The kind of t's in-memory patch ('proven' or 'unproven'), or null when
 * none is enabled for the file as it is (inmem.js). */
function inmemKind(t) { return t.inmem ? inmem.kind(t.name) : null; }

/* Boot recovery's restore of an in-memory patch: the next start of this
 * boot runs stock (the env file goes), then the record is turned off, so
 * no later start is armed. No file of / is written. cb(err, outcome). */
function disarmTarget(t, fails, why, refused, cb) {
    if (!inmem.disarm(t.name)) { cb(new Error('could not remove ' + inmem.paths(t.name).env)); return; }
    try {
        inmem.disable(t.name, refused ? { by: 'refused' } : { by: 'recovery', fails: fails, why: why || 'boot' });
    } catch (e) { cb(new Error('the next start is stock; turning the patch off failed: ' + e.message)); return; }
    cb(null, 'restored');
}

/* Whether a file besides the binary (aapd.conf) still differs from its
 * verified backup: part of a patch a restore did not get to. */
function leftover(t) {
    return t.files.slice(1).some(function (f, i) {
        var p = restorePlan(t, i + 1);
        return !!p && !!p.out;
    });
}

/* t's shutdown mark of boot: {state: running|failed|stopped, crash, ran:
 * systemd started the service in that boot, up: the boot's uptime in s, or
 * null}. */
function markOf(t, id) {
    var text = readText(t.mark), m = /^(\S+) (running|failed|stopped)( crash)?( ran)?(?: up (\d+))?\s*$/.exec(text);
    return m && m[1] === id ? { state: m[2], crash: !!m[3], ran: !!m[4], up: m[5] === undefined ? null : parseInt(m[5], 10), text: text.trim().slice(0, 160) } : null;
}

/* A restart record of recmgr or crashhandler written in the armed boot: at
 * or after the arm, before this boot started (/proc/stat's btime), and not
 * ahead of the clock, each within FS_CLOCK_MS. */
function restartRecorded(t, arm, now, started) {
    return !!arm.at && t.restartInfo.some(function (f) {
        var at;
        try { at = fs.statSync(f).mtime.getTime(); } catch (e) { return false; }
        return at >= arm.at - FS_CLOCK_MS && at <= now + FS_CLOCK_MS && (started === null || at <= started + FS_CLOCK_MS);
    });
}

/* Whether t's other service was armed in boot and crashed in it: a crash
 * its watcher recorded, or its shutdown mark. */
function otherCrashed(t, boot) {
    var o = t.other, st = null;
    try { st = JSON.parse(fs.readFileSync(o.state, 'utf8')); } catch (e) { return false; }
    var arms = [st && st.arm, st && st.prev].filter(function (a) { return !!a && a.boot === boot; });
    if (!arms.length) return false;
    var m = markOf(o, boot);
    return arms.some(function (a) { return a.crashes > 0; }) || (!!m && m.state === 'failed');
}

/* How the armed boot arm ended for t, now the clock reads now and this boot
 * started at started (null: unknown): its shutdown mark's service state;
 * crash, evidence of a restart recmgr or crashhandler asked for (the mark
 * says so, or, with no mark, their record of that boot); orderly, a
 * switch-off or a restart asked for (a mark without crash from a boot that
 * lasted the healthy window, patchd's restart-requested, the watcher
 * stopped while the system stopped), or a parked car's end (parked); off,
 * the time off in ms or null (offOf); mark, the mark as written; asked, a
 * restart asked for; neverRan, the service never ran in it (stopped at the
 * shutdown, never started by systemd nor seen running, no crash);
 * explained, the other service's patch crashed in it. A mark without crash
 * from a shorter boot is none of these: it may be a crash restart whose
 * record was missed, so it counts as a boot with no record.
 *
 * parked: no mark and no restart record, the time off OFF_MS or more, and
 * recmgr's crash table (its newest key, crashKey(), read only then) no
 * newer than at the arm. A key that cannot be read, now or at the arm,
 * tells nothing (untold): not parked. */
function endOf(t, arm, now, started, crashKey) {
    var m = markOf(t, arm.boot), long = !!m && m.up !== null && m.up * 1000 >= HEALTHY_MS;
    var asked = readText(t.restart).trim() === arm.boot, crash = m ? m.crash : restartRecorded(t, arm, now, started);
    var off = m || crash ? null : offOf(arm, now, started), key = null, failure = false, untold = false;
    if (off !== null && off >= OFF_MS) {
        key = typeof arm.crashKey === 'number' ? crashKey() : null;
        untold = typeof key !== 'number';
        failure = !untold && key > arm.crashKey;
    }
    var parked = off !== null && off >= OFF_MS && !untold && !failure;
    return {
        state: m ? m.state : null,
        crash: crash,
        orderly: arm.clean || asked || (!!m && !m.crash && long) || parked,
        neverRan: !!m && m.state === 'stopped' && !m.ran && !arm.ran && !arm.crashes,
        explained: otherCrashed(t, arm.boot),
        mark: m ? m.text : null,
        asked: asked,
        off: off,
        parked: parked,
        failure: failure,
        untold: untold,
    };
}

/* How long the head unit was off after the armed boot arm: from the last
 * time the watcher saw its patched service healthy (arm.seen) to this
 * boot's start (started), in ms, both by the wall clock; null when that
 * cannot be told. A clock not yet set reads before CLOCK_FLOOR_MS, and one
 * set back to an earlier time (the time kept from an earlier shutdown,
 * before the real time comes) reads too early: either makes the time off
 * shorter or negative, never longer, so a wrong clock now only takes the
 * start for a short one. A seen before the boot's arm, or before
 * CLOCK_FLOOR_MS, was stamped by a clock not set yet: null. So is a boot
 * armed less than KEPT_MS after the start before it was last seen or
 * armed (lastAt): it may have run on the time kept from its last shutdown
 * throughout, and its seen would then be as early as that shutdown. */
function offOf(arm, now, started) {
    if (!arm.seen || !arm.at || started === null || arm.seen < CLOCK_FLOOR_MS || arm.at < CLOCK_FLOOR_MS || arm.seen < arm.at) return null;
    if (!arm.lastAt || arm.at - arm.lastAt < KEPT_MS) return null;
    if (started < arm.seen || started > now + FS_CLOCK_MS) return null;
    return started - arm.seen;
}

/* recmgr's newest crash key in db (default RECMGR_DB), or null when it
 * cannot be read. */
function recmgrCrashKey(db) {
    var r;
    db = db || RECMGR_DB;
    try {
        if (!fs.statSync(db).isFile()) return null;
        r = cp.spawnSync(SQLITE, ['file:' + db + '?mode=ro', 'SELECT COALESCE(MAX(CrashKey), 0) FROM Crash;'],
            { cwd: '/', encoding: 'utf8', timeout: SQLITE_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return null; }
    var n = r && r.status === 0 ? parseInt((r.stdout || '').trim(), 10) : NaN;
    return isNaN(n) ? null : n;
}

/* The count ({fails, unknown}) after an armed boot (arm) that ended as end
 * says, and why. A crash of the service counts each time. Otherwise a
 * healthy boot clears the count; a boot the service never ran in counts
 * nothing; a crash restart counts one, unless the other service's patch
 * crashed in it (it counts there); an orderly end counts nothing. A boot
 * that ended with no record (a power cut, a 12 V disconnect, a dealer
 * tool, or a restart whose records were lost) is unknown: two in a row
 * count one, so a loop that leaves no record is still caught; one after
 * which the head unit was off OFF_MS is an orderly end (endOf). */
function tally(count, arm, end) {
    var crashes = arm.crashes || (end.state === 'failed' ? 1 : 0);
    if (crashes) return { fails: count.fails + crashes, unknown: 0, own: true, why: 'saw ' + crashes + ' crash' + (crashes === 1 ? '' : 'es') + ' of the service' };
    /* A start armed in memory clears the count only when it ran healthy and
     * ended in order (a switch-off or restart with its shutdown mark, a
     * restart asked for, or no record and the head unit off OFF_MS after
     * it): a restart for a crash counts even after a healthy run, and a
     * healthy run that ended with no record and a short time off (a reset
     * that beat the shutdown mark) counts as a boot with no record, two in a
     * row one failure. */
    if (arm.confirmed && !(arm.inmem && (end.crash || !end.orderly))) {
        return { fails: 0, unknown: 0, why: end.parked ? 'ran healthy; no record, then off ' + Math.round(end.off / 60000) + ' min' : 'ran healthy' };
    }
    if (end.neverRan) return { fails: count.fails, unknown: count.unknown, why: 'ended before the service ran' };
    if (end.explained) return { fails: count.fails, unknown: 0, why: 'ended for the other service\'s crash' };
    if (end.crash) return { fails: count.fails + 1, unknown: 0, why: 'ended in a restart for a crash' };
    if (end.orderly) return { fails: count.fails, unknown: 0, why: 'ended in order' };
    if (count.unknown + 1 >= 2) return { fails: count.fails + 1, unknown: 0, why: 'is the second in a row to end with no record' };
    return { fails: count.fails, unknown: count.unknown + 1, why: 'ended with no record' };
}

/* ---- the restore ---- */

/* / is read-only per /proc/mounts (the last `/` entry is the effective root). */
function rootIsReadOnly() {
    try {
        var lines = fs.readFileSync(PROC_MOUNTS, 'utf8').split('\n');
        var opts = null;
        for (var i = 0; i < lines.length; i++) {
            var p = lines[i].split(' ');
            if (p[1] === '/') opts = p[3];
        }
        if (opts !== null) return /(^|,)ro(,|$)/.test(opts);
    } catch (e) {}
    return false;
}

function remount(rw, cb) {
    cp.execFile(MOUNT, ['-o', 'remount,' + (rw ? 'rw' : 'ro'), '/'], { timeout: STEP_MS }, function (err) { cb(err); });
}

function remountRo(tries, cb) {
    remount(false, function () {
        if (rootIsReadOnly()) { cb(null); return; }
        if (tries > 1) { setTimeout(function () { remountRo(tries - 1, cb); }, 500); return; }
        cb(new Error('/ is still read-write after remount'));
    });
}

/* What a restore of t.files[i] writes, or null when it has no backup of
 * ours: { out, want } (out null when the file holds it already; want, the
 * original's mode and owner, file_mode.js), { other } (another build or
 * file than the backup's: left as it is) or { err } (a backup neither its
 * record nor a shipped SHA-256 vouches for). */
function restorePlan(t, i) {
    var cur = null;
    try { cur = fs.readFileSync(t.files[i]); } catch (e) {}
    var b = t.check(i, cur);
    if (!b || b.err) return b;
    return cur && cur.equals(b.buf) ? { out: null } : b.other ? { other: b.other }
        : { out: b.buf, want: fileMode.wanted(t.files[i], b.orig, t.floors[i]) };
}

var fsyncPath = record.fsyncPath;

/* Permissions-only damage: the files of t that hold exactly their original
 * (the verified backup of ours, or a shipped file SHIPPED knows) but
 * lack the access the service's user needs, as a write under a restrictive
 * umask leaves them; [{file, want}]. One stat per file when none lacks it;
 * a file that does is read and checked. */
function damaged(t) {
    var out = [];
    t.files.forEach(function (f, i) {
        if (!fileMode.lacks(f, t.floors[i])) return;
        var cur, why = f + ' is not ' + (t.floors[i] === fileMode.EXEC ? 'readable and executable' : 'readable') + ' by ' + t.unit + '\'s user';
        try { cur = fs.readFileSync(f); } catch (e) { log(why + ' and cannot be read: ' + e.message); return; }
        var b = t.check(i, cur), orig = b && !b.err && cur.equals(b.buf);
        if (!orig && !t.stock(i, cur)) { log(why + ' but is not its original: left to the restore'); return; }
        out.push({ file: f, want: fileMode.wanted(f, orig ? b.orig : null, t.floors[i]) });
    });
    return out;
}

/* The damaged files of t given their original's mode and owner, nothing
 * else changed, under the shared remount lock (waited for up to waitMs), /
 * read-write only for that and read-only again after. cb(err, n): n, the
 * files set. */
function repairModes(t, waitMs, cb) {
    var list = damaged(t);
    if (!list.length) { cb(null, 0); return; }
    function locked() {
        writing = true;
        function finish(err) { writing = false; lock.release(); cb(err, err ? 0 : list.length); }
        remount(true, function (mErr) {
            if (mErr) { finish(new Error('remount rw: ' + mErr.message)); return; }
            var wErr = null;
            try {
                list.forEach(function (x) {
                    fileMode.repair(x.file, x.want);
                    log('set ' + x.file + ' to its original\'s mode 0' + x.want.mode.toString(8) + ' and owner ' + x.want.uid + ':' + x.want.gid);
                });
            } catch (e) { wErr = e; }
            remountRo(RO_TRIES, function (roErr) { finish(wErr || roErr); });
        });
    }
    if (waitMs) {
        lock.acquire(waitMs, function (got) {
            if (got) locked();
            else cb(new Error('remount lock held for ' + waitMs + ' ms; deferring'), 0);
        });
        return;
    }
    if (!lock.tryAcquire()) { cb(new Error('remount lock held; deferring'), 0); return; }
    locked();
}

/* Restore t's originals from its verified backups, under the shared remount
 * lock, / read-write only for the write and read-only again after; the
 * patch record then names the restore (fails: the count it was made at).
 * cb(err, outcome): 'restored', 'original' (nothing to write) or 'other'
 * (the binary is another build than the backup's: a firmware update; not
 * ours). A backup neither its record nor a shipped SHA-256 vouches
 * for is refused; aapd.conf in that state, or another file, is left while
 * aapd is restored. The
 * patched binary is hard-linked to t.running first so the rename does not
 * leave an unlinked-but-open file that would keep / writable: always in
 * the watcher, where the service can start between that check and the
 * rename (patchd removes the link once nothing runs it), and in the boot
 * step, which the service waits for, only when a process runs it. A link a
 * process still runs is that link already and stays. With both the link
 * and the target run by processes there is no name left to keep the target
 * linked, so the restore waits for the next boot. Without the lock (patchd
 * writes) it defers: the counter stays, so a later try restores. */
function restoreTarget(t, onlyIfRunning, fails, cb, waitMs, why) {
    var plans = t.files.map(function (f, i) { return restorePlan(t, i); });
    var bin = plans[0];
    if (!bin) { cb(new Error('no backup of ' + t.target)); return; }
    if (bin.err) { cb(new Error('refusing the backup: ' + bin.err)); return; }
    if (bin.other) { cb(null, 'other'); return; }
    plans.slice(1).forEach(function (p, i) { if (p && (p.err || p.other)) log(t.files[i + 1] + ' left as it is: ' + (p.err || 'another file than its backup: ' + p.other)); });
    var writes = [];
    plans.forEach(function (p, i) { if (p && p.out) writes.push({ file: t.files[i], buf: p.out, want: p.want }); });
    var rec = record.current(t.target), rev = rec && rec.rev || 1;
    /* On a head unit that refuses our parts nothing is remounted only to
     * correct the record. */
    var refused = headUnit.refused();
    if (!writes.length && why !== 'file' && ((rec && !rec.patched) || refused)) { cb(null, 'original'); return; }
    if (lock.holds(t.running, t.target) && lock.inUse(t.target)) { cb(new Error('processes run both ' + t.target + ' and ' + t.running + '; deferring')); return; }
    function locked() {
        var released = false;
        writing = true;
        function finish(err, outcome) { if (!released) { released = true; writing = false; lock.release(); } cb(err, outcome); }
        remount(true, function (mErr) {
            if (mErr) { finish(new Error('remount rw: ' + mErr.message)); return; }
            var wErr = null;
            try {
                if (writes.length && !lock.holds(t.running, t.target) && (!onlyIfRunning || lock.inUse(t.target))) {
                    try { fs.unlinkSync(t.running); } catch (e) {}
                    try { fs.linkSync(t.target, t.running); } catch (e) { log('keeping the running ' + t.name + ' linked failed: ' + e.message); }
                }
                writes.forEach(function (w) { fileMode.replace(w.file, w.buf, w.want); });
                /* The patches live in memory only: a patch in the files put
                 * back leaves no backup or record of ours beside them; a file
                 * left as it is (its backup not trusted, another file than
                 * its backup) keeps its backup. */
                var putBack = why === 'file' && t.inmem && writes.every(function (w) { return fs.readFileSync(w.file).equals(w.buf); });
                if (putBack) {
                    var gone = [record.recordPath(t.target)];
                    t.files.forEach(function (f, i) {
                        var pl = plans[i], b = t.backups[i];
                        if (pl && !pl.err && !pl.other && b) gone.push(b, b + '.json', b + '.tmp', b + '.json.tmp');
                    });
                    gone.forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } });
                } else record.write(t.target, !writes.length || why === 'file' ? { patched: false } : refused ? { patched: false, by: 'refused', at: new Date().toISOString() }
                    : { patched: false, by: 'recovery', at: new Date().toISOString(), fails: fails, why: why || 'boot', rev: rev });
                try { fs.unlinkSync(t.pending); } catch (e) {}   /* the pending patch is gone */
            } catch (e) { wErr = e; }
            remountRo(RO_TRIES, function (roErr) {
                if (wErr) finish(new Error('writing: ' + wErr.message + (roErr ? '; ' + roErr.message : '')));
                else finish(roErr, writes.length ? 'restored' : 'original');
            });
        });
    }
    if (waitMs) {
        lock.acquire(waitMs, function (got) {
            if (got) locked();
            else cb(new Error('remount lock held for ' + waitMs + ' ms; deferring'));
        });
        return;
    }
    if (!lock.tryAcquire()) { cb(new Error('remount lock held; deferring')); return; }
    locked();
}

/* Whether a restore holds the remount lock in this process. */
var writing = false;

/* A restore cut short (the boot step out of time): / is put back read-only,
 * one bounded try, and the lock released. */
function abandonRestore(cb) {
    if (!writing) { cb(); return; }
    remount(false, function () { writing = false; lock.release(); cb(); });
}

/* A patch in memory on trial recorded proven: its record (on /var/opt)
 * says so, under the remount lock so patchd does not write it meanwhile;
 * / is not remounted. */
function proveInmem(t, runsTarget, cb) {
    if (!lock.tryAcquire()) { cb(new Error('remount lock held; deferring')); return; }
    var wrote = false, err = null;
    try {
        var rec = inmem.current(t.name);
        if (rec && rec.trial === true && runsTarget()) { inmem.update(t.name, { proven: true, trial: false, provenAt: new Date().toISOString() }); wrote = true; }
    } catch (e) { err = new Error('writing: ' + e.message); }
    lock.release();
    cb(err, wrote);
}

/* ---- the service's run ---- */

/* t.unit's current run: its id (InvocationID, else the main process's start
 * time), main PID, ActiveState, Result, and how its main process ended
 * (ExecMainCode, a CLD_* code, and ExecMainStatus). */
function probeTarget(t, cb) {
    cp.execFile(SYSTEMCTL, ['show', t.unit, '-p', 'InvocationID', '-p', 'ExecMainStartTimestampMonotonic',
        '-p', 'MainPID', '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainCode', '-p', 'ExecMainStatus'], { timeout: STEP_MS }, function (err, out) {
        cb(parseShow((out || '') + ''));
    });
}

function parseShow(text) {
    function get(k) { var m = new RegExp('^' + k + '=(.*)$', 'm').exec(text); return m ? m[1].trim() : ''; }
    var start = get('ExecMainStartTimestampMonotonic');
    return {
        run: get('InvocationID') || (start && start !== '0' ? 't' + start : ''),
        pid: parseInt(get('MainPID'), 10) || 0,
        state: get('ActiveState'),
        result: get('Result'),
        code: get('ExecMainCode'),
        status: get('ExecMainStatus'),
        started: !!start && start !== '0',
    };
}

/* 'stopping' while a shutdown, reboot or poweroff is under way
 * (shutdown.target active or queued: `systemctl is-system-running` says
 * "starting" for one that begins before the boot finished) or an NSM
 * shutdown (var-opt-ro.service queued or running), else is-system-running's
 * answer. */
function realSystemState(cb) {
    cp.execFile(SYSTEMCTL, ['show', 'shutdown.target', 'var-opt-ro.service', '-p', 'ActiveState', '-p', 'Job'], { timeout: STEP_MS }, function (err, out) {
        var t = (out || '') + '';
        if (/^Job=\d+/m.test(t) || /^ActiveState=(active|activating)$/m.test(t)) { cb('stopping'); return; }
        cp.execFile(SYSTEMCTL, ['is-system-running'], { timeout: STEP_MS }, function (err2, out2) { cb(((out2 || '') + '').trim()); });
    });
}

function startTarget(t, cb) {
    cp.execFile(SYSTEMCTL, ['start', t.unit], { timeout: 30000 }, function (err) { cb(err); });
}

/* ---- the counter ---- */

function newArm(id, patch, inMem, at) {
    var a = { boot: id, at: at, patch: patch, crashes: 0, ran: false, confirmed: false, seen: 0, clean: false };
    if (inMem) a.inmem = true;
    return a;
}

/* waze-on-cluster 0.7.5 and earlier wrote the arm as {boot, state:
 * unconfirmed|confirmed|clean}; a unit updated mid-boot still holds one. */
function normArm(a) {
    if (!a || typeof a !== 'object') return null;
    return { boot: a.boot, at: a.at || 0, patch: a.patch || 'unknown', crashes: a.crashes || 0, ran: !!a.ran, confirmed: !!(a.confirmed || a.state === 'confirmed'),
        seen: typeof a.seen === 'number' ? a.seen : 0, lastAt: typeof a.lastAt === 'number' ? a.lastAt : 0, crashKey: typeof a.crashKey === 'number' ? a.crashKey : null,
        clean: !!(a.clean || a.state === 'clean'), own: !!a.own, inmem: !!a.inmem };
}

function logOf(st) {
    return Array.isArray(st.log) ? st.log.filter(function (l) { return typeof l === 'string'; }).slice(-LOG_MAX) : [];
}

/* One entry of st's log: the time (UTC; the clock may not be set yet at
 * the boot step), this boot and the uptime, then what happened. */
function note(st, bootId, what) {
    var up = parseInt(readText('/proc/uptime'), 10);
    st.log = logOf(st).concat((new Date().toISOString() + ' boot ' + String(bootId || '?').slice(0, 8) +
        (up >= 0 ? ' up ' + up + ' s' : '') + ': ' + what).slice(0, LOG_LINE)).slice(-LOG_MAX);
}

/* How the armed boot arm ended, as the boot step read it, for the log:
 * its shutdown mark as written, or that there was none and whether a
 * restart record of that boot was found; what the watcher saw. */
function endText(arm, end) {
    return 'boot ' + String(arm.boot).slice(0, 8) + ' ' + (end.mark !== null ? 'mark "' + end.mark.replace(/^\S+ /, '') + '"' : 'no shutdown mark' + (end.crash ? ', a restart record' : '')) +
        (end.asked ? ', restart asked for' : '') + (end.failure ? ', a crash in recmgr\'s table' : '') +
        (end.untold ? ', recmgr\'s table unreadable' : '') +
        (end.off !== null ? ', off ' + Math.round(end.off / 60000) + ' min after last seen' : '') +
        '; ' + (arm.crashes ? arm.crashes + ' crash' + (arm.crashes === 1 ? '' : 'es') : arm.confirmed ? 'healthy' : arm.ran ? 'ran' : 'never seen running') +
        (arm.clean ? ', stopped in order' : '');
}

function Recovery(opts) {
    opts = opts || {};
    var t = this.target = opts.target || TARGETS.carplay;
    this.statePath = t.state;
    this.healthyMs = opts.healthyMs || HEALTHY_MS;
    this.bootId = opts.bootId || boot.bootId();
    this._restore = opts.restore || function (fails, cb, why) { restoreTarget(t, false, fails, cb, 0, why); };
    this._repairModes = opts.repairModes || function (cb) { repairModes(t, 0, cb); };
    this._disarm = opts.disarm || function (fails, cb, why, refused) { disarmTarget(t, fails, why, refused, cb); };
    /* The boot step, ordered before the service's start (runBoot). */
    this._bootStep = !!opts.bootStep;
    this._arm = opts.arm || function (name) { return inmem.arm(name); };
    /* Whether a process runs the target's own file: the run is of the file
     * the record describes, not of one a change replaced. */
    var self = this;
    var runsTarget = this._runsTarget = opts.runsTarget || function () {
        if (!inmemKind(t)) return lock.inUse(t.target);
        var r = inmem.result(t.name), rec = inmem.current(t.name);
        /* A program reading copies (aapd's aapd.conf): started with this
         * record's ones. */
        return !!r && r.applied === true && r.pid === self._pid && inmem.memState(t.name, self._pid) === 'patched' &&
            (!inmem.TARGETS[t.name].copies.length || (!!rec && inmem.runningId(self._pid) === inmem.patchId(rec)));
    };
    this._prove = opts.prove || function (cb) { proveInmem(t, runsTarget, cb); };
    this._probe = opts.probe || function (cb) { probeTarget(t, cb); };
    this._systemState = opts.systemState || realSystemState;
    this._start = opts.start || function (cb) { startTarget(t, cb); };
    this._alive = opts.alive || function (pid) { return exists(path.join(PROC, String(pid))); };
    this._recmgrLoaded = opts.recmgrLoaded || recmgr.recmgrLoaded;
    this._lock = opts.lock || lock;
    this._now = opts.now || monoMs;
    this._wall = opts.wall || Date.now;
    this._bootTime = opts.bootTime || boot.bootTime;
    this._crashKey = opts.crashKey || recmgrCrashKey;
    this._log = opts.log || log;

    this.restoring = false;
    this._restored = [];        /* callbacks waiting for the restore to end */
    this._busy = false;         /* a probe, crash or start is in flight */
    this._pid = 0;              /* the main PID of the active run */
    this._run = '';             /* the active run, for the healthy timer */
    this._lastProbe = -Infinity;
    this._activeSince = null;   /* start of the current continuous-active run */
    this._settled = null;       /* the run whose healthy minute is done; only seen times follow */
    this._seenAt = -Infinity;   /* when the run was last looked at for a seen time (this._now) */
    this._seenFailing = false;  /* the last seen time could not be saved */
    this._trialRun = null;      /* the run a trial was settled for as the patch's */
    this._startAt = null;       /* when the scheduled start is due */
    this._proveAt = -Infinity;  /* when a patch on trial is next recorded proven */
    /* This boot's ended run, crashes and starts, also kept here so a state
     * file that cannot be written neither repeats a crash nor lifts the start
     * limit; the larger of memory and disk counts. */
    this._ended = '';
    this._crashes = 0;
    this._starts = 0;
    this._pendingRun = null;    /* aapd: the run patchd's pending marker was written under */
}

/* The boot step, the watcher and patchd each read and write a service's
 * state: every read-modify-write holds <state>.lock, a file naming its
 * holder's PID, taken by the first _load or _save of a turn of the event
 * loop and released at the end of that turn (each read-modify-write is
 * synchronous). A lock whose holder is gone is taken over; one held longer
 * than LOCK_WAIT_MS is taken over too, with a line in the log, so a stuck
 * holder never keeps a crash from being recorded. */
var LOCK_WAIT_MS = parseInt(process.env.WOC_RECOVERY_LOCK_WAIT_MS, 10) || 2000;
var SLEEPER = null;
try { SLEEPER = new Int32Array(new SharedArrayBuffer(4)); } catch (e) {}
function sleepMs(ms) {
    if (SLEEPER) { try { Atomics.wait(SLEEPER, 0, 0, ms); return; } catch (e) {} }
    var end = Date.now() + ms;
    while (Date.now() < end) { /* no Atomics.wait: spin */ }
}
function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
Recovery.prototype._stateLock = function () {
    if (this._stateLocked) return;
    var file = this.statePath + '.lock', deadline = Date.now() + LOCK_WAIT_MS, self = this;
    for (;;) {
        try {
            var fd = fs.openSync(file, 'wx', 0o644), wrote = false;
            try { fs.writeSync(fd, String(process.pid)); wrote = true; }
            finally { fs.closeSync(fd); if (!wrote) { try { fs.unlinkSync(file); } catch (e5) {} } }
            break;
        } catch (e) {
            if (e.code === 'ENOENT') {
                try { fs.mkdirSync(path.dirname(file), 0o755); } catch (e2) { if (e2.code !== 'EEXIST') return; }
                continue;
            }
            if (e.code !== 'EEXIST') return;   /* no lock to be had (a read-only folder): the save says why */
            /* No PID yet: its holder is between creating and writing it,
             * unless it was left so for a second. A lock is taken over only
             * as it was seen (the same file, not one another waiter made
             * since), and past the wait only once per wait. */
            var st0, holder = parseInt(readText(file), 10), blank = !(holder > 0);
            try { st0 = fs.statSync(file); } catch (e4) { continue; }
            var stale = holder === process.pid || (blank && Date.now() - st0.mtime.getTime() > 1000) || (!blank && !alive(holder)), late = Date.now() >= deadline;
            if (stale || late) {
                if (late && !stale) this._log(path.basename(file) + ' held by ' + holder + ' for ' + LOCK_WAIT_MS + ' ms: taken over');
                try {
                    var st1 = fs.statSync(file), now = parseInt(readText(file), 10);
                    if (st1.ino === st0.ino && st1.mtime.getTime() === st0.mtime.getTime() && (blank ? !(now > 0) : now === holder)) fs.unlinkSync(file);
                } catch (e3) { if (e3.code !== 'ENOENT') return; }   /* a lock that cannot be removed: none to be had */
                if (late) deadline = Date.now() + LOCK_WAIT_MS;
                continue;
            }
            sleepMs(10);
        }
    }
    this._stateLocked = true;
    setImmediate(function () { self._stateUnlock(); });
};
Recovery.prototype._stateUnlock = function () {
    if (!this._stateLocked) return;
    this._stateLocked = false;
    var file = this.statePath + '.lock';
    if (readText(file) === String(process.pid)) { try { fs.unlinkSync(file); } catch (e) {} }
};

/* read: the state file was read, or there is none. */
Recovery.prototype._load = function () {
    this._stateLock();
    var read = false;
    try {
        var st = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        /* A state without unknown is 0.8.1's or older, counted by other
         * rules: its counts start again. */
        var legacy = !!st && typeof st === 'object' && !('unknown' in st);
        if (st && typeof st === 'object') return { fails: legacy ? 0 : st.fails || 0, unknown: legacy ? 0 : st.unknown || 0, arm: normArm(st.arm),
            prev: normArm(st.prev), starts: st.starts || null, ended: st.ended || null, log: logOf(st), read: true };
    } catch (e) { read = e.code === 'ENOENT'; }
    return { fails: 0, unknown: 0, arm: null, prev: null, starts: null, ended: null, log: [], read: read };
};

/* Persist durably: the state must survive the reboot a crash can cause the
 * moment after, so it is on disk, renamed into place, before this returns. A
 * write that fails leaves the previous state whole, and is tried once more
 * without the log, so the log never keeps the count from being saved.
 * quiet: no line for it. false when it failed. */
Recovery.prototype._save = function (st, quiet) {
    this._stateLock();
    /* The boot step, the watcher and patchd each write it: a temporary
     * file of each process's own, so no write lands in another's. */
    var dir = path.dirname(this.statePath), tmp = this.statePath + '.tmp.' + process.pid, log = (st.log || []).slice(-LOG_MAX);
    function write(entries) {
        var fd;
        try { fs.mkdirSync(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        fd = fs.openSync(tmp, 'w', 0o644);
        try {
            fs.writeFileSync(fd, JSON.stringify({ fails: st.fails || 0, unknown: st.unknown || 0, arm: st.arm || null, prev: st.prev || null, starts: st.starts || null, ended: st.ended || null,
                log: entries }) + '\n');
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, this.statePath);
    }
    try {
        try { write.call(this, log); } catch (e) {
            if (!log.length) throw e;
            try { fs.unlinkSync(tmp); } catch (e2) {}
            write.call(this, []);
            st.log = [];
            if (!quiet) this._log('state saved without its log (' + e.message + ')');
        }
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        if (!quiet) this._log('could not persist state: ' + e.message);
        this._saveError = e.code;
        return false;
    }
    /* The state is written; a folder that cannot be synced (a file system
     * without it) leaves only the rename's timing open. */
    try { fsyncPath(dir); } catch (e) { this._log('could not sync ' + dir + ': ' + e.message); }
    return true;
};

Recovery.prototype._armed = function (st) { return !!st.arm && st.arm.boot === this.bootId; };
Recovery.prototype._thisBoot = function (rec) { return !!rec && rec.boot === this.bootId; };

/* The boot-time decision. First an original that lacks the access its
 * service's user needs gets its mode and owner back (repairModes). Then, on
 * a head unit that refuses our parts (head_unit.js), restore a patch of
 * ours at once; otherwise count the previous armed boot, arm this one when
 * its binary is a patch of ours, and restore at the threshold, or when this
 * boot's arm could not be saved. Also run by the watcher at its start,
 * where it counts nothing twice and retries a restore the boot step did not
 * finish. cb(result) for tests; result.action is 'idle' | 'armed' |
 * 'restored' | 'restore-failed' | 'stopped' (a stop came during the mode
 * repair), and result.repaired the files whose mode and owner were set. */
Recovery.prototype.startBoot = function (cb) {
    cb = cb || function () {};
    var self = this;
    /* First, whatever the count or the patch: an original that lacks the
     * access its service's user needs gets its mode and owner back. A stop
     * meanwhile waits for it, as for a restore (whenRestored), and nothing
     * more is decided. */
    this.restoring = true;
    this._repairModes(function (err, n) {
        self.restoring = false;
        if (err) self._log(self.target.name + ': setting its original\'s mode and owner failed: ' + err.message);
        var stops = self._restored.splice(0);
        if (stops.length) { stops.forEach(function (f) { f(); }); cb({ action: 'stopped', repaired: n || undefined }); return; }
        self._decide(function (r) { if (n) r.repaired = n; cb(r); });
    });
};

Recovery.prototype._decide = function (cb) {
    /* A migration's record waiting for the reverted original (a reset
     * between patchd's revert and its arm) takes it here. */
    if (this.target.inmem) inmem.adopt(this.target.name);
    var t = this.target, st = this._load(), tallied = false, refused = headUnit.refused();
    if (refused) {
        /* A head unit that refuses our parts: a patch of ours goes, whatever
         * the count; nothing is armed. */
        var k = patchKind(t);
        if (k === 'none' || (k === 'original' && !leftover(t))) { cb({ action: 'idle' }); return; }
        this._restoreWith(st.fails, true, cb, refused);
        return;
    }
    if (st.arm && !this._armed(st)) {
        var was = st.fails, wasUnknown = st.unknown;
        var end = endOf(t, st.arm, this._wall(), this._bootTime(), this._crashKey), r = tally(st, st.arm, end);
        note(st, this.bootId, t.name + ': ' + endText(st.arm, end) + ': failed ' + was + ' -> ' + r.fails + ', no record ' + wasUnknown + ' -> ' + r.unknown + ' (' + r.why + ')');
        st.fails = r.fails;
        st.unknown = r.unknown;
        st.prev = st.arm;
        st.prev.own = !!r.own;
        st.arm = null;
        tallied = true;
        this._log(t.name + ': failed patched boots and crashes ' + st.fails + ' (was ' + was + '): the last patched boot ' + r.why +
            (st.unknown ? '; 1 boot with no record' : ''));
    }
    var kind = patchKind(t), inMem = !!inmemKind(t);
    if (!inMem && t.inmem) inmem.disarm(t.name);
    /* The patches are applied in memory only: a patch of ours found in the
     * service's files at the boot step (an install whose activate did not
     * get to it, a patch written by hand) is put back to the original
     * before the service starts, whatever the count, and recorded as a
     * patch to plan, which the boot step plans and arms before the service
     * starts; so is what a put-back of patchd's cut short left (our backups
     * beside the original, a file besides the binary not yet put back),
     * which a record still to plan marks. Files that also hold another
     * change are left as they are (a conflict). Only the boot step: at an
     * install the deploy tool starts the watcher before activate, which
     * moves such a patch into memory itself. */
    var prior = t.inmem ? inmem.readRecord(t.name) : null;
    var cutShort = kind === 'original' && !!prior && prior.enabled === true && prior.needsPlan === true;
    if (t.inmem && this._bootStep && !inMem && (kind === 'proven' || kind === 'unproven' || kind === 'unknown' || cutShort) && t.foreignIn() !== true) {
        if (tallied) this._save(st);
        /* An enabled plan takes the original back by its SHA-256 (adopt);
         * a record still to plan keeps the arguments it holds; without
         * either the patch is recorded as one to plan. */
        var drec = record.current(t.target);
        if (!prior || (prior.enabled === true && !prior.planSha256 && prior.needsPlan !== true)) {
            try { inmem.planFailed(t.name, t.planArgs(drec), 'a patch in ' + t.name + '\'s files was put back as they ship at the start; planned again'); }
            catch (e) { this._log(t.name + ': recording the patch to plan failed: ' + e.message); }
        }
        this._putBack = true;
        this._restoreWith(st.fails, true, cb, undefined, 'file');
        return;
    }
    if (kind === 'none' || kind === 'original') {
        if (tallied || st.fails || st.unknown || st.arm) { st.fails = 0; st.unknown = 0; st.arm = null; this._save(st); }
        cb({ action: 'idle' });
        return;
    }
    if (!st.arm) {
        st.arm = newArm(this.bootId, kind, inMem, this._wall());
        st.arm.lastAt = st.prev ? Math.max(st.prev.seen, st.prev.at) : 0;
        st.arm.crashKey = this._crashKey();
    }
    else if (inMem && !st.arm.inmem) st.arm.inmem = true;
    var saved = this._save(st);
    /* A service with a crash threshold of its own (aapd) is restored at it
     * when the last patched boot counted saw the service itself crash (also
     * when the watcher retries a restore the boot step did not finish). */
    var own = !!st.prev && !!st.prev.own && st.fails > 0;
    var limit = own && t.crashThreshold ? Math.min(THRESHOLD[kind], t.crashThreshold) : THRESHOLD[kind];
    if (saved && st.fails < limit) {
        /* In memory: the start is armed only now, once its record is saved. */
        var a = inMem ? this._arm(t.name) : null;
        if (a && !a.armed) this._log(t.name + ': not armed (' + a.why + '); it starts stock');
        else if (a && !a.already) this._log(t.name + ': armed: the next start applies the patch in memory');
        cb({ action: 'armed', patch: kind, fails: st.fails, inmem: inMem || undefined, armFailed: a && !a.armed ? a.why : undefined });
        return;
    }
    /* why: 'crash' for a service its own crash restores (aapd), else
     * 'boot' (failed head-unit starts). */
    this._restoreWith(st.fails, saved, cb, undefined, own && t.crashThreshold ? 'crash' : 'boot');
};

/* Restore at the threshold, (saved false) because the count could not be
 * saved, or (refused: why) on a head unit that refuses our parts; the
 * counter clears once the binary is not ours to protect. */
Recovery.prototype._restoreWith = function (fails, saved, cb, refused, why) {
    var self = this, n = this.target.name, t0 = this._now();
    this._log(refused ? refused + '; restoring the original ' + n
        : saved ? 'restoring the original ' + n + ' after ' + fails + ' failed patched boots or crashes'
        : 'restoring the original ' + n + ': the boot-recovery state cannot be saved');
    this.restoring = true;
    var inMem = !!inmemKind(this.target), restore = inMem ? this._disarm : this._restore;
    restore(fails, function (err, outcome) {
        self.restoring = false;
        var r;
        if (err) {
            /* The counter stays, so the next start tries again. */
            self._log('boot recovery restore failed: ' + err.message + '; ' + n + ' starts as it is');
            r = { action: 'restore-failed', fails: fails, error: err.message };
        } else {
            self._log(inMem && outcome === 'restored'
                    ? 'turned the in-memory patch of ' + n + ' off: its next start runs it as it ships; its Patch button applies it again'
                : outcome === 'restored' ? 'restored the original ' + n + ' in ' + Math.round(self._now() - t0) + ' ms; its patch is off until its Patch button applies it' +
                    (self.target.crashThreshold ? ' or an update brings a newer patch' : '')
                : outcome === 'other' ? n + ' is another build than our backup (a firmware update): not ours to restore'
                : n + ' is the original already');
            self._clear(outcome !== 'restored' ? null : refused ? n + ': patch ' + (inMem ? 'turned off' : 'restored') + ': ' + refused
                : why === 'file' ? n + ': a patch in its files put back as they ship'
                : n + ': patch ' + (inMem ? 'turned off' : 'restored') + ' after ' + fails + ' failed starts or crashes' + (why === 'crash' ? ' (its own crash)' : ''));
            r = outcome === 'restored' ? { action: 'restored', fails: fails } : { action: 'idle' };
        }
        cb(r);
        self._restored.splice(0).forEach(function (f) { f(); });
    }, why, refused);
};

/* A new patch's count starts at nothing: failures counted belong to the
 * patch it replaces. This boot's arm goes too; the next decision arms the
 * new one. */
Recovery.prototype.resetCount = function () {
    var st = this._load();
    if (st.fails || st.unknown) note(st, this.bootId, this.target.name + ': a new patch; failed ' + st.fails + ' and no record ' + st.unknown + ' set to 0');
    st.fails = 0;
    st.unknown = 0;
    st.arm = null;
    this._crashes = 0;
    this._save(st);
};

Recovery.prototype._clear = function (what) {
    var st = this._load();
    if (what) note(st, this.bootId, what);
    st.fails = 0;
    st.unknown = 0;
    st.arm = null;
    this._crashes = 0;
    this._save(st);
};

/* cb once no restore runs: a stop waits for it, so / is never left writable. */
Recovery.prototype.whenRestored = function (cb) {
    if (this.restoring) this._restored.push(cb);
    else cb();
};

/* One watcher poll. A run of the service is told by its InvocationID. While
 * a run is active a tick only checks that its main PID is in /proc, and asks
 * systemctl every ALIVE_PROBE_MS or once the PID is gone; while the service
 * is down it asks every PROBE_MS. A run that ended failed (Result not success)
 * is a crash, once per run, unless patchd killed it to activate a change or
 * the system is stopping. A run a SIGKILL ended as a success (the tool's
 * carplay.service drop-in, SuccessExitStatus=SIGKILL) is no crash; unless
 * patchd killed it, which starts it itself, the service is started again
 * like after a crash. A run continuously active for HEALTHY_MS confirms the
 * boot, and every SEEN_MS after records when it was last seen (_healthy).
 * cb(result) for tests; result.action is 'skip' | 'watch' | 'confirmed' |
 * 'crash' | 'killed' | 'exited' | 'started' | 'start-skipped'. */
Recovery.prototype.tick = function (cb) {
    cb = cb || function () {};
    var self = this;
    if (this._busy || this.restoring) { cb({ action: 'skip' }); return; }
    var now = this._now();
    if (this._startAt !== null && now >= this._startAt) { this._startDue(cb); return; }
    var fresh = now - this._lastProbe < (this._pid ? ALIVE_PROBE_MS : PROBE_MS);
    if (fresh && (!this._pid || this._alive(this._pid))) { cb({ action: this._healthy(now) }); return; }
    this._busy = true;
    this._probe(function (info) {
        self._lastProbe = now;
        /* patchd writes its pending marker only while a run is up, which
         * keeps the file it replaced: the run of the first probe that sees
         * the marker. */
        if (self.target.restartOnExit) {
            if (!exists(self.target.pending)) self._pendingRun = null;
            else if (self._pendingRun === null) self._pendingRun = info.run || '-';
        }
        if (info.state === 'active') {
            if (info.run !== self._run) { self._run = info.run; self._activeSince = now; self._seenAt = -Infinity; self._ran(); }
            self._pid = info.pid;
        } else {
            self._run = '';
            self._pid = 0;
            self._activeSince = null;
        }
        var killed = self.target.killedRun(info);
        var ended = !killed && (info.state === 'failed' || (info.state === 'inactive' && !!info.result && info.result !== 'success'));
        var exited = !killed && !ended && !!self.target.restartOnExit && info.state === 'inactive' && info.result === 'success' && info.started;
        if (!(ended || killed || exited) || !info.run || self._handled(info.run)) { self._busy = false; cb({ action: self._healthy(now) }); return; }
        self._markHandled(info.run);
        if (info.run === readText(self.target.killed).trim()) { self._busy = false; cb({ action: 'watch' }); return; }
        self._systemState(function (sys) {
            /* An end while the head unit shuts down, its mark already written, is no crash. */
            if (sys === 'stopping' || markOf(self.target, self.bootId)) { self._busy = false; cb({ action: 'watch' }); return; }
            if (killed) { self._onKill(info, cb); return; }
            if (exited) { self._onExit(info, cb); return; }
            self._onCrash(info, cb);
        });
    });
};

Recovery.prototype._handled = function (run) {
    var e = this._load().ended;
    return run === this._ended || (this._thisBoot(e) && e.run === run);
};

Recovery.prototype._markHandled = function (run) {
    this._ended = run;
    var st = this._load();
    st.ended = { boot: this.bootId, run: run };
    this._save(st);
};

Recovery.prototype._ran = function () {
    var st = this._load();
    if (this._armed(st) && !st.arm.ran) { st.arm.ran = true; this._save(st); }
};

/* A run's healthy minute confirms this boot's arm once and records a
 * patch on trial that the run runs proven (_trial); from then on the arm
 * records, every SEEN_MS, when the run was last seen healthy (arm.seen, by
 * the wall clock once it reads after the arm), for the time the head unit
 * was off after it (offOf). A patch in memory is confirmed and seen only
 * from a run of it (_runsTarget): a run of the file a change waiting for
 * the next start replaced, or a start the patch was not applied to, shows
 * nothing of the patch. Once the run is settled the state is read only
 * every SEEN_MS, and a seen time written only while the run is one of the
 * patch. */
Recovery.prototype._healthy = function (now) {
    if (this._activeSince === null || now - this._activeSince < this.healthyMs) return 'watch';
    if (this._settled === this._run && now - this._seenAt < SEEN_MS) return 'watch';
    var st = this._load(), action = 'watch', settled = st.read, save = false;
    /* aapd: a healthy run makes its next start after an end quick again. */
    if (this.target.startDelays && this._startsThisBoot() > 0) {
        this._starts = 0;
        st.starts = { boot: this.bootId, n: 0 };
        settled = this._save(st) && settled;
    }
    var armed = this._armed(st), ofPatch = armed && (!st.arm.inmem || this._runsTarget()), wall = this._wall();
    if (ofPatch && !st.arm.confirmed) {
        st.arm.confirmed = true;
        save = true;
        this._log(this.target.name + ' healthy');
        action = 'confirmed';
    }
    var seen = false;
    if (now - this._seenAt >= SEEN_MS) {
        this._seenAt = now;
        if (ofPatch && wall >= st.arm.at && wall >= CLOCK_FLOOR_MS) { st.arm.seen = wall; save = seen = true; }
    }
    if (save) {
        /* A seen time that cannot be saved is logged once until one is. */
        var ok = this._save(st, seen && this._seenFailing);
        if (seen) {
            if (!ok && !this._seenFailing) this._log(this.target.name + ': its seen time cannot be saved; tried again every ' + SEEN_MS / 1000 + ' s');
            if (ok && this._seenFailing) this._log(this.target.name + ': its seen time is saved again');
            this._seenFailing = !ok;
        }
        settled = ok;
    }
    /* A trial is settled once per run, at the first look that reads it as the patch's. */
    if ((this._settled !== this._run || (ofPatch && this._trialRun !== this._run)) && this._trial(now, st)) settled = false;
    if (settled) {
        this._settled = this._run;
        if (ofPatch) this._trialRun = this._run;
    }
    return action;
};

/* A patch on trial (its record's trial: its build not yet run healthy on
 * this car) that this healthy run runs from the target's own file is
 * recorded proven, so from then on it is restored at the proven threshold,
 * but only in a clean boot: armed this boot (st, the state as read), no
 * crash of the service in it, and no failed start or crash counted before
 * it. A trial that crashed stays on trial. A stop waits for the write
 * (whenRestored). true while the record is being written or is to be tried
 * again; false when there is nothing to do: no trial, a boot that is not
 * clean, or the run is of another file than the target's (a change waits
 * for the next start). */
Recovery.prototype._trial = function (now, st) {
    /* Only a patch in memory is ever on trial: a patch in a file is never
     * kept (_decide). */
    var self = this, t = this.target, im = inmemKind(t) ? inmem.current(t.name) : null;
    if (!im || !im.trial) return false;
    if (!this._armed(st) || st.fails || st.arm.crashes || this._crashes) {
        this._log(t.name + ' ran its patch healthy, but this boot is not clean (' + (!this._armed(st) ? 'not armed' : 'failed starts and crashes ' +
            (st.fails + Math.max(st.arm.crashes, this._crashes))) + '): the patch stays on trial');
        return false;
    }
    if (now < this._proveAt) return true;
    if (!this._runsTarget()) return false;
    this.restoring = true;
    this._prove(function (err, wrote, roErr) {
        self.restoring = false;
        if (err) {
            self._proveAt = self._now() + PROVE_RETRY_MS;
            self._log(t.name + ' ran its patch healthy; recording it proven failed: ' + err.message + '; trying again in ' + PROVE_RETRY_MS / 1000 + ' s');
        } else if (wrote) self._log(t.name + ' ran its patch healthy: the patch is recorded proven');
        if (roErr) self._log(roErr.message + ': / stays read-write until the next head-unit start');
        self._restored.splice(0).forEach(function (f) { f(); });
    });
    return true;
};

/* A crash: recorded at once (the next moment can be a reboot), and a patch
 * restored at once when the record could not be saved, unless /var/opt is
 * read-only: var-opt-ro.service made it so, the head unit is going down and
 * its shutdown mark holds this end. Without recmgr's entry nothing more is
 * done here: the boot step counts it and restores at the next start. With
 * it, a patch is restored at the threshold, then the service is started
 * again. */
Recovery.prototype._onCrash = function (info, cb) {
    var self = this, t = this.target, saved = true, loaded = this._recmgrLoaded(t.name);
    function done(extra) { self._busy = false; cb(Object.assign({ action: 'crash' }, extra)); }
    function next(extra) { if (loaded) self._scheduleStart(); done(extra); }
    function goingDown() {
        if (saved || self._saveError !== 'EROFS') return false;
        self._log('/var/opt is read-only: the head unit is going down; the boot step counts this at the next start');
        done({ fails: st.fails + self._crashes });
        return true;
    }
    this._log(t.name + ' (run ' + info.run + ') ended: ' + info.result);
    /* The run patchd's pending marker was written under ran the file that
     * change replaced: its crash tells nothing of the file on disk, which
     * the start runs, so nothing is counted or restored. */
    if (this._pendingRun && info.run === this._pendingRun) {
        this._log(t.name + ' ran the file a change replaced: not counted; the start runs ' + t.target + ' as it is now');
        next();
        return;
    }
    this._crashes++;
    var st = this._load();
    if (this._armed(st)) {
        st.arm.crashes = Math.max(st.arm.crashes + 1, this._crashes);
        note(st, this.bootId, t.name + ' ended: ' + info.result + (info.code ? ' (code ' + info.code + ', status ' + info.status + ')' : ''));
        saved = this._save(st);
    }
    if (goingDown()) return;
    if (saved && !loaded) {
        this._log('recmgr did not load a ' + t.name + ' entry this boot: the boot step decides at the next start');
        done({ fails: st.fails + this._crashes });
        return;
    }
    var kind = patchKind(t);
    if (kind === 'none' || kind === 'original') { this._clear(); next(); return; }
    if (!this._armed(st)) { st.arm = newArm(this.bootId, kind, false, this._wall()); st.arm.crashes = this._crashes; saved = this._save(st); }
    if (goingDown()) return;
    var total = st.fails + Math.max(st.arm.crashes, this._crashes), limit = Math.min(THRESHOLD[kind], t.crashThreshold || Infinity);
    this._log(t.name + ' crashes while patched: ' + total);
    if (saved && total < limit) { next({ fails: total }); return; }
    this._restoreWith(total, saved, function (r) { next({ fails: total, restore: r.action }); }, undefined, t.crashThreshold ? 'crash' : 'boot');
};

/* A SIGKILL that was not patchd's (the OOM killer, a shell): the service is
 * started again where recmgr loaded its entry (without it, recmgr restarts
 * the head unit for the exit). */
Recovery.prototype._onKill = function (info, cb) {
    this._log(this.target.name + ' (run ' + info.run + ') was killed');
    if (this._recmgrLoaded(this.target.name)) this._scheduleStart();
    this._busy = false;
    cb({ action: 'killed' });
};

/* A clean exit of a service that must not stay down (aapd): started again
 * where recmgr loaded its entry (without it, recmgr restarts the head
 * unit for the exit). */
Recovery.prototype._onExit = function (info, cb) {
    this._log(this.target.name + ' (run ' + info.run + ') exited');
    if (this._recmgrLoaded(this.target.name)) this._scheduleStart();
    this._busy = false;
    cb({ action: 'exited' });
};

Recovery.prototype._startsThisBoot = function () {
    var s = this._load().starts;
    return Math.max(this._thisBoot(s) ? s.n : 0, this._starts);
};

/* The next start after an end: carplay's at most START_DELAYS_MS.length
 * times per boot, aapd's (startDelays) after every end, its delay growing
 * with the starts since its last healthy run. */
Recovery.prototype._scheduleStart = function () {
    var n = this._startsThisBoot(), d = this.target.startDelays;
    if (!d && n >= START_DELAYS_MS.length) {
        this._log(this.target.name + ' stays down: started ' + n + ' times this boot already');
        return;
    }
    var delay = d ? d[Math.min(n, d.length - 1)] : START_DELAYS_MS[n];
    if (d) this._log('starting ' + this.target.name + ' in ' + delay / 1000 + ' s');
    this._startAt = this._now() + delay;
};

/* The scheduled start: only while the service is down, the system is not
 * stopping, and patchd is not writing (it holds the remount lock; the start
 * waits for the next tick). The run it starts is watched like any other. */
Recovery.prototype._startDue = function (cb) {
    var self = this;
    this._busy = true;
    function done(action) { self._busy = false; cb({ action: action }); }
    this._probe(function (info) {
        if (info.state === 'active' || info.state === 'activating') { self._startAt = null; done('start-skipped'); return; }
        self._systemState(function (sys) {
            if (sys === 'stopping') { self._startAt = null; done('start-skipped'); return; }
            if (!self._lock.tryAcquire()) { done('watch'); return; }
            var n = self._startsThisBoot() + 1;
            self._starts = n;
            var st = self._load();
            st.starts = { boot: self.bootId, n: n };
            self._save(st);
            self._startAt = null;
            self._log('starting ' + self.target.name + ' (start ' + n + (self.target.startDelays ? ' since its last healthy run' : ' this boot') + ')');
            self._start(function (err) {
                self._lock.release();
                if (err) self._log('starting ' + self.target.name + ' failed: ' + err.message);
                if (err && self.target.startDelays) self._scheduleStart();
                self._lastProbe = -Infinity;   /* probe the new run at the next tick */
                done('started');
            });
        });
    });
};

/* SIGTERM while the system stops (an orderly reboot) exempts a boot with no
 * crash; a SIGTERM from a service restart does not. */
Recovery.prototype.onShutdown = function (cb) {
    var self = this;
    var st = this._load();
    if (!this._armed(st) || st.arm.crashes || this._crashes || st.arm.clean) { cb(); return; }
    this._systemState(function (sys) {
        if (sys === 'stopping') {
            var now = self._load();
            if (self._armed(now)) { now.arm.clean = true; self._save(now); }
        }
        self._log(self.target.name + ': stopped while the system is ' + (sys || 'unknown') + (sys === 'stopping' ? ': this start ended in order' : ''));
        cb();
    });
};

module.exports = {
    Recovery: Recovery, tally: tally, parseShow: parseShow, targets: targets, TARGETS: TARGETS, THRESHOLD: THRESHOLD,
    RESTORE_BOUND_MS: RESTORE_BOUND_MS, BOOT_BOUND_MS: BOOT_BOUND_MS, BOOT_EXIT_MS: BOOT_EXIT_MS, restoreTarget: restoreTarget, repairModes: repairModes,
    PROVE_RETRY_MS: PROVE_RETRY_MS,
    realSystemState: realSystemState, recmgrCrashKey: recmgrCrashKey, retryPlan: retryPlan, codingMoved: codingMoved, keepRestartRecords: keepRestartRecords, RECORD_MAX: RECORD_MAX, RECORD_BOOTS: RECORD_BOOTS,
};

/* ---- run as the boot step or the watcher ---- */

/* The boot step for one service (`recovery.js boot [carplay|aapd]`) always
 * exits 0, by BOOT_EXIT_MS at the latest, a restore cut short after a try
 * to put / back read-only: the service's start never waits on its failure. Nothing runs the service before it, so the restore links
 * the patched binary only if a process runs it. */
function runBoot(name) {
    var t = TARGETS[name || 'carplay'];
    if (!t) { log('unknown service ' + name); process.exit(0); }
    setTimeout(function () {
        log(t.name + ' boot check: out of time after ' + BOOT_BOUND_MS + ' ms; ' + t.name + ' starts as it is');
        setTimeout(function () { process.exit(0); }, BOOT_EXIT_MS - BOOT_BOUND_MS).unref();
        abandonRestore(function () { process.exit(0); });
    }, BOOT_BOUND_MS).unref();
    var t0 = monoMs();
    if (t.name === 'carplay') {
        try {
            var kept = keepRestartRecords(t, RECORDS, boot.bootId());
            if (kept) log('kept ' + kept + ' restart record' + (kept === 1 ? '' : 's') + ' in ' + RECORDS);
        } catch (e) { log('restart records not kept: ' + e.message); }
    }
    var rec = new Recovery({ target: t, bootStep: true, restore: function (fails, cb, why) { restoreTarget(t, true, fails, cb, BOOT_LOCK_WAIT_MS, why); },
        repairModes: function (cb) { repairModes(t, BOOT_LOCK_WAIT_MS, cb); } });
    function done(r) {
        log(t.name + ' boot check: ' + r.action + (r.patch ? ' (' + r.patch + ' patch, ' + r.fails + ' failed)' : '') +
            (r.repaired ? ', mode and owner set on ' + r.repaired + ' file' + (r.repaired === 1 ? '' : 's') : '') +
            ' in ' + Math.round(monoMs() - t0) + ' ms, ' + Math.round(process.uptime() * 1000) + ' ms since node started');
        process.exit(0);
    }
    /* A plan made for another coding than the car reads becomes a plan
     * still to make (codingMoved). A plan still to make is made first
     * (BOOT_PLAN_MS at most), unless
     * our backup is beside the binary: the step puts that back first.
     * After the step put a patch in the file back, an enabled record is
     * planned (when it has no plan) and armed, so this start applies it;
     * the boot's bound still holds over all of it. */
    (t.inmem && !exists(t.backups[0]) ? function (cb) { codingMoved(t.name); retryPlan(t.name, cb, BOOT_CODING_WAIT_MS, BOOT_PLAN_MS); } : function (cb) { cb(false); })(function () {
        rec.startBoot(function (r) {
            var ir = t.inmem && rec._putBack && r.action !== 'restore-failed' ? inmem.readRecord(t.name) : null;
            if (!ir || ir.enabled !== true) { done(r); return; }
            if (!ir.needsPlan) { rec._decide(done); return; }
            retryPlan(t.name, function (planned) {
                if (!planned) { done(r); return; }
                rec._decide(done);
            }, BOOT_CODING_WAIT_MS, BOOT_PLAN_MS);
        });
    });
    /* A stop mid-restore lets the restore finish (it exits then). */
    process.on('SIGTERM', function () { rec.whenRestored(function () { process.exit(0); }); });
}

/* A patch in memory whose plan is still to be made (inmem.js planFailed: a
 * plan that failed, a put-back cut short, a patch in the file put back at
 * the start) is planned again: at the boot step, before carplay starts, so
 * this start applies it, and at the watcher's start if that did not get to
 * it. The cluster coding the plan reads is waited for up to waitMs; a
 * coding still not readable then is planned for only when anyCoding is
 * set (the watcher's try), since at the boot step it may be one not yet
 * published and the plan is made for the coding it reads. counter: the
 * service's Recovery whose count a new plan starts at nothing. cb(planned). */
function retryPlan(name, cb, waitMs, planMs, anyCoding, counter) {
    var rec = inmem.readRecord(name);
    if (!rec || !rec.needsPlan || rec.enabled !== true) { cb(false); return; }
    /* A car software update replaced the service's binary since, or the
     * record cannot tell (an earlier release's, with no build-id): it runs
     * as it ships until the next install or the Patch button plans it. */
    var now = inmem.buildOf(TARGETS[name].target);
    if (!rec.build || now !== rec.build) {
        log(name + ': ' + (rec.build ? 'another build than the patch was to be planned for (a car software update)' : 'the plan to make names no build') + ': ' + name + ' runs as it ships until the next install or its Patch button');
        try { inmem.remove(name); } catch (e) {}
        cb(false);
        return;
    }
    var until = Date.now() + (waitMs || 0);
    (function wait() {
        var cd = require('./aapd_patch.js').readCoding(CODING);
        if (cd.err && Date.now() < until) { setTimeout(wait, 1000); return; }
        if (cd.err && !anyCoding) { log(name + ': the cluster coding cannot be read yet (' + cd.err + '); the watcher plans the patch'); cb(false); return; }
        plan();
    })();
    function plan() {
        log(name + ': planning the patch in memory again (it was: ' + rec.error + ')');
        inmem.makePlan(name, rec.args || [], planMs || 60000, function (err, r) {
            if (err) {
                log(name + ': planning failed again: ' + err.message + '; ' + name + ' runs as it ships');
                if (err.refused) { try { inmem.remove(name); } catch (e) {} }
                else { try { inmem.planFailed(name, rec.args || [], err.message); } catch (e) {} }
            } else {
                log(name + ': in-memory patch planned (' + r.edits.join(', ') + ')');
                (counter || new Recovery({ target: TARGETS[name] })).resetCount();
            }
            cb(!err);
        });
    }
}

/* A plan made for another cluster coding than the car reads (one made
 * while the coding could not be read, or by a release that did not record
 * it, is for 7): it cannot work there, so its record becomes a plan still
 * to make, nothing is armed for the next start, and retryPlan plans it for
 * the coding the car reads, with every check a plan has. Only a coding
 * that reads, and a record that describes the file as it is, count.
 * true when so. */
function codingMoved(name) {
    var rec = inmem.readRecord(name);
    if (!rec || rec.enabled !== true || rec.needsPlan || !inmem.describes(name, rec)) return false;
    var cd = require('./aapd_patch.js').readCoding(CODING), was = typeof rec.coding === 'number' ? rec.coding : 7;
    if (cd.err || cd.variant === was) return false;
    log(name + ': the patch was planned for KI_KOMBI_VARIANT ' + was + ' and the car reads ' + cd.variant + ': planned again for it');
    try {
        inmem.disarm(name);
        inmem.planFailed(name, rec.args || [], 'planned for KI_KOMBI_VARIANT ' + was + ', the car reads ' + cd.variant);
    } catch (e) { log(name + ': ' + e.message); return false; }
    return true;
}

/* cb() once the cluster coding reads, polled every second for up to ms;
 * never when it does not. */
function whenCoding(ms, cb) {
    var until = Date.now() + ms;
    (function poll() {
        if (!require('./aapd_patch.js').readCoding(CODING).err) { cb(); return; }
        if (Date.now() < until) setTimeout(poll, 1000);
    })();
}

/* The watcher follows carplay, and aapd where the unit has it, each with
 * its own counter, from its start. A plan the boot steps did not get to is
 * made first for its own service (followed once it is made or given up,
 * the cluster coding waited for up to 120 s); a plan made for another
 * coding than the car's is planned again once the coding reads, for the
 * service's next start. */
function runWatcher() {
    var names = ['carplay'].concat(exists(TARGETS.aapd.target) ? ['aapd'] : []);
    watch(names.map(function (n) {
        var r = new Recovery({ target: TARGETS[n] });
        r.before = function (go) {
            var rec = inmem.readRecord(n);
            if (rec && rec.needsPlan && rec.enabled === true) retryPlan(n, function () { go(); }, 120000, 60000, true, r);
            else go();
        };
        r.after = function () {
            whenCoding(120000, function () { if (codingMoved(n)) retryPlan(n, function () {}, 0, 60000, true, r); });
        };
        return r;
    }));
}

/* Follows each Recovery of recs: its `before` first, then its boot
 * decision, then a poll every TICK_MS, and its `after`. */
function watch(recs) {
    var timer = null, booting = 0, stopping = false, finished = false;
    /* A stop waits for a restore in progress, so / is not left writable. */
    function finish() {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        var on = recs.filter(function (r) { return r.watching; }), left = on.length;
        if (!left) process.exit(0);
        on.forEach(function (r) { r.whenRestored(function () { r.onShutdown(function () { if (--left === 0) process.exit(0); }); }); });
    }
    recs.forEach(function (r) {
        (r.before || function (go) { go(); })(function () {
            if (stopping) return;
            booting++;
            r.startBoot(function () {
                booting--;
                r.watching = true;
                if (stopping) { if (!booting) finish(); return; }
                if (r.after) r.after();
            });
        });
    });
    /* Polled even with no patch to watch: the service stays up, since
     * Restart=always would otherwise start it again every few seconds and
     * the deploy tool's health check takes that for a crash loop. */
    timer = setInterval(function () { recs.forEach(function (x) { if (x.watching) x.tick(); }); }, TICK_MS);
    function stop() { if (stopping) return; stopping = true; if (!booting) finish(); }   /* else finish() runs when startBoot returns */
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

if (require.main === module) {
    if (process.argv[2] === 'boot') runBoot(process.argv[3]);
    else runWatcher();
}
