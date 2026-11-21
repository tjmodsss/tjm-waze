/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "video_layer.h"

#include <algorithm>

#include <cstdio>
#include <cstring>

#include "block_pack.h"
#include "yuv_atlas.h"

namespace crs {

using crk::PixelRect;
using crk::UploadPlan;

/* An edge quad (VideoEdge): rgb_at(x) is the picture's colour at x on row
 * u_edge.x (a pixel centre), as its own shader draws it; d, the distance
 * past the rect, runs from u_edge.y at the quad's top to u_edge.z at its
 * bottom (negative: inside, where the picture fades into the edge over
 * u_edge.w px); u_look is dim and the blur's sigma in the frame's pixels:
 * nine taps sigma / 2 apart. The two differ in rgb_at only. */

/* yuv_atlas.cpp's colour at a point of the row */
const char *const kEdgeAtlasFragmentShader = R"(#version 100
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_size;
uniform vec4 u_edge;
uniform vec2 u_look;
uniform float u_opacity;
varying vec2 v_uv;
vec3 rgb_at(float px) {
    vec2 l = vec2(clamp(px, 0.5, u_size.x - 0.5), u_edge.x);
    float th = u_size.y * 1.5;
    vec2 c = clamp(vec2(l.x * 0.5 + 0.25, l.y * 0.5), vec2(0.5), u_size * 0.5 - 0.5);
    float y = texture2D(u_image, vec2(l.x / u_size.x, l.y / th)).r;
    float u = texture2D(u_image, vec2(c.x / u_size.x, (u_size.y + c.y) / th)).r - 128.0 / 255.0;
    float v = texture2D(u_image, vec2((u_size.x * 0.5 + c.x) / u_size.x, (u_size.y + c.y) / th)).r - 128.0 / 255.0;
    return clamp(vec3(y + 1.402 * v, y - 0.344136 * u - 0.714136 * v, y + 1.772 * u), 0.0, 1.0);
}
void main() {
    float d = mix(u_edge.y, u_edge.z, v_uv.y);
    float x = v_uv.x * u_size.x;
    vec3 c = vec3(0.0);
    float n = 0.0;
    for (int k = -4; k <= 4; k++) {
        float o = float(k) * 0.5;
        float w = exp(-0.5 * o * o);
        c += w * rgb_at(x + o * u_look.y);
        n += w;
    }
    float dim = u_look.x > 0.0 ? max(0.25, 1.0 - max(d, 0.0) / u_look.x) : 1.0;
    float a = d >= 0.0 ? 1.0 : clamp(1.0 + d / max(u_edge.w, 1.0), 0.0, 1.0);
    gl_FragColor = vec4(c / n * dim, a * u_opacity);
})";

/* block_pack.cpp's colour at a point of the row */
const char *const kEdgeBlockFragmentShader = R"(#version 100
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_size;
uniform vec4 u_edge;
uniform vec2 u_look;
uniform float u_opacity;
varying vec2 v_uv;
float byte_of(float s) { return floor(s * 255.0 + 0.5); }
vec3 rgb565(float lo, float hi) {
    float v = hi * 256.0 + lo;
    float r = floor(v / 2048.0);
    float g = floor(mod(v, 2048.0) / 32.0);
    float b = mod(v, 32.0);
    return vec3(r / 31.0, g / 63.0, b / 31.0);
}
vec3 rgb_at(float px) {
    vec2 p = clamp(floor(vec2(px, u_edge.x)), vec2(0.0), u_size - 1.0);
    vec2 blk = floor(p / 4.0);
    vec2 q = p - blk * 4.0;
    vec2 tex = vec2(u_size.x * 0.5, u_size.y * 0.25);
    vec4 e = texture2D(u_image, vec2(blk.x * 2.0 + 0.5, blk.y + 0.5) / tex);
    vec4 s = texture2D(u_image, vec2(blk.x * 2.0 + 1.5, blk.y + 0.5) / tex);
    vec3 c0 = rgb565(byte_of(e.r), byte_of(e.g));
    vec3 c1 = rgb565(byte_of(e.b), byte_of(e.a));
    float row = byte_of(q.y < 1.0 ? s.r : q.y < 2.0 ? s.g : q.y < 3.0 ? s.b : s.a);
    float div = q.x < 1.0 ? 1.0 : q.x < 2.0 ? 4.0 : q.x < 3.0 ? 16.0 : 64.0;
    float sel = mod(floor(row / div), 4.0);
    return sel < 0.5 ? c0 : sel < 1.5 ? c1 : sel < 2.5 ? (2.0 * c0 + c1) / 3.0 : (c0 + 2.0 * c1) / 3.0;
}
void main() {
    float d = mix(u_edge.y, u_edge.z, v_uv.y);
    float x = v_uv.x * u_size.x;
    vec3 c = vec3(0.0);
    float n = 0.0;
    for (int k = -4; k <= 4; k++) {
        float o = float(k) * 0.5;
        float w = exp(-0.5 * o * o);
        c += w * rgb_at(x + o * u_look.y);
        n += w;
    }
    float dim = u_look.x > 0.0 ? max(0.25, 1.0 - max(d, 0.0) / u_look.x) : 1.0;
    float a = d >= 0.0 ? 1.0 : clamp(1.0 + d / max(u_edge.w, 1.0), 0.0, 1.0);
    gl_FragColor = vec4(c / n * dim, a * u_opacity);
})";

