/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* A canvas (PROTOCOL.md "Canvases"): a client's off-screen picture on a
 * target. Its effect and mesh layers draw into it in passes of its own,
 * before the target's, its first pass clearing it; its own and other
 * layers on the target sample it as they sample an asset (bind). It is not
 * drawn on screen and not in the layer stack, so it never makes its target
 * wanted.
 *
 * Its layers see the target's scene through graph(): a Graph that makes
 * their quads and views in the canvas and passes everything else on, so a
 * layer is the same object on screen or in a canvas. Drawn once (once),
 * the canvas is drawn again only in the flushes that change something in it
 * or that it samples (touch()); otherwise every frame while enabled
 * (enable(): while something shown samples it). A depth canvas has a
 * depth-stencil buffer of its own, the one place stencil state is offered:
 * on screen it would reach the display's buffer, which other scenes use. */
#ifndef CRS_CANVAS_H
#define CRS_CANVAS_H

#include <stdint.h>
#include <memory>
#include <string>

#include "graph.h"
#include "layer.h"

namespace crs {

class Canvas {
public:
    /* Its sides, at most kMaxSide; a target's canvases together at most
     * kMaxTargetPixels (each canvas is drawn by the display's GPU). */
    static const uint32_t kMaxSide = 2048;
    static const uint64_t kMaxTargetPixels = 2048 * 2048;

    Canvas(uint32_t id, int target, const CanvasSpec &spec);
    ~Canvas();
    /* Why such a canvas cannot be. */
    static const char *spec_error(const CanvasSpec &spec);

    uint32_t id() const { return id_; }
    int target() const { return target_; }
    const CanvasSpec &spec() const { return spec_; }
    uint64_t pixels() const { return (uint64_t)spec_.w * spec_.h; }
    /* What it holds of the display's memory, counted in the service's
     * pixel memory: RGBA8 twice (what its passes draw, and the copy layers
     * sample), and as much again for a depth-stencil buffer. */
    static uint64_t memory(const CanvasSpec &s) { return (uint64_t)s.w * s.h * 4 * (s.depth ? 3 : 2); }
    uint64_t memory() const { return memory(spec_); }

    /* Made in a published scene; false when the renderer refuses it. */
    bool attach(Graph *g);
    /* The scene goes, or the canvas: dropped from the scene first when
     * drop (its layers' objects dropped before). */
    void detach(bool drop);
    bool attached() const { return handle_ != 0; }
    const std::string &refused() const { return refused_; }
    /* Its handle: a buffer to bind. */
    int buffer() const { return handle_; }
    /* The graph its layers draw through; null while not attached. */
    Graph *graph();

    /* Something in it changed: a canvas drawn once draws again. */
    void touch() { dirty_ = true; }
    /* Drawn in the next flush: every frame while enabled, or once and
     * touched since it was last drawn. */
    bool due() const { return handle_ && (spec_.once ? dirty_ : enabled_); }
    /* A canvas drawn every frame drawn or not (Graph::enable_canvas); true
     * when that changed. One drawn once is always enabled. */
    bool enable(bool on);
    /* Its redraw, when due; the caller flushes. */
    Stage stage();
    void committed(bool ok);

private:
    class Adapter;
    uint32_t id_;
    int target_;
    CanvasSpec spec_;
    Graph *g_ = nullptr;
    int handle_ = 0;
    std::unique_ptr<Adapter> adapter_;
    std::string refused_;
    bool dirty_ = false, staged_ = false, enabled_ = true;
};

}  // namespace crs

#endif
