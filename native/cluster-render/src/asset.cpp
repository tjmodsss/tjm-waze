/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "asset.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "cluster_render/protocol.h"
#include "log.h"

namespace crs {

Asset::Asset(uint32_t id, int target, crk::UploadPacer &pacer, const AssetParams &p)
    : id_(id), target_(target), pacer_(pacer), p_(p),
      px_(p.immutable() ? p.bytes() : tex_bytes(p.format, p.w, p.h), 0)
{
    if (!immutable())
        for (uint32_t l = 1; l < p_.levels(); l++) {
            mips_.push_back(std::vector<uint8_t>(tex_level_bytes(p_.format, p_.w, p_.h, l), 0));
            mip_dirty_.push_back({});
        }
}

const char *Asset::size_error(const AssetParams &p)
{
    const TexFormat f = p.format;
    const uint32_t w = p.w, h = p.h;
    if (w < 1 || h < 1)
        return "an asset is at least 1x1";
    if (w > 2048 || h > 2048)
        return "an asset is at most 2048x2048";
    if (tex_compressed(f) && (w % 4 || h % 4))
        return f == TexFormat::ETC2RGB ? "an etc2rgb asset's w and h are multiples of 4"
                                       : "an etc2rgba asset's w and h are multiples of 4";
    if (tex_bytes(f, w, h) + 64 > cr::kMaxMessage)
        return "an asset's pixels must fit one frame message (5,529,600 bytes)";
    if (tex_compressed(f) && tex_chain_bytes(f, w, h, p.levels()) + 64 > cr::kMaxMessage)
        return "an asset's pixels and mip levels must fit one frame message (5,529,600 bytes)";
    if (p.cube && w != h)
        return "a cube map's faces are square: w and h the same";
    if (p.cube && sampling_mips(p.sampler.sampling))
        return "a cube map has no mip levels";
    if (p.cube && p.bytes() + 64 > cr::kMaxMessage)
        return "a cube map's six faces must fit one frame message (5,529,600 bytes)";
    if (p.sampler.anisotropy < 1 || p.sampler.anisotropy > 16)
        return "anisotropy is 1 to 16";
    return nullptr;
}

bool Asset::update(const std::vector<crk::PixelRect> &rects, const uint8_t *data, size_t n, std::string *err)
{
    const uint32_t b = bpp();
    const std::string what = p_.cube ? std::string("a cube map") : std::string("an ") + tex_format_name(p_.format) + " asset";
    if (immutable() && !rects.empty()) {
        *err = what + " is sent whole, with no rects";
        return false;
    }
    if (immutable() && have_) {
        *err = what + " is sent once";
        return false;
    }
    if (rects.empty()) {
        if (n != px_.size()) {
            *err = "a whole asset is " + std::to_string(px_.size()) + " bytes";
            return false;
        }
        std::memcpy(px_.data(), data, n);
        whole_ = true;
        dirty_.clear();
        have_ = true;
        mips_stale_all_ = p_.levels() > 1;
        mips_stale_.clear();
        return true;
    }
    size_t need = 0;
    for (const crk::PixelRect &r : rects) {
        if (r.w == 0 || r.h == 0 || r.x + r.w > p_.w || r.y + r.h > p_.h || r.x + r.w < r.x || r.y + r.h < r.y) {
            *err = "rectangle outside the asset";
            return false;
        }
        need += (size_t)r.w * r.h * b;
    }
    if (n != need) {
        *err = "rectangles need " + std::to_string(need) + " bytes";
        return false;
    }
    for (const crk::PixelRect &r : rects) {
        for (uint32_t y = 0; y < r.h; y++)
            std::memcpy(&px_[((size_t)(r.y + y) * p_.w + r.x) * b], data + (size_t)y * r.w * b, (size_t)r.w * b);
        data += (size_t)r.w * r.h * b;
        if (!whole_) {
            if (dirty_.size() >= kMaxRects) {
                whole_ = true;
                dirty_.clear();
            } else {
                dirty_.push_back(r);
            }
        }
    }
    have_ = true;
    if (p_.levels() > 1 && !mips_stale_all_) {
        if (mips_stale_.size() + rects.size() > kMaxRects) {
            mips_stale_all_ = true;
            mips_stale_.clear();
        } else {
            mips_stale_.insert(mips_stale_.end(), rects.begin(), rects.end());
        }
    }
    return true;
}

namespace {

/* Level l's pixels under level l - 1's rect r: half its size, rounded
 * out, within the level. */
crk::PixelRect halved(const crk::PixelRect &r, uint32_t lw, uint32_t lh)
{
    crk::PixelRect o;
    o.x = std::min(r.x / 2, lw - 1);
    o.y = std::min(r.y / 2, lh - 1);
    o.w = std::min((r.x + r.w - 1) / 2, lw - 1) - o.x + 1;
    o.h = std::min((r.y + r.h - 1) / 2, lh - 1) - o.y + 1;
    return o;
}

/* (n + a / 2) / a for the alpha sums a of four pixels (1-1020) and
 * n < 2^19: n times ceil(2^32 / a), the top 32 bits. Exact: the product's
 * error, under n / 2^32 < 2^-13, is less than the 1 / a a quotient's
 * fraction is from the next whole number. */
struct Reciprocals {
    uint64_t r[1021];
    Reciprocals()
    {
        r[0] = 0;
        for (uint32_t a = 1; a < 1021; a++)
            r[a] = ((1ull << 32) + a - 1) / a;
    }
};
const Reciprocals kRecip;
inline uint8_t divide(uint32_t n, uint32_t a) { return (uint8_t)(((uint64_t)n * kRecip.r[a]) >> 32); }

/* dst's rect r (dw wide) from src (sw x sh): each pixel the mean of the
 * 2x2 above it, clamped to src. RGBA weights colour by alpha. */
void reduce(const uint8_t *src, uint32_t sw, uint32_t sh, uint8_t *dst, uint32_t dw, uint32_t bpp,
            const crk::PixelRect &r)
{
    for (uint32_t y = r.y; y < r.y + r.h; y++)
        for (uint32_t x = r.x; x < r.x + r.w; x++) {
            const uint32_t x0 = std::min(2 * x, sw - 1), x1 = std::min(2 * x + 1, sw - 1);
            const uint32_t y0 = std::min(2 * y, sh - 1), y1 = std::min(2 * y + 1, sh - 1);
            const uint8_t *p[4] = {src + ((size_t)y0 * sw + x0) * bpp, src + ((size_t)y0 * sw + x1) * bpp,
                                   src + ((size_t)y1 * sw + x0) * bpp, src + ((size_t)y1 * sw + x1) * bpp};
            uint8_t *o = dst + ((size_t)y * dw + x) * bpp;
            if (bpp == 1) {
                o[0] = (uint8_t)((p[0][0] + p[1][0] + p[2][0] + p[3][0] + 2) / 4);
                continue;
            }
            const uint32_t a = p[0][3] + p[1][3] + p[2][3] + p[3][3];
            for (int ch = 0; ch < 3; ch++) {
                if (a) {
                    const uint32_t sum = p[0][ch] * p[0][3] + p[1][ch] * p[1][3] + p[2][ch] * p[2][3] + p[3][ch] * p[3][3];
                    o[ch] = divide(sum + a / 2, a);
                } else {
                    o[ch] = (uint8_t)((p[0][ch] + p[1][ch] + p[2][ch] + p[3][ch] + 2) / 4);
                }
            }
            o[3] = (uint8_t)((a + 2) / 4);
        }
}

}  // namespace

void Asset::make_mips(const std::vector<crk::PixelRect> &rects)
{
    std::vector<crk::PixelRect> above = rects;
    if (above.empty())
        above.push_back(crk::PixelRect{0, 0, p_.w, p_.h});
    const uint32_t b = bpp();
    for (uint32_t l = 1; l < p_.levels(); l++) {
        const uint32_t sw = mip_size(p_.w, l - 1), sh = mip_size(p_.h, l - 1);
        const uint32_t lw = mip_size(p_.w, l), lh = mip_size(p_.h, l);
        const uint8_t *src = l == 1 ? px_.data() : mips_[l - 2].data();
        std::vector<crk::PixelRect> here;
        for (const crk::PixelRect &r : above) {
            here.push_back(halved(r, lw, lh));
            reduce(src, sw, sh, mips_[l - 1].data(), lw, b, here.back());
        }
        if (!whole_) {
            std::vector<crk::PixelRect> &d = mip_dirty_[l - 1];
            d.insert(d.end(), here.begin(), here.end());
        }
        above = here;
    }
}

bool Asset::attach(Graph *g)
{
    if (immutable()) {   /* its texture is made at its first stage, from its pixels */
        g_ = g;
        buf_ = 0;
        clean_ = false;
        return true;
    }
    g_ = g;
    buf_ = g->buffer(p_.format, p_.w, p_.h, p_.sampler, p_.levels());
    if (!buf_) {
        g_ = nullptr;
        log_error("asset %u: %ux%u buffer of %u levels refused", id_, p_.w, p_.h, p_.levels());
        return false;
    }
    whole_ = true;   /* a new buffer holds nothing yet */
    clean_ = false;
    dirty_.clear();
    for (auto &d : mip_dirty_)
        d.clear();
    return true;
}

void Asset::detach(bool drop)
{
    if (g_ && drop && buf_)
        g_->drop_buffer(buf_);
    g_ = nullptr;
    buf_ = 0;
    clean_ = false;
    whole_ = true;
    dirty_.clear();
    for (auto &d : mip_dirty_)
        d.clear();
    staged_ = 0;
}

Stage Asset::stage(int64_t now_ms)
{
    staged_ = 0;
    if (immutable()) {
        /* Made once a scene; flushed again until a flush carries it. */
        if (!g_ || !have_ || clean_ || !refused_.empty() || !pacer_.ready(now_ms))
            return Stage::Idle;
        if (!buf_) {
            buf_ = p_.cube ? g_->cube_texture(p_.format, p_.w, p_.sampler, px_.data(), px_.size() / 6)
                           : g_->immutable_texture(p_.format, p_.w, p_.h, p_.sampler, p_.levels(), px_.data(),
                                                   px_.size());
            if (!buf_) {
                refused_ = "the renderer refused its " + std::to_string(p_.w) + "x" + std::to_string(p_.h) + " " +
                           tex_format_name(p_.format) + (p_.cube ? " cube map" : " texture");
                if (p_.levels() > 1)
                    refused_ += " of " + std::to_string(p_.levels()) + " mip levels";
                log_error("asset %u: %s", id_, refused_.c_str());
                return Stage::Idle;
            }
            log_info("asset %u: %ux%u %s texture made, %zu bytes", id_, p_.w, p_.h, tex_format_name(p_.format),
                     px_.size());
            staged_ = px_.size();
            pacer_.spend(staged_);
        }
        staged_whole_ = true;
        return Stage::Wrote;
    }
    if (!g_ || !have_ || (!whole_ && dirty_.empty()) || !pacer_.ready(now_ms))
        return Stage::Idle;
    if (mips_stale_all_ || !mips_stale_.empty()) {
        make_mips(mips_stale_all_ ? std::vector<crk::PixelRect>() : mips_stale_);
        mips_stale_all_ = false;
        mips_stale_.clear();
    }
    const std::vector<crk::PixelRect> all{crk::PixelRect{0, 0, p_.w, p_.h}};
    bool written = true;
    staged_whole_ = whole_;
    staged_ = crk::write_rects(
        px_.data(), p_.w, bpp(), whole_ ? all : dirty_, &scratch_,
        [this](const uint8_t *px, const crk::PixelRect &r) { return g_->write(buf_, r.x, r.y, r.w, r.h, px); },
        &written);
    for (uint32_t l = 1; written && l < p_.levels(); l++) {
        const uint32_t lw = mip_size(p_.w, l), lh = mip_size(p_.h, l);
        const std::vector<crk::PixelRect> level{crk::PixelRect{0, 0, lw, lh}};
        staged_ += crk::write_rects(
            mips_[l - 1].data(), lw, bpp(), whole_ ? level : mip_dirty_[l - 1], &scratch_,
            [this, l](const uint8_t *px, const crk::PixelRect &r) {
                return g_->write_level(buf_, l, r.x, r.y, r.w, r.h, px);
            },
            &written);
    }
    /* Charged at once: the layers staged after it see what is left. */
    pacer_.spend(staged_);
    if (!written)
        clean_ = false;
    return written ? Stage::Wrote : Stage::Failed;
}

void Asset::committed(bool ok)
{
    if (immutable()) {
        if (ok) {
            writes_++;
            bytes_ += staged_;
            clean_ = true;
        } else {
            failed_++;
        }
        staged_ = 0;
        return;
    }
    if (ok) {
        writes_++;
        bytes_ += staged_;
        whole_ = false;
        if (staged_whole_)
            clean_ = true;
    } else {
        failed_++;
        whole_ = true;
        clean_ = false;
    }
    dirty_.clear();
    for (auto &d : mip_dirty_)
        d.clear();
    staged_ = 0;
}

std::string Asset::stats() const
{
    char b[96];
    std::snprintf(b, sizeof b, "%llu writes, %llu KB, %llu failed", (unsigned long long)writes_,
                  (unsigned long long)(bytes_ / 1024), (unsigned long long)failed_);
    return b;
}

}  // namespace crs
