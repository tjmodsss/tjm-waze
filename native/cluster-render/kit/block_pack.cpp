/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
#include "block_pack.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <system_error>
#include <thread>

#if defined(__SSE2__)
#include <emmintrin.h>
#endif

namespace crk {

/* Pixel p = floor(v_uv * u_size), as the atlas shader places it (row 0 at
 * the top). Its block's two texels are fetched at their centres; every value
 * is an integer held exactly in a highp float, so floor, mod and the powers
 * of two below are exact. */
const char *const kBlockFragmentShader = R"(#version 100
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_size;
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
void main() {
    vec2 p = clamp(floor(v_uv * u_size), vec2(0.0), u_size - 1.0);
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
    vec3 c = sel < 0.5 ? c0 : sel < 1.5 ? c1 : sel < 2.5 ? (2.0 * c0 + c1) / 3.0 : (c0 + 2.0 * c1) / 3.0;
    gl_FragColor = vec4(c, u_opacity);
})";

namespace {

uint8_t clamp_level(double v)
{
    return (uint8_t)std::lround(v < 0 ? 0 : v > 255 ? 255 : v);
}

uint8_t clamp_int(int v)
{
    return (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v);
}

/* Row y of the picture as RGB planes r, g, b (w bytes each), the atlas
 * shader's way: chroma bilinear at (x / 2, y / 2 - 1/4) in its plane, edges
 * clamped, which comes to fixed weights (an even x takes a sample, an odd
 * one the mean of two; a row takes 3/4 of its chroma row and 1/4 of the one
 * above or below), then full-range BT.601 in 16-bit fixed point on 8 x the
 * chroma (each coefficient x 65536 / 8, rounded half up). cu and cv are
 * scratch of w / 2 + 1. simd: the SSE2 path where there is one; both give
 * the same bytes. */
void rgb_row(const uint8_t *atlas, uint32_t w, uint32_t h, uint32_t y, int16_t *cu, int16_t *cv, uint8_t *r,
             uint8_t *g, uint8_t *b, bool simd)
{
    const uint32_t cw = w / 2, ch = h / 2;
    const uint8_t *uplane = atlas + (size_t)w * h, *vplane = uplane + cw;   /* U | V side by side, w apart */
    const uint32_t k = y / 2;
    const uint32_t other = y % 2 ? std::min(k + 1, ch - 1) : (k ? k - 1 : 0);
    const uint8_t *u3 = uplane + (size_t)k * w, *u1 = uplane + (size_t)other * w;
    const uint8_t *v3 = vplane + (size_t)k * w, *v1 = vplane + (size_t)other * w;
    const uint8_t *yrow = atlas + (size_t)y * w;
    uint32_t j = 0;
#if defined(__SSE2__)
    if (simd) {
        const __m128i zero = _mm_setzero_si128();
        for (; j + 8 <= cw; j += 8) {
            const __m128i a = _mm_unpacklo_epi8(_mm_loadl_epi64(reinterpret_cast<const __m128i *>(u3 + j)), zero);
            const __m128i c = _mm_unpacklo_epi8(_mm_loadl_epi64(reinterpret_cast<const __m128i *>(u1 + j)), zero);
            const __m128i d = _mm_unpacklo_epi8(_mm_loadl_epi64(reinterpret_cast<const __m128i *>(v3 + j)), zero);
            const __m128i e = _mm_unpacklo_epi8(_mm_loadl_epi64(reinterpret_cast<const __m128i *>(v1 + j)), zero);
            _mm_storeu_si128(reinterpret_cast<__m128i *>(cu + j), _mm_add_epi16(_mm_add_epi16(a, _mm_add_epi16(a, a)), c));
            _mm_storeu_si128(reinterpret_cast<__m128i *>(cv + j), _mm_add_epi16(_mm_add_epi16(d, _mm_add_epi16(d, d)), e));
        }
    }
#endif
    /* 4 x the chroma column by column: 3 x this row + the other row */
    for (; j < cw; j++) {
        cu[j] = (int16_t)(3 * u3[j] + u1[j]);
        cv[j] = (int16_t)(3 * v3[j] + v1[j]);
    }
    cu[cw] = cu[cw - 1];
    cv[cw] = cv[cw - 1];
    j = 0;
#if defined(__SSE2__)
    if (simd) {
        /* 8 chroma columns, 16 pixels, at a time: each channel's term is a
         * pmaddwd of (chroma, 2) or (u, v) pairs with (coefficient, 16384)
         * or the two coefficients, + 32768 >> 16 exactly as below; the
         * saturating packs clamp. */
        const __m128i bias = _mm_set1_epi16(-1024), two = _mm_set1_epi16(2), round = _mm_set1_epi32(32768);
        const __m128i kr = _mm_set1_epi32(11485 | 16384 << 16), kb = _mm_set1_epi32(14516 | 16384 << 16);
        const __m128i kg = _mm_set1_epi32((-2819 & 0xffff) | -5850 * 65536);
        const __m128i lo_byte = _mm_set1_epi16(0xff);
        auto term = [](__m128i lo, __m128i hi, __m128i k, __m128i add) {
            return _mm_packs_epi32(_mm_srai_epi32(_mm_add_epi32(_mm_madd_epi16(lo, k), add), 16),
                                   _mm_srai_epi32(_mm_add_epi32(_mm_madd_epi16(hi, k), add), 16));
        };
        const __m128i zero32 = _mm_setzero_si128();
        for (; j + 8 <= cw; j += 8) {
            const __m128i c0 = _mm_loadu_si128(reinterpret_cast<const __m128i *>(cu + j));
            const __m128i c1 = _mm_loadu_si128(reinterpret_cast<const __m128i *>(cu + j + 1));
            const __m128i d0 = _mm_loadu_si128(reinterpret_cast<const __m128i *>(cv + j));
            const __m128i d1 = _mm_loadu_si128(reinterpret_cast<const __m128i *>(cv + j + 1));
            /* 8 x the chroma, less 8 x 128, at the even and the odd pixels */
            const __m128i ue = _mm_add_epi16(_mm_add_epi16(c0, c0), bias), uo = _mm_add_epi16(_mm_add_epi16(c0, c1), bias);
            const __m128i ve = _mm_add_epi16(_mm_add_epi16(d0, d0), bias), vo = _mm_add_epi16(_mm_add_epi16(d0, d1), bias);
            const __m128i yy = _mm_loadu_si128(reinterpret_cast<const __m128i *>(yrow + 2 * j));
            const __m128i ye = _mm_and_si128(yy, lo_byte), yo = _mm_srli_epi16(yy, 8);
            __m128i out[3];
            for (int c = 0; c < 3; c++) {
                __m128i te, to;
                if (c == 1) {
                    te = term(_mm_unpacklo_epi16(ue, ve), _mm_unpackhi_epi16(ue, ve), kg, round);
                    to = term(_mm_unpacklo_epi16(uo, vo), _mm_unpackhi_epi16(uo, vo), kg, round);
                } else {
                    const __m128i se = c == 0 ? ve : ue, so = c == 0 ? vo : uo, k = c == 0 ? kr : kb;
                    te = term(_mm_unpacklo_epi16(se, two), _mm_unpackhi_epi16(se, two), k, zero32);
                    to = term(_mm_unpacklo_epi16(so, two), _mm_unpackhi_epi16(so, two), k, zero32);
                }
                const __m128i e = _mm_add_epi16(ye, te), o = _mm_add_epi16(yo, to);
                out[c] = _mm_packus_epi16(_mm_unpacklo_epi16(e, o), _mm_unpackhi_epi16(e, o));
            }
            _mm_storeu_si128(reinterpret_cast<__m128i *>(r + 2 * j), out[0]);
            _mm_storeu_si128(reinterpret_cast<__m128i *>(g + 2 * j), out[1]);
            _mm_storeu_si128(reinterpret_cast<__m128i *>(b + 2 * j), out[2]);
        }
    }
#else
    (void)simd;
#endif
    /* 8 x the chroma, less 8 x 128: an even pixel twice its column, an odd
     * one its column and the next */
    for (; j < cw; j++)
        for (uint32_t odd = 0; odd < 2; odd++) {
            const int u = cu[j] + cu[j + odd] - 1024, v = cv[j] + cv[j + odd] - 1024, yy = yrow[2 * j + odd];
            r[2 * j + odd] = clamp_int(yy + ((11485 * v + 32768) >> 16));
            g[2 * j + odd] = clamp_int(yy + ((-2819 * u - 5850 * v + 32768) >> 16));
            b[2 * j + odd] = clamp_int(yy + ((14516 * u + 32768) >> 16));
        }
}

void to_rgb(const uint8_t *atlas, uint32_t w, uint32_t h, uint8_t *out, bool simd)
{
    std::vector<int16_t> cu(w / 2 + 1), cv(w / 2 + 1);
    std::vector<uint8_t> planes((size_t)w * 3);
    uint8_t *r = planes.data(), *g = r + w, *b = g + w;
    for (uint32_t y = 0; y < h; y++) {
        rgb_row(atlas, w, h, y, cu.data(), cv.data(), r, g, b, simd);
        uint8_t *o = out + (size_t)y * w * 3;
        for (uint32_t x = 0; x < w; x++) {
            o[3 * x] = r[x];
            o[3 * x + 1] = g[x];
            o[3 * x + 2] = b[x];
        }
    }
}

/* Quantising and expanding, tabled: round(v * max / 255) half up for a
 * level v, and round(q * 255 / max) for a 5- or 6-bit q. */
struct Tables {
    uint8_t to5[256], to6[256], from5[32], from6[64];
    Tables()
    {
        for (int v = 0; v < 256; v++) {
            to5[v] = (uint8_t)((v * 62 + 255) / 510);
            to6[v] = (uint8_t)((v * 126 + 255) / 510);
        }
        for (int q = 0; q < 32; q++)
            from5[q] = (uint8_t)((q * 255 + 15) / 31);
        for (int q = 0; q < 64; q++)
            from6[q] = (uint8_t)((q * 255 + 31) / 63);
    }
};
const Tables kT;

uint16_t to565(const int c[3])
{
    return (uint16_t)(kT.to5[c[0]] << 11 | kT.to6[c[1]] << 5 | kT.to5[c[2]]);
}

/* The 565 colour on the 0-255 scale, rounded. */
void expand565(uint16_t q, int c[3])
{
    c[0] = kT.from5[q >> 11];
    c[1] = kT.from6[(q >> 5) & 63];
    c[2] = kT.from5[q & 31];
}

/* A block's 16 pixels, row by row, as R, G and B. */
struct Block {
    uint8_t c[3][16];
};

/* Each pixel's place along c1 -> c0 as the number of thresholds it passes,
 * 1/6, 1/2 and 5/6 of the way (all 3 when c0 = c1). The count is also the
 * pixel's weight of c0 in thirds for the refit, and its selector is
 * kSelector[count]: c1, (c0 + 2 c1) / 3, (2 c0 + c1) / 3 or c0. */
const uint8_t kSelector[4] = {1, 3, 2, 0};

void counts(const Block &p, uint16_t q0, uint16_t q1, int16_t cnt[16], bool simd)
{
    int e0[3], e1[3];
    expand565(q0, e0);
    expand565(q1, e1);
    const int d0 = e0[0] - e1[0], d1 = e0[1] - e1[1], d2 = e0[2] - e1[2];
    const int dd = d0 * d0 + d1 * d1 + d2 * d2;
    if (dd <= 0) {
        std::fill(cnt, cnt + 16, (int16_t)3);
        return;
    }
    const int k = e1[0] * d0 + e1[1] * d1 + e1[2] * d2;   /* a pixel's dot is px . d - k */
#if defined(__SSE2__)
    if (simd) {
        /* pmaddwd of (r, g) with (d0, d1) and of (b, 0) with (d2, 0) */
        const __m128i zero = _mm_setzero_si128();
        const __m128i drg = _mm_set1_epi32((int)((uint32_t)(d0 & 0xffff) | (uint32_t)d1 << 16));
        const __m128i db = _mm_set1_epi32(d2 & 0xffff);
        const __m128i vk = _mm_set1_epi32(k), vdd = _mm_set1_epi32(dd), vdd5 = _mm_set1_epi32(5 * dd);
        for (int half = 0; half < 2; half++) {
            auto load = [&](int c) {
                return _mm_unpacklo_epi8(_mm_loadl_epi64(reinterpret_cast<const __m128i *>(p.c[c] + 8 * half)), zero);
            };
            const __m128i r = load(0), g = load(1), b = load(2);
            __m128i n[2];
            for (int q = 0; q < 2; q++) {
                const __m128i rg = q ? _mm_unpackhi_epi16(r, g) : _mm_unpacklo_epi16(r, g);
                const __m128i b0 = q ? _mm_unpackhi_epi16(b, zero) : _mm_unpacklo_epi16(b, zero);
                const __m128i dot = _mm_sub_epi32(_mm_add_epi32(_mm_madd_epi16(rg, drg), _mm_madd_epi16(b0, db)), vk);
                const __m128i dot2 = _mm_add_epi32(dot, dot), dot6 = _mm_add_epi32(dot2, _mm_add_epi32(dot2, dot2));
                /* each threshold passed is a -1 mask */
                n[q] = _mm_sub_epi32(_mm_sub_epi32(_mm_sub_epi32(zero, _mm_cmpgt_epi32(dot6, vdd)),
                                                   _mm_cmpgt_epi32(dot2, vdd)),
                                     _mm_cmpgt_epi32(dot6, vdd5));
            }
            _mm_storeu_si128(reinterpret_cast<__m128i *>(cnt + 8 * half), _mm_packs_epi32(n[0], n[1]));
        }
        return;
    }
#else
    (void)simd;
#endif
    for (int i = 0; i < 16; i++) {
        const int dot = p.c[0][i] * d0 + p.c[1][i] * d1 + p.c[2][i] * d2 - k;
        cnt[i] = (int16_t)((6 * dot > dd) + (2 * dot > dd) + (6 * dot > 5 * dd));
    }
}

void fit_block(const Block &p, uint8_t *out, bool simd)
{
    int lo = 0, hi = 0, llo = 1 << 30, lhi = -1, sum[3] = {0, 0, 0};
    for (int i = 0; i < 16; i++) {
        const int l = 77 * p.c[0][i] + 150 * p.c[1][i] + 29 * p.c[2][i];
        if (l < llo) { llo = l; lo = i; }
        if (l > lhi) { lhi = l; hi = i; }
        for (int c = 0; c < 3; c++)
            sum[c] += p.c[c][i];
    }
    const int chi[3] = {p.c[0][hi], p.c[1][hi], p.c[2][hi]}, clo[3] = {p.c[0][lo], p.c[1][lo], p.c[2][lo]};
    uint16_t q0 = to565(chi), q1 = to565(clo);
    int16_t cnt[16];
    counts(p, q0, q1, cnt, simd);
    /* Least squares for c0, c1 given the counts, in thirds: a pixel is
     * a/3 c0 + b/3 c1 with a its count and b = 3 - a, so A = sum a^2,
     * B = sum b^2, C = sum a b, P = sum a px, Q = sum b px. */
    int s1 = 0, s2 = 0, P[3] = {0, 0, 0};
    for (int i = 0; i < 16; i++) {
        const int a = cnt[i];
        s1 += a;
        s2 += a * a;
        for (int c = 0; c < 3; c++)
            P[c] += a * p.c[c][i];
    }
    const int A = s2, B = 16 * 9 - 6 * s1 + s2, C = 3 * s1 - s2;
    const int det = A * B - C * C;
    if (det != 0) {
        /* Each endpoint level is num / det; quantised to max levels it is
         * round(num * max / (255 det)), clamped. */
        auto q = [det](int num, int max) {
            const int den = 2 * 255 * det;
            const int v = num <= 0 ? 0 : (2 * max * num + 255 * det) / den;
            return v > max ? max : v;
        };
        int n0[3], n1[3];
        for (int c = 0; c < 3; c++) {
            const int Q = 3 * sum[c] - P[c];
            n0[c] = 3 * (B * P[c] - C * Q);
            n1[c] = 3 * (A * Q - C * P[c]);
        }
        q0 = (uint16_t)(q(n0[0], 31) << 11 | q(n0[1], 63) << 5 | q(n0[2], 31));
        q1 = (uint16_t)(q(n1[0], 31) << 11 | q(n1[1], 63) << 5 | q(n1[2], 31));
        counts(p, q0, q1, cnt, simd);
    }
    out[0] = (uint8_t)q0;
    out[1] = (uint8_t)(q0 >> 8);
    out[2] = (uint8_t)q1;
    out[3] = (uint8_t)(q1 >> 8);
    for (int r = 0; r < 4; r++)
        out[4 + r] = (uint8_t)(kSelector[cnt[r * 4]] | kSelector[cnt[r * 4 + 1]] << 2 | kSelector[cnt[r * 4 + 2]] << 4 |
                               kSelector[cnt[r * 4 + 3]] << 6);
}

/* Blocks bx0 .. bx1 - 1 of block rows by0 .. by1 - 1, block (bx, by) at
 * out + ((by - by0) * stride + bx - bx0) * 8. */
void pack_part(const uint8_t *atlas, uint32_t w, uint32_t h, uint32_t bx0, uint32_t bx1, uint32_t by0, uint32_t by1,
               uint8_t *out, size_t stride, bool simd)
{
    std::vector<uint8_t> planes((size_t)w * 4 * 3);   /* 4 rows of R, then of G, then of B */
    std::vector<int16_t> cu(w / 2 + 1), cv(w / 2 + 1);
    const size_t plane = (size_t)w * 4;
    for (uint32_t by = by0; by < by1; by++) {
        for (uint32_t j = 0; j < 4; j++) {
            uint8_t *r = planes.data() + (size_t)j * w;
            rgb_row(atlas, w, h, by * 4 + j, cu.data(), cv.data(), r, r + plane, r + 2 * plane, simd);
        }
        for (uint32_t bx = bx0; bx < bx1; bx++) {
            Block p;
            for (int c = 0; c < 3; c++)
                for (int j = 0; j < 4; j++)
                    std::memcpy(p.c[c] + 4 * j, planes.data() + c * plane + (size_t)j * w + bx * 4, 4);
            fit_block(p, out + ((size_t)(by - by0) * stride + (bx - bx0)) * 8, simd);
        }
    }
}

/* Block rows by0 .. by1 - 1. */
void pack_rows(const uint8_t *atlas, uint32_t w, uint32_t h, uint32_t by0, uint32_t by1, uint8_t *out, bool simd)
{
    const uint32_t bw = w / 4;
    pack_part(atlas, w, h, 0, bw, by0, by1, out + (size_t)by0 * bw * 8, bw, simd);
}

}  // namespace

