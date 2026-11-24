// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Robert Nisipeanu
/**
 * Node 8 client for the cluster render service (../PROTOCOL.md): an app's
 * layers on the instrument cluster and the HUD. Copy this file into an app's
 * src/ and bundle it like any other module; it needs only the `net` and
 * `events` builtins.
 *
 *   const { ClusterRender } = require('./cluster_render_client.js');
 *   const cr = new ClusterRender('robertn_myapp');
 *   const badge = cr.image({ target: 'panel', klass: 'overlay', x: 1700, y: 40, w: 160, h: 64, iw: 160, ih: 64 });
 *   cr.on('layer', (ref, state, reason) => { ... });   // shown, waiting, suspended, stalled, hidden, error
 *   cr.on('target', (name, state, holder, reason, guideDisabled, disabled) => { ... });
 *   cr.on('budget', (capKb, maxKb, reason) => { ... });
 *   cr.on('fps_cap', (fps, app) => { ... });   // another app holds this one's videos (0: released)
 *   cr.on('ready', () => cr.pixels(badge, null, rgba));   // after every (re)connect
 *   cr.connect();
 *   ...
 *   cr.pixels(badge, [{ x: 0, y: 0, w: 40, h: 64 }], changedRows);   // only what changed
 *   cr.set(badge, { visible: false, rotate: 15 });
 *
 *   const font = cr.asset({ target: 'panel', format: 'r8', w: 256, h: 128 });
 *   cr.pixels(font, null, glyphs);
 *   const label = cr.effect({ target: 'panel', x: 40, y: 600, w: 300, h: 60, fs: GLYPH_FS, time: true });
 *   cr.bind(label, 'u_atlas', font);
 *   cr.uniform(label, 'u_cells', cells, { type: 'vec4' });
 *   const car = cr.mesh({ target: 'panel', x: 700, y: 200, w: 520, h: 400, cz: 6 });
 *   cr.part(car, 1, { vs: LIT_VS, fs: LIT_FS });
 *   cr.geometry(car, 1, { positions, normals, indices });
 *   cr.animate(car, { part: 1, property: 'rotate', keys: '0:0,0,0 4000:0,360,0', loop: true });
 *   const gauge = cr.scene({ target: 'panel', file: '/var/opt/my-tool/gauge.ramses',
 *       res: ['/var/opt/my-tool/gauge.ramres'], sha256: [sceneSha, resSha] });
 *   cr.edit(gauge, '--rotate ^needle$=0,0,-30\n--uniform ^bar$:u_level=0.5');
 *   cr.host('panel', { target: 'map', x: 600, y: 120, w: 720, h: 480 });   // the map under this app's panel layers
 *   cr.on('host', (target, ev) => { ... });   // ev.into: where target is drawn now ('' : its own slot)
 *   cr.on('hosting', (target, ev) => { ... });   // this app's host: ev.state 'live' or 'waiting', ev.reason
 *   cr.close();
 *
 * Nothing blocks and nothing queues without bound. The client reconnects
 * whenever the service goes, makes every asset and layer again with its last
 * settings: uniforms, mesh parts with their geometry and transforms, binds
 * and animations, every scene file with its kept edits, and sends each image
 * layer and asset whole; 'ready' then
 * asks the app for anything else. An image layer or asset is kept here
 * whole: what changed since it last went is sent as one update when the
 * socket takes it. A video frame not yet sent is replaced by the next
 * (newest wins).
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const DEFAULT_PATH = '/dev/shm/cluster-render/render.sock';
const PROTO = 1;
const JSON_T = 0x4a;    /* 'J' */
const FRAME_T = 0x46;   /* 'F' */
const MESH_T = 0x4d;    /* 'M' */
const MAX_DIRTY = 16;
const BACKOFF_MS = [250, 500, 1000, 2000];
const SET_KEYS = ['klass', 'z', 'x', 'y', 'w', 'h', 'visible', 'exclusive', 'prewarm', 'preload', 'contend',
    'guide_hold', 'yield', 'others_fps', 'hosted', 'opacity', 'rotate', 'sx', 'sy', 'px', 'py'];
const MESH_KEYS = ['projection', 'fov', 'ortho_h', 'near', 'far', 'cx', 'cy', 'cz', 'crx', 'cry', 'crz'];
/* An effect layer's or mesh part's render state (PROTOCOL.md "Render
 * state"); a part's also takes PART_LOOK_KEYS. */
const LOOK_KEYS = ['blend', 'blend_src', 'blend_dst', 'blend_src_alpha', 'blend_dst_alpha', 'blend_op',
    'blend_op_alpha', 'color_mask', 'stencil_func', 'stencil_ref', 'stencil_mask', 'stencil_fail',
    'stencil_depth_fail', 'stencil_pass'];
const PART_LOOK_KEYS = ['depth_func', 'depth_write', 'cull', 'draw', 'instances'];
const BLEND_KEYS = LOOK_KEYS.filter((k) => k.indexOf('blend_') === 0);

/* An effect layer's kept look takes a set's look fields as the service
 * does: a blend preset replaces the custom factors and operations (they go),
 * and blend none takes none (the service refuses them). */
function setLook(kept, opts) {
    if (opts.blend !== undefined) BLEND_KEYS.forEach((k) => { delete kept[k]; });
    LOOK_KEYS.forEach((k) => { if (opts[k] !== undefined) kept[k] = opts[k]; });
    if (kept.blend === 'none') BLEND_KEYS.forEach((k) => { delete kept[k]; });
}
const MIPMAPPED = ['nearest_mips', 'bilinear_mips', 'trilinear'];

/* Bytes of an asset's pixels: with mips, its mip levels too, a compressed
 * one's down to the last level of whole 4x4 blocks (PROTOCOL.md
 * "Mipmaps"). */
function assetBytes(w, h, bpp, block, mips) {
    let n = 0;
    for (let lw = w, lh = h; ; lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1)) {
        n += block ? (lw / 4) * (lh / 4) * block : lw * lh * bpp;
        if (!mips || (lw === 1 && lh === 1)) return n;
        if (block && ((lw >> 1) % 4 || (lh >> 1) % 4 || !(lw >> 1) || !(lh >> 1))) return n;
    }
}
const UNIFORM_WIDTH = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat4: 16 };

function message(type, body) {
    const m = Buffer.alloc(5 + body.length);
    m.writeUInt32LE(body.length + 1, 0);
    m[4] = type;
    body.copy(m, 5);
    return m;
}

function jsonMessage(obj) {
    return message(JSON_T, Buffer.from(JSON.stringify(obj), 'utf8'));
}

