/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
/* The map's submission clock, and a duration tally for the probe. Not
 * thread-safe; the render thread owns them. */
#ifndef CRK_FRAME_CLOCK_H
#define CRK_FRAME_CLOCK_H

#include <algorithm>
#include <cstdint>

namespace crk {

/* Count, mean and largest of a series of durations. */
struct Spread {
    uint64_t n = 0;
    int64_t sum = 0, max = 0;
    void add(int64_t v)
    {
        n++;
        sum += v;
        max = std::max(max, v);
    }
    void merge(const Spread &o)
    {
        n += o.n;
        sum += o.sum;
        max = std::max(max, o.max);
    }
    int64_t mean() const { return n ? sum / (int64_t)n : 0; }
};

/* The submission clock: deadlines on an absolute grid, start + n * 1000 / fps
 * ms, each computed from n so a fractional interval (33.3 ms at 30) keeps its
 * exact average. A frame may go at or after the current deadline. When one
 * goes, the next deadline is the first on the grid strictly after it, so a
 * late frame still targets the grid (its average does not drift) and the
 * deadlines that passed while nothing went are skipped, not made up as a
 * catch-up burst. A send landing just before a grid point can be followed by
 * the next within a few ms; the cluster squashes that pair, costing a frame's
 * bytes, not lag. fps 0: no pacing. */
class FrameClock {
public:
    void configure(uint32_t fps) { fps_ = fps; }
    uint32_t fps() const { return fps_; }

    /* Another rate from now_ms on: the deadline due next stays where it
     * is (now_ms for a clock that had none) and the grid goes on from it at
     * the new rate, so a change never lets a frame go early or holds one
     * back. */
    void retime(uint32_t fps, int64_t now_ms)
    {
        start_ms_ = fps_ ? deadline(n_) : now_ms;
        n_ = 0;
        fps_ = fps;
    }

    /* Starts the grid at now_ms; the first frame may go at once. */
    void reset(int64_t now_ms)
    {
        start_ms_ = now_ms;
        n_ = 0;
    }

    bool due(int64_t now_ms) const { return fps_ == 0 || now_ms >= deadline(n_); }

    /* Milliseconds from now_ms until due(). */
    int64_t ms_until_due(int64_t now_ms) const
    {
        return fps_ == 0 ? 0 : std::max<int64_t>(0, deadline(n_) - now_ms);
    }

    /* A frame went at now_ms: the next deadline is the first on the grid
     * after it, so a late send still targets the grid and deadlines that
     * passed meanwhile are skipped, not made up. */
    void sent(int64_t now_ms)
    {
        if (fps_ == 0)
            return;
        do
            n_++;
        while (deadline(n_) <= now_ms);
    }

private:
    int64_t deadline(uint64_t n) const { return start_ms_ + (int64_t)(n * 1000 / fps_); }

    uint32_t fps_ = 0;
    int64_t start_ms_ = 0;
    uint64_t n_ = 0;
};

}  // namespace crk

#endif
