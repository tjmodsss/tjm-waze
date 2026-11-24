/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "text_layer.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "log.h"

namespace crs {

const char *const kTextVertexShader = R"(#version 100
attribute vec2 a_position;
attribute vec2 a_texcoord;
uniform mat4 u_mvp;
varying vec2 v_uv;
void main() {
    v_uv = a_texcoord;
    gl_Position = u_mvp * vec4(a_position, 0.0, 1.0);
})";

/* highp where the GPU has it: an atlas 2048 pixels wide needs more than
 * mediump's 10 bits to address a texel. */
const char *const kTextFragmentShader = R"(#version 100
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_atlas;
uniform vec4 u_color;
uniform float u_sdf;
varying vec2 v_uv;
void main() {
    float s = texture2D(u_atlas, v_uv).r;
    float a = u_sdf > 0.0 ? clamp((s - 0.5) * u_sdf + 0.5, 0.0, 1.0) : s;
    gl_FragColor = vec4(u_color.rgb * u_color.a, u_color.a) * a;
})";

const char *const kTextVertexShader300 = R"(#version 300 es
in vec2 a_position;
in vec2 a_texcoord;
uniform mat4 u_mvp;
out vec2 v_uv;
void main() {
    v_uv = a_texcoord;
    gl_Position = u_mvp * vec4(a_position, 0.0, 1.0);
})";

/* The edge where the distance sample crosses 0.5, as wide as the sample
 * changes over a pixel on screen: whatever the size, turn or scale. */
const char *const kTextSdfFragmentShader300 = R"(#version 300 es
precision highp float;
uniform sampler2D u_atlas;
uniform vec4 u_color;
in vec2 v_uv;
out vec4 o_color;
void main() {
    float s = texture(u_atlas, v_uv).r;
    float a = clamp((s - 0.5) / max(fwidth(s), 0.0001) + 0.5, 0.0, 1.0);
    o_color = vec4(u_color.rgb * u_color.a, u_color.a) * a;
})";

namespace {

/* n integers at p separated by sep, into v, p past them; false for
 * anything else or a value past 2^31. */
bool ints(const char *&p, const char *end, int64_t *v, size_t n, char sep)
{
    for (size_t i = 0; i < n; i++) {
        if (i && (p >= end || *p++ != sep))
            return false;
        const bool neg = p < end && *p == '-';
        if (neg)
            p++;
        if (p >= end || *p < '0' || *p > '9')
            return false;
        int64_t x = 0;
        while (p < end && *p >= '0' && *p <= '9') {
            x = x * 10 + (*p++ - '0');
            if (x > 0x7fffffff)
                return false;
        }
        v[i] = neg ? -x : x;
    }
    return true;
}

bool scalar(int64_t c) { return c >= 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff); }

/* Entries of s separated by spaces, each passed to f(begin, end). */
template <typename F> bool entries(const std::string &s, F f)
{
    const char *p = s.data(), *end = p + s.size();
    while (p < end) {
        if (*p == ' ') {
            p++;
            continue;
        }
        const char *e = p;
        while (e < end && *e != ' ')
            e++;
        if (!f(p, e))
            return false;
        p = e;
    }
    return true;
}

}  // namespace

