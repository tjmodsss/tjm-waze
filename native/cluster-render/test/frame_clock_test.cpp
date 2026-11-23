/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the map's submission clock (frame_clock.h): that its
 * deadlines fall on an exact fractional grid, that a late send still targets
 * the grid, that deadlines passing with nothing to send are skipped rather
 * than made up, the wait it reports until the next, and a change of rate
 * keeping the deadline due next. */
#include <algorithm>
#include <cstdio>

#include "../kit/frame_clock.h"

using namespace crk;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

/* The clock runs a main loop at tick_ms, sending whenever a frame is due;
 * returns the sends per second after the first two seconds and the largest
 * gap between sends. A frame is always waiting. */
static double run_clock(uint32_t fps, int64_t tick_ms, bool wake, int64_t *max_gap)
{
    FrameClock c;
    c.configure(fps);
    c.reset(0);
    int counted = 0;
    int64_t last = -1;
    *max_gap = 0;
    for (int64_t t = 0; t <= 12000;) {
        if (c.due(t)) {
            c.sent(t);
            if (t >= 2000) {
                counted++;
                if (last >= 0)
                    *max_gap = std::max(*max_gap, t - last);
            }
            last = t;
        }
        int64_t next = t + tick_ms;
        if (wake) {
            const int64_t w = c.ms_until_due(t);
            if (w > 0 && w < tick_ms)
                next = t + w;
        }
        t = next;
    }
    return counted / 10.0;
}

static void test_clock_rate()
{
    int64_t gap = 0;
    char name[128];
    /* 30 fps on a 16 ms loop with wakes: the exact 33.3 ms grid, so 30 a
     * second and no gap past one interval. */
    double r = run_clock(30, 16, true, &gap);
    std::snprintf(name, sizeof name, "30 fps, 16 ms loop, wakes: %.1f a second, largest gap %lld ms", r,
                  (long long)gap);
    ok(name, r >= 29.5 && r <= 30.5 && gap <= 50);
    /* 24 fps likewise. */
    r = run_clock(24, 16, true, &gap);
    std::snprintf(name, sizeof name, "24 fps, 16 ms loop, wakes: %.1f a second", r);
    ok(name, r >= 23.5 && r <= 24.5);
    /* On a 33 ms loop without wakes the 33.3 ms grid still averages ~30,
     * because the clock skips at most to the next due deadline (no catch-up
     * burst) and the loop lands on nearly every one. */
    r = run_clock(30, 33, false, &gap);
    std::snprintf(name, sizeof name, "30 fps, 33 ms loop, no wake: %.1f a second", r);
    ok(name, r >= 28.0 && r <= 30.5);
}

/* Deadlines are absolute: a frame sent late does not shorten the next
 * interval, and deadlines that pass with nothing to send are skipped, not
 * made up as a burst. */
static void test_clock_absolute_and_skip()
{
    FrameClock c;
    c.configure(20);   /* 50 ms interval */
    c.reset(1000);
    ok("the first frame is due at the start", c.due(1000) && c.ms_until_due(1000) == 0);
    c.sent(1000);
    ok("the next deadline is one interval on", c.ms_until_due(1000) == 50 && !c.due(1020) && c.due(1050));
    /* A frame sent 30 ms late (at 1080): the next is at 1100, the grid point,
     * not 1130 — the average holds. */
    c.sent(1080);
    ok("a late send still targets the grid", c.ms_until_due(1080) == 20 && c.due(1100));
    /* Nothing goes for a while; at 1500 one frame goes. The deadlines from
     * 1100 to 1500 are skipped, so the next is 1550, not an immediate burst. */
    c.sent(1500);
    ok("skipped deadlines are not made up", !c.due(1540) && c.due(1550));
}

static void test_clock_off()
{
    FrameClock c;
    c.configure(0);
    ok("fps 0: always due, no wait", c.due(0) && c.due(12345) && c.ms_until_due(999) == 0);
    c.sent(5);
    ok("fps 0: still always due after a send", c.due(5));
}

/* retime: the deadline due next stays, the grid goes on from it at the new
 * rate; from no clock, the grid starts at once. */
static void test_clock_retime()
{
    FrameClock c;
    c.configure(30);
    c.reset(0);
    c.sent(0);   /* next at 33 */
    c.retime(20, 10);
    bool kept = !c.due(32) && c.due(33) && c.fps() == 20;
    c.sent(33);
    kept = kept && !c.due(82) && c.due(83);   /* 33 + 50 */
    ok("retime: the next deadline kept, then the new rate's grid from it", kept);
    c.retime(20, 90);
    ok("retime: the same rate again moves nothing", c.due(90) && c.ms_until_due(90) == 0);
    FrameClock off;
    off.retime(15, 500);
    off.sent(500);
    ok("retime: from no clock, the grid starts at once", off.ms_until_due(500) == 66 && off.fps() == 15);
    off.retime(0, 520);
    ok("retime: to no clock, always due", off.due(520) && off.ms_until_due(520) == 0);
}

int main()
{
    test_clock_rate();
    test_clock_absolute_and_skip();
    test_clock_off();
    test_clock_retime();
    if (failures) {
        std::printf("%d FAILED\n", failures);
        return 1;
    }
    std::printf("all ok\n");
    return 0;
}
