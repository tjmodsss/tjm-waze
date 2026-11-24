/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* RAMSES's console kept at INFO while the DLT daemon lowers RAMSES's log
 * levels (iDrive 7).
 *
 * The renderer's subscriptions are read from RAMSES's console
 * (ramses_console.h). RAMSES has one level per log context, and the console
 * and DLT both log only what that level lets through. libramses registers a
 * libdlt callback for each context (dlt_register_log_level_changed_callback)
 * that sets the context's level to the one the DLT daemon sends; the car's
 * daemon sends OFF while it does not trace, so the console goes quiet with
 * DLT. libdlt checks the daemon's level itself before it sends a message
 * (dlt_user_log_write_start), so DLT gets only what the daemon asks for
 * whatever RAMSES's own level is.
 *
 * This file defines dlt_register_log_level_changed_callback in the
 * executable, so libramses's call binds to it before libdlt's. It registers
 * libramses's callback with libdlt (the next definition, dlsym RTLD_NEXT)
 * through a callback that passes RAMSES a level of at least INFO: the
 * console keeps logging at INFO, levels above INFO (a trace) still reach
 * RAMSES, and libdlt's own level, which decides what DLT gets, is the
 * daemon's. Only this process's RAMSES contexts are concerned: of the
 * unit's libraries only libramses imports that function (abi/ABI.md). A
 * level change that leaves RAMSES at INFO is not logged by RAMSES (its
 * "Dlt changed log level" line). */
#ifndef CRS_RAMSES_DLT_H
#define CRS_RAMSES_DLT_H

#include <stdint.h>

#include <string>

extern "C" {
/* The callback libdlt calls with a context's new level (DLT_ID_SIZE 4,
 * the id not NUL-terminated). */
typedef void (*DltLevelChanged)(char context_id[4], uint8_t log_level, uint8_t trace_status);
/* libdlt's function, as libramses calls it: handle is a DltContext, whose
 * first member is its 4-byte context id. */
int dlt_register_log_level_changed_callback(void *handle, DltLevelChanged callback);
}

namespace crs {

/* DLT's levels: OFF 0, FATAL 1, ERROR 2, WARN 3, INFO 4, DEBUG 5, VERBOSE 6. */
static const uint8_t kDltInfo = 4;
uint8_t ramses_level(uint8_t dlt_level);
/* For the status. */
std::string ramses_dlt_text();
/* Tests: the libdlt function the wrapper registers with; null: dlsym. */
void set_dlt_register(int (*real)(void *, DltLevelChanged));

}  // namespace crs

#endif
