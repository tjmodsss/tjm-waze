/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Text for cluster-render (PROTOCOL.md "Text"), as js/cluster_render_text.js:
 * a Font packs its glyphs into an r8 atlas and sends it once as an asset
 * with its table (Client::font()); a Text is a text layer drawing a line
 * of it, laid out by the service (Client::text()), so changing the string
 * sends the string alone. Both need a service whose hello has text
 * (Client::takes_text()); they are held until then. */
#ifndef CLUSTER_RENDER_TEXT_H
#define CLUSTER_RENDER_TEXT_H

#include <stdint.h>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "cluster_render/client.h"

namespace cr {

/* The most glyphs a Text holds, and how many it holds unless told. */
const unsigned kMaxTextGlyphs = 256;
const unsigned kDefaultTextGlyphs = 64;

/* A glyph given to Font::from_glyphs(): a w x h R8 bitmap, its first row
 * top pixels below the line's top, its left bearing and advance. */
struct GlyphBitmap {
    uint32_t code = 0;   /* a Unicode code point */
    unsigned w = 0, h = 0;
    int top = 0, left = 0;
    int advance = -1;   /* negative: its width */
    std::vector<uint8_t> pixels;
};

class Font {
public:
    /* Empty (ok() false) when the line is not 1-2048 high, a glyph's
     * offsets or advance pass 2048, or the glyphs do not fit a 2048 x 2048
     * atlas. sdf: the glyphs are distance fields, their range in pixels
     * each side of the edge (0: coverage). */
    static Font from_glyphs(unsigned line_height, const std::vector<GlyphBitmap> &glyphs,
                            const std::map<std::pair<uint32_t, uint32_t>, int> &kerning = {}, unsigned sdf = 0);
    /* A monospace grid: pixels w x h (R8, or RGBA with bpp 4: its alpha) of
     * cols x rows cells, chars (UTF-8) the characters cell by cell; advance
     * the cells' (0: their width). */
    static Font from_grid(const uint8_t *pixels, unsigned w, unsigned h, unsigned cols, unsigned rows,
                          const std::string &chars, unsigned bpp = 1, unsigned advance = 0);
    /* An AngelCode BMFont: its text .fnt and its one page's pixels (R8, or
     * RGBA with bpp 4: its alpha). Empty for a font of several pages, of
     * glyphs packed in channels, of a glyph outside the page or of a
     * negative xadvance, width or height. */
    static Font from_bmfont(const std::string &fnt, const uint8_t *page, unsigned page_w, unsigned page_h,
                            unsigned bpp = 1, unsigned sdf = 0);

    bool ok() const { return w_ > 0; }
    unsigned width() const { return w_; }
    unsigned height() const { return h_; }
    unsigned line_height() const { return line_; }
    const std::vector<uint8_t> &pixels() const { return px_; }
    /* The table Client::font() takes. */
    FontOptions options() const;
    /* The font and its atlas, an r8 asset on target sampled bilinear,
     * which goes when the font is dropped (Client::font()); the font's ref,
     * 0 when refused here. */
    uint32_t asset(Client &c, const std::string &target) const;
    /* text (UTF-8) in a line h pixels high, spacing pixels between
     * characters: its advance, as the service lays it out; *glyphs the
     * glyphs it draws. */
    float measure(const std::string &text, float h, float spacing, unsigned *glyphs = nullptr) const;

private:
    struct Glyph {
        unsigned x = 0, y = 0, w = 0, h = 0;
        int left = 0, top = 0, advance = 0;
    };
    unsigned w_ = 0, h_ = 0, line_ = 0, sdf_ = 0;
    std::vector<uint8_t> px_;
    std::map<uint32_t, Glyph> glyphs_;
    std::map<std::pair<uint32_t, uint32_t>, int> kerning_;
};

struct TextOptions {
    float color[4] = {1, 1, 1, 1};   /* straight alpha, 0-1 */
    std::string align = "left";      /* left, center or right */
    float spacing = 0;               /* pixels between characters */
    unsigned max_glyphs = kDefaultTextGlyphs;   /* the glyphs it holds: 1 to kMaxTextGlyphs */
};

class Text {
public:
    /* A text layer of lo's rect drawing strings from font, whose ref on the
     * client is font_ref (Font::asset()), a line as high as the rect. ref()
     * 0, nothing sent, when the font is empty, the rect has no width or
     * height, or to.max_glyphs is not 1 to kMaxTextGlyphs. */
    Text(Client &c, std::shared_ptr<const Font> font, uint32_t font_ref, const LayerOptions &lo,
         const TextOptions &to = TextOptions());
    uint32_t ref() const { return ref_; }
    /* The string shown (UTF-8), sent as it is; false when it has more
     * glyphs than the layer holds or is wider than its rect (it is shown
     * cut), or, nothing sent and the last string kept, when it is past
     * kMaxTextBytes or not UTF-8. */
    bool set(const std::string &text);
    void color(const float rgba[4]);
    void drop();

private:
    Client &c_;
    std::shared_ptr<const Font> font_;
    LayerOptions lo_;
    TextOptions to_;
    uint32_t ref_ = 0;
};

}  // namespace cr

#endif
