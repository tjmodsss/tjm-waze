/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
/* The map packed in 4x4 blocks, two colours each, for a persistent RGBA8
 * Texture2DBuffer (VideoConfig pan_blocks).
 *
 * The cluster takes no compressed texture format in a Texture2DBuffer
 * (createTexture2DBuffer refuses them), so the packing is our own, in an
 * ordinary RGBA8 buffer, unpacked by the fragment shader. Each 4x4 block of
 * the w x h picture is 8 bytes: two RGB565 endpoints c0 and c1 (bytes 0-1
 * and 2-3, little endian) and sixteen 2-bit selectors (bytes 4-7, one byte
 * a row, the left pixel in the low bits). A selector picks c0, c1,
 * (2 c0 + c1) / 3 or (c0 + 2 c1) / 3. The buffer is (w / 2) x (h / 4) RGBA8
 * texels: block (bx, by) is texels (2 bx, by), the endpoints, and
 * (2 bx + 1, by), the selectors; a 1088x480 map is 544x120, 261,120 B a
 * frame, a third of the R8 atlas.
 *
 * The packer reads the 4:2:0 atlas (yuv_atlas.h), turns it to RGB with the
 * atlas shader's own chroma siting and matrix (so the colours are what the
 * atlas path shows), and fits each block cheaply: the darkest and lightest
 * pixels as endpoints, the selectors by each pixel's place between them, one
 * least-squares refit of the endpoints for those selectors, the selectors
 * again. On the car's Waze capture that comes within 0.2 dB of a principal-
 * axis fit with two refits. */
#ifndef CRK_BLOCK_PACK_H
#define CRK_BLOCK_PACK_H

#include <stddef.h>
#include <stdint.h>
#include <vector>

namespace crk {

/* GLSL ES 1.00 fragment shader drawing the packed buffer: u_image the
 * buffer, sampled nearest; u_size the picture's w x h; u_opacity as the
 * atlas shader's. Bytes come back exactly from the RGBA8 texels as
 * floor(s * 255 + 0.5) in highp floats, a selector byte at a time. */
extern const char *const kBlockFragmentShader;

/* The buffer's size for a w x h picture (both multiples of 4). */
inline uint32_t block_texels_w(uint32_t w) { return w / 2; }
inline uint32_t block_texels_h(uint32_t h) { return h / 4; }
inline size_t block_bytes(uint32_t w, uint32_t h) { return (size_t)w / 4 * (h / 4) * 8; }

/* Packs the w x h picture of a w x atlas_height(h) atlas into out
 * (block_bytes(w, h)), its block rows split between `threads` threads (the
 * caller's and threads - 1 started for the call; the caller's packs the
 * rows of any that cannot start). */
void pack_blocks(const uint8_t *atlas, uint32_t w, uint32_t h, uint8_t *out, unsigned threads);
/* The same on one thread without SSE2, which pack_blocks equals byte for
 * byte. */
void pack_blocks_scalar(const uint8_t *atlas, uint32_t w, uint32_t h, uint8_t *out);
/* Blocks bx0 .. bx1 - 1 x by0 .. by1 - 1 alone, row by row into out
 * ((bx1 - bx0) * (by1 - by0) * 8 bytes): the bytes pack_blocks gives them,
 * which is texel rect (2 bx0, by0, 2 (bx1 - bx0), by1 - by0) of the buffer. */
void pack_block_rect(const uint8_t *atlas, uint32_t w, uint32_t h, uint32_t bx0, uint32_t by0, uint32_t bx1,
                     uint32_t by1, uint8_t *out);
/* Whether block (bx, by) packs otherwise from atlas a than from b: a byte it
 * is made from differs (its 4x4 luma, and the chroma around it that the
 * atlas shader's siting reaches). */
bool block_differs(const uint8_t *a, const uint8_t *b, uint32_t w, uint32_t h, uint32_t bx, uint32_t by);

/* The RGB the atlas shader draws at every pixel, as the packer sees it:
 * w x h x 3 bytes into out. */
void atlas_to_rgb(const uint8_t *atlas, uint32_t w, uint32_t h, uint8_t *out);
/* The same without SSE2, which atlas_to_rgb equals byte for byte. */
void atlas_to_rgb_scalar(const uint8_t *atlas, uint32_t w, uint32_t h, uint8_t *out);

/* CPU twin of kBlockFragmentShader: the RGB it draws at pixel (x, y). */
void block_rgb(const uint8_t *packed, uint32_t w, uint32_t x, uint32_t y, uint8_t rgb[3]);

}  // namespace crk

#endif
