/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Runs the compositor on the unit's own libramses (TCP, no renderer) with a
 * display port that grants every request: every layer kind's objects,
 * shaders (compiled by the library's glslang), buffer writes, uniforms,
 * draw-order changes, an exclusive layer, removals and a scene published
 * again must be accepted, with nothing logged as an error by this service
 * or the library. Then the 3D and asset side: the backend's own answers for
 * every new call (uniform arrays, turned quads, views split into passes,
 * parts and their geometry, every kind of animation, and on RAMSES 19 the
 * scene described whole, as to a renderer that subscribes, once animations
 * have stopped), and through the compositor a lit rotating cube, an effect
 * sampling an R8 glyph atlas and an RGBA8 sprite with a vec4 array, a turned
 * needle and an effect on the renderer's clock, published again. On RAMSES
 * 19, a scene file the library saves from a synthetic gauge (a needle on a
 * pivot, a bar on a data object, a plain quad, a camera and two passes, an
 * animation sequence of a real-time system and one of a system whose time
 * the service sets): loaded as the panel's scene through the compositor,
 * every edit kind read back from the library, the needle turned at 30 edits
 * a second, the sequences played, skipped and played again, unpublished for the HUD's shared scene id, loaded again with every kept
 * edit, replaced in place by a second file, dropped with the resources its
 * loads made; a file of another scene id refused.
 * Run by `make test-ramses ROOTFS=<dir>`;
 * built with CRS_RAMSES27 against iDrive 8's RAMSES 27 (graph_ramses27.h),
 * by `make test-ramses27 ROOTFS=<dir>`. */
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "../src/compositor.h"
#include "text_layer.h"
#include "../src/curves.h"
#include "fake_port.h"
#include "log.h"
#ifdef CRS_RAMSES27
#include "../src/graph_ramses27.h"
#include "ramses-client-api/RamsesClient.h"
#include "ramses-client-api/TextureEnums.h"
#include "ramses-framework-api/RamsesFramework.h"
#include "ramses-framework-api/RamsesFrameworkConfig.h"
#else
#include "../src/graph_ramses19.h"
#include "ramses19/ramses.h"
#endif

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const char *const kBars = R"(#version 100
precision mediump float;
uniform float u_level;
uniform float u_time;
varying vec2 v_uv;
void main() {
    float bar = step(abs(v_uv.y - 0.5) * 2.0, u_level * (0.6 + 0.4 * sin(u_time * 6.0 + v_uv.x * 20.0)));
    gl_FragColor = vec4(1.0, 0.1, 0.1, bar);
})";

static const char *const kLitVs = R"(#version 100
attribute vec3 a_position;
attribute vec3 a_normal;
uniform mat4 u_mvp;
uniform mat4 u_normal;
varying vec3 v_n;
void main() {
    v_n = (u_normal * vec4(a_normal, 0.0)).xyz;
    gl_Position = u_mvp * vec4(a_position, 1.0);
})";

static const char *const kLitFs = R"(#version 100
precision mediump float;
uniform vec4 u_color;
varying vec3 v_n;
void main() {
    float d = max(dot(normalize(v_n), normalize(vec3(0.4, 0.7, 0.6))), 0.0);
    gl_FragColor = vec4(u_color.rgb * (0.22 + 0.78 * d), 1.0);
})";

/* Every semantic and attribute a part's shaders can have. */
static const char *const kAllVs = R"(#version 100
attribute vec3 a_position;
attribute vec3 a_normal;
attribute vec2 a_texcoord;
attribute vec4 a_color;
uniform mat4 u_mvp;
uniform mat4 u_mv;
uniform mat4 u_m;
uniform mat4 u_v;
uniform mat4 u_p;
uniform mat4 u_normal;
uniform mat4 u_bones[2];
varying vec2 v_uv;
varying vec4 v_color;
void main() {
    v_uv = a_texcoord;
    v_color = a_color * (u_normal * vec4(a_normal, 0.0)).z;
    vec4 p = u_bones[0] * u_bones[1] * vec4(a_position, 1.0);
    gl_Position = u_mvp * p + (u_p * u_v * u_m * p - u_p * u_mv * p);
})";

static const char *const kAllFs = R"(#version 100
precision mediump float;
uniform sampler2D u_atlas;
uniform vec3 u_tint;
uniform float u_fade;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
    gl_FragColor = vec4(v_color.rgb * u_tint, texture2D(u_atlas, v_uv).r * u_fade);
})";

/* A glyph of an R8 atlas over an RGBA8 sprite, cells from a vec4 array. */
static const char *const kGlyphs = R"(#version 100
precision mediump float;
uniform sampler2D u_atlas;
uniform sampler2D u_sprite;
uniform vec4 u_cells[4];
varying vec2 v_uv;
void main() {
    float a = texture2D(u_atlas, u_cells[0].xy + v_uv * u_cells[0].zw).r;
    vec4 s = texture2D(u_sprite, v_uv);
    gl_FragColor = vec4(mix(s.rgb, u_cells[1].rgb, a), max(s.a, a)) + u_cells[2] * u_cells[3].x;
})";

/* Plasma on the renderer's clock. */
static const char *const kPlasma = R"(#version 100
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float u_time;
varying vec2 v_uv;
void main() {
    vec2 p = (v_uv - 0.5) * 6.0;
    float v = sin(p.x + u_time) + sin(p.y * 1.3 - u_time * 0.7) + sin(length(p) * 2.2 - u_time * 1.4);
    gl_FragColor = vec4(0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + v * 1.6), 1.0);
})";

#ifndef CRS_RAMSES27
static bool ok_status(ramses::status_t s) { return s == ramses::StatusOK; }

/* The synthetic scene file's effect: a flat colour, dimmed by u_level. */
static const char *const kGaugeVs = R"(#version 100
attribute vec2 a_position;
uniform mat4 u_mvp;
void main() {
    gl_Position = u_mvp * vec4(a_position, 0.0, 1.0);
})";

static const char *const kGaugeFs = R"(#version 100
precision mediump float;
uniform vec4 u_color;
uniform float u_level;
void main() {
    gl_FragColor = vec4(u_color.rgb * u_level, u_color.a);
})";

/* Saves a synthetic gauge, made here, as a scene file and a resource file:
 * a needle on a pivot node (to turn), a bar whose level is a data object, a
 * plain quad; an orthographic camera, a main and a glow pass; two animation
 * sequences, never started, processed on the client too (so the check reads
 * what they animate): "sweep" of a real-time system takes the data object
 * "swept" from 0 to 10 in a second, "drive" of a system without a clock of
 * its own the data object "driven". */
static bool save_gauge(ramses::RamsesClient &client, ramses::sceneId_t id, const std::string &file,
                       const std::string &res)
{
    ramses::SceneConfig sc;
    ramses::Scene *s = client.createScene(id, sc, "gauge");
    ramses::EffectDescription d;
    d.setVertexShader(kGaugeVs);
    d.setFragmentShader(kGaugeFs);
    d.setUniformSemantic("u_mvp", ramses::EEffectUniformSemantic_ModelViewProjectionMatrix);
    ramses::Effect *fx = client.createEffect(d, ramses::ResourceCacheFlag_DoNotCache, "gauge_fx");
    static const float quad[8] = {0, 0, 1, 0, 0, 1, 1, 1};
    static const uint16_t tris[6] = {0, 1, 2, 2, 1, 3};
    const ramses::Vector2fArray *pos = client.createConstVector2fArray(4, quad);
    const ramses::UInt16Array *idx = client.createConstUInt16Array(6, tris);
    if (!s || !fx || !pos || !idx)
        return false;
    ramses::OrthographicCamera *cam = s->createOrthographicCamera("main_cam");
    cam->setFrustum(0, 1920, 0, 720, 0.1f, 10);
    cam->setViewport(0, 0, 1920, 720);
    ramses::RenderGroup *group = s->createRenderGroup("main_group");
    ramses::RenderGroup *glow = s->createRenderGroup("glow_group");
    bool good = true;
    const char *const passes[2] = {"main_pass", "glow_pass"};
    for (int i = 0; i < 2; i++) {
        ramses::RenderPass *p = s->createRenderPass(passes[i]);
        good = good && p && ok_status(p->setCamera(*cam)) && ok_status(p->addRenderGroup(i ? *glow : *group)) &&
               ok_status(p->setRenderOrder(i));
    }
    ramses::GroupNode *gauge = s->createGroupNode("gauge");
    ramses::GroupNode *pivot = s->createGroupNode("needle_pivot");
    ramses::DataFloat *level = s->createDataFloat("level");
    good = good && gauge && pivot && level && ok_status(gauge->setTranslation(0, 0, -1)) &&
           ok_status(pivot->setParent(*gauge)) && ok_status(pivot->setTranslation(960, 360, 0));
    struct { const char *name; ramses::Node *parent; float x, y, w, h; } parts[] = {
        {"needle", pivot, -4, 0, 8, 300}, {"bar", gauge, 200, 80, 600, 40}, {"quad", nullptr, 1500, 500, 200, 120}};
    for (const auto &part : parts) {
        ramses::MeshNode *m = s->createMeshNode(part.name);
        ramses::Appearance *app = s->createAppearance(*fx, (std::string(part.name) + "_look").c_str());
        ramses::GeometryBinding *geo = s->createGeometryBinding(*fx);
        ramses::AttributeInput ain;
        ramses::UniformInput color, dim;
        good = good && m && app && geo && ok_status(fx->findAttributeInput("a_position", ain)) &&
               ok_status(geo->setInputBuffer(ain, *pos)) && ok_status(geo->setIndices(*idx)) &&
               ok_status(m->setAppearance(*app)) && ok_status(m->setGeometryBinding(*geo)) &&
               ok_status(m->setTranslation(part.x, part.y, part.parent ? 0.0f : -1.0f)) &&
               ok_status(m->setScaling(part.w, part.h, 1)) &&
               ok_status(fx->findUniformInput("u_color", color)) && ok_status(fx->findUniformInput("u_level", dim)) &&
               ok_status(app->setInputValueVector4f(color, 1, 1, 1, 1)) &&
               ok_status(std::string(part.name) == "bar" ? app->bindInput(dim, *level) : app->setInputValueFloat(dim, 1)) &&
               (!part.parent || ok_status(m->setParent(*part.parent))) &&
               ok_status((std::string(part.name) == "quad" ? glow : group)->addMeshNode(*m));
    }
    /* A data object taken from 0 to 10 in a second by a sequence of sys,
     * never started; the systems process on the client too. */
    auto bake = [&](ramses::AnimationSystem *sys, const char *data, const char *seq_name) {
        ramses::DataFloat *d = s->createDataFloat(data);
        ramses::SplineLinearFloat *keys = sys ? sys->createSplineLinearFloat() : nullptr;
        if (!d || !keys || !ok_status(d->setValue(0)) || !ok_status(keys->setKey(0, 0.0f)) ||
            !ok_status(keys->setKey(1000, 10.0f)))
            return false;
        ramses::AnimatedProperty *prop = sys->createAnimatedProperty(*d);
        ramses::Animation *anim = prop ? sys->createAnimation(*prop, *keys) : nullptr;
        ramses::AnimationSequence *seq = anim ? sys->createAnimationSequence(seq_name) : nullptr;
        return seq && ok_status(seq->addAnimation(*anim));
    };
    good = good &&
           bake(s->createRealTimeAnimationSystem(ramses::EAnimationSystemFlags_ClientSideProcessing, "gauge_clock"),
                "swept", "sweep") &&
           bake(s->createAnimationSystem(ramses::EAnimationSystemFlags_ClientSideProcessing, "gauge_driven"), "driven",
                "drive");
    ramses::ResourceFileDescription rd(res.c_str());
    rd.add(fx);
    rd.add(pos);
    rd.add(idx);
    ramses::ResourceFileDescriptionSet set;
    set.add(rd);
    good = good && ok_status(level->setValue(0.5f)) && ok_status(s->flush()) &&
           ok_status(client.saveSceneToFile(*s, file.c_str(), set, false));
    client.destroy(*s);
    client.destroy(*fx);
    client.destroy(*pos);
    client.destroy(*idx);
    return good;
}

/* An object of the scene the client knows by the name "gauge". */
template <typename T> static T *gauge_object(ramses::RamsesClient &client, const char *name)
{
    ramses::Scene *s = static_cast<ramses::Scene *>(client.findObjectByName("gauge"));
    return s ? static_cast<T *>(s->findObjectByName(name)) : nullptr;
}

/* The edits shown: the needle turned by turn, red, the level 0.75, the quad
 * hidden, the viewport halved, the glow pass off. */
