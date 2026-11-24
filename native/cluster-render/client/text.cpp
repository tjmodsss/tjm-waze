/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "cluster_render/text.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <sstream>

namespace cr {

namespace {

const unsigned kMaxAtlas = 2048;

/* The code points of UTF-8 s; a bad byte stands for itself. */
std::vector<uint32_t> code_points(const std::string &s)
{
    std::vector<uint32_t> out;
    for (size_t i = 0; i < s.size();) {
        const uint8_t b = (uint8_t)s[i];
        const int n = b < 0x80 ? 1 : (b >> 5) == 6 ? 2 : (b >> 4) == 14 ? 3 : (b >> 3) == 30 ? 4 : 1;
        uint32_t cp = n == 1 ? b : b & (0x7f >> n);
        bool good = i + n <= s.size();
        for (int k = 1; good && k < n; k++) {
            const uint8_t c = (uint8_t)s[i + k];
            good = (c >> 6) == 2;
            cp = (cp << 6) | (c & 0x3f);
        }
        out.push_back(good ? cp : b);
        i += good ? n : 1;
    }
    return out;
}

/* key=value's number in a BMFont line; 0 when absent. */
int field(const std::string &line, const char *key)
{
    const std::string k = std::string(" ") + key + "=";
    const size_t at = line.find(k);
    return at == std::string::npos ? 0 : std::atoi(line.c_str() + at + k.size());
}

}  // namespace

Font Font::from_glyphs(unsigned line_height, const std::vector<GlyphBitmap> &glyphs,
                       const std::map<std::pair<uint32_t, uint32_t>, int> &kerning, unsigned sdf)
{
    Font f;
    if (line_height < 1 || line_height > kMaxAtlas || sdf > 64)
        return f;
    /* Shelves of glyphs, a column and a row of 0 around each: nothing
     * bleeds in when sampled bilinear. As wide as a square of their area,
     * a power of two. */
    size_t area = 0;
    unsigned widest = 0;
    for (const GlyphBitmap &g : glyphs) {
        if (g.pixels.size() < (size_t)g.w * g.h || std::abs(g.top) > 2048 || std::abs(g.left) > 2048 ||
            g.advance > 2048)
            return f;
        area += (size_t)(g.w + 1) * (g.h + 1);
        widest = std::max(widest, g.w + 2);
    }
    unsigned w = 16;
    while (w < kMaxAtlas && ((size_t)w * w < area || w < widest))
        w *= 2;
    if (widest > w)
        return f;
    std::vector<std::pair<unsigned, unsigned>> at(glyphs.size());
    unsigned x = 1, y = 1, shelf = 0;
    for (size_t i = 0; i < glyphs.size(); i++) {
        const GlyphBitmap &g = glyphs[i];
        if (x + g.w + 1 > w) {
            x = 1;
            y += shelf + 1;
            shelf = 0;
        }
        at[i] = std::make_pair(x, y);
        x += g.w + 1;
        shelf = std::max(shelf, g.h);
    }
    const unsigned h = y + shelf + 1;
    if (h > kMaxAtlas)
        return f;
    f.w_ = w;
    f.h_ = h;
    f.line_ = line_height;
    f.sdf_ = sdf;
    f.px_.assign((size_t)w * h, 0);
    f.kerning_ = kerning;
    for (size_t i = 0; i < glyphs.size(); i++) {
        const GlyphBitmap &g = glyphs[i];
        for (unsigned row = 0; row < g.h; row++)
            std::memcpy(&f.px_[(size_t)(at[i].second + row) * w + at[i].first], &g.pixels[(size_t)row * g.w], g.w);
        Glyph &gl = f.glyphs_[g.code];
        gl.x = at[i].first;
        gl.y = at[i].second;
        gl.w = g.w;
        gl.h = g.h;
        gl.left = g.left;
        gl.top = g.top;
        gl.advance = g.advance < 0 ? (int)g.w : g.advance;
    }
    return f;
}

Font Font::from_grid(const uint8_t *pixels, unsigned w, unsigned h, unsigned cols, unsigned rows,
                     const std::string &chars, unsigned bpp, unsigned advance)
{
    const std::vector<uint32_t> cps = code_points(chars);
    if (!cols || !rows || cps.size() > (size_t)cols * rows || (bpp != 1 && bpp != 4))
        return Font();
    const unsigned cw = w / cols, ch = h / rows;
    std::vector<GlyphBitmap> glyphs;
    for (size_t i = 0; i < cps.size(); i++) {
        GlyphBitmap g;
        g.code = cps[i];
        g.w = cw;
        g.h = ch;
        g.advance = (int)(advance ? advance : cw);
        g.pixels.resize((size_t)cw * ch);
        const unsigned cx = (unsigned)(i % cols) * cw, cy = (unsigned)(i / cols) * ch;
        for (unsigned y = 0; y < ch; y++)
            for (unsigned x = 0; x < cw; x++)
                g.pixels[(size_t)y * cw + x] = pixels[((size_t)(cy + y) * w + cx + x) * bpp + bpp - 1];
        glyphs.push_back(std::move(g));
    }
    return from_glyphs(ch, glyphs);
}

Font Font::from_bmfont(const std::string &fnt, const uint8_t *page, unsigned page_w, unsigned page_h, unsigned bpp,
                       unsigned sdf)
{
    if (bpp != 1 && bpp != 4)
        return Font();
    unsigned line_height = 0;
    std::vector<GlyphBitmap> glyphs;
    std::map<std::pair<uint32_t, uint32_t>, int> kerning;
    std::istringstream in(fnt);
    std::string line;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r')
            line.pop_back();
        if (line.compare(0, 7, "common ") == 0) {
            line_height = (unsigned)std::max(0, field(line, "lineHeight"));
            if (field(line, "pages") > 1 || field(line, "packed"))
                return Font();
        } else if (line.compare(0, 5, "char ") == 0) {
            GlyphBitmap g;
            const int chnl = field(line, "chnl");
            if (field(line, "page") || (chnl && chnl != 15))
                return Font();
            const int gx = field(line, "x"), gy = field(line, "y");
            g.code = (uint32_t)field(line, "id");
            if (field(line, "width") < 0 || field(line, "height") < 0)
                return Font();   /* malformed, as Node refuses it */
            g.w = (unsigned)field(line, "width");
            g.h = (unsigned)field(line, "height");
            g.left = field(line, "xoffset");
            g.top = field(line, "yoffset");
            g.advance = field(line, "xadvance");
            if (g.advance < 0)
                return Font();
            if (gx < 0 || gy < 0 || gx + g.w > page_w || gy + g.h > page_h)
                return Font();
            g.pixels.resize((size_t)g.w * g.h);
            for (unsigned y = 0; y < g.h; y++)
                for (unsigned x = 0; x < g.w; x++)
                    g.pixels[(size_t)y * g.w + x] = page[((size_t)(gy + y) * page_w + gx + x) * bpp + bpp - 1];
            glyphs.push_back(std::move(g));
        } else if (line.compare(0, 8, "kerning ") == 0) {
            kerning[std::make_pair((uint32_t)field(line, "first"), (uint32_t)field(line, "second"))] =
                field(line, "amount");
        }
    }
    return from_glyphs(line_height, glyphs, kerning, sdf);
}