VideoLayer::VideoLayer(uint32_t id, int target, uint64_t seq, crk::UploadPacer &pacer, int atlas_effect,
                       int block_effect, const VideoParams &p, int64_t now_ms)
    : Layer(id, target, seq, pacer), p_(p), atlas_effect_(atlas_effect), block_effect_(block_effect),
      atlas_bytes_((size_t)p.w * crk::atlas_height(p.h)), atlas_h_(crk::atlas_height(p.h)),
      planner_(p.w, crk::atlas_height(p.h), 1, crk::kTileSize, crk::kTileSize, p.dirty_threshold, p.dirty_settle_ms),
      motion_(p.w, crk::atlas_height(p.h), 1, crk::kTileSize, crk::kTileSize, p.dirty_threshold, 0)
{
    if (p_.h % 4)
        p_.pan_blocks = false;
    if (!p_.pan_blocks)
        p_.always_packed = false;
    if (p_.pan_blocks)
        packed_.resize(crk::block_bytes(p_.w, p_.h));
    clock_.configure(p_.fps);
    clock_.reset(now_ms);
}

const char *VideoLayer::size_error(uint32_t w, uint32_t h)
{
    if (w < 64 || h < 32)
        return "video smaller than 64x32";
    if (w > 1920 || h > 720)
        return "video larger than 1920x720";
    if (w % 4 || h % 2)
        return "video width must be a multiple of 4 and its height even";
    return nullptr;
}

void VideoLayer::offer(const uint8_t *atlas, int64_t now_ms)
{
    if (front_pending_)
        superseded_++;   /* the newest frame replaces the unsent one: it skips ahead, never replays */
    repeated_ = front_stale_ = false;
    front_.resize(atlas_bytes_);
    crk::round_levels(front_.data(), atlas, atlas_bytes_, p_.level_bits);
    front_pending_ = true;
    front_ms_ = last_frame_ms_ = now_ms;
    have_ = true;
}

void VideoLayer::repeat(int64_t now_ms)
{
    if (!have_)
        return;
    if (front_stale_) {
        front_ = shown_;   /* once after each whole write */
        front_stale_ = false;
    }
    if (front_pending_)
        superseded_++;
    else
        repeated_ = true;
    front_pending_ = true;
    front_ms_ = last_frame_ms_ = now_ms;
}

void VideoLayer::to_source()
{
    source_ = true;
    /* The newest frame into front_, as attach() finds it. */
    if (!front_pending_ && !planner_.quiet() && !held_n_ && shown_.size() == atlas_bytes_) {
        front_.swap(shown_);
        front_ms_ = shown_ms_;
    }
    repeated_ = front_stale_ = false;
    front_pending_ = false;
}

void VideoLayer::direct()
{
    source_ = false;
    repeated_ = false;
    front_pending_ = front_.size() == atlas_bytes_ && front_ms_ >= 0;
}

uint8_t *VideoLayer::taken()
{
    if (shown_.size() != atlas_bytes_)
        shown_.assign(atlas_bytes_, 0);
    return shown_.data();
}

uint8_t *VideoLayer::canvas()
{
    if (front_.size() != atlas_bytes_) {
        front_.assign(atlas_bytes_, 128);   /* black: Y 0, U and V neutral */
        std::fill(front_.begin(), front_.begin() + (size_t)p_.w * p_.h, 0);
    } else if (front_stale_) {
        front_ = shown_;   /* once after each whole write */
    }
    front_stale_ = false;
    return front_.data();
}

void VideoLayer::canvas_changed(int64_t now_ms)
{
    if (front_pending_)
        superseded_++;
    repeated_ = front_stale_ = false;
    front_pending_ = true;
    front_ms_ = last_frame_ms_ = now_ms;
    have_ = true;
}

bool VideoLayer::due(int64_t now_ms)
{
    const bool uncover = uncovering();
    return (clock_.due(now_ms) || parked_ || uncover) && (pacer_.ready(now_ms) || (force_ && uncover));
}

void VideoLayer::hide(const uint8_t *tiles)
{
    hiding_ = false;
    shown_drawn_ = g_ && drawn_;
    if (!tiles || no_hide_ || p_.always_packed)   /* the packed quad hides nothing */
        return;
    hidden_.assign(tiles, tiles + planner_.tiles());
    hiding_ = std::find(hidden_.begin(), hidden_.end(), 1) != hidden_.end();
}

void VideoLayer::occluded(const Coverage &cov, const Shown &s)
{
    shown_drawn_ = g_ && s.drawn;
    if (!shown_drawn_ || cov.empty() || s.turned || no_hide_ || p_.always_packed) {
        hiding_ = false;
        return;
    }
    hiding_ = hidden_tiles(cov, p_.w, p_.h, s.rect, &hidden_);
}

