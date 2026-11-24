/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* A renderer for host tests (graph.h): keeps every object's pending state
 * and, at each flush, copies it to what the display shows, as RAMSES
 * applies a flush whole. A test can refuse a write after some bytes or the
 * next flush, and read back what is shown: buffers, quads, views, parts and
 * the animations playing. Scene files are text the test writes
 * (FakeFileScene), read back the same way. */
#ifndef CRS_FAKE_GRAPH_H
#define CRS_FAKE_GRAPH_H

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "../src/graph.h"
#include "../src/scene_edit.h"

namespace crs {

struct FakeBuffer {
    TexFormat f;
    uint32_t w, h;
    std::vector<uint8_t> px;
    Sampler sampler;
    uint32_t levels = 1;
    std::vector<std::vector<uint8_t>> mips;   /* levels 1 and up */
    uint64_t level_writes = 0;                /* write_level() calls past level 0 */
    bool cube = false;                        /* a cube_texture(): px its six faces */
};

inline FakeBuffer fake_buffer(TexFormat f, uint32_t w, uint32_t h, std::vector<uint8_t> px, const Sampler &s)
{
    FakeBuffer b{};
    b.f = f;
    b.w = w;
    b.h = h;
    b.px = std::move(px);
    b.sampler = s;
    return b;
}

struct FakeQuad {
    int effect = 0;
    Rect r;
    Turn turn;
    bool visible = false;
    int32_t order = 0;
    std::map<std::string, int> textures;
    std::map<std::string, std::vector<float>> uniforms;
    std::map<std::string, UniformType> types;   /* uniforms set as arrays */
    PartLook look = quad_look();
    std::map<std::string, int> sets;   /* uniform() calls by name */
    std::map<std::string, int> links;   /* uniform -> value (link()) */
    int styles = 0;   /* style() calls */
    int canvas = 0;   /* the canvas it is drawn in; 0: the target */
    uint32_t glyph_cap = 0;        /* a glyph run's capacity (glyph_buffer()); 0: none */
    std::vector<float> glyphs;     /* its glyphs as glyphs() wrote them, 16 floats each */
    int glyph_writes = 0;
};

struct FakeView {
    Rect r;
    Projection p;
    Pose camera;
    bool visible = false;
    int32_t order = 0;
    int canvas = 0;
};

struct FakeCanvas {
    CanvasSpec spec;
    int redraws = 0;   /* redraw() calls */
    bool enabled = true;   /* enable_canvas() */
};

struct FakePart {
    int view = 0, effect = 0;
    PartLook look;
    Pose pose;
    bool geometry = false;
    uint32_t vertices = 0, indices = 0;
    unsigned attributes = 0;
    int geometries = 0;   /* geometry() calls */
    int poses = 0;        /* pose() calls */
    bool pivot = false;   /* a node(): draws nothing */
    int parent = 0;       /* the part or node it follows; 0: the view */
    std::map<std::string, int> links;   /* uniform -> value (link()) */
    std::map<std::string, int> textures;
    std::map<std::string, std::vector<float>> uniforms;
    std::map<std::string, UniformType> types;
};

/* Kept as the backends keep theirs (AnimTable), with no objects. */
struct FakeAnimation : AnimState {};

struct FakeValue {
    uint32_t width = 1;
    std::vector<float> v;
    int sets = 0;   /* set_value() calls */
};

struct FakeState {
    std::map<int, FakeBuffer> buffers;
    std::map<int, FakeQuad> quads;
    std::map<int, FakeView> views;
    std::map<int, FakePart> parts;
    std::map<int, FakeAnimation> animations;
    std::map<int, FakeCanvas> canvases;
    std::map<int, FakeValue> values;
};

class FakeGraph : public Graph {
public:
    FakeState pending, shown;
    int next = 1;
    uint64_t flushes = 0, last_tag = 0;
    size_t written = 0;            /* bytes written since the last flush */
    uint64_t writes = 0;           /* write() calls that went */
    uint64_t shown_writes = 0;     /* writes as of the last flush that went: what shown's buffers hold */
    uint64_t flushed_bytes = 0;    /* bytes carried by flushes that went */
    int64_t *clock_us = nullptr;   /* advanced by *flush_cost_us at each flush */
    const int64_t *flush_cost_us = nullptr;
    long write_budget = -1;        /* refuse writes once this many bytes went; -1: never */
    bool fail_flush = false;
    bool refuse_textures = false;  /* immutable_texture() refused, as a backend without the format */
    bool refuse_canvases = false;  /* canvas() refused */
    bool refuse_glyphs = false;    /* glyph_buffer() refused, as a backend without glyph runs */
    bool refuse_glyph_writes = false;   /* glyphs() refused */
    int glyph_refusals = 0;             /* glyphs() calls refused for it */
    std::string name;
    std::map<std::string, FakeGraph *> *registry = nullptr;
    const std::map<int, unsigned> *effect_attributes = nullptr;   /* the Gpu's */
    /* Over a file scene (FileScene::layers): its passes' first render
     * order, and the file's flush, which a flush of this graph is too. */
    bool over_file = false;
    int32_t over_order = 0;
    std::function<void(uint64_t)> also_flush;
    /* band(): the over band's first render order (over a file only). */
    bool band_on = false;
    int32_t band_base = 0;
    bool band(int32_t base) override
    {
        if (!over_file)
            return false;
        band_on = true;
        band_base = base;
        return true;
    }

