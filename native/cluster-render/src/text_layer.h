/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Text (PROTOCOL.md "Text"): a client's font, an atlas of glyphs it sent
 * as an r8 asset with a table of where each glyph is and how it advances,
 * and text layers that draw a line of a string from it.
 *
 * The service lays the string out (advances, kerning, spacing, alignment,
 * whole pixels) and draws each glyph as two triangles of its own, sampling
 * the atlas once a pixel: a glyph run in vertex buffers the scene keeps
 * (Graph::glyph_buffer), rewritten in place when the string changes, at
 * most kFps times a second and within the shared upload budget. A string
 * change sends the client's few bytes of JSON; the service writes 64 bytes
 * a glyph into the scene. Nothing is compiled or made per change. */
#ifndef CRS_TEXT_LAYER_H
#define CRS_TEXT_LAYER_H

#include <stdint.h>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "cluster_render/protocol.h"
#include "layer.h"

namespace crs {

/* The text layers' shaders (GLSL ES 1.00): a_position in the quad's unit
 * square, as the unit quad's; a_texcoord in the atlas; u_color straight
 * alpha, drawn premultiplied; u_sdf 0 for a coverage atlas, else the
 * factor sdf_factor() gives for the layer's size and largest scale, which
 * makes a distance atlas's edge a pixel wide on screen. */
extern const char *const kTextVertexShader;
extern const char *const kTextFragmentShader;
/* A distance atlas's in GLSL ES 3.00, for a cluster that draws it: the
 * edge a pixel wide on screen from the sample's screen-space derivatives,
 * whatever the layer's scale or its animations; no u_sdf. */
extern const char *const kTextVertexShader300;
extern const char *const kTextSdfFragmentShader300;

struct FontGlyph {
    uint16_t x = 0, y = 0, w = 0, h = 0;   /* its box in the atlas */
    int16_t left = 0, top = 0;            /* its offset from the pen and the line's top */
    uint16_t advance = 0;
};

/* A font's table: glyphs in an atlas aw x ah, a line `line` atlas pixels
 * high, kerning by (first, second) code point. */
struct Font {
    static const size_t kMaxGlyphs = 1024, kMaxKerning = 4096;
    static const uint32_t kMaxLine = 2048, kMaxSdf = 64;
    uint32_t aw = 0, ah = 0, line = 0;
    /* A distance atlas's range, in atlas pixels each side of the edge
     * (sampled 0.5 on it); 0: a coverage atlas. */
    uint32_t sdf = 0;
    std::map<uint32_t, FontGlyph> glyphs;
    std::map<uint64_t, int16_t> kerning;

