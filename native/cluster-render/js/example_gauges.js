// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Robert Nisipeanu
/**
 * A small custom cluster built only from layers (../PROTOCOL.md): a static
 * background, two gauges whose needles the renderer turns, and a number
 * readout. It doubles as an efficiency check: it counts the bytes it sends
 * the service and prints them for three phases of 10 s each.
 *
 *   setup    the assets and layers, sent once: a 256x256 dial face (rgba8,
 *            mipmapped by the service), a 256x32 r8 seven-segment font,
 *            the background, two dials, two needles and the readout;
 *   idle     nothing changes;
 *   sweep    both needles sweep without end: one looping animation each,
 *            sent once, played by the renderer;
 *   drive    a new speed and rpm every 250 ms, as a car's values come: each
 *            needle's animation replaced by one from where it is to the new
 *            value over 250 ms, and the readout's digits as a uniform.
 *
 * The service then reports what it wrote for this client to the display
 * (the status's asset and layer lines). Nothing is sent per frame: what a
 * phase costs is its messages, not the frames the renderer draws.
 *
 * On the unit (Node 8): copy this file and cluster_render_client.js into one
 * directory and run it as a user that may open the service's socket (group
 * tm_oap_app, or root):
 *   node example_gauges.js [--socket PATH] [--target panel] [--phase-ms 10000]
 * iDrive 7's panel is 1920x720; on iDrive 8 use --target widget (2240x896).
 */
'use strict';

const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client.js');

const SIZES = { panel: [1920, 720], map: [1088, 480], hud: [800, 480], widget: [2240, 896], popup: [2240, 896] };

/* The background: a dark gradient and a faint grid, drawn by a shader, so
 * it costs no pixels. */
const BACKGROUND_FS = `#version 100
precision mediump float;
varying vec2 v_uv;
void main() {
    vec2 g = abs(fract(v_uv * vec2(24.0, 9.0)) - 0.5);
    float line = step(0.48, max(g.x, g.y));
    vec3 c = mix(vec3(0.02, 0.03, 0.06), vec3(0.06, 0.08, 0.13), v_uv.y) + line * 0.025;
    gl_FragColor = vec4(c, 1.0);
}`;

/* A dial: the face asset, sampled trilinear so it stays smooth at any size. */
const DIAL_FS = `#version 100
precision mediump float;
uniform sampler2D u_face;
varying vec2 v_uv;
void main() {
    gl_FragColor = texture2D(u_face, v_uv);
}`;

/* A needle pointing up, its pivot at the quad's bottom centre: drawn by the
 * shader, a tapered bar with a soft edge. */
const NEEDLE_FS = `#version 100
precision mediump float;
uniform vec4 u_color;
varying vec2 v_uv;
void main() {
    float w = mix(0.2, 0.9, v_uv.y);           /* narrow at the tip (top) */
    float d = abs(v_uv.x - 0.5) * 2.0 - w;     /* < 0 inside */
    float a = clamp(-d * 4.0, 0.0, 1.0);
    gl_FragColor = vec4(u_color.rgb * a, u_color.a * a);
}`;

/* Up to 8 seven-segment digits, codes in u_text[0..1] (4 to a vec4); 32 a
 * space. */
const READOUT_FS = `#version 100
precision mediump float;
uniform sampler2D u_font;
uniform vec4 u_text[2];
varying vec2 v_uv;
float code(float cell) {
    vec4 v = cell < 4.0 ? u_text[0] : u_text[1];
    float lane = mod(cell, 4.0);
    return lane < 0.5 ? v.x : lane < 1.5 ? v.y : lane < 2.5 ? v.z : v.w;
}
void main() {
    float x = v_uv.x * 8.0;
    float c = code(floor(x));
    float ink = c > 15.5 ? 0.0 : texture2D(u_font, vec2((c + fract(x)) / 16.0, v_uv.y)).r;
    gl_FragColor = vec4(vec3(1.0, 0.75, 0.2) * ink, ink);
}`;

/* Seven-segment digits 0-9 (16x32 each) in a 256x32 R8 atlas. */
const SEGMENTS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];
const STROKES = { a: [5, 2, 6, 3], b: [11, 5, 3, 9], c: [11, 17, 3, 9], d: [5, 26, 6, 3], e: [2, 17, 3, 9],
    f: [2, 5, 3, 9], g: [5, 14, 6, 3] };

