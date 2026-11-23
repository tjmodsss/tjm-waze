#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* The lock of boot recovery's state file (recovery.js): every
 * read-modify-write of <state> holds <state>.lock, a file with its holder's
 * PID. A live other holder makes a save wait; a dead holder's lock is taken
 * at once; a lock held past WOC_RECOVERY_LOCK_WAIT_MS is taken over with a
 * line in the log; two processes saving at once lose no update.
 *
 *   node recovery_lock_test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tmp = require('./tmp.js');
const cp = require('child_process');

const WAIT_MS = 1500;
process.env.WOC_RECOVERY_LOCK_WAIT_MS = String(WAIT_MS);
const ROOT = tmp.dir();
Object.assign(process.env, { WOC_STATE_DIR: path.join(ROOT, 'inmem'), WOC_CARPLAY: path.join(ROOT, 'no-carplay'), WOC_REMOUNT_LOCK: path.join(ROOT, 'remount.lock') });
const recovery = require('../recovery.js');
const RECOVERY = path.join(__dirname, '..', 'recovery.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let n = 0;
/* A fresh state file's folder and carplay's target with that state. */
function target() {
    const d = path.join(ROOT, 'w' + (++n));
    fs.mkdirSync(path.join(d, 'var'), { recursive: true });
    fs.mkdirSync(path.join(d, 'shm'), { recursive: true });
    return recovery.targets({ state: path.join(d, 'var', 'boot-recovery.json'), sock: path.join(d, 'shm', 'patch.sock'),
        carplay: path.join(d, 'carplay'), aapd: path.join(d, 'aapd'), aapdConf: path.join(d, 'aapd.conf') }).carplay;
}
function rec(t, logs) { return new recovery.Recovery({ target: t, log: (l) => logs.push(l) }); }
const turn = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A process that writes its PID into the lock and keeps it for ms, then
 * removes it (ms 0: never). Resolves once the lock holds its PID. */
async function holder(lock, ms) {
    const c = cp.spawn(process.execPath, ['-e', 'const fs = require("fs"); fs.writeFileSync(process.argv[1], String(process.pid));' +
        'if (+process.argv[2]) setTimeout(() => { fs.unlinkSync(process.argv[1]); process.exit(0); }, +process.argv[2]); else setInterval(() => {}, 1e6);', lock, String(ms)], { stdio: 'ignore' });
    for (let t = Date.now(); Date.now() - t < 5000; await sleep(10)) {
        try { if (fs.readFileSync(lock, 'utf8') === String(c.pid)) return c; } catch (e) {}
    }
    c.kill('SIGKILL');
    throw new Error('the holder never took the lock');
}
function done(c) { return new Promise((r) => { if (c.exitCode !== null || c.signalCode !== null) r(); else c.on('exit', () => r()); }); }

test('a live other process holding the lock makes a save wait until it lets go', async () => {
    const t = target(), logs = [], lock = t.state + '.lock';
    const c = await holder(lock, 400);
    const t0 = Date.now();
    assert.strictEqual(rec(t, logs)._save({ fails: 1, unknown: 0, arm: null }), true);
    const waited = Date.now() - t0;
    assert(waited >= 250 && waited < WAIT_MS, 'waited ' + waited + ' ms');
    assert.strictEqual(JSON.parse(fs.readFileSync(t.state, 'utf8')).fails, 1);
    assert(!logs.some((l) => /taken over/.test(l)), logs.join('\n'));
    await turn();
    assert(!fs.existsSync(lock), 'released at the end of the turn');
    await done(c);
});

test('a dead holder\'s lock is taken at once, and released at the end of the turn', async () => {
    const t = target(), logs = [], lock = t.state + '.lock';
    const gone = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(lock, gone.stdout);
    const t0 = Date.now();
    assert.strictEqual(rec(t, logs)._save({ fails: 2, unknown: 0, arm: null }), true);
    assert(Date.now() - t0 < 250, 'took ' + (Date.now() - t0) + ' ms');
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid), 'held by this process during the turn');
    assert(!logs.some((l) => /taken over/.test(l)), 'no takeover line for a dead holder: ' + logs.join('\n'));
    await turn();
    assert(!fs.existsSync(lock));
    assert.strictEqual(JSON.parse(fs.readFileSync(t.state, 'utf8')).fails, 2);
});

