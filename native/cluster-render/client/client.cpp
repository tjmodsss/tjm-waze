/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
#include "cluster_render/client.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <unistd.h>

namespace cr {

namespace {

#ifdef MSG_NOSIGNAL
const int kSendFlags = MSG_NOSIGNAL;
#else
const int kSendFlags = 0;   /* the app ignores SIGPIPE */
#endif

std::string num(double v)
{
    char b[32];
    std::snprintf(b, sizeof b, "%.6g", v);
    return b;
}

std::string flag(bool b) { return b ? "1" : "0"; }

/* After each failed connection: 0.25, 0.5, 1, then every 2 s. */
const int64_t kBackoff[] = {250, 500, 1000, 2000};

}  // namespace

Client::Client(const std::string &app, const std::string &socket_path) : app_(app), path_(socket_path)
{
}

Client::~Client()
{
    if (fd_ >= 0)
        close(fd_);
    for (auto &kv : shm_)
        shm_close(&kv.second);
    if (cur_fd_ >= 0)
        close(cur_fd_);
}

void Client::connect_now(int64_t now_ms)
{
    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof addr.sun_path, "%s", path_.c_str());
    fd_ = socket(AF_UNIX, SOCK_STREAM, 0);
    /* Room for a whole video frame in flight (the kernel caps it). */
    int buf = 1 << 20;
    if (fd_ >= 0)
        setsockopt(fd_, SOL_SOCKET, SO_SNDBUF, &buf, sizeof buf);
    if (fd_ < 0 || ::connect(fd_, (struct sockaddr *)&addr, sizeof addr) < 0) {
        disconnect(now_ms);
        return;
    }
    fcntl(fd_, F_SETFD, FD_CLOEXEC);
    fcntl(fd_, F_SETFL, fcntl(fd_, F_GETFL) | O_NONBLOCK);
    queue(json_object({{"op", json_quote("hello")}, {"app", json_quote(app_)}, {"proto", num(kProtocolVersion)}}));
    replay(false);
    write_out();
}

bool Client::in_canvas(const Layer &l) { return l.kind == "canvas" || l.canvas; }

bool Client::held(uint32_t ref) const
{
    auto it = layers_.find(ref);
    if (it == layers_.end())
        return false;
    const Layer &l = it->second;
    return (in_canvas(l) && !(ready_ && canvas_)) || (texty(l) && !(ready_ && text_));
}

void Client::queue_for(uint32_t ref, const std::string &json)
{
    if (!held(ref))
        queue(json);
}

void Client::replay(bool canvases)
{
    auto drawn_in = [this](uint32_t ref) {
        auto it = layers_.find(ref);
        return it != layers_.end() && late(it->second);
    };
    /* Assets and canvases first, so binds and the layers drawn in a canvas
     * find them; binds and animations once every layer and part is made. */
    for (int pass = 0; pass < 2; pass++)
        for (auto &kv : layers_) {
            Layer &l = kv.second;
            if (late(l) != canvases || (canvases && held(kv.first)) ||
                (l.kind == "asset" || l.kind == "canvas" || l.kind == "value" || l.kind == "font") != (pass == 0))
                continue;
            queue(layer_json(kv.first, l));
            if (!l.edits.empty())
                queue(edits_json(kv.first, l));
            for (const auto &h : l.hosts)
                queue(h.second);
            /* in the order they were made: a parent before what follows it */
            std::vector<const Part *> parts;
            for (const auto &p : l.parts)
                parts.push_back(&p.second);
            std::sort(parts.begin(), parts.end(), [](const Part *a, const Part *b) { return a->made < b->made; });
            for (const Part *p : parts) {
                queue(p->json);
                if (!p->geometry.empty())
                    queue_message(p->geometry);
                if (!p->transform.empty())
                    queue(p->transform);
            }
            for (const auto &u : l.uniforms)
                queue(u.second);
            if ((l.kind == "image" || l.kind == "asset") && l.have) {
                l.whole = true;   /* sent once the service says hello */
                l.dirty.clear();
                l.dirty_bytes = 0;
            }
        }
    for (const auto &kv : layers_) {
        for (const auto &b : kv.second.binds)
            if ((late(kv.second) || drawn_in(b.second.first)) == canvases && !held(kv.first) &&
                !held(b.second.first))
                queue(b.second.second);
        for (const auto &b : kv.second.links)
            if (late(kv.second) == canvases && !held(kv.first))
                queue(b.second.second);
    }
    for (const auto &kv : layers_)
        if (late(kv.second) == canvases && !held(kv.first))
            for (const auto &a : kv.second.animations)
                queue(a.second);
}

void Client::disconnect(int64_t now_ms)
{
    if (fd_ >= 0)
        close(fd_);
    fd_ = -1;
    ready_ = false;
    in_.clear();
    hosts.clear();
    /* The newest frame each video layer was given stays its last: the one
     * on its way, then any still waiting. */
    if (!cur_px_.empty())
        keep_last(last_frame_ref_, &cur_px_);
    for (auto &f : frames_)
        keep_last(f.first, &f.second.px);
    for (auto &kv : layers_)
        kv.second.sent = false;
    repeats_ = always_packed_ = preload_ = others_fps_ = render_state_ = samplers_ = host_layers_ = host_hide_ = fresh_ms_ = canvas_ = curves_ = nodes_ = draw_ = instances_ = cube_ = values_ = shm_frames_ = scene_anim_ = over_order_ = text_ = false;
    for (auto &kv : shm_)
        shm_close(&kv.second);
    shm_.clear();
    shm_due_.clear();
    if (cur_fd_ >= 0)
        close(cur_fd_);
    cur_fd_ = -1;
    if (fps_cap) {
        fps_cap = 0;
        fps_cap_app.clear();
        if (on_fps_cap)
            on_fps_cap(0, "");
    }
    cur_.clear();
    cur_px_.clear();
    cur_off_ = 0;
    ctl_.clear();
    frames_.clear();
    repeats_due_.clear();
    retry_ms_ = now_ms + kBackoff[backoff_ < 3 ? backoff_ : 3];
    if (backoff_ < 3)
        backoff_++;
}

bool Client::wants_write() const
{
    if (fd_ < 0)
        return false;
    if (!cur_.empty() || !ctl_.empty() || !frames_.empty() || !repeats_due_.empty())
        return true;
    for (const auto &kv : layers_)
        if ((kv.second.kind == "image" || kv.second.kind == "asset") && (kv.second.whole || !kv.second.dirty.empty()))
            return ready_;
    return false;
}

void Client::poll(int64_t now_ms)
{
    if (fd_ < 0) {
        if (now_ms >= retry_ms_)
            connect_now(now_ms);
        return;
    }
    read_events();
    if (fd_ >= 0)
        write_out();
    if (fd_ < 0)
        retry_ms_ = now_ms + kBackoff[backoff_ < 3 ? backoff_ : 3];
}

