/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "service.h"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>

#include "log.h"

namespace crs {

Service::Service(Gpu *gpu, Port *port, const ServiceConfig &cfg) : cfg_(cfg), slots_(port, nullptr)
{
    for (const TargetSpec &t : cfg_.targets)
        slots_.add(t);
    CeilingSettings cs = cfg_.ceiling;
    cs.max_kb = cfg_.budget.max_bps / 1024;
    cs.floor_kb = cfg_.budget.floor_bps / 1024;
    cs.step_kb = cfg_.budget.step_bps / 1024;
    memory_.reset(new CeilingMemory(cs));
    GovernorConfig budget = cfg_.budget;
    if (budget.max_bps)
        budget.start_bps = memory_->start_kb() * 1024;
    comp_.reset(new Compositor(gpu, &slots_, budget, cfg_.upload_burst_ms));
    comp_->set_slow_flush_ms(cfg_.slow_flush_ms);
    comp_->set_file_tick_ms(1000 / std::max(1, cfg_.fps));
    comp_->set_fade_ms(cfg_.fade_ms);
    slots_.set_scenes(comp_.get());
    Governor *gov = &comp_->governor();
    slots_.on_evidence = [this, gov](Evidence e, const std::string &detail, int64_t now_ms) {
        if (e == Evidence::Removal)
            log_info("%s", trace_.recent_text().c_str());
        gov->evidence(e, now_ms, detail);
    };
    slots_.budget_text = [gov]() {
        return "cap " + std::to_string((unsigned long long)(gov->cap() / 1024)) + " ceiling " +
               std::to_string((unsigned long long)(gov->ceiling() / 1024));
    };
    server_.reset(new Server(comp_.get(), &slots_, cfg_.backend));
    CeilingMemory *memory = memory_.get();
    server_->ceiling_text = [memory]() { return memory->status_text(); };
    server_->set_scene_files(cfg_.scene_files);
    server_->set_drop_ins(cfg_.drop_ins);
}

bool Service::start(std::string *err)
{
    return comp_->init(err) && server_->listen(cfg_.socket_path, cfg_.socket_mode, cfg_.socket_group, err);
}

size_t Service::poll_fds(std::vector<pollfd> *fds) const
{
    const size_t first = fds->size();
    server_->poll_fds(fds);
    return first;
}

int Service::timeout_ms(int64_t now_ms) const
{
    bool active = false;
    for (size_t i = 0; i < slots_.targets().size(); i++)
        active = active || slots_.requested((int)i) || (slots_.loaded((int)i) && comp_->pending((int)i));
    /* Idle: four times a second, so a stalled layer's state, a slot poll and
     * the status file stay current. A loaded target alone stays idle: what
     * a client sends wakes the loop, and only a change left to flush ticks
     * it at the frame rate. */
    int64_t t = active ? 1000 / std::max(1, cfg_.fps) : 250;
    for (int64_t w : {comp_->wake_in_ms(now_ms), slots_.wake_in_ms(now_ms)})
        if (w > 0 && w < t)
            t = w;
    return (int)t;
}

void Service::after_poll(const std::vector<pollfd> &fds, size_t first, int64_t now_ms)
{
    server_->handle(fds, first, now_ms);
    comp_->arrange(now_ms);
    slots_.follow(now_ms);
    slots_.tick(now_ms);
    comp_->render(now_ms);
    server_->report(now_ms);
    if (second_ms_ < 0)
        second_ms_ = now_ms;
    else if (now_ms - second_ms_ >= 1000)
        sample(now_ms);
    if (now_ms - minute_ms_ >= kMinuteMs) {
        minute_ms_ = now_ms;
        log_minute(now_ms);
    }
    if (!cfg_.status_path.empty() && now_ms - status_ms_ >= 1000) {
        status_ms_ = now_ms;
        const std::string tmp = cfg_.status_path + ".tmp";
        const std::string text = server_->status_text(now_ms);
        int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
        if (fd >= 0) {
            const bool whole = write(fd, text.data(), text.size()) == (ssize_t)text.size();
            close(fd);
            if (whole)
                rename(tmp.c_str(), cfg_.status_path.c_str());
            else
                unlink(tmp.c_str());
        }
    }
}

namespace {

/* The whole table at path; "" when it cannot be read. */
std::string read_table(const std::string &path)
{
    std::string out;
    const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return out;
    char buf[16384];
    for (;;) {
        const ssize_t r = read(fd, buf, sizeof buf);
        if (r <= 0 || out.size() > (4u << 20))
            break;
        out.append(buf, (size_t)r);
    }
    close(fd);
    return out;
}

}  // namespace

void Service::sample(int64_t now_ms)
{
    /* A layer gone since takes its counts with it: that second counts 0. */
    auto since = [](uint64_t now, uint64_t then) { return now >= then ? now - then : 0; };
    WriteStats w;
    bool shown = false;
    for (size_t i = 0; i < slots_.targets().size(); i++) {
        const WriteStats t = comp_->write_stats((int)i);
        w.frames += t.frames;
        w.bytes += t.bytes;
        w.holds += t.holds;
        w.age_ms += t.age_ms;
        const TargetSpec &spec = slots_.targets()[i];
        shown = shown || (slots_.status((int)i).state == TargetState::Shown && spec.follows.empty() && !spec.share);
    }
    LinkTrace::Second s;
    s.kb = since(w.bytes, written_.bytes) / 1024;
    s.holds = since(w.holds, written_.holds);
    const uint64_t frames = since(w.frames, written_.frames);
    if (frames)
        s.flush_ms = (int64_t)(since(w.age_ms, written_.age_ms) / frames);
    /* Read only while writes go. */
    if (s.kb)
        for (const std::string &path : cfg_.tcp_tables) {
            std::string peer;
            const int64_t q = deepest_send_queue(read_table(path), &peer);
            if (q >= 0 && q / 1024 >= s.queue_kb) {
                s.queue_kb = q / 1024;
                s.peer = peer;
            }
        }
    trace_.add(s);
    written_ = w;
    memory_->update(shown ? now_ms - second_ms_ : 0, comp_->governor().removal_level() / 1024);
    second_ms_ = now_ms;
}

void Service::log_minute(int64_t now_ms)
{
    const std::string upload = trace_.minute_text();
    if (!upload.empty())
        log_info("%s", upload.c_str());
    stats_.resize(slots_.targets().size());
    stats_ms_.resize(slots_.targets().size(), now_ms);
    for (size_t i = 0; i < slots_.targets().size(); i++) {
        if (slots_.status((int)i).state != TargetState::Shown)
            continue;
        const WriteStats w = comp_->write_stats((int)i), &last = stats_[i];
        /* A layer gone since takes its counts with it. */
        auto since = [](uint64_t now, uint64_t then) { return now >= then ? now - then : now; };
        const std::string rendering = slots_.rendering_text((int)i, now_ms);
        const uint64_t frames = since(w.frames, last.frames);
        const Governor &gov = comp_->governor();
        log_info("target %s: in the last %lld s its layers wrote %llu frames (%llu ms from offer to flush on average), "
                 "%llu KB, %llu failed, %llu budget holds (cap %llu KB/s, ceiling %llu); %s",
                 slots_.targets()[i].name.c_str(), (long long)((now_ms - stats_ms_[i]) / 1000),
                 (unsigned long long)frames,
                 (unsigned long long)(frames ? since(w.age_ms, last.age_ms) / frames : 0),
                 (unsigned long long)(since(w.bytes, last.bytes) / 1024),
                 (unsigned long long)since(w.failed, last.failed), (unsigned long long)since(w.holds, last.holds),
                 (unsigned long long)(gov.cap() / 1024), (unsigned long long)(gov.ceiling() / 1024),
                 rendering.c_str());
        stats_[i] = w;
        stats_ms_[i] = now_ms;
    }
}

void Service::shutdown(int64_t now_ms)
{
    for (size_t i = 0; i < slots_.targets().size(); i++)
        slots_.want((int)i, false, false);
    /* Lingering targets are released at once: past every linger. */
    slots_.tick(now_ms);
    slots_.tick(now_ms + 3600 * 1000);
    slots_.unpublish_all();
}

}  // namespace crs