void atlas_to_rgb(const uint8_t *atlas, uint32_t w, uint32_t h, uint8_t *out)
{
    to_rgb(atlas, w, h, out, true);
}

void atlas_to_rgb_scalar(const uint8_t *atlas, uint32_t w, uint32_t h, uint8_t *out)
{
    to_rgb(atlas, w, h, out, false);
}

void pack_blocks_scalar(const uint8_t *atlas, uint32_t w, uint32_t h, uint8_t *out)
{
    pack_rows(atlas, w, h, 0, h / 4, out, false);
}

void pack_blocks(const uint8_t *atlas, uint32_t w, uint32_t h, uint8_t *out, unsigned threads)
{
    const uint32_t rows = h / 4;
    const uint32_t n = std::max(1u, std::min(threads, rows));
    std::vector<std::thread> helpers;
    uint32_t t = 1;
    try {
        for (; t < n; t++)
            helpers.emplace_back(pack_rows, atlas, w, h, rows * t / n, rows * (t + 1) / n, out, true);
    } catch (const std::system_error &) {
        /* No thread to spare: this one packs the rows left. */
    }
    pack_rows(atlas, w, h, 0, rows / n, out, true);
    if (t < n)
        pack_rows(atlas, w, h, rows * t / n, rows, out, true);
    for (std::thread &helper : helpers)
        helper.join();
}