void Client::read_events()
{
    char buf[16384];
    for (;;) {
        ssize_t r = read(fd_, buf, sizeof buf);
        if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) {
            disconnect(0);
            return;
        }
        if (r < 0)
            break;
        in_.append(buf, (size_t)r);
    }
    size_t off = 0;
    for (;;) {
        size_t used = 0, n = 0;
        uint8_t type = 0;
        const char *body = nullptr;
        bool bad = false;
        if (!next_message(in_.data() + off, in_.size() - off, &used, &type, &body, &n, &bad)) {
            if (bad) {
                disconnect(0);
                return;
            }
            break;
        }
        off += used;
        Json j;
        if (type != kJson || !parse_json(std::string(body, n), &j))
            continue;
        const std::string ev = j["ev"];
        if (ev == "hello") {
            backend = j["backend"];
            targets = j["targets"];
            repeats_ = j["repeat"] == "1";
            always_packed_ = j["always_packed"] == "1";
            preload_ = j["preload"] == "1";
            others_fps_ = j["others_fps"] == "1";
            render_state_ = j["render_state"] == "1";
            samplers_ = j["samplers"] == "1";
            host_layers_ = j["host_layers"] == "1";
            host_hide_ = j["host_hide"] == "1";
            fresh_ms_ = j["fresh_ms"] == "1";
            canvas_ = j["canvas"] == "1";
            curves_ = j["curves"] == "1";
            nodes_ = j["nodes"] == "1";
            draw_ = j["draw"] == "1";
            instances_ = j["instances"] == "1";
            cube_ = j["cube"] == "1";
            values_ = j["values"] == "1";
            shm_frames_ = j["shm_frames"] == "1";
            if (shm_frames_)
                for (const auto &kv : layers_)
                    if (kv.second.kind == "video" && !held(kv.first))
                        shm_due_.insert(kv.first);
            scene_anim_ = j["scene_anim"] == "1";
            text_ = j["text"] == "1";
            over_order_ = j["over_order"] == "1";
            ready_ = true;
            backoff_ = 0;
            /* after the layers, which went at connect */
            if (host_layers_)
                for (const auto &kv : layer_hosts_)
                    queue(kv.second.second);
            /* Canvases and the layers drawn in them only to a service that
             * takes them: an older one would draw such a layer on screen;
             * fonts and text layers likewise. */
            if (canvas_ || text_)
                replay(true);
            if (on_ready)
                on_ready();
        } else if (ev == "shm") {
            auto m = shm_.find((uint32_t)std::strtoul(j["ref"].c_str(), nullptr, 10));
            if (m != shm_.end())
                m->second.state = j["ok"] == "1" ? Shm::Ok : Shm::Refused;
        } else if (ev == "layer" && on_layer) {
            on_layer((uint32_t)std::strtoul(j["ref"].c_str(), nullptr, 10), j["state"], j["reason"]);
        } else if (ev == "target") {
            guide_disabled[j["target"]] = j["guide_disabled"] == "1";
            disabled[j["target"]] = j["disabled"] == "1";
            if (on_target)
                on_target(j["target"], j["state"], j["holder"], j["reason"]);
        } else if (ev == "error") {
            const uint32_t ref = (uint32_t)std::strtoul(j["ref"].c_str(), nullptr, 10);
            /* A layer the service refused or lost: its next frame goes whole,
             * which the service answers at most once. */
            auto l = layers_.find(ref);
            if (l != layers_.end())
                l->second.sent = false;
            /* a host refused is not sent again after a reconnect */
            if (l != layers_.end() && j["op"] == "host")
                l->second.hosts.erase(j["target"]);
            /* a host from layers refused: the service ended this client's
             * host of the target; forgotten here when it is the one refused
             * (one sent since, into another target, still holds) */
            if (j["op"] == "host" && j.count("into")) {
                auto lh = layer_hosts_.find(j["target"]);
                if (lh != layer_hosts_.end() && lh->second.first == j["into"])
                    layer_hosts_.erase(lh);
            }
            if (on_error)
                on_error(j["op"], ref, j["reason"]);
        } else if (ev == "budget" && on_budget) {
            on_budget((unsigned)std::strtoul(j["cap_kb_per_s"].c_str(), nullptr, 10),
                      (unsigned)std::strtoul(j["max_kb_per_s"].c_str(), nullptr, 10), j["reason"]);
        } else if (ev == "fps_cap") {
            fps_cap = (unsigned)std::strtoul(j["fps"].c_str(), nullptr, 10);
            fps_cap_app = fps_cap ? j["app"] : std::string();
            if (on_fps_cap)
                on_fps_cap(fps_cap, fps_cap_app);
        } else if (ev == "status" && on_status) {
            on_status(j["text"]);
        } else if (ev == "hosting") {
            if (on_hosting)
                on_hosting(j["target"], j["into"], j["state"], j["reason"]);
        } else if (ev == "host") {
            Host h;
            h.target = j["target"];
            h.into = j["into"];
            h.shown = j["shown"] == "1";
            int *ints[] = {&h.x, &h.y, &h.src_x, &h.src_y};
            unsigned *sizes[] = {&h.w, &h.h, &h.src_w, &h.src_h};
            const char *const ik[] = {"x", "y", "src_x", "src_y"}, *const sk[] = {"w", "h", "src_w", "src_h"};
            for (int i = 0; i < 4; i++) {
                *ints[i] = (int)std::strtol(j[ik[i]].c_str(), nullptr, 10);
                *sizes[i] = (unsigned)std::strtoul(j[sk[i]].c_str(), nullptr, 10);
            }
            if (h.into.empty())
                hosts.erase(h.target);
            else
                hosts[h.target] = h;
            if (on_host)
                on_host(h);
        }
        if (fd_ < 0)
            return;
    }
    in_.erase(0, off);
}

void Client::write_out()
{
    for (;;) {
        if (cur_off_ >= cur_.size() + cur_px_.size()) {
            cur_.clear();
            cur_off_ = 0;
            if (!cur_px_.empty()) {
                auto l = layers_.find(last_frame_ref_);
                if (l != layers_.end())
                    l->second.sent = true;
                keep_last(last_frame_ref_, &cur_px_);
            }
            if (!repeats_due_.empty()) {
                cur_ = encode(kJson, json_object({{"op", json_quote("repeat")}, {"ref", num(*repeats_due_.begin())}}));
                repeats_due_.erase(repeats_due_.begin());
            } else if (!ctl_.empty()) {
                cur_.swap(ctl_.front());
                ctl_.pop_front();
            } else if (ready_ && next_image(&cur_)) {
                /* an image layer's changes */
            } else if (ready_ && next_shm()) {
                /* a video layer's shared buffer */
            } else if (!frames_.empty()) {
                /* Round robin over the layers with a frame waiting. */
                auto it = frames_.upper_bound(last_frame_ref_);
                if (it == frames_.end())
                    it = frames_.begin();
                last_frame_ref_ = it->first;
                if (shm_frame(it->first, it->second.px)) {
                    /* copied into a slot: sent as soon as its message is */
                    auto l = layers_.find(it->first);
                    if (l != layers_.end())
                        l->second.sent = true;
                    keep_last(it->first, &it->second.px);
                } else {
                    cur_.swap(it->second.head);
                    cur_px_.swap(it->second.px);
                }
                frames_.erase(it);
            } else {
                return;
            }
        }
        struct iovec iov[2];
        struct msghdr mh;
        std::memset(&mh, 0, sizeof mh);
        mh.msg_iov = iov;
        if (cur_off_ < cur_.size()) {
            iov[mh.msg_iovlen].iov_base = const_cast<char *>(cur_.data() + cur_off_);
            iov[mh.msg_iovlen++].iov_len = cur_.size() - cur_off_;
        }
        const size_t px_off = cur_off_ > cur_.size() ? cur_off_ - cur_.size() : 0;
        if (px_off < cur_px_.size()) {
            iov[mh.msg_iovlen].iov_base = cur_px_.data() + px_off;
            iov[mh.msg_iovlen++].iov_len = cur_px_.size() - px_off;
        }
        union {
            char buf[CMSG_SPACE(sizeof(int))];
            struct cmsghdr align;
        } ctl;
        const bool with_fd = cur_fd_ >= 0 && cur_off_ == 0;
        if (with_fd) {
            mh.msg_control = ctl.buf;
            mh.msg_controllen = sizeof ctl.buf;
            struct cmsghdr *c = CMSG_FIRSTHDR(&mh);
            c->cmsg_level = SOL_SOCKET;
            c->cmsg_type = SCM_RIGHTS;
            c->cmsg_len = CMSG_LEN(sizeof(int));
            std::memcpy(CMSG_DATA(c), &cur_fd_, sizeof(int));
        }
        ssize_t w = ::sendmsg(fd_, &mh, kSendFlags);
        if (w < 0 && with_fd && errno != EAGAIN && errno != EINTR) {
            /* The descriptor not taken: the message goes without it, the
             * service refuses it, and frames go whole on this connection. */
            close(cur_fd_);
            cur_fd_ = -1;
            shm_frames_ = false;
            continue;
        }
        if (w < 0) {
            if (errno != EAGAIN && errno != EINTR)
                disconnect(0);
            return;
        }
        if (with_fd && w > 0) {
            close(cur_fd_);   /* the service has its own now; the mapping stays */
            cur_fd_ = -1;
        }
        cur_off_ += (size_t)w;
    }
}

