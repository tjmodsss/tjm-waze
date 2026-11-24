#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
"""RAMSES's console and DLT under the unit's own dlt-daemon (make test-dlt).

As root in the build image, with the unit's root file system at /rootfs: its
dlt-daemon (as dlt.service starts it, /etc/dlt.conf) and dlt-control on its
libdlt, and test/dlt_check.cpp on its libramses and libdlt. The daemon's
default level is OFF, as the log-and-trace manager leaves it when DLT does
not trace; a capture sets it to INFO for a while and back to OFF.

- Without src/ramses_dlt.cpp (dlt_check_plain) the RAMSES console goes quiet
  as the daemon sets RAMSES's contexts to OFF: the car's case.
- With it (dlt_check) the console stays live throughout.
- Either way DLT gets RAMSES's messages only while the daemon's level is
  INFO.

  dlt_check.py BIN_DIR"""
import os
import shutil
import subprocess
import sys
import time

ROOT = '/rootfs'
BIN = sys.argv[1]
LOADER = [ROOT + '/lib/ld-linux-x86-64.so.2', '--library-path', ROOT + '/lib:' + ROOT + '/usr/lib']
failures = 0


def ok(name, cond, detail=''):
    global failures
    print('%-4s %s%s' % ('ok' if cond else 'FAIL', name, '' if cond else ': ' + detail))
    if not cond:
        failures += 1


def install(src, dst, mode):
    shutil.copyfile(ROOT + src, dst)
    os.chmod(dst, mode)


def control(level):
    r = subprocess.run(['dlt-control', '-u', '-t', '1000', '-d', str(level)], stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, universal_newlines=True)
    if r.returncode:
        for name in ('daemon', 'dlt_check_plain', 'dlt_check'):
            if os.path.exists('/tmp/%s.log' % name):
                print('--- ' + name + '\n' + open('/tmp/%s.log' % name).read()[-3000:])
        sys.exit('dlt-control -d %d: %s' % (level, r.stdout))


def rows(path):
    out = []
    with open(path) as f:
        for line in f:
            p = line.split()
            if len(p) == 4:
                out.append((int(p[0]), int(p[1]), int(p[2]) == 1, int(p[3])))
    return out


def window(rs, a, b):
    """The rows from a to b seconds after the start."""
    return [r for r in rs if a * 1000 <= r[0] < b * 1000]


def grew(rs, col):
    return rs[-1][col] - rs[0][col] if rs else -1


def run(name):
    report = '/tmp/%s.report' % name
    log = open('/tmp/%s.log' % name, 'w')
    p = subprocess.Popen(LOADER + [os.path.join(BIN, name), '27', report], stdout=log, stderr=subprocess.STDOUT)
    # the report's clock starts with its first row
    for _ in range(400):
        if os.path.exists(report) and rows(report):
            break
        time.sleep(0.025)
    time.sleep(9.5)
    control(4)   # a capture: the default level INFO
    time.sleep(6)
    control(0)   # the capture over: OFF again
    p.wait(timeout=60)
    log.close()
    return rows(report)


def main():
    if not os.path.exists('/lib/ld-linux-x86-64.so.2'):
        os.symlink('/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-x86-64.so.2')
    install('/usr/bin/dlt-daemon', '/usr/local/bin/dlt-daemon', 0o755)
    install('/usr/bin/dlt-control', '/usr/local/bin/dlt-control', 0o755)
    install('/usr/lib/libdlt.so.2.15.0', '/usr/lib/libdlt.so.2', 0o755)
    install('/etc/dlt.conf', '/etc/dlt.conf', 0o644)
    # The default level OFF from the start, as the manager has set it by the
    # time the service registers (this daemon crashes on a dlt-control -d
    # with no application registered)
    with open('/etc/dlt.conf', 'a') as f:
        f.write('\nContextLogLevel = 0\n')
    subprocess.check_call(['groupadd', '-f', 'mgu_dlt'])
    os.makedirs('/run/dlt-files', 0o711, exist_ok=True)
    for d in ('/var/opt/public/sin/dlt-daemon', '/run/logntrace', '/run/lifecycle-ioc'):
        os.makedirs(d, exist_ok=True)
    with open('/run/lifecycle-ioc/lccount', 'w') as f:   # the daemon's records name the lifecycle
        f.write('12\n')
    # SIGPIPE ignored, as systemd starts it (IgnoreSIGPIPE): dlt-control
    # closes before the daemon's reply
    daemon = subprocess.Popen(['dlt-daemon'], stdout=open('/tmp/daemon.log', 'w'), stderr=subprocess.STDOUT,
                              restore_signals=False)
    for _ in range(200):
        if os.path.exists('/run/dlt-files/dlt-ctrl.sock'):
            break
        time.sleep(0.05)
    else:
        sys.exit('dlt-daemon: no control socket')

    for name, fixed in (('dlt_check_plain', False), ('dlt_check', True)):
        rs = run(name)
        off1, cap, off2 = window(rs, 6, 9), window(rs, 10, 15), window(rs, 21, 27)
        what = 'with the fix' if fixed else 'without the fix'
        print('     %s: console %.1f lines/s at OFF, %.1f during the capture; DLT %d messages during it, %d at OFF'
              % (what, grew(off2, 1) / 6.0, grew(cap, 1) / 5.0, grew(cap, 3), grew(off1, 3) + grew(off2, 3)))
        if fixed:
            ok(what + ': the console live with DLT at OFF',
               off1 and all(r[2] for r in off1) and grew(off1, 1) > 0, str(off1[-1:]))
            ok(what + ': the console live through a capture and after it',
               all(r[2] for r in window(rs, 6, 27)) and grew(off2, 1) > 0, str(off2[-1:]))
        else:
            ok(what + ': the console quiet with DLT at OFF (the car)',
               off1 and not any(r[2] for r in off1) and grew(off1, 1) == 0, str(off1[-1:]))
        ok(what + ': DLT gets no RAMSES message at OFF', grew(off1, 3) == 0 and grew(off2, 3) == 0,
           'off %d, after %d' % (grew(off1, 3), grew(off2, 3)))
        ok(what + ': DLT gets RAMSES messages during a capture', grew(cap, 3) > 0, str(grew(cap, 3)))

    daemon.kill()
    if failures:
        print('%d FAILED' % failures)
        for name in ('dlt_check_plain', 'dlt_check'):
            print('--- ' + name)
            print(open('/tmp/%s.log' % name).read()[-3000:])
        sys.exit(1)
    print('all ok')


main()