    /* Its table's bytes in the service's memory. */
    size_t bytes() const { return glyphs.size() * 40 + kerning.size() * 48 + 64; }
};

/* The font of an atlas aw x ah from a font message's fields: glyphs
 * "code:x,y,w,h,left,top,advance ...", kerning "first,second:amount ...".
 * False with *err for anything out of range: a code point that is not a
 * Unicode scalar value or comes twice, a box outside the atlas, an offset or
 * advance past 2048, more than kMaxGlyphs glyphs or kMaxKerning pairs, a
 * pair of a glyph the font lacks. */
bool parse_font(const std::string &glyphs, const std::string &kerning, uint32_t aw, uint32_t ah, uint32_t line,
                uint32_t sdf, Font *out, std::string *err);

/* s's code points; false when s is not well-formed UTF-8 (overlong,
 * surrogates, past U+10FFFF, cut short). */
bool decode_utf8(const std::string &s, std::vector<uint32_t> *out);

enum class TextAlign { Left, Center, Right };

/* How a text layer draws its string. */
struct TextStyle {
    float size = 0;        /* the line's height in the target's pixels; 0: the layer's height */
    float spacing = 0;     /* pixels between characters */
    TextAlign align = TextAlign::Left;
    float color[4] = {1, 1, 1, 1};   /* straight alpha, 0-1 */
};

/* A glyph laid out: its box in the layer's pixels (from the top-left) and
 * in the atlas (0-1). */
struct GlyphQuad {
    float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    float u0 = 0, v0 = 0, u1 = 0, v1 = 0;
};

/* cps laid out in a layer w x h: the font scaled to the style's size, each
 * glyph's top-left on whole pixels, kerning and spacing between characters,
 * aligned in w by whole pixels, each glyph cut to the layer (its atlas box
 * with it) and left out when nothing of it is inside; *width the line's
 * advance before alignment. A character the font lacks advances by its
 * space, or not at all. */
std::vector<GlyphQuad> lay_out(const Font &f, const std::vector<uint32_t> &cps, const TextStyle &s, uint32_t w,
                               uint32_t h, float *width = nullptr);

/* The glyphs' vertices as Graph::glyphs() takes them: 16 floats a glyph,
 * x, y (the quad's unit square, y up), u, v at its bottom-left,
 * bottom-right, top-left and top-right corners. */
std::vector<float> glyph_vertices(const std::vector<GlyphQuad> &q, uint32_t w, uint32_t h);

/* u_sdf for font drawn with lines size pixels high at scale times that on
 * screen: the factor that turns a distance sample into coverage with a
 * one-pixel edge; 0 for a coverage font. */
float sdf_factor(const Font &f, float size, float scale);

/* A line of text: an effect layer whose quad draws a glyph run from its
 * font's atlas (bound as u_atlas by the compositor). */
class TextLayer : public EffectLayer {
public:
    static const uint32_t kMaxGlyphs = 256;    /* a layer's glyph capacity at most */
    static const uint32_t kDefaultGlyphs = 64;
    static const size_t kMaxTextBytes = cr::kMaxTextBytes;  /* a string's UTF-8 */
    static const uint32_t kFps = 30;           /* glyph writes a second at most */
    /* Bytes a glyph takes in the scene's buffers: four vertices of x, y,
     * u, v floats, and six 16-bit indices. */
    static const size_t kVertexBytes = 64, kIndexBytes = 12;

    /* derivatives: effect is the GLSL ES 3.00 distance shader, which needs
     * no u_sdf. */
    TextLayer(uint32_t id, int target, uint64_t seq, crk::UploadPacer &pacer, int effect,
              std::shared_ptr<const Font> font, uint32_t capacity, bool derivatives, int64_t now_ms);
    const char *kind() const override { return "text"; }

    uint32_t capacity() const { return capacity_; }
    /* Its string, as code points (decode_utf8). Glyphs past the capacity
     * are not drawn. */
    void set_text(std::vector<uint32_t> &&cps);
    const TextStyle &style() const { return style_; }
    void set_style(const TextStyle &s);
    /* What the last write drew: glyphs, and how many the string had to
     * draw (more than the capacity: cut). */
    uint32_t drawn_glyphs() const { return glyphs_drawn_; }

    bool attach(Graph *g, int64_t now_ms, std::string *err) override;
    void place() override;
    Stage stage(int64_t now_ms) override;
    void committed(bool ok, int64_t now_ms) override;
    size_t staged_bytes() const override { return staged_bytes_; }
    int64_t wake_in_ms(int64_t now_ms) const override;
    std::string stats() const override;
    WriteStats write_stats() const override;
    /* The renderer refused a glyph write: the layer is hidden, in error,
     * until the client changes it (a text message, which set_style() takes)
     * or its scene goes; then hidden until its glyphs are written whole. */
    std::string refusal() const override { return refusal_; }
    void arrange(bool drawn, int32_t order) override;
    size_t buffer_bytes() const override { return attached() ? capacity_ * (kVertexBytes + kIndexBytes) : 0; }

private:
    void colour();
    /* u_sdf for the layer's size and its largest scale, set when it
     * changed. */
    void sharpen();

    std::shared_ptr<const Font> font_;
    uint32_t capacity_;
    bool derivatives_;
    std::vector<uint32_t> cps_;
    TextStyle style_;
    crk::FrameClock clock_;
    uint64_t version_ = 1, written_ = 0, staged_version_ = 0;
    Rect laid_;   /* the rect the scene's glyphs were laid out in */
    uint32_t glyphs_drawn_ = 0, pending_drawn_ = 0;
    size_t staged_bytes_ = 0;
    float sdf_ = -1;   /* the u_sdf set */
    std::string refusal_;
    bool stale_ = false;   /* the buffers may hold a refused write's glyphs: hidden */
    uint64_t writes_ = 0, bytes_ = 0, failed_ = 0, holds_ = 0;
};

}  // namespace crs

#endif