    ~FakeGraph() override
    {
        if (registry)
            registry->erase(name);
    }

    int buffer(TexFormat f, uint32_t w, uint32_t h, Sampling s) override { return buffer(f, w, h, s, Wrap::Clamp); }
    int buffer(TexFormat f, uint32_t w, uint32_t h, Sampling s, Wrap wrap) override
    {
        Sampler smp;
        smp.sampling = s;
        smp.u = smp.v = wrap;
        return buffer(f, w, h, smp, 1);
    }
    int buffer(TexFormat f, uint32_t w, uint32_t h, const Sampler &s, uint32_t levels) override
    {
        if (tex_compressed(f) || levels < 1 || levels > mip_levels(w, h))
            return 0;
        FakeBuffer b = fake_buffer(f, w, h, std::vector<uint8_t>((size_t)w * h * (f == TexFormat::R8 ? 1 : 4), 0), s);
        b.levels = levels;
        for (uint32_t l = 1; l < levels; l++)
            b.mips.push_back(std::vector<uint8_t>(tex_level_bytes(f, w, h, l), 0));
        pending.buffers[next] = b;
        return next++;
    }
    int immutable_texture(TexFormat f, uint32_t w, uint32_t h, const Sampler &s, uint32_t levels,
                          const uint8_t *data, size_t n) override
    {
        if (refuse_textures || !tex_compressed(f) || levels < 1 || levels > mip_levels(f, w, h) ||
            n != tex_chain_bytes(f, w, h, levels))
            return 0;
        const size_t base = tex_bytes(f, w, h);
        FakeBuffer b = fake_buffer(f, w, h, std::vector<uint8_t>(data, data + base), s);
        b.levels = levels;
        for (uint32_t l = 1; l < levels; l++) {
            data += tex_level_bytes(f, w, h, l - 1);
            b.mips.push_back(std::vector<uint8_t>(data, data + tex_level_bytes(f, w, h, l)));
        }
        pending.buffers[next] = b;
        return next++;
    }
    int cube_texture(TexFormat f, uint32_t size, const Sampler &s, const uint8_t *data, size_t face) override
    {
        if (refuse_textures || !size || face != tex_bytes(f, size, size) || sampling_mips(s.sampling))
            return 0;
        FakeBuffer b = fake_buffer(f, size, size, std::vector<uint8_t>(data, data + face * 6), s);
        b.cube = true;
        pending.buffers[next] = b;
        return next++;
    }
    bool write_level(int buf, uint32_t level, uint32_t x, uint32_t y, uint32_t w, uint32_t h,
                     const uint8_t *px) override
    {
        if (level == 0)
            return write(buf, x, y, w, h, px);
        auto it = pending.buffers.find(buf);
        if (it == pending.buffers.end() || level >= it->second.levels)
            return false;
        FakeBuffer &b = it->second;
        const uint32_t lw = mip_size(b.w, level), lh = mip_size(b.h, level);
        const size_t bpp = b.f == TexFormat::R8 ? 1 : 4;
        if (x + w > lw || y + h > lh)
            return false;
        if (write_budget >= 0 && (long)(written + (size_t)w * h * bpp) > write_budget)
            return false;
        for (uint32_t row = 0; row < h; row++)
            std::memcpy(&b.mips[level - 1][((size_t)(y + row) * lw + x) * bpp], px + (size_t)row * w * bpp,
                        (size_t)w * bpp);
        written += (size_t)w * h * bpp;
        writes++;
        b.level_writes++;
        return true;
    }
    bool write(int buf, uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint8_t *px) override
    {
        auto it = pending.buffers.find(buf);
        if (it == pending.buffers.end() || tex_compressed(it->second.f) || x + w > it->second.w ||
            y + h > it->second.h)
            return false;
        const size_t bpp = it->second.f == TexFormat::R8 ? 1 : 4;
        if (write_budget >= 0 && (long)(written + (size_t)w * h * bpp) > write_budget)
            return false;
        for (uint32_t row = 0; row < h; row++)
            std::memcpy(&it->second.px[((size_t)(y + row) * it->second.w + x) * bpp], px + (size_t)row * w * bpp,
                        (size_t)w * bpp);
        written += (size_t)w * h * bpp;
        writes++;
        return true;
    }
    int quad(int effect, const Rect &r) override
    {
        FakeQuad q;
        q.effect = effect;
        q.r = r;
        pending.quads[next] = q;
        return next++;
    }
    bool place(int quad, const Rect &r) override
    {
        if (pending.views.count(quad))
            return pending.views[quad].r = r, true;
        return has(quad) && (pending.quads[quad].r = r, true);
    }
    bool turn(int quad, const Turn &t) override { return has(quad) && (pending.quads[quad].turn = t, true); }
    bool style(int quad, const PartLook &look) override
    {
        if (!has(quad))
            return false;
        pending.quads[quad].look = look;
        pending.quads[quad].look.depth = false;
        pending.quads[quad].look.cull = Cull::None;
        pending.quads[quad].styles++;
        return true;
    }
    bool texture(int quad, const char *u, int buf) override
    {
        if (!pending.buffers.count(buf) || !known_sampler(u))
            return false;
        if (pending.parts.count(quad))
            return pending.parts[quad].textures[u] = buf, true;
        if (!has(quad))
            return false;
        pending.quads[quad].textures[u] = buf;
        return true;
    }
    bool uniform(int quad, const char *name, const float *v, int n) override
    {
        if (n < 1 || n > 4 || unknown_uniform == name)
            return false;
        if (pending.parts.count(quad))
            return pending.parts[quad].uniforms[name] = std::vector<float>(v, v + n), true;
        if (!has(quad))
            return false;
        pending.quads[quad].uniforms[name] = std::vector<float>(v, v + n);
        pending.quads[quad].sets[name]++;
        return true;
    }
    bool uniform_array(int quad, const char *name, UniformType t, const float *v, uint32_t elements) override
    {
        if (!elements || unknown_uniform == name)
            return false;
        const std::vector<float> vals(v, v + elements * uniform_width(t));
        if (pending.parts.count(quad)) {
            pending.parts[quad].uniforms[name] = vals;
            pending.parts[quad].types[name] = t;
            return true;
        }
        if (!has(quad))
            return false;
        pending.quads[quad].uniforms[name] = vals;
        pending.quads[quad].types[name] = t;
        return true;
    }
    bool show(int quad, bool on) override
    {
        if (pending.views.count(quad))
            return pending.views[quad].visible = on, true;
        return has(quad) && (pending.quads[quad].visible = on, true);
    }
    bool order(int quad, int32_t o) override
    {
        if (pending.views.count(quad))
            return pending.views[quad].order = o, true;
        return has(quad) && (pending.quads[quad].order = o, true);
    }
    bool glyph_buffer(int quad, uint32_t capacity) override
    {
        if (refuse_glyphs || !has(quad) || !capacity || pending.quads[quad].glyph_cap)
            return false;
        pending.quads[quad].glyph_cap = capacity;
        return true;
    }
    bool glyphs(int quad, const float *v, uint32_t n) override
    {
        if (refuse_glyph_writes) {
            glyph_refusals++;
            return false;
        }
        if (!has(quad) || n > pending.quads[quad].glyph_cap)
            return false;
        if (write_budget >= 0 && (long)(written + (size_t)n * 64) > write_budget)
            return false;
        written += (size_t)n * 64;
        writes++;
        pending.quads[quad].glyphs.assign(v, v + n * 16);
        pending.quads[quad].glyph_writes++;
        return true;
    }
    void drop_quad(int quad) override
    {
        stop_on(quad);
        pending.quads.erase(quad);
    }
    void drop_buffer(int buf) override { pending.buffers.erase(buf); }