void Client::queue(const std::string &json)
{
    if (fd_ < 0)
        return;
    ctl_.push_back(encode(kJson, json));
}

void Client::queue_message(const std::string &msg)
{
    if (fd_ >= 0)
        ctl_.push_back(msg);
}

void Client::send_now()
{
    if (fd_ >= 0)
        write_out();
}

void Client::turn_fields(std::vector<std::pair<std::string, std::string>> *kv, const LayerOptions &lo) const
{
    kv->push_back({"rotate", num(lo.rotate)});
    kv->push_back({"sx", num(lo.sx)});
    kv->push_back({"sy", num(lo.sy)});
    if (lo.pivot) {
        kv->push_back({"px", num(lo.px)});
        kv->push_back({"py", num(lo.py)});
    }
}

void Client::mesh_fields(std::vector<std::pair<std::string, std::string>> *kv, const MeshOptions &mo) const
{
    const std::pair<const char *, float> f[] = {{"fov", mo.fov}, {"ortho_h", mo.ortho_h}, {"near", mo.near},
                                                {"far", mo.far},  {"cx", mo.cx},           {"cy", mo.cy},
                                                {"cz", mo.cz},    {"crx", mo.crx},         {"cry", mo.cry},
                                                {"crz", mo.crz}};
    kv->push_back({"projection", json_quote(mo.ortho ? "ortho" : "perspective")});
    for (const auto &p : f)
        kv->push_back({p.first, num(p.second)});
}

std::vector<std::pair<std::string, std::string>> Client::fields(const char *op, uint32_t ref,
                                                                const LayerOptions &lo) const
{
    std::vector<std::pair<std::string, std::string>> kv = {
        {"op", json_quote(op)},          {"ref", num(ref)},
        {"class", json_quote(lo.klass)}, {"z", num(lo.z)},
        {"x", num(lo.x)},                {"y", num(lo.y)},
        {"visible", flag(lo.visible)},   {"exclusive", flag(lo.exclusive)},
        {"prewarm", flag(lo.prewarm)},   {"preload", flag(lo.preload)},
        {"contend", flag(lo.contend)},   {"guide_hold", flag(lo.guide_hold)},
        {"yield", flag(lo.yield)},       {"opacity", num(lo.opacity)}};
    if (lo.w && lo.h) {
        kv.push_back({"w", num(lo.w)});
        kv.push_back({"h", num(lo.h)});
    }
    if (lo.others_fps)
        kv.push_back({"others_fps", num(lo.others_fps)});
    if (!lo.hosted.empty())
        kv.push_back({"hosted", json_quote(lo.hosted)});
    return kv;
}

std::string Client::edits_json(uint32_t ref, const Layer &l) const
{
    std::vector<std::pair<uint64_t, std::string>> lines;
    for (const auto &kv : l.edits)
        lines.push_back(kv.second);
    std::sort(lines.begin(), lines.end());
    std::string text;
    for (const auto &line : lines)
        text += (text.empty() ? "" : "\n") + line.second;
    return json_object({{"op", json_quote("edit")}, {"ref", num(ref)}, {"lines", json_quote(text)}});
}

namespace {

/* A render state's fields that are set (PROTOCOL.md "Render state"). */
void look_fields(std::vector<std::pair<std::string, std::string>> *kv, const RenderState &r)
{
    const std::pair<const char *, const std::string *> named[] = {
        {"blend", &r.blend},           {"blend_src", &r.blend_src},
        {"blend_dst", &r.blend_dst},   {"blend_src_alpha", &r.blend_src_alpha},
        {"blend_dst_alpha", &r.blend_dst_alpha}, {"blend_op", &r.blend_op},
        {"blend_op_alpha", &r.blend_op_alpha}, {"color_mask", &r.color_mask},
        {"depth_func", &r.depth_func}};
    for (const auto &f : named)
        if (!f.second->empty())
            kv->push_back({f.first, json_quote(*f.second)});
    if (r.depth_write >= 0)
        kv->push_back({"depth_write", r.depth_write ? "1" : "0"});
    const std::pair<const char *, const std::string *> stencil[] = {
        {"stencil_func", &r.stencil_func}, {"stencil_fail", &r.stencil_fail},
        {"stencil_depth_fail", &r.stencil_depth_fail}, {"stencil_pass", &r.stencil_pass}};
    for (const auto &f : stencil)
        if (!f.second->empty())
            kv->push_back({f.first, json_quote(*f.second)});
    if (r.stencil_ref >= 0)
        kv->push_back({"stencil_ref", std::to_string(r.stencil_ref)});
    if (r.stencil_mask >= 0)
        kv->push_back({"stencil_mask", std::to_string(r.stencil_mask)});
    if (!r.draw.empty())
        kv->push_back({"draw", json_quote(r.draw)});
    if (r.instances)
        kv->push_back({"instances", std::to_string(r.instances)});
}

}  // namespace

