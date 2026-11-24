// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "h264_source.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <grp.h>
#include <libgen.h>
#include <poll.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <vector>

#include "log.h"

namespace woc {

H264Source::H264Source() {}

H264Source::~H264Source() { stop(); }

bool H264Source::start(const std::string &path, const std::string &group, const Sink &sink, std::string *err)
{
    path_ = path;
    sink_ = sink;
    bytes_ = 0;

    /* carplay (uid cia_13002) writes the FIFO; this tool (hmi_5000) reads it.
     * The one group both belong to is "video" (VERIFIED: /etc/group). Give the
     * FIFO and its directory that group so carplay can traverse to the FIFO and
     * open it for writing, without widening either to everyone. */
    gid_t gid = (gid_t)-1;
    if (!group.empty()) {
        struct group *g = getgrnam(group.c_str());
        if (g)
            gid = g->gr_gid;
        else
            log_warn("h264: group %s not found; carplay may not reach the FIFO", group.c_str());
    }

    /* The FIFO's directory: world-traversable (0755) so the carplay uid reaches
     * the FIFO (which is group-restricted) and the diagnostics uid reaches
     * status.json (0644). The directory listing is not sensitive. */
    std::vector<char> dirbuf(path.begin(), path.end());
    dirbuf.push_back('\0');
    const char *dir = dirname(dirbuf.data());
    if (dir && dir[0]) {
        mkdir(dir, 0755);   /* best effort: systemd's RuntimeDirectory usually made it */
        chmod(dir, 0755);
    }

    struct stat st;
    if (stat(path.c_str(), &st) != 0) {
        if (mkfifo(path.c_str(), 0620) != 0 && errno != EEXIST) {
            *err = "mkfifo " + path + ": " + std::strerror(errno);
            return false;
        }
    } else if (!S_ISFIFO(st.st_mode)) {
        *err = path + " exists and is not a FIFO";
        return false;
    }
    /* chmod after mkfifo: the umask strips the group write bit at creation. */
    if (gid != (gid_t)-1 && chown(path.c_str(), (uid_t)-1, gid) != 0)
        log_warn("h264: chgrp %s to the carplay group failed: %s", path.c_str(), std::strerror(errno));
    chmod(path.c_str(), 0620);

    /* O_RDWR, not O_RDONLY: holding a writer ourselves means poll never
     * reports permanent EOF when carplay closes between streams, so the
     * reader thread keeps running across CarPlay sessions. We never write. */
    fd_ = open(path.c_str(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (fd_ < 0) {
        *err = "open " + path + ": " + std::strerror(errno);
        return false;
    }
    if (pipe2(wake_, O_NONBLOCK | O_CLOEXEC) != 0) {
        *err = std::string("pipe2: ") + std::strerror(errno);
        close(fd_);
        fd_ = -1;
        return false;
    }
    running_ = true;
    thread_ = std::thread(&H264Source::loop, this);
    log_info("h264: reading %s", path.c_str());
    return true;
}

void H264Source::loop()
{
    std::vector<uint8_t> buf(64 * 1024);
    while (running_.load()) {
        struct pollfd p[2] = {{fd_, POLLIN, 0}, {wake_[0], POLLIN, 0}};
        /* Data or stop()'s byte on wake_ wakes it; nothing else is waited for. */
        int n = poll(p, 2, -1);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            break;
        }
        if (p[1].revents & POLLIN)
            break;
        if (!(p[0].revents & POLLIN))
            continue;
        for (;;) {
            ssize_t r = read(fd_, buf.data(), buf.size());
            if (r > 0) {
                bytes_.fetch_add((uint64_t)r);
                sink_(buf.data(), (size_t)r);
                if ((size_t)r < buf.size())
                    break;   /* drained for now */
            } else if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                break;
            } else {
                break;   /* 0: all writers gone this instant; wait for the next */
            }
        }
    }
}

void H264Source::stop()
{
    if (!running_.exchange(false))
        return;
    if (wake_[1] >= 0) {
        char c = 0;
        ssize_t n = write(wake_[1], &c, 1);
        (void)n;
    }
    if (thread_.joinable())
        thread_.join();
    for (int *fd : {&wake_[0], &wake_[1], &fd_}) {
        if (*fd >= 0) {
            close(*fd);
            *fd = -1;
        }
    }
}

}  // namespace woc