    int view(const Rect &r, const Projection &p, const Pose &camera) override
    {
        FakeView v;
        v.r = r;
        v.p = p;
        v.camera = camera;
        pending.views[next] = v;
        return next++;
    }
    bool camera(int view, const Projection &p, const Pose &camera) override
    {
        auto it = pending.views.find(view);
        if (it == pending.views.end())
            return false;
        it->second.p = p;
        it->second.camera = camera;
        return true;
    }
    void drop_view(int view) override
    {
        stop_on(view);
        pending.views.erase(view);
    }
    int part(int view, int effect, const PartLook &look) override
    {
        if (!pending.views.count(view))
            return 0;
        FakePart p;
        p.view = view;
        p.effect = effect;
        p.look = look;
        pending.parts[next] = p;
        return next++;
    }
    bool geometry(int part, const Geometry &g) override
    {
        auto it = pending.parts.find(part);
        if (it == pending.parts.end())
            return false;
        const unsigned has_attrs = kAttrPosition | (g.normal ? kAttrNormal : 0) | (g.texcoord ? kAttrTexcoord : 0) |
                                   (g.color ? kAttrColor : 0);
        unsigned reads = kAttrPosition;
        if (effect_attributes && effect_attributes->count(it->second.effect))
            reads = effect_attributes->at(it->second.effect);
        if (reads & ~has_attrs)
            return false;
        it->second.geometry = true;
        it->second.vertices = g.vertices;
        it->second.indices = g.indices;
        it->second.attributes = has_attrs;
        it->second.geometries++;
        geometry_bytes += (size_t)g.vertices * 4 * (3 + (g.normal ? 3 : 0) + (g.texcoord ? 2 : 0) + (g.color ? 4 : 0)) +
                          (size_t)g.indices * 2;
        return true;
    }
    bool pose(int part, const Pose &p) override
    {
        auto it = pending.parts.find(part);
        return it != pending.parts.end() && (it->second.pose = p, it->second.poses++, true);
    }
    void drop_part(int part) override
    {
        stop_on(part);
        pending.parts.erase(part);
    }
    int value(uint32_t width) override
    {
        if (width < 1 || width > 4)
            return 0;
        pending.values[next].width = width;
        pending.values[next].v.assign(width, 0.0f);
        return next++;
    }
    bool set_value(int value, const float *v) override
    {
        auto it = pending.values.find(value);
        if (it == pending.values.end())
            return false;
        it->second.v.assign(v, v + it->second.width);
        it->second.sets++;
        return true;
    }
    /* A uniform named unknown_uniform is not in the shader. */
    bool link(int drawable, const char *name, int value) override
    {
        if ((value && !pending.values.count(value)) || unknown_uniform == name)
            return false;
        std::map<std::string, int> *links = pending.parts.count(drawable)  ? &pending.parts[drawable].links
                                            : pending.quads.count(drawable) ? &pending.quads[drawable].links
                                                                            : nullptr;
        if (!links)
            return false;
        if (value)
            (*links)[name] = value;
        else
            links->erase(name);
        return true;
    }
    void drop_value(int value) override
    {
        stop_on(value);
        pending.values.erase(value);
    }