std::string Client::layer_json(uint32_t ref, const Layer &l) const
{
    if (l.kind == "value" || l.kind == "font")
        return l.value;
    if (l.kind == "scene") {
        std::string res, sha;
        for (const std::string &r : l.so.res)
            res += (res.empty() ? "" : " ") + r;
        for (const std::string &h : l.so.sha256)
            sha += (sha.empty() ? "" : " ") + h;
        std::vector<std::pair<std::string, std::string>> kv = {{"op", json_quote("scene")},
                                                               {"ref", num(ref)},
                                                               {"target", json_quote(l.so.target)},
                                                               {"file", json_quote(l.so.file)},
                                                               {"res", json_quote(res)},
                                                               {"sha256", json_quote(sha)},
                                                               {"contend", flag(l.so.contend)}};
        if (l.so.layers)
            kv.push_back({"layers", "1"});
        if (l.so.layers && l.so.layers_order_set)
            kv.push_back({"layers_order", num(l.so.layers_order)});
        if (l.so.layers && l.so.over_order_set)
            kv.push_back({"over_order", num(l.so.over_order)});
        return json_object(kv);
    }
    if (l.kind == "asset") {
        std::vector<std::pair<std::string, std::string>> kv = {
            {"op", json_quote("asset")},
            {"ref", num(ref)},
            {"target", json_quote(l.ao.target)},
            {"format", json_quote(l.ao.r8 ? "r8" : "rgba8")},
            {"w", num(l.ao.w)},
            {"h", num(l.ao.h)},
            {"sampling", json_quote(!l.sampler.sampling.empty() ? l.sampler.sampling
                                    : l.ao.bilinear                ? "bilinear"
                                                                   : "nearest")},
            {"wrap", json_quote(l.ao.repeat ? "repeat" : "clamp")}};
        if (!l.sampler.wrap_u.empty())
            kv.push_back({"wrap_u", json_quote(l.sampler.wrap_u)});
        if (!l.sampler.wrap_v.empty())
            kv.push_back({"wrap_v", json_quote(l.sampler.wrap_v)});
        if (l.sampler.anisotropy)
            kv.push_back({"anisotropy", num(l.sampler.anisotropy)});
        if (l.cube)
            kv.push_back({"cube", "1"});
        return json_object(kv);
    }
    if (l.kind == "canvas") {
        std::vector<std::pair<std::string, std::string>> kv = {
            {"op", json_quote("canvas")}, {"ref", num(ref)}, {"target", json_quote(l.co.target)},
            {"w", num(l.co.w)},           {"h", num(l.co.h)}};
        if (l.co.depth)
            kv.push_back({"depth", "1"});
        if (l.co.once)
            kv.push_back({"once", "1"});
        kv.push_back({"clear", json_quote(num(l.co.clear[0]) + " " + num(l.co.clear[1]) + " " + num(l.co.clear[2]) +
                                          " " + num(l.co.clear[3]))});
        const std::pair<const char *, const std::string *> named[] = {{"sampling", &l.co.sampler.sampling},
                                                                      {"wrap_u", &l.co.sampler.wrap_u},
                                                                      {"wrap_v", &l.co.sampler.wrap_v}};
        for (const auto &f : named)
            if (!f.second->empty())
                kv.push_back({f.first, json_quote(*f.second)});
        if (l.co.sampler.anisotropy)
            kv.push_back({"anisotropy", num(l.co.sampler.anisotropy)});
        return json_object(kv);
    }
    std::vector<std::pair<std::string, std::string>> kv = fields("layer", ref, l.lo);
    if (l.canvas)
        kv.push_back({"canvas", num(l.canvas)});
    kv.push_back({"target", json_quote(l.lo.target)});
    kv.push_back({"kind", json_quote(l.kind)});
    if (l.kind == "video") {
        turn_fields(&kv, l.lo);
        kv.push_back({"vw", num(l.vo.w)});
        kv.push_back({"vh", num(l.vo.h)});
        kv.push_back({"fps", num(l.vo.fps)});
        kv.push_back({"level_bits", num(l.vo.level_bits)});
        kv.push_back({"dirty_threshold", num(l.vo.dirty_threshold)});
        kv.push_back({"settle_ms", num(l.vo.settle_ms)});
        kv.push_back({"pan_blocks", flag(l.vo.pan_blocks)});
        kv.push_back({"stall_ms", num(l.vo.stall_ms)});
        if (l.vo.always_packed)   /* only when set: a layer without it is written exact */
            kv.push_back({"always_packed", "1"});
        if (l.vo.fresh_ms)
            kv.push_back({"fresh_ms", num(l.vo.fresh_ms)});
    } else if (l.kind == "image") {
        kv.push_back({"iw", num(l.io.w)});
        kv.push_back({"ih", num(l.io.h)});
        kv.push_back({"fps", num(l.io.fps)});
        kv.push_back({"sampling", json_quote(l.io.bilinear ? "bilinear" : "nearest")});
        turn_fields(&kv, l.lo);
    } else if (l.kind == "mesh") {
        mesh_fields(&kv, l.mo);
    } else if (l.kind == "text") {
        kv.push_back({"font", num(l.font)});
        kv.push_back({"max", num(l.to.max)});
        text_fields(&kv, l.to);
        kv.push_back({"text", json_quote(l.text)});
        turn_fields(&kv, l.lo);
    } else {
        kv.push_back({"fs", json_quote(l.eo.fs)});
        if (!l.eo.vs.empty())
            kv.push_back({"vs", json_quote(l.eo.vs)});
        kv.push_back({"time_fps", num(l.eo.time_fps)});
        if (l.cluster_time)
            kv.push_back({"time", "1"});
        look_fields(&kv, l.look);
        turn_fields(&kv, l.lo);
    }
    return json_object(kv);
}

std::string Client::uniform_json(uint32_t ref, const std::string &name, const std::vector<float> &v) const
{
    std::string vals;
    for (float f : v)
        vals += (vals.empty() ? "" : " ") + num(f);
    return json_object({{"op", json_quote("uniform")}, {"ref", num(ref)}, {"name", json_quote(name)},
                        {"v", json_quote(vals)}});
}

uint32_t Client::add(const Layer &l)
{
    const uint32_t ref = next_ref_++;
    layers_[ref] = l;
    queue_for(ref, layer_json(ref, l));
    if (shm_frames_ && l.kind == "video" && !held(ref))
        shm_due_.insert(ref);
    if (fd_ >= 0)
        write_out();
    return ref;
}

uint32_t Client::video(const LayerOptions &lo, const VideoOptions &vo)
{
    Layer l;
    l.kind = "video";
    l.lo = lo;
    l.vo = vo;
    return add(l);
}

uint32_t Client::image(const LayerOptions &lo, const ImageOptions &io)
{
    Layer l;
    l.kind = "image";
    l.lo = lo;
    l.io = io;
    if (!l.io.w || !l.io.h) {
        l.io.w = lo.w;
        l.io.h = lo.h;
    }
    if (!l.io.w || !l.io.h || l.io.w > 1920 || l.io.h > 720)
        return 0;
    l.w = l.io.w;
    l.h = l.io.h;
    l.image.assign((size_t)l.io.w * l.io.h * 4, 0);
    return add(l);
}

uint32_t Client::effect(const LayerOptions &lo, const EffectOptions &eo)
{
    return effect(lo, eo, false);
}

uint32_t Client::effect(const LayerOptions &lo, const EffectOptions &eo, bool cluster_time)
{
    return effect(lo, eo, cluster_time, RenderState());
}

uint32_t Client::effect(const LayerOptions &lo, const EffectOptions &eo, bool cluster_time, const RenderState &look)
{
    Layer l;
    l.kind = "effect";
    l.lo = lo;
    l.eo = eo;
    l.cluster_time = cluster_time;
    l.look = look;
    return add(l);
}

uint32_t Client::font(uint32_t asset, const FontOptions &fo)
{
    auto a = layers_.find(asset);
    if (a == layers_.end() || a->second.kind != "asset" || !a->second.ao.r8 || a->second.cube || !fo.line ||
        fo.glyphs.empty())
        return 0;
    Layer l;
    l.kind = "font";
    l.lo.target = a->second.ao.target;
    l.font = asset;
    std::vector<std::pair<std::string, std::string>> kv = {
        {"op", json_quote("font")}, {"ref", num(next_ref_)},           {"asset", num(asset)},
        {"line", num(fo.line)},     {"glyphs", json_quote(fo.glyphs)}};
    if (fo.sdf)
        kv.push_back({"sdf", num(fo.sdf)});
    if (!fo.kerning.empty())
        kv.push_back({"kerning", json_quote(fo.kerning)});
    l.value = json_object(kv);
    return add(l);
}

uint32_t Client::font(const std::string &target, unsigned w, unsigned h, const uint8_t *px, const FontOptions &fo)
{
    if (!fo.line || fo.glyphs.empty() || !w || !h || w > 2048 || h > 2048 || (size_t)w * h + 64 > kMaxMessage)
        return 0;
    Layer a;
    a.kind = "asset";
    a.ao.target = target;
    a.ao.r8 = true;
    a.ao.w = w;
    a.ao.h = h;
    a.ao.bilinear = true;
    a.w = w;
    a.h = h;
    a.bpp = 1;
    a.atlas = true;
    a.image.assign(px, px + (size_t)w * h);
    a.whole = a.have = true;
    const uint32_t atlas = add(a);
    const uint32_t ref = font(atlas, fo);
    if (!ref) {
        drop(atlas);
        return 0;
    }
    layers_[ref].owns = true;
    return ref;
}

void Client::text_fields(std::vector<std::pair<std::string, std::string>> *kv, const TextLayerOptions &to)
{
    kv->push_back({"align", json_quote(to.align)});
    kv->push_back({"spacing", num(to.spacing)});
    kv->push_back({"size", num(to.size)});
    kv->push_back({"color", json_quote(num(to.color[0]) + " " + num(to.color[1]) + " " + num(to.color[2]) + " " +
                                       num(to.color[3]))});
}