function font() {
    const w = 256, px = Buffer.alloc(w * 32);
    SEGMENTS.forEach((segs, cell) => segs.split('').forEach((s) => {
        const r = STROKES[s];
        for (let y = r[1]; y < r[1] + r[3]; y++)
            px.fill(255, y * w + cell * 16 + r[0], y * w + cell * 16 + r[0] + r[2]);
    }));
    return px;
}

/* The dial face, 256x256 RGBA: a ring, ticks every 10% of the sweep
 * (-135 to +135 degrees), the last fifth red. */
function face() {
    const S = 256, c = S / 2, px = Buffer.alloc(S * S * 4);
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const dx = x + 0.5 - c, dy = y + 0.5 - c, r = Math.sqrt(dx * dx + dy * dy) / c;
            const a = Math.atan2(dx, -dy) * 180 / Math.PI;
            const t = Math.round((a + 135) / 27) * 27 - 135;
            const off = r * Math.abs(Math.sin((a - t) * Math.PI / 180));
            let p = null;
            if (r > 0.72 && r < 0.88 && Math.abs(t) <= 135 && off < 0.012)
                p = t >= 81 ? [255, 50, 40, 255] : [235, 238, 245, 255];
            else if (r > 0.9 && r < 0.95) p = [120, 132, 150, 255];
            else if (r < 0.9) p = [6, 9, 16, 230];
            if (p) px.set(p, (y * S + x) * 4);
        }
    }
    return px;
}

function parse(argv) {
    const a = { socket: DEFAULT_PATH, target: 'panel', phaseMs: 10000 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--socket') a.socket = argv[++i];
        else if (argv[i] === '--target') a.target = argv[++i];
        else if (argv[i] === '--phase-ms') a.phaseMs = Number(argv[++i]);
        else a.bad = true;
    }
    a.size = SIZES[a.target];
    if (a.bad || !a.size || !(a.phaseMs >= 1000)) {
        console.error('usage: node example_gauges.js [--socket PATH] [--target panel|map|hud|widget|popup] [--phase-ms MS]');
        process.exit(2);
    }
    return a;
}

/* A gauge: a dial and a needle, the needle turned from -135 (min) to +135
 * degrees (max) about the dial's centre. */
class Gauge {
    constructor(cr, target, x, y, size, face, color, max) {
        this.cr = cr;
        this.max = max;
        this.angle = -135;   /* where the needle is, as last animated */
        this.dial = cr.effect({ target: target, klass: 'content', x: x, y: y, w: size, h: size, fs: DIAL_FS });
        cr.bind(this.dial, 'u_face', face);
        const nw = Math.round(size * 0.05), nl = Math.round(size * 0.42);
        this.needle = cr.effect({ target: target, klass: 'content', z: 1, x: x + (size - nw) / 2, y: y + size / 2 - nl,
            w: nw, h: nl, px: nw / 2, py: nl, rotate: this.angle, fs: NEEDLE_FS, blend: 'premultiplied' });
        cr.uniform(this.needle, 'u_color', color);
        this.anim = 0;
    }
    angleOf(v) { return -135 + 270 * Math.max(0, Math.min(1, v / this.max)); }
    /* One animation, looping, sent once. */
    sweep(ms, now) {
        this.sweepMs = ms;
        this.since = now;
        this.anim = this.cr.animate(this.needle, { property: 'rotate', loop: true, anim: this.anim,
            keys: '0:-135 ' + ms / 2 + ':135 ' + ms + ':-135' });
    }
    /* The needle from where it is to v over ms, replacing its animation. */
    to(v, ms, now) {
        const from = this.at(now), to = this.angleOf(v);
        this.sweepMs = 0;
        this.from = from;
        this.target = to;
        this.since = now;
        this.ms = ms;
        this.anim = this.cr.animate(this.needle, { property: 'rotate', anim: this.anim,
            keys: '0:' + from.toFixed(1) + ' ' + ms + ':' + to.toFixed(1) });
    }
    /* Where the needle is at now, as the renderer plays its last keys. */
    at(now) {
        if (this.since === undefined) return this.angle;
        if (this.sweepMs) {
            const k = ((now - this.since) % this.sweepMs) / this.sweepMs;
            return -135 + 270 * (k < 0.5 ? 2 * k : 2 - 2 * k);
        }
        const k = Math.min(1, (now - this.since) / this.ms);
        return this.from + (this.target - this.from) * k;
    }
}

