/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The service's memory stays bounded while idle: a day of the idle loop on
 * a simulated clock, at the cadence the service asks for (Service::timeout_ms),
 * with the periodic work of a day (the status file every second, the upload
 * trace and minute statistics, the governor's and slot manager's ticks, a
 * slot table from the KOMBI every 10 s), RAMSES's console statistics every
 * 2 s and the DLT daemon setting its level now and then. Every live byte
 * allocated with new is counted; after a warm-up hour, the rest of the day
 * may add at most kSlack. Parts, run alone with `idle_memory_test PART
 * [HOURS]`: alone, no client; clients, three connected over the socket (a
 * shown layer on the map, a hidden one on the panel, one asking for the
 * status every 10 s); session, the heap's free memory released once a
 * session's target is released (Service::release_memory). */
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <new>
#include <string>
#include <vector>

#include "../src/log.h"
#include "../src/ramses_console.h"
#include "../src/service.h"
#include "cluster_render/client.h"
#include "fake_graph.h"
#include "fake_port.h"

/* ---- every live byte allocated with new ------------------------------------ */

static std::atomic<long long> g_live(0);

namespace {
const size_t kHead = 16;   /* the size, keeping max_align_t alignment */
void *counted(size_t n)
{
    void *p = std::malloc(n + kHead);
    if (!p)
        throw std::bad_alloc();
    *(size_t *)p = n;
    g_live += (long long)n;
    return (char *)p + kHead;
}
void uncounted(void *p)
{
    if (!p)
        return;
    char *b = (char *)p - kHead;
    g_live -= (long long)*(size_t *)b;
    std::free(b);
}
}  // namespace

void *operator new(size_t n) { return counted(n); }
void *operator new[](size_t n) { return counted(n); }
void *operator new(size_t n, const std::nothrow_t &) noexcept
{
    try {
        return counted(n);
    } catch (...) {
        return nullptr;
    }
}
void *operator new[](size_t n, const std::nothrow_t &) noexcept
{
    try {
        return counted(n);
    } catch (...) {
        return nullptr;
    }
}
void operator delete(void *p) noexcept { uncounted(p); }
void operator delete[](void *p) noexcept { uncounted(p); }
void operator delete(void *p, size_t) noexcept { uncounted(p); }
void operator delete[](void *p, size_t) noexcept { uncounted(p); }
void operator delete(void *p, const std::nothrow_t &) noexcept { uncounted(p); }
void operator delete[](void *p, const std::nothrow_t &) noexcept { uncounted(p); }

/* ---- the idle loop ---------------------------------------------------------- */

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond)
        failures++;
}

/* What a day of idling may add after the warm-up: a few strings whose
 * capacity settles late. The day's growth this guards against was megabytes. */
static const long long kSlack = 4096;
static const int64_t kHourMs = 3600 * 1000;

struct Rig {
    std::string dir = "/tmp/crs-idle-test-" + std::to_string(getpid());
    std::string path = dir + "/render.sock";
    FakeGpu gpu;
    FakePort port;
    ServiceConfig sc;
    std::unique_ptr<Service> svc;
    std::unique_ptr<RamsesConsole> console;
    std::vector<cr::Client *> clients;
    int64_t now = 100000;
    int64_t console_ms = 0, table_ms = 0, level_ms = 0;
    uint64_t ticks = 0;

    Rig()
    {
        mkdir_p();
        TargetSpec m, p, h;
        m.name = "map"; m.slot = 0x100; m.scene_id = 0x010004f0; m.width = 1088; m.height = 480;
        m.take_over_stock = true;
        p.name = "panel"; p.slot = 0x203; p.scene_id = 0x010004f8; p.width = 1920; p.height = 720; p.linger_ms = 3000;
        h.name = "hud"; h.slot = 0x323; h.scene_id = 0x01000400; h.width = 800; h.height = 480; h.linger_ms = 3000;
        sc.targets = {m, p, h};
        sc.socket_path = path;
        sc.status_path = dir + "/status.txt";
        sc.backend = "fake";
        port.watchdog();
        svc.reset(new Service(&gpu, &port, sc));
        port.m = &svc->slots();
        std::string err;
        if (!svc->start(&err))
            std::printf("start: %s\n", err.c_str());
        std::vector<uint64_t> scenes;
        for (const TargetSpec &t : sc.targets)
            scenes.push_back(t.scene_id);
        console.reset(new RamsesConsole(scenes));
        RamsesConsole *c = console.get();
        svc->slots().console_text = [c](int64_t now_ms) { return c->counts_text(now_ms); };
        svc->slots().console_live_since = [c](int64_t now_ms) { return c->live_since(now_ms); };
    }
    ~Rig()
    {
        svc.reset();
        unlink(sc.status_path.c_str());
        rmdir(dir.c_str());
    }
    void mkdir_p() { ::mkdir(dir.c_str(), 0700); }