namespace {

/* A text layer's string as the service takes it. */
bool text_ok(const std::string &text) { return text.size() <= kMaxTextBytes && utf8_ok(text); }

bool text_options_ok(const TextLayerOptions &to)
{
    bool ok = to.max >= 1 && to.max <= 256 && (to.align == "left" || to.align == "center" || to.align == "right") &&
              std::isfinite(to.spacing) && to.spacing >= -1024 && to.spacing <= 1024 && std::isfinite(to.size) &&
              to.size >= 0 && to.size <= 2048;
    for (float c : to.color)
        ok = ok && c >= 0 && c <= 1;
    return ok;
}

}  // namespace

uint32_t Client::text(const LayerOptions &lo, uint32_t font, const TextLayerOptions &to, const std::string &text)
{
    auto f = layers_.find(font);
    if (f == layers_.end() || f->second.kind != "font" || !text_options_ok(to) || !text_ok(text))
        return 0;
    Layer l;
    l.kind = "text";
    l.lo = lo;
    l.font = font;
    l.to = to;
    l.text = text;
    return add(l);
}

bool Client::set_text(uint32_t ref, const std::string &text)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || it->second.kind != "text" || !text_ok(text))
        return false;   /* the last string taken stays */
    if (it->second.text == text)
        return true;
    it->second.text = text;
    queue_for(ref, json_object({{"op", json_quote("text")}, {"ref", num(ref)}, {"text", json_quote(text)}}));
    send_now();
    return true;
}

bool Client::set_text_style(uint32_t ref, const TextLayerOptions &to)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || it->second.kind != "text" || !text_options_ok(to))
        return false;
    const unsigned max = it->second.to.max;   /* set when it is made */
    it->second.to = to;
    it->second.to.max = max;
    std::vector<std::pair<std::string, std::string>> kv = {{"op", json_quote("text")}, {"ref", num(ref)}};
    text_fields(&kv, to);
    queue_for(ref, json_object(kv));
    send_now();
    return true;
}

uint32_t Client::canvas(const CanvasOptions &co)
{
    if (!co.w || !co.h || co.w > 2048 || co.h > 2048)
        return 0;
    Layer l;
    l.kind = "canvas";
    l.co = co;
    return add(l);
}

uint32_t Client::effect_in(uint32_t canvas, const LayerOptions &lo, const EffectOptions &eo, bool cluster_time,
                           const RenderState &look)
{
    auto it = layers_.find(canvas);
    if (it == layers_.end() || it->second.kind != "canvas")
        return 0;
    Layer l;
    l.kind = "effect";
    l.lo = lo;
    l.lo.target = it->second.co.target;
    l.eo = eo;
    l.cluster_time = cluster_time;
    l.look = look;
    l.canvas = canvas;
    return add(l);
}

uint32_t Client::mesh_in(uint32_t canvas, const LayerOptions &lo, const MeshOptions &mo)
{
    auto it = layers_.find(canvas);
    if (it == layers_.end() || it->second.kind != "canvas")
        return 0;
    Layer l;
    l.kind = "mesh";
    l.lo = lo;
    l.lo.target = it->second.co.target;
    l.mo = mo;
    l.canvas = canvas;
    return add(l);
}

uint32_t Client::mesh(const LayerOptions &lo, const MeshOptions &mo)
{
    Layer l;
    l.kind = "mesh";
    l.lo = lo;
    l.mo = mo;
    return add(l);
}

uint32_t Client::asset(const AssetOptions &ao)
{
    return asset(ao, SamplerOptions());
}

uint32_t Client::asset(const AssetOptions &ao, const SamplerOptions &so)
{
    Layer l;
    l.kind = "asset";
    l.ao = ao;
    l.sampler = so;
    l.w = ao.w;
    l.h = ao.h;
    l.bpp = ao.r8 ? 1 : 4;
    if (!l.w || !l.h || l.w > 2048 || l.h > 2048 || (size_t)l.w * l.h * l.bpp + 64 > kMaxMessage)
        return 0;
    l.image.assign((size_t)l.w * l.h * l.bpp, 0);
    return add(l);
}

uint32_t Client::cube(const AssetOptions &ao, const SamplerOptions &so)
{
    Layer l;
    l.kind = "asset";
    l.ao = ao;
    l.ao.h = ao.w;
    l.sampler = so;
    l.cube = true;
    /* the six faces as one image of six rows of faces */
    l.w = ao.w;
    l.h = ao.w * 6;
    l.bpp = ao.r8 ? 1 : 4;
    if (!l.w || l.w > 2048 || (size_t)l.w * l.h * l.bpp + 64 > kMaxMessage)
        return 0;
    l.image.assign((size_t)l.w * l.h * l.bpp, 0);
    return add(l);
}

uint32_t Client::scene(const SceneOptions &so)
{
    if (so.file.empty() || so.sha256.size() != so.res.size() + 1)
        return 0;
    Layer l;
    l.kind = "scene";
    l.so = so;
    return add(l);
}

void Client::scene(uint32_t ref, const SceneOptions &so)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || it->second.kind != "scene" || so.file.empty() || so.sha256.size() != so.res.size() + 1)
        return;
    const std::string target = it->second.so.target;   /* set when it is made */
    it->second.so = so;
    it->second.so.target = target;
    it->second.edits.clear();
    it->second.hosts.clear();   /* the service ends them with the file it replaces */
    queue(layer_json(ref, it->second));
    send_now();
}

/* A host message: by is ("ref", the scene's) or ("into", a target's name). */
std::string Client::host_json(const std::pair<std::string, std::string> &by, const Host &h) const
{
    std::vector<std::pair<std::string, std::string>> kv = {
        {"op", json_quote("host")}, by,             {"target", json_quote(h.target)}, {"x", num(h.x)},
        {"y", num(h.y)},            {"w", num(h.w)}, {"h", num(h.h)},                  {"shown", flag(h.shown)}};
    if (h.hide)
        kv.push_back({"hide", "1"});
    if (h.src_w && h.src_h)
        kv.insert(kv.end(), {{"src_x", num(h.src_x)}, {"src_y", num(h.src_y)}, {"src_w", num(h.src_w)},
                             {"src_h", num(h.src_h)}});
    if (h.edge_top || h.edge_bottom)
        kv.insert(kv.end(), {{"edge_top", num(h.edge_top)}, {"edge_bottom", num(h.edge_bottom)},
                             {"edge_fade", num(h.edge_fade)}, {"edge_dim", num(h.edge_dim)},
                             {"edge_blur", num(h.edge_blur)}});
    return json_object(kv);
}

bool Client::host(uint32_t ref, const Host &h)
{
    auto it = layers_.find(ref);
    /* what the service refuses whatever it holds is not sent or kept */
    if (it == layers_.end() || it->second.kind != "scene" || !it->second.so.layers || h.target.empty() ||
        h.target == it->second.so.target)
        return false;
    const std::string json = host_json({"ref", num(ref)}, h);
    it->second.hosts[h.target] = json;
    queue(json);
    send_now();
    return true;
}

bool Client::host(const Host &h)
{
    if (h.into.empty() || h.target.empty() || h.into == h.target)
        return false;
    const std::string json = host_json({"into", json_quote(h.into)}, h);
    layer_hosts_[h.target] = {h.into, json};   /* into another target: the service moves it */
    /* to an older service nothing: it would refuse it (no such scene) */
    if (ready_ && host_layers_) {
        queue(json);
        send_now();
    }
    return true;
}

void Client::unhost(const std::string &target)
{
    auto it = layer_hosts_.find(target);
    /* sent also with nothing kept here (a refusal of an older host may have
     * crossed a newer one): the service ends whatever this client hosts of
     * target, whatever its into */
    if (ready_ && host_layers_) {
        queue(json_object({{"op", json_quote("unhost")},
                           {"into", json_quote(it != layer_hosts_.end() ? it->second.first : std::string())},
                           {"target", json_quote(target)}}));
        send_now();
    }
    if (it != layer_hosts_.end())
        layer_hosts_.erase(it);
}

