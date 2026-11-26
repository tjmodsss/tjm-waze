/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* A video layer: decoded 4:2:0 frames, such as a CarPlay map, drawn with
 * these upload rules:
 *
 * - one persistent R8 buffer holding the frame's Y, U and V planes as an
 *   atlas (yuv_atlas.h), turned into colour by the renderer's GPU, with one
 *   sampler, made when the scene is: no texture or sampler per frame;
 * - each update writes only the 64x64 tiles that differ visibly from what
 *   the buffer holds (the noise filter and settle time, dirty_tiles.h), the
 *   whole atlas when most do, in place with setData;
 * - fast motion whose exact write the byte budget cannot cover at once goes
 *   as 4x4 colour blocks into one of two persistent RGBA8 buffers drawn by a
 *   second quad (block_pack.h), and the exact atlas comes back with the next
 *   update the budget covers, or kRefineMs after the last packed one; with
 *   always_packed the atlas is never written or shown: each update is
 *   planned as an exact one would be (the noise filter, settle time and
 *   tiles), and only the 4x4 blocks in its tiles that pack otherwise than
 *   what the packed buffer holds are packed and written, in place in one
 *   buffer (the whole buffer for a scene's first write, or after a failed
 *   one), so a still map writes nothing;
 * - updates go on the frame clock's grid (frame_clock.h) and within the
 *   service's one byte budget (upload_pacer.h), shared by every layer;
 * - only the newest frame waits: a frame not yet written is replaced by each
 *   newer one, so the picture skips ahead and memory stays four atlases, a
 *   rectangle scratch and, with packed blocks, the packing;
 * - setData and the flush are checked: on a refusal the newest frame stays
 *   pending and the next write is whole.
 *
 * The target's scene carries every layer, so stage() writes and the
 * compositor flushes once for all of them; committed() then settles the
 * flush's outcome: what it wrote is shown, or after a refusal the next write
 * is whole. Frames come from a client (offer).
 *
 * Hidden tiles (occlusion.h). Each tick before stage() the compositor
 * tells the layer what the next flush shows opaquely above it (occluded();
 * a composite's tiles are given by hide()), and so which of its atlas tiles
 * are wholly under opaque layers. Those are not written while they
 * stay hidden; the buffer keeps what it held there. A hidden tile that has
 * come to differ from the frame past the threshold is held: once it is no
 * longer hidden (the layer above moved, went, turned translucent or
 * faded, or this one moved), it must be written before any flush shows it.
 * The layer is then uncovering(): its next stage() plans and writes, its
 * frame clock notwithstanding, every visible tile that differs, held ones
 * included, and until that write goes the compositor holds the change that
 * uncovers them back (compositor.h); a forced write (force()) hides
 * nothing. While the packed quad shows, the atlas is not drawn and nothing
 * is uncovered; the write that brings the atlas back is planned
 * with the tiles hidden then. A whole write (the first in a scene, or after
 * a failed one) writes hidden tiles too. With no tile hidden the layer
 * writes exactly as without any of this.
 *
 * A target with several videos draws them through one composite
 * (video_composite.h): each client video is then a source, with no objects
 * in the scene; it keeps its newest frame for the composite to take, and
 * goes back to drawing itself, its newest frame written whole, once the
 * display holds every video's buffers separately again (compositor.h). */
#ifndef CRS_VIDEO_LAYER_H
#define CRS_VIDEO_LAYER_H

#include "layer.h"
#include "occlusion.h"

namespace crs {

struct VideoParams {
    uint32_t w = 1088, h = 480;      /* the frame's size; the atlas is w x h*3/2 */
    uint32_t level_bits = 2;         /* round_levels (yuv_atlas.h); 0: exact */
    uint32_t dirty_threshold = 8;    /* dirty_tiles.h; 0: every difference */
    int dirty_settle_ms = 1000;      /* 0: never */
    uint32_t fps = 30;               /* updates a second at most; 0: no clock */
    bool pan_blocks = true;          /* packed fast motion; needs h a multiple of 4 */
    int stall_ms = 6000;             /* no frame for this long: not ready */
    /* Every write packed, the first and a still picture's too, never the
     * exact atlas; needs pan_blocks (without, off). */
    bool always_packed = false;
    /* Its target on screen again (on_screen_again): a frame that came before
     * waits up to this long for a newer one before it is written (0: none). */
    int fresh_ms = 0;
};

/* A host's edge (PROTOCOL.md "host"): the picture's rows kEdgeInset in
 * from its top and its bottom drawn on past them, top px above its rect and
 * bottom px below, blurred along the row by a Gaussian of sigma blur px (0:
 * none) and darkened with the distance d from the rect to max(1/4, 1 - d /
 * dim) (dim 0: not); the picture's own rows fade into them over fade px
 * inside the rect. top and bottom 0: none. */
struct VideoEdge {
    uint32_t top = 0, bottom = 0, fade = 0, dim = 0, blur = 0;
    bool on() const { return top || bottom; }
    bool operator==(const VideoEdge &o) const
    {
        return top == o.top && bottom == o.bottom && fade == o.fade && dim == o.dim && blur == o.blur;
    }
    bool operator!=(const VideoEdge &o) const { return !(*this == o); }
};
/* The edge quads' effects: the atlas's colour and the packed blocks'. */
extern const char *const kEdgeAtlasFragmentShader;
extern const char *const kEdgeBlockFragmentShader;

class VideoLayer : public Layer {
public:
    /* The packed quad gives way to the exact atlas once no update has needed
     * it for this long, and the packing runs on this many threads (the
     * caller's and two more; MGU has four cores). */
    static const int64_t kRefineMs = 250;
    static const unsigned kPackThreads = 3;
    /* always_packed: rects a write at most, fewer than an exact write can
     * take (1088x480: 204 tiles, up to 152 before it goes whole). */
    static const size_t kPackedRects = 64;

    VideoLayer(uint32_t id, int target, uint64_t seq, crk::UploadPacer &pacer, int atlas_effect, int block_effect,
               const VideoParams &p, int64_t now_ms);
    const char *kind() const override { return "video"; }
    static const char *size_error(uint32_t w, uint32_t h);
    size_t frame_bytes() const { return atlas_bytes_; }

    /* A frame's atlas, frame_bytes() long; its levels are rounded on the
     * way in. Replaces a frame not yet written. */
    void offer(const uint8_t *atlas, int64_t now_ms);
    /* A frame that is the last one offered again, byte for byte: staged,
     * counted and kept live as that frame would be, with nothing to copy and
     * no plan to make unless tiles are due to settle. */
    void repeat(int64_t now_ms);
    /* The target flushes again after it did not: a frame waiting since
     * before, once this layer has written one, waits up to fresh_ms for a
     * newer one (PROTOCOL.md "fresh_ms"). Not for a composite's source. */
    void on_screen_again(int64_t now_ms);

    bool ready(int64_t now_ms) const override;
    bool attach(Graph *g, int64_t now_ms, std::string *err) override;
    void detach(bool drop) override;
    void arrange(bool drawn, int32_t order) override;
    void place() override;
    Stage stage(int64_t now_ms) override;
    void committed(bool ok, int64_t now_ms) override;
    size_t staged_bytes() const override { return staged_.raw; }
    bool holds_flush() const override { return parked_ && drawn_; }
    int64_t wake_in_ms(int64_t now_ms) const override;
    std::string stats() const override;
    WriteStats write_stats() const override;
    size_t buffer_bytes() const override
    {
        return g_ ? atlas_bytes_ + (p_.pan_blocks ? 2 * packed_.size() : 0) : 0;
    }
    bool fades() const override { return true; }

    const VideoParams &video() const { return p_; }

    /* Another client's layer asks for this one's bandwidth (PROTOCOL.md
     * "Bandwidth for a layer"): updates at most cap a second while cap is
     * below its own fps (or it has none), at its own fps with cap 0. Its
     * params stay as the client set them. */
    void cap_fps(uint32_t cap, int64_t now_ms);
    /* The updates a second its clock allows now; 0: no clock. */
    uint32_t clock_fps() const { return clock_.fps(); }

    /* Its edge (none by default), within its target (the caller clamps
     * it), drawn by these effects of the edge shaders above: two quads a
     * kind, over the picture, shown with the atlas or the packed one. True
     * when it changed. A turned layer's edge is drawn unturned. */
    bool set_edge(const VideoEdge &e, int atlas_effect, int block_effect);
    const VideoEdge &edge() const { return edge_; }
    static const uint32_t kEdgeInset = 2;

    /* The atlas tiles (row by row, planner's) the next flush shows wholly
     * under opaque layers, given each tick before stage(); null: none. */
    void hide(const uint8_t *tiles);
    /* Called each tick before stage() with the coverage of the layers drawn
     * above it (occlusion.h): hides what that covers. */
    void occluded(const Coverage &cov, const Shown &s) override;
    /* Adds what it draws opaquely, as the next flush shows it. */
    void occlude(Coverage *cov, const Shown &s) override;
    /* Held tiles are no longer hidden: the next flush must carry them. */
    bool uncovering() const override;
    /* Its first frame written (a composite's source: the composite's). */
    bool on_display() const override { return opaque_ || source_; }
    /* The next stage() writes what uncovering() needs whatever the budget
     * allows (charged as any write), for an uncover the compositor cannot
     * hold back (compositor.h). Such a write hides nothing: with packed
     * blocks it is the newest frame packed (the exact atlas comes back with
     * a write the budget allows), without them every changed tile; and it
     * does not go when no tile it uncovers differs from the newest frame
     * past the threshold. The
     * layer hides no tile again until a write the budget allowed (so from a
     * positive allowance: the forced write's debt repaid) has gone. */
    void force(bool on) { force_ = on; }
    /* It hides tiles, or holds tiles a write left unwritten under cover. */
    bool holds_tiles() const { return hiding_ || held_n_ > 0; }
    /* The tiles hidden this tick; null: none. */
    const uint8_t *hidden_mask() const { return hiding_ ? hidden_.data() : nullptr; }

    /* A source of its target's composite (video_composite.h): detached, its
     * newest frame in newest(). direct() makes it a layer of its own again,
     * before it is attached: its newest frame then goes whole. */
    void to_source();
    void direct();
    bool source() const { return source_; }
    /* The newest frame, frame_bytes() long; null before the first. */
    const uint8_t *newest() const { return have_ ? front_.data() : nullptr; }
    /* A source's frame or repeat waits for the composite, and whether it is
     * a frame (not a repeat). took(): the composite has taken it. */
    bool waiting() const { return front_pending_; }
    bool fresh() const { return front_pending_ && !repeated_; }
    void took() { front_pending_ = repeated_ = false; }
    /* A source's copy of what the composite last took from it, frame_bytes()
     * long, which its next frame is compared with. */
    uint8_t *taken();

protected:
    void faded() override
    {
        if (g_)
            set_opacity();
    }

    /* The quads drawing the buffers: one over params.rect for the atlas and
     * one for the packed blocks. The composite draws one pair a source. */
    virtual bool make_atlas_quads(Graph *g);
    virtual bool make_block_quads(Graph *g);
    virtual void drop_quads();
    /* Shows the atlas quads, or with blocks the packed ones, where drawn. */
    virtual void show_quads(bool blocks);
    /* The packed quads sample buf. */
    virtual bool bank_quads(int buf);
    virtual void set_opacity();

    /* The composite's frame, composed in place: the newest frame, whole
     * (black before the first). canvas_changed(): it changed, and waits to
     * be written as an offered frame would. */
    uint8_t *canvas();
    void canvas_changed(int64_t now_ms);
    /* A write may go now: the frame clock is due (or a whole rewrite is, or
     * held tiles are uncovered) and the budget allows one. */
    bool due(int64_t now_ms);
    /* Milliseconds until the frame clock is due; 0 or less: it is. */
    int64_t clock_wait_ms(int64_t now_ms) const { return clock_.ms_until_due(now_ms); }

    VideoParams p_;
    int atlas_effect_, block_effect_;
    int atlas_buf_ = 0;
    int block_buf_[2] = {0, 0};
    int block_bank_ = 0;
    bool blocks_shown_ = false, opaque_ = false;

private:
    enum class Kind { None, Exact, Blocks };
    /* A write staged into the scene, awaiting the flush's outcome. */
    struct Staged {
        Kind kind = Kind::None;
        bool fresh = false, whole = false, refine = false, was_shown = false, was_parked = false;
        bool packed = false;   /* an exact plan written as packed blocks (always_packed) */
        int next_bank = 0;
        size_t raw = 0, accepted = 0;
        int64_t offered_ms = 0;   /* when its frame was offered */
        std::vector<crk::PixelRect> rects;
    };

    Stage stage_exact(int64_t now_ms, bool fresh);
    Stage stage_blocks(int64_t now_ms, bool fresh);
    size_t write_packed(const std::vector<crk::PixelRect> &rects, bool whole, bool fill, bool *written);
    void show_blocks(bool on);
    void drop_objects();
    /* Whether a held tile no longer hidden differs from the newest frame past
     * the threshold; those that do not are held no more. */
    bool held_differ();
    /* After a plan with the tiles hidden_: what the buffer will hold. */
    void planned_hidden(bool whole);

    size_t atlas_bytes_;
    uint32_t atlas_h_;
    crk::UploadPlanner planner_;   /* each update against shown_, and its quiet tiles */
    crk::UploadPlanner motion_;    /* new frames against the packed one */
    crk::FrameClock clock_;

    /* The newest frame, not yet written while front_pending_; shown_ is what
     * the buffer holds, the reference the next frame is diffed against, and
     * outlives the scene so the next one starts from it. */
    std::vector<uint8_t> front_, shown_, rect_scratch_;
    bool front_pending_ = false;
    /* repeated_: front_ waits as a repeat of the picture last staged.
     * front_stale_: a whole write swapped the newest frame into shown_. */
    bool repeated_ = false, front_stale_ = false;
    int64_t front_ms_ = -1, shown_ms_ = -1, last_frame_ms_ = -1;
    int64_t picture_ms_ = -1;   /* when front_'s picture came (offer, canvas_changed; not repeat) */
    bool wrote_ = false;        /* written in a scene before the one it is attached to */
    /* on_screen_again: the picture of picture_ms_ hold_from_ms_ waits until hold_until_ms_ (-1: none) */
    int64_t hold_from_ms_ = -1, hold_until_ms_ = -1;
    bool have_ = false;

    int atlas_quad_ = 0, block_quad_ = 0;
    VideoEdge edge_;
    int edge_fx_[2] = {0, 0};
    int edge_quad_[2][2] = {{0, 0}, {0, 0}};   /* [atlas, blocks][top, bottom] */
    Rect edge_at_;                               /* the rect they were made for */
    void make_edge_quads();
    void drop_edge_quads();
    /* parked_: a failed exact write left the atlas unlike any frame; the
     * target holds its flushes until the next whole write. first_: the
     * scene's first write is still to go. source_: drawn by the composite. */
    bool buffer_stale_ = false, parked_ = false, first_ = false, source_ = false;
    std::vector<uint8_t> block_src_, packed_;
    std::vector<uint8_t> block_mask_, block_scratch_;   /* always_packed's blocks to write, packed */
    /* hidden_: the tiles hidden this tick (hiding_: any is). held_: tiles a
     * plan left unwritten under cover that differ from the frame past the
     * threshold (held_n_ of them); held_plan_ the last plan's. */
    std::vector<uint8_t> hidden_, held_, held_plan_;
    /* shown_drawn_: drawn as the last occlusion took it. forced_write_: the
     * write staged went past the budget; no_hide_: one did, and since then
     * no write the budget allowed has gone. */
    bool hiding_ = false, force_ = false, shown_drawn_ = false;
    bool forced_write_ = false, no_hide_ = false;
    uint32_t held_n_ = 0;
    uint64_t hidden_tiles_ = 0, uncovers_ = 0, forced_ = 0;
    int64_t refine_due_ms_ = -1;
    Staged staged_;

    uint64_t age_ms_ = 0;   /* the sent frames' ages at their flush, summed */
    uint64_t sent_ = 0, same_ = 0, quiet_ = 0, superseded_ = 0, settled_ = 0, failed_ = 0, refused_ = 0,
             bytes_ = 0, whole_writes_ = 0, partial_writes_ = 0, rects_ = 0, packed_writes_ = 0, refines_ = 0,
             held_budget_ = 0;
};

}  // namespace crs

#endif