bool parse_font(const std::string &glyphs, const std::string &kerning, uint32_t aw, uint32_t ah, uint32_t line,
                uint32_t sdf, Font *out, std::string *err)
{
    Font f;
    f.aw = aw;
    f.ah = ah;
    f.line = line;
    f.sdf = sdf;
    if (line < 1 || line > Font::kMaxLine) {
        *err = "a font's line is 1 to 2048 pixels";
        return false;
    }
    if (sdf > Font::kMaxSdf) {
        *err = "a font's sdf is 0 to 64 pixels";
        return false;
    }
    std::string why;
    const bool good = entries(glyphs, [&](const char *p, const char *end) {
        int64_t code = 0, v[7];
        if (!ints(p, end, &code, 1, ':') || p >= end || *p++ != ':' || !ints(p, end, v, 7, ',') || p != end) {
            why = "a font's glyphs are code:x,y,w,h,left,top,advance";
            return false;
        }
        if (!scalar(code)) {
            why = "glyph " + std::to_string(code) + ": not a Unicode scalar value";
            return false;
        }
        if (f.glyphs.count((uint32_t)code)) {
            why = "glyph " + std::to_string(code) + " comes twice";
            return false;
        }
        if (f.glyphs.size() >= Font::kMaxGlyphs) {
            why = "a font has at most " + std::to_string(Font::kMaxGlyphs) + " glyphs";
            return false;
        }
        if (v[0] < 0 || v[1] < 0 || v[2] < 0 || v[3] < 0 || v[0] + v[2] > aw || v[1] + v[3] > ah) {
            why = "glyph " + std::to_string(code) + ": its box is outside the atlas";
            return false;
        }
        if (std::llabs(v[4]) > 2048 || std::llabs(v[5]) > 2048 || v[6] < 0 || v[6] > 2048) {
            why = "glyph " + std::to_string(code) + ": left and top are -2048 to 2048, advance 0 to 2048";
            return false;
        }
        FontGlyph &g = f.glyphs[(uint32_t)code];
        g.x = (uint16_t)v[0];
        g.y = (uint16_t)v[1];
        g.w = (uint16_t)v[2];
        g.h = (uint16_t)v[3];
        g.left = (int16_t)v[4];
        g.top = (int16_t)v[5];
        g.advance = (uint16_t)v[6];
        return true;
    });
    if (!good) {
        *err = why;
        return false;
    }
    const bool kerned = entries(kerning, [&](const char *p, const char *end) {
        int64_t pair[2], amount = 0;
        if (!ints(p, end, pair, 2, ',') || p >= end || *p++ != ':' || !ints(p, end, &amount, 1, ',') || p != end) {
            why = "a font's kerning is first,second:amount";
            return false;
        }
        if (!scalar(pair[0]) || !scalar(pair[1]) || !f.glyphs.count((uint32_t)pair[0]) ||
            !f.glyphs.count((uint32_t)pair[1])) {
            why = "kerning " + std::to_string(pair[0]) + "," + std::to_string(pair[1]) + ": a glyph the font lacks";
            return false;
        }
        if (std::llabs(amount) > 2048) {
            why = "kerning is -2048 to 2048";
            return false;
        }
        if (f.kerning.size() >= Font::kMaxKerning) {
            why = "a font has at most " + std::to_string(Font::kMaxKerning) + " kerning pairs";
            return false;
        }
        f.kerning[(uint64_t)pair[0] << 32 | (uint64_t)pair[1]] = (int16_t)amount;
        return true;
    });
    if (!kerned) {
        *err = why;
        return false;
    }
    *out = std::move(f);
    return true;
}

bool decode_utf8(const std::string &s, std::vector<uint32_t> *out)
{
    out->clear();
    if (!cr::utf8_ok(s))
        return false;
    /* well-formed: each lead byte says how many continuation bytes follow */
    for (size_t i = 0; i < s.size();) {
        const uint8_t b = (uint8_t)s[i];
        const int n = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
        uint32_t cp = n == 1 ? b : b & (0x7f >> n);
        for (int k = 1; k < n; k++)
            cp = (cp << 6) | ((uint8_t)s[i + k] & 0x3f);
        out->push_back(cp);
        i += n;
    }
    return true;
}