void Client::edit(uint32_t ref, const std::string &lines)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || it->second.kind != "scene")
        return;
    size_t at = 0;
    while (at <= lines.size()) {
        size_t nl = lines.find('\n', at);
        if (nl == std::string::npos)
            nl = lines.size();
        std::string line = lines.substr(at, nl - at);
        at = nl + 1;
        if (!line.empty() && line.back() == '\r')
            line.pop_back();
        if (!line.empty() && !edit_once(line))
            it->second.edits[edit_key(line)] = std::make_pair(++edits_, line);
    }
    queue(json_object({{"op", json_quote("edit")}, {"ref", num(ref)}, {"lines", json_quote(lines)}}));
    send_now();
}

void Client::set(uint32_t ref, const LayerOptions &lo)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || it->second.kind == "asset" || it->second.kind == "scene")
        return;
    const std::string target = it->second.lo.target;
    const unsigned others_fps = it->second.lo.others_fps;
    const bool hosted = !it->second.lo.hosted.empty();
    it->second.lo = lo;
    it->second.lo.target = target;
    std::vector<std::pair<std::string, std::string>> kv = fields("set", ref, it->second.lo);
    if (others_fps && !lo.others_fps)
        kv.push_back({"others_fps", "0"});   /* the request ends */
    if (hosted && lo.hosted.empty())
        kv.push_back({"hosted", json_quote("")});   /* not the hosted picture any more */
    if (it->second.kind != "mesh")
        turn_fields(&kv, it->second.lo);
    queue_for(ref, json_object(kv));
    send_now();
}

void Client::set_look(uint32_t ref, const RenderState &look)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || it->second.kind != "effect")
        return;
    it->second.look = look;
    /* The service changes only the fields sent: the whole look goes, its
     * defaults included, so nothing of the last one stays. */
    RenderState whole = look;
    if (whole.blend.empty())
        whole.blend = "alpha";
    if (whole.color_mask.empty())
        whole.color_mask = "rgba";
    std::vector<std::pair<std::string, std::string>> kv = {{"op", json_quote("set")}, {"ref", num(ref)}};
    look_fields(&kv, whole);
    queue_for(ref, json_object(kv));
    send_now();
}

void Client::camera(uint32_t ref, const MeshOptions &mo)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || it->second.kind != "mesh")
        return;
    it->second.mo.fov = mo.fov;
    it->second.mo.ortho_h = mo.ortho_h;
    it->second.mo.near = mo.near;
    it->second.mo.far = mo.far;
    it->second.mo.cx = mo.cx;
    it->second.mo.cy = mo.cy;
    it->second.mo.cz = mo.cz;
    it->second.mo.crx = mo.crx;
    it->second.mo.cry = mo.cry;
    it->second.mo.crz = mo.crz;
    std::vector<std::pair<std::string, std::string>> kv = {{"op", json_quote("set")}, {"ref", num(ref)}};
    mesh_fields(&kv, it->second.mo);
    queue_for(ref, json_object(kv));
    send_now();
}

void Client::uniform(uint32_t ref, const std::string &name, const std::vector<float> &v)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || v.empty() || v.size() > 4)
        return;
    std::string &m = it->second.uniforms[std::make_pair(0u, name)];
    m = uniform_json(ref, name, v);
    queue_for(ref, m);
    send_now();
}

void Client::uniform(uint32_t ref, const std::string &name, UniformType type, const std::vector<float> &v,
                     uint32_t part)
{
    static const char *const names[] = {"float", "vec2", "vec3", "vec4", "mat4"};
    static const size_t widths[] = {1, 2, 3, 4, 16};
    const int t = (int)type;
    auto it = layers_.find(ref);
    if (it == layers_.end() || v.empty() || v.size() > 1024 || v.size() % widths[t])
        return;
    std::string vals;
    for (float f : v)
        vals += (vals.empty() ? "" : " ") + num(f);
    std::vector<std::pair<std::string, std::string>> kv = {{"op", json_quote("uniform")}, {"ref", num(ref)},
                                                           {"name", json_quote(name)},   {"type", json_quote(names[t])},
                                                           {"v", json_quote(vals)}};
    if (part)
        kv.push_back({"part", num(part)});
    std::string &m = it->second.uniforms[std::make_pair(part, name)];
    m = json_object(kv);
    queue_for(ref, m);
    send_now();
}

void Client::bind(uint32_t ref, const std::string &sampler, uint32_t asset, uint32_t part)
{
    auto it = layers_.find(ref);
    auto a = layers_.find(asset);
    if (it == layers_.end() || a == layers_.end() || (a->second.kind != "asset" && a->second.kind != "canvas"))
        return;
    std::vector<std::pair<std::string, std::string>> kv = {{"op", json_quote("bind")}, {"ref", num(ref)},
                                                           {"sampler", json_quote(sampler)}, {"asset", num(asset)}};
    if (part)
        kv.push_back({"part", num(part)});
    auto &b = it->second.binds[std::make_pair(part, sampler)];
    b = std::make_pair(asset, json_object(kv));
    if (!held(asset))
        queue_for(ref, b.second);
    send_now();
}

bool Client::part(uint32_t ref, uint32_t part, const PartOptions &po)
{
    return this->part(ref, part, po, RenderState());
}

bool Client::part(uint32_t ref, uint32_t part, const PartOptions &po, const RenderState &look)
{
    return this->part(ref, part, po, look, 0);
}

bool Client::pivot(uint32_t ref, uint32_t part, uint32_t parent)
{
    return add_part(ref, part, parent, {{"node", "1"}});
}

bool Client::part(uint32_t ref, uint32_t part, const PartOptions &po, const RenderState &look, uint32_t parent)
{
    std::vector<std::pair<std::string, std::string>> kv = {{"vs", json_quote(po.vs)},
                                                           {"fs", json_quote(po.fs)},
                                                           {"depth", flag(po.depth)},
                                                           {"cull", json_quote(po.cull)}};
    if (look.blend.empty())
        kv.push_back({"blend", json_quote(po.blend)});
    look_fields(&kv, look);
    return add_part(ref, part, parent, kv);
}

bool Client::add_part(uint32_t ref, uint32_t part, uint32_t parent,
                      std::vector<std::pair<std::string, std::string>> fields)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || it->second.kind != "mesh" || !part || it->second.parts.count(part) ||
        (parent && !it->second.parts.count(parent)))
        return false;
    Part &p = it->second.parts[part];
    p.made = ++parts_made_;
    fields.insert(fields.begin(), {{"op", json_quote("part")}, {"ref", num(ref)}, {"part", num(part)}});
    if (parent)
        fields.push_back({"parent", num(parent)});
    p.json = json_object(fields);
    queue_for(ref, p.json);
    send_now();
    return true;
}

bool Client::geometry(uint32_t ref, uint32_t part, const Geometry &g)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || !it->second.parts.count(part))
        return false;
    const size_t v = g.positions.size() / 3;
    if (g.positions.size() % 3 || v < 1 || v > kMaxMeshVertices || (!g.normals.empty() && g.normals.size() != v * 3) ||
        (!g.texcoords.empty() && g.texcoords.size() != v * 2) || (!g.colors.empty() && g.colors.size() != v * 4) ||
        g.indices.empty() || g.indices.size() > kMaxMeshIndices)
        return false;
    for (uint16_t i : g.indices)
        if (i >= v)
            return false;
    std::string &m = it->second.parts[part].geometry;
    m = mesh_message(ref, part, (uint32_t)v, g.positions.data(), g.normals.empty() ? nullptr : g.normals.data(),
                     g.texcoords.empty() ? nullptr : g.texcoords.data(), g.colors.empty() ? nullptr : g.colors.data(),
                     (uint32_t)g.indices.size(), g.indices.data());
    if (!held(ref))
        queue_message(m);
    send_now();
    return true;
}

