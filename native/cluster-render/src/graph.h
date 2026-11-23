/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The renderer as the layers see it: quads drawn by effects, persistent
 * texture buffers written in place, uniforms, 3D views of meshes, animations
 * the renderer plays by itself, and one flush that carries a tick's changes.
 * All content the service draws is built from these, or is a scene file a
 * client has it load whole (FileScene), so a display generation
 * is one implementation of Gpu and Graph: graph_ramses19.cpp for iDrive 7
 * (RAMSES 19, the KOMBI's renderer), graph_ramses27.cpp for iDrive 8
 * (RAMSES 27, the cluster's; README.md "iDrive 8").
 *
 * Coordinates are the target's pixels from its top-left corner. A buffer is
 * written in rectangles of tightly packed rows. Every handle is a positive
 * int, unique within its Graph across every kind of object; 0 means refused.
 * Nothing a call changes is shown before flush(). */
#ifndef CRS_GRAPH_H
#define CRS_GRAPH_H

#include <stddef.h>
#include <stdint.h>
#include <memory>
#include <string>
#include <vector>

#include "slots.h"

namespace crs {

struct Rect {
    int32_t x = 0, y = 0;
    uint32_t w = 0, h = 0;
};
inline bool operator==(const Rect &a, const Rect &b) { return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h; }
inline bool operator!=(const Rect &a, const Rect &b) { return !(a == b); }

/* The compressed formats are an immutable_texture(), never a buffer():
 * ETC2RGBA, ETC2 colour with EAC alpha, 16 bytes a 4x4 block
 * (GL_COMPRESSED_RGBA8_ETC2_EAC); ETC2RGB, opaque ETC2 colour, 8 bytes a
 * 4x4 block (GL_COMPRESSED_RGB8_ETC2).
 *
 * The renderers take both (VERIFIED, static): MGU's libramses 19 maps
 * public ETextureFormat_ETC2RGB (10) / ETC2RGBA (11) to internal 14 / 15
 * (table 0x6a1620), and the KOMBI's GL format switch (0x2e2130b) uploads
 * them as GL_COMPRESSED_RGB8_ETC2 / GL_COMPRESSED_RGBA8_ETC2_EAC (cases
 * 0x2e2188f / 0x2e218b9) with glCompressedTexSubImage2D (0x2e1d161).
 * iDrive 8's libramses 27 maps public ETC2RGB (8) / ETC2RGBA (9) to internal
 * 12 / 13 (table 0x68be80) and the library's renderer uploads them the same
 * way (cases 0x526a30 / 0x526a10); iDrive 8's cluster firmware is not
 * checked. Neither library checks the data's size for
 * them (19: 0x123c00), so tex_bytes() must be exact. */
enum class TexFormat { R8, RGBA8, ETC2RGBA, ETC2RGB };
inline bool tex_compressed(TexFormat f) { return f == TexFormat::ETC2RGBA || f == TexFormat::ETC2RGB; }
/* Its name in the protocol. */
inline const char *tex_format_name(TexFormat f)
{
    switch (f) {
    case TexFormat::R8: return "r8";
    case TexFormat::ETC2RGBA: return "etc2rgba";
    case TexFormat::ETC2RGB: return "etc2rgb";
    default: return "rgba8";
    }
}
/* Bytes of a w x h texture of format f (compressed: w and h multiples of 4). */
inline size_t tex_bytes(TexFormat f, uint32_t w, uint32_t h)
{
    if (tex_compressed(f))
        return (size_t)(w / 4) * (h / 4) * (f == TexFormat::ETC2RGB ? 8 : 16);
    return (size_t)w * h * (f == TexFormat::R8 ? 1 : 4);
}
/* How a texture is sampled: nearest or bilinear within its picture, or from
 * its mip levels (Mips: the nearest level; Trilinear: between two), or
 * linear one way and nearest the other (minified, magnified). */
enum class Sampling {
    Nearest,
    Bilinear,
    NearestMips,
    BilinearMips,
    Trilinear,
    MinLinearMagNearest,
    MinNearestMagLinear
};
inline bool sampling_mips(Sampling s)
{
    return s == Sampling::NearestMips || s == Sampling::BilinearMips || s == Sampling::Trilinear;
}
enum class Wrap { Clamp, Repeat, Mirror };
/* A texture's sampler: its sampling, its wrap along u and v, and its
 * anisotropy (1: isotropic; up to 16, as far as the display's GPU goes). */
struct Sampler {
    Sampling sampling = Sampling::Nearest;
    Wrap u = Wrap::Clamp, v = Wrap::Clamp;
    uint32_t anisotropy = 1;
};
inline bool operator==(const Sampler &a, const Sampler &b)
{
    return a.sampling == b.sampling && a.u == b.u && a.v == b.v && a.anisotropy == b.anisotropy;
}
/* What buffer(f, w, h, Sampling, Wrap) takes: nearest or bilinear, one wrap
 * for both axes, isotropic. */
inline bool sampler_plain(const Sampler &s)
{
    return (s.sampling == Sampling::Nearest || s.sampling == Sampling::Bilinear) && s.u == s.v &&
           s.u != Wrap::Mirror && s.anisotropy == 1;
}

/* Mip levels: level l of a w x h texture is max(1, w >> l) x max(1, h >> l),
 * down to 1x1 (mip_levels() of them in all). A compressed texture's go down
 * to the last level whose sides are both multiples of 4 (mip_levels(f, w,
 * h)): RAMSES 27 warns that a smaller ETC2 level may fail to upload
 * (VERIFIED, make test-ramses27). A shorter chain samples whole because the
 * renderers allocate a texture with exactly the levels given, as immutable
 * GLES 3 storage, whose levels past those given do not count:
 * - RAMSES 27.0.116 (its source): Device_GL::allocateTexture2D takes
 *   glTexStorage2D(target, mipLevelCount, ...), compressed levels go by
 *   glCompressedTexSubImage2D; glTexImage2D only for stream textures, and
 *   GL_TEXTURE_MAX_LEVEL is never set.
 * - The head unit's RAMSES 19 (its binary, ../abi/ABI.md): the same calls
 *   (four glTexStorage2D sites, compressed uploads only by
 *   glCompressedTexSubImage2D, one glTexImage2D at level 0, no 0x813D), and
 *   a 64x32 etc2rgba chain stopping at 8x4, sampled trilinear, drawn by its
 *   renderer with each level's colour at its size (VERIFIED by running).
 * The KOMBI's own renderer build is not checked (only a car can). */
inline uint32_t mip_levels(uint32_t w, uint32_t h)
{
    uint32_t n = 1;
    for (uint32_t d = w > h ? w : h; d > 1; d >>= 1)
        n++;
    return n;
}
inline uint32_t mip_levels(TexFormat f, uint32_t w, uint32_t h)
{
    if (!tex_compressed(f))
        return mip_levels(w, h);
    uint32_t n = 1;
    while (n < 32 && (w >> n) && (h >> n) && (w >> n) % 4 == 0 && (h >> n) % 4 == 0)
        n++;
    return n;
}
inline uint32_t mip_size(uint32_t d, uint32_t level) { return d >> level ? d >> level : 1; }
inline size_t tex_level_bytes(TexFormat f, uint32_t w, uint32_t h, uint32_t level)
{
    return tex_bytes(f, mip_size(w, level), mip_size(h, level));
}
/* Bytes of levels 0 to levels - 1, one after another. */
inline size_t tex_chain_bytes(TexFormat f, uint32_t w, uint32_t h, uint32_t levels)
{
    size_t n = 0;
    for (uint32_t l = 0; l < levels; l++)
        n += tex_level_bytes(f, w, h, l);
    return n;
}

enum class UniformType { Float, Vec2, Vec3, Vec4, Mat4 };
/* Floats in one element of t (a mat4 is 16, in GLSL's column order). */
inline uint32_t uniform_width(UniformType t)
{
    switch (t) {
    case UniformType::Vec2: return 2;
    case UniformType::Vec3: return 3;
    case UniformType::Vec4: return 4;
    case UniformType::Mat4: return 16;
    default: return 1;
    }
}

/* How a quad turns and scales about its pivot: degrees clockwise on screen,
 * scale factors, the pivot in pixels from the quad's top-left. */
struct Turn {
    float rotate = 0;
    float sx = 1, sy = 1;
    float px = 0, py = 0;
};

/* A 3D view's projection, its aspect that of the view's rect: perspective
 * over fov degrees vertically, or orthographic over ortho_h units. */
struct Projection {
    bool ortho = false;
    float fov = 30, ortho_h = 2;
    float near = 0.1f, far = 100;
};

/* A node's place in its view: translation, rotation about x, y and z in
 * degrees (right-handed: positive turns counter-clockwise seen from the
 * axis's positive end), scale. A camera looks down its -z. */
struct Pose {
    float t[3] = {0, 0, 0};
    float r[3] = {0, 0, 0};
    float s[3] = {1, 1, 1};
};

enum class Cull { None, Back, Front };
/* Blending presets: Alpha, source alpha over what is below; Add, added at
 * source alpha; None, replaced; Premultiplied, a colour already multiplied
 * by its alpha over what is below; Max and Min, the larger or smaller of
 * each channel; Subtract, taken away at source alpha. */
enum class Blend { Alpha, Add, None, Premultiplied, Max, Min, Subtract };
/* The blend factors and operations every display takes (RAMSES 19 has no
 * colour or constant factors). */
enum class BlendFactor { Zero, One, SrcAlpha, OneMinusSrcAlpha, DstAlpha, OneMinusDstAlpha };
enum class BlendOp { Add, Subtract, ReverseSubtract, Min, Max };
/* colour = op(src * colour_src, dst * colour_dst), and alpha the same with
 * the alpha factors and op; off: written over what is below. */
struct BlendState {
    bool on = true;
    BlendFactor src = BlendFactor::SrcAlpha, dst = BlendFactor::OneMinusSrcAlpha;
    BlendFactor src_alpha = BlendFactor::One, dst_alpha = BlendFactor::OneMinusSrcAlpha;
    BlendOp op = BlendOp::Add, op_alpha = BlendOp::Add;
};
inline bool operator==(const BlendState &a, const BlendState &b)
{
    return a.on == b.on && (!a.on || (a.src == b.src && a.dst == b.dst && a.src_alpha == b.src_alpha &&
                                      a.dst_alpha == b.dst_alpha && a.op == b.op && a.op_alpha == b.op_alpha));
}
inline BlendState blend_state(Blend b)
{
    BlendState s;
    switch (b) {
    case Blend::Add: s.dst = BlendFactor::One; break;
    case Blend::None: s.on = false; break;
    case Blend::Premultiplied: s.src = BlendFactor::One; break;
    case Blend::Max:
    case Blend::Min:
        s.src = s.dst = s.src_alpha = s.dst_alpha = BlendFactor::One;
        s.op = s.op_alpha = b == Blend::Max ? BlendOp::Max : BlendOp::Min;
        break;
    case Blend::Subtract:
        s.dst = BlendFactor::One;
        s.op = BlendOp::ReverseSubtract;
        break;
    default: break;
    }
    return s;
}
/* Depth tests; Off: neither tested nor written. */
enum class DepthFunc { Off, Less, LessEqual, Equal, NotEqual, Greater, GreaterEqual, Always, Never };
/* Stencil tests and operations; a part or quad tests the stencil only in
 * a canvas with a depth-stencil buffer (its own, never the display's). */
enum class StencilFunc { Off, Never, Always, Equal, NotEqual, Less, LessEqual, Greater, GreaterEqual };
enum class StencilOp { Keep, Zero, Replace, Increment, IncrementWrap, Decrement, DecrementWrap, Invert };
struct StencilState {
    StencilFunc func = StencilFunc::Off;
    uint8_t ref = 0, mask = 0xff;
    StencilOp fail = StencilOp::Keep, depth_fail = StencilOp::Keep, pass = StencilOp::Keep;
};
/* Every field, also while off: fields set while the stencil is off are kept
 * for when stencil_func turns it on. */
inline bool operator==(const StencilState &a, const StencilState &b)
{
    return a.func == b.func && a.ref == b.ref && a.mask == b.mask && a.fail == b.fail &&
           a.depth_fail == b.depth_fail && a.pass == b.pass;
}
/* Colour channels written, as bits. */
const uint8_t kMaskR = 1, kMaskG = 2, kMaskB = 4, kMaskA = 8, kMaskRGBA = 15;
/* How a part (or a quad, with style()) is drawn: depth tested with
 * depth_func and written when depth_write (depth false: neither), which
 * faces are culled, how it blends over what is below (the blend preset, or
 * custom when has_custom), and the colour channels it writes. */
struct PartLook {
    bool depth = true;
    DepthFunc depth_func = DepthFunc::LessEqual;
    bool depth_write = true;
    Cull cull = Cull::Back;
    Blend blend = Blend::Alpha;
    bool has_custom = false;
    BlendState custom;
    uint8_t color_mask = kMaskRGBA;
    StencilState stencil;

    BlendState blending() const { return has_custom ? custom : blend_state(blend); }
    DepthFunc depth_test() const { return depth ? depth_func : DepthFunc::Off; }
    bool depth_writes() const { return depth && depth_write; }
};
inline bool operator==(const PartLook &a, const PartLook &b)
{
    return a.depth_test() == b.depth_test() && a.depth_writes() == b.depth_writes() && a.cull == b.cull &&
           a.blending() == b.blending() && a.color_mask == b.color_mask && a.stencil == b.stencil;
}
inline bool operator!=(const PartLook &a, const PartLook &b) { return !(a == b); }
/* A quad's look unless styled: blended at source alpha, no depth, no
 * culling, every channel. */
inline PartLook quad_look()
{
    PartLook l;
    l.depth = false;
    l.cull = Cull::None;
    return l;
}

/* Vertex attributes, as bits of a mask: what a part's geometry carries and
 * what its vertex shader reads (a_position, a_normal, a_texcoord, a_color). */
const unsigned kAttrNormal = 1, kAttrTexcoord = 2, kAttrColor = 4, kAttrPosition = 8;

/* A part's vertices and triangles. Positions and normals are xyz, texture
 * coordinates uv, colours rgba, one per vertex; an attribute it lacks is
 * null. */
struct Geometry {
    uint32_t vertices = 0, indices = 0;
    const float *position = nullptr, *normal = nullptr, *texcoord = nullptr, *color = nullptr;
    const uint16_t *index = nullptr;
};

enum class Animated { Rotate, Translate, Scale, Uniform };
/* Keys the renderer interpolates by itself: width floats a key, at times in
 * milliseconds from the start, ascending. */
struct Animation {
    Animated property = Animated::Rotate;
    std::string uniform;   /* property Uniform */
    uint32_t width = 1;
    bool loop = false;     /* from the first key again after the last */
    bool step = false;     /* each key's value held until the next */
    std::vector<uint32_t> t;
    std::vector<float> v;
};

/* An off-screen canvas (Graph::canvas): w x h RGBA8 the scene's own passes
 * draw into before the target's, with a depth-stencil buffer when depth,
 * cleared to clear (RGBA) at the start of each frame it is drawn, and
 * sampled through sampler (no mipmaps). once: drawn once, and again only
 * on redraw(). */
struct CanvasSpec {
    uint32_t w = 0, h = 0;
    bool depth = false;
    float clear[4] = {0, 0, 0, 0};
    Sampler sampler;
    bool once = false;
};

/* Canvases' render orders (Graph::canvas): a block of kCanvasSpan each,
 * from kCanvasBase up, kCanvasSlots blocks, below every render order of a
 * target's own passes (a scene file's layers_order is at least
 * kLowestLayersOrder). */
const int32_t kCanvasBase = -1000000000, kCanvasSpan = 4096, kCanvasSlots = 64;
const int32_t kLowestLayersOrder = kCanvasBase + kCanvasSlots * kCanvasSpan;

/* A canvas as the library holds it (Graph::read_canvas, for tests): its
 * buffers' formats, types and access modes as the library's enums give
 * them (-1: no such buffer), whether its copy pass writes alpha unblended,
 * and the render order of its first pass and its copy pass. */
struct CanvasReadback {
    int color_format = -1, color_type = -1, color_access = -1;
    int shown_format = -1, shown_type = -1, shown_access = -1;
    int depth_format = -1, depth_type = -1, depth_access = -1;
    bool copy_writes_alpha = false, copy_blends = true, enabled = false;
    int32_t first_order = 0, copy_order = 0;
};

/* One target's scene. */
class Graph {
public:
    virtual ~Graph() {}
    /* A persistent texture buffer and its sampler (clamped). */
    virtual int buffer(TexFormat f, uint32_t w, uint32_t h, Sampling s) = 0;
    /* Likewise, with the sampler's wrap. */
    virtual int buffer(TexFormat f, uint32_t w, uint32_t h, Sampling s, Wrap wrap) = 0;
    virtual bool write(int buf, uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint8_t *px) = 0;
    /* A persistent texture buffer of levels mip levels (1 to
     * mip_levels(w, h)) and its sampler s. write() writes level 0,
     * write_level() any. 0 where the backend has no such sampler. */
    virtual int buffer(TexFormat f, uint32_t w, uint32_t h, const Sampler &s, uint32_t levels)
    {
        return levels == 1 && sampler_plain(s) ? buffer(f, w, h, s.sampling, s.u) : 0;
    }
    virtual bool write_level(int buf, uint32_t level, uint32_t x, uint32_t y, uint32_t w, uint32_t h,
                             const uint8_t *px)
    {
        return level == 0 && write(buf, x, y, w, h, px);
    }
    /* An immutable texture of levels mip levels, data their n bytes one
     * level after another (tex_chain_bytes), and its sampler, handled as a
     * buffer (texture(), drop_buffer()) but never written. Only a compressed
     * format, only where the backend takes it: 0 otherwise. */
    virtual int immutable_texture(TexFormat, uint32_t, uint32_t, const Sampler &, uint32_t, const uint8_t *, size_t)
    {
        return 0;
    }
    /* A quad over r drawn by effect, hidden until show(). Blended over what
     * is below (source alpha), no depth test. */
    virtual int quad(int effect, const Rect &r) = 0;
    virtual bool place(int quad, const Rect &r) = 0;
    /* Turns and scales the quad within its rect's place. */
    virtual bool turn(int quad, const Turn &t) = 0;
    /* Draws the quad with look's blending and colour mask (its depth and
     * culling are not used: a quad tests no depth and culls nothing). False
     * where the backend has no such state. */
    virtual bool style(int, const PartLook &) { return false; }
    /* texture(), uniform() and uniform_array() take a quad or a part. */
    virtual bool texture(int quad, const char *uniform, int buf) = 0;
    /* A float, vec2, vec3 or vec4 uniform (n 1-4). */
    virtual bool uniform(int quad, const char *name, const float *v, int n) = 0;
    /* elements values of type t: an array uniform, or one value. */
    virtual bool uniform_array(int quad, const char *name, UniformType t, const float *v, uint32_t elements) = 0;
    /* show(), order() and place() take a quad or a view. */
    virtual bool show(int quad, bool on) = 0;
    /* Draw order within the scene: higher is drawn later, on top. Quads and
     * views share it; a view drawn between quads splits them into separate
     * passes when the backend needs that, so the order holds exactly. */
    virtual bool order(int quad, int32_t order) = 0;
    virtual void drop_quad(int quad) = 0;
    virtual void drop_buffer(int buf) = 0;

    /* A 3D view over r with its own camera, drawn in a pass of its own that
     * clears depth (when a part tests it), never colour. Hidden until
     * show(). */
    virtual int view(const Rect &r, const Projection &p, const Pose &camera) = 0;
    virtual bool camera(int view, const Projection &p, const Pose &camera) = 0;
    virtual void drop_view(int view) = 0;
    /* A part of the view drawn by effect, at the identity pose; drawn once
     * it has geometry. */
    virtual int part(int view, int effect, const PartLook &look) = 0;
    /* Replaces the part's geometry: immutable resources, made once a call.
     * False when the effect reads an attribute g lacks. */
    virtual bool geometry(int part, const Geometry &g) = 0;
    virtual bool pose(int part, const Pose &p) = 0;
    virtual void drop_part(int part) = 0;

    /* Plays a by the renderer, nothing sent per frame, on:
     * - a quad: Rotate 1 value (degrees clockwise about its pivot), Translate
     *   3 (pixels right, down, out, from its place), Scale 3 (about its
     *   pivot);
     * - a part: Rotate, Translate, Scale 3 values, as pose();
     * - a view's camera: Rotate, Translate 3 values, as camera();
     * - the uniform of a quad or a part: 1, 3 or 4 values (float, vec3,
     *   vec4).
     * Returns the animation's handle, 0 when refused. A stopped animation
     * leaves its property at its last value; dropping its node stops it. */
    virtual int animate(int node, const Animation &a) = 0;
    virtual void stop(int anim) = 0;

    /* Sends everything changed since the last flush as one update, tagged. */
    virtual bool flush(uint64_t tag) = 0;

    /* A canvas: its handle is a buffer handle too (texture(), not
     * drop_buffer()). 0 where the backend has none. Quads and views drawn
     * into it come from quad_in() and view_in(), and are ordered among
     * themselves (order()) in passes of the canvas's own, its first clearing
     * it; a canvas's passes go before the target's and before a canvas made
     * later. Canvas 0 is the target itself. drop_canvas() takes a canvas
     * whose quads and views are dropped. */
    virtual int canvas(const CanvasSpec &) { return 0; }
    virtual void drop_canvas(int) {}
    virtual bool redraw(int) { return false; }
    /* A canvas not drawn once: drawn each frame while enabled (as it is
     * made), not drawn at all while not, keeping its last picture. */
    virtual bool enable_canvas(int, bool) { return false; }
    /* What the library holds for the canvas; false where it cannot say. */
    virtual bool read_canvas(int, CanvasReadback *) const { return false; }
    virtual int quad_in(int canvas, int effect, const Rect &r) { return canvas ? 0 : quad(effect, r); }
    virtual int view_in(int canvas, const Rect &r, const Projection &p, const Pose &camera)
    {
        return canvas ? 0 : view(r, p, camera);
    }
};

/* A target's scene loaded from a scene file (Gpu::load): drawn as the file
 * has it, with its own cameras and passes, its objects changed by name
 * (scene_edit.h). objects() lists each kind's names; an object's handle is
 * its place in that list, valid while the scene is. Nothing a call changes
 * is shown before flush(). */
class FileScene {
public:
    enum Kind { Node, Mesh, Camera, Pass, kKinds };
    enum Transform { Translation, Scaling, Rotation };
    virtual ~FileScene() {}
    virtual std::vector<std::string> objects(Kind k) = 0;
    /* The node and every node under it. */
    virtual bool visible(int node, bool on) = 0;
    /* Rotation in degrees, about x, y and z as the scene's own nodes turn. */
    virtual bool transform(int node, Transform what, const float v[3]) = 0;
    /* x, y, w, h in pixels from the bottom-left, as the file's own. */
    virtual bool viewport(int camera, const uint32_t v[4]) = 0;
    virtual bool enable(int pass, bool on) = 0;
    /* The uniform called name of the mesh's appearance: as many whole
     * elements of v as it takes, ints rounded. False with *why: the mesh has
     * no such uniform, it is bound to a data object, or v is too short. */
    virtual bool uniform(int mesh, const std::string &name, const std::vector<float> &v, std::string *why) = 0;
    /* The data object called name: 1 to 4 values, as its type takes. */
    virtual bool data(const std::string &name, const std::vector<float> &v, std::string *why) = 0;
    virtual bool flush(uint64_t tag) = 0;
    /* A Graph that draws in this scene, over the file (PROTOCOL.md "Layers
     * over a scene file"): a camera and passes of its own, which never clear,
     * at render orders from *order up, one a pass; null order: from one past
     * the file's highest. Its flush() flushes this scene, edits included. It
     * borrows the scene: it goes after this FileScene, never before. Null
     * with *err where the backend draws nothing over a file. */
    virtual std::unique_ptr<Graph> layers(const int32_t *, std::string *err)
    {
        *err = "this display draws no layers over scene files";
        return nullptr;
    }
};

/* The participant: effects (shared by every scene) and the scenes. */
class Gpu {
public:
    virtual ~Gpu() {}
    /* The target's scene loaded from a scene file and its resource files
     * (real paths, checked: scene_file.h), flushed and published; null with
     * *err when it does not load or its scene id is not the target's. */
    virtual std::unique_ptr<FileScene> load(const TargetSpec &, const std::string &,
                                            const std::vector<std::string> &, std::string *err)
    {
        *err = "this display takes no scene files";
        return nullptr;
    }
    /* Compiles an effect: GLSL ES 1.00 (the HMI's own effects are). The
     * renderer fills these uniforms where a shader declares them: u_mvp,
     * u_mv, u_m, u_v, u_p (mat4: model-view-projection, model-view, model,
     * view, projection) and u_normal (mat4: the inverse transpose of u_mv).
     * A quad's vertex shader gets a_position (the unit quad, 0-1); the
     * service's default one passes v_uv with v = 0 at the quad's top. */
    virtual int effect(const char *vs, const char *fs, std::string *err) = 0;
    virtual void drop_effect(int effect) = 0;
    /* The vertex attributes the effect reads (kAttr* bits). */
    virtual unsigned attributes(int effect) const = 0;
    /* The target's scene, empty, flushed and published. */
    virtual std::unique_ptr<Graph> scene(const TargetSpec &t, std::string *err) = 0;
};

/* The default vertex shader: a_position over the quad, v_uv from its
 * top-left. */
extern const char *const kQuadVertexShader;

/* The render passes a backend with ordered passes draws the scene in: each
 * view in a pass of its own, and the quads between two views sharing one.
 * views lists, for the scene's quads and views sorted by draw order, which
 * are views; returns each one's pass, 0 the first, in render order. */
std::vector<int> plan_passes(const std::vector<bool> &views);

}  // namespace crs

#endif