/* A frame message: u32 ref, u64 id, u16 rect count, rects, pixels. */
function frameMessage(ref, id, rects, pixels) {
    const head = 14 + rects.length * 8;
    const body = Buffer.alloc(head + pixels.length);
    body.writeUInt32LE(ref >>> 0, 0);
    body.writeUInt32LE(id % 0x100000000, 4);
    body.writeUInt32LE(Math.floor(id / 0x100000000), 8);
    body.writeUInt16LE(rects.length, 12);
    rects.forEach((r, i) => {
        body.writeUInt16LE(r.x, 14 + i * 8);
        body.writeUInt16LE(r.y, 16 + i * 8);
        body.writeUInt16LE(r.w, 18 + i * 8);
        body.writeUInt16LE(r.h, 20 + i * 8);
    });
    pixels.copy(body, head);
    return message(FRAME_T, body);
}

/* A mesh message: u32 ref, part, vertices, indices, u8 mask, then the
 * float32 arrays and the u16 indices. */
function meshMessage(ref, part, g) {
    const v = g.positions.length / 3;
    const arrays = [g.positions, g.normals, g.texcoords, g.colors].filter((a) => a && a.length);
    const floats = arrays.reduce((n, a) => n + a.length, 0);
    const body = Buffer.alloc(17 + floats * 4 + g.indices.length * 2);
    body.writeUInt32LE(ref >>> 0, 0);
    body.writeUInt32LE(part >>> 0, 4);
    body.writeUInt32LE(v, 8);
    body.writeUInt32LE(g.indices.length, 12);
    body[16] = (g.normals && g.normals.length ? 1 : 0) | (g.texcoords && g.texcoords.length ? 2 : 0) |
        (g.colors && g.colors.length ? 4 : 0);
    let off = 17;
    arrays.forEach((a) => { for (let i = 0; i < a.length; i++, off += 4) body.writeFloatLE(a[i], off); });
    for (let i = 0; i < g.indices.length; i++, off += 2) body.writeUInt16LE(g.indices[i], off);
    return message(MESH_T, body);
}

function flag(v) { return v ? 1 : 0; }

/* A scene edit line's key (../PROTOCOL.md "edit", cr::edit_key): its kind,
 * --show as --hide, --pass-on as --pass-off and --skip as --play, and the
 * rest, up to the last '=' for the kinds that take a value. */
const VALUED = ['--uniform', '--move', '--scale', '--rotate', '--viewport', '--set'];
function editKey(line) {
    const sp = line.indexOf(' ');
    let kind = sp < 0 ? line : line.slice(0, sp);
    let rest = sp < 0 ? '' : line.slice(sp + 1);
    if (kind === '--show') kind = '--hide';
    else if (kind === '--pass-on') kind = '--pass-off';
    else if (kind === '--skip') kind = '--play';
    else if (VALUED.indexOf(kind) >= 0 && rest.lastIndexOf('=') >= 0) rest = rest.slice(0, rest.lastIndexOf('='));
    return kind + ' ' + rest;
}

/* A text layer's options in range (ClusterRender.text()). */
function textOk(o) {
    const n = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
    const c = [].concat(o.color);
    return ['left', 'center', 'right'].indexOf(o.align) >= 0 && n(o.spacing, -1024, 1024) && n(o.size, 0, 2048) &&
        c.length === 4 && c.every((v) => n(v, 0, 1));
}

/* A text layer's string as the service takes it: at most 1024 bytes of
 * UTF-8, no lone surrogate (which has no UTF-8). */
function stringOk(t) {
    return Buffer.byteLength(t, 'utf8') <= 1024 &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);
}

/* The fields of a text message or layer that say how it draws its line. */
function textFields(o) {
    return { align: o.align, spacing: o.spacing, size: o.size, color: [].concat(o.color).join(' ') };
}

class ClusterRender extends EventEmitter {
    constructor(app, socketPath) {
        super();
        this.app = app;
        this.path = socketPath || DEFAULT_PATH;
        this.sock = null;
        this.ready = false;
        this.closed = true;
        this.backoff = 0;
        this.timer = null;
        this.layers = new Map();     /* ref -> { kind, opts, uniforms, parts, binds, anims, image, dirty, whole } */
        this.nextRef = 1;
        this.pendingFrames = new Map();   /* ref -> frame message waiting for the socket */
        this.blocked = false;
        this.inbuf = Buffer.alloc(0);
        this.backend = '';
        this.targets = '';
        this.fpsCap = 0;        /* another app's others_fps holding this one's videos (fps_cap); 0: none */
        this.fpsCapApp = '';
        this.hostLayers = false;
        this.layerHosts = new Map();   /* hosts from this app's layers: hosted target -> { into, msg } */
    }

    connect() {
        this.closed = false;
        this._open();
    }