    int animate(int node, const Animation &a) override
    {
        if (a.property == Animated::Value) {
            if (!pending.values.count(node) || a.width != pending.values[node].width)
                return 0;
        } else if (!has(node) && !pending.parts.count(node) && !pending.views.count(node)) {
            return 0;
        }
        if (a.property == Animated::Uniform && unknown_uniform == a.uniform)
            return 0;
        table().add(next, node, a);
        return next++;
    }
    void stop(int anim) override { table().stop(anim, [](FakeAnimation &) {}); }
    /* In place, the old one playing until the replacement is made, by the
     * backends' own state machine (AnimTable). */
    int replace(int anim, int node, const Animation &a, std::function<void()> restore) override
    {
        if (!pending.animations.count(anim))
            return animate(node, a);
        replaces++;
        table().replace(anim, node, a, std::move(restore));
        return anim;
    }
    uint64_t take_animation_bytes() override
    {
        const uint64_t b = Graph::take_animation_bytes();
        animation_taken += b;
        return b;
    }
    bool animations_due() const override
    {
        return AnimTable<FakeAnimation>::any_due(pending.animations);
    }
    /* Through the backends' gate and state machine. */
    void make_animations()
    {
        table().make([this](FakeAnimation &an, FakeAnimation &, bool) {
            AnimTable<FakeAnimation>::Built b;
            b.ok = true;
            b.bytes = key_bytes(an.a);
            made_by[an.a.owner] += b.bytes;
            return b;
        });
    }
    AnimTable<FakeAnimation> table() { return AnimTable<FakeAnimation>(pending.animations, keys_); }
    std::map<uint64_t, uint64_t> made_by;   /* key bytes made, by owner */
    int replaces = 0;                 /* replace() calls on a playing animation */
    uint64_t animation_taken = 0;     /* key bytes taken by take_animation_bytes(), in all */