FontOptions Font::options() const
{
    FontOptions fo;
    fo.line = line_;
    fo.sdf = sdf_;
    std::ostringstream g, k;
    for (const auto &kv : glyphs_) {
        const Glyph &gl = kv.second;
        g << (g.tellp() > 0 ? " " : "") << kv.first << ':' << gl.x << ',' << gl.y << ',' << gl.w << ',' << gl.h << ','
          << gl.left << ',' << gl.top << ',' << gl.advance;
    }
    /* only pairs of glyphs the font has: the service refuses others */
    for (const auto &kv : kerning_)
        if (glyphs_.count(kv.first.first) && glyphs_.count(kv.first.second) && kv.second)
            k << (k.tellp() > 0 ? " " : "") << kv.first.first << ',' << kv.first.second << ':' << kv.second;
    fo.glyphs = g.str();
    fo.kerning = k.str();
    return fo;
}

uint32_t Font::asset(Client &c, const std::string &target) const
{
    if (!ok())
        return 0;
    return c.font(target, w_, h_, px_.data(), options());
}

float Font::measure(const std::string &text, float h, float spacing, unsigned *glyphs) const
{
    const float s = line_ ? h / (float)line_ : 0;
    float x = 0;
    unsigned n = 0;
    auto space = glyphs_.find(32);
    const std::vector<uint32_t> cps = code_points(text);
    for (size_t i = 0; i < cps.size(); i++) {
        if (i) {
            auto k = kerning_.find(std::make_pair(cps[i - 1], cps[i]));
            if (k != kerning_.end() && glyphs_.count(cps[i - 1]) && glyphs_.count(cps[i]))
                x += (float)k->second * s;
            x += spacing;
        }
        auto g = glyphs_.find(cps[i]);
        if (g != glyphs_.end()) {
            n += g->second.w && g->second.h;
            x += (float)g->second.advance * s;
        } else if (space != glyphs_.end()) {
            x += (float)space->second.advance * s;
        }
    }
    if (glyphs)
        *glyphs = n;
    return x;
}

Text::Text(Client &c, std::shared_ptr<const Font> font, uint32_t font_ref, const LayerOptions &lo,
           const TextOptions &to)
    : c_(c), font_(std::move(font)), lo_(lo), to_(to)
{
    if (!font_ || !font_->ok() || !lo_.w || !lo_.h || !to_.max_glyphs || to_.max_glyphs > kMaxTextGlyphs)
        return;
    TextLayerOptions tl;
    tl.max = to_.max_glyphs;
    tl.align = to_.align;
    tl.spacing = to_.spacing;
    std::copy(to_.color, to_.color + 4, tl.color);
    ref_ = c_.text(lo_, font_ref, tl);
}

bool Text::set(const std::string &text)
{
    if (!ref_)
        return false;
    if (!c_.set_text(ref_, text))
        return false;   /* past kMaxTextBytes or not UTF-8: the last string stays */
    unsigned n = 0;
    const float width = font_->measure(text, (float)lo_.h, to_.spacing, &n);
    return n <= to_.max_glyphs && width <= (float)lo_.w;
}

void Text::color(const float rgba[4])
{
    if (!ref_)
        return;
    std::copy(rgba, rgba + 4, to_.color);
    TextLayerOptions tl;
    tl.max = to_.max_glyphs;
    tl.align = to_.align;
    tl.spacing = to_.spacing;
    std::copy(to_.color, to_.color + 4, tl.color);
    c_.set_text_style(ref_, tl);
}

void Text::drop()
{
    if (ref_)
        c_.drop(ref_);
    ref_ = 0;
}

}  // namespace cr
