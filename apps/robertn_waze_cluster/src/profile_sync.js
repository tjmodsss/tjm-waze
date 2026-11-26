// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * profile_sync - the map settings per driver profile. Runs from the app's
 * start, page shown or not.
 *
 * It reads the head unit's current user account
 * (de.bmw.infotainment.personalization.SessionManager, field
 * currentUserAccountReference, a getter), read-only, when the app starts,
 * every POLL_MS, and READ_RETRY_MS after a read that failed until
 * UNREADABLE_READS in a row have; and it takes the account
 * SessionManager's currentUserOnChange event sends. A
 * valid id (PROFILE_ID) counts at once; no profile counts only when the
 * head unit has no SessionManager proxy or no such field. A read that
 * fails, times out or gives no valid id changes nothing, and a proxy that
 * is slow to set up or fails to start is set up again later. When the
 * profile that counts differs from the one patchd has in effect, it tells
 * patchd {"cmd":"profile","id"} over a short
 * connection of its own. patchd puts that profile's own map settings, or
 * the shared ones, in effect and saves them for the render's next start;
 * when the render is to follow, this moves it to them: through the page's
 * own render connection while the page is open (it owns the render's
 * control socket), else through a short connection of its own. setOwn(on)
 * asks patchd {"cmd":"profile-own","id","on"} the same way, for the Own
 * settings for this driver checkbox; refused, the profile is told again.
 *
 * patchd not running is asked again at the next read. One that takes the
 * connection and does not answer is asked again after NO_ANSWER_MS,
 * doubling up to NO_ANSWER_MAX_MS, until it answers or a page load (which
 * also runs at each new connection to patchd) asks it at once. While the
 * page loads, either is asked again READ_RETRY_MS later, up to LOAD_TRIES
 * times. Each streak is logged once. Meanwhile Show on, the HUD settings
 * and the checkbox are greyed.
 *
 * The page's map settings are written for one driver profile's settings:
 * writeTarget() names the profile and set patchd has in effect, and only
 * while that is the profile that counts (settled()); patchd refuses a write
 * that names any other. Until then, while the page loads, while patchd is
 * not yet told a new profile, while a tick of the checkbox waits for
 * patchd, or while the reads keep failing, nothing names one. The page
 * loads (load()) each time it shows: the profile read once, told to
 * patchd, and the settings patchd has stored for it shown. The profile is
 * read again right before each write (confirmWrite). While patchd says no
 * driver has own settings, the shared settings are the only ones and a
 * write names none. Each answer of patchd's moves the page's render to the
 * settings stored for that profile when it shows others
 * (control.showStored); a load ends once the render shows them.
 */
'use strict';

const EventEmitter = require('events');
const net = require('net');
const { RENDER_PATH, PATCH_PATH, renderCommands } = require('./waze_cluster_control.js');

const POLL_MS = 1000;
/* a read that failed: read again after this */
const READ_RETRY_MS = 300;
const READ_MS = 3000;
/* a proxy that failed to start: set up again after this, then less often */
const SETUP_RETRY_MS = 10000;
const SETUP_RETRY_MAX_MS = 300000;
const REPLY_MS = 3000;
const NO_ANSWER_MS = 10000;
const NO_ANSWER_MAX_MS = 300000;
/* reads and asks a page load makes while patchd has not answered it */
const LOAD_TRIES = 4;
/* reads in a row that fail or give no profile id before the profile counts
 * as unreadable */
const UNREADABLE_READS = 3;
/* how long a short render connection stays for its commands */
const RENDER_HOLD_MS = 800;
const IFACE = 'de.bmw.infotainment.personalization.SessionManager';
const INSTANCE = 'de.bmw.infotainment.personalization.SessionManager';
const FIELD = 'currentUserAccountReference';
const EVENT = 'currentUserOnChange';
/* patchd's PROFILE_ID: what an id may be before it is used as a key */
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+={}-]{0,127}$/;
const NONE = null;

function within(p, ms, what) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
        p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}

