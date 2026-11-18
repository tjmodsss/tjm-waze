/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the 4x4-block packing (block_pack.h): that the packer's RGB
 * is what the atlas shader draws; the byte layout the shader reads (through
 * its CPU twin); that a flat block and a two-level block come back within
 * the RGB565 step; how close a busy synthetic map frame comes back; and how
 * long a 1088x480 frame takes to pack on this machine. */
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "../kit/block_pack.h"
#include "../kit/yuv_atlas.h"

using namespace crk;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const uint32_t W = 1088, H = 480;

/* An atlas whose Y is f(x, y) and whose chroma planes are u(x, y), v(x, y)
 * at half size. */
template <class F, class G, class K>
static std::vector<uint8_t> make_atlas(F f, G u, K v)
{
    std::vector<uint8_t> a((size_t)W * atlas_height(H));
    for (uint32_t y = 0; y < H; y++)
        for (uint32_t x = 0; x < W; x++)
            a[(size_t)y * W + x] = (uint8_t)f(x, y);
    for (uint32_t y = 0; y < H / 2; y++)
        for (uint32_t x = 0; x < W / 2; x++) {
            a[(size_t)(H + y) * W + x] = (uint8_t)u(x, y);
            a[(size_t)(H + y) * W + W / 2 + x] = (uint8_t)v(x, y);
        }
    return a;
}

static void test_rgb_matches_atlas_shader()
{
    std::srand(7);
    const std::vector<uint8_t> a = make_atlas([](uint32_t, uint32_t) { return std::rand() % 256; },
                                              [](uint32_t, uint32_t) { return std::rand() % 256; },
                                              [](uint32_t, uint32_t) { return std::rand() % 256; });
    std::vector<uint8_t> rgb((size_t)W * H * 3);
    atlas_to_rgb(a.data(), W, H, rgb.data());
    int worst = 0;
    for (uint32_t y = 0; y < H; y += 7)
        for (uint32_t x = 0; x < W; x += 5) {
            uint8_t s[3];
            atlas_rgb(a.data(), W, H, (x + 0.5) / W, (y + 0.5) / H, s);
            for (int c = 0; c < 3; c++)
                worst = std::max(worst, std::abs(s[c] - rgb[((size_t)y * W + x) * 3 + c]));
        }
    char name[96];
    std::snprintf(name, sizeof name, "the packer's RGB is the atlas shader's, edges included (worst %d)", worst);
    ok(name, worst <= 1);
}

/* The SSE2 conversion and packing against the scalar ones, byte for byte:
 * random planes (every clamp reached), extreme chroma, a width whose chroma
 * columns leave a tail past the last 8, and smooth gradients. */
static void test_simd_equals_scalar()
{
#if !defined(__SSE2__)
    std::printf("skip SSE2 against scalar: no SSE2 on this host (make test-kit-x86)\n");
    return;
#endif
    std::srand(11);
    bool same = true;
    for (uint32_t w : {W, 1084u, 64u}) {
        const uint32_t h = 32;
        for (int kind = 0; kind < 3 && same; kind++) {
            std::vector<uint8_t> a((size_t)w * atlas_height(h));
            for (uint8_t &v : a)
                v = kind == 0 ? (uint8_t)std::rand() : kind == 1 ? (std::rand() % 2 ? 255 : 0) : (uint8_t)(std::rand() % 2 ? 250 : 5);
            std::vector<uint8_t> fast((size_t)w * h * 3), slow(fast.size());
            atlas_to_rgb(a.data(), w, h, fast.data());
            atlas_to_rgb_scalar(a.data(), w, h, slow.data());
            same = same && fast == slow;
        }
    }
    ok("atlas_to_rgb equals the scalar conversion byte for byte", same);

    same = true;
    for (int kind = 0; kind < 3 && same; kind++) {
        std::vector<uint8_t> a((size_t)W * atlas_height(H));
        for (size_t i = 0; i < a.size(); i++)
            a[i] = kind == 0 ? (uint8_t)std::rand() : kind == 1 ? (uint8_t)(i % 3 ? 255 : 0) : (uint8_t)((i / 7) % 256);
        std::vector<uint8_t> fast(block_bytes(W, H)), slow(fast.size());
        pack_blocks(a.data(), W, H, fast.data(), 3);
        pack_blocks_scalar(a.data(), W, H, slow.data());
        same = same && fast == slow;
    }
    ok("pack_blocks equals the scalar packing byte for byte", same);
}

