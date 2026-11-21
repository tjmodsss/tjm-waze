// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* A library whose constructor starts a thread before libwocpatch.so's runs,
 * as libdlt's does in carplay. */
#include <pthread.h>
#include <unistd.h>

static void *spin(void *arg) { (void)arg; for (;;) usleep(1000); return 0; }

__attribute__((constructor)) static void start(void) {
    pthread_t t;
    pthread_create(&t, 0, spin, 0);
}