void Client::transform(uint32_t ref, uint32_t part, const Transform &t)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || !it->second.parts.count(part))
        return;
    std::string &m = it->second.parts[part].transform;
    m = json_object({{"op", json_quote("transform")},
                     {"ref", num(ref)},
                     {"part", num(part)},
                     {"tx", num(t.tx)},
                     {"ty", num(t.ty)},
                     {"tz", num(t.tz)},
                     {"rx", num(t.rx)},
                     {"ry", num(t.ry)},
                     {"rz", num(t.rz)},
                     {"sx", num(t.sx)},
                     {"sy", num(t.sy)},
                     {"sz", num(t.sz)}});
    queue_for(ref, m);
    send_now();
}

uint32_t Client::animate(uint32_t ref, const AnimationOptions &a)
{
    return animate(ref, a, 0);
}

uint32_t Client::animate(uint32_t ref, const AnimationOptions &a, uint32_t again)
{
    return animate(ref, a, again, a.step ? "step" : "linear");
}

uint32_t Client::animate(uint32_t ref, const AnimationOptions &a, uint32_t again, const std::string &interp)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || a.property.empty() || a.keys.empty() ||
        (again && !it->second.animations.count(again)))
        return 0;
    const uint32_t anim = again ? again : it->second.next_anim++;
    std::vector<std::pair<std::string, std::string>> kv = {
        {"op", json_quote("animate")},       {"ref", num(ref)},
        {"anim", num(anim)},                 {"property", json_quote(a.property)},
        {"keys", json_quote(a.keys)},        {"loop", flag(a.loop)},
        {"interp", json_quote(interp.empty() ? (a.step ? "step" : "linear") : interp)}};
    if (a.part)
        kv.push_back({"part", num(a.part)});
    if (!a.name.empty())
        kv.push_back({"name", json_quote(a.name)});
    std::string &m = it->second.animations[anim];
    m = json_object(kv);
    queue_for(ref, m);
    send_now();
    return anim;
}

void Client::stop(uint32_t ref, uint32_t anim)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || !it->second.animations.erase(anim))
        return;
    queue_for(ref, json_object({{"op", json_quote("stop")}, {"ref", num(ref)}, {"anim", num(anim)}}));
    send_now();
}

/* A value's message: its target, type (by width) and v; empty when v is not
 * width finite numbers, as the service would refuse it. */
static std::string value_json(uint32_t ref, const std::string &target, size_t width, const std::vector<float> &v)
{
    static const char *const names[] = {"float", "vec2", "vec3", "vec4"};
    if (width < 1 || width > 4 || v.size() != width)
        return std::string();
    std::string vs;
    for (float x : v) {
        if (!std::isfinite(x))
            return std::string();
        vs += (vs.empty() ? "" : " ") + num(x);
    }
    return json_object({{"op", json_quote("value")}, {"ref", num(ref)}, {"target", json_quote(target)},
                        {"type", json_quote(names[width - 1])}, {"v", json_quote(vs)}});
}

uint32_t Client::value(const std::string &target, UniformType type, const std::vector<float> &v)
{
    const std::string m = value_json(next_ref_, target, (size_t)type + 1, v);
    if (m.empty())
        return 0;
    Layer l;
    l.kind = "value";
    l.lo.target = target;
    l.w = (unsigned)v.size();
    l.value = m;
    const uint32_t ref = next_ref_++;
    layers_[ref] = l;
    queue(l.value);
    send_now();
    return ref;
}

bool Client::set_value(uint32_t value, const std::vector<float> &v)
{
    auto it = layers_.find(value);
    const std::string m = it == layers_.end() || it->second.kind != "value"
                              ? std::string()
                              : value_json(value, it->second.lo.target, it->second.w, v);
    if (m.empty())
        return false;   /* kept as it was, for a reconnect */
    it->second.value = m;
    queue(m);
    send_now();
    return true;
}

bool Client::link(uint32_t ref, const std::string &uniform, uint32_t value, uint32_t part)
{
    auto it = layers_.find(ref);
    auto v = layers_.find(value);
    if (it == layers_.end() || (it->second.kind != "effect" && it->second.kind != "mesh") || uniform.empty() ||
        (value && (v == layers_.end() || v->second.kind != "value")))
        return false;
    std::vector<std::pair<std::string, std::string>> kv = {{"op", json_quote("link")}, {"ref", num(ref)},
                                                           {"name", json_quote(uniform)}, {"value", num(value)}};
    if (part)
        kv.push_back({"part", num(part)});
    const std::string m = json_object(kv);
    if (value)
        it->second.links[std::make_pair(part, uniform)] = std::make_pair(value, m);
    else
        it->second.links.erase(std::make_pair(part, uniform));
    queue_for(ref, m);
    send_now();
    return true;
}

void Client::request_status()
{
    queue(json_object({{"op", json_quote("status")}}));
    if (fd_ >= 0)
        write_out();
}

void Client::drop(uint32_t ref)
{
    auto it = layers_.find(ref);
    if (it == layers_.end())
        return;
    const bool hold = held(ref);   /* never sent: nothing to drop */
    bool sampled = false;
    for (auto &kv : layers_) {
        for (const auto &b : kv.second.binds)
            sampled = sampled || b.second.first == ref;
        sampled = sampled || kv.second.canvas == ref;   /* a canvas with layers in it */
        /* a font a text layer draws from, an asset a font is over */
        sampled = sampled || ((kv.second.kind == "text" || kv.second.kind == "font") && kv.second.font == ref);
        /* a value dropped: the service undoes its links */
        for (auto b = kv.second.links.begin(); b != kv.second.links.end();)
            b = b->second.first == ref ? kv.second.links.erase(b) : std::next(b);
    }
    if (it->second.kind == "video")
        spare_.clear();   /* buffers of its size may be needed no more */
    const uint32_t atlas = it->second.kind == "font" && it->second.owns ? it->second.font : 0;
    if (!sampled)
        layers_.erase(it);
    frames_.erase(ref);
    repeats_due_.erase(ref);
    shm_due_.erase(ref);
    auto sm = shm_.find(ref);
    if (sm != shm_.end()) {
        shm_close(&sm->second);   /* a "shm" message on its way still goes with its descriptor */
        shm_.erase(sm);
    }
    if (!hold)
        queue(json_object({{"op", json_quote("drop")}, {"ref", num(ref)}}));
    send_now();
    if (atlas && !sampled)
        drop(atlas);   /* the atlas the font owns goes with it */
}

size_t Client::frame_bytes(uint32_t ref) const
{
    auto it = layers_.find(ref);
    if (it == layers_.end())
        return 0;
    if (it->second.kind == "video")
        return (size_t)it->second.vo.w * (it->second.vo.h + it->second.vo.h / 2);
    if (it->second.kind == "image" || it->second.kind == "asset")
        return it->second.image.size();
    return 0;
}

bool Client::video_frame_ok(uint32_t ref, size_t n) const
{
    auto it = layers_.find(ref);
    return ready_ && it != layers_.end() && it->second.kind == "video" && n == frame_bytes(ref);
}

void Client::take_spare(std::vector<uint8_t> *v, size_t n)
{
    for (size_t i = spare_.size(); i-- > 0;) {
        if (spare_[i].size() == n) {
            v->swap(spare_[i]);
            spare_.erase(spare_.begin() + (long)i);
            return;
        }
    }
    v->resize(n);
}

void Client::keep_last(uint32_t ref, std::vector<uint8_t> *px)
{
    auto l = layers_.find(ref);
    if (l != layers_.end() && l->second.kind == "video")
        px->swap(l->second.last);
    if (!px->empty()) {
        if (spare_.size() >= kMaxSpare)
            spare_.erase(spare_.begin());
        spare_.push_back(std::move(*px));
    }
    px->clear();
}

void Client::shm_close(Shm *m)
{
    if (m->map)
        munmap(m->map, m->size);
    m->map = nullptr;
}

