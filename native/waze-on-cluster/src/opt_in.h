// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The opt-in settings over the shipped configuration.
 *
 * features_file (features.conf) holds only the opt-in keys (kFeatureKeys),
 * each 0 or 1; a valid value replaces the configuration's; another key, a
 * value out of range or a line that does not read is left out with a
 * warning, as is a file that cannot be read. Every release up to 0.10.7
 * refuses to start with these keys in its local conf, so they never go
 * there (patchd moves any it finds there to features_file). */
#ifndef WOC_OPT_IN_H
#define WOC_OPT_IN_H

#include <string>

#include "config.h"

namespace woc {

/* The keys features_file holds. */
extern const char *const kFeatureKeys[2];

void load_features(cld::Config *cfg, const std::string &path);

}  // namespace woc

#endif
