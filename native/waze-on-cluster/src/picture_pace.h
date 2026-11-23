// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Which decoded frames get a picture, at most picture_fps a second.
 *
 * Every frame is decoded, since the next ones refer to it, but a picture
 * (VPP, its copy to system memory, the packing and the hand-off,
 * decoder_msdk.h) is what costs the head unit's CPU, and a moving map
 * changes nearly every picture. The cluster takes at most target_fps
 * updates a second (map_feed.h), so with a phone sending 30 frames a second
 * and target_fps 15, half the pictures are made for nothing.
 *
 * The pictures follow an absolute grid, one slot every 1000 / picture_fps ms
 * from the first picture (crk::FrameClock). A frame gets a picture when its
 * slot has come, or comes within a quarter of an interval (kLeadDiv), so a
 * frame a few ms early on the grid is not skipped for it. A picture takes
 * the slot; slots that passed with no frame are skipped, not made up. So a
 * phone faster than picture_fps gives picture_fps pictures a second, and a
 * slower one gives one for every frame.
 *
 * A frame skipped here may be the last one for a while (a still map sends a
 * frame only when it changes), so the producer gives it its picture after
 * all when no newer frame came by its slot and the lead after it
 * (late_in_ms): the map is never left on an older picture than the phone's
 * last. That picture takes the slot too.
 *
 * picture_fps 0: every frame gets a picture. Not thread-safe.
 *
 * While another app's layer on the cluster asks for the other videos'
 * upload bandwidth (cluster-render's others_fps), the renderer writes the
 * map at most at its fps_cap, so the pictures follow it (picture_rate),
 * and go back to picture_fps when it is released. */
#ifndef WOC_PICTURE_PACE_H
#define WOC_PICTURE_PACE_H

#include <stdint.h>

#include "frame_clock.h"

namespace woc {

class PicturePace {
public:
    static const int64_t kLeadDiv = 4;

    explicit PicturePace(unsigned fps) : fps_(fps) { clock_.configure(fps); }

    /* Another rate from the next picture on, which comes whatever the time
     * and starts the grid again. */
    void set_fps(unsigned fps)
    {
        if (fps == fps_)
            return;
        fps_ = fps;
        clock_.configure(fps);
        started_ = false;
    }
    unsigned fps() const { return fps_; }

    /* Whether a frame decoded at now_ms gets its picture. */
    bool due(int64_t now_ms) const { return !fps_ || !started_ || clock_.due(now_ms + lead_ms()); }

    /* A picture was made at now_ms: it takes the current slot. */
    void took(int64_t now_ms)
    {
        if (!fps_)
            return;
        if (!started_) {
            clock_.reset(now_ms);
            started_ = true;
        }
        clock_.sent(now_ms);
    }

    /* The next picture comes whatever the time, and the grid starts again
     * from it (the map shown again). */
    void reset() { started_ = false; }

    /* How long until a skipped frame, if still the newest, gets its picture
     * after all: its slot and the lead after it; 0 when that is now or past. */
    int64_t late_in_ms(int64_t now_ms) const
    {
        return fps_ && started_ ? clock_.ms_until_due(now_ms - lead_ms()) : 0;
    }

private:
    int64_t lead_ms() const { return 1000 / kLeadDiv / (int64_t)fps_; }

    unsigned fps_ = 0;
    bool started_ = false;
    crk::FrameClock clock_;
};

/* The pictures a second (0: every frame) for picture_fps (as loaded, 0 or
 * at least target_fps and floor) while the renderer holds the map to cap
 * updates a second (its fps_cap event; 0: not held): picture_fps when not
 * held, or held at target_fps or more (target_fps 0: no clock, so any cap
 * holds it); else the cap, or picture_fps when lower, and never below
 * floor (what the HUD and the freeze watch take). */
inline unsigned picture_rate(unsigned picture_fps, unsigned cap, unsigned target_fps, unsigned floor)
{
    if (!cap || (target_fps && cap >= target_fps))
        return picture_fps;
    const unsigned r = picture_fps && picture_fps < cap ? picture_fps : cap;
    return r < floor ? floor : r;
}

}  // namespace woc

#endif