std::vector<GlyphQuad> lay_out(const Font &f, const std::vector<uint32_t> &cps, const TextStyle &st, uint32_t w,
                               uint32_t h, float *width)
{
    std::vector<GlyphQuad> out;
    const float size = st.size > 0 ? st.size : (float)h;
    const float s = f.line ? size / (float)f.line : 0;
    float pen = 0;
    const FontGlyph *space = nullptr;
    auto sp = f.glyphs.find(32);
    if (sp != f.glyphs.end())
        space = &sp->second;
    for (size_t i = 0; i < cps.size(); i++) {
        if (i) {
            auto k = f.kerning.find((uint64_t)cps[i - 1] << 32 | cps[i]);
            if (k != f.kerning.end())
                pen += (float)k->second * s;
            pen += st.spacing;
        }
        auto it = f.glyphs.find(cps[i]);
        const FontGlyph *g = it == f.glyphs.end() ? nullptr : &it->second;
        if (g && g->w && g->h) {
            GlyphQuad q;
            q.x0 = std::floor(pen + (float)g->left * s + 0.5f);
            q.y0 = std::floor((float)g->top * s + 0.5f);
            q.x1 = q.x0 + (float)g->w * s;
            q.y1 = q.y0 + (float)g->h * s;
            q.u0 = (float)g->x / (float)f.aw;
            q.v0 = (float)g->y / (float)f.ah;
            q.u1 = (float)(g->x + g->w) / (float)f.aw;
            q.v1 = (float)(g->y + g->h) / (float)f.ah;
            out.push_back(q);
        }
        if (g)
            pen += (float)g->advance * s;
        else if (space)
            pen += (float)space->advance * s;
    }
    if (width)
        *width = pen;
    const float room = (float)w - pen;
    const float shift = st.align == TextAlign::Right ? std::floor(room + 0.5f)
                        : st.align == TextAlign::Center ? std::floor(room / 2 + 0.5f) : 0.0f;
    std::vector<GlyphQuad> kept;
    kept.reserve(out.size());
    for (GlyphQuad q : out) {
        q.x0 += shift;
        q.x1 += shift;
        /* cut to the layer, the atlas box with it */
        const float cx0 = std::max(q.x0, 0.0f), cx1 = std::min(q.x1, (float)w);
        const float cy0 = std::max(q.y0, 0.0f), cy1 = std::min(q.y1, (float)h);
        if (cx1 <= cx0 || cy1 <= cy0)
            continue;
        const float du = (q.u1 - q.u0) / (q.x1 - q.x0), dv = (q.v1 - q.v0) / (q.y1 - q.y0);
        GlyphQuad c;
        c.x0 = cx0;
        c.x1 = cx1;
        c.y0 = cy0;
        c.y1 = cy1;
        c.u0 = q.u0 + (cx0 - q.x0) * du;
        c.u1 = q.u0 + (cx1 - q.x0) * du;
        c.v0 = q.v0 + (cy0 - q.y0) * dv;
        c.v1 = q.v0 + (cy1 - q.y0) * dv;
        kept.push_back(c);
    }
    return kept;
}

std::vector<float> glyph_vertices(const std::vector<GlyphQuad> &qs, uint32_t w, uint32_t h)
{
    std::vector<float> v;
    v.reserve(qs.size() * 16);
    const float fw = w ? (float)w : 1, fh = h ? (float)h : 1;
    for (const GlyphQuad &q : qs) {
        const float x0 = q.x0 / fw, x1 = q.x1 / fw, top = 1 - q.y0 / fh, bottom = 1 - q.y1 / fh;
        const float corners[16] = {x0, bottom, q.u0, q.v1, x1, bottom, q.u1, q.v1,
                                   x0, top,    q.u0, q.v0, x1, top,    q.u1, q.v0};
        v.insert(v.end(), corners, corners + 16);
    }
    return v;
}

float sdf_factor(const Font &f, float size, float scale)
{
    return f.sdf && f.line ? 2.0f * (float)f.sdf * size * scale / (float)f.line : 0.0f;
}

TextLayer::TextLayer(uint32_t id, int target, uint64_t seq, crk::UploadPacer &pacer, int effect,
                     std::shared_ptr<const Font> font, uint32_t capacity, bool derivatives, int64_t now_ms)
    : EffectLayer(id, target, seq, pacer, effect, 0, now_ms), font_(std::move(font)), capacity_(capacity),
      derivatives_(derivatives)
{
    PartLook look = quad_look();
    look.blend = Blend::Premultiplied;
    set_look(look);
    clock_.configure(kFps);
    clock_.reset(now_ms);
    colour();
}

void TextLayer::colour()
{
    set_uniform("u_color", style_.color, 4);
    sharpen();
}

void TextLayer::sharpen()
{
    if (derivatives_)
        return;   /* the shader finds the edge's width itself */
    const LayerParams &p = drawn_params();
    const float size = style_.size > 0 ? style_.size : (float)p.rect.h;
    const float scale = std::max(std::max(std::fabs(p.sx), std::fabs(p.sy)), animated_scale(0));
    const float sdf = sdf_factor(*font_, size, scale);
    if (sdf != sdf_) {
        sdf_ = sdf;
        set_uniform("u_sdf", &sdf, 1);
    }
}

void TextLayer::set_text(std::vector<uint32_t> &&cps)
{
    if (cps == cps_)
        return;
    cps_ = std::move(cps);
    version_++;
}

void TextLayer::set_style(const TextStyle &s)
{
    const bool moved = s.size != style_.size || s.spacing != style_.spacing || s.align != style_.align;
    style_ = s;
    colour();
    if (moved)
        version_++;
    /* After a refused write: drawn again, its glyphs rewritten first (the
     * buffers may be half written), hidden until that write goes. */
    if (!refusal_.empty()) {
        refusal_.clear();
        stale_ = true;
        version_++;
    }
}

