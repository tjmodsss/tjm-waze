/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 IterioDev */
/* The iDrive 8 display port: the DcsmProvider built into the unit's RAMSES
 * 27, whose consumer is the cluster (over SOME/IP RemoteContentManager
 * 0xB0A3), for any number of targets at once (README.md "iDrive 8").
 *
 * A target's slot is a DCSM category and TargetSpec::content the content
 * offered in it, as the target's scene. The cluster decides when to show
 * it: some categories by themselves (the cluster's middle, the HUD), the
 * widget once it is picked in the cluster's widget menu (VERIFIED on the
 * car). So:
 * - a request is an offer. Accepted, the target is parked: offered, not
 *   shown, with no timeout, as a Dcsm2 map the KOMBI parks. Refused, it is
 *   a transient refusal (the ladder): the library says only that it could
 *   not offer, and another provider offering the same content is the one
 *   cause a valid configuration leaves;
 * - the cluster asking for the content (contentReadyRequested) is answered
 *   at once: the scene is published before the offer;
 * - contentShow is shown; contentHide and contentRelease (the cluster takes
 *   the content back to Ready, Assigned or Offered, as on every layout
 *   change, VERIFIED on the car) are parked again: the offer stays;
 * - a release is a stop of the offer, confirmed() once the cluster accepts
 *   it (on the car within about 30 ms). Until then the library refuses a new
 *   offer of the content (even from inside stopOfferAccepted: it forgets the
 *   content only after that returns): the slot manager waits for the
 *   confirmation, and a request that comes anyway is refused (the ladder).
 *   The scene stays published meanwhile, warm (slots.h) or, taken down,
 *   retired until on_stopped (Ramses27Gpu::scene builds no new one with its
 *   id);
 * - nothing is lost while the offer stands: a cluster that goes away takes
 *   its assignments back (contentRelease), and the offer is there when it
 *   comes back. There is no slot table, no take-over (no counterpart is
 *   known) and no heartbeat.
 *
 * All of it runs on the render thread: the unit's loop dispatches the
 * provider's events (unit_idrive8.cpp), and dispatch() delivers what a
 * request decided once the slot manager has taken the request's state. */
#ifndef CRS_DCSM27_PORT_H
#define CRS_DCSM27_PORT_H

#include <functional>
#include <map>
#include <string>
#include <vector>

#include "graph.h"
#include "slots.h"

namespace crs {

/* The provider's calls, as unit_idrive8.cpp makes them. false: refused,
 * with the library's message in why. */
class Dcsm27Wire {
public:
    virtual ~Dcsm27Wire() {}
    virtual bool offer(const TargetSpec &t, std::string *why) = 0;
    virtual bool stop_offer(uint64_t content, std::string *why) = 0;
    virtual bool ready(uint64_t content, std::string *why) = 0;
};

/* The cluster's area for a content (contentSizeChange): its canvas, the
 * category's rect in it and the safe rect (canvas coordinates, VERIFIED on
 * the car), and the cluster's layout. A field it did not send is 0. */
struct ContentArea {
    uint32_t render_w = 0, render_h = 0;
    Rect rect, safe;
    uint32_t layout = 0;
    bool has_render = false, has_rect = false, has_safe = false, has_layout = false;
};

class Dcsm27Port : public Port {
public:
    explicit Dcsm27Port(Dcsm27Wire *wire) : wire_(wire) {}
    void set_manager(SlotManager *m) { manager_ = m; }

    bool available() const override { return up_; }
    void request(const TargetSpec &t) override;
    void release(const TargetSpec &t) override;
    bool confirmed(const TargetSpec &t) const override;
    void take_over(const TargetSpec &t, uint64_t content) override;
    void refresh_slots() override {}

    /* The framework connected (or not). */
    void on_availability(bool up, int64_t now_ms);
    /* What the cluster says, in the order the provider dispatched it. */
    void on_size(uint64_t content, const ContentArea &a, int64_t now_ms);
    void on_ready_requested(uint64_t content, int64_t now_ms);
    void on_show(uint64_t content, int64_t now_ms);
    void on_hide(uint64_t content, int64_t now_ms);
    void on_release(uint64_t content, int64_t now_ms);
    void on_stop_accepted(uint64_t content, int64_t now_ms);
    /* Delivers the answers to this pass's requests (after the slot
     * manager's tick, before the next one). */
    void dispatch(int64_t now_ms);
    /* An offer is stopping: the cluster has not accepted the stop yet. */
    bool stopping() const;
    /* A content of the scene is offered or its offer is stopping. */
    bool holds(uint64_t scene_id) const;
    /* No content offered or stopping and no answer or stop to deliver:
     * the provider has no event of ours to dispatch. */
    bool idle() const { return contents_.empty() && answers_.empty() && stopped_.empty(); }

    /* A released target's offer is gone (its stop accepted, or none to
     * stop): its scene may go now (Ramses27Gpu::drop_retired). Called from
     * dispatch(), after the pass that took the target down. */
    std::function<void(uint64_t scene_id)> on_stopped;

private:
    enum class Phase { Offered, Shown, Stopping };
    struct Content {
        TargetSpec spec;
        Phase phase = Phase::Offered;
        ContentArea area;   /* as last logged */
    };
    struct Answer {
        uint64_t scene = 0;
        bool refused = false;
        std::string why;
    };

    /* False: refused (answered as such); the caller forgets the content. */
    bool offer(Content &c);
    /* The content's target while its offer stands; null otherwise. */
    Content *offered(uint64_t content);

    Dcsm27Wire *wire_;
    SlotManager *manager_ = nullptr;
    bool up_ = false;
    std::map<uint64_t, Content> contents_;   /* by content id */
    std::vector<Answer> answers_;
    std::vector<uint64_t> stopped_;          /* scene ids, for on_stopped */
};

}  // namespace crs

#endif
