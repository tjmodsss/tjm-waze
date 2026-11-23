/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "ramses_console.h"

#include <fcntl.h>
#include <strings.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <cstring>
#include <thread>

#include "log.h"

namespace crs {

namespace {

const char kSubscription[] = "received scene subscription for ";
const char kUnsubscription[] = "received scene unsubscription for ";
const char kDisconnected[] = "unsubscribing all scenes for ";
const char kRequest[] = "ResourceComponent::handleRequestResources(from ";
const char kAvailable[] = "send locally available ";

bool hex_digit(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
bool alnum(char c) { return hex_digit(c) || (c >= 'g' && c <= 'z') || (c >= 'G' && c <= 'Z') || c == '_'; }

/* The token at p: spaces and quotes skipped, up to a space, quote or
 * bracket; *end past it. */
std::string token(const std::string &s, size_t p, size_t *end = nullptr)
{
    while (p < s.size() && (s[p] == ' ' || s[p] == '\'' || s[p] == '"'))
        p++;
    size_t q = p;
    while (q < s.size() && !std::strchr(" '\",;:()[]", s[q]))
        q++;
    if (end)
        *end = q;
    return s.substr(p, q - p);
}

/* A decimal or 0x hex number at p, after spaces, quotes and brackets. */
bool number(const std::string &s, size_t p, uint64_t *v, size_t *end)
{
    while (p < s.size() && std::strchr(" '\"[(", s[p]))
        p++;
    const bool hex = s.compare(p, 2, "0x") == 0 || s.compare(p, 2, "0X") == 0;
    const size_t start = hex ? p + 2 : p;
    size_t q = start;
    while (q < s.size() && (hex ? hex_digit(s[q]) : (s[q] >= '0' && s[q] <= '9')))
        q++;
    if (q == start || q - start > (hex ? 16u : 20u))
        return false;
    *v = std::strtoull(s.substr(start, q - start).c_str(), nullptr, hex ? 16 : 10);
    *end = q;
    return true;
}

/* what occurs in s at a word's bounds, case-insensitively for hex. */
bool has_word(const std::string &s, const std::string &what)
{
    for (size_t p = 0; p + what.size() <= s.size(); p++) {
        if (strncasecmp(s.c_str() + p, what.c_str(), what.size()) != 0)
            continue;
        const bool before = p > 0 && alnum(s[p - 1]);
        const bool after = p + what.size() < s.size() && alnum(s[p + what.size()]);
        if (!before && !after)
            return true;
    }
    return false;
}

/* "ramses.Client" from "<time> [ Info  ] ramses.Client        | ..."; "other"
 * for a line that names no RAMSES context. */
std::string line_context(const std::string &line)
{
    const size_t p = line.find(" ramses.");
    if (p == std::string::npos)
        return "other";
    size_t q = p + 1;
    while (q < line.size() && line[q] != ' ' && line[q] != '|')
        q++;
    return line.substr(p + 1, q - p - 1);
}

void write_all(int fd, const char *p, size_t n)
{
    while (n > 0) {
        const ssize_t w = write(fd, p, n);
        if (w < 0 && errno == EINTR)
            continue;
        if (w <= 0)
            return;   /* the original stdout is gone; keep draining the pipe */
        p += w;
        n -= (size_t)w;
    }
}

}  // namespace

std::string strip_colours(const char *s, size_t n)
{
    std::string out;
    out.reserve(n);
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '\x1b' && i + 1 < n && s[i + 1] == '[') {
            i += 2;
            while (i < n && !((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z')))
                i++;
            continue;
        }
        if (s[i] != '\n' && s[i] != '\r')
            out += s[i];
    }
    return out;
}

bool parse_console_line(const std::string &line, ConsoleEvent *e)
{
    size_t p, end;
    const bool sub = (p = line.find(kSubscription)) != std::string::npos;
    if (sub || (p = line.find(kUnsubscription)) != std::string::npos) {
        p += sub ? sizeof kSubscription - 1 : sizeof kUnsubscription - 1;
        e->unknown = line.compare(p, 8, "unknown ") == 0;
        if (e->unknown)
            p += 8;
        if (line.compare(p, 6, "scene ") != 0 || !number(line, p + 6, &e->scene, &end))
            return false;
        e->kind = sub ? ConsoleEvent::Subscribed : ConsoleEvent::Unsubscribed;
        const size_t from = line.find(" from ", end);
        e->guid = from == std::string::npos ? std::string() : token(line, from + 6);
        return true;
    }
    if ((p = line.find(kDisconnected)) != std::string::npos) {
        /* "... for particpant: <guid>" (sic) */
        p += sizeof kDisconnected - 1;
        while (p < line.size() && line[p] != ' ' && line[p] != ':')
            p++;
        e->kind = ConsoleEvent::RendererGone;
        e->guid = token(line, line.compare(p, 1, ":") == 0 ? p + 1 : p);
        return !e->guid.empty();
    }
    if ((p = line.find(kRequest)) != std::string::npos) {
        e->guid = token(line, p + sizeof kRequest - 1, &end);
        const size_t a = line.find(kAvailable, end);
        uint64_t n = 0;
        if (e->guid.empty() || a == std::string::npos || !number(line, a + sizeof kAvailable - 1, &n, &end))
            return false;
        e->kind = ConsoleEvent::ResourceRequest;
        e->resources = (unsigned)n;
        return true;
    }
    return false;
}

bool ramses_line(const std::string &line)
{
    /* "<time> [ Info  ] ramses.Framework      | ..." */
    const size_t bar = line.find(" | ");
    const size_t ctx = line.find(" ramses.");
    return ctx != std::string::npos && (bar == std::string::npos || ctx < bar);
}

int level_change(const std::string &line, const char *context)
{
    /* "... ramses.Ramsh | RCLI | ramses.Client | 0 | OFF |  Dlt changed log level from INFO" */
    if (line.find("Dlt changed log level") == std::string::npos)
        return -1;
    static const char *const kLevels[] = {"OFF", "FATAL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"};
    std::vector<std::string> fields;
    size_t from = 0;
    for (;;) {
        const size_t bar = line.find('|', from);
        std::string f = line.substr(from, bar == std::string::npos ? std::string::npos : bar - from);
        const size_t a = f.find_first_not_of(' '), b = f.find_last_not_of(' ');
        fields.push_back(a == std::string::npos ? std::string() : f.substr(a, b - a + 1));
        if (bar == std::string::npos)
            break;
        from = bar + 1;
    }
    for (size_t i = 0; i < fields.size(); i++) {
        if (fields[i] != context)
            continue;
        for (size_t k = i + 1; k < fields.size(); k++)
            for (int l = 0; l < 7; l++)
                if (fields[k] == kLevels[l])
                    return l;
    }
    return -1;
}

bool console_interesting(const std::string &line, const std::vector<uint64_t> &scenes)
{
    /* Every 2 s the client's scenes and their flush statistics; their
     * states are in the subscription lines. */
    if (line.find(" ramses.Periodic ") != std::string::npos)
        return false;
    if (line.find("ubscri") != std::string::npos || line.find("Ramses log levels") != std::string::npos ||
        line.find("Dlt changed log level") != std::string::npos)
        return true;
    char b[32];
    for (uint64_t id : scenes) {
        std::snprintf(b, sizeof b, "%llu", (unsigned long long)id);
        if (has_word(line, b))
            return true;
        std::snprintf(b, sizeof b, "0x%llx", (unsigned long long)id);
        if (has_word(line, b))
            return true;
        std::snprintf(b, sizeof b, "0x%08llx", (unsigned long long)id);
        if (has_word(line, b))
            return true;
    }
    return false;
}

bool RamsesConsole::start(std::string *err)
{
    int p[2];
    if (pipe(p) != 0) {
        *err = std::string("pipe: ") + std::strerror(errno);
        return false;
    }
    if (pipe(wake_) != 0) {
        *err = std::string("pipe: ") + std::strerror(errno);
        close(p[0]);
        close(p[1]);
        return false;
    }
    for (int fd : {p[0], p[1], wake_[0], wake_[1]})
        fcntl(fd, F_SETFD, FD_CLOEXEC);
    for (int fd : {wake_[0], wake_[1]})
        fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    std::fflush(stdout);
    out_ = fcntl(1, F_DUPFD_CLOEXEC, 3);
    if (out_ < 0 || dup2(p[1], 1) < 0) {
        *err = std::string("stdout: ") + std::strerror(errno);
        if (out_ >= 0)
            close(out_);
        for (int fd : {p[0], p[1], wake_[0], wake_[1]})
            close(fd);
        out_ = wake_[0] = wake_[1] = -1;
        return false;
    }
    close(p[1]);
    in_ = p[0];
    /* A pipe makes stdout fully buffered; a log line must reach the pipe
     * when it is written. */
    setvbuf(stdout, nullptr, _IOLBF, 0);
    std::thread([this] { run(); }).detach();
    return true;
}

void RamsesConsole::run()
{
    char buf[8192];
    size_t have = 0;
    for (;;) {
        const ssize_t n = read(in_, buf + have, sizeof buf - have);
        if (n < 0 && errno == EINTR)
            continue;
        if (n <= 0) {
            /* Nobody would drain the pipe: RAMSES's writes would block once
             * it fills. */
            const int err = n < 0 ? errno : 0;
            std::fflush(stdout);
            dup2(out_, 1);
            log_warn("ramses: console not readable (%s); stdout back on its own, renderer subscriptions no "
                     "longer observed",
                     err ? std::strerror(err) : "end of file");
            break;
        }
        have += (size_t)n;
        size_t start = 0;
        for (size_t i = 0; i < have; i++)
            if (buf[i] == '\n') {
                feed(buf + start, i + 1 - start, cld::now_ms());
                start = i + 1;
            }
        if (start == 0 && have == sizeof buf) {
            feed(buf, have, cld::now_ms());   /* a line longer than the buffer: in pieces */
            have = 0;
        } else {
            std::memmove(buf, buf + start, have - start);
            have -= start;
        }
    }
    if (have)
        feed(buf, have, cld::now_ms());
}

void RamsesConsole::feed(const char *s, size_t n, int64_t now_ms)
{
    const std::string line = strip_colours(s, n);
    ConsoleEvent e;
    const bool event = parse_console_line(line, &e);
    const bool ramses = event || ramses_line(line);
    if (!ramses && out_ >= 0)
        write_all(out_, s, n);
    const std::string context = ramses ? line_context(line) : "other";
    std::lock_guard<std::mutex> lock(mutex_);
    contexts_[contexts_.count(context) || contexts_.size() < kMaxContexts ? context : "other"]++;
    lines_++;
    last_ms_ = now_ms;
    if (!ramses)
        return;
    if (ramses_ms_ < 0 || now_ms - ramses_ms_ > kQuietMs) {
        /* Every context was quiet: the DLT daemon's default level, which
         * set ramses.Client off with the others, set it on again (its line
         * is never printed: ramses.Ramsh, which prints them, gets the new
         * level after ramses.Client). */
        live_since_ = now_ms;
        client_off_ = false;
    }
    ramses_ms_ = now_ms;
    const int level = level_change(line, "ramses.Client");
    if (level >= 0 || (context == "ramses.Client" && client_off_)) {
        const bool off = level >= 0 && level < 4;   /* below INFO */
        if (client_off_ && !off)
            live_since_ = now_ms;
        client_off_ = off;
    }
    bool raw = console_interesting(line, scenes_);
    if (context != "ramses.Periodic" && first_ < kFirstLines) {
        first_++;
        raw = true;
    }
    if (!event && !raw)
        return;
    if (event) {
        e.ms = now_ms;
        events_.push_back(e);
    }
    if (raw) {
        if (raw_since_ms_ < 0 || now_ms - raw_since_ms_ >= 60000) {
            raw_since_ms_ = now_ms;
            raw_minute_ = 0;
        }
        if (raw_minute_ < kRawPerMinute) {
            raw_minute_++;
            raw_.push_back(line);
        } else {
            raw_dropped_++;
        }
    }
    if (wake_[1] >= 0) {
        const char c = 0;
        const ssize_t w = write(wake_[1], &c, 1);
        (void)w;
    }
}

void RamsesConsole::take(std::vector<ConsoleEvent> *events, std::vector<std::string> *raw, uint64_t *raw_dropped)
{
    if (wake_[0] >= 0) {
        char buf[64];
        while (read(wake_[0], buf, sizeof buf) > 0) {
        }
    }
    std::lock_guard<std::mutex> lock(mutex_);
    events->insert(events->end(), events_.begin(), events_.end());
    events_.clear();
    raw->insert(raw->end(), raw_.begin(), raw_.end());
    raw_.clear();
    *raw_dropped = raw_dropped_;
    raw_dropped_ = 0;
}

int64_t RamsesConsole::live_since(int64_t now_ms) const
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (client_off_ || ramses_ms_ < 0 || now_ms - ramses_ms_ > kQuietMs)
        return -1;
    return live_since_;
}

std::string RamsesConsole::counts_text(int64_t now_ms) const
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!lines_)
        return "no line read since start";
    std::vector<std::pair<uint64_t, std::string>> by;
    for (const auto &kv : contexts_)
        by.push_back({kv.second, kv.first});
    std::sort(by.begin(), by.end(), [](const std::pair<uint64_t, std::string> &a,
                                       const std::pair<uint64_t, std::string> &b) { return a.first > b.first; });
    std::string s = std::to_string(lines_) + " lines (";
    for (size_t i = 0; i < by.size(); i++)
        s += (i ? ", " : "") + by[i].second + " " + std::to_string(by[i].first);
    return s + "), the last " + std::to_string((now_ms - last_ms_) / 1000) + " s ago";
}


}  // namespace crs