/* The id a value of the field or of the event's output carries, else null. */
function idOf(v) {
    const id = v && typeof v === 'object' ? v[FIELD] : v;
    return typeof id === 'string' && PROFILE_ID.test(id) ? id : null;
}

/* A reader of the current user account through the SDK's typed proxy:
 * () -> Promise<id | NONE>. NONE only without the proxy or the field, for
 * good; rejected when the read gives nothing to go by. read.watch(cb): cb(id)
 * for each valid id the proxy's EVENT sends, from the first read that gives
 * one on (a proxy without the event sends none). options: readMs, retryMs
 * (also the subscription's first retry), retryMaxMs. */
function sessionReader(someipBuilders, log, options) {
    const o = options || {};
    const readMs = o.readMs || READ_MS;
    const retryMax = o.retryMaxMs || SETUP_RETRY_MAX_MS;
    let retryMs = o.retryMs || SETUP_RETRY_MS;
    let proxy = null;
    let none = false;
    let starting = null;
    let retryAt = 0;
    const warned = {};
    const watchers = [];
    const warn = (why, text) => {
        if (!warned[why]) {
            warned[why] = true;
            log.warn(`driver profiles: ${text}`);
        }
    };
    /* null for good when the head unit has no such proxy or field */
    const setUp = () => {
        if (proxy || none) {
            return Promise.resolve(proxy);
        }
        if (starting) {
            return starting;
        }
        if (Date.now() < retryAt) {
            return Promise.reject(new Error(`${IFACE} proxy: set up again later`));
        }
        starting = within(Promise.resolve()
            .then(() => someipBuilders.buildTypedProxy(IFACE, INSTANCE))
            .then((p) => {
                if (!p || !p[FIELD] || typeof p[FIELD].getValue !== 'function') {
                    none = true;
                    warn('none', `no ${FIELD}; the map settings are shared`);
                    return null;
                }
                return p.init().then(() => p);
            }, (e) => {
                none = true;
                warn('none', `no ${IFACE} proxy (${e && e.message}); the map settings are shared`);
                return null;
            }), readMs, `${IFACE} proxy`)
            .then((p) => {
                starting = null;
                proxy = p;
                return p;
            }, (e) => {
                starting = null;
                retryAt = Date.now() + retryMs;
                log.info(`driver profiles: ${e && e.message}; set up again in ${Math.round(retryMs / 1000)} s`);
                retryMs = Math.min(retryMs * 2, retryMax);
                throw e;
            });
        return starting;
    };
    /* EVENT, once the service answers: 'none', 'asking' or 'on'; refused,
     * asked again after subRetryMs (doubling up to retryMax); after a read
     * that fails (the service gone or restarting) asked again. The SDK's
     * subscribe registers a handler of its own each time and its unsubscribe
     * takes the subscription's id: the last id is unsubscribed first, and
     * each subscription's handler passes events only while it is the
     * latest, so no registration a refusal left behind doubles them. */
    let sub = 'none';
    let subAt = 0;
    let subRetryMs = o.retryMs || SETUP_RETRY_MS;
    let subGen = 0;
    let subId = null;
    const subscribe = (p) => {
        const ev = p[EVENT];
        if (sub !== 'none' || Date.now() < subAt || !ev || typeof ev.subscribe !== 'function') {
            return;
        }
        sub = 'asking';
        const gen = ++subGen;
        const old = subId;
        subId = null;
        Promise.resolve()
            .then(() => old !== null && typeof ev.unsubscribe === 'function' && ev.unsubscribe(old))
            .catch(() => {})
            .then(() => ev.subscribe((v) => {
                const id = gen === subGen && idOf(v);
                if (id) {
                    watchers.forEach((cb) => cb(id));
                }
            }))
            .then((sid) => {
                subId = sid === undefined ? null : sid;
                sub = 'on';
                subRetryMs = o.retryMs || SETUP_RETRY_MS;
            }, (e) => {
                sub = 'none';
                subAt = Date.now() + subRetryMs;
                warn('event', `${EVENT} not subscribed (${e && e.message}); asked again later`);
                subRetryMs = Math.min(subRetryMs * 2, retryMax);
            });
    };
    const read = () => setUp().then((p) => {
        if (!p) {
            return NONE;
        }
        return within(Promise.resolve()
            .then(() => p.waitUntilAvailable(readMs))
            .then(() => p[FIELD].getValue()), readMs * 2, `reading ${FIELD}`)
            .catch((e) => {
                if (sub === 'on') {
                    sub = 'none';
                }
                throw e;
            })
            .then((v) => {
                const id = idOf(v);
                if (id) {
                    subscribe(p);
                    return id;
                }
                if (v !== '') {
                    warn('shape', `${FIELD} is not a profile id`);
                }
                throw new Error('no profile id read');
            });
    });
    read.watch = (cb) => watchers.push(cb);
    return read;
}

