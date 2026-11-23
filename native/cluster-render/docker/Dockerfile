# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu

# Build and test userland matching the head unit: Ubuntu 18.04 amd64 has
# gcc 7.5 / libstdc++ 6.0.24 and glibc 2.27, the versions the unit's
# libvsomeip3 3.1.34 and libramses 19.0.14 were built against. Pinned to the
# amd64 manifest.
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
# The Ubuntu archive is slow or refuses connections at times, and apt-get
# update can succeed with index files missing.
RUN for i in 1 2 3 4 5 6; do \
      apt-get update -q \
      && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
           g++ make binutils python3 python3-pyelftools \
      && break; \
      [ "$i" = 6 ] && exit 1; sleep 30; \
    done \
 && rm -rf /var/lib/apt/lists/*
