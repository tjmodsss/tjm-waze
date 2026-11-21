#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
# libwocpatch.so against a test program (target.c): all or nothing, only the
# plan's program, the result file. Run by `make test-preload` in the unit's
# toolchain image: preload_test.sh <libwocpatch.so> <target> <work dir>
set -eu
LIB=$1 BIN=$2 W=$3
mkdir -p "$W"
fails=0
ok() { echo "ok: $*"; }
bad() { echo "FAIL: $*"; fails=$((fails + 1)); }
id=$(readelf -n "$BIN" | sed -n 's/.*Build ID: *\([0-9a-f]*\).*/\1/p')
set -- $("$BIN" dump)
mva=$2 mstock=$3; ava=$5 astock=$6
mpatched=$(printf 'patched message' | od -An -tx1 | tr -d ' \n')00
apatched=2a000000
plan() {   # plan <file> <build-id> <answer stock> [extra line]
    { echo "wocplan 1"; echo "build-id $2"
      echo "edit message $mva $mstock $mpatched"; echo "edit answer $ava $3 $apatched"
      [ -n "${4:-}" ] && echo "$4"; echo "end ${5:-2}"; } > "$1"
}
run() {   # run <plan> -> stdout of the target; result in $W/result
    : > "$W/result"
    WOC_PATCH_PLAN=$1 WOC_PATCH_RESULT=$W/result LD_PRELOAD=$LIB "$BIN" 2> "$W/err"
}
stock="stock message!! 41414141"

plan "$W/p1" "$id" "$astock"
out=$(run "$W/p1")
[ "$out" = "patched message 2a
child" ] && ok "the plan's edits in .rodata and .text applied" || bad "applied: got '$out' $(cat "$W/err")"
grep -q '"applied":true,.*"edits":\["message","answer"\]' "$W/result" && ok "result: applied, both edits" || bad "result: $(cat "$W/result")"
grep -q '"pid":[1-9][0-9]*,' "$W/result" && grep -q 'applied 2 edits in memory' "$W/err" && ok "stderr says so" || bad "stderr: $(cat "$W/err")"

plan "$W/p2" 0000000000000000000000000000000000000000 "$astock"
out=$(run "$W/p2")
[ "$out" = "$stock
child" ] && [ ! -s "$W/result" ] && [ ! -s "$W/err" ] && ok "another program's plan: nothing, no result" || bad "other build: '$out' result '$(cat "$W/result")'"

plan "$W/p3" "$id" 00000000
out=$(run "$W/p3")
[ "$(echo "$out" | head -1)" = "$stock" ] && grep -q '"applied":false' "$W/result" && grep -q 'answer at .* does not read as' "$W/result" \
    && ok "one site not stock: nothing applied (the other site stays stock)" || bad "mismatch: '$out' $(cat "$W/result")"

plan "$W/p4" "$id" "$astock"; head -c -6 "$W/p4" > "$W/p4c"
out=$(run "$W/p4c")
[ "$(echo "$out" | head -1)" = "$stock" ] && [ ! -s "$W/result" ] && grep -q 'cut short\|not ended' "$W/err" && ok "a plan cut short: nothing, said on stderr, no result" || bad "cut short: $(cat "$W/result" "$W/err")"

plan "$W/p5" "$id" "$astock" "hook answer 1000 x"
out=$(run "$W/p5")
[ "$(echo "$out" | head -1)" = "$stock" ] && grep -q 'unknown line kind' "$W/err" && ok "a kind this library does not know: nothing" || bad "unknown kind: $(cat "$W/result")"

plan "$W/p6" "$id" "$astock" "" 3
out=$(run "$W/p6")
[ "$(echo "$out" | head -1)" = "$stock" ] && grep -q 'its end says 3' "$W/err" && ok "an edit count that does not match: nothing" || bad "count: $(cat "$W/result")"

{ echo "wocplan 1"; echo "build-id $id"; echo "edit far ffffff00 00 01"; echo "end 1"; } > "$W/p7"
out=$(run "$W/p7")
[ "$(echo "$out" | head -1)" = "$stock" ] && grep -q 'not in a loaded part' "$W/result" && ok "an address outside the program: nothing" || bad "outside: $(cat "$W/result")"

out=$(WOC_PATCH_PLAN=$W/none WOC_PATCH_RESULT=$W/result LD_PRELOAD=$LIB "$BIN" 2>/dev/null)
[ "$(echo "$out" | head -1)" = "$stock" ] && ok "no plan file: stock" || bad "no plan: $out"

out=$(LD_PRELOAD=$LIB "$BIN" 2>&1)
[ "$out" = "$stock
child" ] && ok "no WOC_PATCH_PLAN: stock, silent" || bad "unarmed: $out"

# Another library's thread, started before ours (libdlt's in carplay): applied.
THR=$(dirname "$BIN")/libthread.so
: > "$W/result"
out=$(WOC_PATCH_PLAN=$W/p1 WOC_PATCH_RESULT=$W/result LD_PRELOAD="$LIB $THR" "$BIN" 2>/dev/null)
[ "$(echo "$out" | head -1)" = "patched message 2a" ] && grep -q '"applied":true,"threads":2' "$W/result" \
    && ok "a thread another library started: applied, code pages kept executable" || bad "with a thread: '$out' $(cat "$W/result")"

# The test build that aborts once it has applied: the process ends with SIGABRT
# (an armed start that crashes, which boot recovery counts).
CRASH=$(dirname "$LIB")/libwocpatch-crash.so
: > "$W/result"
WOC_PATCH_PLAN=$W/p1 WOC_PATCH_RESULT=$W/result LD_PRELOAD=$CRASH "$BIN" >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" -eq 134 ] && grep -q '"applied":true' "$W/result" && ok "the crash test build applies, then aborts" || bad "crash build: rc $rc $(cat "$W/result")"

# The result file is never created by the library.
rm -f "$W/result"
WOC_PATCH_PLAN=$W/p1 WOC_PATCH_RESULT=$W/result LD_PRELOAD=$LIB "$BIN" >/dev/null 2>&1
[ ! -e "$W/result" ] && ok "a missing result file is not created" || bad "result created"

# Only the linker's own symbols (_init, _fini, the section bounds).
nm -D --defined-only "$LIB" | grep -v -E ' (__bss_start|_edata|_end|_init|_fini)$' | grep -q . && bad "exports: $(nm -D --defined-only "$LIB")" || ok "exports nothing"
[ $fails -eq 0 ] && echo "preload_test: all passed" || { echo "preload_test: $fails failed"; exit 1; }