/* One request to a socket on a connection of its own: resolves to the
 * first line done(msg) accepts, null when the connection opened and none
 * came, or undefined when it did not open. */
function askOnce(path, obj, done, ms) {
    return new Promise((resolve) => {
        const s = net.connect(path);
        let buf = '';
        let over = false;
        let linked = false;
        const finish = (v) => {
            if (!over) {
                over = true;
                clearTimeout(timer);
                s.destroy();
                resolve(v === null && !linked ? undefined : v);
            }
        };
        const timer = setTimeout(() => finish(null), ms);
        s.setEncoding('utf8');
        s.on('connect', () => {
            linked = true;
            s.write(JSON.stringify(obj) + '\n');
        });
        s.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                let msg = null;
                try {
                    msg = JSON.parse(buf.slice(0, i));
                } catch (e) {
                    /* not ours */
                }
                buf = buf.slice(i + 1);
                if (msg && done(msg)) {
                    finish(msg);
                    return;
                }
            }
        });
        s.on('error', () => finish(null));
        s.on('close', () => finish(null));
    });
}

class ProfileSync extends EventEmitter {
    /* options: control (the page's WazeClusterControl), log, readProfile
     * (with watch(cb) when it can send a change), patchPath, renderPath,
     * pollMs, readRetryMs, replyMs, retryMs and retryMaxMs (the no-answer
     * backoff). Emits 'change' when profile,
     * own, settled(), loading() or canChooseOwn() may have changed. */
    constructor(options) {
        super();
        const o = options || {};
        this._control = o.control || null;
        this._log = o.log || { info() {}, warn() {} };
        this._read = o.readProfile;
        this._patchPath = o.patchPath || PATCH_PATH;
        this._renderPath = o.renderPath || RENDER_PATH;
        this._pollMs = o.pollMs || POLL_MS;
        this._readRetryMs = o.readRetryMs || READ_RETRY_MS;
        this._replyMs = o.replyMs || REPLY_MS;
        this._retryMs = o.retryMs || NO_ANSWER_MS;
        this._retryMaxMs = o.retryMaxMs || NO_ANSWER_MAX_MS;
        this._noAnswerMs = this._retryMs;   /* the next no-answer backoff */
        this._warned = null;                /* why patchd did not take the last ask, logged */
        /* the profile patchd has put in effect (NONE: none) and whether it
         * has its own settings; undefined and null until patchd has said */
        this.profile = undefined;
        this.own = null;
        this._askedOwn = null;      /* the checkbox as pressed, until patchd answers */
        this._confirmed = undefined; /* the profile that counts: the last valid id read, or NONE for good */
        this._loading = false;      /* the page's load runs */
        this._loadTries = 0;
        this._failed = 0;           /* reads in a row that gave nothing to go by */
        this._switches = 0;         /* events taken: a read begun before the last is older than it */
        this._retryAt = 0;
        this._chain = Promise.resolve();
        this._timer = null;
        this._polling = false;
        this._again = null;         /* a read asked for while one runs: whether to tell patchd */
        this._stopped = true;
        if (this._read && typeof this._read.watch === 'function') {
            this._read.watch((id) => {
                if (!this._stopped) {
                    this._switches++;
                    this._take(id, false);
                }
            });
        }
    }

    start() {
        if (this._stopped && this._read) {
            this._stopped = false;
            this._poll();
        }
    }