void pack_block_rect(const uint8_t *atlas, uint32_t w, uint32_t h, uint32_t bx0, uint32_t by0, uint32_t bx1,
                     uint32_t by1, uint8_t *out)
{
    pack_part(atlas, w, h, bx0, bx1, by0, by1, out, bx1 - bx0, true);
}

bool block_differs(const uint8_t *a, const uint8_t *b, uint32_t w, uint32_t h, uint32_t bx, uint32_t by)
{
    for (uint32_t y = 4 * by; y < 4 * by + 4; y++)
        if (std::memcmp(a + (size_t)y * w + 4 * bx, b + (size_t)y * w + 4 * bx, 4) != 0)
            return true;
    /* rgb_row's chroma: columns 2 bx to 2 bx + 2, rows 2 by - 1 to 2 by + 2,
     * each held inside its plane */
    const uint32_t cw = w / 2, ch = h / 2;
    const uint32_t c0 = 2 * bx, c1 = std::min(2 * bx + 2, cw - 1), r0 = by ? 2 * by - 1 : 0, r1 = std::min(2 * by + 2, ch - 1);
    for (uint32_t r = r0; r <= r1; r++) {
        const size_t u = (size_t)(h + r) * w + c0, v = u + cw;
        if (std::memcmp(a + u, b + u, c1 - c0 + 1) != 0 || std::memcmp(a + v, b + v, c1 - c0 + 1) != 0)
            return true;
    }
    return false;
}

void block_rgb(const uint8_t *packed, uint32_t w, uint32_t x, uint32_t y, uint8_t rgb[3])
{
    const uint8_t *b = packed + ((size_t)(y / 4) * (w / 4) + x / 4) * 8;
    const uint16_t q0 = (uint16_t)(b[0] | b[1] << 8), q1 = (uint16_t)(b[2] | b[3] << 8);
    double c0[3] = {(q0 >> 11) / 31.0, ((q0 >> 5) & 63) / 63.0, (q0 & 31) / 31.0};
    double c1[3] = {(q1 >> 11) / 31.0, ((q1 >> 5) & 63) / 63.0, (q1 & 31) / 31.0};
    const int s = (b[4 + y % 4] >> (2 * (x % 4))) & 3;
    for (int c = 0; c < 3; c++) {
        const double v = s == 0 ? c0[c] : s == 1 ? c1[c] : s == 2 ? (2 * c0[c] + c1[c]) / 3 : (c0[c] + 2 * c1[c]) / 3;
        rgb[c] = clamp_level(v * 255.0);
    }
}

}  // namespace crk