    int node(int view) override
    {
        if (!pending.views.count(view))
            return 0;
        FakePart p;
        p.view = view;
        p.pivot = true;
        pending.parts[next] = p;
        return next++;
    }
    bool parent(int part, int parent) override
    {
        auto c = pending.parts.find(part);
        auto p = pending.parts.find(parent);
        if (c == pending.parts.end() || p == pending.parts.end() || part == parent || c->second.view != p->second.view)
            return false;
        c->second.parent = parent;
        return true;
    }
    int canvas(const CanvasSpec &c) override
    {
        if (refuse_canvases || !c.w || !c.h || sampling_mips(c.sampler.sampling))
            return 0;
        pending.canvases[next].spec = c;
        pending.buffers[next] = fake_buffer(TexFormat::RGBA8, c.w, c.h, {}, c.sampler);
        return next++;
    }
    void drop_canvas(int c) override
    {
        for (auto it = pending.quads.begin(); it != pending.quads.end();)
            it = it->second.canvas == c ? pending.quads.erase(it) : std::next(it);
        for (auto it = pending.views.begin(); it != pending.views.end();)
            it = it->second.canvas == c ? pending.views.erase(it) : std::next(it);
        pending.canvases.erase(c);
        pending.buffers.erase(c);
    }
    bool redraw(int c) override
    {
        auto it = pending.canvases.find(c);
        if (it == pending.canvases.end())
            return false;
        it->second.redraws++;
        return true;
    }
    bool enable_canvas(int c, bool on) override
    {
        auto it = pending.canvases.find(c);
        if (it == pending.canvases.end() || it->second.spec.once)
            return false;
        it->second.enabled = on;
        return true;
    }
    int quad_in(int c, int effect, const Rect &r) override
    {
        if (c && !pending.canvases.count(c))
            return 0;
        const int q = quad(effect, r);
        pending.quads[q].canvas = c;
        return q;
    }
    int view_in(int c, const Rect &r, const Projection &p, const Pose &camera) override
    {
        if (c && !pending.canvases.count(c))
            return 0;
        const int v = view(r, p, camera);
        pending.views[v].canvas = c;
        return v;
    }

    bool flush(uint64_t tag) override
    {
        if (clock_us && flush_cost_us)
            *clock_us += *flush_cost_us;
        if (fail_flush)
            return false;
        make_animations();
        flushed_bytes += written;
        shown = pending;
        shown_writes = writes;
        flushes++;
        last_tag = tag;
        written = 0;
        if (also_flush)
            also_flush(tag);
        return true;
    }

    std::string unknown_uniform;
    std::string unknown_sampler;
    size_t geometry_bytes = 0;   /* geometry made, over the scene's life */

    bool has(int quad) const { return pending.quads.count(quad) != 0; }
    bool known_sampler(const char *u) const { return unknown_sampler.empty() || unknown_sampler != u; }
    /* Visible quads as shown, bottom to top. */
    std::vector<int> visible() const
    {
        std::vector<std::pair<int32_t, int>> v;
        for (const auto &kv : shown.quads)
            if (kv.second.visible)
                v.push_back({kv.second.order, kv.first});
        std::sort(v.begin(), v.end());
        std::vector<int> out;
        for (auto &p : v)
            out.push_back(p.second);
        return out;
    }
    /* Visible quads and views as shown, bottom to top. */
    std::vector<int> drawn() const
    {
        std::vector<std::pair<int32_t, int>> v;
        for (const auto &kv : shown.quads)
            if (kv.second.visible)
                v.push_back({kv.second.order, kv.first});
        for (const auto &kv : shown.views)
            if (kv.second.visible)
                v.push_back({kv.second.order, kv.first});
        std::sort(v.begin(), v.end());
        std::vector<int> out;
        for (auto &p : v)
            out.push_back(p.second);
        return out;
    }
    bool is_view(int h) const { return shown.views.count(h) != 0; }
    /* The animations playing on node, as shown. */
    std::vector<Animation> playing(int node) const
    {
        std::vector<Animation> out;
        for (const auto &kv : shown.animations)
            if (kv.second.node == node)
                out.push_back(kv.second.a);
        return out;
    }

private:
    void stop_on(int node) { table().stop_on(node, [](FakeAnimation &) {}); }
};

/* What a file scene shows, by object name: a node's visibility, its pose
 * ("NAME t", "NAME s", "NAME r": xyz), a camera's viewport, a pass enabled,
 * and values ("MESH:UNIFORM", or a data object's name). */
struct FakeFileState {
    std::map<std::string, bool> visible, enabled;
    std::map<std::string, std::vector<float>> pose, values;
    std::map<std::string, std::vector<uint32_t>> viewport;
};

/* A scene file of the host tests (FakeGpu::load), lines of text: "scene ID",
 * then "node NAME PARENT", "mesh NAME PARENT UNIFORM...", "camera NAME
 * PARENT" (PARENT - for none; meshes and cameras are nodes too), "pass
 * NAME", "data NAME COMPONENTS", "sequence NAME MS" (an animation sequence
 * lasting MS, of the file's one animation system without a clock of its
 * own), "rtsequence NAME" (one of a real-time system). */
class FakeFileScene : public FileScene {
public:
    std::vector<std::string> names[kKinds];
    std::vector<int> parent;   /* per node: its parent's handle; -1: none */
    std::map<std::string, std::vector<std::string>> uniforms;   /* mesh -> its uniforms */
    std::map<std::string, size_t> data_width;
    std::map<std::string, uint64_t> sequences;   /* name -> ms it lasts */
    std::vector<std::string> realtime;
    std::vector<std::string> played;            /* "play NAME" or "skip NAME", in order */
    std::map<std::string, uint64_t> started;    /* a sequence's last start, in its system's time */
    std::vector<uint64_t> times;                /* the system's time as set, in order */
    std::vector<int64_t> ticked;                /* when tick() set it */
    SequenceClock clock;
    FakeFileState pending, shown;
    uint64_t flushes = 0;
    int listed = 0;   /* objects() calls */
    std::string name;
    std::map<std::string, FakeFileScene *> *registry = nullptr;