    stop() {
        this._stopped = true;
        clearTimeout(this._timer);
        this._timer = null;
    }

    /* patchd has the profile that counts in effect (NONE too: no profile
     * detected), its set known; the page is not loading and the reads give
     * an id. */
    _inEffect() {
        return this._confirmed !== undefined && this.profile === this._confirmed && this.own !== null && !this._loading && !this.unreadable();
    }

    canChooseOwn() {
        return typeof this.profile === 'string' && this._inEffect();
    }

    settled() {
        return this._inEffect() && this._askedOwn === null;
    }

    loading() {
        return this._loading;
    }

    /* What a map setting written now is for: {profile, own} as patchd has
     * them in effect, null while not settled; {} (none named) while patchd
     * says no driver has own settings, when the shared settings are the
     * only ones. */
    writeTarget() {
        if (this._control && this._control.ownSettings === false && this._askedOwn === null) {
            return {};
        }
        return this.settled() ? { profile: this.profile, own: this.own ? 1 : 0 } : null;
    }

    /* The reads keep giving nothing to go by. */
    unreadable() {
        return this._failed >= UNREADABLE_READS;
    }

    /* Right before a write for w (a writeTarget()): the profile read again;
     * true while w is still what a write is for. A read naming another
     * profile counts at once, so the page greys until patchd has it. */
    confirmWrite(w) {
        if (!('profile' in w)) {
            return Promise.resolve(true);
        }
        const switches = this._switches;
        return Promise.resolve().then(() => this._read()).then((id) => {
            this._take(id, false, switches);
            const now = this.writeTarget();
            return !!now && now.profile === w.profile && now.own === w.own;
        }, () => {
            this._readFailed();
            return false;
        });
    }

    /* The checkbox's tick: as pressed until patchd answers, then patchd's. */
    ownShown() {
        return this._askedOwn !== null ? this._askedOwn : this.own === true;
    }

    setOwn(on) {
        if (!this.canChooseOwn() || this._askedOwn !== null || !!on === this.own) {
            return Promise.resolve();
        }
        this._askedOwn = !!on;
        this.emit('change');
        return this._ask({ cmd: 'profile-own', id: this.profile, on: on ? 1 : 0 });
    }

    /* The page shows (opened, back in focus, or patchd connected): the
     * profile read at once and told to patchd, and the settings patchd has
     * stored for it shown; until then the page loads. */
    load() {
        if (!this._stopped) {
            this._retryAt = 0;
            this._noAnswerMs = this._retryMs;
            this._loadTries = 0;
            if (!this._loading) {
                this._loading = true;
                this.emit('change');
            }
            this._poll(true);
        }
    }

    /* One read; with tell, the profile that counts is told to patchd even
     * when patchd has it. */
    _poll(tell) {
        if (this._polling) {
            this._again = !!(this._again || tell);
            return;
        }
        clearTimeout(this._timer);
        this._polling = true;
        const switches = this._switches;
        Promise.resolve().then(() => this._read()).then((id) => this._take(id, tell, switches), () => this._readFailed()).then(() => {
            this._polling = false;
            const again = this._again;
            this._again = null;
            /* a load ends once patchd has the profile read in effect and the
             * render shows its settings, or the reads keep failing, or after
             * LOAD_TRIES without patchd's answer (asked again at each read) */
            const unanswered = this._failed === 0 && this.profile !== this._confirmed && ++this._loadTries < LOAD_TRIES;
            const retry = !this.unreadable() && (this._failed > 0 || (this._loading && unanswered));
            if (this._loading && again === null && !retry) {
                this._loading = false;
                this.emit('change');
            }
            if (this._stopped) {
                return;
            }
            if (again !== null) {
                this._poll(again);
            } else {
                this._timer = setTimeout(() => this._poll(retry && this._loading), retry ? this._readRetryMs : this._pollMs);
            }
        });
    }

    /* A read with nothing to go by: the profile that counts stays. */
    _readFailed() {
        const was = this.unreadable();
        this._failed++;
        if (this.unreadable() !== was) {
            this.emit('change');
        }
    }