    close() {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.sock) this.sock.destroy();
        this.sock = null;
        this.ready = false;
        this._releaseFpsCap();
    }

    _open() {
        if (this.closed || this.sock) return;
        const sock = net.connect(this.path);
        this.sock = sock;
        this.blocked = false;
        this.connected = false;
        this.inbuf = Buffer.alloc(0);
        sock.on('connect', () => {
            /* Everything made before now goes in the replay below. */
            this.connected = true;
            this._send({ op: 'hello', app: this.app, proto: PROTO });
            this._replay(false);
        });
        /* A socket close() let go is not this.sock any more: its late events
         * are ignored. */
        sock.on('data', (d) => { if (this.sock === sock) this._data(d); });
        sock.on('drain', () => { if (this.sock === sock) { this.blocked = false; this._pump(); } });
        sock.on('error', () => {});
        sock.on('close', () => {
            if (this.sock !== sock) return;
            const wasReady = this.ready;
            this.sock = null;
            this.ready = false;
            this.connected = false;
            this.pendingFrames.clear();
            this._releaseFpsCap();
            if (wasReady) this.emit('disconnected');
            if (this.closed) return;
            const ms = BACKOFF_MS[Math.min(this.backoff, BACKOFF_MS.length - 1)];
            this.backoff++;
            this.timer = setTimeout(() => { this.timer = null; this._open(); }, ms);
        });
    }

    /* A canvas, or a layer drawn in one. */
    static _inCanvas(l) { return !!l && (l.kind === 'canvas' || !!l.opts.canvas); }
    static _texty(l) { return !!l && (l.kind === 'font' || l.kind === 'text' || !!l.atlas); }
    /* Sent only once the hello says the service takes it. */
    static _late(l) { return ClusterRender._inCanvas(l) || ClusterRender._texty(l); }

    /* Held here, not sent: a canvas or a layer drawn in one, until a hello
     * with canvas (an older service would draw such a layer on screen); a
     * font or a text layer until a hello with text. */
    _held(ref) {
        const l = this.layers.get(ref);
        return (ClusterRender._inCanvas(l) && !(this.ready && this.canvases)) ||
            (ClusterRender._texty(l) && !(this.ready && this.texts));
    }

    /* Every layer, part, bind and animation made so far: the late ones not
     * held (late true) or the rest. Assets, canvases and fonts first, so
     * binds and the layers drawn in a canvas or from a font find them; binds
     * and animations once every layer and part is made. */
    _replay(canvases) {
        const inCanvas = (ref) => ClusterRender._late(this.layers.get(ref));
        [true, false].forEach((assets) => this.layers.forEach((l, ref) => {
            if (ClusterRender._late(l) !== canvases || (canvases && this._held(ref)) ||
                (l.kind === 'asset' || l.kind === 'canvas' || l.kind === 'value' || l.kind === 'font') !== assets) return;
            this._send(this._layerMsg(ref, l));
                if (l.edits.size) this._send({ op: 'edit', ref: ref, lines: Array.from(l.edits.values()).join('\n') });
                l.hosts.forEach((m) => this._send(m));
                l.parts.forEach((p) => {
                    this._send(p.msg);
                    if (p.geometry) this._write(p.geometry);
                    if (p.transform) this._send(p.transform);
                });
            Object.keys(l.uniforms).forEach((k) => this._send(l.uniforms[k]));
            if ((l.kind === 'image' || l.kind === 'asset') && l.have) { l.whole = true; l.dirty = []; l.dirtyBytes = 0; }
        }));
        this.layers.forEach((l) => Object.keys(l.binds).forEach((k) => {
            if ((ClusterRender._late(l) || inCanvas(l.binds[k].asset)) === canvases) this._send(l.binds[k].msg);
        }));
        this.layers.forEach((l) => Object.keys(l.links).forEach((k) => {
            if (ClusterRender._late(l) === canvases) this._send(l.links[k].msg);
        }));
        this.layers.forEach((l) => { if (ClusterRender._late(l) === canvases) l.anims.forEach((m) => this._send(m)); });
    }

    _data(d) {
        this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
        let off = 0;
        while (this.inbuf.length - off >= 5) {
            const len = this.inbuf.readUInt32LE(off);
            if (len < 1 || len > 8 * 1024 * 1024) { this.sock.destroy(); return; }
            if (this.inbuf.length - off < 4 + len) break;
            const type = this.inbuf[off + 4];
            const body = this.inbuf.slice(off + 5, off + 4 + len);
            off += 4 + len;
            if (type !== JSON_T) continue;
            let ev;
            try { ev = JSON.parse(body.toString('utf8')); } catch (e) { continue; }
            this._event(ev);
        }
        this.inbuf = this.inbuf.slice(off);
    }

    _event(ev) {
        if (ev.ev === 'hello') {
            this.backend = ev.backend;
            this.targets = ev.targets;
            this.hostEdge = ev.host_edge === 1;   /* takes a host's edge_* */
            this.preload = ev.preload === 1;      /* knows a layer's preload */
            this.othersFps = ev.others_fps === 1;   /* knows a layer's others_fps */
            this.renderState = ev.render_state === 1;   /* takes blend factors, depth_func, color_mask */
            this.samplers = ev.samplers === 1;   /* takes mipmapped sampling, mirror, wrap_u/v, anisotropy */
            this.hostLayers = ev.host_layers === 1;   /* takes a host from layers (host('panel', ...)) */
            this.canvases = ev.canvas === 1;   /* takes canvases and layers drawn in them */
            this.curves = ev.curves === 1;   /* takes interp ease_in, ease_out, ease_in_out, smooth */
            this.nodes = ev.nodes === 1;   /* takes pivot parts and parents */
            this.draw = ev.draw === 1;   /* takes a part's draw mode */
            this.instances = ev.instances === 1;   /* takes a part's instances above 1 */
            this.cubeMaps = ev.cube === 1;   /* takes cube map assets */
            this.values = ev.values === 1;   /* takes shared values (value(), link()) */
            this.sceneAnim = ev.scene_anim === 1;   /* takes --play and --skip edit lines */
            this.texts = ev.text === 1;   /* takes fonts and text layers (font(), text()) */
            this.overOrder = ev.over_order === 1;   /* takes a scene's over_order */
            this.ready = true;
            this.backoff = 0;
            /* after the layers, which went at connect */
            if (this.hostLayers) this.layerHosts.forEach((h) => this._send(h.msg));
            if (this.canvases || this.texts) this._replay(true);
            this._pump();
            this.emit('ready');
        } else if (ev.ev === 'layer') {
            this.emit('layer', ev.ref, ev.state, ev.reason);
        } else if (ev.ev === 'target') {
            this.emit('target', ev.target, ev.state, ev.holder, ev.reason, ev.guide_disabled === 1, ev.disabled === 1);
        } else if (ev.ev === 'budget') {
            this.emit('budget', ev.cap_kb_per_s, ev.max_kb_per_s, ev.reason);
        } else if (ev.ev === 'fps_cap') {
            this.fpsCap = ev.fps || 0;
            this.fpsCapApp = this.fpsCap ? ev.app || '' : '';
            this.emit('fps_cap', this.fpsCap, this.fpsCapApp);
        } else if (ev.ev === 'error') {
            /* a host refused is not sent again after a reconnect */
            const l = ev.op === 'host' && !ev.into ? this.layers.get(ev.ref) : null;
            if (l && l.hosts) l.hosts.delete(ev.target);
            /* one from layers: the service ended this app's host of the target; forgotten here
             * when it is the one refused (one sent since, into another target, still holds) */
            const lh = ev.op === 'host' && 'into' in ev ? this.layerHosts.get(ev.target) : null;
            if (lh && lh.into === ev.into) this.layerHosts.delete(ev.target);
            this.emit('refused', ev.op, ev.ref, ev.reason, ev.line);
        } else if (ev.ev === 'status') {
            this.emit('status', ev.text);
        } else if (ev.ev === 'hosting') {
            this.emit('hosting', ev.target, ev);   /* this app's host from layers: ev.state live or waiting, ev.reason */
        } else if (ev.ev === 'host') {
            this.emit('host', ev.target, ev);   /* ev.into empty: not hosted any more */
        }
    }

    /* The connection gone: no other app's request holds this one any more. */
    _releaseFpsCap() {
        if (!this.fpsCap) return;
        this.fpsCap = 0;
        this.fpsCapApp = '';
        this.emit('fps_cap', 0, '');
    }

    _send(obj) {
        if ((obj.ref !== undefined && obj.op !== 'hello' && this._held(obj.ref)) ||
            (obj.op === 'bind' && this._held(obj.asset))) return;
        this._write(jsonMessage(obj));
    }

    _write(m) {
        if (!this.sock || !this.connected) return;
        if (!this.sock.write(m)) this.blocked = true;
    }

    /* Writes frames while the socket takes them: image changes first, then
     * the newest video frame of each layer. */
    _pump() {
        if (!this.sock || !this.ready) return;
        this.layers.forEach((l, ref) => {
            if (this.blocked || (l.kind !== 'image' && l.kind !== 'asset') || !(l.whole || l.dirty.length) ||
                this._held(ref)) return;
            const rects = l.whole ? [] : l.dirty;
            let px;
            if (l.whole) {
                px = l.image;
            } else {
                const parts = [];
                rects.forEach((r) => {
                    for (let y = 0; y < r.h; y++) {
                        const start = ((r.y + y) * l.iw + r.x) * l.bpp;
                        parts.push(l.image.slice(start, start + r.w * l.bpp));
                    }
                });
                px = Buffer.concat(parts);
            }
            l.whole = false;
            l.dirty = [];
            l.dirtyBytes = 0;
            if (!this.sock.write(frameMessage(ref, 0, rects, px))) this.blocked = true;
        });
        for (const ref of Array.from(this.pendingFrames.keys())) {
            if (this.blocked) break;
            const m = this.pendingFrames.get(ref);
            this.pendingFrames.delete(ref);
            if (!this.sock.write(m)) this.blocked = true;
        }
    }

    _layerMsg(ref, l) {
        const o = l.opts;
        if (l.kind === 'scene') {
            const m = { op: 'scene', ref: ref, target: o.target, file: o.file, res: (o.res || []).join(' '),
                sha256: [].concat(o.sha256).join(' '), contend: flag(o.contend) };
            if (o.layers) m.layers = 1;
            if (o.layers && o.layers_order !== undefined) m.layers_order = o.layers_order;
            if (o.layers && o.over_order !== undefined) m.over_order = o.over_order;
            return m;
        }
        if (l.kind === 'value' || l.kind === 'font') return l.msg;
        if (l.kind === 'canvas') {
            const m = { op: 'canvas', ref: ref, target: o.target, w: o.w, h: o.h };
            if (o.depth) m.depth = 1;
            if (o.once) m.once = 1;
            if (o.clear) m.clear = [].concat(o.clear).join(' ');
            ['sampling', 'wrap', 'wrap_u', 'wrap_v', 'anisotropy'].forEach((k) => { if (o[k] !== undefined) m[k] = o[k]; });
            return m;
        }
        if (l.kind === 'asset') {
            const m = { op: 'asset', ref: ref, target: o.target, format: o.format || 'rgba8', w: o.w, h: o.h,
                sampling: o.sampling || 'nearest', wrap: o.wrap || 'clamp' };
            ['wrap_u', 'wrap_v', 'anisotropy'].forEach((k) => { if (o[k] !== undefined) m[k] = o[k]; });
            if (o.cube) m.cube = 1;
            return m;
        }
        const m = { op: 'layer', ref: ref, target: o.target, kind: l.kind };
        if (o.canvas) m.canvas = o.canvas;
        this._setFields(m, o);
        if (l.kind === 'video') {
            ['vw', 'vh', 'fps', 'level_bits', 'dirty_threshold', 'settle_ms', 'stall_ms'].forEach((k) => {
                if (o[k] !== undefined) m[k] = o[k];
            });
            if (o.pan_blocks !== undefined) m.pan_blocks = flag(o.pan_blocks);
        } else if (l.kind === 'image') {
            m.iw = o.iw;
            m.ih = o.ih;
            if (o.fps !== undefined) m.fps = o.fps;
            if (o.sampling) m.sampling = o.sampling;
        } else if (l.kind === 'mesh') {
            MESH_KEYS.forEach((k) => { if (o[k] !== undefined) m[k] = o[k]; });
        } else if (l.kind === 'text') {
            m.font = o.font;
            m.max = o.max;
            Object.assign(m, textFields(o));
            m.text = l.text;
        } else {
            m.fs = o.fs;
            if (o.vs) m.vs = o.vs;
            if (o.time_fps !== undefined) m.time_fps = o.time_fps;
            if (o.time) m.time = 1;
            LOOK_KEYS.forEach((k) => { if (o[k] !== undefined) m[k] = o[k]; });
        }
        return m;
    }

    _setFields(m, o) {
        SET_KEYS.forEach((k) => {
            if (o[k] === undefined) return;
            const key = k === 'klass' ? 'class' : k;
            m[key] = typeof o[k] === 'boolean' ? flag(o[k]) : o[k];
        });
    }

    _uniformMsg(ref, name, v) {
        return { op: 'uniform', ref: ref, name: name, v: v.join(' ') };
    }

    _add(kind, opts) {
        const o = Object.assign({}, opts);
        const l = { kind: kind, opts: o, uniforms: {}, parts: new Map(), binds: {}, links: {}, anims: new Map(), nextAnim: 1,
            dirty: [], dirtyBytes: 0, whole: false, have: false, edits: new Map(), hosts: new Map() };
        l.atlas = !!o.atlas;   /* a font's own (font()): held as fonts are */
        delete o.atlas;
        if (kind === 'scene' && !(o.file && [].concat(o.sha256 || []).length === (o.res || []).length + 1)) return 0;
        if (kind === 'image') {
            o.iw = o.iw || o.w;
            o.ih = o.ih || o.h;
            if (!(o.iw > 0 && o.ih > 0 && o.iw <= 1920 && o.ih <= 720)) return 0;
            l.iw = o.iw;
            l.ih = o.ih;
            l.bpp = 4;
        } else if (kind === 'asset') {
            /* etc2rgba: 16 bytes a 4x4 block, etc2rgb: 8; sent whole. */
            const block = o.format === 'etc2rgba' ? 16 : o.format === 'etc2rgb' ? 8 : 0;
            l.compressed = block > 0;
            l.bpp = o.format === 'r8' || l.compressed ? 1 : 4;
            if (!(o.w > 0 && o.h > 0 && o.w <= 2048 && o.h <= 2048)) return 0;
            if (l.compressed && (o.w % 4 || o.h % 4)) return 0;
            /* A compressed asset sampled with mipmaps is sent with every
             * level; the service makes an uncompressed one's. */
            l.bytes = assetBytes(o.w, o.h, l.bpp, block, l.compressed && MIPMAPPED.indexOf(o.sampling) >= 0);
            /* A cube map: six square faces, +x, -x, +y, -y, +z, -z, sent
             * whole and once, no mip levels. */
            if (o.cube) {
                if (o.w !== o.h || MIPMAPPED.indexOf(o.sampling) >= 0) return 0;
                l.bytes *= 6;
                l.wholeOnly = true;
            }
            if (l.bytes > 1920 * 720 * 4) return 0;
            l.iw = o.w;
            l.ih = o.h;
        }
        if (l.bpp) l.image = Buffer.alloc(l.bytes || l.iw * l.ih * l.bpp);
        const ref = this.nextRef++;
        this.layers.set(ref, l);
        if (this.sock) this._send(this._layerMsg(ref, l));
        return ref;
    }

    /* opts: target, klass, z, x, y, w, h, visible, exclusive, prewarm,
     * preload, contend, guide_hold, yield, others_fps, hosted (a producer's
     * layer placed by a host of that target), opacity, rotate, sx, sy, px, py, then per kind (see
     * PROTOCOL.md); an image's iw and ih default to its w and h; an
     * effect's time: true takes u_time from the renderer's clock, and its
     * render state blend, blend_src, blend_dst, blend_src_alpha,
     * blend_dst_alpha, blend_op, blend_op_alpha, color_mask (to a service
     * whose hello has render_state; set() changes them). A mesh's:
     * projection, fov, ortho_h, near, far and its camera cx, cy, cz, crx,
     * cry, crz (degrees, right-handed). Returns the layer's ref, 0 when
     * refused. */
    video(opts) { return this._add('video', opts); }
    image(opts) { return this._add('image', opts); }
    effect(opts) { return this._add('effect', opts); }
    mesh(opts) { return this._add('mesh', opts); }
    /* opts: target, format ('rgba8', 'r8'; 'etc2rgba', 'etc2rgb', w and h
     * multiples of 4, its blocks sent whole), w, h (up to 2048), sampling
     * ('nearest', 'bilinear'; with mipmaps, to a service whose hello has
     * samplers: 'nearest_mips', 'bilinear_mips', 'trilinear', and
     * 'min_linear_mag_nearest', 'min_nearest_mag_linear'), wrap ('clamp',
     * 'repeat'; 'mirror'), wrap_u, wrap_v, anisotropy (1-16). Sampled with
     * mipmaps, a compressed asset's frame carries every level after its
     * picture (PROTOCOL.md "Mipmaps"). To a service whose hello has cube:
     * cube: true, a cube map, w equal to h, its frame the six faces one
     * after another (+x, -x, +y, -y, +z, -z), sent whole and once, no mip
     * levels (PROTOCOL.md "Cube maps"). */
    asset(opts) { return this._add('asset', opts); }
    /* A canvas (PROTOCOL.md "Canvases"), to a service whose hello has canvas:
     * opts target, w, h (up to 2048), depth (a depth-stencil buffer of its
     * own), clear ([r, g, b, a], 0-1), once (drawn again only when what is
     * in it changes), sampling, wrap, wrap_u, wrap_v, anisotropy (no
     * mipmaps). An effect or mesh layer made with canvas: its ref draws in
     * it; bind() samples it as an asset, best with blend 'premultiplied'; a
     * layer in a canvas samples only canvases made before its own. The
     * canvas, its layers and binds of it are held until a hello with canvas
     * (this.canvases), and never sent to an older service, which would draw
     * such a layer on screen. Returns its ref, 0 when refused. */
    canvas(opts) {
        const o = opts || {};
        if (!(o.w > 0 && o.h > 0 && o.w <= 2048 && o.h <= 2048)) return 0;
        return this._add('canvas', o);
    }

    /* A font over this app's r8 asset (PROTOCOL.md "Text"), to a service
     * whose hello has text (this.texts): opts line (the line's height),
     * glyphs ('code:x,y,w,h,left,top,advance ...': its box in the atlas, its
     * offset from the pen and the line's top, in atlas pixels), kerning
     * ('first,second:amount ...'), sdf (a distance atlas's range in pixels
     * each side of the edge). cluster_render_text.js's Font makes them. Held
     * until such a hello and never sent to an older service; made again
     * after a reconnect. Returns its ref, 0 when asset is not an r8 asset of
     * this app or line or glyphs are missing. */
    font(asset, opts) {
        if (asset !== null && typeof asset === 'object') return this._ownedFont(asset);
        const a = this.layers.get(asset);
        if (!a || !opts || a.kind !== 'asset' || a.opts.format !== 'r8' || a.opts.cube || !(opts.line > 0) ||
            !opts.glyphs) return 0;
        const ref = this.nextRef;
        const l = { kind: 'font', opts: { target: a.opts.target, font: asset }, uniforms: {}, parts: new Map(),
            binds: {}, links: {}, anims: new Map(), nextAnim: 1, edits: new Map(), hosts: new Map() };
        l.msg = { op: 'font', ref: ref, asset: asset, line: opts.line, glyphs: opts.glyphs };
        if (opts.sdf) l.msg.sdf = opts.sdf;
        if (opts.kerning) l.msg.kerning = opts.kerning;
        this.nextRef++;
        this.layers.set(ref, l);
        this._send(l.msg);
        return ref;
    }

    /* font({ target, w, h, pixels, line, glyphs, kerning, sdf }): a font
     * with an atlas of its own, an r8 asset of w x h pixels (sampled
     * bilinear), held as the font is and dropped with it. */
    _ownedFont(o) {
        if (!(o.line > 0) || !o.glyphs || !Buffer.isBuffer(o.pixels)) return 0;
        const atlas = this._add('asset', { target: o.target, format: 'r8', w: o.w, h: o.h, sampling: 'bilinear',
            atlas: true });
        if (!atlas) return 0;
        if (!this.pixels(atlas, null, o.pixels)) {
            this.drop(atlas);
            return 0;
        }
        const ref = this.font(atlas, o);
        if (!ref) {
            this.drop(atlas);
            return 0;
        }
        this.layers.get(ref).owns = true;
        return ref;
    }

    /* A text layer (PROTOCOL.md "Text"): a line of text drawn from a font
     * over its rect, held as fonts are. opts the layer's (target, x, y, w,
     * h, klass, z, ...), font (font()'s ref), max (the glyphs it holds,
     * 1-256, 64 by default), align ('left', 'center', 'right'), spacing
     * (pixels between characters), size (the line's height in pixels; 0:
     * the layer's height), color ([r, g, b, a], 0-1), text. Returns its ref,
     * 0 when font is not one or a field is out of range. */
    text(opts) {
        const f = this.layers.get(opts.font);
        const o = Object.assign({ max: 64, align: 'left', spacing: 0, size: 0, color: [1, 1, 1, 1] }, opts);
        if (!f || f.kind !== 'font' || !(Number.isInteger(o.max) && o.max >= 1 && o.max <= 256) || !textOk(o)) return 0;
        const text = o.text === undefined ? '' : String(o.text);
        if (!stringOk(text)) return 0;
        delete o.text;
        const ref = this.nextRef++;
        this.layers.set(ref, { kind: 'text', opts: o, text: text, uniforms: {}, parts: new Map(), binds: {}, links: {},
            anims: new Map(), nextAnim: 1, edits: new Map(), hosts: new Map() });
        this._send(this._layerMsg(ref, this.layers.get(ref)));
        return ref;
    }

    /* The text layer's string; false, nothing sent, for a layer that is not
     * one. */
    setText(ref, text) {
        const l = this.layers.get(ref);
        if (!l || l.kind !== 'text') return false;
        text = String(text);
        if (!stringOk(text)) return false;   /* the last string taken stays */
        if (l.text === text) return true;
        l.text = text;
        this._send({ op: 'text', ref: ref, text: text });
        return true;
    }

    /* How the text layer draws its line: any of align, spacing, size,
     * color (its max as made); false, nothing sent, when one is out of
     * range or the layer is not a text layer. */
    textStyle(ref, opts) {
        const l = this.layers.get(ref);
        if (!l || l.kind !== 'text') return false;
        const o = Object.assign({}, l.opts);
        ['align', 'spacing', 'size', 'color'].forEach((k) => { if (opts[k] !== undefined) o[k] = opts[k]; });
        if (!textOk(o)) return false;
        l.opts = o;
        this._send(Object.assign({ op: 'text', ref: ref }, textFields(o)));
        return true;
    }

    /* A scene file as the target's scene (PROTOCOL.md "Scene files"): opts
     * target, file (an absolute path), res (its resource files' paths),
     * sha256 (an array of hex SHA-256s: the file's, then each resource
     * file's), contend; layers: true draws the target's layers over the
     * file, layers_order the render order their passes start at,
     * over_order the overlay and alert layers' (a service whose hello has
     * over_order 1). */
    scene(opts) { return this._add('scene', opts); }

    /* The scene (made with layers) hosts another target (PROTOCOL.md
     * "host"): opts target, x, y, w, h (in the scene's target), src_x,
     * src_y, src_w, src_h (in the hosted target's pixels; sent, all four,
     * when src_w and src_h are set, else all of it), shown; edge_top,
     * edge_bottom, edge_fade, edge_dim, edge_blur (the edge drawn on the
     * hosted picture; sent, all five, when edge_top or edge_bottom is set).
     * Kept by target and sent again after a reconnect, until the service
     * refuses it or the scene is replaced; false, nothing sent, for a scene
     * without layers or a host of its own target.
     *
     * With a target's name in place of ref (host('panel', opts)): this
     * app's layers there host opts.target, no scene needed (PROTOCOL.md
     * "Hosting from layers"); the hosted video is drawn under them while
     * one of them is visible. Kept by opts.target, sent to a service whose
     * hello has host_layers 1 (this.hostLayers), now or once one is
     * connected, until unhost() or the service refuses it (the service ends
     * it; here it is forgotten unless one into another target was sent
     * since); false, nothing kept, without opts.target or
     * for that target itself. A 'hosting' event says whether it is live. */
    host(ref, opts) {
        if (typeof ref === 'string') return this._hostFromLayers(ref, opts);
        const l = this.layers.get(ref);
        /* what the service refuses whatever it holds is not sent or kept */
        if (!l || l.kind !== 'scene' || !l.opts.layers || !opts.target || opts.target === l.opts.target) return false;
        const m = this._hostMsg({ op: 'host', ref: ref }, opts);
        l.hosts.set(opts.target, m);
        this._send(m);
        return true;
    }

    _hostFromLayers(into, opts) {
        if (!into || !opts.target || opts.target === into) return false;
        const m = this._hostMsg({ op: 'host', into: into }, opts);
        this.layerHosts.set(opts.target, { into: into, msg: m });   /* into another target: the service moves it */
        /* to an older service nothing: it would refuse it (no such scene) */
        if (this.ready && this.hostLayers) this._send(m);
        return true;
    }

    /* Sent also with nothing kept here (a refusal of an older host may have
     * crossed a newer one): the service ends whatever this app hosts of
     * target, whatever its into. */
    unhost(target) {
        const h = this.layerHosts.get(target);
        this.layerHosts.delete(target);
        if (this.ready && this.hostLayers) this._send({ op: 'unhost', into: h ? h.into : '', target: target });
    }

    _hostMsg(m, opts) {
        m.target = opts.target;
        m.x = opts.x;
        m.y = opts.y;
        m.w = opts.w;
        m.h = opts.h;
        m.shown = flag(opts.shown !== false);
        /* the part: all four with src_w and src_h, else none (all of it), as the C++ client */
        if (opts.src_w && opts.src_h) {
            m.src_x = opts.src_x || 0;
            m.src_y = opts.src_y || 0;
            m.src_w = opts.src_w;
            m.src_h = opts.src_h;
        }
        if (opts.edge_top || opts.edge_bottom)
            ['edge_top', 'edge_bottom', 'edge_fade', 'edge_dim', 'edge_blur'].forEach((k) => { m[k] = opts[k] || 0; });
        return m;
    }

    /* Another file for a scene, in place (opts as scene()'s, the target
     * kept): its kept edits go. */
    replace(ref, opts) {
        const l = this.layers.get(ref);
        if (!l || l.kind !== 'scene' || !opts.file ||
            [].concat(opts.sha256 || []).length !== (opts.res || []).length + 1) return false;
        l.opts = Object.assign({}, opts, { target: l.opts.target });
        l.edits = new Map();
        l.hosts = new Map();   /* the service ends them with the file it replaces */
        this._send(this._layerMsg(ref, l));
        return true;
    }

    /* Edit lines for a scene (PROTOCOL.md "edit"), separated by newlines:
     * kept by their key, each replacing the kept line of its key, and sent
     * again after a reconnect in the order last sent; --play and --skip (to
     * a service whose hello has scene_anim, this.sceneAnim) never kept. */
    edit(ref, lines) {
        const l = this.layers.get(ref);
        if (!l || l.kind !== 'scene') return;
        lines.split('\n').forEach((line) => {
            line = line.replace(/\r$/, '');
            const key = editKey(line);
            if (!line || key.startsWith('--play ')) return;
            l.edits.delete(key);
            l.edits.set(key, line);
        });
        this._send({ op: 'edit', ref: ref, lines: lines });
    }

    set(ref, opts) {
        const l = this.layers.get(ref);
        if (!l || l.kind === 'asset' || l.kind === 'canvas' || l.kind === 'scene') return;
        const own = l.kind === 'mesh' ? MESH_KEYS : l.kind === 'effect' ? LOOK_KEYS : [];
        SET_KEYS.concat(l.kind === 'mesh' ? MESH_KEYS : []).forEach((k) => { if (opts[k] !== undefined) l.opts[k] = opts[k]; });
        if (l.kind === 'effect') setLook(l.opts, opts);
        const m = { op: 'set', ref: ref };
        this._setFields(m, opts);
        own.forEach((k) => { if (opts[k] !== undefined) m[k] = opts[k]; });
        this._send(m);
    }

    /* values: 1-4 numbers; or, with opts.type ('float', 'vec2', 'vec3',
     * 'vec4', 'mat4'), whole elements of it, up to 1024 numbers: an array
     * uniform. opts.part: a mesh layer's part. */
    uniform(ref, name, values, opts) {
        const l = this.layers.get(ref);
        const o = opts || {};
        if (!l || !values.length) return;
        const m = this._uniformMsg(ref, name, values);
        if (o.type) {
            const w = UNIFORM_WIDTH[o.type];
            if ((l.kind !== 'effect' && l.kind !== 'mesh') || !w || values.length > 1024 || values.length % w) return;
            m.type = o.type;
        } else if ((l.kind !== 'effect' && l.kind !== 'mesh') || values.length > 4) return;
        if (o.part) m.part = o.part;
        l.uniforms[(o.part || 0) + ':' + name] = m;
        this._send(m);
    }

    /* A shared value (PROTOCOL.md "Shared values"), to a service whose hello
     * has values (this.values): opts target, type ('float' default, 'vec2',
     * 'vec3', 'vec4'), v (its first value, as many numbers). Uniforms of this
     * app's effect layers and mesh parts there follow it (link());
     * setValue() sets it and animate(ref, { property: 'value', keys })
     * animates it, for all of them at once. Returns its ref, 0 when v does
     * not fit the type. */
    value(opts) {
        const width = { float: 1, vec2: 2, vec3: 3, vec4: 4 }[opts.type || 'float'];
        const v = [].concat(opts.v === undefined ? new Array(width || 0).fill(0) : opts.v);
        if (!width || v.length !== width || !v.every((x) => typeof x === 'number' && isFinite(x))) return 0;
        const ref = this.nextRef;
        const l = { kind: 'value', opts: { target: opts.target, type: opts.type || 'float' }, width: width,
            uniforms: {}, parts: new Map(), binds: {}, links: {}, anims: new Map(), nextAnim: 1, edits: new Map(),
            hosts: new Map() };
        l.msg = { op: 'value', ref: ref, target: opts.target, type: l.opts.type, v: v.join(' ') };
        this.nextRef++;
        this.layers.set(ref, l);
        this._send(l.msg);
        return ref;
    }

    setValue(ref, v) {
        const l = this.layers.get(ref);
        v = [].concat(v);
        if (!l || l.kind !== 'value' || v.length !== l.width || !v.every((x) => typeof x === 'number' && isFinite(x)))
            return false;
        l.msg = Object.assign({}, l.msg, { v: v.join(' ') });
        this._send(l.msg);
        return true;
    }

    /* The effect layer's uniform (or mesh part's) follows the value, of the
     * uniform's type; value 0: it does not, and takes its own value again. */
    link(ref, uniform, value, part) {
        const l = this.layers.get(ref), v = this.layers.get(value);
        if (!l || (l.kind !== 'effect' && l.kind !== 'mesh') || !uniform || (value && (!v || v.kind !== 'value')))
            return false;
        const m = { op: 'link', ref: ref, name: uniform, value: value || 0 };
        if (part) m.part = part;
        if (value) l.links[(part || 0) + ':' + uniform] = { value: value, msg: m };
        else delete l.links[(part || 0) + ':' + uniform];
        this._send(m);
        return true;
    }

    /* The effect layer's (or mesh part's) sampler samples the asset. */
    bind(ref, sampler, asset, part) {
        const l = this.layers.get(ref), a = this.layers.get(asset);
        if (!l || !a || (a.kind !== 'asset' && a.kind !== 'canvas')) return;
        const m = { op: 'bind', ref: ref, sampler: sampler, asset: asset };
        if (part) m.part = part;
        l.binds[(part || 0) + ':' + sampler] = { asset: asset, msg: m };
        this._send(m);
    }

    /* A mesh layer's part, numbered from 1: opts vs, fs, depth, cull
     * ('back', 'front', 'none'), blend ('alpha', 'add', 'none'), and, to a
     * service whose hello has render_state, the rest of its render state
     * (PROTOCOL.md "Render state"): blend 'premultiplied', 'max', 'min',
     * 'subtract', blend_src, blend_dst, blend_src_alpha, blend_dst_alpha,
     * blend_op, blend_op_alpha, color_mask, depth_func, depth_write. To a
     * service whose hello has nodes: node: true, a pivot that draws nothing
     * (no shaders), and parent, the number of a part made before that this
     * one follows (its transform then relative to the parent's). Parts are
     * made again after a reconnect in the order they were made. To a
     * service whose hello has draw: draw ('triangles' default,
     * 'triangle_strip', 'lines', 'line_loop', 'points') and instances
     * (1-256; gl_InstanceID in a GLSL ES 3.00 vertex shader). */
    part(ref, part, opts) {
        const l = this.layers.get(ref);
        if (!l || l.kind !== 'mesh' || !(part > 0) || l.parts.has(part)) return false;
        if (opts.parent !== undefined && !l.parts.has(opts.parent)) return false;
        const m = opts.node ? { op: 'part', ref: ref, part: part, node: 1 }
            : { op: 'part', ref: ref, part: part, vs: opts.vs, fs: opts.fs };
        if (opts.parent !== undefined) m.parent = opts.parent;
        if (opts.depth !== undefined) m.depth = flag(opts.depth);
        if (opts.depth_write !== undefined) m.depth_write = flag(opts.depth_write);
        LOOK_KEYS.concat(PART_LOOK_KEYS).forEach((k) => {
            if (opts[k] !== undefined && m[k] === undefined) m[k] = opts[k];
        });
        l.parts.set(part, { msg: m, geometry: null, transform: null });
        this._send(m);
        return true;
    }

    /* g: positions (xyz), normals (xyz), texcoords (uv), colors (rgba) per
     * vertex, the last three optional, and indices, as many as the part's
     * draw mode takes (whole triangles by default). The service takes a
     * part's new geometry at most once a second. */
    geometry(ref, part, g) {
        const l = this.layers.get(ref);
        const p = l && l.parts.get(part);
        const v = g.positions.length / 3;
        const per = (a, n) => !a || !a.length || a.length === v * n;
        if (!p || !(v >= 1 && v <= 65535 && Number.isInteger(v)) || !per(g.normals, 3) || !per(g.texcoords, 2) ||
            !per(g.colors, 4) || !(g.indices.length >= 1 && g.indices.length <= 196605)) {
            return false;
        }
        for (let i = 0; i < g.indices.length; i++) if (!(g.indices[i] < v)) return false;
        p.geometry = meshMessage(ref, part, g);
        if (!this._held(ref)) this._write(p.geometry);
        return true;
    }

    /* t: tx, ty, tz, rx, ry, rz (degrees, right-handed), sx, sy, sz.
     * False, and nothing sent, when a value is out of the service's range. */
    transform(ref, part, t) {
        const l = this.layers.get(ref);
        const p = l && l.parts.get(part);
        if (!p) return false;
        const keys = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'].filter((k) => t[k] !== undefined);
        if (!keys.every((k) => typeof t[k] === 'number' && Math.abs(t[k]) <= (k[0] === 'r' ? 36000 : 1000000)))
            return false;
        /* The service merges each transform into the part's pose, so the
         * replay carries every field set so far. */
        p.transform = p.transform || { op: 'transform', ref: ref, part: part };
        keys.forEach((k) => { p.transform[k] = t[k]; });
        this._send(p.transform);
        return true;
    }

    /* opts: part, property ('rotate', 'translate', 'scale', 'uniform'),
     * name (the uniform's), keys ("t:v[,v,v] ..." or [[t, v...], ...], t in
     * ms), loop, interp ('linear', 'step'; to a service whose hello has curves:
     * 'ease_in', 'ease_out', 'ease_in_out', 'smooth'), anim (a number this returned:
     * that animation replaced). Returns the animation's number, 0 when
     * refused here. */
    animate(ref, opts) {
        const l = this.layers.get(ref);
        if (!l || !opts.property || !opts.keys) return 0;
        const keys = typeof opts.keys === 'string' ? opts.keys
            : opts.keys.map((k) => k[0] + ':' + k.slice(1).join(',')).join(' ');
        /* opts.anim: that animation of the layer's (one animate() returned)
         * replaced, so a needle sent to new values keeps one animation;
         * its first key is where the needle is now. */
        const anim = opts.anim > 0 && l.anims.has(opts.anim) ? opts.anim : l.nextAnim++;
        const m = { op: 'animate', ref: ref, anim: anim, property: opts.property, keys: keys,
            loop: flag(opts.loop), interp: opts.interp || 'linear' };
        if (opts.part) m.part = opts.part;
        if (opts.name) m.name = opts.name;
        l.anims.set(anim, m);
        this._send(m);
        return anim;
    }

    stop(ref, anim) {
        const l = this.layers.get(ref);
        if (!l || !l.anims.delete(anim)) return;
        this._send({ op: 'stop', ref: ref, anim: anim });
    }

    /* A layer or an asset; an asset a layer samples stays (the service
     * refuses it). */
    drop(ref) {
        if (!this.layers.has(ref)) return;
        const held = this._held(ref);   /* never sent: nothing to drop */
        let sampled = false;
        this.layers.forEach((l) => Object.keys(l.binds).forEach((k) => { sampled = sampled || l.binds[k].asset === ref; }));
        /* a canvas with layers in it stays too; a font a text layer draws
         * from, and an asset a font is over */
        this.layers.forEach((l) => {
            sampled = sampled || l.opts.canvas === ref || (ClusterRender._texty(l) && l.opts.font === ref);
        });
        /* a value dropped: the service undoes its links */
        this.layers.forEach((l) => Object.keys(l.links).forEach((k) => { if (l.links[k].value === ref) delete l.links[k]; }));
        const l = this.layers.get(ref);
        const atlas = l.kind === 'font' && l.owns ? l.opts.font : 0;
        if (!sampled) this.layers.delete(ref);
        this.pendingFrames.delete(ref);
        if (!held) this._send({ op: 'drop', ref: ref });
        if (atlas && !sampled) this.drop(atlas);   /* the atlas the font owns goes with it */
    }

    frameBytes(ref) {
        const l = this.layers.get(ref);
        if (!l) return 0;
        if (l.kind === 'video') {
            const w = l.opts.vw || 1088, h = l.opts.vh || 480;
            return w * (h + (h >> 1));
        }
        return l.image ? l.image.length : 0;
    }

    /* A video frame: the whole 4:2:0 atlas. False while not connected. */
    frame(ref, atlas, id) {
        const l = this.layers.get(ref);
        if (!this.ready || !l || l.kind !== 'video' || atlas.length !== this.frameBytes(ref)) return false;
        this.pendingFrames.set(ref, frameMessage(ref, id || 0, [], atlas));
        this._pump();
        return true;
    }

    /* An image or asset update: rects ([{x, y, w, h}]) with their rows
     * packed one rect after another in px, or no rects (null) and the whole
     * image. */
    pixels(ref, rects, px) {
        const l = this.layers.get(ref);
        if (!l || !l.image) return false;
        const iw = l.iw, ih = l.ih, bpp = l.bpp;
        if ((l.compressed || l.wholeOnly) && rects && rects.length) return false;
        if (l.wholeOnly && l.have) return false;   /* a cube map is sent once, as the service takes it */
        if (!rects || !rects.length) {
            if (px.length !== l.image.length) return false;
            px.copy(l.image);
            l.whole = true;
            l.dirty = [];
            l.dirtyBytes = 0;
        } else {
            let need = 0;
            for (const r of rects) {
                if (!(r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= iw && r.y + r.h <= ih)) return false;
                need += r.w * r.h * bpp;
            }
            if (need !== px.length) return false;
            let off = 0;
            for (const r of rects) {
                for (let y = 0; y < r.h; y++) {
                    px.copy(l.image, ((r.y + y) * iw + r.x) * bpp, off, off + r.w * bpp);
                    off += r.w * bpp;
                }
                if (l.whole) continue;
                /* An update of rects (8 bytes of header each) never outgrows
                 * the whole image, which is within the service's message
                 * limit. */
                l.dirtyBytes += r.w * r.h * bpp;
                if (l.dirty.length >= MAX_DIRTY || l.dirtyBytes + 8 * (l.dirty.length + 1) >= l.image.length) {
                    l.whole = true;
                    l.dirty = [];
                    l.dirtyBytes = 0;
                } else l.dirty.push(r);
            }
        }
        l.have = true;
        this._pump();
        return true;
    }

    status() { this._send({ op: 'status' }); }
}

module.exports = { ClusterRender, DEFAULT_PATH };
