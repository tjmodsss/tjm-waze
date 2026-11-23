/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* A display port for host runs (slots.h) that keeps a slot table the way the
 * KOMBI does (../dcsm/DCSM.md "Slots: one shown, the rest parked"): one row
 * per mapping, the first content mapped into a slot shown, later ones parked
 * and the oldest parked shown when the shown one goes. Requests are answered
 * after grant_ms. A test can play the stock HMI mapping its content, taking
 * a slot from us, the slot coming free and the display service going away;
 * a take-over unmaps the HMI's content, which the HMI maps again (parked).
 * Every change of the table is reported, as the KOMBI reports every slot on
 * each arbitration. A release is confirmed confirm_ms after it (the car:
 * about 35 ms). A load (preload) is fetched after grant_ms and kept
 * unmapped; an unmap keeps the fetch; a remap maps a kept fetch after
 * grant_ms. */
#ifndef CRS_FAKE_PORT_H
#define CRS_FAKE_PORT_H

#include <map>
#include <set>
#include <string>
#include <vector>

#include "../src/slots.h"

namespace crs {

class FakePort : public Port {
public:
    SlotManager *m = nullptr;
    bool up = true;
    int64_t grant_ms = 50;
    int64_t confirm_ms = 35;
    int requests = 0, releases = 0, loads = 0, remaps = 0;
    std::map<uint64_t, int64_t> loading;   /* scene -> when its load is fetched */
    std::set<uint64_t> fetched;            /* scenes loaded or unmapped, kept fetched */
    int64_t last_request_ms = -1, last_release_ms = -1;
    std::map<uint64_t, int64_t> releasing;   /* scene -> when its release is confirmed */
    std::vector<uint64_t> taken_over;      /* contents a take-over unmapped, in order */
    std::map<uint64_t, int64_t> pending;   /* scene -> when it is answered */
    std::vector<uint64_t> promoted;        /* scenes of ours shown since, told at the next tick */
    std::map<uint64_t, uint64_t> slot_of;  /* scene -> the slot it was asked for */
    std::vector<SlotInfo> table;           /* one row per mapping, oldest first */

    bool available() const override { return up; }
    void request(const TargetSpec &t) override
    {
        requests++;
        last_request_ms = now;
        releasing.erase(t.scene_id);
        pending[t.scene_id] = now + grant_ms;
        slot_of[t.scene_id] = t.slot;
    }
    bool confirmed(const TargetSpec &t) const override
    {
        auto it = releasing.find(t.scene_id);
        return it == releasing.end() || now >= it->second;
    }
    void release(const TargetSpec &t) override
    {
        releases++;
        last_release_ms = now;
        releasing[t.scene_id] = now + confirm_ms;
        pending.erase(t.scene_id);
        loading.erase(t.scene_id);
        fetched.erase(t.scene_id);
        if (unmap(t.slot, t.scene_id))
            report();
    }
    bool preloads() const override { return true; }
    void load(const TargetSpec &t) override
    {
        loads++;
        last_request_ms = now;
        releasing.erase(t.scene_id);
        loading[t.scene_id] = now + grant_ms;
        slot_of[t.scene_id] = t.slot;
    }
    bool unmap(const TargetSpec &t) override
    {
        pending.erase(t.scene_id);
        fetched.insert(t.scene_id);
        if (unmap(t.slot, t.scene_id))
            report();
        return true;
    }
    bool remap(const TargetSpec &t, int64_t) override
    {
        if (!fetched.erase(t.scene_id))
            return false;
        remaps++;
        pending[t.scene_id] = now + grant_ms;
        return true;
    }
    void take_over(const TargetSpec &t, uint64_t content) override
    {
        taken_over.push_back(content);
        if (!unmap(t.slot, content))
            return;
        map(t.slot, content);
        report();
    }
    void refresh_slots() override { report(); }