void VideoLayer::occlude(Coverage *cov, const Shown &s)
{
    /* Drawn at u_opacity, 0 until its first frame is written. */
    if (g_ && s.drawn && opaque_ && s.opacity * s.fade >= 1.0f && !s.turned)
        cov->add(box_of(s.rect));
}

bool VideoLayer::uncovering() const
{
    if (!held_n_ || !g_ || !shown_drawn_ || blocks_shown_)
        return false;
    if (!hiding_)
        return true;
    for (size_t i = 0; i < held_.size(); i++)
        if (held_[i] && !hidden_[i])
            return true;
    return false;
}

bool VideoLayer::held_differ()
{
    const uint32_t T = crk::kTileSize, cols = (p_.w + T - 1) / T;
    bool any = false;
    for (size_t i = 0; i < held_.size(); i++) {
        if (!held_[i] || (hiding_ && hidden_[i]))
            continue;
        const uint32_t x0 = (uint32_t)(i % cols) * T, y0 = (uint32_t)(i / cols) * T;
        const uint32_t w = std::min(T, p_.w - x0), h = std::min(T, atlas_h_ - y0);
        bool differs = false;
        for (uint32_t y = y0; y < y0 + h && !differs; y++) {
            const size_t off = (size_t)y * p_.w + x0;
            differs = crk::max_abs_diff(&front_[off], &shown_[off], w) > p_.dirty_threshold;
        }
        if (differs) {
            any = true;
        } else {
            held_[i] = 0;
            held_n_--;
        }
    }
    return any;
}

void VideoLayer::planned_hidden(bool whole)
{
    if (!held_n_ && !hiding_)
        return;
    held_n_ = 0;
    if (whole || !hiding_) {
        std::fill(held_.begin(), held_.end(), 0);
        return;
    }
    for (size_t i = 0; i < held_.size(); i++) {
        held_[i] = hidden_[i] ? held_plan_[i] : 0;
        held_n_ += held_[i];
    }
}

bool VideoLayer::ready(int64_t now_ms) const
{
    return have_ && now_ms - last_frame_ms_ <= p_.stall_ms;
}

bool VideoLayer::attach(Graph *g, int64_t now_ms, std::string *err)
{
    g_ = g;
    /* The scene starts from the newest frame: one not yet written, the
     * newest partly written (quiet or held tiles), or what the last scene's
     * buffer held. The first stage() writes it whole, checked like any other
     * write; a layer whose frames have stopped is not ready, so not drawn. */
    if (!front_pending_ && !planner_.quiet() && !held_n_ && shown_.size() == atlas_bytes_) {
        front_.swap(shown_);
        front_ms_ = shown_ms_;
    }
    repeated_ = front_stale_ = false;
    front_pending_ = front_.size() == atlas_bytes_ && front_ms_ >= 0;
    shown_.assign(atlas_bytes_, 0);
    shown_ms_ = -1;
    planner_.reset();
    held_.assign(planner_.tiles(), 0);
    held_n_ = 0;
    hiding_ = shown_drawn_ = false;
    buffer_stale_ = true;
    opaque_ = false;
    blocks_shown_ = parked_ = false;
    first_ = true;
    refine_due_ms_ = -1;
    drawn_ = false;

    atlas_buf_ = g->buffer(TexFormat::R8, p_.w, atlas_h_, Sampling::Bilinear);
    bool good = atlas_buf_ && make_atlas_quads(g);
    if (good && p_.pan_blocks) {
        const uint32_t bw = crk::block_texels_w(p_.w), bh = crk::block_texels_h(p_.h);
        for (int k = 0; k < 2 && good; k++)
            good = (block_buf_[k] = g->buffer(TexFormat::RGBA8, bw, bh, Sampling::Nearest)) != 0;
        good = good && make_block_quads(g);
        block_bank_ = 0;
    }
    if (!good) {
        *err = p_.pan_blocks ? "video buffers, samplers or quads refused" : "video buffer, sampler or quad refused";
        detach(true);
        return false;
    }
    make_edge_quads();
    clock_.reset(now_ms);
    return true;
}

bool VideoLayer::make_atlas_quads(Graph *g)
{
    const float size[2] = {(float)p_.w, (float)p_.h}, zero = 0.0f;
    atlas_quad_ = g->quad(atlas_effect_, drawn_params().rect);
    return atlas_quad_ && g->turn(atlas_quad_, drawn_params().turn()) && g->texture(atlas_quad_, "u_image", atlas_buf_) &&
           g->uniform(atlas_quad_, "u_size", size, 2) && g->uniform(atlas_quad_, "u_opacity", &zero, 1) &&
           g->show(atlas_quad_, false) && g->order(atlas_quad_, order_);
}

