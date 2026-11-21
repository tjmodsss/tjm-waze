// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The program preload_test.sh preloads libwocpatch.so into: a PIE with a
 * string in .rodata and a function whose immediate is in .text.
 *   target dump   the two sites as "<name> <vaddr hex> <bytes hex>"
 *   target        "<message> <answer()>", then the same from a child
 *                 (sh -c), which inherits LD_PRELOAD */
#define _GNU_SOURCE
#include <link.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const char message[16] __attribute__((aligned(16))) = "stock message!!";
__attribute__((noinline)) int answer(void) { return 0x41414141; }

static int base_of(struct dl_phdr_info *info, size_t size, void *data) {
    (void)size;
    *(ElfW(Addr) *)data = info->dlpi_addr;
    return 1;
}

static void dump(const char *name, const void *at, size_t len, ElfW(Addr) base) {
    printf("%s %lx ", name, (unsigned long)((ElfW(Addr))at - base));
    for (size_t i = 0; i < len; i++) printf("%02x", ((const unsigned char *)at)[i]);
    printf("\n");
}

int main(int argc, char **argv) {
    ElfW(Addr) base = 0;
    dl_iterate_phdr(base_of, &base);
    if (argc > 1 && strcmp(argv[1], "dump") == 0) {
        dump("message", message, sizeof message, base);
        /* the 4-byte immediate of answer()'s mov eax,imm32 */
        const unsigned char *f = (const unsigned char *)answer;
        for (int i = 0; i < 16; i++) if (f[i] == 0xb8) { dump("answer", f + i + 1, 4, base); break; }
        return 0;
    }
    printf("%s %x\n", message, answer());
    fflush(stdout);
    if (argc == 1) return system("echo child");
    return 0;
}
