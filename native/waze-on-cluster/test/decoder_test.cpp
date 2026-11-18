// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The decoder against the fake MSDK (fake_msdk.h). Its src_crop path: a
 * CarPlay sequence goes from decode to VPP without waiting for the decode
 * task, an Android Auto one is waited for and cropped, and a session that
 * goes from one to the other and back sets VPP up for each. Its pictures: a
 * picture equal to the one before comes out as the same, unpacked, and the
 * others packed with their levels rounded; after forget_last, the same
 * picture once more packed. GPU copy: asked for with
 * MFXInitEx on page-aligned surfaces. A session that cannot be made or set
 * up with it is made again without, the sequence starting over as it began
 * (a rect restart's exemption kept), and no session in the process asks
 * for it again. A VPP run failing with it loses that picture and the
 * session goes on as it is; three in a row move its output planes off
 * 16-byte alignment (the CPU copy), and every picture after them comes
 * out. Each failure runs in a child process, since the fallback is the
 * process's. Each SPS goes to the SPS sink. Each frame says how many frames
 * the decoder took after it before it came out: none when each comes out as
 * it is decoded, none for a frame taken and never output, the lag of
 * pictures held for display order, and unknown when the library does not
 * carry the bitstream's TimeStamp. A frame decoded without a picture gets it
 * late while its surface still holds it: once, the newest one's, cropped
 * as any other, and none once a later frame came out, once the decoder may
 * have taken its surface, or when its picture needs another VPP rect. */
#include <sys/wait.h>
#include <unistd.h>

#include <functional>
#include <stdio.h>

#include <string>
#include <vector>

#include "decoder_msdk.h"
#include "fake_msdk.h"
#include "log.h"

using fake_msdk::access_unit;
using fake_msdk::calls;
using fake_msdk::count;
using woc::Decoder;
using woc::OutputPart;
using woc::SourceCrop;
using woc::VideoFrame;

static int failures = 0;

/* body in a child process, so the process-wide GPU copy fallback starts
 * afresh; a failure in it is one here. */
static void isolated(const char *what, const std::function<void()> &body)
{
    fflush(stderr);
    const pid_t pid = fork();
    if (pid == 0) {
        failures = 0;
        body();
        fflush(stderr);
        _exit(failures ? 1 : 0);
    }
    int status = 0;
    if (pid < 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

static void fault(const char *call, int status, int after = 0, int times = 0)
{
    fake_msdk::gpu_fault.call = call;
    fake_msdk::gpu_fault.status = status;
    fake_msdk::gpu_fault.after = after;
    fake_msdk::gpu_fault.times = times;
}

/* How many entries of calls start with p. */
static int count_prefix(const std::string &p)
{
    int n = 0;
    for (const std::string &c : calls)
        n += c.compare(0, p.size(), p) == 0;
    return n;
}

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        for (const std::string &c : calls)
            fprintf(stderr, "    %s\n", c.c_str());
        failures++;
    }
}

namespace {

const char *const kCarPlay = "1088x480", *const kAndroidAuto = "1280x720";

struct Run {
    Decoder dec;
    /* Each frame: its atlas's first byte, 0 for the same picture again, -1
     * for none. */
    std::vector<int> frames;
    std::vector<uint8_t> pictures;   /* the atlases' first bytes */
    bool whole = true;               /* every atlas one level throughout */
    std::vector<int> held;           /* each frame's VideoFrame::held */
    uint32_t ow = 1088, oh = 480;    /* the size every frame comes at */
    OutputPart part;                 /* and the part it is (set_part) */

    explicit Run(const char *crop, unsigned level_bits = 0, bool gpu_copy = false)
    {
        calls.clear();
        SourceCrop c;
        parse_source_crop(crop, &c);
        std::string err;
        if (!dec.init("/dev/null", 1088, 480, level_bits, gpu_copy, &err, c))
            fprintf(stderr, "init: %s\n", err.c_str());
    }
    Decoder::FrameSink sink()
    {
        return [this](const VideoFrame &f) {
            expect(f.w == ow && f.h == oh && f.part == part, "every frame of the output size, the part it is");
            expect(!(f.same && f.atlas), "the same picture has no atlas");
            held.push_back(f.held);
            frames.push_back(f.atlas ? (*f.atlas)[0] : f.same ? 0 : -1);
            if (!f.atlas)
                return;
            expect(f.atlas->size() == (size_t)f.w * (f.h + f.h / 2), "the atlas of the frame's size");
            pictures.push_back((*f.atlas)[0]);
            for (uint8_t b : *f.atlas)
                whole = whole && b == (*f.atlas)[0];
        };
    }
    void feed(const char *sps, bool idr, uint8_t content, bool picture = true)
    {
        const std::string au = access_unit(sps, idr, content);
        std::string err;
        dec.feed((const uint8_t *)au.data(), au.size(), sink(), &err, true, picture);
    }
    /* picture_skipped through this run's sink. */
    bool late()
    {
        std::string err;
        const bool ok = dec.picture_skipped(sink(), &err);
        expect(err.empty(), "a late picture without an error");
        return ok;
    }
    /* A sequence: its SPS with an IDR, then n - 1 P frames. */
    void sequence(const char *size, int n, uint8_t first)
    {
        feed(size, true, first);
        for (int i = 1; i < n; i++)
            feed(nullptr, false, (uint8_t)(first + i));
    }
};

const char *const kAndroidAutoCrop = "1280x720:0,0,1280,564";

}  // namespace

int main()
{
    {
        /* Each SPS to the SPS sink, from its header byte to the next start
         * code, once whether its sequence goes on or restarts the decoder. */
        Run r("");
        std::vector<std::string> sps;
        r.dec.on_sps([&](const uint8_t *nal, size_t len) { sps.emplace_back((const char *)nal, len); });
        r.sequence(kCarPlay, 3, 10);
        r.sequence(kAndroidAuto, 2, 20);
        expect(sps == std::vector<std::string>({"\x67" "1088x480", "\x67" "1280x720"}), "each SPS to the SPS sink");
        expect(r.pictures.size() == 5, "each SPS's sequence decoded");
    }
    {
        /* held: a frame out as it is decoded holds none, and a frame the
         * decoder takes without output (a damaged one) is not held. */
        Run r("");
        fake_msdk::swallow = 12;
        r.sequence(kCarPlay, 5, 10);
        fake_msdk::swallow = 0;
        expect(r.pictures == std::vector<uint8_t>({10, 11, 13, 14}), "a frame taken without output: the others out");
        expect(r.held == std::vector<int>({0, 0, 0, 0}), "a frame taken without output: none held after it");
    }
    {
        /* Pictures held for display order: each out two frames late. */
        Run r("");
        fake_msdk::delay = 2;
        r.sequence(kCarPlay, 6, 20);
        fake_msdk::delay = 0;
        expect(r.pictures == std::vector<uint8_t>({20, 21, 22, 23}), "held pictures: out in order");
        expect(r.held == std::vector<int>({2, 2, 2, 2}), "held pictures: two frames taken after each");
    }
    {
        /* A library that does not carry the TimeStamp: held unknown. */
        Run r("");
        fake_msdk::timestamps = false;
        r.sequence(kCarPlay, 3, 30);
        fake_msdk::timestamps = true;
        expect(r.held == std::vector<int>({-1, -1, -1}), "no TimeStamp carried: held unknown");
    }
    {
        Run r(kAndroidAutoCrop);
        r.sequence(kCarPlay, 5, 10);
        expect(r.pictures == std::vector<uint8_t>({10, 11, 12, 13, 14}), "carplay with a crop: every picture");
        expect(r.held == std::vector<int>(5, 0), "carplay: each frame out as it is decoded");
        expect(count("decode-sync") == 0, "carplay with a crop: no wait for the decode task");
        expect(count("vpp 0,0,1088,480") == 5 && count("vpp-sync") == 5, "carplay with a crop: VPP on the whole picture");
        expect(count("init 1088x480") == 1, "carplay with a crop: one sequence");
    }
    {
        Run r(kAndroidAutoCrop);
        r.sequence(kAndroidAuto, 5, 20);
        expect(r.pictures == std::vector<uint8_t>({20, 21, 22, 23, 24}), "android auto: every picture");
        expect(count("vpp-init 0,0,1280,564") == 1, "android auto: VPP set up for the crop");
        expect(count("decode-sync") == 5 && count("vpp 0,0,1280,564") == 5, "android auto: each picture waited for and cropped");
        bool ordered = true;
        for (size_t i = 0; i < calls.size(); i++)
            if (calls[i] == "vpp 0,0,1280,564")
                ordered = ordered && i > 0 && calls[i - 1] == "decode-sync";
        expect(ordered, "android auto: the wait comes before VPP");
    }
    {
        /* One session: Android Auto, then CarPlay's smaller (compatible)
         * sequence, then Android Auto's larger (incompatible) one. */
        Run r(kAndroidAutoCrop);
        r.sequence(kAndroidAuto, 3, 30);
        r.sequence(kCarPlay, 3, 40);
        const size_t carplay_from = calls.size();
        r.feed(nullptr, false, 50);
        r.feed(nullptr, false, 51);
        const std::vector<std::string> carplay(calls.begin() + (long)carplay_from, calls.end());
        r.sequence(kAndroidAuto, 3, 60);
        expect(r.pictures == std::vector<uint8_t>({30, 31, 32, 40, 41, 42, 50, 51, 60, 61, 62}),
               "android auto, carplay, android auto: every picture");
        expect(count("init 1280x720") == 2 && count("init 1088x480") == 1, "a sequence set up for each change");
        expect(count("vpp-init 0,0,1280,564") == 2 && count("vpp-init 0,0,1088,480") == 1, "VPP set up for each rect");
        expect(count("vpp 0,0,1280,564") == 6 && count("vpp 0,0,1088,480") == 5, "each picture in its own rect");
        expect(carplay == std::vector<std::string>({"vpp 0,0,1088,480", "vpp-sync", "vpp 0,0,1088,480", "vpp-sync"}),
               "carplay after android auto: no wait for the decode task");
        /* The compatible SPS's picture is waited for once, to find it needs
         * another rect; Android Auto's six are waited for. */
        expect(count("decode-sync") == 7, "the waits: android auto's pictures and the change");
    }
    {
        /* A compatible SPS that makes a sequence croppable: a larger stream,
         * then Android Auto's within its surfaces. */
        Run r(kAndroidAutoCrop);
        r.sequence("1920x1080", 2, 70);
        r.sequence(kAndroidAuto, 2, 80);
        expect(r.pictures == std::vector<uint8_t>({70, 71, 80, 81}), "1920x1080 then android auto: every picture");
        expect(count("vpp 0,0,1920,1080") == 2 && count("vpp 0,0,1280,564") == 2, "the larger whole, android auto cropped");
        expect(count("init 1280x720") == 1 && count("vpp-init 0,0,1280,564") == 1, "android auto set up for its rect");
    }
    {
        /* Pictures equal to the one before: VPP's last output is what they
         * are compared with (a frame without a picture has none), an SPS that
         * keeps the sequence keeps it, and a new sequence starts afresh. */
        Run r("", 2);
        r.feed(kCarPlay, true, 5);
        r.feed(nullptr, false, 5);
        r.feed(nullptr, false, 5);
        r.feed(nullptr, false, 6);
        r.feed(nullptr, false, 6);
        r.feed(nullptr, false, 9, false);
        r.feed(nullptr, false, 6);
        r.feed(nullptr, false, 5);
        r.feed(kCarPlay, true, 5);
        r.feed(kAndroidAuto, true, 5);
        expect(r.frames == std::vector<int>({4, 0, 0, 8, 0, -1, 0, 4, 0, 4}),
               "the same pictures, the others rounded to 2 bits");
        expect(r.whole, "each atlas packed whole");
        expect(count("vpp-sync") == 9, "VPP on every frame with a picture");
        expect(r.dec.pack_us().n == 9, "each compared or packed");
        /* forgotten, the same picture again comes with its atlas, once */
        r.dec.forget_last();
        r.feed(nullptr, false, 5);
        r.feed(nullptr, false, 5);
        expect(r.frames.size() == 12 && r.frames[10] == 4 && r.frames[11] == 0,
               "after forget_last the last picture again is packed, then the same");
    }
    {
        Run r("", 0, true);
        r.sequence(kCarPlay, 3, 1);
        expect(r.pictures == std::vector<uint8_t>({1, 2, 3}), "gpu copy: every picture");
        expect(count("session gpucopy 1") == 1 && count("session") == 0, "gpu copy: asked for with MFXInitEx");
        expect(count("vpp-out unaligned") == 0, "gpu copy: VPP's output page-aligned, its pitch a multiple of 64");
        expect(r.dec.vpp_us().n == 3, "the wait for each VPP run timed");
    }
    {
        Run r("");
        r.sequence(kCarPlay, 2, 1);
        expect(count("session") == 1 && count("session gpucopy 1") == 0, "no gpu copy: MFXInit");
    }
    /* Each step of a session's setup failing with GPU copy. */
    const struct {
        const char *call, *what;
        int status;
    } steps[] = {{"MFXInitEx", "MFXInitEx refused", -3},
                 {"SetHandle", "SetHandle failing", -6},
                 {"DECODE_QueryIOSurf", "QueryIOSurf failing", -3},
                 {"VPP_Init", "VPP's Init failing", -4}};
    for (const auto &step : steps)
        isolated(step.what, [&step] {
            fault(step.call, step.status);
            Run r("", 0, true);
            r.sequence(kCarPlay, 2, 1);
            expect(r.pictures == std::vector<uint8_t>({1, 2}), step.what);
            expect(count("session gpucopy 1") == 1, "GPU copy asked for once");
            Run again("", 0, true);
            again.sequence(kCarPlay, 2, 3);
            expect(count("session gpucopy 1") == 0 && again.pictures == std::vector<uint8_t>({3, 4}),
                   "a decoder set up again with it: no GPU copy in this process");
        });
    isolated("a VPP run failing alone with GPU copy", [] {
        fault("VPP_Run", -17, 1, 1);
        Run r("", 0, true);
        r.sequence(kCarPlay, 4, 1);
        expect(r.pictures == std::vector<uint8_t>({1, 3, 4}), "that picture lost, every other one out");
        expect(count("session gpucopy 1") == 1 && count("session") == 0 && count("init 1088x480") == 1,
               "in the same session");
        expect(count("vpp-out shifted") == 0, "its output still copied on the GPU");
        Run again("", 0, true);
        again.sequence(kCarPlay, 2, 5);
        expect(count("session gpucopy 1") == 1 && again.pictures == std::vector<uint8_t>({5, 6}),
               "a decoder set up again still asks for GPU copy");
    });
    isolated("VPP runs failing with GPU copy, a successful one between", [] {
        fault("VPP_Run", -17, 0, 2);
        Run r("", 0, true);
        r.sequence(kCarPlay, 3, 1);
        fault("VPP_Run", -17, 0, 2);
        for (uint8_t i = 4; i <= 6; i++)
            r.feed(nullptr, false, i);
        expect(r.pictures == std::vector<uint8_t>({3, 6}), "the failed pictures lost");
        expect(count("vpp-out shifted") == 0, "the success starts the count again: still copied on the GPU");
    });
    isolated("three VPP runs in a row failing with GPU copy", [] {
        fault("VPP_Run", -17);
        Run r("", 0, true);
        r.sequence(kCarPlay, 6, 1);
        expect(r.pictures == std::vector<uint8_t>({4, 5, 6}),
               "those pictures lost, the session going on with every picture after them");
        expect(count("session gpucopy 1") == 1 && count("session") == 0 && count("init 1088x480") == 1,
               "in the same session");
        expect(count("vpp-out shifted") == 3, "its output copied on the CPU");
        r.sequence(kAndroidAuto, 2, 9);
        expect(count("session") == 1, "the next sequence in a session without GPU copy");
    });
    isolated("a rect restart's exemption kept through the fallback", [] {
        /* Android Auto's sequence whose pictures are CarPlay's size: a rect
         * restart, then converted as they are. VPP's Init fails with GPU
         * copy at that restart. */
        fault("VPP_Init", -4, 1);
        fake_msdk::picture_size = "1088x480";
        Run r(kAndroidAutoCrop, 0, true);
        r.sequence(kAndroidAuto, 3, 1);
        expect(r.pictures == std::vector<uint8_t>({1, 2, 3}), "every picture");
        expect(count("init 1280x720") == 3, "the first start, the restart with GPU copy, and without");
    });
    {
        /* A frame decoded without a picture gets it late (picture_skipped)
         * while nothing was decoded since: once, never after a later decode,
         * and nothing when the last frame had its picture. */
        Run r("");
        r.feed(kCarPlay, true, 10);
        expect(!r.late(), "late: nothing when the last frame had its picture");
        r.feed(nullptr, false, 11, false);
        expect(r.late(), "late: the skipped frame's picture");
        expect(!r.late(), "late: only once");
        r.feed(nullptr, false, 12, false);
        r.feed(nullptr, false, 13);
        expect(!r.late(), "late: nothing once a later frame was decoded");
        r.feed(nullptr, false, 14, false);
        r.feed(nullptr, false, 15, false);
        expect(r.late(), "late: the newest of two skipped frames");
        expect(r.pictures == std::vector<uint8_t>({10, 11, 13, 15}), "late: each picture the newest frame's");
        expect(r.frames == std::vector<int>({10, -1, 11, -1, 13, -1, -1, 15}), "late: frames in order");
    }
    {
        /* A sequence src_crop checks: the late picture is cropped as any
         * other, without waiting for its decode again. */
        Run r(kAndroidAutoCrop);
        r.feed(kAndroidAuto, true, 20);
        r.feed(nullptr, false, 21, false);
        const int syncs = count("decode-sync");
        expect(r.late(), "late: a sequence src_crop checks");
        expect(count("decode-sync") == syncs, "late: its decode not waited for again");
        expect(count("vpp 0,0,1280,564") == 2, "late: cropped");
        expect(r.pictures == std::vector<uint8_t>({20, 21}), "late: the cropped sequence's pictures");
    }
    {
        /* A picture that needs another VPP input rect gets no late picture
         * (a restart starts at an access unit); the next frame's picture
         * restarts the decoder. */
        Run r(kAndroidAutoCrop);
        r.feed(kAndroidAuto, true, 22);
        fake_msdk::picture_size = "1088x480";
        r.feed(nullptr, false, 23, false);
        expect(!r.late(), "late: none for a picture that needs another rect");
        expect(count("init 1280x720") == 1, "late: no restart outside an access unit");
        fake_msdk::picture_size = "";
    }
    {
        /* An access unit that outputs no frame leaves the skipped frame's
         * surface alone when the decoder keeps it as a reference: its late
         * picture still comes. Without that, the decoder may be handed the
         * surface, and no late picture comes. */
        fake_msdk::refs = 1;
        Run r("");
        r.feed(kCarPlay, true, 30);
        r.feed(nullptr, false, 31, false);
        fake_msdk::swallow = 32;
        r.feed(nullptr, false, 32);
        expect(r.late(), "late: after an access unit that output nothing");
        expect(r.pictures == std::vector<uint8_t>({30, 31}), "late: the skipped frame's picture");
        fake_msdk::refs = 0;
        Run u("");
        u.feed(kCarPlay, true, 33);
        u.feed(nullptr, false, 34, false);
        fake_msdk::swallow = 35;
        u.feed(nullptr, false, 35);
        expect(!u.late(), "late: none once its surface was handed to the decoder");
        fake_msdk::swallow = 0;
    }
    {
        Run r("");
        r.sequence(kAndroidAuto, 3, 90);
        r.sequence(kCarPlay, 3, 95);
        expect(count("decode-sync") == 0, "no crop: no wait for the decode task");
        expect(count("header 1280x720") == 1 && count("header 1088x480") == 0, "no crop: no header read while running");
        expect(count_prefix("vpp-reset") == 0, "no part (hosted_vpp_scale off): VPP never reset");
    }
    const OutputPart host{24, 0, 1040, 480, 936, 432};   /* a host's 1040x480 of the map, shown at 936x432 */
    {
        /* A part asked for before the stream: VPP set up whole for the
         * sequence, then reset for the part; each picture waited for and
         * given the part's rect, out at the part's size. Unset at a
         * picture: VPP reset whole, no wait. Another mid-sequence: at the
         * next picture, the first never the same as one before; a late
         * picture as any other. */
        Run r("");
        r.dec.set_part(host);
        r.part = host;
        r.ow = 936;
        r.oh = 432;
        r.sequence(kCarPlay, 3, 1);
        expect(count("vpp-init 0,0,1088,480") == 1 && count("vpp-reset 24,0,1040,480 936x432") == 1,
               "part: VPP set up whole for the sequence, then reset for the part");
        expect(count("vpp 24,0,1040,480") == 3 && count("decode-sync") == 3, "part: each picture waited for, in its rect");
        expect(r.pictures == std::vector<uint8_t>({1, 2, 3}) && r.whole, "part: every picture");
        r.dec.set_part(OutputPart());
        r.part = OutputPart();
        r.ow = 1088;
        r.oh = 480;
        r.feed(nullptr, false, 3);
        expect(count("vpp-reset 0,0,1088,480 1088x480") == 1 && count("vpp 0,0,1088,480") == 1 && count("decode-sync") == 3,
               "part unset: VPP reset whole, the picture whole without the wait");
        expect(r.frames.back() == 3, "part unset: the first picture packed, not the same as the part's");
        const OutputPart q{100, 40, 600, 400, 300, 200};
        r.dec.set_part(q);
        r.part = q;
        r.ow = 300;
        r.oh = 200;
        r.feed(nullptr, false, 5);
        r.feed(nullptr, false, 5);
        expect(count("vpp-reset 100,40,600,400 300x200") == 1 && count("vpp 100,40,600,400") == 2,
               "a part mid-sequence: from the next picture");
        expect(r.frames.size() == 6 && r.frames[4] == 5 && r.frames[5] == 0, "a part's pictures compared as any");
        r.feed(nullptr, false, 6, false);
        expect(r.late() && r.pictures.back() == 6 && count("vpp 100,40,600,400") == 3, "a part's late picture");
    }
    {
        /* With src_crop: the part of the crop of each picture. 24..1064 of
         * 1088 is 28.2..1251.8 of 1280: 28..1252, all of its 564 rows. */
        Run r(kAndroidAutoCrop);
        r.dec.set_part(host);
        r.part = host;
        r.ow = 936;
        r.oh = 432;
        r.sequence(kAndroidAuto, 2, 10);
        expect(count("vpp-init 0,0,1280,564") == 1 && count("vpp-reset 28,0,1224,564 936x432") == 1,
               "part with src_crop: VPP set up for the crop, then reset for its part");
        expect(count("vpp 28,0,1224,564") == 2 && r.pictures == std::vector<uint8_t>({10, 11}),
               "part with src_crop: each picture in the part's rect of its crop");
    }
    {
        /* A part VPP's reset refuses: logged, VPP reset whole, the pictures
         * whole, not asked again in the sequence; asked again in the next
         * (a larger stream). */
        Run r("");
        fake_msdk::reset_status = -15;
        fake_msdk::reset_faults = 1;
        r.dec.set_part(host);
        r.sequence(kCarPlay, 3, 1);
        expect(count("vpp-reset 24,0,1040,480 936x432") == 1 && count("vpp-reset 0,0,1088,480 1088x480") == 1,
               "reset refused: asked once in the sequence, VPP reset whole");
        expect(count("vpp 0,0,1088,480") == 3 && r.pictures == std::vector<uint8_t>({1, 2, 3}),
               "reset refused: every picture whole");
        r.part = host;
        r.ow = 936;
        r.oh = 432;
        r.sequence(kAndroidAuto, 1, 4);
        expect(count("vpp-reset 28,0,1224,720 936x432") == 1 && r.pictures.back() == 4,
               "reset refused: asked again in the next sequence");
    }
    {
        /* The whole output's reset failing too: VPP closed and set up again. */
        Run r("");
        fake_msdk::reset_status = -15;
        fake_msdk::reset_faults = 2;
        r.dec.set_part(host);
        r.sequence(kCarPlay, 2, 1);
        expect(count("vpp-init 0,0,1088,480") == 2 && r.pictures == std::vector<uint8_t>({1, 2}),
               "both resets refused: VPP set up again whole, every picture whole");
    }
    {
        /* A part VPP is not used for (more than 8 times smaller): no reset,
         * every picture whole. */
        Run r("");
        r.dec.set_part(OutputPart{0, 0, 1088, 480, 128, 32});
        r.sequence(kCarPlay, 2, 1);
        expect(count_prefix("vpp-reset") == 0 && count("vpp 0,0,1088,480") == 2, "a part too small: whole pictures");
    }
    {
        /* With src_crop the limit is VPP's: 1088x480 of the output at 136x60
         * is 8 times, but VPP would scale 1280x564 of its input, 9.4 times:
         * refused, every picture whole (the CPU scales it). */
        Run r(kAndroidAutoCrop);
        r.dec.set_part(OutputPart{0, 0, 1088, 480, 136, 60});
        r.sequence(kAndroidAuto, 2, 1);
        expect(count_prefix("vpp-reset") == 0 && count("vpp 0,0,1280,564") == 2,
               "a part 8 times smaller in the output, more in src_crop's input: whole pictures");
    }
    isolated("VPP not set up again after a failed whole set-up", [&host] {
        /* A part made, then unset: the whole output's reset refused and its
         * set-up after closing VPP failing too: one error, the pictures
         * whole, not tried again at each picture of the sequence. */
        fault("VPP_Init", -3, 1);
        Run r("", 0, true);
        r.dec.set_part(host);
        r.part = host;
        r.ow = 936;
        r.oh = 432;
        r.feed(kCarPlay, true, 1);
        fake_msdk::reset_status = -15;
        fake_msdk::reset_faults = 100;
        r.dec.set_part(OutputPart());
        r.part = OutputPart();
        r.ow = 1088;
        r.oh = 480;
        const int errors = cld::log_errors;
        for (uint8_t c = 2; c <= 4; c++)
            r.feed(nullptr, false, c);
        expect(cld::log_errors - errors == 1 && count("vpp-reset 0,0,1088,480 1088x480") == 1 &&
                   count_prefix("vpp-init") == 2 && r.pictures == std::vector<uint8_t>({1, 2, 3, 4}),
               "the whole output's set-up failing: one error, not one a picture");
    });
    isolated("a VPP run failing with a part", [&host] {
        fault("VPP_Run", -17, 1, 1);
        Run r("", 0, true);
        r.dec.set_part(host);
        r.part = host;
        r.ow = 936;
        r.oh = 432;
        r.feed(kCarPlay, true, 1);
        r.part = OutputPart();
        r.ow = 1088;
        r.oh = 480;
        r.feed(nullptr, false, 2);
        r.feed(nullptr, false, 3);
        expect(r.pictures == std::vector<uint8_t>({1, 3}), "a VPP run failing with a part: that picture lost, then whole");
        expect(count("vpp-reset 0,0,1088,480 1088x480") == 1 && count("vpp-reset 24,0,1040,480 936x432") == 1,
               "a VPP run failing with a part: VPP reset whole, the part not asked again");
        expect(count("vpp-out shifted") == 0, "a VPP run failing with a part: GPU copy kept");
    });
    if (failures) {
        fprintf(stderr, "decoder_test: %d failures\n", failures);
        return 1;
    }
    printf("decoder_test: ok\n");
    return 0;
}