bool VideoLayer::make_block_quads(Graph *g)
{
    const float size[2] = {(float)p_.w, (float)p_.h}, zero = 0.0f;
    block_quad_ = g->quad(block_effect_, drawn_params().rect);
    return block_quad_ && g->turn(block_quad_, drawn_params().turn()) && g->texture(block_quad_, "u_image", block_buf_[0]) &&
           g->uniform(block_quad_, "u_size", size, 2) && g->uniform(block_quad_, "u_opacity", &zero, 1) &&
           g->show(block_quad_, false) && g->order(block_quad_, order_ + 1);
}

void VideoLayer::drop_quads()
{
    if (atlas_quad_) g_->drop_quad(atlas_quad_);
    if (block_quad_) g_->drop_quad(block_quad_);
    drop_edge_quads();
}

bool VideoLayer::set_edge(const VideoEdge &e, int atlas_effect, int block_effect)
{
    if (e == edge_ && (!e.on() || (atlas_effect == edge_fx_[0] && block_effect == edge_fx_[1])))
        return false;
    edge_ = e;
    edge_fx_[0] = atlas_effect;
    edge_fx_[1] = block_effect;
    if (g_) {
        drop_edge_quads();
        make_edge_quads();
    }
    return true;
}

/* Over the picture (its order + 2), each sampling what its kind's quad
 * does, shown and faded as that is; a kind or side the renderer refuses is
 * not drawn. */
void VideoLayer::make_edge_quads()
{
    if (!g_ || !edge_.on())
        return;
    const Rect r = edge_at_ = drawn_params().rect;
    const float size[2] = {(float)p_.w, (float)p_.h}, zero = 0.0f;
    const float look[2] = {(float)edge_.dim, r.w ? (float)edge_.blur * p_.w / r.w : 0.0f};
    const uint32_t in = std::min(kEdgeInset, p_.h - 1);
    for (int k = 0; k < (p_.pan_blocks ? 2 : 1); k++)
        for (int side = 0; side < 2; side++) {
            const uint32_t past = side ? edge_.bottom : edge_.top;
            if (!past || !edge_fx_[k])
                continue;
            const Rect er = side ? Rect{r.x, r.y + (int32_t)(r.h - edge_.fade), r.w, edge_.fade + past}
                                 : Rect{r.x, r.y - (int32_t)past, r.w, past + edge_.fade};
            const float e[4] = {(float)(side ? p_.h - 1 - in : in) + 0.5f, side ? -(float)edge_.fade : (float)past,
                                side ? (float)past : -(float)edge_.fade, (float)edge_.fade};
            int &q = edge_quad_[k][side];
            q = g_->quad(edge_fx_[k], er);
            if (q && !(g_->texture(q, "u_image", k ? block_buf_[block_bank_] : atlas_buf_) &&
                       g_->uniform(q, "u_size", size, 2) && g_->uniform(q, "u_edge", e, 4) &&
                       g_->uniform(q, "u_look", look, 2) && g_->uniform(q, "u_opacity", &zero, 1) &&
                       g_->order(q, order_ + 2))) {
                g_->drop_quad(q);
                q = 0;
            }
        }
    show_quads(blocks_shown_);
    set_opacity();
}

void VideoLayer::drop_edge_quads()
{
    for (auto &kind : edge_quad_)
        for (int &q : kind) {
            if (q && g_)
                g_->drop_quad(q);
            q = 0;
        }
}

void VideoLayer::drop_objects()
{
    if (!g_)
        return;
    drop_quads();
    if (atlas_buf_) g_->drop_buffer(atlas_buf_);
    for (int k = 0; k < 2; k++)
        if (block_buf_[k]) g_->drop_buffer(block_buf_[k]);
}

void VideoLayer::detach(bool drop)
{
    if (drop)
        drop_objects();
    /* A frame the packed quad showed never reached the atlas: the next scene
     * starts from it. With always_packed shown_ is what the packed quad
     * shows, taken as the atlas's would be (attach, to_source). */
    if (blocks_shown_ && !p_.always_packed)
        front_pending_ = true;
    g_ = nullptr;
    hiding_ = shown_drawn_ = forced_write_ = false;
    atlas_buf_ = atlas_quad_ = block_quad_ = 0;
    edge_quad_[0][0] = edge_quad_[0][1] = edge_quad_[1][0] = edge_quad_[1][1] = 0;
    block_buf_[0] = block_buf_[1] = 0;
    blocks_shown_ = parked_ = false;
    drawn_ = false;
    refine_due_ms_ = -1;
    staged_ = Staged();
}

void VideoLayer::show_blocks(bool on)
{
    blocks_shown_ = on;
    if (!g_)
        return;
    show_quads(on);
}

void VideoLayer::show_quads(bool blocks)
{
    g_->show(atlas_quad_, drawn_ && !blocks);
    if (block_quad_)
        g_->show(block_quad_, drawn_ && blocks);
    for (int side = 0; side < 2; side++)
        for (int k = 0; k < 2; k++)
            if (edge_quad_[k][side])
                g_->show(edge_quad_[k][side], drawn_ && blocks == (k == 1));
}

bool VideoLayer::bank_quads(int buf)
{
    bool ok = g_->texture(block_quad_, "u_image", buf);
    for (int side = 0; side < 2; side++)
        if (edge_quad_[1][side])
            ok = g_->texture(edge_quad_[1][side], "u_image", buf) && ok;
    return ok;
}