    ~FakeFileScene() override
    {
        if (registry)
            registry->erase(name);
    }
    std::vector<std::string> objects(Kind k) override
    {
        listed++;
        return names[k];
    }
    bool visible(int node, bool on) override
    {
        for (size_t n = 0; n < names[Node].size(); n++)
            for (int a = (int)n; a >= 0; a = parent[a])
                if (a == node) {
                    pending.visible[names[Node][n]] = on;
                    break;
                }
        return node >= 0 && node < (int)names[Node].size();
    }
    bool transform(int node, Transform what, const float v[3]) override
    {
        pending.pose[names[Node].at(node) + " " + "tsr"[what]] = std::vector<float>(v, v + 3);
        return true;
    }
    bool viewport(int camera, const uint32_t v[4]) override
    {
        pending.viewport[names[Camera].at(camera)] = std::vector<uint32_t>(v, v + 4);
        return true;
    }
    bool enable(int pass, bool on) override
    {
        pending.enabled[names[Pass].at(pass)] = on;
        return true;
    }
    bool uniform(int mesh, const std::string &u, const std::vector<float> &v, std::string *why) override
    {
        const std::vector<std::string> &has = uniforms[names[Mesh].at(mesh)];
        if (std::find(has.begin(), has.end(), u) == has.end()) {
            *why = "no uniform " + u;
            return false;
        }
        pending.values[names[Mesh][mesh] + ":" + u] = v;
        return true;
    }
    bool data(const std::string &d, const std::vector<float> &v, std::string *why) override
    {
        auto it = data_width.find(d);
        if (it == data_width.end() || v.size() < it->second) {
            *why = it == data_width.end() ? "no data object " + d : "too few values";
            return false;
        }
        pending.values[d] = std::vector<float>(v.begin(), v.begin() + it->second);
        return true;
    }
    bool play(const std::string &seq, bool end, int64_t now_ms, std::string *why) override
    {
        auto it = sequences.find(seq);
        if (it == sequences.end() && std::find(realtime.begin(), realtime.end(), seq) == realtime.end()) {
            *why = "no animation sequence " + seq;
            return false;
        }
        played.push_back((end ? "skip " : "play ") + seq);
        if (it != sequences.end()) {
            uint64_t from = 0;
            times.push_back(clock.play(this, &it->second, times.empty() ? 0 : times.back(), it->second, end, now_ms,
                                       &from));
            started[seq] = from;
        }
        return true;
    }
    bool tick(int64_t now_ms) override
    {
        const auto set = clock.tick(now_ms);
        for (const auto &st : set) {
            times.push_back(st.second);
            ticked.push_back(now_ms);
        }
        return !set.empty();
    }
    bool ticking() const override { return clock.ticking(); }
    bool flush(uint64_t) override
    {
        shown = pending;
        flushes++;
        return true;
    }
    /* FakeGpu's layers over this file (FakeGpu::load). */
    std::function<std::unique_ptr<Graph>(const int32_t *, std::string *)> make_layers;
    std::unique_ptr<Graph> layers(const int32_t *order, std::string *err) override
    {
        return make_layers ? make_layers(order, err) : FileScene::layers(order, err);
    }
};

class FakeGpu : public Gpu {
public:
    int next_effect = 1;
    std::map<std::string, FakeFileScene *> files;   /* loaded file scenes by target name */
    int loads = 0;
    std::map<int, std::string> effects;   /* handle -> fragment shader */
    std::map<int, unsigned> attrs;        /* handle -> attributes its vertex shader reads */
    std::string reject;                   /* a fragment shader containing this fails to compile */
    bool no_sequences = false;            /* as a display whose animation types were not learned */
    bool sequences() override { return !no_sequences; }
    std::map<std::string, FakeGraph *> live;   /* published scenes by target name */
    int scenes = 0;
    bool refuse_textures = false;         /* each new scene's immutable_texture() refused */
    std::string unknown_sampler;          /* each new scene's texture() refuses it */
    bool refuse_layers = false;           /* no layers over a file scene, as a backend without them */
    bool fail_loads = false;              /* every scene file fails to load */
    int64_t *clock_us = nullptr;
    int64_t flush_cost_us = 0;

