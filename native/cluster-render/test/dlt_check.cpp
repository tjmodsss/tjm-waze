/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* A RAMSES 19 participant set up as cluster-render-idrive7 sets up its own
 * (the console read by RamsesConsole, DLT application CLRD), on the unit's
 * libramses and libdlt, for test/dlt_check.py. Built with src/ramses_dlt.cpp
 * (dlt_check) and without it (dlt_check_plain). Every 250 ms it appends to
 * REPORT: milliseconds since start, RAMSES console lines read, whether the
 * console is live (RamsesConsole::live_since), and the messages RAMSES has
 * handed to DLT (dlt_user_log_write_finish, called only for a message libdlt
 * let through at the daemon's level).
 *   dlt_check SECONDS REPORT */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <dlfcn.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "../src/ramses_console.h"
#include "log.h"
#include "ramses19/ramses.h"

static std::atomic<unsigned long> dlt_sent{0};

extern "C" int dlt_user_log_write_finish(void *log)
{
    static int (*real)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "dlt_user_log_write_finish");
    dlt_sent++;
    return real ? real(log) : -1;
}

int main(int argc, char **argv)
{
    if (argc != 3) {
        std::fprintf(stderr, "usage: dlt_check SECONDS REPORT\n");
        return 2;
    }
    const int64_t seconds = std::atoll(argv[1]);
    FILE *report = std::fopen(argv[2], "w");
    if (!report)
        return 2;
    crs::RamsesConsole console(std::vector<uint64_t>{});
    std::string err;
    if (!console.start(&err)) {
        std::fprintf(stderr, "console: %s\n", err.c_str());
        return 1;
    }
    const char *args[] = {"cluster-render", "--log-level-console", "info"};
    ramses::RamsesFrameworkConfig fwc(3, args);
    fwc.setDLTApplicationID("CLRD");
    fwc.setDLTApplicationDescription("cluster-render");
    ramses::RamsesFramework framework(fwc);
    ramses::RamsesClient client("cluster-render", framework);
    framework.connect();
    const int64_t start = cld::now_ms();
    for (int64_t now = start; now - start < seconds * 1000; now = cld::now_ms()) {
        std::vector<crs::ConsoleEvent> events;
        std::vector<std::string> raw;
        uint64_t dropped = 0;
        console.take(&events, &raw, &dropped);
        const std::string counts = console.counts_text(now);
        std::fprintf(report, "%lld %llu %d %lu\n", (long long)(now - start),
                     std::strtoull(counts.c_str(), nullptr, 10), console.live_since(now) >= 0 ? 1 : 0,
                     dlt_sent.load());
        std::fflush(report);
        usleep(250000);
    }
    framework.disconnect();
    std::fclose(report);
    return 0;
}