void VideoLayer::set_opacity()
{
    const float a = opaque_ ? drawn_params().opacity * fade_ : 0.0f;
    g_->uniform(atlas_quad_, "u_opacity", &a, 1);
    if (block_quad_)
        g_->uniform(block_quad_, "u_opacity", &a, 1);
    for (auto &kind : edge_quad_)
        for (int q : kind)
            if (q)
                g_->uniform(q, "u_opacity", &a, 1);
}

void VideoLayer::arrange(bool drawn, int32_t order)
{
    order_ = order;
    if (!g_)
        return;
    drawn_ = drawn;
    show_blocks(blocks_shown_);
    g_->order(atlas_quad_, order);
    if (block_quad_)
        g_->order(block_quad_, order + 1);
    for (auto &kind : edge_quad_)
        for (int q : kind)
            if (q)
                g_->order(q, order + 2);
}

void VideoLayer::place()
{
    if (!g_)
        return;
    g_->place(atlas_quad_, drawn_params().rect);
    g_->turn(atlas_quad_, drawn_params().turn());
    if (block_quad_) {
        g_->place(block_quad_, drawn_params().rect);
        g_->turn(block_quad_, drawn_params().turn());
    }
    if (edge_.on() && drawn_params().rect != edge_at_) {   /* the edge's quads and blur follow the rect */
        drop_edge_quads();
        make_edge_quads();
    }
    set_opacity();
}

Stage VideoLayer::stage(int64_t now_ms)
{
    staged_ = Staged();
    if (!g_ || !drawn_)
        return Stage::Idle;
    /* Quiet tiles due to settle are written from front_, still the newest
     * frame, when no newer one waits; the packed quad gives way to the exact
     * atlas when no newer frame needed it for kRefineMs. */
    const int64_t settle_ms = planner_.settle_due_ms();
    const bool settle = !front_pending_ && settle_ms >= 0 && now_ms >= settle_ms;
    const bool refine = !p_.always_packed && blocks_shown_ && !front_pending_ && now_ms >= refine_due_ms_;
    /* Held tiles no longer hidden go now, whatever the frame clock. */
    const bool uncover = uncovering();
    if (!(front_pending_ || settle || refine || uncover) || (!clock_.due(now_ms) && !parked_ && !uncover))
        return Stage::Idle;
    const bool paced = pacer_.ready(now_ms);
    if (!paced && !(force_ && uncover)) {
        held_budget_++;
        return Stage::Idle;
    }
    /* A forced write (compositor.h) hides nothing. With packed blocks it is
     * the newest frame packed, the atlas hidden until a write the budget
     * allows brings it back exact; without, every changed tile, the held
     * ones with it. */
    forced_write_ = !paced;
    if (forced_write_) {
        /* Held tiles the newest frame no longer differs from past the
         * threshold are as the planner leaves quiet ones: no write. */
        if (!held_differ()) {
            forced_write_ = false;
            return Stage::Idle;
        }
        hiding_ = false;
        if (p_.pan_blocks && !first_ && !p_.always_packed)
            return stage_blocks(now_ms, front_pending_);
    }
    return stage_exact(now_ms, front_pending_);
}

/* always_packed: the blocks of the picture the plan's atlas rects touch (one
 * block more on every side, which their colours reach) that pack otherwise
 * from front_ than from shown_, packed into the packed buffer in place, in
 * as few rects as their rows give and at most kPackedRects; fill: every
 * block. They are packed from shown_ with the rects copied in (whole: from
 * front_), so the packed buffer stays shown_'s packing. The bytes written;
 * *written false on a refusal. */