/* c0 red, c1 blue, row 0's selectors 0, 1, 2, 3: the four palette colours
 * left to right, as the shader reads the bytes. */
static void test_layout()
{
    std::vector<uint8_t> p(block_bytes(W, H), 0);
    p[0] = 0x00; p[1] = 0xF8;   /* c0 = 0xF800, red */
    p[2] = 0x1F; p[3] = 0x00;   /* c1 = 0x001F, blue */
    p[4] = 0xE4;                /* row 0: 0b11 10 01 00 */
    uint8_t c[4][3];
    for (uint32_t x = 0; x < 4; x++)
        block_rgb(p.data(), W, x, 0, c[x]);
    ok("selector 0 is c0", c[0][0] == 255 && c[0][1] == 0 && c[0][2] == 0);
    ok("selector 1 is c1", c[1][0] == 0 && c[1][1] == 0 && c[1][2] == 255);
    ok("selector 2 is (2 c0 + c1) / 3", c[2][0] == 170 && c[2][2] == 85);
    ok("selector 3 is (c0 + 2 c1) / 3", c[3][0] == 85 && c[3][2] == 170);
    uint8_t below[3];
    block_rgb(p.data(), W, 0, 1, below);
    ok("row 1 reads its own byte", below[0] == 255);   /* row 1's selectors are 0 */
    ok("a 1088x480 frame is 261,120 bytes in a 544x120 buffer",
       block_bytes(W, H) == 261120 && block_texels_w(W) == 544 && block_texels_h(H) == 120);
}

/* Largest channel error of the unpacked frame against the packer's RGB, and
 * the PSNR. */
static void roundtrip(const std::vector<uint8_t> &a, int *worst, double *psnr)
{
    std::vector<uint8_t> rgb((size_t)W * H * 3), packed(block_bytes(W, H)), split(block_bytes(W, H));
    atlas_to_rgb(a.data(), W, H, rgb.data());
    pack_blocks(a.data(), W, H, packed.data(), 1);
    pack_blocks(a.data(), W, H, split.data(), 3);
    ok("three threads pack the same bytes as one", split == packed);
    double se = 0;
    *worst = 0;
    for (uint32_t y = 0; y < H; y++)
        for (uint32_t x = 0; x < W; x++) {
            uint8_t o[3];
            block_rgb(packed.data(), W, x, y, o);
            for (int c = 0; c < 3; c++) {
                const int d = o[c] - rgb[((size_t)y * W + x) * 3 + c];
                *worst = std::max(*worst, std::abs(d));
                se += (double)d * d;
            }
        }
    const double mse = se / ((double)W * H * 3);
    *psnr = mse == 0 ? 99 : 10 * std::log10(255.0 * 255.0 / mse);
}

static void test_flat_and_two_level()
{
    int worst;
    double psnr;
    roundtrip(make_atlas([](uint32_t, uint32_t) { return 90; }, [](uint32_t, uint32_t) { return 170; },
                         [](uint32_t, uint32_t) { return 100; }),
              &worst, &psnr);
    char name[112];
    std::snprintf(name, sizeof name, "a flat frame comes back within the RGB565 step (worst %d)", worst);
    ok(name, worst <= 4);
    /* White strokes on blue: two Y levels, chroma flat over each 2x2. */
    roundtrip(make_atlas([](uint32_t x, uint32_t y) { return (x * 7 + y * 3) % 11 < 3 ? 235 : 80; },
                         [](uint32_t, uint32_t) { return 180; }, [](uint32_t, uint32_t) { return 110; }),
              &worst, &psnr);
    std::snprintf(name, sizeof name, "two levels a block come back within the RGB565 step (worst %d)", worst);
    ok(name, worst <= 4);
}

/* A busy synthetic map: flat areas, soft gradients, a coloured band and thin
 * light strokes over it, with matching chroma. */
