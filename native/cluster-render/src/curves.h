/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Eased animation curves (PROTOCOL.md "Animations"), played by the
 * renderers as linear keys: each segment between two of the client's keys
 * sampled at steps the service chooses, so the same curve plays on RAMSES 19
 * and RAMSES 27, which share linear and step splines only (RAMSES 27 has no
 * Bezier ones).
 *
 * - ease_in, ease_out, ease_in_out: each segment eased by a cubic (it
 *   starts slow, ends slow, or both), from key to key;
 * - smooth: a Catmull-Rom curve through every key (the segments' slopes
 *   from their neighbours, the first and last keys' from their one), so a
 *   needle sent to new values moves without corners. */
#ifndef CRS_CURVES_H
#define CRS_CURVES_H

#include <stdint.h>
#include <vector>

#include "graph.h"

namespace crs {

enum class Curve { Linear, Step, EaseIn, EaseOut, EaseInOut, Smooth };

/* Keys a curve may be sampled into, in all. */
const size_t kMaxSampledKeys = 1024;

/* The steps a segment of a curve over keys keys takes: as many as the
 * sampled keys allow, at most 16, at least 1. */
inline uint32_t curve_steps(size_t keys)
{
    if (keys < 2)
        return 1;
    const size_t s = (kMaxSampledKeys - 1) / (keys - 1);
    return s > 16 ? 16 : s < 1 ? 1 : (uint32_t)s;
}

/* *a's keys as linear keys along curve c (Linear and Step: as they are),
 * worked out in double. False, *a unchanged, when a sampled key or a slope
 * is not a finite float (keys near the ends of the float range). */
bool sample_curve(Curve c, Animation *a);

}  // namespace crs

#endif