size_t VideoLayer::write_packed(const std::vector<PixelRect> &rects, bool whole, bool fill, bool *written)
{
    const uint32_t bw = p_.w / 4, bh = p_.h / 4, cw = p_.w / 2;
    block_mask_.assign((size_t)bw * bh, fill ? 1 : 0);
    auto mark = [&](uint32_t x0, uint32_t y0, uint32_t x1, uint32_t y1) {   /* a picture rect */
        const uint32_t bx0 = x0 / 4 ? x0 / 4 - 1 : 0, by0 = y0 / 4 ? y0 / 4 - 1 : 0;
        const uint32_t bx1 = std::min(bw, (x1 + 3) / 4 + 1), by1 = std::min(bh, (y1 + 3) / 4 + 1);
        for (uint32_t by = by0; by < by1; by++)
            for (uint32_t bx = bx0; bx < bx1; bx++) {
                uint8_t &m = block_mask_[(size_t)by * bw + bx];
                m = m || crk::block_differs(front_.data(), shown_.data(), p_.w, p_.h, bx, by);
            }
    };
    for (const PixelRect &r : rects) {
        if (fill)
            break;
        if (r.y < p_.h)
            mark(r.x, r.y, r.x + r.w, std::min(r.y + r.h, p_.h));
        if (r.y + r.h > p_.h) {   /* chroma rows, U then V side by side: 2 pixels a sample */
            const uint32_t y0 = 2 * (std::max(r.y, p_.h) - p_.h), y1 = 2 * (r.y + r.h - p_.h);
            if (r.x < cw)
                mark(2 * r.x, y0, 2 * std::min(r.x + r.w, cw), y1);
            if (r.x + r.w > cw)
                mark(2 * (std::max(r.x, cw) - cw), y0, 2 * (r.x + r.w - cw), y1);
        }
    }
    if (!whole)
        crk::copy_rects(shown_.data(), front_.data(), p_.w, 1, rects);
    const uint8_t *src = whole ? front_.data() : shown_.data();
    /* Each row's runs of marked blocks, a run under one of the same columns
     * in the row above extending its rect; past kPackedRects every cell of
     * 2, then 4, 8 ... blocks a side with a mark is marked whole. */
    std::vector<PixelRect> out;
    std::vector<size_t> open, next;
    for (uint32_t s = 2;; s *= 2) {
        out.clear();
        open.clear();
        for (uint32_t by = 0; by < bh; by++) {
            next.clear();
            for (uint32_t bx = 0; bx < bw;) {
                if (!block_mask_[(size_t)by * bw + bx]) {
                    bx++;
                    continue;
                }
                const uint32_t x0 = bx;
                while (bx < bw && block_mask_[(size_t)by * bw + bx])
                    bx++;
                size_t i = 0;
                while (i < open.size() && !(out[open[i]].x == x0 && out[open[i]].w == bx - x0))
                    i++;
                if (i < open.size()) {
                    out[open[i]].h++;
                    next.push_back(open[i]);
                } else {
                    out.push_back(PixelRect{x0, by, bx - x0, 1});
                    next.push_back(out.size() - 1);
                }
            }
            open.swap(next);
        }
        if (out.size() <= kPackedRects)
            break;
        for (uint32_t cy = 0; cy < bh; cy += s)
            for (uint32_t cx = 0; cx < bw; cx += s) {
                const uint32_t x1 = std::min(bw, cx + s), y1 = std::min(bh, cy + s);
                bool any = false;
                for (uint32_t by = cy; by < y1 && !any; by++) {
                    const uint8_t *row = block_mask_.data() + (size_t)by * bw;
                    any = std::find(row + cx, row + x1, 1) != row + x1;
                }
                for (uint32_t by = cy; by < y1 && any; by++)
                    std::fill(block_mask_.data() + (size_t)by * bw + cx, block_mask_.data() + (size_t)by * bw + x1, 1);
            }
    }
    /* Into packed_: all of it on the packing threads, else each row's
     * marked blocks from the first to the last, its rows converted once. */
    if (out.size() == 1 && out[0].w == bw && out[0].h == bh) {
        crk::pack_blocks(src, p_.w, p_.h, packed_.data(), kPackThreads);
    } else {
        for (uint32_t by = 0; by < bh; by++) {
            const uint8_t *row = block_mask_.data() + (size_t)by * bw;
            uint32_t x0 = 0, x1 = bw;
            while (x0 < bw && !row[x0])
                x0++;
            while (x1 > x0 && !row[x1 - 1])
                x1--;
            if (x0 < x1)
                crk::pack_block_rect(src, p_.w, p_.h, x0, by, x1, by + 1, packed_.data() + ((size_t)by * bw + x0) * 8);
        }
    }
    size_t bytes = 0;
    *written = true;
    for (const PixelRect &b : out) {
        const size_t n = (size_t)b.w * b.h * 8;
        const uint8_t *px = packed_.data() + (size_t)b.y * bw * 8;   /* whole rows: in place */
        if (b.w < bw) {
            block_scratch_.resize(n);
            for (uint32_t y = 0; y < b.h; y++)
                std::memcpy(block_scratch_.data() + (size_t)y * b.w * 8,
                            packed_.data() + ((size_t)(b.y + y) * bw + b.x) * 8, (size_t)b.w * 8);
            px = block_scratch_.data();
        }
        if (!g_->write(block_buf_[block_bank_], 2 * b.x, b.y, 2 * b.w, b.h, px)) {
            *written = false;
            return bytes;
        }
        bytes += n;
    }
    return bytes;
}

/* The plan's rectangles go into the one buffer in place; the compositor's
 * one flush then shows them, so the cluster never shows a frame half
 * written. setData's bytes travel raw in the flush: what the budget
 * charges. A new frame whose exact write costs more than the packed one and
 * more than the budget allows at that moment goes packed instead, except
 * the layer's first frame in a scene: that goes whole and exact, its bytes
 * charged as debt. */