static bool gauge_edited(ramses::RamsesClient &client, float turn)
{
    ramses::Node *pivot = gauge_object<ramses::Node>(client, "needle_pivot");
    ramses::Node *quad = gauge_object<ramses::Node>(client, "quad");
    ramses::MeshNode *needle = gauge_object<ramses::MeshNode>(client, "needle");
    ramses::DataFloat *level = gauge_object<ramses::DataFloat>(client, "level");
    ramses::LocalCamera *cam = gauge_object<ramses::LocalCamera>(client, "main_cam");
    ramses::RenderPass *glow = gauge_object<ramses::RenderPass>(client, "glow_pass");
    if (!pivot || !quad || !needle || !level || !cam || !glow) {
        std::printf("     the loaded gauge's objects not found\n");
        return false;
    }
    float rx = 0, ry = 0, rz = 0, v = 0, r = 0, g = 0, b = 0, a = 0;
    ramses::UniformInput color;
    const bool read = ok_status(pivot->getRotation(rx, ry, rz)) && ok_status(level->getValue(v)) &&
                      ok_status(needle->getAppearance()->getEffect().findUniformInput("u_color", color)) &&
                      ok_status(needle->getAppearance()->getInputValueVector4f(color, r, g, b, a));
    std::printf("     rotation %g, level %g, colour %g %g %g, quad %s, viewport %ux%u, glow %s\n", rz, v, r, g, b,
                quad->getVisibility() ? "shown" : "hidden", cam->getViewportWidth(), cam->getViewportHeight(),
                glow->isEnabled() ? "on" : "off");
    return read && rz == turn && v == 0.75f && r == 1 && g == 0 && !quad->getVisibility() &&
           cam->getViewportWidth() == 960 && cam->getViewportHeight() == 360 && !glow->isEnabled();
}

static size_t resource_count(ramses::RamsesClient &client, uint32_t type)
{
    size_t n = 0;
    ramses::ResourceIterator it(client, ramses::ERamsesObjectType(type));
    while (it.getNext())
        n++;
    return n;
}

/* The data buffers' element types as abi/include/ramses19/types.h
 * declares them: each attribute takes a buffer of its own type (the library
 * refuses a buffer of another type with "vertex data buffer type does not
 * match input data type"), an index buffer is 16-bit. */
static bool data_types(ramses::RamsesClient &client)
{
    ramses::SceneConfig sc;
    ramses::Scene *s = client.createScene(0x010004fe, sc, "data_types");
    ramses::EffectDescription d;
    d.setVertexShader("#version 100\nattribute float a_f;\nattribute vec2 a_2;\nattribute vec3 a_3;\n"
                      "attribute vec4 a_4;\nuniform mat4 u_mvp;\n"
                      "void main() { gl_Position = u_mvp * vec4(a_f + a_2.x + a_3.x, a_4.yz, 1.0); }\n");
    d.setFragmentShader("#version 100\nvoid main() { gl_FragColor = vec4(1.0); }\n");
    d.setUniformSemantic("u_mvp", ramses::EEffectUniformSemantic_ModelViewProjectionMatrix);
    ramses::Effect *fx = client.createEffect(d, ramses::ResourceCacheFlag_DoNotCache, "data_types_fx");
    if (!s || !fx)
        return false;
    ramses::GeometryBinding *geo = s->createGeometryBinding(*fx);
    const char *names[] = {"a_f", "a_2", "a_3", "a_4"};
    const ramses::EDataType types[] = {ramses::EDataType_Float, ramses::EDataType_Vector2F,
                                       ramses::EDataType_Vector3F, ramses::EDataType_Vector4F};
    bool good = geo != nullptr;
    for (int a = 0; good && a < 4; a++) {
        ramses::AttributeInput in;
        good = ok_status(fx->findAttributeInput(names[a], in));
        ramses::VertexDataBuffer *b = good ? s->createVertexDataBuffer(64, types[a]) : nullptr;
        good = b && ok_status(geo->setInputBuffer(in, *b));
    }
    ramses::IndexDataBuffer *idx = s->createIndexDataBuffer(12, ramses::EDataType_UInt16);
    const uint16_t six[6] = {0, 1, 2, 2, 1, 3};
    good = good && idx && ok_status(idx->setData(reinterpret_cast<const char *>(six), 12, 0)) &&
           ok_status(geo->setIndices(*idx));
    client.destroy(*s);
    client.destroy(*fx);
    return good;
}

/* The scene called name described whole, as the library describes it to a
 * renderer that subscribes: saved to a file, which is then removed. */
static ramses::RamsesClient *describing;
static bool described(const char *name)
{
    ramses::Scene *s = static_cast<ramses::Scene *>(describing->findObjectByName(name));
    const std::string file = "/tmp/crs-ramses-check-" + std::to_string(getpid()) + "-described.ramses";
    ramses::ResourceFileDescriptionSet none;
    const bool saved = s && ok_status(describing->saveSceneToFile(*s, file.c_str(), none, false));
    unlink(file.c_str());
    return saved;
}
#endif

/* A cube: 6 faces x 4 vertices with their normals. */
static MeshData cube_mesh()
{
    static const float n[6][3] = {{0, 0, 1}, {0, 0, -1}, {1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}};
    MeshData d;
    for (int f = 0; f < 6; f++) {
        const float *N = n[f];
        const float a[3] = {N[1], N[2], N[0]};
        const float b[3] = {N[1] * a[2] - N[2] * a[1], N[2] * a[0] - N[0] * a[2], N[0] * a[1] - N[1] * a[0]};
        const uint16_t base = (uint16_t)(d.position.size() / 3);
        for (int v = 0; v < 4; v++) {
            const float sa = (v & 1) ? 1.0f : -1.0f, sb = (v & 2) ? 1.0f : -1.0f;
            for (int c = 0; c < 3; c++) {
                d.position.push_back(N[c] + sa * a[c] + sb * b[c]);
                d.normal.push_back(N[c]);
                d.texcoord.push_back(c == 2 ? 0.0f : (c ? sb : sa) * 0.5f + 0.5f);
            }
            d.texcoord.pop_back();
            d.color.insert(d.color.end(), {1.0f, 0.5f, 0.0f, 1.0f});
        }
        for (uint16_t k : {0, 1, 2, 2, 1, 3})
            d.index.push_back((uint16_t)(base + k));
    }
    d.vertices = (uint32_t)(d.position.size() / 3);
    return d;
}

static Animation keyed(Animated prop, uint32_t width, std::vector<uint32_t> t, std::vector<float> v, bool step = false,
                       const char *uniform = "")
{
    Animation a;
    a.property = prop;
    a.width = width;
    a.t = t;
    a.v = v;
    a.loop = true;
    a.step = step;
    a.uniform = uniform;
    return a;
}

/* The backend's answers to every 3D, asset and animation call, on a scene
 * of its own. */