    /* RAMSES's console as the reader thread feeds it, and the main loop's
     * take(): its statistics every 2 s, and every 20 minutes the DLT
     * daemon setting the levels off and back. */
    void console_tick()
    {
        while (now - console_ms >= 2000) {
            console_ms += 2000;
            char line[200];
            const int n = std::snprintf(line, sizeof line,
                                        "%lld.%03lld [ Info  ] ramses.Periodic      | R | Client: 3 scene(s): "
                                        "0x10004f0 Published, flushes 12, avg 0 ms\n",
                                        (long long)(console_ms / 1000), (long long)(console_ms % 1000));
            console->feed(line, (size_t)n, console_ms);
        }
        if (now - level_ms >= 20 * 60 * 1000) {
            level_ms = now;
            for (const char *lv : {"OFF", "INFO"}) {
                char line[200];
                const int n = std::snprintf(line, sizeof line,
                                            "0.000 [ Info  ] ramses.Ramsh | RCLI | ramses.Client | 0 | %s |  Dlt changed "
                                            "log level from INFO\n",
                                            lv);
                console->feed(line, (size_t)n, now);
            }
        }
        std::vector<ConsoleEvent> events;
        std::vector<std::string> raw;
        uint64_t dropped = 0;
        console->take(&events, &raw, &dropped);
    }

    /* One turn of the unit's loop at now: the socket exchange until idle,
     * the KOMBI's slot table every 10 s. */
    void turn()
    {
        if (now - table_ms >= 10000) {
            table_ms = now;
            port.refresh_slots();
        }
        for (int round = 0; round < 50; round++) {
            bool pending = false;
            for (cr::Client *c : clients)
                pending = pending || c->wants_write();
            std::vector<pollfd> fds;
            const size_t first = svc->poll_fds(&fds);
            const int n = ::poll(fds.data(), fds.size(), 0);
            port.tick(now);
            svc->after_poll(fds, first, now);
            for (cr::Client *c : clients)
                c->poll(now);
            if (round > 0 && n <= 0 && !pending)
                break;
        }
        console_tick();
        ticks++;
    }

    /* ms of the idle loop: each turn after the timeout the service asks for. */
    void idle(int64_t ms)
    {
        const int64_t end = now + ms;
        while (now < end) {
            now += std::max(1, svc->timeout_ms(now));
            turn();
        }
    }
};

/* The day after the warm-up hour; growth in bytes, and each hour's live bytes. */
static long long day(Rig &r, int64_t hours, std::vector<long long> *by_hour)
{
    r.idle(kHourMs);
    const long long start = g_live;
    for (int64_t h = 1; h < hours; h++) {
        r.idle(kHourMs);
        by_hour->push_back(g_live - start);
    }
    return g_live - start;
}

static void report(const char *what, long long grew, const std::vector<long long> &by_hour, uint64_t ticks)
{
    std::printf("     %s: %llu turns, live bytes after the warm-up hour:", what, (unsigned long long)ticks);
    for (size_t i = 0; i < by_hour.size(); i += std::max<size_t>(1, by_hour.size() / 6))
        std::printf(" %+lld", by_hour[i]);
    std::printf(" ... %+lld\n", grew);
}

/* The log lines of a day (the stock HMI's slot, minute statistics) are not
 * this test's output: stderr goes to /dev/null while f runs. */
template <typename F> static void quietly(F f)
{
    std::fflush(stderr);
    const int err_fd = dup(2), null_fd = open("/dev/null", O_WRONLY);
    dup2(null_fd, 2);
    f();
    std::fflush(stderr);
    dup2(err_fd, 2);
    close(err_fd);
    close(null_fd);
}