Stage VideoLayer::stage_exact(int64_t now_ms, bool fresh)
{
    /* A repeat of the picture last staged: its plan would find what that
     * picture's found, nothing to write, unless tiles are due to settle.
     * transient: pan_blocks' packed quad shows (with always_packed the
     * packed quad is the only one, written as the atlas would be). */
    const bool transient = blocks_shown_ && !p_.always_packed;
    const int64_t settle_ms = planner_.settle_due_ms();
    const bool uncover = uncovering();
    if (fresh && repeated_ && !uncover &&
        (transient || (opaque_ && !buffer_stale_ && (settle_ms < 0 || now_ms < settle_ms)))) {
        repeated_ = false;
        ((transient ? motion_.quiet() : planner_.quiet()) ? quiet_ : same_)++;
        if (!transient)
            shown_ms_ = front_ms_;
        front_pending_ = false;
        return Stage::Idle;
    }
    repeated_ = false;
    if (transient && fresh) {
        const UploadPlan m = motion_.plan(block_src_.data(), front_.data(), now_ms);
        if (m.rects.empty()) {
            (m.quiet_tiles ? quiet_ : same_)++;
            front_pending_ = false;
            return Stage::Idle;
        }
    }
    const bool refine = transient;
    const uint8_t *hidden = hiding_ ? hidden_.data() : nullptr;
    if (hidden)
        held_plan_.assign(planner_.tiles(), 0);
    const UploadPlan p = planner_.plan(shown_.data(), front_.data(), now_ms, hidden, hidden ? held_plan_.data() : nullptr);
    hidden_tiles_ += p.hidden_tiles;
    if (p.rects.empty() && opaque_ && !refine && !buffer_stale_) {
        planned_hidden(false);
        if (uncover)
            uncovers_++;
        if (fresh)
            (p.quiet_tiles ? quiet_ : same_)++;
        shown_ms_ = front_ms_;   /* the buffer is front_ to within the threshold */
        front_pending_ = false;
        return Stage::Idle;
    }
    /* Whole: a plan of most tiles, or a buffer a failed write (or a new
     * scene) left unlike shown_. */
    const bool whole = p.whole || buffer_stale_;
    const size_t raw = whole ? front_.size() : p.bytes;
    if (fresh && !first_ && p_.pan_blocks && !p_.always_packed && raw > packed_.size() &&
        pacer_.allowance() < (int64_t)raw) {
        planner_.reset();   /* the atlas is not written: no tile of it is left quiet */
        /* Nor are the held ones written: they stay held, with the hidden
         * tiles this plan found changed. */
        for (size_t i = 0; hidden && i < held_.size(); i++)
            if (hidden_[i] && held_plan_[i] && !held_[i]) {
                held_[i] = 1;
                held_n_++;
            }
        return stage_blocks(now_ms, fresh);
    }
    settled_ += p.settled_tiles;
    const std::vector<PixelRect> all{PixelRect{0, 0, p_.w, atlas_h_}};
    staged_.kind = Kind::Exact;
    staged_.fresh = fresh;
    staged_.offered_ms = front_ms_;
    staged_.whole = whole;
    staged_.refine = refine;
    staged_.raw = raw;
    staged_.rects = whole ? all : p.rects;
    bool written = true;
    if (p_.always_packed) {
        /* the blocks that changed, the buffer whole when stale */
        staged_.packed = true;
        staged_.raw = staged_.accepted = write_packed(staged_.rects, whole, buffer_stale_, &written);
    } else {
        staged_.accepted = crk::write_rects(
            front_.data(), p_.w, 1, staged_.rects, &rect_scratch_,
            [this](const uint8_t *px, const PixelRect &r) { return g_->write(atlas_buf_, r.x, r.y, r.w, r.h, px); },
            &written);
    }
    if (!written) {
        refused_++;
        return Stage::Failed;
    }
    /* A failed flush makes the next write whole, and until it goes the
     * target holds or the packed quad shows: the held tiles can be taken as
     * written now. */
    planned_hidden(whole);
    if (uncover)
        uncovers_++;
    if (!opaque_) {
        opaque_ = true;   /* undone in committed() if the flush fails */
        set_opacity();
    }
    parked_ = false;
    show_blocks(p_.always_packed || (refine ? false : blocks_shown_));
    return Stage::Wrote;
}

/* The whole of front_ packed into the bank not shown, which then shows: a
 * failed write or flush leaves the shown bank and quad as they were. */
Stage VideoLayer::stage_blocks(int64_t, bool fresh)
{
    crk::pack_blocks(front_.data(), p_.w, p_.h, packed_.data(), kPackThreads);
    staged_.kind = Kind::Blocks;
    staged_.fresh = fresh;
    staged_.offered_ms = front_ms_;
    staged_.next_bank = 1 - block_bank_;
    staged_.was_shown = blocks_shown_;
    staged_.was_parked = parked_;
    staged_.raw = packed_.size();
    bool written = g_->write(block_buf_[staged_.next_bank], 0, 0, crk::block_texels_w(p_.w),
                             crk::block_texels_h(p_.h), packed_.data());
    staged_.accepted = written ? packed_.size() : 0;
    if (!written)
        refused_++;
    if (written)
        written = bank_quads(block_buf_[staged_.next_bank]);
    if (!written)
        return Stage::Failed;
    if (!opaque_) {
        opaque_ = true;
        set_opacity();
    }
    parked_ = false;   /* the stale atlas is hidden in this flush */
    show_blocks(true);
    return Stage::Wrote;
}

