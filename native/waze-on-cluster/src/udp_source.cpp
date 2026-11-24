// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "udp_source.h"

#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

#include "log.h"

namespace woc {

/* O_NONBLOCK + FD_CLOEXEC without the Linux-only one-shot syscalls, so this
 * compiles for the host test as well as the unit's Linux target. */
static bool set_nonblock_cloexec(int fd)
{
    int fl = fcntl(fd, F_GETFL);
    int fd_fl = fcntl(fd, F_GETFD);
    return fl >= 0 && fd_fl >= 0 &&
           fcntl(fd, F_SETFL, fl | O_NONBLOCK) == 0 &&
           fcntl(fd, F_SETFD, fd_fl | FD_CLOEXEC) == 0;
}

UdpSource::UdpSource() {}

UdpSource::~UdpSource() { stop(); }

bool UdpSource::start(uint16_t port, const Sink &sink, std::string *err)
{
    sink_ = sink;
    bytes_ = 0;
    packets_ = 0;

    fd_ = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd_ < 0) { *err = std::string("udp socket: ") + std::strerror(errno); return false; }
    set_nonblock_cloexec(fd_);
    /* A large receive buffer: the bridge can burst packets faster than a
     * static-map decode drains them, and a dropped datagram is a corrupt frame.
     * No SO_REUSEADDR: this is the sole listener, and allowing a co-bind would
     * only make which socket receives a datagram ambiguous. */
    int rcv = 4 * 1024 * 1024;
    setsockopt(fd_, SOL_SOCKET, SO_RCVBUF, &rcv, sizeof rcv);

    struct sockaddr_in addr;
    std::memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   /* carplay writes to 127.0.0.1 */
    if (bind(fd_, (struct sockaddr *)&addr, sizeof addr) != 0) {
        *err = "udp bind 127.0.0.1:" + std::to_string(port) + ": " + std::strerror(errno);
        close(fd_);
        fd_ = -1;
        return false;
    }
    if (pipe(wake_) != 0) {
        *err = std::string("pipe: ") + std::strerror(errno);
        close(fd_);
        fd_ = -1;
        return false;
    }
    set_nonblock_cloexec(wake_[0]);
    set_nonblock_cloexec(wake_[1]);
    running_ = true;
    thread_ = std::thread(&UdpSource::loop, this);
    log_info("udp: receiving on 127.0.0.1:%u", (unsigned)port);
    return true;
}

void UdpSource::loop()
{
    std::vector<uint8_t> buf(65536);   /* one UDP datagram; preserves boundaries */
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
            ssize_t r = recv(fd_, buf.data(), buf.size(), 0);
            if (r > 0) {
                bytes_.fetch_add((uint64_t)r);
                packets_.fetch_add(1);
                sink_(buf.data(), (size_t)r);
            } else if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                break;
            } else if (r < 0 && errno == EINTR) {
                continue;
            } else {
                break;
            }
        }
    }
}

void UdpSource::stop()
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