    /* A read's or the event's id counts at once; one that is not patchd's
     * (or with tell, any) is told, the page greyed until patchd answers. */
    _take(id, tell, switches) {
        if (switches !== undefined && switches !== this._switches) {
            /* the read began before an event since: the event's id stands */
            return tell && Date.now() >= this._retryAt ? this._ask({ cmd: 'profile', id: this._confirmed }) : undefined;
        }
        const was = this.unreadable();
        this._failed = 0;
        if (id !== this._confirmed || was) {
            this._confirmed = id;
            this.emit('change');
        }
        if ((tell || id !== this.profile) && Date.now() >= this._retryAt) {
            return this._ask({ cmd: 'profile', id });
        }
        return undefined;
    }

    /* One command at a time; the reply sets profile and own and, when the
     * settings in effect changed, moves the render. */
    _ask(msg) {
        const run = () => {
            if (this._stopped) {
                this._askedOwn = null;
                return undefined;
            }
            const ev = `${msg.cmd}-reply`;
            /* an answer older than a page write since does not show what is stored */
            const writes = this._control ? this._control.writes : 0;
            let shown;
            return askOnce(this._patchPath, msg, (m) => m.ev === ev || (m.ev === 'refused' && m.cmd === msg.cmd), this._replyMs)
                .then((r) => {
                    if (msg.cmd === 'profile-own') {
                        this._askedOwn = null;
                    }
                    if (this._control) {
                        this._control.noteOwnSettings(r || {});
                    }
                    if (r) {
                        this._noAnswerMs = this._retryMs;
                    }
                    if (r && r.ev === ev && r.ok) {
                        this._retryAt = 0;
                        this._warned = null;
                        this.profile = r.id;
                        this.own = r.own === true;
                        this._log.info(`driver profile: ${r.own ? 'its own' : 'the shared'} map settings${r.changed ? ', applied' : ''}`);
                        if (r.settings) {
                            shown = this._toRender(r.settings, r.changed, writes);
                        }
                    } else {
                        const why = r === undefined ? 'not running' : (r && r.reason) || 'no answer';
                        if (why !== this._warned) {
                            this._warned = why;
                            this._log.warn(`patchd did not take ${msg.cmd}: ${why}`);
                        }
                        if (msg.cmd === 'profile') {
                            this.profile = undefined;
                            this.own = null;
                            /* no answer outside a page load: asked again after a backoff */
                            this._retryAt = r === null && !this._loading ? Date.now() + this._noAnswerMs : 0;
                            if (this._retryAt) {
                                this._noAnswerMs = Math.min(this._noAnswerMs * 2, this._retryMaxMs);
                            }
                        } else if (r && this._confirmed !== undefined) {
                            /* refused (patchd has another profile in effect): what it has */
                            this._ask({ cmd: 'profile', id: this._confirmed });
                        }
                    }
                    this.emit('change');
                    return shown;
                });
        };
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => {});
        return p;
    }

    /* The render to the settings stored for the profile in effect: through
     * the page's render connection while the page is open, where it shows
     * others (unless the page wrote one after asking), once it is up;
     * else, when they changed, through a short connection. Resolves once
     * the page's render shows them. */
    _toRender(s, changed, writes) {
        const c = this._control;
        if (c && c.isOpen()) {
            return changed || c.writes === writes ? c.showStored(s, changed) : undefined;
        }
        if (!changed) {
            return undefined;
        }
        const cmds = renderCommands(s);
        /* the render down or owned by another: its next start reads the saved settings */
        const sock = net.connect(this._renderPath);
        const end = setTimeout(() => sock.destroy(), RENDER_HOLD_MS * 3);
        sock.on('connect', () => {
            cmds.forEach((m) => sock.write(JSON.stringify(m) + '\n'));
            setTimeout(() => sock.end(), RENDER_HOLD_MS);
        });
        sock.on('error', () => {});
        sock.on('close', () => clearTimeout(end));
        return undefined;
    }
}

module.exports = { ProfileSync, sessionReader, IFACE, INSTANCE, FIELD, POLL_MS };
