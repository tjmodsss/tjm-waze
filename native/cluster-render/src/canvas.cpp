/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "canvas.h"

#include "log.h"

namespace crs {

/* The target's graph, its quads and views made in the canvas. */
class Canvas::Adapter : public Graph {
public:
    Adapter(Graph *g, int canvas) : g_(g), canvas_(canvas) {}

    int buffer(TexFormat f, uint32_t w, uint32_t h, Sampling s) override { return g_->buffer(f, w, h, s); }
    int buffer(TexFormat f, uint32_t w, uint32_t h, Sampling s, Wrap wrap) override
    {
        return g_->buffer(f, w, h, s, wrap);
    }
    int buffer(TexFormat f, uint32_t w, uint32_t h, const Sampler &s, uint32_t levels) override
    {
        return g_->buffer(f, w, h, s, levels);
    }
    bool write(int buf, uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint8_t *px) override
    {
        return g_->write(buf, x, y, w, h, px);
    }
    bool write_level(int buf, uint32_t level, uint32_t x, uint32_t y, uint32_t w, uint32_t h,
                     const uint8_t *px) override
    {
        return g_->write_level(buf, level, x, y, w, h, px);
    }
    int immutable_texture(TexFormat f, uint32_t w, uint32_t h, const Sampler &s, uint32_t levels, const uint8_t *data,
                          size_t n) override
    {
        return g_->immutable_texture(f, w, h, s, levels, data, n);
    }
    int quad(int effect, const Rect &r) override { return g_->quad_in(canvas_, effect, r); }
    bool place(int quad, const Rect &r) override { return g_->place(quad, r); }
    bool turn(int quad, const Turn &t) override { return g_->turn(quad, t); }
    bool style(int quad, const PartLook &look) override { return g_->style(quad, look); }
    bool texture(int quad, const char *uniform, int buf) override { return g_->texture(quad, uniform, buf); }
    bool uniform(int quad, const char *name, const float *v, int n) override { return g_->uniform(quad, name, v, n); }
    bool uniform_array(int quad, const char *name, UniformType t, const float *v, uint32_t elements) override
    {
        return g_->uniform_array(quad, name, t, v, elements);
    }
    bool show(int quad, bool on) override { return g_->show(quad, on); }
    bool order(int quad, int32_t order) override { return g_->order(quad, order); }
    void drop_quad(int quad) override { g_->drop_quad(quad); }
    void drop_buffer(int buf) override { g_->drop_buffer(buf); }
    int view(const Rect &r, const Projection &p, const Pose &camera) override
    {
        return g_->view_in(canvas_, r, p, camera);
    }
    bool camera(int view, const Projection &p, const Pose &camera) override { return g_->camera(view, p, camera); }
    void drop_view(int view) override { g_->drop_view(view); }
    int part(int view, int effect, const PartLook &look) override { return g_->part(view, effect, look); }
    bool geometry(int part, const Geometry &g) override { return g_->geometry(part, g); }
    bool pose(int part, const Pose &p) override { return g_->pose(part, p); }
    void drop_part(int part) override { g_->drop_part(part); }
    int animate(int node, const Animation &a) override { return g_->animate(node, a); }
    void stop(int anim) override { g_->stop(anim); }
    /* The target's flush carries the canvas's changes. */
    bool flush(uint64_t) override { return true; }

private:
    Graph *g_;
    int canvas_;
};

Canvas::Canvas(uint32_t id, int target, const CanvasSpec &spec) : id_(id), target_(target), spec_(spec) {}

Canvas::~Canvas() {}

Graph *Canvas::graph() { return adapter_.get(); }

const char *Canvas::spec_error(const CanvasSpec &s)
{
    if (s.w < 1 || s.h < 1 || s.w > kMaxSide || s.h > kMaxSide)
        return "a canvas is 1x1 to 2048x2048";
    if (sampling_mips(s.sampler.sampling))
        return "a canvas has no mip levels: sample it nearest, bilinear or one way each";
    if (s.sampler.anisotropy < 1 || s.sampler.anisotropy > 16)
        return "anisotropy is 1 to 16";
    for (float c : s.clear)
        if (!(c >= 0.0f && c <= 1.0f))
            return "clear is four numbers from 0 to 1";
    return nullptr;
}

bool Canvas::attach(Graph *g)
{
    g_ = g;
    handle_ = g->canvas(spec_);
    if (!handle_) {
        g_ = nullptr;
        refused_ = "the renderer refused the " + std::to_string(spec_.w) + "x" + std::to_string(spec_.h) + " canvas";
        log_error("canvas %u: %s", id_, refused_.c_str());
        return false;
    }
    refused_.clear();
    adapter_.reset(new Adapter(g, handle_));
    dirty_ = enabled_ = true;
    return true;
}

bool Canvas::enable(bool on)
{
    if (!g_ || spec_.once || on == enabled_)
        return false;
    if (!g_->enable_canvas(handle_, on)) {
        log_warn("canvas %u: not %s", id_, on ? "enabled" : "disabled");
        return false;
    }
    enabled_ = on;
    return true;
}

void Canvas::detach(bool drop)
{
    if (g_ && drop && handle_)
        g_->drop_canvas(handle_);
    adapter_.reset();
    g_ = nullptr;
    handle_ = 0;
    staged_ = false;
}

Stage Canvas::stage()
{
    staged_ = false;
    if (!g_ || !dirty_ || !spec_.once)
        return Stage::Idle;
    if (!g_->redraw(handle_))
        return Stage::Failed;
    staged_ = true;
    return Stage::Wrote;
}

void Canvas::committed(bool ok)
{
    if (staged_ && ok)
        dirty_ = false;
    staged_ = false;
}

}  // namespace crs