    int effect(const char *vs, const char *fs, std::string *err) override
    {
        if (!reject.empty() && std::string(fs).find(reject) != std::string::npos) {
            *err = "shader did not compile";
            return 0;
        }
        const std::string v = vs;
        unsigned a = 0;
        const struct { const char *name; unsigned bit; } names[] = {
            {"a_position", kAttrPosition}, {"a_normal", kAttrNormal}, {"a_texcoord", kAttrTexcoord},
            {"a_color", kAttrColor}};
        for (const auto &n : names)
            if (v.find(std::string("attribute vec3 ") + n.name) != std::string::npos ||
                v.find(std::string("attribute vec2 ") + n.name) != std::string::npos ||
                v.find(std::string("in vec3 ") + n.name) != std::string::npos || /* GLSL ES 3.00 */
                v.find(std::string("in vec2 ") + n.name) != std::string::npos || v.find(std::string("in vec4 ") + n.name) != std::string::npos ||
                v.find(std::string("attribute vec4 ") + n.name) != std::string::npos)
                a |= n.bit;
        effects[next_effect] = fs;
        attrs[next_effect] = a;
        sources[next_effect] = std::string(vs) + "\n" + fs;
        return next_effect++;
    }
    void drop_effect(int e) override
    {
        effects.erase(e);
        attrs.erase(e);
        sources.erase(e);
    }
    /* The fake's reading of the uniforms its shaders declare: comments,
     * precision and comma lists taken, no preprocessor; none with
     * no_inputs, as a backend that cannot say. */
    bool inputs(int e, std::vector<EffectInput> *out) const override
    {
        auto it = sources.find(e);
        if (no_inputs || it == sources.end())
            return false;
        std::string src;
        const std::string &s = it->second;
        for (size_t i = 0; i < s.size(); i++) {
            if (s.compare(i, 2, "//") == 0)
                i = s.find('\n', i) == std::string::npos ? s.size() : s.find('\n', i);
            else if (s.compare(i, 2, "/*") == 0)
                i = s.find("*/", i) == std::string::npos ? s.size() : s.find("*/", i) + 1;
            else
                src += s[i];
        }
        std::vector<std::string> w;
        std::string cur;
        for (char c : src + " ") {
            if (std::isalnum((unsigned char)c) || c == '_') {
                cur += c;
                continue;
            }
            if (!cur.empty())
                w.push_back(cur);
            cur.clear();
            if (c == ';' || c == ',' || c == '[' || c == ']')
                w.push_back(std::string(1, c));
        }
        out->clear();
        for (size_t i = 0; i < w.size(); i++) {
            if (w[i] != "uniform")
                continue;
            size_t t = i + 1;
            while (t < w.size() && (w[t] == "lowp" || w[t] == "mediump" || w[t] == "highp"))
                t++;
            if (t >= w.size())
                break;
            const EffectInput::Kind k = w[t] == "sampler2D"     ? EffectInput::Sampler2D
                                        : w[t] == "samplerCube" ? EffectInput::SamplerCube
                                        : w[t] == "float"       ? EffectInput::Float
                                        : w[t] == "vec2"        ? EffectInput::Vec2
                                        : w[t] == "vec3"        ? EffectInput::Vec3
                                        : w[t] == "vec4"        ? EffectInput::Vec4
                                                                : EffectInput::Other;
            for (size_t n = t + 1; n < w.size() && w[n] != ";"; n++) {
                if (w[n] == "[" && n + 1 < w.size() && std::isdigit((unsigned char)w[n + 1][0]) && !out->empty())
                    out->back().elements = (uint32_t)std::atoi(w[n + 1].c_str());
                if (w[n] == "," || w[n] == "[" || w[n] == "]" || std::isdigit((unsigned char)w[n][0]))
                    continue;
                EffectInput in;
                in.name = w[n];
                in.kind = k;
                out->push_back(in);
            }
        }
        return true;
    }
    std::map<int, std::string> sources;   /* handle -> its shaders */
    bool no_inputs = false;
    unsigned attributes(int e) const override
    {
        auto it = attrs.find(e);
        return it == attrs.end() ? 0 : it->second;
    }
    std::unique_ptr<Graph> scene(const TargetSpec &t, std::string *) override
    {
        FakeGraph *g = new FakeGraph();
        g->name = t.name;
        g->registry = &live;
        g->clock_us = clock_us;
        g->flush_cost_us = &flush_cost_us;
        g->effect_attributes = &attrs;
        g->refuse_textures = refuse_textures;
        g->unknown_sampler = unknown_sampler;
        live[t.name] = g;
        scenes++;
        return std::unique_ptr<Graph>(g);
    }
    FakeGraph *graph(const std::string &target)
    {
        auto it = live.find(target);
        return it == live.end() ? nullptr : it->second;
    }
    std::unique_ptr<FileScene> load(const TargetSpec &t, const std::string &file, const std::vector<std::string> &res,
                                    std::string *err) override
    {
        std::ifstream in(file);
        std::string word, id;
        if (fail_loads || !(in >> word >> id) || word != "scene") {
            *err = "the scene file did not load";
            return nullptr;
        }
        for (const std::string &r : res)
            if (!std::ifstream(r)) {
                *err = "the scene file did not load";
                return nullptr;
            }
        if (std::strtoull(id.c_str(), nullptr, 0) != t.scene_id) {
            *err = "the file's scene id is " + id + ", not the target's";
            return nullptr;
        }
        std::unique_ptr<FakeFileScene> s(new FakeFileScene());
        std::string line;
        while (std::getline(in, line)) {
            std::istringstream ls(line);
            std::string kind, name, up;
            if (!(ls >> kind >> name))
                continue;
            if (kind == "pass") {
                s->names[FileScene::Pass].push_back(name);
                continue;
            }
            if (kind == "data") {
                ls >> s->data_width[name];
                continue;
            }
            if (kind == "sequence") {
                ls >> s->sequences[name];
                continue;
            }
            if (kind == "rtsequence") {
                s->realtime.push_back(name);
                continue;
            }
            ls >> up;
            const auto &nodes = s->names[FileScene::Node];
            const auto p = std::find(nodes.begin(), nodes.end(), up);
            s->parent.push_back(p == nodes.end() ? -1 : (int)(p - nodes.begin()));
            s->names[FileScene::Node].push_back(name);
            if (kind == "camera")
                s->names[FileScene::Camera].push_back(name);
            if (kind == "mesh") {
                s->names[FileScene::Mesh].push_back(name);
                for (std::string u; ls >> u;)
                    s->uniforms[name].push_back(u);
            }
        }
        s->name = t.name;
        s->registry = &files;
        files[t.name] = s.get();
        loads++;
        /* Layers over it: a graph like scene()'s, its passes from order
         * up (past the file's passes, one order each, without one), its
         * flush the file's too. */
        FakeFileScene *fs = s.get();
        s->make_layers = [this, t, fs](const int32_t *order, std::string *why) -> std::unique_ptr<Graph> {
            if (refuse_layers) {
                *why = "this display draws no layers over scene files";
                return nullptr;
            }
            std::unique_ptr<Graph> g = scene(t, why);
            FakeGraph *fg = static_cast<FakeGraph *>(g.get());
            fg->over_file = true;
            fg->over_order = order ? *order : (int32_t)fs->names[FileScene::Pass].size();
            fg->also_flush = [fs](uint64_t tag) { fs->flush(tag); };
            return g;
        };
        return std::unique_ptr<FileScene>(s.release());
    }
    FakeFileScene *file(const std::string &target)
    {
        auto it = files.find(target);
        return it == files.end() ? nullptr : it->second;
    }
};

}  // namespace crs

#endif