bool Client::next_shm()
{
    while (!shm_due_.empty()) {
        const uint32_t ref = *shm_due_.begin();
        shm_due_.erase(shm_due_.begin());
        const size_t slot = frame_bytes(ref);
        if (!slot || held(ref) || shm_.count(ref))
            continue;
#ifdef __linux__
        Shm m;
        m.slots = kShmSlots;
        m.slot_bytes = slot;
        m.size = kShmHeader + m.slots * slot;
        const int fd = memfd_create("cluster-render-frames", MFD_CLOEXEC | MFD_ALLOW_SEALING);
        void *p = MAP_FAILED;
        if (fd >= 0 && ftruncate(fd, (off_t)m.size) == 0 &&
            fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL) == 0)
            p = mmap(nullptr, m.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (p == MAP_FAILED) {
            if (fd >= 0)
                close(fd);
            continue;   /* its frames go whole */
        }
        m.map = static_cast<uint8_t *>(p);
        shm_[ref] = m;
        cur_ = encode(kJson, json_object({{"op", json_quote("shm")}, {"ref", num(ref)}, {"slots", num(m.slots)}}));
        cur_fd_ = fd;
        return true;
#endif
    }
    return false;
}

bool Client::shm_frame(uint32_t ref, const std::vector<uint8_t> &px)
{
    auto it = shm_.find(ref);
    if (it == shm_.end() || it->second.state != Shm::Ok || px.size() != it->second.slot_bytes)
        return false;
    Shm &m = it->second;
    uint32_t *busy = reinterpret_cast<uint32_t *>(m.map);
    for (unsigned k = 0; k < m.slots; k++) {
        if (__atomic_load_n(busy + k, __ATOMIC_ACQUIRE) != 0)
            continue;   /* the service has not copied its frame out yet */
        busy[k] = 1;
        std::memcpy(m.map + kShmHeader + (size_t)k * m.slot_bytes, px.data(), px.size());
        cur_ = encode(kJson, json_object({{"op", json_quote("slot")}, {"ref", num(ref)}, {"slot", num(k)}}));
        return true;
    }
    return false;
}

bool Client::frame(uint32_t ref, const uint8_t *atlas, size_t n, uint64_t id)
{
    if (!video_frame_ok(ref, n))
        return false;
    repeats_due_.erase(ref);
    Frame &f = frames_[ref];
    f.head = frame_head(ref, id, {}, n);
    if (f.px.size() != n)
        take_spare(&f.px, n);
    std::memcpy(f.px.data(), atlas, n);
    write_out();
    return true;
}

bool Client::frame(uint32_t ref, std::vector<uint8_t> *atlas, uint64_t id)
{
    if (!atlas || !video_frame_ok(ref, atlas->size()))
        return false;
    const size_t n = atlas->size();
    repeats_due_.erase(ref);
    Frame &f = frames_[ref];
    f.head = frame_head(ref, id, {}, n);
    f.px.swap(*atlas);
    if (atlas->size() != n)
        take_spare(atlas, n);   /* else it is the unsent frame this one replaces */
    write_out();
    return true;
}

bool Client::repeat(uint32_t ref, uint64_t id)
{
    const size_t n = frame_bytes(ref);
    if (!video_frame_ok(ref, n))
        return false;
    Layer &l = layers_[ref];
    auto f = frames_.find(ref);
    if (f != frames_.end()) {
        f->second.head = frame_head(ref, id, {}, n);   /* the frame waiting is this picture */
        return true;
    }
    const bool on_its_way = !cur_px_.empty() && last_frame_ref_ == ref;
    if (repeats_ && (l.sent || on_its_way)) {
        repeats_due_.insert(ref);
        write_out();
        return true;
    }
    if (on_its_way) {
        /* Its picture is still being written whole to a service without
         * repeats: the same picture goes whole again after it, with this id. */
        if (cur_px_.size() != n)
            return true;   /* another size: not this picture; the next frame goes whole */
        Frame &w = frames_[ref];
        w.head = frame_head(ref, id, {}, n);
        take_spare(&w.px, n);
        std::memcpy(w.px.data(), cur_px_.data(), n);
        write_out();
        return true;
    }
    if (l.last.size() != n)
        return false;
    repeats_due_.erase(ref);
    Frame &w = frames_[ref];
    w.head = frame_head(ref, id, {}, n);
    w.px.swap(l.last);
    write_out();
    return true;
}

bool Client::latest(uint32_t ref, std::vector<uint8_t> *out) const
{
    auto l = layers_.find(ref);
    if (l == layers_.end() || l->second.kind != "video")
        return false;
    auto f = frames_.find(ref);
    const std::vector<uint8_t> &px = f != frames_.end()                            ? f->second.px
                                     : !cur_px_.empty() && last_frame_ref_ == ref ? cur_px_
                                                                                   : l->second.last;
    if (px.empty())
        return false;
    *out = px;
    return true;
}

bool Client::pixels(uint32_t ref, const std::vector<FrameRect> &rects, const uint8_t *px, size_t n)
{
    auto it = layers_.find(ref);
    if (it == layers_.end() || (it->second.kind != "image" && it->second.kind != "asset"))
        return false;
    Layer &l = it->second;
    const unsigned w = l.w, h = l.h, bpp = l.bpp;
    /* a cube map is sent whole and once, as the service takes it */
    if (l.cube && (!rects.empty() || l.have))
        return false;
    if (rects.empty()) {
        if (n != l.image.size())
            return false;
        std::memcpy(l.image.data(), px, n);
        l.whole = true;
        l.dirty.clear();
        l.dirty_bytes = 0;
    } else {
        size_t need = 0;
        for (const FrameRect &r : rects) {
            if (!r.w || !r.h || (unsigned)r.x + r.w > w || (unsigned)r.y + r.h > h)
                return false;
            need += (size_t)r.w * r.h * bpp;
        }
        if (need != n)
            return false;
        for (const FrameRect &r : rects) {
            for (unsigned y = 0; y < r.h; y++)
                std::memcpy(&l.image[((size_t)(r.y + y) * w + r.x) * bpp], px + (size_t)y * r.w * bpp,
                            (size_t)r.w * bpp);
            px += (size_t)r.w * r.h * bpp;
            if (l.whole)
                continue;
            /* An update of rects (8 bytes of header each) never outgrows the
             * whole image, which is within the service's message limit. */
            l.dirty_bytes += (size_t)r.w * r.h * bpp;
            if (l.dirty.size() >= kMaxDirty || l.dirty_bytes + 8 * (l.dirty.size() + 1) >= l.image.size()) {
                l.whole = true;
                l.dirty.clear();
                l.dirty_bytes = 0;
            } else {
                l.dirty.push_back(r);
            }
        }
    }
    l.have = true;
    if (fd_ >= 0)
        write_out();
    return true;
}

/* The changed part of one image layer or asset, as one frame message;
 * these go before video frames. */
bool Client::next_image(std::string *msg)
{
    for (auto &kv : layers_) {
        Layer &l = kv.second;
        if ((l.kind != "image" && l.kind != "asset") || (!l.whole && l.dirty.empty()) || held(kv.first))
            continue;
        std::vector<FrameRect> rects = l.whole ? std::vector<FrameRect>() : l.dirty;
        size_t n = 0;
        if (l.whole) {
            n = l.image.size();
        } else {
            for (const FrameRect &r : rects)
                n += (size_t)r.w * r.h * l.bpp;
        }
        *msg = frame_head(kv.first, 0, rects, n);
        if (l.whole) {
            msg->append(reinterpret_cast<const char *>(l.image.data()), n);
        } else {
            for (const FrameRect &r : rects)
                for (unsigned y = 0; y < r.h; y++)
                    msg->append(reinterpret_cast<const char *>(&l.image[((size_t)(r.y + y) * l.w + r.x) * l.bpp]),
                                (size_t)r.w * l.bpp);
        }
        l.whole = false;
        l.dirty.clear();
        l.dirty_bytes = 0;
        return true;
    }
    return false;
}

}  // namespace cr