    void tick(int64_t t)
    {
        now = t;
        std::vector<uint64_t> shown;
        shown.swap(promoted);
        for (uint64_t scene : shown)
            m->on_shown(scene, t);
        for (auto it = loading.begin(); it != loading.end();) {
            if (t >= it->second) {
                const uint64_t scene = it->first;
                it = loading.erase(it);
                fetched.insert(scene);
                m->on_fetched(scene, t);
            } else {
                ++it;
            }
        }
        for (auto it = pending.begin(); it != pending.end();) {
            if (t >= it->second) {
                const uint64_t scene = it->first;
                it = pending.erase(it);
                const bool shown = map(slot_of[scene], scene);
                report();
                if (shown)
                    m->on_shown(scene, t);
                else
                    m->on_parked(scene, t);
            } else {
                ++it;
            }
        }
    }
    /* The stock HMI maps its content into the slot: shown if the slot shows
     * nothing, else parked. */
    void stock_map(uint64_t slot, uint64_t content)
    {
        map(slot, content);
        report();
    }
    /* The stock HMI unmaps its content from the slot. */
    void stock_unmap(uint64_t slot, uint64_t content)
    {
        if (unmap(slot, content))
            report();
    }
    /* The stock HMI maps its own content over the target's slot, removing
     * ours. */
    void steal(const TargetSpec &t, uint64_t stock_scene = 0x01000101)
    {
        clear(t.slot);
        add(t.slot, stock_scene, 1);
        report();
        m->on_lost(t.scene_id, "fetch removed", now);
    }
    void free_slot(const TargetSpec &t)
    {
        clear(t.slot);
        add(t.slot, 0, 0);
        report();
    }
    /* The KOMBI's watchdog drops every mapping of ours: the service went
     * away without releasing them. */
    void watchdog()
    {
        pending.clear();
        promoted.clear();
        loading.clear();
        fetched.clear();
        std::vector<SlotInfo> rows = table;
        for (const SlotInfo &s : rows)
            if (slot_of.count(s.content))
                unmap(s.slot, s.content);
    }
    void set_up(bool on)
    {
        up = on;
        pending.clear();
        loading.clear();
        fetched.clear();
        m->on_availability(on, now);
    }
    /* The row of content in slot; null: none. */
    const SlotInfo *row(uint64_t slot, uint64_t content) const
    {
        for (const SlotInfo &s : table)
            if (s.slot == slot && s.content == content)
                return &s;
        return nullptr;
    }

    int64_t now = 0;

private:
    bool shows(uint64_t slot) const
    {
        for (const SlotInfo &s : table)
            if (s.slot == slot && s.map_status == 1)
                return true;
        return false;
    }
    void add(uint64_t slot, uint64_t content, uint32_t map_status)
    {
        SlotInfo s;
        s.slot = slot;
        s.content = content;
        s.map_status = map_status;
        table.push_back(s);
        status(slot);
    }
    void clear(uint64_t slot)
    {
        for (size_t i = table.size(); i-- > 0;)
            if (table[i].slot == slot)
                table.erase(table.begin() + i);
    }
    /* Maps content into slot; true: shown, false: parked. */
    bool map(uint64_t slot, uint64_t content)
    {
        for (size_t i = table.size(); i-- > 0;)
            if (table[i].slot == slot && (table[i].content == 0 || table[i].content == content))
                table.erase(table.begin() + i);
        const bool shown = !shows(slot);
        add(slot, content, shown ? 1 : 3);
        return shown;
    }
    /* Unmaps content from slot and shows the oldest parked row. False: it
     * was not mapped there. */
    bool unmap(uint64_t slot, uint64_t content)
    {
        bool found = false;
        for (size_t i = table.size(); i-- > 0;)
            if (table[i].slot == slot && table[i].content == content) {
                table.erase(table.begin() + i);
                found = true;
            }
        if (!found)
            return false;
        if (!shows(slot))
            for (SlotInfo &s : table)
                if (s.slot == slot && s.map_status == 3) {
                    s.map_status = 1;
                    status(slot);
                    if (slot_of.count(s.content))
                        promoted.push_back(s.content);
                    return true;
                }
        bool any = false;
        for (const SlotInfo &s : table)
            any = any || s.slot == slot;
        if (!any)
            add(slot, 0, 0);
        status(slot);
        return true;
    }
    void status(uint64_t slot)
    {
        const uint32_t st = shows(slot) ? 2 : 1;
        for (SlotInfo &s : table)
            if (s.slot == slot)
                s.status = st;
    }
    void report()
    {
        if (m)
            m->on_slots(table, now);
    }
};

}  // namespace crs

#endif
