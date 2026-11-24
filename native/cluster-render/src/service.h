/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* One pass of the render loop, the same for the unit's binary (main.cpp) and
 * the host harness (test/host_service.cpp); only the backends differ.
 *
 * Each pass, after poll():
 *   1. the display's reports reach the slot manager (the caller drains them),
 *   2. clients' messages and frames are taken (server),
 *   3. each target's layers are arranged and its demand is set (compositor),
 *   4. targets are published, requested, kept or released (slot manager),
 *   5. each requested target's layers are staged and flushed once,
 *   6. changed states go to the clients, and to the status file when its
 *      text changed (looked at once a second); once a second the upload is
 *      sampled (link_trace.h) and the
 *      remembered ceiling kept (ceiling_memory.h); once a minute the
 *      upload's summary and each shown target's layers' writes since its
 *      last such line, and whether it is rendered, go to the log. */
#ifndef CRS_SERVICE_H
#define CRS_SERVICE_H

#include <poll.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "ceiling_memory.h"
#include "compositor.h"
#include "governor.h"
#include "link_trace.h"
#include "server.h"
#include "slots.h"

namespace crs {

struct ServiceConfig {
    std::vector<TargetSpec> targets;
    GovernorConfig budget;   /* ceiling 5500, floor 2000, step 500 KB/s */
    int upload_burst_ms = 250;
    int slow_flush_ms = 150;
    int fps = 30;                /* the loop's tick while a target is up */
    int fade_ms = 250;           /* a target's layers fade in when it is shown, and out before it is released */
    bool instancing = true;      /* mesh parts drawn more than once (instances) */
    std::string socket_path = "/dev/shm/cluster-render/render.sock";
    unsigned socket_mode = 0660;
    std::string socket_group;
    std::string status_path;     /* empty: none */
    std::string backend = "id7";
    /* Where the scene files of targets that take them come from: under
     * /var/opt/, root's (scene_file.h). */
    SceneFiles scene_files;
    /* The drop-ins read with the settings, one line each for the status:
     * "loaded PATH" or "skipped PATH: why" (settings.h). */
    std::vector<std::string> drop_ins;
    /* The remembered ceiling's file and what it is checked against; its
     * limits are budget's. path empty: nothing remembered. */
    CeilingSettings ceiling;
    /* The TCP tables the send queue is read from (link_trace.h); empty:
     * not read. */
    std::vector<std::string> tcp_tables;
};

class Service {
public:
    Service(Gpu *gpu, Port *port, const ServiceConfig &cfg);
    bool start(std::string *err);

    SlotManager &slots() { return slots_; }
    Compositor &compositor() { return *comp_; }
    Server &server() { return *server_; }

    /* The server's poll entries, appended to fds; returns where they start. */
    size_t poll_fds(std::vector<pollfd> *fds) const;
    int timeout_ms(int64_t now_ms) const;
    /* Nothing requested, loaded, pending or due (SlotManager::at_rest): the
     * loop waits for a client, the display or a timer, and looks at the
     * clock every kRestMs only. */
    bool at_rest() const;
    static const int64_t kRestMs = 1000;
    /* Steps 2-6 (README.md "The render loop"). */
    void after_poll(const std::vector<pollfd> &fds, size_t first, int64_t now_ms);
    /* Takes everything off the display and unpublishes the scenes, for a
     * clean exit. */
    void shutdown(int64_t now_ms);

    /* Called kTrimMs after the last requested target was released: gives
     * the heap's free pages back to the system (malloc_trim with glibc), so
     * what a session freed does not stay resident while the service idles. */
    std::function<void()> release_memory;
    static const int64_t kTrimMs = 10000;

private:
    bool requested_ = false;   /* a target was requested at the last turn */
    int64_t released_ms_ = -1; /* when the last target was released, release_memory not yet called; -1: none */
    void trim(int64_t now_ms);
    ServiceConfig cfg_;
    SlotManager slots_;
    std::unique_ptr<Compositor> comp_;
    std::unique_ptr<Server> server_;
    int64_t status_ms_ = 0;
    std::string status_written_;   /* the status file's text, as last written */
    void write_status(int64_t now_ms);
    static const int64_t kMinuteMs = 60000;
    int64_t minute_ms_ = 0;
    /* Per target: its layers' writes and the time at its last minute line. */
    std::vector<WriteStats> stats_;
    std::vector<int64_t> stats_ms_;
    void log_minute(int64_t now_ms);
    std::unique_ptr<CeilingMemory> memory_;
    LinkTrace trace_;
    int64_t second_ms_ = -1;
    WriteStats written_;   /* every target's, at the last sample */
    void sample(int64_t now_ms);
};

}  // namespace crs

#endif
