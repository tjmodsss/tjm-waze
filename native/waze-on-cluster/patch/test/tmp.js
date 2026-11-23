// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* The temporary files and child processes of one test run.
 *
 * dir() makes a new folder, <n>, inside the run's own folder,
 * woc-test-XXXXXX in the system's temporary directory (TMPDIR), made on first
 * use. Every child process started with child_process.spawn is recorded.
 *
 * When the process exits or throws, the recorded children still running are
 * killed and the run's folder is removed. A detached watcher does the same
 * once the process is gone any other way (SIGINT, SIGTERM, SIGKILL), also
 * while it is blocked in a synchronous call, where a signal handler would
 * not run: signals keep their default action.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var spawn = cp.spawn;
var top = null;
var children = new Set();

/* Polls for this process; once it is gone, kills the pids in <root>/.pids
 * and removes <root>. */
var WATCHER = [
    'var fs = require("fs"), cp = require("child_process");',
    'var root = process.argv[1], parent = Number(process.argv[2]);',
    'var t = setInterval(function () {',
    '    try { process.kill(parent, 0); return; } catch (e) { if (e.code === "EPERM") return; }',
    '    clearInterval(t);',
    '    var pids = "";',
    '    try { pids = fs.readFileSync(root + "/.pids", "utf8"); } catch (e) {}',
    '    pids.split("\\n").filter(Boolean).forEach(function (p) { try { process.kill(Number(p), "SIGKILL"); } catch (e) {} });',
    '    try { cp.execFileSync("rm", ["-rf", root]); } catch (e) {}',
    '}, 200);'
].join('\n');

function savePids() {
    var list = [];
    children.forEach(function (c) { if (c.pid) list.push(c.pid); });
    try { fs.writeFileSync(path.join(root(), '.pids'), list.join('\n') + '\n'); } catch (e) {}
}

function cleanup() {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    children.clear();
    if (top) { try { cp.execFileSync('rm', ['-rf', top]); } catch (e) {} top = null; }
}

function root() {
    if (!top) {
        top = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-test-'));
        spawn(process.execPath, ['-e', WATCHER, top, String(process.pid)], { detached: true, stdio: 'ignore' }).unref();
    }
    return top;
}

/* Numbered: sockets go in these folders, and a socket's path has to fit in
 * 104 bytes, macOS's limit. */
var made = 0;
function dir() {
    var d = path.join(root(), String(++made));
    fs.mkdirSync(d);
    return d;
}

cp.spawn = function () {
    var c = spawn.apply(this, arguments);
    children.add(c);
    c.once('exit', function () { children.delete(c); savePids(); });
    savePids();
    return c;
};

process.on('exit', cleanup);

module.exports = { dir: dir, root: root };