static std::vector<uint8_t> busy_frame()
{
    return make_atlas(
        [](uint32_t x, uint32_t y) {
            int v = 60 + (int)(x / 8 + y / 6) % 40;
            if (y > 150 && y < 210) v = 120;
            if ((x / 3 + y) % 23 == 0 || (x * 5 + y * 3) % 37 < 2) v = 230;
            return v;
        },
        [](uint32_t x, uint32_t y) { return y > 75 && y < 105 ? 200 : 128 + (int)(x % 32) / 4; },
        [](uint32_t, uint32_t y) { return y > 75 && y < 105 ? 90 : 128 - (int)(y % 24) / 3; });
}

static void test_busy_frame()
{
    int worst;
    double psnr;
    roundtrip(busy_frame(), &worst, &psnr);
    char name[112];
    std::snprintf(name, sizeof name, "a busy synthetic map frame comes back at %.1f dB (worst %d)", psnr, worst);
    ok(name, psnr > 28.0);
}

static void bench()
{
    const std::vector<uint8_t> a = busy_frame();
    std::vector<uint8_t> packed(block_bytes(W, H));
    for (unsigned threads : {1u, 3u}) {
        pack_blocks(a.data(), W, H, packed.data(), threads);
        const int n = 30;
        const auto t0 = std::chrono::steady_clock::now();
        for (int i = 0; i < n; i++)
            pack_blocks(a.data(), W, H, packed.data(), threads);
        const double ms =
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / n;
        std::printf("     packing a 1088x480 frame on %u thread%s takes %.2f ms on this machine\n", threads,
                    threads > 1 ? "s" : "", ms);
    }
}

/* pack_block_rect: a rect of blocks, as pack_blocks gives them; block_differs:
 * a block whose own luma or reached chroma changed, not its untouched
 * neighbours. */
static void test_rect_and_differs()
{
    const std::vector<uint8_t> a = busy_frame();
    std::vector<uint8_t> whole(block_bytes(W, H));
    pack_blocks(a.data(), W, H, whole.data(), 1);
    const uint32_t bx0 = 13, by0 = 7, bx1 = 61, by1 = 40, bw = W / 4;
    std::vector<uint8_t> part((size_t)(bx1 - bx0) * (by1 - by0) * 8);
    pack_block_rect(a.data(), W, H, bx0, by0, bx1, by1, part.data());
    bool same = true;
    for (uint32_t by = by0; by < by1; by++)
        same = same && std::equal(part.begin() + (size_t)(by - by0) * (bx1 - bx0) * 8,
                                  part.begin() + (size_t)(by - by0 + 1) * (bx1 - bx0) * 8,
                                  whole.begin() + ((size_t)by * bw + bx0) * 8);
    ok("pack_block_rect packs a rect of blocks as pack_blocks does", same);
    std::vector<uint8_t> b = a;
    b[(size_t)41 * W + 101] ^= 1;   /* a luma pixel of block (25, 10) */
    ok("block_differs: the block of a changed luma pixel, not its neighbour",
       block_differs(a.data(), b.data(), W, H, 25, 10) && !block_differs(a.data(), b.data(), W, H, 26, 10) &&
           !block_differs(a.data(), b.data(), W, H, 25, 11));
    b = a;
    b[(size_t)(H + 21) * W + 50] ^= 1;   /* U at column 50, row 21: pixels around 100,42 */
    ok("block_differs: a changed chroma sample's blocks and the one to its left it reaches",
       block_differs(a.data(), b.data(), W, H, 25, 10) && block_differs(a.data(), b.data(), W, H, 24, 10) &&
           !block_differs(a.data(), b.data(), W, H, 26, 10) && !block_differs(a.data(), b.data(), W, H, 25, 12));
}

int main()
{
    test_rect_and_differs();
    test_rgb_matches_atlas_shader();
    test_simd_equals_scalar();
    test_layout();
    test_flat_and_two_level();
    test_busy_frame();
    bench();
    if (failures) {
        std::printf("%d FAILED\n", failures);
        return 1;
    }
    std::printf("all ok\n");
    return 0;
}