static void backend(Gpu &gpu)
{
    std::string err;
    TargetSpec t;
    t.name = "check";
    t.scene_id = 0x010004f8;
    t.width = 1920;
    t.height = 720;
    std::unique_ptr<Graph> g = gpu.scene(t, &err);
    const int glyph_fx = gpu.effect(kQuadVertexShader, kGlyphs, &err);
    const int all_fx = gpu.effect(kAllVs, kAllFs, &err);
    const int lit_fx = gpu.effect(kLitVs, kLitFs, &err);
    ok("effects with every semantic, attribute and array compile",
       g && glyph_fx && all_fx && lit_fx &&
           gpu.attributes(all_fx) == (kAttrPosition | kAttrNormal | kAttrTexcoord | kAttrColor) &&
           gpu.attributes(lit_fx) == (kAttrPosition | kAttrNormal));
    if (!g || !glyph_fx || !all_fx || !lit_fx)
        return;
    const int atlas = g->buffer(TexFormat::R8, 64, 32, Sampling::Bilinear, Wrap::Repeat);
    const int sprite = g->buffer(TexFormat::RGBA8, 16, 16, Sampling::Nearest, Wrap::Clamp);
    std::vector<uint8_t> px(64 * 32 * 4, 90);
    Rect r;
    r.x = 100; r.y = 100; r.w = 200; r.h = 80;
    const int q1 = g->quad(glyph_fx, r);
    const float cells[16] = {0, 0, 0.25f, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0};
    Turn turn;
    turn.rotate = 30; turn.sx = 1.5f; turn.px = 100; turn.py = 70;
    ok("repeating and clamped buffers, written, sampled by one quad",
       atlas && sprite && g->write(atlas, 0, 0, 64, 32, px.data()) && g->write(sprite, 0, 0, 16, 16, px.data()) &&
           q1 && g->texture(q1, "u_atlas", atlas) && g->texture(q1, "u_sprite", sprite));
    const std::vector<uint8_t> blocks(tex_bytes(TexFormat::ETC2RGBA, 16, 16), 0x55);
    Sampler bilinear, repeat;
    bilinear.sampling = Sampling::Bilinear;
    repeat.u = repeat.v = Wrap::Repeat;
    const int etc2rgba = g->immutable_texture(TexFormat::ETC2RGBA, 16, 16, bilinear, 1, blocks.data(), blocks.size());
    const int etc2rgb =
        g->immutable_texture(TexFormat::ETC2RGB, 16, 16, repeat, 1, blocks.data(), tex_bytes(TexFormat::ETC2RGB, 16, 16));
    const int q0 = g->quad(glyph_fx, r);
    ok("etc2rgba and etc2rgb textures, sampled by one quad",
       etc2rgba && etc2rgb && q0 && g->texture(q0, "u_atlas", etc2rgb) && g->texture(q0, "u_sprite", etc2rgba) &&
           !g->write(etc2rgb, 0, 0, 4, 4, blocks.data()));
    ok("a vec4 array uniform and a turn", g->uniform_array(q1, "u_cells", UniformType::Vec4, cells, 4) &&
                                             g->turn(q1, turn) && g->show(q1, true) && g->order(q1, 0));

    /* Samplers and mip levels (PROTOCOL.md "Mipmaps"): every sampling,
     * wrap per axis, anisotropy; a buffer's levels written each, and a
     * compressed chain. */
    const Sampling samplings[] = {Sampling::NearestMips, Sampling::BilinearMips, Sampling::Trilinear,
                                  Sampling::MinLinearMagNearest, Sampling::MinNearestMagLinear};
    bool sampled = true;
    std::vector<int> mipped;
    for (Sampling sm : samplings) {
        Sampler smp;
        smp.sampling = sm;
        smp.u = Wrap::Mirror;
        smp.v = Wrap::Repeat;
        smp.anisotropy = 4;
        const uint32_t levels = sampling_mips(sm) ? mip_levels(64, 32) : 1;
        const int b = g->buffer(TexFormat::RGBA8, 64, 32, smp, levels);
        for (uint32_t l = 0; b && l < levels; l++)
            sampled = sampled && g->write_level(b, l, 0, 0, mip_size(64, l), mip_size(32, l), px.data());
        sampled = sampled && b;
        mipped.push_back(b);
    }
    ok("mipmapped, mirrored, anisotropic buffers of every sampling, each level written", sampled);
    ok("a level past the buffer's refused", !g->write_level(mipped[0], 7, 0, 0, 1, 1, px.data()));
    Sampler trilinear;
    trilinear.sampling = Sampling::Trilinear;
    const uint32_t clevels = mip_levels(TexFormat::ETC2RGBA, 64, 32);   /* 64x32, 32x16, 16x8, 8x4 */
    const std::vector<uint8_t> chain(tex_chain_bytes(TexFormat::ETC2RGBA, 64, 32, clevels), 0x33);
    const int etc2mips =
        g->immutable_texture(TexFormat::ETC2RGBA, 64, 32, trilinear, clevels, chain.data(), chain.size());
    ok("an etc2rgba texture with every mip level", etc2mips && g->texture(q0, "u_atlas", etc2mips) &&
                                                       g->texture(q1, "u_sprite", mipped[2]));
    ok("a chain of the wrong length refused",
       !g->immutable_texture(TexFormat::ETC2RGBA, 64, 32, trilinear, clevels, chain.data(), chain.size() - 16));

    /* Render state (PROTOCOL.md "Render state"): every blend factor and
     * operation and a colour mask on a quad. */
    const BlendFactor factors[] = {BlendFactor::Zero,     BlendFactor::One,      BlendFactor::SrcAlpha,
                                   BlendFactor::OneMinusSrcAlpha, BlendFactor::DstAlpha, BlendFactor::OneMinusDstAlpha};
    const BlendOp ops[] = {BlendOp::Add, BlendOp::Subtract, BlendOp::ReverseSubtract, BlendOp::Min, BlendOp::Max};
    /* Each of the four factors takes every factor, each operation every
     * operation, on colour and alpha. */
    bool styled = true;
    for (int f = 0; f < 6; f++)
        for (int o = 0; o < 5; o++) {
            PartLook look = quad_look();
            look.has_custom = true;
            look.custom.src = factors[f];
            look.custom.dst = factors[(f + 1) % 6];
            look.custom.src_alpha = factors[(f + 2) % 6];
            look.custom.dst_alpha = factors[(f + 3) % 6];
            look.custom.op = ops[o];
            look.custom.op_alpha = ops[(o + 1) % 5];
            look.color_mask = kMaskR | kMaskB;
            styled = styled && g->style(q0, look);
        }
    for (Blend b : {Blend::Alpha, Blend::Add, Blend::None, Blend::Premultiplied, Blend::Max, Blend::Min,
                    Blend::Subtract}) {
        PartLook look = quad_look();
        look.blend = b;
        styled = styled && g->style(q1, look);
    }
    ok("quads styled with every factor, operation, preset and a colour mask", styled && g->flush(1));
    Projection persp;
    Projection ortho;
    ortho.ortho = true;
    ortho.ortho_h = 4;
    Pose cam;
    cam.t[2] = 6;
    cam.r[0] = -10;
    Rect vr;
    vr.x = -100; vr.y = 50; vr.w = 600; vr.h = 400;   /* reaches past the left edge */
    const int v1 = g->view(vr, persp, cam);
    vr.x = 1000; vr.y = 300;
    const int v2 = g->view(vr, ortho, cam);
    const int q2 = g->quad(glyph_fx, r);
    const int q3 = g->quad(glyph_fx, r);
    for (int q : {q2, q3})
        g->texture(q, "u_atlas", atlas), g->texture(q, "u_sprite", sprite),
            g->uniform_array(q, "u_cells", UniformType::Vec4, cells, 4), g->show(q, true);
    ok("perspective and orthographic views between quads: five passes",
       v1 && v2 && g->show(v1, true) && g->show(v2, true) && g->order(v1, 4) && g->order(q2, 8) &&
           g->order(v2, 12) && g->order(q3, 16) && g->flush(1));
    PartLook flat;
    flat.depth = false; flat.cull = Cull::None; flat.blend = Blend::Add;
    PartLook opaque;
    opaque.blend = Blend::None; opaque.cull = Cull::Front;
    opaque.depth_func = DepthFunc::GreaterEqual;
    opaque.depth_write = false;
    opaque.color_mask = kMaskA;
    const int p1 = g->part(v1, lit_fx, PartLook());
    const int p2 = g->part(v1, all_fx, flat);
    const int p3 = g->part(v2, all_fx, opaque);
    const MeshData cube = cube_mesh();
    Geometry bare = cube.geometry();
    bare.normal = nullptr;
    const float bones[32] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    const float tint[3] = {1, 0.5f, 0.2f}, fade = 1.0f, orange[4] = {1, 0.45f, 0, 1};
    Pose pose;
    pose.r[1] = 30; pose.t[2] = -1; pose.s[0] = 1.5f;
    ok("parts: geometry with every attribute, uniforms of every kind, a sampler, a pose",
       p1 && p2 && p3 && g->geometry(p1, cube.geometry()) && g->geometry(p2, cube.geometry()) &&
           g->geometry(p3, cube.geometry()) && g->uniform(p1, "u_color", orange, 4) &&
           g->uniform_array(p2, "u_bones", UniformType::Mat4, bones, 2) &&
           g->uniform_array(p2, "u_tint", UniformType::Vec3, tint, 1) && g->uniform(p2, "u_fade", &fade, 1) &&
           g->texture(p2, "u_atlas", atlas) && g->pose(p1, pose) && g->flush(2));
    ok("geometry lacking what the shader reads is refused", !g->geometry(p1, bare));
    ok("geometry replaced", g->geometry(p1, cube.geometry()) && g->flush(3));
    const int a1 = g->animate(q1, keyed(Animated::Rotate, 1, {0, 1000}, {0, 90}));
    const int a2 = g->animate(q1, keyed(Animated::Translate, 3, {0, 1000}, {0, 0, 0, 40, 20, 0}));
    const int a3 = g->animate(q2, keyed(Animated::Scale, 3, {0, 500, 1000}, {1, 1, 1, 2, 2, 1, 1, 1, 1}, true));
    const int a4 = g->animate(p1, keyed(Animated::Rotate, 3, {0, 4000}, {0, 0, 0, 0, 360, 0}));
    const int a5 = g->animate(p2, keyed(Animated::Translate, 3, {0, 1000}, {0, 0, 0, 0, 1, 0}, true));
    const int a6 = g->animate(v1, keyed(Animated::Translate, 3, {0, 2000}, {0, 0, 6, 0, 0, 8}));
    const int a7 = g->animate(v2, keyed(Animated::Rotate, 3, {0, 2000}, {0, 0, 0, 0, 30, 0}));
    const int a8 = g->animate(p2, keyed(Animated::Uniform, 1, {0, 1000}, {0, 1}, false, "u_fade"));
    const int a9 = g->animate(p2, keyed(Animated::Uniform, 3, {0, 1000}, {1, 0, 0, 0, 0, 1}, true, "u_tint"));
    const int a10 = g->animate(p1, keyed(Animated::Uniform, 4, {0, 1000}, {1, 0, 0, 1, 0, 0, 1, 1}, false, "u_color"));
    const int a11 = g->animate(p1, keyed(Animated::Uniform, 4, {0, 1000}, {1, 0, 0, 1, 0, 0, 1, 1}, true, "u_color"));
    ok("animations of every property, linear and step, on quads, parts and cameras",
       a1 && a2 && a3 && a4 && a5 && a6 && a7 && a8 && a9 && a10 && a11 && g->flush(4));
    const int errors = cld::log_errors;
    ok("refused: a uniform the shader lacks, and one of another width, before anything is made",
       !g->animate(p2, keyed(Animated::Uniform, 1, {0, 1000}, {0, 1}, false, "u_none")) &&
           !g->animate(p2, keyed(Animated::Uniform, 3, {0, 1000}, {0, 0, 0, 1, 1, 1}, false, "u_fade")) &&
           cld::log_errors == errors && g->flush(4));
    cld::log_errors = errors;
#ifndef CRS_RAMSES27
    ok("and the scene described whole", described("check"));
#endif
    g->stop(a1);
    g->stop(a11);
    g->order(v1, 20);   /* the views together at the top: three passes, a segment fewer */
    g->order(v2, 24);
    ok("stopped, reordered", g->flush(5));
#ifndef CRS_RAMSES27
    ok("with animations stopped, the scene described whole to a renderer that subscribes", described("check"));
#endif
    Projection near = persp;
    near.fov = 50;
    vr.x = 2000;   /* past the right edge: nothing to draw */
    ok("a camera changed, a view moved off the target", g->camera(v1, near, cam) && g->place(v2, vr) && g->flush(6));
    g->drop_part(p2);
    g->drop_view(v2);
    g->drop_quad(q3);
    ok("parts, views and quads dropped with their animations", g->flush(7));
#ifndef CRS_RAMSES27
    ok("and the scene described whole again", described("check"));
#endif
    /* Part hierarchies: a pivot, a part following it, posed and animated
     * by a smooth curve sampled into linear keys (curves.h). */
    const int pivot = g->node(v1);
    const int follower = g->part(v1, lit_fx, PartLook());
    Animation smooth = keyed(Animated::Rotate, 3, {0, 1000, 2000}, {0, 0, 0, 0, 90, 0, 0, 180, 0}, true);
    sample_curve(Curve::Smooth, &smooth);
    Pose tilt;
    tilt.r[0] = 20;
    ok("hierarchy: a pivot, a part following it, posed and animated by a smooth curve",
       pivot && follower && g->geometry(follower, cube.geometry()) && g->parent(follower, pivot) &&
           g->pose(pivot, tilt) && smooth.t.size() == 33 && g->animate(pivot, smooth) && g->flush(8));
    ok("hierarchy: a pivot has no geometry", !g->geometry(pivot, cube.geometry()));
    int up = -1;
    ok("hierarchy: the follower's parent the pivot, as the library holds it",
       g->read_parent(follower, &up) && up == pivot);
    g->drop_part(pivot);
    up = -1;
    ok("hierarchy: the pivot dropped, what followed it follows the view",
       g->flush(9) && g->read_parent(follower, &up) && up == 0);
    /* A part under a drawn part: the parent dropped, the child follows the
     * view, drawn on. */
    const int under = g->part(v1, lit_fx, PartLook());
    up = -1;
    ok("hierarchy: a part following a drawn part",
       under && g->geometry(under, cube.geometry()) && g->parent(under, follower) && g->flush(10) &&
           g->read_parent(under, &up) && up == follower);
    g->drop_part(follower);
    up = -1;
    ok("hierarchy: the drawn parent dropped, its follower follows the view",
       g->flush(11) && g->read_parent(under, &up) && up == 0);
    g->drop_part(under);
#ifndef CRS_RAMSES27
    ok("hierarchy: the scene described whole", described("check"));
#endif

    /* A needle sent a new value at 10 Hz (a smooth curve of two keys, 17
     * sampled) among 16 quads each played by a smooth curve of 64 keys
     * (1,009 sampled): each replacement makes its own keys, not the others'
     * (on RAMSES 19 the old ones retired, the system made again only when
     * they outnumber the live ones), measured. */
    std::vector<uint32_t> tk;
    std::vector<float> vk;
    for (int k = 0; k < 64; k++) {
        tk.push_back((uint32_t)k * 100);
        vk.push_back((float)(k % 7) * 10.0f);
    }
    Animation dial = keyed(Animated::Rotate, 1, tk, vk);
    sample_curve(Curve::Smooth, &dial);
    std::vector<int> dials, played;
    bool made = dial.t.size() == 1009;
    for (int i = 0; i < 16 && made; i++) {
        Rect nr;
        nr.x = 40 * i;
        nr.y = 600;
        nr.w = nr.h = 32;
        dials.push_back(g->quad(glyph_fx, nr));
        played.push_back(dials.back() ? g->animate(dials.back(), dial) : 0);
        made = played.back() && g->show(dials.back(), true);
    }
    made = made && g->flush(10);
    g->take_animation_bytes();
    int needle = played.empty() ? 0 : played[0];
    const auto t0 = std::chrono::steady_clock::now();
    for (int k = 0; k < 50 && made; k++) {
        Animation n = keyed(Animated::Rotate, 1, {0, 100}, {(float)k, (float)k + 1.0f});
        sample_curve(Curve::Smooth, &n);
        needle = g->replace(needle, dials[0], n);
        made = needle && g->flush(11);
    }
    const double ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / 50;
    const uint64_t per = g->take_animation_bytes() / 50;
    std::printf("     a 10 Hz needle among 16 layers of 1,009-key animations: %.2f ms a replacement with its flush, "
                "%llu key bytes a replacement\n",
                ms, (unsigned long long)per);
    ok("animations: a needle replaced 50 times among 16 animated layers makes its own keys each time",
       made && per == 17 * 8);
    /* A quad dropped with its animation playing: it is retired, no other
     * animation made again. */
    g->drop_quad(dials.back());
    dials.pop_back();
    played.pop_back();
    ok("animations: a quad dropped with its animation playing makes no other again",
       g->flush(11) && g->take_animation_bytes() == 0);
#ifndef CRS_RAMSES27
    /* Replaced past the retired keys' threshold: the animation system made
     * again, the live animations keeping when they started, and a
     * replacement due in that flush made in it. */
    uint64_t start_before = 0, start_after = 0, needle_start = 0;
    const bool read = g->read_animation(played[1], &start_before);
    bool rebuilt = false;
    for (int k = 0; k < 40 && !rebuilt && made; k++) {
        needle = g->replace(needle, dials[0], dial);
        made = needle && g->flush(11);
        rebuilt = g->take_animation_bytes() > dial.t.size() * 8;
    }
    ok("animations: past the retired keys' threshold made again, the live ones from when they started, the due one "
       "made",
       read && rebuilt && g->read_animation(played[1], &start_after) && start_after == start_before &&
           g->read_animation(needle, &needle_start) && needle_start > 0);
#endif
    /* Within a key allowance of one dial's keys a flush: three replaced at
     * once, by two owners, made one a flush, the rest due meanwhile. */
    {
        const uint64_t one = key_bytes(dial);
        g->key_allowance(one);
        Animation d1 = dial, d2 = dial;
        d1.owner = 1;
        d2.owner = 2;
        played[1] = g->replace(played[1], dials[1], d1);
        played[2] = g->replace(played[2], dials[2], d2);
        played[3] = g->replace(played[3], dials[3], d1);
        int flushes = 0;
        bool each_one = played[1] && played[2] && played[3];
        while (g->animations_due() && flushes < 10) {
            each_one = each_one && g->flush(13) && g->take_animation_bytes() == one;
            flushes++;
        }
        ok("animations: within the key allowance, three replacements made one a flush, the others due meanwhile",
           each_one && flushes == 3 && !g->animations_due());
    }
#ifndef CRS_RAMSES27
    /* A needle replaced every flush within the same allowance, past the
     * retired keys' threshold: the playing dials move to a new system one a
     * flush, taking turns with the needle, each keeping when it started; a
     * flush that moves one does not make the needle. */
    {
        const uint64_t one = key_bytes(dial);
        uint64_t kept_before = 0, kept_after = 0;
        const bool read_kept = g->read_animation(played[5], &kept_before);
        bool within = true;
        int moves = 0;
        uint64_t needle_at = 0;
        g->read_animation(needle, &needle_at);
        for (int k = 0; k < 120 && made; k++) {
            needle = g->replace(needle, dials[0], dial);
            made = needle && g->flush(14);
            const uint64_t b = g->take_animation_bytes();
            uint64_t at = 0;
            within = within && b >= one && b < 2 * one;   /* the allowance passed by one animation at most */
            /* the needle not made again (its start kept): a dial moved */
            g->read_animation(needle, &at);
            moves += at == needle_at;
            needle_at = at;
        }
        while (g->animations_due() && made) {
            made = g->flush(15);
            const uint64_t b = g->take_animation_bytes();
            within = within && b >= one && b < 2 * one;
            moves++;
        }
        g->key_allowance(UINT64_MAX);
        ok("animations: past the threshold within the allowance, the dials moved to a new system a dial a flush, starts kept",
           made && within && moves >= (int)dials.size() - 1 && read_kept &&
               g->read_animation(played[5], &kept_after) && kept_after == kept_before);
        ok("animations: the scene described whole once they moved", described("check"));
    }
#endif
    g->key_allowance(UINT64_MAX);
    /* A replacement waiting for the allowance: the old animation plays on
     * (RAMSES 19 reports its start), nothing restored; its old quad dropped
     * meanwhile, the replacement still made on the new one; stopped while
     * waiting, its old target restored once. */
    {
        Rect wr;
        wr.w = wr.h = 32;
        const int qa = g->quad(glyph_fx, wr), qb = g->quad(glyph_fx, wr), qc = g->quad(glyph_fx, wr);
        int restored = 0;
        const int wa = g->animate(qa, keyed(Animated::Rotate, 1, {0, 1000}, {0, 90}));
        const bool first = wa && g->flush(16);
        g->take_animation_bytes();
        uint64_t s0 = 0, s1 = 0;
        const bool r0 = g->read_animation(wa, &s0);
        g->key_allowance(0);
        const Animation moved = keyed(Animated::Rotate, 1, {0, 2000}, {0, 180});
        const int wb = g->replace(wa, qb, moved, [&restored]() { restored++; });
        const bool waiting = wb == wa && g->flush(16) && g->animations_due() && g->take_animation_bytes() == 0;
        const bool playing = !r0 || (g->read_animation(wa, &s1) && s1 == s0);
        ok("animations: a replacement waiting for the allowance, the old one playing on, nothing restored yet",
           first && waiting && playing && restored == 0);
        g->drop_quad(qa);
        const bool kept = g->flush(16) && g->animations_due() && restored == 0;
        g->key_allowance(UINT64_MAX);
        const bool made = g->flush(16) && !g->animations_due() && g->take_animation_bytes() == key_bytes(moved);
        ok("animations: its old quad dropped while it waits, the replacement made on the new one",
           kept && made && restored == 0);
        g->key_allowance(0);
        g->replace(wb, qc, keyed(Animated::Rotate, 1, {0, 3000}, {0, 270}), [&restored]() { restored++; });
        g->stop(wb);
        g->key_allowance(UINT64_MAX);
        ok("animations: stopped while a replacement waits, the old target restored once, nothing made",
           restored == 1 && g->flush(16) && !g->animations_due() && g->take_animation_bytes() == 0);
        g->drop_quad(qb);
        g->drop_quad(qc);
        g->flush(16);
    }
    /* Thousands of replacements alternating between properties while one
     * waits: one restore held (no chain), run once when the newest is made
     * elsewhere; one back on the property that plays restores nothing. */
    {
        Rect wr;
        wr.w = wr.h = 32;
        const int q = g->quad(glyph_fx, wr);
        auto token = std::make_shared<int>(0);
        const int wa = g->animate(q, keyed(Animated::Rotate, 1, {0, 1000}, {0, 90}));
        const bool first = wa && g->flush(16);
        g->take_animation_bytes();
        g->key_allowance(0);
        const Animation grow = keyed(Animated::Scale, 3, {0, 1000}, {1, 1, 1, 2, 2, 2});
        const Animation slide = keyed(Animated::Translate, 3, {0, 1000}, {0, 0, 0, 9, 9, 0});
        bool taken = true;
        for (int i = 0; i < 4000; i++) {
            taken = taken && g->replace(wa, q, i % 2 ? slide : grow, [token]() { ++*token; }) == wa;
            if (i % 500 == 499)
                taken = taken && g->flush(16) && g->take_animation_bytes() == 0;
        }
        ok("animations: 4,000 alternating replacements waiting, one restore held, none run",
           first && taken && token.use_count() == 2 && *token == 0 && g->animations_due());
        g->key_allowance(UINT64_MAX);
        ok("animations: the newest made, the restore run once and let go",
           g->flush(16) && g->take_animation_bytes() == key_bytes(slide) && *token == 1 && token.use_count() == 1);
        g->key_allowance(0);
        for (int i = 0; i < 1000; i++)
            g->replace(wa, q, i % 2 ? slide : grow, [token]() { ++*token; });
        g->key_allowance(UINT64_MAX);
        ok("animations: the newest back on the property that plays, nothing restored",
           g->flush(16) && g->take_animation_bytes() == key_bytes(slide) && *token == 1 && token.use_count() == 1);
        g->drop_quad(q);
        g->flush(16);
    }
    for (size_t i = 0; i < dials.size(); i++) {
        g->stop(i ? played[i] : needle);
        g->drop_quad(dials[i]);
    }
    ok("animations: stopped and dropped", g->flush(12));
#ifndef CRS_RAMSES27
    ok("animations: with replaced and stopped ones retired, the scene described whole", described("check"));
#endif

    /* Draw modes and instances: every mode, and a GLSL ES 3.00 part drawn
     * 8 times by gl_InstanceID. */
    const int es3 = gpu.effect("#version 300 es\nin vec3 a_position;\nuniform mat4 u_mvp;\n"
                               "void main(){gl_PointSize=3.0;gl_Position=u_mvp*vec4(a_position+"
                               "vec3(float(gl_InstanceID)*0.3,0.0,0.0),1.0);}",
                               "#version 300 es\nprecision mediump float;\nout vec4 o;\nvoid main(){o=vec4(1.0);}",
                               &err);
    bool modes = es3 != 0;
    std::vector<int> drawn;
    for (Draw d : {Draw::Triangles, Draw::TriangleStrip, Draw::Lines, Draw::LineLoop, Draw::Points}) {
        PartLook look;
        look.draw = d;
        look.instances = 8;
        const int p = modes ? g->part(v1, es3, look) : 0;
        modes = modes && p && g->geometry(p, cube.geometry());
        drawn.push_back(p);
    }
    ok("draw: every draw mode, 8 instances each, from a GLSL ES 3.00 effect", modes && g->flush(8));
    const int es3_quad = gpu.effect("#version 300 es\nin vec2 a_position;\nuniform mat4 u_mvp;\nout vec2 v_uv;\n"
                                    "void main(){v_uv=a_position;gl_Position=u_mvp*vec4(a_position,0.0,1.0);}",
                                    "#version 300 es\nprecision mediump float;\nin vec2 v_uv;\nout vec4 o;\n"
                                    "void main(){o=vec4(v_uv,0.0,1.0);}",
                                    &err);
    Rect er;
    er.w = er.h = 64;
    const int eq = es3_quad ? g->quad(es3_quad, er) : 0;
    ok("draw: an effect quad from GLSL ES 3.00 shaders", eq && g->show(eq, true) && g->flush(8));

    /* Every value of each render state enum set on a part and read back
     * from the library through the backend's own tables; and a new
     * appearance, as the library makes it, read through the same tables:
     * triangles, back faces culled, depth tested less-or-equal and written,
     * stencil off, every channel written. A table out of the library's
     * order reads its defaults as other values (ABI.md: each setter keeps
     * the value, and the renderer's GL tables give it the header's
     * meaning). */
    std::vector<PartLook> looks;
    for (int d = 0; d < 5; d++) {
        looks.push_back(PartLook());
        looks.back().draw = (Draw)d;
    }
    for (int c = 0; c < 3; c++) {
        looks.push_back(PartLook());
        looks.back().cull = (Cull)c;
    }
    for (int f = 0; f < 9; f++) {
        looks.push_back(PartLook());
        looks.back().depth = f != 0;
        looks.back().depth_func = f ? (DepthFunc)f : DepthFunc::LessEqual;
        looks.back().depth_write = f % 2 == 0;
    }
    for (int f = 0; f < 6; f++) {
        looks.push_back(PartLook());
        BlendState &b = looks.back().custom;
        looks.back().has_custom = true;
        b.src = (BlendFactor)f;
        b.dst = (BlendFactor)((f + 1) % 6);
        b.src_alpha = (BlendFactor)((f + 2) % 6);
        b.dst_alpha = (BlendFactor)((f + 3) % 6);
        b.op = (BlendOp)(f % 5);
        b.op_alpha = (BlendOp)((f + 1) % 5);
    }
    looks.push_back(PartLook());
    looks.back().blend = Blend::None;
    for (int s = 0; s < 9; s++) {
        looks.push_back(PartLook());
        StencilState &st = looks.back().stencil;
        st.func = (StencilFunc)s;
        st.ref = (uint8_t)(s * 20);
        st.mask = 0xf0;
        st.fail = (StencilOp)(s % 8);
        st.depth_fail = (StencilOp)((s + 1) % 8);
        st.pass = (StencilOp)((s + 2) % 8);
    }
    for (int m = 0; m < 16; m++) {
        looks.push_back(PartLook());
        looks.back().color_mask = (uint8_t)m;
    }
    int read_as_set = 0;
    for (const PartLook &l : looks) {
        const int p = g->part(v1, lit_fx, l);
        PartLook back;
        if (p && g->read_look(p, &back) && back == l)
            read_as_set++;
        else
            std::printf("     not read back: look %d\n", read_as_set);
        g->drop_part(p);
    }
    /* A round trip through the backend's own tables: what it checks is that
     * no two values map to one. */
    ok("render state: every draw mode, cull mode, depth function, blend factor and operation, stencil function and "
       "operation and colour mask read back as set",
       read_as_set == (int)looks.size());
#ifndef CRS_RAMSES27
    /* The library's own numbers for our values, against the ones traced from
     * each setter to the GL call (abi/ABI.md): a wrong name in the header, or
     * a backend table out of order, reads another number. */
    struct Traced {
        PartLook look;
        std::vector<int> raw;   /* as read_look_raw() gives them */
    };
    auto traced = [](Draw d, Cull c, DepthFunc df, BlendFactor b0, BlendFactor b1, BlendOp op, StencilFunc sf,
                     StencilOp so, std::vector<int> raw) {
        Traced t;
        t.look.draw = d;
        t.look.cull = c;
        t.look.depth = df != DepthFunc::Off;
        t.look.depth_func = df == DepthFunc::Off ? DepthFunc::LessEqual : df;
        t.look.has_custom = true;
        t.look.custom.src = b0;
        t.look.custom.dst = b1;
        t.look.custom.src_alpha = b1;
        t.look.custom.dst_alpha = b0;
        t.look.custom.op = t.look.custom.op_alpha = op;
        t.look.stencil.func = sf;
        t.look.stencil.fail = t.look.stencil.depth_fail = t.look.stencil.pass = so;
        t.raw = raw;
        return t;
    };
    const std::vector<Traced> cases = {
        /* Points 0, Disabled 0, Greater 1, Zero 0 / OneMinusDstAlpha 5, Subtract 2, Never 1, Zero 1 */
        traced(Draw::Points, Cull::None, DepthFunc::Greater, BlendFactor::Zero, BlendFactor::OneMinusDstAlpha,
               BlendOp::Subtract, StencilFunc::Never, StencilOp::Zero, {0, 0, 1, 0, 5, 5, 0, 2, 2, 1, 1, 1, 1}),
        /* Lines 1, FrontFacing 1, GreaterEqual 2, One 1 / DstAlpha 4, ReverseSubtract 3, Always 2, Replace 2 */
        traced(Draw::Lines, Cull::Front, DepthFunc::GreaterEqual, BlendFactor::One, BlendFactor::DstAlpha,
               BlendOp::ReverseSubtract, StencilFunc::Always, StencilOp::Replace, {1, 1, 2, 1, 4, 4, 1, 3, 3, 2, 2, 2, 2}),
        /* Triangles 2, BackFacing 2, Less 3, SrcAlpha 2 / OneMinusSrcAlpha 3, Min 4, Equal 3, Increment 3 */
        traced(Draw::Triangles, Cull::Back, DepthFunc::Less, BlendFactor::SrcAlpha, BlendFactor::OneMinusSrcAlpha,
               BlendOp::Min, StencilFunc::Equal, StencilOp::Increment, {2, 2, 3, 2, 3, 3, 2, 4, 4, 3, 3, 3, 3}),
        /* TriangleStrip 3, LessEqual 4, Max 5, NotEqual 4, IncrementWrap 4 */
        traced(Draw::TriangleStrip, Cull::Back, DepthFunc::LessEqual, BlendFactor::One, BlendFactor::One, BlendOp::Max,
               StencilFunc::NotEqual, StencilOp::IncrementWrap, {3, 2, 4, 1, 1, 1, 1, 5, 5, 4, 4, 4, 4}),
        /* LineLoop 4, Equal 5, Add 1, Less 5, Decrement 5 */
        traced(Draw::LineLoop, Cull::None, DepthFunc::Equal, BlendFactor::One, BlendFactor::Zero, BlendOp::Add,
               StencilFunc::Less, StencilOp::Decrement, {4, 0, 5, 1, 0, 0, 1, 1, 1, 5, 5, 5, 5}),
        /* NotEqual 6, LessEqual 6, DecrementWrap 6 */
        traced(Draw::Triangles, Cull::None, DepthFunc::NotEqual, BlendFactor::One, BlendFactor::Zero, BlendOp::Add,
               StencilFunc::LessEqual, StencilOp::DecrementWrap, {2, 0, 6, 1, 0, 0, 1, 1, 1, 6, 6, 6, 6}),
        /* Always 7, Greater 7, Invert 7 */
        traced(Draw::Triangles, Cull::None, DepthFunc::Always, BlendFactor::One, BlendFactor::Zero, BlendOp::Add,
               StencilFunc::Greater, StencilOp::Invert, {2, 0, 7, 1, 0, 0, 1, 1, 1, 7, 7, 7, 7}),
        /* Never 8, GreaterEqual 8, Keep 0 */
        traced(Draw::Triangles, Cull::None, DepthFunc::Never, BlendFactor::One, BlendFactor::Zero, BlendOp::Add,
               StencilFunc::GreaterEqual, StencilOp::Keep, {2, 0, 8, 1, 0, 0, 1, 1, 1, 8, 0, 0, 0}),
        /* depth Disabled 0, stencil Disabled 0 */
        traced(Draw::Triangles, Cull::None, DepthFunc::Off, BlendFactor::One, BlendFactor::Zero, BlendOp::Add,
               StencilFunc::Off, StencilOp::Keep, {2, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0}),
    };
    int as_traced = 0;
    for (const Traced &t : cases) {
        const int p = g->part(v1, lit_fx, t.look);
        std::vector<int> raw;
        if (p && g->read_look_raw(p, &raw) && raw == t.raw)
            as_traced++;
        else
            std::printf("     not as traced: case %d\n", (int)(&t - &cases[0]));
        g->drop_part(p);
    }
    ok("render state: the library's numbers for every value are the ones traced to the GL calls",
       as_traced == (int)cases.size());
    /* blending off: both operations Disabled 0 */
    PartLook off;
    off.blend = Blend::None;
    const int op = g->part(v1, lit_fx, off);
    std::vector<int> raw;
    ok("render state: blending off reads Disabled 0 for both operations",
       op && g->read_look_raw(op, &raw) && raw.size() == 13 && raw[7] == 0 && raw[8] == 0);
    g->drop_part(op);
#endif
    const int fresh_part = g->part(v1, lit_fx, PartLook());
    PartLook fresh;
    ok("render state: a new appearance reads triangles, back faces culled, depth less-or-equal and written, no "
       "stencil, every channel",
       fresh_part && g->read_look(fresh_part, &fresh, true) && fresh.draw == Draw::Triangles &&
           fresh.cull == Cull::Back && fresh.depth_test() == DepthFunc::LessEqual && fresh.depth_writes() &&
           fresh.stencil.func == StencilFunc::Off && fresh.color_mask == kMaskRGBA);
    g->drop_part(fresh_part);
    g->drop_quad(eq);
    gpu.drop_effect(es3_quad);
    for (int p : drawn)
        g->drop_part(p);

    /* An effect's samplers as the library compiled it: each of a list, a
     * defined type, the branch its preprocessor took, a comment between
     * uniform and the type. */
    {
        const char *fs = "#version 100\nprecision mediump float;\n#define CUBE samplerCube\n"
                         "uniform sampler2D u_a, u_b;\nuniform CUBE u_c;\n"
                         "#if 0\nuniform samplerCube u_d;\n#else\nuniform sampler2D u_d;\n#endif\n"
                         "uniform/**/samplerCube u_e;\nuniform vec4 u_tint;\n"
                         "#if 0\nuniform samplerCube u_k;\n#else// the branch taken\nuniform sampler2D u_k;\n#endif\n"
                         "varying vec2 v_uv;\n"
                         "void main(){gl_FragColor=(texture2D(u_a,v_uv)+texture2D(u_b,v_uv)+textureCube(u_c,vec3(v_uv,1.0))"
                         "+texture2D(u_d,v_uv)+textureCube(u_e,vec3(1.0))+texture2D(u_k,v_uv))*u_tint;}";
        const int fx = gpu.effect(kQuadVertexShader, fs, &err);
        std::vector<EffectInput> in;
        std::map<std::string, EffectInput::Kind> kind;
        const bool known = fx && gpu.inputs(fx, &in);
        for (const EffectInput &e : in)
            kind[e.name] = e.kind;
#ifdef CRS_RAMSES27
        /* the library's own types: every kind exact */
        const EffectInput::Kind defined = EffectInput::SamplerCube, branched = EffectInput::Sampler2D;
#else
        /* one data type for both kinds: each from its declarations where
         * they agree, unknown (never refused) behind a define or across
         * branches */
        const EffectInput::Kind defined = EffectInput::Sampler, branched = EffectInput::Sampler;
#endif
        ok("samplers: as compiled: each of a list, a defined type, the branch taken (after an #else// comment too), a "
           "comment between",
           known && kind.count("u_a") && kind["u_a"] == EffectInput::Sampler2D && kind.count("u_b") &&
               kind["u_b"] == EffectInput::Sampler2D && kind.count("u_c") && kind["u_c"] == defined &&
               kind.count("u_d") && kind["u_d"] == branched && kind.count("u_e") &&
               kind["u_e"] == EffectInput::SamplerCube && kind.count("u_tint") && kind["u_tint"] == EffectInput::Vec4 &&
               kind.count("u_k") && kind["u_k"] == branched);
        if (fx)
            gpu.drop_effect(fx);
    }

    /* Cube maps: RGBA8 and ETC2RGBA, sampled by a samplerCube. */
    const int sky_fx = gpu.effect(kQuadVertexShader,
                                  "#version 100\nprecision mediump float;\nuniform samplerCube u_sky;\nvarying vec2 v_uv;\n"
                                  "void main(){gl_FragColor=textureCube(u_sky,vec3(v_uv*2.0-1.0,1.0));}",
                                  &err);
    std::vector<uint8_t> faces(6 * 32 * 32 * 4, 0x77);
    Sampler bilin;
    bilin.sampling = Sampling::Bilinear;
    const int cube_rgba = g->cube_texture(TexFormat::RGBA8, 32, bilin, faces.data(), 32 * 32 * 4);
    const int cube_etc2 = g->cube_texture(TexFormat::ETC2RGBA, 32, bilin, faces.data(), tex_bytes(TexFormat::ETC2RGBA, 32, 32));
    const int sky_q = sky_fx ? g->quad(sky_fx, r) : 0;
    ok("cube: RGBA8 and ETC2RGBA cube textures, sampled by a samplerCube",
       sky_fx && cube_rgba && cube_etc2 && sky_q && g->texture(sky_q, "u_sky", cube_rgba) && g->show(sky_q, true) &&
           g->flush(8) && g->texture(sky_q, "u_sky", cube_etc2) && g->flush(9));
    ok("cube: faces of the wrong size refused", !g->cube_texture(TexFormat::RGBA8, 32, bilin, faces.data(), 100));
    {
        /* A texture of the other kind: RAMSES 27 refuses it, RAMSES 19
         * takes it (the service refuses it first where it knows the kind). */
        const int fx2 = gpu.effect(kQuadVertexShader,
                                   "#version 100\nprecision mediump float;\nuniform sampler2D u_flat;\nvarying vec2 v_uv;\n"
                                   "void main(){gl_FragColor=texture2D(u_flat,v_uv);}",
                                   &err);
        const int q2 = fx2 ? g->quad(fx2, r) : 0;
        const int flat = g->buffer(TexFormat::RGBA8, 16, 16, Sampling::Bilinear);
        const bool cube_on_2d = q2 && g->texture(q2, "u_flat", cube_rgba);
        const bool flat_on_cube = sky_q && flat && g->texture(sky_q, "u_sky", flat);
#ifdef CRS_RAMSES27
        ok("cube: a cube texture on a sampler2D, and a 2D one on a samplerCube, refused by the library",
           q2 && flat && !cube_on_2d && !flat_on_cube);
#else
        ok("cube: a cube texture on a sampler2D, and a 2D one on a samplerCube, taken by the library",
           q2 && flat && cube_on_2d && flat_on_cube);
#endif
        g->texture(sky_q, "u_sky", cube_rgba);
        g->drop_quad(q2);
        g->drop_buffer(flat);
        if (fx2)
            gpu.drop_effect(fx2);
        g->flush(9);
    }
#ifndef CRS_RAMSES27
    /* The faces in the order given: each filled with its own byte, the
     * texture's data as the library saves it holds them +x, -x, +y, -y, +z,
     * -z (CubeMipLevelData's pointers in the library's order). */
    std::vector<uint8_t> marked(6 * 32 * 32 * 4);
    for (size_t i = 0; i < marked.size(); i++)
        marked[i] = (uint8_t)(0x31 + i / (32 * 32 * 4) * 0x11);
    const int cube_marked = g->cube_texture(TexFormat::RGBA8, 32, bilin, marked.data(), 32 * 32 * 4);
    const std::string res = "/tmp/crs-ramses-check-" + std::to_string(getpid()) + "-cube.ramres";
    uint32_t cube_size = 0;
    int cube_format = -1;
    const bool saved = cube_marked && g->read_cube(cube_marked, &cube_size, &cube_format, res.c_str());
    std::string bytes;
    if (FILE *f = std::fopen(res.c_str(), "rb")) {
        char b[65536];
        size_t n;
        while ((n = std::fread(b, 1, sizeof b, f)) > 0)
            bytes.append(b, n);
        std::fclose(f);
    }
    unlink(res.c_str());
    size_t at = 0;
    bool in_order = !bytes.empty();
    for (int face = 0; face < 6 && in_order; face++) {
        const size_t found = bytes.find(std::string(32 * 32 * 4, (char)(0x31 + face * 0x11)), at);
        in_order = found != std::string::npos;
        at = found + 32 * 32 * 4;
    }
    ok("cube: its size and format read back, its six faces saved in the order given",
       saved && cube_size == 32 && cube_format == (int)ramses::ETextureFormat_RGBA8 && in_order);
    g->drop_buffer(cube_marked);
#endif
    g->drop_quad(sky_q);
    g->drop_buffer(cube_rgba);
    g->drop_buffer(cube_etc2);
#ifndef CRS_RAMSES27
    ok("cube and draw: the scene described whole", described("check"));
#endif

    /* Shared values: a float and a vec3, a quad's and a part's uniforms
     * following them, set, the float animated, replaced and stopped; a value
     * of another type than its uniform refused; unlinked; dropped. */
    const int lvl_fx = gpu.effect(kQuadVertexShader,
                                  "#version 100\nprecision mediump float;\nuniform float u_level;\nuniform vec3 u_tint;\n"
                                  "varying vec2 v_uv;\nvoid main(){gl_FragColor=vec4(u_tint*u_level,1.0);}",
                                  &err);
    Rect lr;
    lr.w = lr.h = 64;
    const int vq = lvl_fx ? g->quad(lvl_fx, lr) : 0;
    const int vp = g->part(v1, all_fx, PartLook());
    const int level = g->value(1), warmth = g->value(3);
    const float half = 0.5f, warm[3] = {1.0f, 0.5f, 0.2f};
    Animation pulse = keyed(Animated::Value, 1, {0, 500, 1000}, {0, 1, 0});
    int pulsing = 0;
    ok("values: a float and a vec3 a quad's and a part's uniforms follow, set, the float animated",
       vq && vp && level && warmth && g->geometry(vp, cube.geometry()) && g->show(vq, true) &&
           g->set_value(level, &half) && g->set_value(warmth, warm) && g->link(vq, "u_level", level) &&
           g->link(vp, "u_fade", level) && g->link(vq, "u_tint", warmth) && g->link(vp, "u_tint", warmth) &&
           (pulsing = g->animate(level, pulse)) && g->flush(13));
    ok("values: a value of another type than the uniform refused", !g->link(vq, "u_level", warmth));
    {
        /* the library refuses an array (logging an error the run fails on):
         * refused before it is asked */
        const int arr_fx = gpu.effect(kQuadVertexShader,
                                      "#version 100\nprecision mediump float;\nuniform float u_arr[4];\n"
                                      "void main(){gl_FragColor=vec4(u_arr[0]+u_arr[3]);}",
                                      &err);
        const int aq = arr_fx ? g->quad(arr_fx, lr) : 0;
        ok("values: an array uniform refused", aq && !g->link(aq, "u_arr", level) && g->flush(13));
        /* As the library compiled the effect: the second of a list and a
         * struct's member linked; an unused uniform linked where the
         * library reports it, and refused by the service where it does
         * not, never failing at the flush. */
        const int list_fx = gpu.effect(kQuadVertexShader,
                                       "#version 100\nprecision mediump float;\nuniform vec3 u_near, u_far;\n"
                                       "struct Lamp { float k; vec3 c; };\nuniform Lamp u_lamp;\nuniform float u_unused;\n"
                                       "void main(){gl_FragColor=vec4((u_near+u_far+u_lamp.c)*u_lamp.k,1.0);}",
                                       &err);
        std::vector<EffectInput> lin;
        std::map<std::string, EffectInput> by;
        const bool listed = list_fx && gpu.inputs(list_fx, &lin);
        std::string member, names;
        for (const EffectInput &e : lin) {
            by[e.name] = e;
            names += " " + e.name;
            if (e.name.find("u_lamp") != std::string::npos && e.name.find('k') != std::string::npos &&
                e.kind == EffectInput::Float)
                member = e.name;
        }
        std::printf("     the library's uniforms:%s\n", names.c_str());
        const int lq = list_fx ? g->quad(list_fx, lr) : 0;
        const int errs = cld::log_errors;
        const bool unused_listed = by.count("u_unused") != 0;
        ok("values: the second of a list of vec3s and a struct's float member, as the library reports them, linked",
           listed && lq && by.count("u_far") && by["u_far"].kind == EffectInput::Vec3 && by["u_far"].elements == 1 &&
               g->link(lq, "u_far", warmth) && !member.empty() && g->link(lq, member.c_str(), level) && g->flush(13) &&
               cld::log_errors == errs);
        ok("values: an unused uniform linked where the library reports it, else not there to link",
           unused_listed ? g->link(lq, "u_unused", level) && g->flush(13) && cld::log_errors == errs
                         : !g->link(lq, "u_unused", level));
        g->link(lq, "u_far", 0);
        g->link(lq, member.c_str(), 0);
        g->link(lq, "u_unused", 0);
        g->drop_quad(lq);
        if (list_fx)
            gpu.drop_effect(list_fx);
        g->drop_quad(aq);
        gpu.drop_effect(arr_fx);
    }
    pulse.v = {1, 0, 1};
    pulsing = g->replace(pulsing, level, pulse);
    ok("values: its animation replaced", pulsing && g->flush(14));
    g->stop(pulsing);
    ok("values: stopped, set again, unlinked",
       g->set_value(level, warm) && g->link(vq, "u_level", 0) && g->link(vp, "u_fade", 0) &&
           g->link(vq, "u_tint", 0) && g->link(vp, "u_tint", 0) && g->flush(15));
    /* a value that was animated dropped while another animation plays:
     * no animation made again for it (its data object kept while a system
     * that animated it lasts) */
    const int spin = g->animate(vq, keyed(Animated::Rotate, 1, {0, 1000}, {0, 360}, true));
    const bool spun = spin && g->flush(15);
    g->take_animation_bytes();
    g->drop_value(level);
    const bool none_again = g->flush(15) && g->take_animation_bytes() == 0;
    g->stop(spin);
    g->drop_value(warmth);
    g->drop_quad(vq);
    g->drop_part(vp);
    ok("values: dropped, an animated one making no other animation again", spun && none_again && g->flush(16));
#ifndef CRS_RAMSES27
    ok("values: the scene described whole", described("check"));
#endif
    gpu.drop_effect(lvl_fx);

    /* Text layers' glyph runs (src/text_layer.h): the service's text
     * shaders compiled; a quad drawing a run of 256 glyphs from vertex and
     * index buffers the scene keeps, a 64-glyph line written into them and
     * flushed, rewritten as a readout changes, emptied; a second buffer or
     * more glyphs than it holds refused; dropped with its buffers. */
    const int tfx = gpu.effect(kTextVertexShader, kTextFragmentShader, &err);
    Rect tr;
    tr.x = 100;
    tr.y = 600;
    tr.w = 1600;
    tr.h = 32;
    const int tq = tfx ? g->quad(tfx, tr) : 0;
    const int tbuf = g->buffer(TexFormat::R8, 64, 32, Sampling::Bilinear);
    std::vector<uint8_t> tpx(64 * 32, 200);
    crs::Font tf;
    std::string terr;
    const bool font_ok = crs::parse_font("49:0,0,8,16,0,0,8 50:8,0,8,16,0,8,9", "49,50:-1", 64, 32, 16, 0, &tf, &terr);
    std::vector<uint32_t> cps;
    for (int i = 0; i < 64; i++)
        cps.push_back(i % 2 ? '2' : '1');
    crs::TextStyle ts;
    const std::vector<crs::GlyphQuad> line = crs::lay_out(tf, cps, ts, tr.w, tr.h);
    const std::vector<float> lv = crs::glyph_vertices(line, tr.w, tr.h);
    const float white[4] = {1, 1, 1, 1}, nosdf = 0;
    const bool run = font_ok && line.size() == 64 && tq && tbuf && g->write(tbuf, 0, 0, 64, 32, tpx.data()) &&
                     g->glyph_buffer(tq, 256) && g->texture(tq, "u_atlas", tbuf) && g->uniform(tq, "u_color", white, 4) &&
                     g->uniform(tq, "u_sdf", &nosdf, 1) && g->style(tq, [] {
                         PartLook l = quad_look();
                         l.blend = Blend::Premultiplied;
                         return l;
                     }()) && g->glyphs(tq, lv.data(), 64) && g->show(tq, true) && g->flush(17);
    ok("text: its shaders compiled, a run of 256 glyphs made, a line of 64 written and drawn", run);
    bool readout = run;
    for (int i = 0; readout && i < 20; i++) {
        const std::vector<uint32_t> v = {(uint32_t)('1' + i % 2), '2', '1'};
        const std::vector<float> rv = crs::glyph_vertices(crs::lay_out(tf, v, ts, tr.w, tr.h), tr.w, tr.h);
        readout = g->glyphs(tq, rv.data(), (uint32_t)(rv.size() / 16)) && g->flush(17);
    }
    ok("text: a readout rewritten 20 times, a flush each, the run emptied",
       readout && g->glyphs(tq, nullptr, 0) && g->flush(17));
    std::vector<float> past(257 * 16, 0.0f);
    ok("text: a second glyph buffer, or more glyphs than it holds, refused",
       run && !g->glyph_buffer(tq, 16) && !g->glyphs(tq, past.data(), 257) && g->flush(17));
#ifndef CRS_RAMSES27
    ok("text: the scene described whole", described("check"));
#endif
    /* A distance font's GLSL ES 3.00 shader (derivatives) compiled, and a
     * run drawn with it from the same atlas. */
    const int sfx = gpu.effect(kTextVertexShader300, kTextSdfFragmentShader300, &err);
    const int sq = sfx ? g->quad(sfx, tr) : 0;
    ok("text: the distance shader (GLSL ES 3.00) compiled, a run of it written and drawn",
       sq && g->glyph_buffer(sq, 64) && g->texture(sq, "u_atlas", tbuf) && g->uniform(sq, "u_color", white, 4) &&
           g->glyphs(sq, lv.data(), 64) && g->show(sq, true) && g->flush(17));
    g->drop_quad(sq);
    if (sfx)
        gpu.drop_effect(sfx);
    g->drop_quad(tq);
    g->drop_buffer(tbuf);
    if (tfx)
        gpu.drop_effect(tfx);
    ok("text: dropped with its buffers", g->flush(17));

    /* Canvases (PROTOCOL.md "Canvases"): one with a depth-stencil buffer,
     * a quad in it writing the stencil and one testing it, a view with a
     * part in it, a quad on screen sampling it; one drawn once, redrawn;
     * both dropped. */
    CanvasSpec cs;
    cs.w = 256;
    cs.h = 128;
    cs.depth = true;
    cs.clear[2] = 1;
    cs.clear[3] = 1;
    cs.sampler.sampling = Sampling::Bilinear;
    const int canvas = g->canvas(cs);
    CanvasSpec os = cs;
    os.depth = false;
    os.once = true;
    const int once = g->canvas(os);
    Rect cr;
    cr.w = 128;
    cr.h = 64;
    const int cq1 = g->quad_in(canvas, glyph_fx, cr);
    cr.x = 64;
    const int cq2 = g->quad_in(canvas, glyph_fx, cr);
    PartLook writes = quad_look(), tests = quad_look();
    writes.stencil.func = StencilFunc::Always;
    writes.stencil.ref = 1;
    writes.stencil.pass = StencilOp::Replace;
    writes.color_mask = 0;
    tests.stencil.func = StencilFunc::NotEqual;
    tests.stencil.ref = 1;
    Rect vr2;
    vr2.w = 256;
    vr2.h = 128;
    const int cv = g->view_in(canvas, vr2, persp, cam);
    const int cp = cv ? g->part(cv, lit_fx, PartLook()) : 0;
    const int oq = g->quad_in(once, glyph_fx, cr);
    Rect sr;
    sr.x = 300; sr.y = 300; sr.w = 256; sr.h = 128;
    const int screen = g->quad(glyph_fx, sr);
    ok("canvases: made, quads and a view drawn in them",
       canvas && once && cq1 && cq2 && cv && cp && oq && screen && g->geometry(cp, cube.geometry()) &&
           g->style(cq1, writes) && g->style(cq2, tests) && g->show(cq1, true) && g->show(cq2, true) &&
           g->show(cv, true) && g->show(oq, true) && g->order(cq1, 0) && g->order(cv, 4) && g->order(cq2, 8));
    ok("canvases: sampled on screen", g->texture(screen, "u_atlas", canvas) && g->texture(screen, "u_sprite", once) &&
                                          g->show(screen, true) && g->flush(8));
    ok("canvases: one drawn once, drawn again", g->redraw(once) && g->flush(9));
    CanvasReadback rb, ro;
    /* A round trip through the library's own tables, not evidence of the
     * enums (ABI.md has that): the canvas as made, the copy unblended. */
    ok("canvases: read back as made: colour buffers drawn in and sampled, a depth-stencil one only drawn in; the "
       "copy writes alpha, unblended",
       g->read_canvas(canvas, &rb) && rb.color_format == (int)ramses::ERenderBufferFormat_RGBA8 &&
           rb.color_type == (int)ramses::ERenderBufferType_Color &&
           rb.color_access == (int)ramses::ERenderBufferAccessMode_ReadWrite &&
           rb.shown_format == (int)ramses::ERenderBufferFormat_RGBA8 &&
           rb.shown_type == (int)ramses::ERenderBufferType_Color &&
           rb.shown_access == (int)ramses::ERenderBufferAccessMode_ReadWrite &&
           rb.depth_format == (int)ramses::ERenderBufferFormat_Depth24_Stencil8 &&
           rb.depth_type == (int)ramses::ERenderBufferType_DepthStencil &&
           rb.depth_access == (int)ramses::ERenderBufferAccessMode_WriteOnly && rb.copy_writes_alpha &&
           !rb.copy_blends && g->read_canvas(once, &ro) && ro.depth_format == -1 &&
           ro.first_order > rb.copy_order && rb.copy_order > rb.first_order);
    ok("canvases: one drawn every frame disabled and enabled again",
       g->enable_canvas(canvas, false) && g->read_canvas(canvas, &rb) && !rb.enabled && g->flush(9) &&
           g->enable_canvas(canvas, true) && g->read_canvas(canvas, &rb) && rb.enabled && g->flush(9));
    /* Every slot of render orders taken: the canvases take the first ones
     * again, made-before still drawn first. */
    bool cycled = true;
    for (int i = 0; i < kCanvasSlots + 2 && cycled; i++) {
        const int c = g->canvas(os);
        cycled = c && g->flush(9);
        g->drop_canvas(c);
    }
    const int later = g->canvas(os);
    CanvasReadback rl;
    ok("canvases: past every slot of render orders, a canvas made later still drawn after those made before",
       cycled && later && g->flush(9) && g->read_canvas(canvas, &rb) && g->read_canvas(once, &ro) &&
           g->read_canvas(later, &rl) && rb.copy_order < ro.first_order && ro.copy_order < rl.first_order &&
           rl.copy_order < kLowestLayersOrder);
    g->drop_canvas(later);
    ok("canvases: a quad in a canvas that is gone is refused", !g->quad_in(9999, glyph_fx, cr));
#ifndef CRS_RAMSES27
    ok("canvases: the scene described whole", described("check"));
#endif
    g->drop_quad(screen);
    g->drop_canvas(canvas);
    g->drop_canvas(once);
    ok("canvases: dropped with what is drawn in them", g->flush(10));
#ifndef CRS_RAMSES27
    ok("canvases: and the scene described whole again", described("check"));
#endif
    g.reset();
    gpu.drop_effect(glyph_fx);
    gpu.drop_effect(all_fx);
    gpu.drop_effect(lit_fx);
}

