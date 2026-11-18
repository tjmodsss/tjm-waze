// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test of the unit's own settings (local_conf.h): local_conf's known
 * keys over the shipped configuration's, a key this version does not know
 * and a line that does not read left out with a warning, the opt-in keys
 * left out there with a warning, a missing local_conf none; features_file's
 * valid opt-in values over the configuration's, any other line left out; the
 * shipped waze-on-cluster.conf loads, names the file patchd writes and has
 * the opt-in keys off. */
#include <unistd.h>

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

#include "config.h"
#include "local_conf.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static cld::Config conf()
{
    cld::Config c;
    c.define("target_fps", "30");
    c.define("src_crop", "");
    c.define("hosted_vpp_scale", "0");
    c.define("always_packed", "0");
    return c;
}

static bool has(const std::vector<std::string> &w, const std::string &s)
{
    for (const std::string &l : w)
        if (l.find(s) != std::string::npos)
            return true;
    return false;
}

int main()
{
    const std::string base = "/tmp/woc-local-conf-test-" + std::to_string(getpid());
    const std::string local = base + ".local.conf", feat = base + ".features.conf";
    unlink(local.c_str());
    unlink(feat.c_str());

    cld::Config c = conf();
    std::vector<std::string> w;
    load_local_conf(&c, local, &w);
    ok("no local conf: the configuration's, nothing to warn", c.str("target_fps") == "30" && w.empty());

    std::ofstream(local) << "# mine\ntarget_fps = 20\nsome_later_key = 7\nhosted_vpp_scale = 1\nalways_packed += 1\n"
                            "garbage\n  \nsrc_crop = 1280x564+0+0 # AA\n";
    c = conf();
    w.clear();
    load_local_conf(&c, local, &w);
    ok("an unknown key does not stop the rest: the known keys taken", c.str("target_fps") == "20" &&
                                                                         c.str("src_crop") == "1280x564+0+0");
    ok("the unknown key left out with a warning naming it and its line",
       has(w, local + ":3: unknown setting some_later_key"));
    ok("a line that does not read left out with a warning", has(w, local + ":6: expected key=value"));
    ok("the opt-in keys left out of the local conf, each with a warning",
       c.str("hosted_vpp_scale") == "0" && c.str("always_packed") == "0" &&
           has(w, ":4: hosted_vpp_scale is left out") && has(w, ":5: always_packed is left out"));
    ok("four warnings, one a line", w.size() == 4);

    c = conf();
    load_features(&c, feat);
    ok("no features file: the opt-in keys off", c.str("hosted_vpp_scale") == "0" && c.str("always_packed") == "0");
    std::ofstream(feat) << "hosted_vpp_scale = 1\nalways_packed += 1 # on\n";
    c = conf();
    load_features(&c, feat);
    ok("the features file's values (= and +=), over the configuration's", c.str("hosted_vpp_scale") == "1" && c.str("always_packed") == "1");
    std::ofstream(feat) << "hosted_vpp_scale = 2\nalways_packed = yes\ntarget_fps = 5\ngarbage\nalways_packed=1\n";
    c = conf();
    load_features(&c, feat);
    ok("out of range, another key or a line that does not read: left out, the rest taken",
       c.str("hosted_vpp_scale") == "0" && c.str("always_packed") == "1" && c.str("target_fps") == "30");
    unlink(local.c_str());
    unlink(feat.c_str());

    /* The shipped conf: what main() loads strictly before local_conf. */
    cld::Config shipped;
    shipped.define("hosted_vpp_scale", "");
    shipped.define("always_packed", "");
    shipped.define("features_file", "");
    shipped.extra_keys = [](const std::string &) { return true; };
    std::string err;
    ok("shipped: waze-on-cluster.conf reads", shipped.load("waze-on-cluster.conf", &err));
    ok("shipped: features_file is the file patchd writes", shipped.str("features_file") == "/var/opt/waze-on-cluster/features.conf");
    ok("shipped: the opt-in keys off", shipped.str("hosted_vpp_scale") == "0" && shipped.str("always_packed") == "0");
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
