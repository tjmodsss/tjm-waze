// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The unit's own settings over the shipped configuration.
 *
 * local_conf (waze-on-cluster.local.conf), which updates keep, is read line
 * by line: a key this version does not know, or a line that does not read,
 * is left out with a warning and the rest taken, so a local conf written for
 * a later version still starts this one. Every release up to 0.10.7 refuses
 * to start with a key it does not know there, so a key that release lacks
 * never belongs in local_conf: the opt-in keys (kFeatureKeys) live in
 * features_file instead, which no release before this one reads; found in
 * local_conf they are left out with a warning (patchd moves them).
 *
 * features_file (features.conf) holds the opt-in keys, each 0 or 1; a valid
 * value replaces the configuration's; another key, a value out of range or
 * a line that does not read is left out with a warning, as is a file that
 * cannot be read. */
#ifndef WOC_LOCAL_CONF_H
#define WOC_LOCAL_CONF_H

#include <string>
#include <vector>

#include "config.h"

namespace woc {

/* The keys features_file holds. */
extern const char *const kFeatureKeys[2];

/* local_conf's settings over cfg's; a missing file is none. Each line left
 * out is one entry in *warnings. */
void load_local_conf(cld::Config *cfg, const std::string &path, std::vector<std::string> *warnings);

void load_features(cld::Config *cfg, const std::string &path);

}  // namespace woc

#endif