int main()
{
    cld::log_name = "ramses_check";
#ifdef CRS_RAMSES27
    ramses::RamsesFramework::SetConsoleLogLevel(ramses::ELogLevel::Warn);
    ramses::RamsesFrameworkConfig fwc;
    ramses::RamsesFramework framework(fwc);
    ramses::RamsesClient *client = framework.createClient("ramses_check");
    if (!client || framework.connect() != ramses::StatusOK) {
        std::printf("FAIL connect\n");
        return 1;
    }
    Ramses27Gpu gpu(*client);
#else
    const char *args[] = {"ramses_check"};
    ramses::RamsesFrameworkConfig fwc(1, args);
    ramses::RamsesFramework framework(fwc);
    ramses::RamsesClient client("ramses_check", framework);
    if (framework.connect() != ramses::StatusOK) {
        std::printf("FAIL connect\n");
        return 1;
    }
    Ramses19Gpu gpu(client);
    describing = &client;
    ok("text: the data buffers' element types as declared: each attribute takes its own",
       data_types(client));
    /* Saved before any target has the panel's scene id. */
    const std::string dir = "/tmp/crs-ramses-check-" + std::to_string(getpid());
    mkdir(dir.c_str(), 0755);
    const std::string gauge = dir + "/gauge.ramses", gauge_res = dir + "/gauge.ramres";
    const std::string other = dir + "/other.ramses", other_res = dir + "/other.ramres";
    const std::string gauge2 = dir + "/gauge2.ramses", gauge2_res = dir + "/gauge2.ramres";
    ok("a synthetic scene file saved, a second one, and one of another scene id",
       save_gauge(client, 0x01000400, gauge, gauge_res) && save_gauge(client, 0x01000400, gauge2, gauge2_res) &&
           save_gauge(client, 0x010004f9, other, other_res));
#endif
    std::string err;
    ok("the unit quad", gpu.init(&err));
#ifndef CRS_RAMSES27
    /* The uniform types unknown (learn() failed): a uniform's animation
     * refused before anything is made, a rotation taken. */
    {
        gpu.untyped(true);
        TargetSpec u;
        u.name = "untyped";
        u.scene_id = 0x010004fa;
        u.width = u.height = 64;
        std::unique_ptr<Graph> ug = gpu.scene(u, &err);
        const int ufx = gpu.effect(kQuadVertexShader,
                                   "#version 100\nprecision mediump float;\nuniform float u_level;\n"
                                   "void main(){gl_FragColor=vec4(u_level);}",
                                   &err);
        Rect ur;
        ur.w = ur.h = 32;
        const int uq = ug && ufx ? ug->quad(ufx, ur) : 0;
        const int errs = cld::log_errors;
        ok("animations: the uniform types unknown, a uniform's animation refused up front, a rotation taken",
           uq && !ug->animate(uq, keyed(Animated::Uniform, 1, {0, 1000}, {0, 1}, false, "u_level")) &&
               ug->animate(uq, keyed(Animated::Rotate, 1, {0, 1000}, {0, 90})) && ug->flush(1) && cld::log_errors == errs);
        if (ug)
            ug->drop_quad(uq);
        ug.reset();
        if (ufx)
            gpu.drop_effect(ufx);
        gpu.untyped(false);
    }
#endif

    FakePort port;
    SlotManager slots(&port, nullptr);
    TargetSpec m;
    m.name = "map"; m.slot = 0x100; m.scene_id = 0x010004f0; m.width = 1088; m.height = 480; m.linger_ms = 500;
    m.take_over_stock = true;
    TargetSpec p;
    p.name = "panel"; p.slot = 0x203; p.scene_id = 0x01000400; p.width = 1920; p.height = 720; p.linger_ms = 500;
    p.scene_files = true;
    TargetSpec h;   /* the panel's scene id */
    h.name = "hud"; h.slot = 0x323; h.scene_id = 0x01000400; h.width = 800; h.height = 480; h.linger_ms = 500;
    slots.add(m);
    slots.add(p);
    slots.add(h);
    GovernorConfig gc;
    Compositor comp(&gpu, &slots, gc, 250);
    slots.set_scenes(&comp);
    port.m = &slots;
    ok("the built-in effects compile", comp.init(&err));

    int64_t now = 10000;
    auto run = [&](int64_t ms) {
        for (int64_t t = 0; t < ms; t += 33) {
            now += 33;
            port.tick(now);
            comp.arrange(now);
            slots.tick(now);
            comp.render(now);
        }
    };

    LayerParams lp;
    lp.contend = true;
    lp.rect.w = 1088;
    lp.rect.h = 480;
    VideoParams vp;
    const uint32_t vid = comp.add_video(1, 0, lp, vp, now, &err);
    VideoLayer *video = static_cast<VideoLayer *>(comp.layer(1, vid));
    LayerParams ip;
    ip.klass = Klass::Overlay;
    ip.rect.x = 900; ip.rect.y = 380; ip.rect.w = 160; ip.rect.h = 80;
    const uint32_t img = comp.add_image(2, 0, ip, 160, 80, 30, Sampling::Nearest, now, &err);
    ImageLayer *image = static_cast<ImageLayer *>(comp.layer(2, img));
    LayerParams ep;
    ep.klass = Klass::Overlay;
    ep.rect.x = 740; ep.rect.y = 461; ep.rect.w = 440; ep.rect.h = 132;
    const uint32_t fx = comp.add_effect(3, 1, ep, "", kBars, 30, now, &err);
    ok("a video, an image and an effect layer (the effect compiled by glslang)", vid && img && fx);
    const float level = 0.7f;
    static_cast<EffectLayer *>(comp.layer(3, fx))->set_uniform("u_level", &level, 1);

    std::vector<uint8_t> atlas(video->frame_bytes());
    std::vector<uint8_t> px(160 * 80 * 4, 200);
    image->update({}, px.data(), px.size(), &err);
    for (int i = 0; i < 90; i++) {
        /* Still, then a small change, then whole-picture motion (packed). */
        for (size_t k = 0; k < atlas.size(); k++)
            atlas[k] = (uint8_t)(i < 30 ? k / 13 : i < 60 ? (k / 13 + (k % 1088 < 64 ? i : 0)) : k / 13 + i * 9);
        video->offer(atlas.data(), now);
        if (i % 10 == 0) {
            std::vector<uint8_t> patch(16 * 16 * 4, (uint8_t)i);
            image->update({crk::PixelRect{8, 8, 16, 16}}, patch.data(), patch.size(), &err);
        }
        run(33);
    }
    run(1000);
    std::string reason;
    ok("all shown", comp.state(vid, &reason) == LayerState::Shown && comp.state(img, &reason) == LayerState::Shown &&
                        comp.state(fx, &reason) == LayerState::Shown);
    const std::string s = video->stats();
    std::printf("     video: %s\n", s.c_str());
    ok("whole, partial and packed writes all went", s.find(" 0 whole") == std::string::npos &&
                                                       s.find(" 0 partial") == std::string::npos &&
                                                       s.find(" 0 packed") == std::string::npos &&
                                                       s.find(" 0 failed") != std::string::npos);

    LayerParams xp;
    xp.klass = Klass::Alert;
    xp.exclusive = true;
    const uint32_t alert = comp.add_effect(4, 0, xp, "", "#version 100\nvoid main(){gl_FragColor=vec4(0.0,0.0,1.0,1.0);}",
                                           0, now, &err);
    run(200);
    ok("an exclusive alert suspends the rest", comp.state(vid, &reason) == LayerState::Suspended);
    comp.remove_owner(4);
    comp.layer(2, img)->params.z = -5;
    comp.changed(comp.layer(2, img));
    run(200);
    ok("removed, and the order changed: back", alert && comp.state(vid, &reason) == LayerState::Shown);

    port.steal(m);
    run(2500);
    ok("the scene taken and published again: shown", comp.state(vid, &reason) == LayerState::Shown);
    comp.remove_owner(1);
    comp.remove_owner(2);
    comp.remove_owner(3);
    run(1000);
    ok("every layer gone: both targets released", slots.status(0).state == TargetState::Idle &&
                                                      slots.status(1).state == TargetState::Idle);

    backend(gpu);

    /* Sample content through the compositor, on the panel. */
    AssetParams gp;
    gp.format = TexFormat::R8;
    gp.w = 256;
    gp.h = 64;
    gp.sampler.sampling = Sampling::Bilinear;
    const uint32_t glyphs = comp.add_asset(5, 1, gp, &err);
    AssetParams sp;
    sp.w = sp.h = 32;
    sp.sampler.u = sp.sampler.v = Wrap::Repeat;
    const uint32_t sprite = comp.add_asset(5, 1, sp, &err);
    std::vector<uint8_t> gpx(256 * 64), spx(32 * 32 * 4);
    for (size_t i = 0; i < gpx.size(); i++)
        gpx[i] = (uint8_t)(i * 7);
    for (size_t i = 0; i < spx.size(); i++)
        spx[i] = (uint8_t)(i * 3);
    comp.asset(5, glyphs)->update({}, gpx.data(), gpx.size(), &err);
    comp.asset(5, sprite)->update({}, spx.data(), spx.size(), &err);
    LayerParams tp;
    tp.klass = Klass::Overlay;
    tp.rect.x = 60; tp.rect.y = 560; tp.rect.w = 512; tp.rect.h = 128;
    const uint32_t label = comp.add_effect(5, 1, tp, "", kGlyphs, 0, now, &err);
    EffectLayer *ll = static_cast<EffectLayer *>(comp.layer(5, label));
    const float cells[16] = {0, 0, 0.0625f, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0};
    ll->set_uniform("u_cells", UniformType::Vec4, cells, 4);
    const bool bound = comp.bind(5, label, 0, "u_atlas", glyphs, &err) && comp.bind(5, label, 0, "u_sprite", sprite, &err);

    LayerParams cp;
    cp.rect.x = 660; cp.rect.y = 120; cp.rect.w = 600; cp.rect.h = 480;
    MeshParams mp;
    mp.camera.t[2] = 6;
    const uint32_t box = comp.add_mesh(5, 1, cp, mp, now, &err);
    MeshLayer *ml = static_cast<MeshLayer *>(comp.layer(5, box));
    const bool parted = comp.add_part(5, box, 1, kLitVs, kLitFs, PartLook(), 0, &err) &&
                        comp.geometry(5, box, 1, cube_mesh(), now, &err);
    const float orange[4] = {1, 0.45f, 0, 1};
    ml->set_uniform(1, "u_color", orange, 4);
    Pose tilt;
    tilt.r[0] = 25;
    ml->set_pose(1, tilt);
    const bool spinning = ml->animate(1, 1, keyed(Animated::Rotate, 3, {0, 6000}, {25, 0, 0, 25, 360, 0}), &err);

    LayerParams np;
    np.klass = Klass::Overlay;
    np.rect.x = 1500; np.rect.y = 160; np.rect.w = 24; np.rect.h = 240;
    np.rotate = -120;
    np.pivot_x = np.pivot_y = true;
    np.px = 12; np.py = 228;
    const uint32_t needle = comp.add_image(5, 1, np, 24, 240, 30, Sampling::Bilinear, now, &err);
    std::vector<uint8_t> npx(24 * 240 * 4, 220);
    static_cast<ImageLayer *>(comp.layer(5, needle))->update({}, npx.data(), npx.size(), &err);
    const bool sweeping = comp.layer(5, needle)->animate(1, 0, keyed(Animated::Rotate, 1, {0, 3000, 6000}, {-120, 120, -120}), &err);

    LayerParams pp;
    pp.klass = Klass::Ambient;
    const uint32_t plasma = comp.add_effect(5, 1, pp, "", kPlasma, 0, now, &err);
    static_cast<EffectLayer *>(comp.layer(5, plasma))->cluster_time();
    ok("assets, a mesh layer with a lit cube, a turned needle and a clock effect",
       glyphs && sprite && label && bound && box && parted && spinning && needle && sweeping && plasma);
    run(1500);
    auto all_shown = [&]() {
        for (uint32_t id : {label, box, needle, plasma})
            if (comp.state(id, &reason) != LayerState::Shown) {
                std::printf("     layer %u: %s %s\n", id, layer_state_name(comp.state(id, &reason)), reason.c_str());
                return false;
            }
        return true;
    };
    ok("all shown", all_shown());
    run(1100);
    ok("the cube's geometry replaced a second later", comp.geometry(5, box, 1, cube_mesh(), now, &err));
    run(200);
    port.steal(p);
    run(500);
    port.free_slot(p);   /* the HMI's content gone again */
    run(2500);
    ok("the panel taken and published again: assets, binds, parts and animations back", all_shown());
    comp.layer(5, needle)->stop(1);
    comp.touch(comp.layer(5, needle));
    run(100);
    comp.remove_owner(5);
    run(4000);
    ok("all gone: the panel released", slots.status(1).state == TargetState::Idle);

#ifndef CRS_RAMSES27
    /* The synthetic scene file on the panel, through the compositor. */
    SceneSource src;
    src.file = gauge;
    src.res = {gauge_res};
    const uint32_t sc = comp.add_scene(6, 1, src, false, &err);
    SceneEdits *ed = comp.edits(6, sc);
    const std::vector<EditProblem> refused =
        ed->add("--rotate ^needle_pivot$=0,0,45\n--uniform ^needle$:u_color=1,0,0,1\n--set level=0.75\n"
                "--hide ^quad$\n--viewport ^main_cam$=0,0,960,360\n--pass-off ^glow_pass$\n--uniform ^bar$:u_level=1");
    run(1500);
    const size_t resources = resource_count(client, gpu.types().resource);
    const std::vector<EditProblem> problems = ed->take_problems();
    ok("the scene file loaded as the panel's scene, every edit kind applied in its first flush",
       sc && refused.empty() && comp.state(sc, &reason) == LayerState::Shown && gauge_edited(client, 45));
    ok("a uniform bound to a data object refused, reported", problems.size() == 1 &&
                                                                 problems[0].reason.find("bound to a data object") != std::string::npos);
    std::set<uint32_t> uniforms(gpu.types().uniform, gpu.types().uniform + 11);
    uniforms.insert(gpu.types().sampler2d);
    uniforms.insert(gpu.types().sampler_cube);
    const std::set<uint32_t> datas(gpu.types().data, gpu.types().data + 5);
    ok("twelve uniform types (one for both kinds of sampler) and five data object types learned, each different",
       uniforms.size() == 12 && gpu.types().sampler2d == gpu.types().sampler_cube && datas.size() == 5 && !uniforms.count(0) && !datas.count(0));
    ok("the two kinds of animation system and the sequence learned, each different: sequences can be played",
       gpu.types().system && gpu.types().realtime && gpu.types().sequence &&
           gpu.types().system != gpu.types().realtime && gpu.sequences());
    for (int i = 0; i <= 30; i++) {
        ed->add("--rotate ^needle_pivot$=0,0," + std::to_string(i * 3));
        run(33);
    }
    ok("the needle turned at 30 edits a second", gauge_edited(client, 90) && comp.state(sc, &reason) == LayerState::Shown);

    /* The file's sequence played by edit lines (save_gauge: read back on the
     * client), on the library's own clock. */
    {
        ramses::AnimationSystemRealTime *clock = gauge_object<ramses::AnimationSystemRealTime>(client, "gauge_clock");
        ramses::DataFloat *swept = gauge_object<ramses::DataFloat>(client, "swept");
        auto value = [&]() {
            float v = -1;
            return clock && swept && ok_status(clock->updateLocalTime()) && ok_status(swept->getValue(v)) ? v : -1.0f;
        };
        ed->add("--play sweep");
        run(100);
        usleep(300 * 1000);
        const float mid = value();
        ed->add("--skip sweep");
        run(100);
        const float end = value();
        ed->add("--play sweep");
        run(100);
        const float again = value();
        ed->add("--play nowhere");
        run(100);
        const std::vector<EditProblem> unknown = ed->take_problems();
        std::printf("     swept %g 300 ms after --play, %g after --skip, %g after --play again\n", mid, end, again);
        ok("the file's animation sequence: played, skipped to its end, played again from its start, an unknown one "
           "reported; the scene still described",
           mid > 0 && mid < 10 && end == 10 && again < mid && unknown.size() == 1 &&
               unknown[0].reason.find("no animation sequence nowhere") != std::string::npos && described("gauge"));
    }
    /* A sequence of a system without a clock of its own: its time set by
     * the service once a tick, on the compositor's clock. */
    {
        ramses::AnimationSystem *sys = gauge_object<ramses::AnimationSystem>(client, "gauge_driven");
        ramses::DataFloat *driven = gauge_object<ramses::DataFloat>(client, "driven");
        auto value = [&]() {
            float v = -1;
            return driven && ok_status(driven->getValue(v)) ? v : -1.0f;
        };
        ed->add("--play drive");
        run(500);
        const float mid = value();
        run(1000);
        const float end = value();
        const uint64_t at_end = sys ? sys->getTime() : 0;
        ed->add("--play drive");
        run(100);
        const float again = value();
        ed->add("--skip drive");
        run(100);
        const float skipped = value();
        std::printf("     driven %g 500 ms after --play, %g at its end (its system at %llu ms), %g after --play "
                    "again, %g after --skip\n",
                    mid, end, (unsigned long long)at_end, again, skipped);
        ok("a sequence the service sets the time of: played on its ticks, held at its end, played again from its "
           "start, skipped to its end; the scene still described",
           mid > 2 && mid < 8 && end == 10 && at_end >= 601000 && again < mid && skipped == 10 && described("gauge"));
    }

    /* Published again: the HUD (the panel's scene id) shown while the HMI holds the panel. */
    port.steal(p);
    run(200);
    LayerParams hp;
    const uint32_t hud = comp.add_effect(7, 2, hp, "", kBars, 0, now, &err);
    run(1500);
    ok("the HUD shown meanwhile: the scene file's scene destroyed",
       slots.status(2).state == TargetState::Shown && !client.findObjectByName("gauge"));
    comp.remove_owner(7);
    run(1000);
    port.free_slot(p);
    run(2500);
    ok("the panel published again: the file loaded again with every kept edit, no resource more than the first time",
       hud && comp.state(sc, &reason) == LayerState::Shown && gauge_edited(client, 90) &&
           resource_count(client, gpu.types().resource) == resources);

    SceneSource second;
    second.file = gauge2;
    second.res = {gauge2_res};
    const int requests = port.requests;
    comp.replace_scene(6, sc, second, false);
    ed->add("--rotate ^needle_pivot$=0,0,60\n--uniform ^needle$:u_color=1,0,0,1\n--set level=0.75\n"
            "--hide ^quad$\n--viewport ^main_cam$=0,0,960,360\n--pass-off ^glow_pass$");
    run(500);
    ok("another file in place: loaded and edited, the slot not asked for again, no resource more",
       comp.state(sc, &reason) == LayerState::Shown && gauge_edited(client, 60) && port.requests == requests &&
           resource_count(client, gpu.types().resource) == resources);

    /* Layers over the file: a video and an effect drawn in its scene, in
     * passes after its own (main_pass 0, glow_pass 1), its edits with them. */
    SceneLayers over;
    over.on = true;
    comp.set_layers(sc, over);
    comp.replace_scene(6, sc, second, false);
    LayerParams hv;
    hv.rect.x = 700; hv.rect.y = 160; hv.rect.w = 560; hv.rect.h = 400;
    VideoParams hvp;
    hvp.w = 560;
    hvp.h = 400;
    const uint32_t hosted = comp.add_video(8, 1, hv, hvp, now, &err);
    LayerParams fp;
    fp.klass = Klass::Overlay;
    fp.rect = hv.rect;
    const uint32_t edge = comp.add_effect(8, 1, fp, "", kBars, 0, now, &err);
    VideoLayer *hvideo = static_cast<VideoLayer *>(comp.layer(8, hosted));
    std::vector<uint8_t> hatlas(hvideo->frame_bytes());
    for (int i = 0; i < 30; i++) {
        for (size_t k = 0; k < hatlas.size(); k++)
            hatlas[k] = (uint8_t)(k / 7 + i * 5);
        hvideo->offer(hatlas.data(), now);
        if (i == 10)
            ed->add("--rotate ^needle_pivot$=0,0,30\n--uniform ^needle$:u_color=1,0,0,1\n--set level=0.75\n"
                    "--hide ^quad$\n--viewport ^main_cam$=0,0,960,360\n--pass-off ^glow_pass$");
        run(33);
    }
    run(500);
    const ramses::RenderPass *lp0 = gauge_object<ramses::RenderPass>(client, "cluster-render layers");
    ok("layers over the file: a video and an effect drawn in its scene from render order 2, its edits flushed with them",
       comp.state(sc, &reason) == LayerState::Shown && comp.state(hosted, &reason) == LayerState::Shown &&
           comp.state(edge, &reason) == LayerState::Shown && lp0 && lp0->getRenderOrder() == 2 &&
           gauge_edited(client, 30));
#ifndef CRS_RAMSES27
    /* A value over the file: made in its scene, the effect's u_level
     * linked to it. */
    const float over_level = 0.5f;
    const uint32_t over_value = comp.add_value(8, 1, 1, &over_level, &err);
    run(100);
    const bool over_linked = over_value && comp.link(8, edge, 0, "u_level", over_value, &err);
    run(100);
    ok("layers over the file: a value made in its scene, an effect's uniform linked to it",
       over_linked && comp.linked(8, edge, 0, "u_level") && comp.state(edge, &reason) == LayerState::Shown);
    if (!over_linked)
        std::printf("     %s\n", err.c_str());
#endif
    comp.remove_owner(8);
    run(500);
    ok("the layers gone, the file stays", comp.state(sc, &reason) == LayerState::Shown && client.findObjectByName("gauge"));
    comp.remove_owner(6);
    run(1500);
    ok("dropped: the panel released, the scene and the resources its load made gone",
       slots.status(1).state == TargetState::Idle && !client.findObjectByName("gauge") &&
           resource_count(client, gpu.types().resource) < resources);

    SceneSource wrong;
    wrong.file = other;
    wrong.res = {other_res};
    const uint32_t bad = comp.add_scene(6, 1, wrong, false, &err);
    run(500);
    ok("a file of another scene id refused, nothing left of it",
       bad && comp.state(bad, &reason) == LayerState::Error && reason.find("scene id is 0x10004f9") != std::string::npos &&
           !client.findObjectByName("gauge"));
    comp.remove_owner(6);
    run(500);
    const int removed = std::system(("rm -rf " + dir).c_str());
    (void)removed;
#endif
    ok("nothing logged as an error", cld::log_errors == 0);
    framework.disconnect();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
