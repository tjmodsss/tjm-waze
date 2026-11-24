/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The text layers' glyph runs (src/text_layer.h) drawn by a GLES 2 context
 * on the host (Mesa's software renderer, through EGL loaded at run time),
 * with the service's own shaders, layout and vertices, blended
 * premultiplied as the layer is: "AV" with kerning that pulls V over A's
 * box, both glyphs hollow, so the pixels the two boxes share show both;
 * colour; a line aligned right and cut at the rect; a distance-field glyph
 * scaled up drawn with a sharper edge than a coverage one. Skipped, and
 * says so, where the host has no EGL; failed instead with CR_REQUIRE_GL set
 * (CI). */
#include <dlfcn.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "text_layer.h"

namespace {

int failures = 0;

void ok(const char *what, bool good)
{
    std::printf("%s %s\n", good ? "ok  " : "FAIL", what);
    failures += !good;
}

typedef void *(*GetProc)(const char *);
GetProc get_proc = nullptr;
bool es3 = false;   /* the context is GLES 3 */

template <typename F> F gl(const char *name) { return (F)get_proc(name); }

/* A surfaceless GLES 2 context, current; false when there is none. */
bool context(std::string *why)
{
    void *egl = dlopen("libEGL.so.1", RTLD_NOW);
    if (!egl) {
        *why = "no libEGL.so.1";
        return false;
    }
    get_proc = (GetProc)dlsym(egl, "eglGetProcAddress");
    typedef void *Display;
    auto platform_display = (Display(*)(unsigned, void *, const int *))get_proc("eglGetPlatformDisplayEXT");
    auto initialize = (unsigned (*)(Display, int *, int *))dlsym(egl, "eglInitialize");
    auto bind_api = (unsigned (*)(unsigned))dlsym(egl, "eglBindAPI");
    auto choose = (unsigned (*)(Display, const int *, void **, int, int *))dlsym(egl, "eglChooseConfig");
    auto create = (void *(*)(Display, void *, void *, const int *))dlsym(egl, "eglCreateContext");
    auto make_current = (unsigned (*)(Display, void *, void *, void *))dlsym(egl, "eglMakeCurrent");
    Display d = platform_display ? platform_display(0x31DD /* EGL_PLATFORM_SURFACELESS_MESA */, nullptr, nullptr)
                                 : nullptr;
    int major = 0, minor = 0;
    if (!d || !initialize || !initialize(d, &major, &minor)) {
        *why = "no surfaceless EGL display";
        return false;
    }
    bind_api(0x30A0 /* EGL_OPENGL_ES_API */);
    const int config_attrs[] = {0x3040 /* EGL_RENDERABLE_TYPE */, 4 /* EGL_OPENGL_ES2_BIT */, 0x3038};
    void *config = nullptr;
    int n = 0;
    choose(d, config_attrs, &config, 1, &n);
    /* GLES 3 where the host has it (it draws GLSL ES 1.00 too), else 2 */
    const int es3_attrs[] = {0x3098 /* EGL_CONTEXT_CLIENT_VERSION */, 3, 0x3038};
    const int es2_attrs[] = {0x3098, 2, 0x3038};
    void *c = create(d, n ? config : nullptr, nullptr, es3_attrs);
    es3 = c != nullptr;
    if (!c)
        c = create(d, n ? config : nullptr, nullptr, es2_attrs);
    if (!c || !make_current(d, nullptr, nullptr, c)) {
        *why = "no GLES 2 context";
        return false;
    }
    return true;
}

const unsigned GL_FRAGMENT_SHADER = 0x8B30, GL_VERTEX_SHADER = 0x8B31, GL_COMPILE_STATUS = 0x8B81,
               GL_LINK_STATUS = 0x8B82, GL_TEXTURE_2D = 0x0DE1, GL_LUMINANCE = 0x1909, GL_RGBA = 0x1908,
               GL_UNSIGNED_BYTE = 0x1401, GL_TEXTURE_MIN_FILTER = 0x2801, GL_TEXTURE_MAG_FILTER = 0x2800,
               GL_TEXTURE_WRAP_S = 0x2802, GL_TEXTURE_WRAP_T = 0x2803, GL_LINEAR = 0x2601,
               GL_CLAMP_TO_EDGE = 0x812F, GL_FRAMEBUFFER = 0x8D40, GL_COLOR_ATTACHMENT0 = 0x8CE0,
               GL_FRAMEBUFFER_COMPLETE = 0x8CD5, GL_COLOR_BUFFER_BIT = 0x4000, GL_FLOAT = 0x1406,
               GL_TRIANGLES = 0x0004, GL_UNPACK_ALIGNMENT = 0x0CF5, GL_PACK_ALIGNMENT = 0x0D05, GL_BLEND = 0x0BE2,
               GL_ONE = 1, GL_ONE_MINUS_SRC_ALPHA = 0x0303, GL_UNSIGNED_SHORT = 0x1403;

unsigned shader(unsigned kind, const char *src)
{
    const unsigned s = gl<unsigned (*)(unsigned)>("glCreateShader")(kind);
    gl<void (*)(unsigned, int, const char *const *, const int *)>("glShaderSource")(s, 1, &src, nullptr);
    gl<void (*)(unsigned)>("glCompileShader")(s);
    int good = 0;
    gl<void (*)(unsigned, unsigned, int *)>("glGetShaderiv")(s, GL_COMPILE_STATUS, &good);
    if (!good) {
        char log[1024] = {};
        gl<void (*)(unsigned, int, int *, char *)>("glGetShaderInfoLog")(s, sizeof log, nullptr, log);
        std::printf("     %s\n", log);
    }
    return good ? s : 0;
}

/* A text program of the service's, linked; 0 when it does not compile. */
unsigned program(const std::string &vs_src, const std::string &fs_src)
{
    const unsigned vs = shader(GL_VERTEX_SHADER, vs_src.c_str());
    const unsigned fs = shader(GL_FRAGMENT_SHADER, fs_src.c_str());
    if (!vs || !fs)
        return 0;
    const unsigned prog = gl<unsigned (*)()>("glCreateProgram")();
    gl<void (*)(unsigned, unsigned)>("glAttachShader")(prog, vs);
    gl<void (*)(unsigned, unsigned)>("glAttachShader")(prog, fs);
    gl<void (*)(unsigned, unsigned, const char *)>("glBindAttribLocation")(prog, 0, "a_position");
    gl<void (*)(unsigned, unsigned, const char *)>("glBindAttribLocation")(prog, 1, "a_texcoord");
    gl<void (*)(unsigned)>("glLinkProgram")(prog);
    int linked = 0;
    gl<void (*)(unsigned, unsigned, int *)>("glGetProgramiv")(prog, GL_LINK_STATUS, &linked);
    return linked ? prog : 0;
}

unsigned texture(int tw, int th, unsigned format, const void *px)
{
    unsigned t = 0;
    gl<void (*)(int, unsigned *)>("glGenTextures")(1, &t);
    gl<void (*)(unsigned, unsigned)>("glBindTexture")(GL_TEXTURE_2D, t);
    gl<void (*)(unsigned, int)>("glPixelStorei")(GL_UNPACK_ALIGNMENT, 1);
    gl<void (*)(unsigned, int, int, int, int, int, unsigned, unsigned, const void *)>("glTexImage2D")(
        GL_TEXTURE_2D, 0, (int)format, tw, th, 0, format, GL_UNSIGNED_BYTE, px);
    auto param = gl<void (*)(unsigned, unsigned, int)>("glTexParameteri");
    param(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    param(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    param(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    param(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    return t;
}

/* An RGBA picture w x h, rows from the top. */
struct Picture {
    int w = 0, h = 0;
    std::vector<uint8_t> px;
    const uint8_t *at(int x, int y) const { return &px[((size_t)y * w + x) * 4]; }
};

/* cps drawn by the service's layout and shaders in a rect w x h from the
 * font's atlas (aw x ah R8), premultiplied over transparent black, the rect
 * scaled by scale on screen (a picture scale times as big); u_sdf as the
 * layer sets it for sdf_scale (0: the scale drawn at); vs and fs the
 * program. */
Picture draw(const crs::Font &f, const std::vector<uint8_t> &atlas, const std::vector<uint32_t> &cps,
             const crs::TextStyle &st, int w, int h, int scale = 1, float sdf_scale = 0,
             const std::string &vs = crs::kTextVertexShader, const std::string &fs = crs::kTextFragmentShader)
{
    Picture pic;
    const unsigned prog = program(vs, fs);
    if (!prog)
        return pic;
    gl<void (*)(unsigned)>("glUseProgram")(prog);
    auto loc = [&](const char *name) { return gl<int (*)(unsigned, const char *)>("glGetUniformLocation")(prog, name); };
    const int lw = w, lh = h;   /* the rect laid out in */
    w *= scale;
    h *= scale;
    const unsigned target = texture(w, h, GL_RGBA, nullptr);
    unsigned fbo = 0;
    gl<void (*)(int, unsigned *)>("glGenFramebuffers")(1, &fbo);
    gl<void (*)(unsigned, unsigned)>("glBindFramebuffer")(GL_FRAMEBUFFER, fbo);
    gl<void (*)(unsigned, unsigned, unsigned, unsigned, int)>("glFramebufferTexture2D")(
        GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, target, 0);
    if (gl<unsigned (*)(unsigned)>("glCheckFramebufferStatus")(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        return pic;
    texture((int)f.aw, (int)f.ah, GL_LUMINANCE, atlas.data());
    /* the unit square onto the viewport, as u_mvp puts it on the rect */
    const float mvp[16] = {2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, -1, -1, 0, 1};
    gl<void (*)(int, int, unsigned char, const float *)>("glUniformMatrix4fv")(loc("u_mvp"), 1, 0, mvp);
    gl<void (*)(int, int)>("glUniform1i")(loc("u_atlas"), 0);
    gl<void (*)(int, int, const float *)>("glUniform4fv")(loc("u_color"), 1, st.color);
    const float size = st.size > 0 ? st.size : (float)lh;
    gl<void (*)(int, float)>("glUniform1f")(loc("u_sdf"),
                                           crs::sdf_factor(f, size, sdf_scale > 0 ? sdf_scale : (float)scale));
    gl<void (*)(int, int, int, int)>("glViewport")(0, 0, w, h);
    gl<void (*)(float, float, float, float)>("glClearColor")(0, 0, 0, 0);
    gl<void (*)(unsigned)>("glClear")(GL_COLOR_BUFFER_BIT);
    gl<void (*)(unsigned)>("glEnable")(GL_BLEND);
    gl<void (*)(unsigned, unsigned)>("glBlendFunc")(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    const std::vector<crs::GlyphQuad> q = crs::lay_out(f, cps, st, (uint32_t)lw, (uint32_t)lh);
    const std::vector<float> v = crs::glyph_vertices(q, (uint32_t)lw, (uint32_t)lh);
    std::vector<uint16_t> idx;
    for (size_t i = 0; i < q.size(); i++) {
        const uint16_t b = (uint16_t)(i * 4);
        for (uint16_t k : {b, (uint16_t)(b + 1), (uint16_t)(b + 2), (uint16_t)(b + 2), (uint16_t)(b + 1),
                           (uint16_t)(b + 3)})
            idx.push_back(k);
    }
    auto attrib = gl<void (*)(unsigned, int, unsigned, unsigned char, int, const void *)>("glVertexAttribPointer");
    if (!v.empty()) {
        attrib(0, 2, GL_FLOAT, 0, 16, v.data());
        attrib(1, 2, GL_FLOAT, 0, 16, v.data() + 2);
    }
    gl<void (*)(unsigned)>("glEnableVertexAttribArray")(0);
    gl<void (*)(unsigned)>("glEnableVertexAttribArray")(1);
    if (!idx.empty())
        gl<void (*)(unsigned, int, unsigned, const void *)>("glDrawElements")(GL_TRIANGLES, (int)idx.size(),
                                                                             GL_UNSIGNED_SHORT, idx.data());
    std::vector<uint8_t> px((size_t)w * h * 4);
    gl<void (*)(unsigned, int)>("glPixelStorei")(GL_PACK_ALIGNMENT, 1);
    gl<void (*)(int, int, int, int, unsigned, unsigned, void *)>("glReadPixels")(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE,
                                                                                  px.data());
    pic.w = w;
    pic.h = h;
    pic.px.resize(px.size());
    for (int y = 0; y < h; y++)   /* GL's rows from the bottom */
        std::memcpy(&pic.px[(size_t)y * w * 4], &px[(size_t)(h - 1 - y) * w * 4], (size_t)w * 4);
    return pic;
}

/* A font of glyphs gw x gh each in one row of an atlas, a column of 0
 * between them; its atlas into *atlas. */
crs::Font font_of(const std::vector<std::pair<uint32_t, std::vector<uint8_t>>> &glyphs, unsigned gw, unsigned gh,
                  int advance, const std::string &kerning, unsigned sdf, std::vector<uint8_t> *atlas)
{
    const unsigned aw = 1 + (gw + 1) * (unsigned)glyphs.size(), ah = gh + 2;
    atlas->assign((size_t)aw * ah, 0);
    std::string table;
    for (size_t i = 0; i < glyphs.size(); i++) {
        const unsigned x = 1 + (gw + 1) * (unsigned)i;
        for (unsigned y = 0; y < gh; y++)
            std::memcpy(&(*atlas)[(size_t)(y + 1) * aw + x], &glyphs[i].second[(size_t)y * gw], gw);
        table += (table.empty() ? "" : " ") + std::to_string(glyphs[i].first) + ":" + std::to_string(x) + ",1," +
                 std::to_string(gw) + "," + std::to_string(gh) + ",0,0," + std::to_string(advance);
    }
    crs::Font f;
    std::string err;
    if (!crs::parse_font(table, kerning, aw, ah, gh, sdf, &f, &err))
        std::printf("     font: %s\n", err.c_str());
    return f;
}

}  // namespace

int main()
{
    std::string why;
    if (!context(&why)) {
        if (std::getenv("CR_REQUIRE_GL")) {
            std::printf("FAIL text GL: %s, and CR_REQUIRE_GL is set\n", why.c_str());
            return 1;
        }
        std::printf("skip text_gl_check: %s: the text shaders are not drawn on this host\n", why.c_str());
        return 0;
    }
    /* A and V: 6 x 8, their outer columns lit, hollow between; V kerned 2
     * pixels over A, so A's right column (x 5) lies in V's box, over V's
     * unlit second column, and V's left column (x 4) in A's. */
    std::vector<uint8_t> hollow(48, 0);
    for (int y = 0; y < 8; y++)
        hollow[y * 6] = hollow[y * 6 + 5] = 255;
    std::vector<uint8_t> atlas;
    const crs::Font av = font_of({{'A', hollow}, {'V', hollow}}, 6, 8, 6, "65,86:-2", 0, &atlas);
    crs::TextStyle st;
    const Picture pic = draw(av, atlas, {'A', 'V'}, st, 16, 8);
    ok("text GL: the service's shaders compiled, linked and drawn", pic.w == 16);
    if (pic.w == 16) {
        std::printf("     alpha by pixel:");
        for (int x = 0; x < 16; x++)
            std::printf(" %d", pic.at(x, 4)[3]);
        std::printf("\n");
        ok("text GL: A's columns and V's lit, the two kerned into each other's boxes both shown",
           pic.at(0, 4)[3] > 250 && pic.at(5, 4)[3] > 250 && pic.at(4, 4)[3] > 250 && pic.at(9, 4)[3] > 250);
        ok("text GL: hollow between, nothing past the text",
           pic.at(2, 4)[3] < 5 && pic.at(7, 4)[3] < 5 && pic.at(12, 4)[3] < 5 && pic.at(15, 4)[3] == 0);
        ok("text GL: white, premultiplied", pic.at(0, 4)[0] > 250 && pic.at(2, 4)[0] < 5);
    }
    /* Half-transparent red, right-aligned in 10: "AV" is 10 wide (6 + 6 -
     * 2), so it fills the rect; three of them cut at its left edge. */
    st.color[1] = st.color[2] = 0;
    st.color[3] = 0.5f;
    st.align = crs::TextAlign::Right;
    const Picture red = draw(av, atlas, {'A', 'V', 'A', 'V'}, st, 10, 8);
    ok("text GL: red at half alpha, premultiplied: 128 red, 128 alpha",
       red.w == 10 && std::abs(red.at(9, 4)[0] - 128) <= 2 && std::abs(red.at(9, 4)[3] - 128) <= 2 &&
           red.at(9, 4)[1] == 0);
    ok("text GL: aligned right, cut at the left: the last V's right column at the edge, the first A gone",
       red.w == 10 && red.at(9, 4)[3] > 120 && red.at(4, 4)[3] > 120 && red.at(2, 4)[3] < 5);

    /* One 32 x 32 disc scaled 4 times: as coverage its edge is a ramp 4
     * pixels wide, as a distance field (8 pixels each side) a pixel or two. */
    std::vector<uint8_t> cover(32 * 32), dist(32 * 32);
    for (int y = 0; y < 32; y++)
        for (int x = 0; x < 32; x++) {
            const float d = 12.0f - std::sqrt((x + 0.5f - 16) * (x + 0.5f - 16) + (y + 0.5f - 16) * (y + 0.5f - 16));
            cover[y * 32 + x] = (uint8_t)std::lround(255 * std::max(0.0f, std::min(1.0f, d + 0.5f)));
            dist[y * 32 + x] = (uint8_t)std::lround(255 * std::max(0.0f, std::min(1.0f, 0.5f + d / 16)));
        }
    std::vector<uint8_t> catlas, datlas;
    const crs::Font cf = font_of({{'o', cover}}, 32, 32, 32, "", 0, &catlas);
    const crs::Font df = font_of({{'o', dist}}, 32, 32, 32, "", 8, &datlas);
    crs::TextStyle big;
    const Picture soft = draw(cf, catlas, {'o'}, big, 128, 128), sharp = draw(df, datlas, {'o'}, big, 128, 128);
    auto ramp = [](const Picture &p) {
        int n = 0;
        for (int x = 0; x < p.w; x++)
            n += p.at(x, 64)[3] > 12 && p.at(x, 64)[3] < 243;
        return n;
    };
    std::printf("     edge pixels across the middle row: coverage %d, distance field %d\n", ramp(soft), ramp(sharp));
    ok("text GL: a distance-field glyph scaled up keeps a sharp edge, a coverage one does not",
       soft.w == 128 && sharp.w == 128 && ramp(sharp) <= 4 && ramp(soft) >= 6 && sharp.at(64, 64)[3] > 250 &&
           sharp.at(2, 64)[3] == 0);
    /* The same glyph in a 32 x 32 layer at sx = sy = 4: its edge a pixel or
     * two on screen from u_sdf for the layer's scale, and from the GLSL ES
     * 3.00 shader's derivatives, which take no u_sdf; u_sdf for the layer's
     * own size would leave it 4 pixels wide. */
    crs::TextStyle small;
    const Picture fallback = draw(df, datlas, {'o'}, small, 32, 32, 4, 4);
    const Picture unscaled = draw(df, datlas, {'o'}, small, 32, 32, 4, 1);
    std::printf("     edge pixels at 4x scale: scaled u_sdf %d, unscaled u_sdf %d\n", ramp(fallback), ramp(unscaled));
    ok("text GL: a distance-field glyph in a layer scaled 4x sharp from u_sdf for its scale",
       fallback.w == 128 && ramp(fallback) <= 4 && ramp(unscaled) >= 6 && fallback.at(64, 64)[3] > 250);
    if (es3) {
        const Picture deriv =
            draw(df, datlas, {'o'}, small, 32, 32, 4, 1, crs::kTextVertexShader300, crs::kTextSdfFragmentShader300);
        std::printf("     edge pixels at 4x scale from derivatives (GLSL ES 3.00): %d\n", ramp(deriv));
        ok("text GL: the same from the GLSL ES 3.00 shader's derivatives",
           deriv.w == 128 && ramp(deriv) <= 4 && deriv.at(64, 64)[3] > 250 && deriv.at(2, 64)[3] == 0);
    } else {
        ok("text GL: a GLES 3 context for the GLSL ES 3.00 shader (CR_REQUIRE_GL)", !std::getenv("CR_REQUIRE_GL"));
        std::printf("skip the GLSL ES 3.00 distance shader: no GLES 3 context\n");
    }
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