static void alone(int64_t hours)
{
    long long grew = 0;
    std::vector<long long> by_hour;
    uint64_t ticks = 0;
    quietly([&] {
        Rig r;
        r.port.stock_map(0x100, 0x01000300);   /* the HMI's map in the map slot, as at a cold boot */
        grew = day(r, hours, &by_hour);
        ticks = r.ticks;
    });
    report("no client", grew, by_hour, ticks);
    ok("idle with no client: a day adds at most 4 KB", grew <= kSlack);
}

static void clients(int64_t hours)
{
    long long grew = 0;
    std::vector<long long> by_hour;
    uint64_t ticks = 0;
    bool made = false;
    quietly([&] {
        Rig r;
        r.port.stock_map(0x100, 0x01000300);
        cr::Client shown("idle-map", r.path), hidden("idle-panel", r.path), asking("diag", r.path);
        r.clients = {&shown, &hidden, &asking};
        r.idle(1000);
        cr::EffectOptions eo;
        eo.fs = "#version 100\nprecision mediump float;\nvarying vec2 v_uv;\n"
                "void main() { gl_FragColor = vec4(v_uv, 0.3, 1.0); }\n";
        cr::LayerOptions lo;
        lo.target = "map";
        lo.contend = true;
        lo.w = 256;
        lo.h = 128;
        shown.effect(lo, eo);
        lo.target = "panel";
        lo.visible = false;
        hidden.effect(lo, eo);
        int64_t asked = r.now;
        std::string status;
        asking.on_status = [&](const std::string &t) { status = t; };
        r.idle(5000);
        const int64_t end = r.now + hours * kHourMs;
        /* the status asked for every 10 s, the rest as day() */
        auto run = [&](int64_t ms) {
            const int64_t stop = r.now + ms;
            while (r.now < stop) {
                r.now += std::max(1, r.svc->timeout_ms(r.now));
                if (r.now - asked >= 10000) {
                    asked = r.now;
                    asking.request_status();
                }
                r.turn();
            }
        };
        run(kHourMs);
        const long long start = g_live;
        while (r.now < end - 1) {
            run(std::min(kHourMs, end - r.now));
            by_hour.push_back(g_live - start);
        }
        grew = g_live - start;
        ticks = r.ticks;
        made = shown.connected() && hidden.connected() && status.find("map") != std::string::npos;
        r.clients.clear();
    });
    ok("the clients connected and their layers made (the map's shown, the status answered)", made);
    report("three idle clients", grew, by_hour, ticks);
    ok("idle with three clients: a day adds at most 4 KB", grew <= kSlack);
}

/* A session on the panel, then idle: the heap's free pages released once,
 * kTrimMs after the target is, and not while it is shown. */
static void session()
{
    int releases = 0, while_shown = -1, after_end = -1;
    quietly([&] {
        Rig r;
        r.svc->release_memory = [&releases] { releases++; };
        std::unique_ptr<cr::Client> c(new cr::Client("session", r.path));
        r.clients = {c.get()};
        r.idle(1000);
        cr::EffectOptions eo;
        eo.fs = "#version 100\nprecision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }\n";
        cr::LayerOptions lo;
        lo.target = "panel";
        c->effect(lo, eo);
        r.idle(60000);
        while_shown = releases;
        r.clients.clear();
        c.reset();
        r.idle(Service::kTrimMs);   /* the panel's linger, then the release */
        r.idle(Service::kTrimMs);
        after_end = releases;
        r.idle(kHourMs);
    });
    ok("free memory released once after a session ends, not while its target is shown, not again while idle",
       while_shown == 0 && after_end == 1 && releases == 1);
}

int main(int argc, char **argv)
{
    signal(SIGPIPE, SIG_IGN);
    cld::log_name = "cluster-render";
    const std::string part = argc > 1 ? argv[1] : "all";
    const int64_t hours = argc > 2 ? std::atoll(argv[2]) : 24;
    if (part == "all" || part == "alone")
        alone(hours);
    if (part == "all" || part == "clients")
        clients(hours);
    if (part == "all" || part == "session")
        session();
    std::printf("%s\n", failures ? "FAILED" : "PASSED");
    return failures ? 1 : 0;
}
