/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* An asset: a texture a client uploads once and its effect layers and mesh
 * parts on the same target sample (bind). It is not drawn and not in the
 * layer stack, so it never makes its target wanted.
 *
 * Like an image layer it keeps its pixels on the CPU: a new scene of its
 * target gets a new buffer, written whole; a client's changes are written
 * in place in the rectangles that changed. Its writes are staged before the
 * layers' in the same flush and spend the shared byte budget. A failed
 * write leaves the buffer unlike the asset (unclean) until it is written
 * whole again; the layers sampling it are not drawn meanwhile.
 *
 * An etc2rgba or etc2rgb asset (compressed) and a cube map are immutable:
 * sent whole, once, and each scene of its target gets an immutable texture
 * made from it at the asset's first stage there. No rectangles, no scratch.
 * A texture the renderer refuses leaves the asset refused().
 *
 * Sampled with mipmaps (sampling_mips()), an asset has every mip level down
 * to 1x1. An rgba8 or r8 asset's levels are made here from its pixels (each
 * pixel of a level the mean of four of the level above; RGBA weighted by
 * alpha, so transparent pixels lend no colour), again in the rectangles a
 * change touches, and written with them. They are made when a write goes
 * (stage()), not as messages come: however fast a client sends, the levels
 * are made no more often than the upload budget writes them. A compressed
 * asset's come from the client, after its picture, in its one frame. */
#ifndef CRS_ASSET_H
#define CRS_ASSET_H

#include <stdint.h>
#include <string>
#include <vector>

#include "dirty_tiles.h"
#include "graph.h"
#include "layer.h"
#include "upload_pacer.h"

namespace crs {

struct AssetParams {
    TexFormat format = TexFormat::RGBA8;
    uint32_t w = 0, h = 0;
    Sampler sampler;
    /* A cube map (PROTOCOL.md "Cube maps"): w x w faces, six of them. */
    bool cube = false;
    /* Its mip levels: 1, or every level (graph.h mip_levels) when sampled
     * with mipmaps; a cube map has none. */
    uint32_t levels() const { return !cube && sampling_mips(sampler.sampling) ? mip_levels(format, w, h) : 1; }
    /* Its pixels, mip levels and faces included. */
    size_t bytes() const { return tex_chain_bytes(format, w, h, levels()) * (cube ? 6 : 1); }
    /* Sent whole and once, made at its first stage in a scene. */
    bool immutable() const { return cube || tex_compressed(format); }
};

class Asset {
public:
    static const uint32_t kMaxRects = 16;   /* more pending: written whole */

    Asset(uint32_t id, int target, crk::UploadPacer &pacer, const AssetParams &p);
    /* Why such an asset cannot be: it must fit one frame message (a
     * compressed one with its mip levels, a cube map with its six faces),
     * and a cube map's faces are square, without mip levels. */
    static const char *size_error(const AssetParams &p);

    uint32_t id() const { return id_; }
    int target() const { return target_; }
    const AssetParams &params() const { return p_; }
    uint32_t bpp() const { return p_.format == TexFormat::R8 ? 1 : 4; }
    /* Sent whole and once: compressed, or a cube map. */
    bool immutable() const { return p_.immutable(); }
    /* Its pixels, mip levels and faces included. */
    size_t bytes() const { return p_.bytes(); }
    /* What it holds of the service's pixel memory: its pixels, mip levels
     * and faces, and a rectangle scratch as large unless immutable. */
    uint64_t memory() const { return memory(p_); }
    static uint64_t memory(const AssetParams &p)
    {
        return (uint64_t)p.bytes() * (p.immutable() ? 1 : 2);
    }
    /* Why the renderer refused its texture; empty when it did not. */
    const std::string &refused() const { return refused_; }

    /* Rectangles of new pixels, each's rows packed one after another;
     * none: data is the whole asset. False with *err when a rectangle is
     * outside it or data does not match. */
    bool update(const std::vector<crk::PixelRect> &rects, const uint8_t *data, size_t n, std::string *err);
    bool have() const { return have_; }

    /* Its buffer in a published scene; false when refused. */
    bool attach(Graph *g);
    /* The scene goes, or the asset: dropped from the scene first when drop. */
    void detach(bool drop);
    bool attached() const { return g_ != nullptr; }
    int buffer() const { return buf_; }
    /* The buffer holds the asset whole. */
    bool clean() const { return g_ && clean_; }

    /* Writes what changed, when the budget allows; the caller flushes. */
    Stage stage(int64_t now_ms);
    void committed(bool ok);
    size_t staged_bytes() const { return staged_; }
    std::string stats() const;

private:
    uint32_t id_;
    int target_;
    crk::UploadPacer &pacer_;
    AssetParams p_;
    /* Makes the mip levels under level 0's rects (none: all of them) and
     * notes each level's rects to write. */
    void make_mips(const std::vector<crk::PixelRect> &rects);

    std::vector<uint8_t> px_, scratch_;
    std::vector<std::vector<uint8_t>> mips_;                /* levels 1 and up, uncompressed */
    std::vector<std::vector<crk::PixelRect>> mip_dirty_;   /* their rects to write, as dirty_ */
    /* Level 0's changes the levels do not have yet: rects, or all of it. */
    std::vector<crk::PixelRect> mips_stale_;
    bool mips_stale_all_ = false;
    std::string refused_;
    std::vector<crk::PixelRect> dirty_;
    bool whole_ = true, have_ = false, clean_ = false, staged_whole_ = false;
    Graph *g_ = nullptr;
    int buf_ = 0;
    size_t staged_ = 0;
    uint64_t writes_ = 0, bytes_ = 0, failed_ = 0;
};

}  // namespace crs

#endif