test('a lock held past the wait is taken over, with a line in the log', async () => {
    const t = target(), logs = [], lock = t.state + '.lock';
    const c = await holder(lock, 0);
    try {
        const t0 = Date.now();
        assert.strictEqual(rec(t, logs)._save({ fails: 3, unknown: 0, arm: null }), true);
        const waited = Date.now() - t0;
        assert(waited >= WAIT_MS - 50 && waited < WAIT_MS + 1000, 'waited ' + waited + ' ms');
        assert(logs.some((l) => l === 'boot-recovery.json.lock held by ' + c.pid + ' for ' + WAIT_MS + ' ms: taken over'), logs.join('\n'));
        assert.strictEqual(JSON.parse(fs.readFileSync(t.state, 'utf8')).fails, 3);
        await turn();
        assert(!fs.existsSync(lock), 'this process\'s lock released');
    } finally { c.kill('SIGKILL'); await done(c); }
});

test('a blank lock left for over a second is taken over', async () => {
    const t = target(), logs = [], lock = t.state + '.lock';
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    assert.strictEqual(rec(t, logs)._save({ fails: 5, unknown: 0, arm: null }), true);
    assert(Date.now() - t0 < 250, 'took ' + (Date.now() - t0) + ' ms');
    assert.strictEqual(JSON.parse(fs.readFileSync(t.state, 'utf8')).fails, 5);
    await turn();
    assert(!fs.existsSync(lock));
});

test('a read and its write in one turn hold the lock once; a later turn takes it again', async () => {
    const t = target(), r = rec(t, []), lock = t.state + '.lock';
    const st = r._load();
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid));
    st.fails = 4;
    assert.strictEqual(r._save(st), true);
    await turn();
    assert(!fs.existsSync(lock));
    r._load();
    assert(fs.existsSync(lock), 'taken again');
    await turn();
    assert(!fs.existsSync(lock));
});

test('two processes saving at once lose no update', async () => {
    const t = target(), N = 60;
    fs.writeFileSync(t.state, JSON.stringify({ fails: 0, unknown: 0, arm: null }) + '\n');
    const script = [
        'const recovery = require(process.argv[1]);',
        'const t = recovery.targets({ state: process.argv[2], sock: process.argv[3], carplay: process.argv[4], aapd: process.argv[4] + "-aapd", aapdConf: process.argv[4] + "-conf" }).carplay;',
        'const r = new recovery.Recovery({ target: t, log: () => {} });',
        'let n = 0;',
        '(function step() { const st = r._load(); st.fails += 1; if (!r._save(st)) process.exit(2); if (++n < ' + N + ') setImmediate(step); })();',
    ].join('\n');
    const args = [RECOVERY, t.state, path.join(path.dirname(t.state), '..', 'shm', 'patch.sock'), t.target];
    const kids = [0, 1].map(() => cp.spawn(process.execPath, ['-e', script].concat(args), { stdio: ['ignore', 'ignore', 'pipe'] }));
    const codes = await Promise.all(kids.map((k) => new Promise((r) => { let err = ''; k.stderr.on('data', (d) => { err += d; }); k.on('exit', (code) => r([code, err])); })));
    codes.forEach((c) => assert.strictEqual(c[0], 0, c[1]));
    assert.strictEqual(JSON.parse(fs.readFileSync(t.state, 'utf8')).fails, 2 * N, 'every increment kept');
    assert(!fs.existsSync(t.state + '.lock'), 'no lock left');
});

(async () => {
    let failed = 0;
    try {
        for (const t of tests) {
            try { await t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack)); }
        }
    } finally { cp.execFileSync('rm', ['-rf', ROOT]); }
    console.log((tests.length - failed) + '/' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