function main() {
    const args = parse(process.argv.slice(2));
    const W = args.size[0], H = args.size[1], target = args.target;
    const cr = new ClusterRender('example-gauges', args.socket);
    const log = (s) => console.log(new Date().toISOString() + ' ' + s);

    /* Every byte the client writes to the service, by phase. */
    let sent = 0, messages = 0;
    const open = cr._open.bind(cr);
    cr._open = () => {
        open();
        const sock = cr.sock, write = sock.write.bind(sock);
        sock.write = (b, ...rest) => { sent += b.length; messages++; return write(b, ...rest); };
    };
    cr.on('refused', (op, ref, reason) => log('refused ' + op + ' ' + ref + ': ' + reason));
    cr.on('layer', (ref, state, reason) => { if (state !== 'shown') log('layer ' + ref + ' ' + state + (reason ? ': ' + reason : '')); });
    cr.on('target', (t, state) => log('target ' + t + ' ' + state));

    const results = [];
    const phase = (name, start) => {
        const s0 = sent, m0 = messages, t0 = Date.now();
        if (start) start();
        return new Promise((resolve) => setTimeout(() => {
            const secs = (Date.now() - t0) / 1000;
            results.push({ name: name, bytes: sent - s0, messages: messages - m0, secs: secs });
            resolve();
        }, args.phaseMs));
    };

    cr.on('ready', async () => {
        if (results.length) return;   /* a reconnect: the client made everything again */
        log('ready: backend ' + cr.backend + ', render_state ' + cr.renderState + ', samplers ' + cr.samplers);
        const s0 = sent, m0 = messages;
        /* setup: assets first, then the layers that sample them */
        const faceAsset = cr.asset({ target: target, w: 256, h: 256,
            sampling: cr.samplers ? 'trilinear' : 'bilinear' });
        cr.pixels(faceAsset, null, face());
        const fontAsset = cr.asset({ target: target, format: 'r8', w: 256, h: 32, sampling: 'bilinear' });
        cr.pixels(fontAsset, null, font());
        cr.effect({ target: target, klass: 'ambient', fs: BACKGROUND_FS });
        const size = Math.round(H * 0.8), y = Math.round((H - size) / 2);
        const speed = new Gauge(cr, target, Math.round(W * 0.08), y, size, faceAsset, [1, 0.45, 0.1, 1], 260);
        const rpm = new Gauge(cr, target, W - Math.round(W * 0.08) - size, y, size, faceAsset, [0.2, 0.8, 1, 1], 8000);
        const rw = Math.round(W * 0.16), rh = Math.round(rw / 4);
        const readout = cr.effect({ target: target, klass: 'overlay', x: Math.round((W - rw) / 2),
            y: Math.round((H - rh) / 2), w: rw, h: rh, fs: READOUT_FS });
        cr.bind(readout, 'u_font', fontAsset);
        const show = (v) => {
            const d = ('        ' + Math.round(v)).slice(-8).split('').map((ch) => (ch === ' ' ? 32 : Number(ch)));
            cr.uniform(readout, 'u_text', d, { type: 'vec4' });
        };
        show(0);
        await new Promise((r) => setTimeout(r, 3000));   /* the setup's pixels go within the budget */
        results.push({ name: 'setup', bytes: sent - s0, messages: messages - m0, secs: 3 });

        await phase('idle');
        await phase('sweep', () => { speed.sweep(4000, Date.now()); rpm.sweep(3000, Date.now()); });
        let n = 0, timer = null;
        await phase('drive', () => {
            timer = setInterval(() => {
                n++;
                const now = Date.now();
                const kmh = 130 + 90 * Math.sin(n / 12), revs = 3500 + 2500 * Math.sin(n / 7);
                speed.to(kmh, 250, now);
                rpm.to(revs, 250, now);
                show(kmh);
            }, 250);
        });
        clearInterval(timer);

        console.log('phase   seconds   messages   bytes   bytes/s');
        results.forEach((r) => console.log(r.name.padEnd(8) + r.secs.toFixed(1).padStart(7) +
            String(r.messages).padStart(11) + String(r.bytes).padStart(8) +
            String(Math.round(r.bytes / r.secs)).padStart(10)));
        cr.on('status', (text) => {
            console.log('the service, for this client:');
            text.split('\n').filter((l) => l.indexOf('example-gauges') >= 0).forEach((l) => console.log('  ' + l));
            if (!process.env.KEEP) { cr.close(); process.exit(0); }
        });
        cr.status();
    });
    const end = () => { cr.close(); process.exit(0); };
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
    log('example gauges on ' + target + ' (' + W + 'x' + H + ') via ' + args.socket);
    cr.connect();
}

main();
