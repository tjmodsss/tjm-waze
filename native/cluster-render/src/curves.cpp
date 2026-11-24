/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "curves.h"

#include <cfloat>
#include <cmath>

namespace crs {

namespace {

/* The eased fraction of a segment at u (0-1). */
double ease(Curve c, double u)
{
    switch (c) {
    case Curve::EaseIn: return u * u * u;
    case Curve::EaseOut: {
        const double v = 1.0 - u;
        return 1.0 - v * v * v;
    }
    case Curve::EaseInOut:
        return u < 0.5 ? 4.0 * u * u * u : 1.0 - 4.0 * (1.0 - u) * (1.0 - u) * (1.0 - u);
    default: return u;
    }
}

bool holds(double x) { return std::isfinite(x) && std::fabs(x) <= FLT_MAX; }

}  // namespace

bool sample_curve(Curve c, Animation *a)
{
    const size_t n = a->t.size(), w = a->width;
    if (c == Curve::Linear || c == Curve::Step || n < 2)
        return true;
    const uint32_t steps = curve_steps(n);
    std::vector<uint32_t> t;
    std::vector<float> v;
    t.reserve((n - 1) * steps + 1);
    v.reserve(((n - 1) * steps + 1) * w);
    auto key = [&](size_t k, size_t i) { return (double)a->v[k * w + i]; };
    for (size_t k = 0; k + 1 < n; k++) {
        const uint32_t t0 = a->t[k], t1 = a->t[k + 1];
        /* Steps no closer than a millisecond: the keys' times stay apart. */
        const uint32_t s = t1 - t0 < steps ? t1 - t0 : steps;
        for (uint32_t j = 0; j < s; j++) {
            const double u = (double)j / (double)s;
            t.push_back(t0 + (uint32_t)((uint64_t)(t1 - t0) * j / s));
            for (size_t i = 0; i < w; i++) {
                const double p1 = key(k, i), p2 = key(k + 1, i);
                double x;
                if (c != Curve::Smooth) {
                    x = p1 + (p2 - p1) * ease(c, u);
                } else {
                    /* Catmull-Rom over the segment's time: slopes per ms
                     * from the neighbours, scaled to the segment. */
                    const double dt = (double)(t1 - t0);
                    const double m1 = k > 0 ? (p2 - key(k - 1, i)) / (double)(t1 - a->t[k - 1]) * dt : p2 - p1;
                    const double m2 = k + 2 < n ? (key(k + 2, i) - p1) / (double)(a->t[k + 2] - t0) * dt : p2 - p1;
                    if (!holds(m1) || !holds(m2))
                        return false;
                    const double u2 = u * u, u3 = u2 * u;
                    x = (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 +
                        (u3 - u2) * m2;
                }
                if (!holds(x))
                    return false;
                v.push_back((float)x);
            }
        }
    }
    t.push_back(a->t.back());
    for (size_t i = 0; i < w; i++)
        v.push_back(key(n - 1, i));
    a->t.swap(t);
    a->v.swap(v);
    a->step = false;
    return true;
}

}  // namespace crs
