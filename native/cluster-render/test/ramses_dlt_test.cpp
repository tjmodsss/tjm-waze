// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The DLT level wrapper (ramses_dlt.h) against a stand-in for libdlt's
 * dlt_register_log_level_changed_callback: RAMSES's callback gets the
 * daemon's level, at least INFO, for its own context. */
#include "../src/ramses_dlt.h"

#include <stdio.h>
#include <string.h>

#include <map>
#include <string>

static int failures = 0;

static void ok(const char *name, bool cond)
{
    printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond)
        failures++;
}

/* libdlt's side: the callback registered per context id. */
static std::map<std::string, DltLevelChanged> registered;
static int real_calls = 0;
static int fake_register(void *handle, DltLevelChanged cb)
{
    real_calls++;
    registered[std::string(static_cast<const char *>(handle), 4)] = cb;
    return 0;
}

/* RAMSES's side: the last level each of its contexts was given. */
static std::map<std::string, int> ramses;
static void ramses_cb(char id[4], uint8_t level, uint8_t) { ramses[std::string(id, 4)] = level; }

/* A DltContext: its 4-byte id first. */
struct Ctx {
    char id[4];
    int32_t pos = 0;
    void *ptrs[2] = {nullptr, nullptr};
};

static void daemon_sets(const char *id, uint8_t level)
{
    char buf[4];
    memcpy(buf, id, 4);
    registered[std::string(id, 4)](buf, level, 0);
}

int main()
{
    ok("levels below INFO are INFO for RAMSES", crs::ramses_level(0) == 4 && crs::ramses_level(1) == 4 &&
                                                    crs::ramses_level(3) == 4);
    ok("INFO and above pass", crs::ramses_level(4) == 4 && crs::ramses_level(5) == 5 && crs::ramses_level(6) == 6);

    crs::set_dlt_register(fake_register);
    Ctx client{{'R', 'C', 'L', 'I'}}, periodic{{'R', 'P', 'E', 'R'}};
    ok("registered with libdlt", dlt_register_log_level_changed_callback(&client, ramses_cb) == 0 &&
                                     dlt_register_log_level_changed_callback(&periodic, ramses_cb) == 0 &&
                                     real_calls == 2 && registered.count("RCLI") && registered.count("RPER"));
    ok("libdlt gets the wrapper, not RAMSES's callback", registered["RCLI"] != ramses_cb);

    daemon_sets("RCLI", 0);
    daemon_sets("RPER", 4);
    ok("the daemon sets OFF: RAMSES's context kept at INFO, the other context as set",
       ramses["RCLI"] == 4 && ramses["RPER"] == 4);
    daemon_sets("RCLI", 6);
    ok("a trace level reaches RAMSES", ramses["RCLI"] == 6);
    daemon_sets("RCLI", 2);
    ok("back down to ERROR: INFO", ramses["RCLI"] == 4);
    ok("counted for the status", crs::ramses_dlt_text() ==
                                     "RAMSES contexts registered with DLT: 2; DLT levels below INFO kept at INFO: 2");

    ok("no callback: registered as none", dlt_register_log_level_changed_callback(&client, nullptr) == 0 &&
                                              registered["RCLI"] == nullptr);
    ok("no handle: refused", dlt_register_log_level_changed_callback(nullptr, ramses_cb) == -1);

    if (failures) {
        printf("%d FAILED\n", failures);
        return 1;
    }
    printf("all ok\n");
    return 0;
}