void VideoLayer::committed(bool ok, int64_t now_ms)
{
    const Staged s = staged_;
    staged_ = Staged();
    const bool forced = forced_write_;
    forced_write_ = false;
    if (s.kind != Kind::None && ok) {
        /* After a forced write nothing is hidden until a write the budget
         * allowed has gone: it started from a positive allowance, so the
         * forced write's debt was repaid. */
        if (forced) {
            no_hide_ = true;
            forced_++;
        } else {
            no_hide_ = false;
        }
    }
    if (s.kind == Kind::None)
        return;
    /* A failed update is retried with the newest frame: packed blocks at the
     * next deadline, an exact write as soon as the budget allows. */
    clock_.sent(now_ms);
    if (!ok) {
        failed_++;
        pacer_.spend(s.accepted);
        if (s.kind == Kind::Blocks) {
            bank_quads(block_buf_[block_bank_]);
            parked_ = s.was_parked;
            show_blocks(s.was_shown);
        } else {
            /* Part of front_ may be in the buffer, unflushed: the next write
             * is whole, and until it goes the target holds its flushes
             * (holds_flush), so the cluster keeps showing the last frame
             * and never a half-written one. The packed quad keeps showing
             * if it was. */
            buffer_stale_ = true;
            parked_ = !s.refine;
            show_blocks(s.refine ? true : blocks_shown_);
            /* A settle write that failed still has a frame to show: the next
             * deadline writes it whole. */
            if (!s.refine)
                front_pending_ = true;
        }
        if (shown_ms_ < 0 && !blocks_shown_) {
            opaque_ = false;
            set_opacity();
        }
        return;
    }
    if (s.fresh) {
        sent_++;
        age_ms_ += (uint64_t)std::max<int64_t>(0, now_ms - s.offered_ms);
    }
    bytes_ += s.raw;
    pacer_.spend(s.raw);
    if (s.kind == Kind::Blocks) {
        block_bank_ = s.next_bank;
        block_src_.assign(front_.begin(), front_.end());
        motion_.reset();   /* the packed frame is front_: nothing of it is left quiet */
        refine_due_ms_ = now_ms + kRefineMs;
        packed_writes_++;
        front_pending_ = false;   /* buffer_stale_ stays: the atlas still needs a whole write */
        return;
    }
    buffer_stale_ = false;
    first_ = false;
    /* shown_ is what the buffer holds: all of front_, or front_ in the
     * written rectangles; front_ stays the newest frame while quiet tiles
     * are left (planner_.quiet()). */
    if (s.whole) {
        shown_.swap(front_);
        front_stale_ = true;
        planner_.reset();
    } else if (!s.packed) {   /* a packed write copied its rects into shown_ (write_packed) */
        crk::copy_rects(shown_.data(), front_.data(), p_.w, 1, s.rects);
    }
    if (s.refine) {
        refine_due_ms_ = -1;
        refines_++;
    }
    if (s.packed) {   /* always_packed: shown_ is what the packed buffer holds */
        packed_writes_++;
    } else {
        (s.whole ? whole_writes_ : partial_writes_)++;
        rects_ += s.rects.size();
    }
    shown_ms_ = front_ms_;
    front_pending_ = false;
}

int64_t VideoLayer::wake_in_ms(int64_t now_ms) const
{
    if (!g_ || !drawn_ || !front_pending_)
        return -1;
    const int64_t w = clock_.ms_until_due(now_ms);
    return w > 0 ? w : -1;
}

WriteStats VideoLayer::write_stats() const
{
    WriteStats w;
    w.frames = sent_;
    w.age_ms = age_ms_;
    w.bytes = bytes_;
    w.failed = failed_;
    w.holds = held_budget_;
    return w;
}

std::string VideoLayer::stats() const
{
    char b[400];
    std::snprintf(b, sizeof b,
                  "%s%llu sent, %llu unchanged, %llu within threshold, %llu superseded, %llu settled, %llu failed "
                  "(%llu refused), %llu KB, %llu whole, %llu partial, %llu rects, %llu packed, %llu back to exact, "
                  "%llu budget holds",
                  source_ ? "drawn by the target's composite; " : "", (unsigned long long)sent_,
                  (unsigned long long)same_, (unsigned long long)quiet_,
                  (unsigned long long)superseded_, (unsigned long long)settled_, (unsigned long long)failed_,
                  (unsigned long long)refused_, (unsigned long long)(bytes_ / 1024),
                  (unsigned long long)whole_writes_, (unsigned long long)partial_writes_, (unsigned long long)rects_,
                  (unsigned long long)packed_writes_, (unsigned long long)refines_,
                  (unsigned long long)held_budget_);
    if (!hidden_tiles_)
        return b;
    char h[96];
    std::snprintf(h, sizeof h, ", %llu tiles left hidden, %llu uncovered (%llu forced)",
                  (unsigned long long)hidden_tiles_, (unsigned long long)uncovers_, (unsigned long long)forced_);
    return std::string(b) + h;
}

}  // namespace crs