void TextLayer::arrange(bool drawn, int32_t order)
{
    EffectLayer::arrange(drawn, order);
    if (g_ && stale_)
        g_->show(quad_handle(), false);
}

bool TextLayer::attach(Graph *g, int64_t now_ms, std::string *err)
{
    if (!EffectLayer::attach(g, now_ms, err))
        return false;
    if (!g->glyph_buffer(quad_handle(), capacity_)) {
        *err = "the renderer refused the text's glyph buffers";
        detach(true);
        return false;
    }
    written_ = 0;   /* the new scene's buffers hold nothing yet */
    refusal_.clear();
    stale_ = false;
    sdf_ = -1;   /* the new quad has none yet */
    colour();
    return true;
}

void TextLayer::place()
{
    EffectLayer::place();
    const Rect &r = drawn_params().rect;
    if (r.w != laid_.w || r.h != laid_.h) {
        version_++;
        colour();   /* the size follows the height */
    }
}

Stage TextLayer::stage(int64_t now_ms)
{
    staged_bytes_ = 0;
    staged_version_ = 0;
    sharpen();   /* a turn or a scale animation may have changed the scale */
    Stage st = EffectLayer::stage(now_ms);
    if (!g_ || !drawn_ || written_ == version_)
        return st;
    if (!clock_.due(now_ms))
        return st;
    if (!pacer_.ready(now_ms)) {
        holds_++;
        return st;
    }
    const Rect r = drawn_params().rect;
    const std::vector<GlyphQuad> all = lay_out(*font_, cps_, style_, r.w, r.h);
    const uint32_t n = (uint32_t)std::min<size_t>(all.size(), capacity_);
    std::vector<GlyphQuad> q(all.begin(), all.begin() + n);
    const std::vector<float> v = glyph_vertices(q, r.w, r.h);
    if (!g_->glyphs(quad_handle(), v.data(), n)) {
        /* Its quad hidden at once (stale_), its buffers maybe half
         * written; in error until the client changes it, so the target's
         * other layers flush on. drawn_ stays as the compositor arranged
         * it: the compositor hides the layer for the refusal at its next
         * arrange, and should the client's change clear the refusal
         * before that, the layer is still drawn and stages the rewrite. */
        failed_++;
        refusal_ = "the renderer refused " + std::to_string(n) + " glyphs";
        log_error("layer %u: %s", id_, refusal_.c_str());
        g_->show(quad_handle(), false);
        stale_ = true;
        return Stage::Wrote;
    }
    refusal_.clear();   /* written whole: a held layer retries before the compositor arranges it */
    if (stale_) {
        stale_ = false;   /* shown with the glyphs written now */
        g_->show(quad_handle(), true);
    }
    staged_bytes_ = (size_t)n * kVertexBytes;
    pacer_.spend(staged_bytes_);
    staged_version_ = version_;
    pending_drawn_ = n;
    laid_ = r;
    return Stage::Wrote;
}

void TextLayer::committed(bool ok, int64_t now_ms)
{
    EffectLayer::committed(ok, now_ms);
    if (!staged_version_)
        return;
    if (ok) {
        written_ = staged_version_;
        glyphs_drawn_ = pending_drawn_;
        clock_.sent(now_ms);
        writes_++;
        bytes_ += staged_bytes_;
    } else {
        failed_++;
    }
    staged_version_ = 0;
}

int64_t TextLayer::wake_in_ms(int64_t now_ms) const
{
    if (!g_ || !drawn_ || written_ == version_)
        return EffectLayer::wake_in_ms(now_ms);
    const int64_t w = clock_.ms_until_due(now_ms);
    return w > 0 ? w : -1;
}

std::string TextLayer::stats() const
{
    char b[128];
    std::snprintf(b, sizeof b, "%u of %u glyphs drawn, %llu writes, %llu KB", glyphs_drawn_, capacity_,
                  (unsigned long long)writes_, (unsigned long long)(bytes_ / 1024));
    return b;
}

WriteStats TextLayer::write_stats() const
{
    WriteStats s;
    s.frames = writes_;
    s.bytes = bytes_;
    s.failed = failed_;
    s.holds = holds_;
    return s;
}

}  // namespace crs
