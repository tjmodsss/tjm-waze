/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "ramses_dlt.h"

#include <dlfcn.h>
#include <string.h>

#include <atomic>
#include <map>
#include <mutex>

#include "log.h"

namespace crs {
namespace {

typedef int (*Register)(void *, DltLevelChanged);

Register real_register = nullptr;
std::mutex mutex;
/* libramses's callback by context id. libdlt calls back from its own
 * thread while later contexts are still being registered. */
std::map<std::string, DltLevelChanged> callbacks;
std::atomic<uint64_t> kept{0};

std::string id_of(const char *id) { return std::string(id, strnlen(id, 4)); }

void level_changed(char context_id[4], uint8_t log_level, uint8_t trace_status)
{
    DltLevelChanged cb = nullptr;
    {
        std::lock_guard<std::mutex> lock(mutex);
        auto c = callbacks.find(id_of(context_id));
        if (c != callbacks.end())
            cb = c->second;
    }
    if (!cb)
        return;
    const uint8_t level = ramses_level(log_level);
    if (level != log_level)
        kept++;
    cb(context_id, level, trace_status);
}

}  // namespace

uint8_t ramses_level(uint8_t dlt_level) { return dlt_level < kDltInfo ? kDltInfo : dlt_level; }

std::string ramses_dlt_text()
{
    size_t n;
    {
        std::lock_guard<std::mutex> lock(mutex);
        n = callbacks.size();
    }
    return "RAMSES contexts registered with DLT: " + std::to_string(n) +
           "; DLT levels below INFO kept at INFO: " + std::to_string(kept.load());
}

void set_dlt_register(Register real) { real_register = real; }

}  // namespace crs

extern "C" int dlt_register_log_level_changed_callback(void *handle, DltLevelChanged callback)
{
    using namespace crs;
    Register real = real_register;
    if (!real)
        real = (Register)dlsym(RTLD_NEXT, "dlt_register_log_level_changed_callback");
    if (!real || !handle)
        return -1;   /* DLT_RETURN_ERROR: RAMSES keeps its levels */
    bool first;
    {
        std::lock_guard<std::mutex> lock(mutex);
        first = callbacks.empty();
        callbacks[id_of(static_cast<const char *>(handle))] = callback;
    }
    if (first)
        log_info("ramses: DLT levels below INFO are passed to RAMSES as INFO: its console stays live; what DLT "
                 "gets still follows the DLT daemon");
    return real(handle, callback ? level_changed : nullptr);
}
