// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * Content of every layer kind on the cluster through cluster-render
 * (../PROTOCOL.md), one page or all of them at once:
 *   cube    a lit cube in a mesh layer, turned by the renderer;
 *   text    live seven-segment numbers: an effect over an R8 glyph-atlas asset
 *           with a vec4 array of glyph codes, and an RGBA8 sprite asset;
 *   needle  a needle image sweeping about its pivot over a dial image;
 *   plasma  an effect on the renderer's clock;
 *   alert   an exclusive alert for 4 s, every 30 s;
 *   video   moving bars as a video layer, turned 5 degrees and narrowed;
 *   glow    render state and mipmaps (a service whose hello has
 *           render_state and samplers): a mirrored, mipmapped tile pattern
 *           the renderer shrinks and grows, three glows added over each
 *           other at max, and a shadow subtracted, its alpha not written;
 *   canvas  off-screen canvases (a service whose hello has canvas): plasma
 *           drawn only inside a ring written to a canvas's stencil, shown
 *           on screen; a lit cube drawn once in a canvas drawn once, shown
 *           twice, one of them turned by the renderer.
 * Every animation runs in the renderer; the client sends only the text once
 * a second and the video's frames. Every layer, target, budget and refused
 * event is printed with its time.
 *
 * On the unit (Node 8): copy this file and cluster_render_client.js into one
 * directory and run it as a user that may open the service's socket (group
 * tm_oap_app, or root); Ctrl-C ends it and its layers go with it.
 *   node showcase.js [--socket PATH] [all|cube|text|needle|plasma|alert|video|glow|canvas]
 *                    [--target panel|map|hud|guide|widget|popup] [--size WxH]
 * The sizes are iDrive 7's targets' and iDrive 8's guide, widget and popup
 * canvases; --size gives another (iDrive 8: map 874x749, hud 353x203).
 */
'use strict';

const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client.js');

const PAGES = ['cube', 'text', 'needle', 'plasma', 'alert', 'video', 'glow', 'canvas'];
const SIZES = { panel: [1920, 720], map: [1088, 480], hud: [800, 480], guide: [702, 213], widget: [2240, 896], popup: [2240, 896] };

const HIGHP = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

const LIT_VS = `#version 100
attribute vec3 a_position;
attribute vec3 a_normal;
uniform mat4 u_mvp;
uniform mat4 u_normal;
varying vec3 v_n;
void main() {
    v_n = (u_normal * vec4(a_normal, 0.0)).xyz;
    gl_Position = u_mvp * vec4(a_position, 1.0);
}`;

const LIT_FS = `#version 100
precision mediump float;
uniform vec4 u_color;
varying vec3 v_n;
void main() {
    float d = max(dot(normalize(v_n), normalize(vec3(0.4, 0.7, 0.6))), 0.0);
    gl_FragColor = vec4(u_color.rgb * (0.22 + 0.78 * d), 1.0);
}`;

/* An icon square, then 16 cells of 16x32 glyphs; u_text holds 16 glyph
 * codes, 4 to a vec4. */
const TEXT_FS = `#version 100
${HIGHP}uniform sampler2D u_font;
uniform sampler2D u_icon;
uniform vec4 u_text[4];
varying vec2 v_uv;
float code(float cell) {
    float slot = floor(cell / 4.0), lane = cell - slot * 4.0;
    vec4 v = u_text[0];
    for (int i = 1; i < 4; i++)
        if (float(i) == slot) v = u_text[i];
    return lane < 0.5 ? v.x : lane < 1.5 ? v.y : lane < 2.5 ? v.z : v.w;
}
void main() {
    float x = v_uv.x * 18.0;
    float cell = max(floor(x - 2.0), 0.0);
    float ink = texture2D(u_font, vec2((code(cell) + fract(x)) / 32.0, v_uv.y)).r;
    vec4 icon = texture2D(u_icon, vec2(x * 0.5, v_uv.y));
    vec4 bg = vec4(0.02, 0.03, 0.05, 0.75);
    gl_FragColor = x < 2.0 ? vec4(mix(bg.rgb, icon.rgb, icon.a), max(bg.a, icon.a))
                           : vec4(mix(bg.rgb, vec3(1.0, 0.72, 0.1), ink), max(bg.a, ink));
}`;

const PLASMA_FS = `#version 100
${HIGHP}uniform float u_time;
varying vec2 v_uv;
void main() {
    vec2 p = (v_uv - 0.5) * 6.0;
    float v = sin(p.x + u_time) + sin(p.y * 1.3 - u_time * 0.7) + sin(length(p) * 2.2 - u_time * 1.4);
    gl_FragColor = vec4(0.6 * (0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + v * 1.6)), 1.0);
}`;

const ALERT_FS = `#version 100
${HIGHP}uniform float u_time;
varying vec2 v_uv;
void main() {
    float stripe = step(0.5, fract((v_uv.x * 2.5 + v_uv.y) * 4.0 - u_time));
    vec2 e = min(v_uv, 1.0 - v_uv);
    float border = step(min(e.x * 2.5, e.y), 0.12);
    float pulse = 0.55 + 0.45 * sin(u_time * 9.0);
    vec3 inner = vec3(0.75, 0.0, 0.0) * pulse;
    gl_FragColor = vec4(mix(inner, mix(vec3(0.1), vec3(1.0, 0.8, 0.0), stripe), border), 1.0);
}`;

/* A ring: kept between two radii, discarded elsewhere (it writes the
 * stencil where it is kept). */
const RING_FS = `#version 100
precision mediump float;
varying vec2 v_uv;
void main() {
    float r = length((v_uv - 0.5) * vec2(2.0, 1.0));
    if (r < 0.28 || r > 0.48) discard;
    gl_FragColor = vec4(1.0);
}`;

/* A canvas sampled, as it was drawn. */
const SAMPLE_FS = `#version 100
precision mediump float;
uniform sampler2D u_canvas;
varying vec2 v_uv;
void main() {
    gl_FragColor = texture2D(u_canvas, v_uv);
}`;

/* The tile pattern four times across, mirrored at each edge. */
const TILES_FS = `#version 100
precision mediump float;
uniform sampler2D u_tiles;
varying vec2 v_uv;
void main() {
    gl_FragColor = texture2D(u_tiles, v_uv * 4.0);
}`;

/* A soft disc of colour u_color, premultiplied by its alpha. */
const GLOW_FS = `#version 100
precision mediump float;
uniform vec4 u_color;
varying vec2 v_uv;
void main() {
    float a = u_color.a * smoothstep(0.5, 0.0, length(v_uv - 0.5));
    gl_FragColor = vec4(u_color.rgb * a, a);
}`;

/* Seven-segment glyphs, 16x32 each, in one 512x32 R8 atlas. */
const GLYPHS = '0123456789AbCdEFHLPrUnot-: .hSyu';
const SEGMENTS = {
    0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg',
    9: 'abcdfg', A: 'abcefg', b: 'cdefg', C: 'adef', d: 'bcdeg', E: 'adefg', F: 'aefg', H: 'bcefg', L: 'def',
    P: 'abefg', r: 'eg', U: 'bcdef', n: 'ceg', o: 'cdeg', t: 'defg', '-': 'g', ':': ':', '.': '.', h: 'cefg',
    S: 'afgcd', y: 'bcdfg', u: 'cde', ' ': '',
};
const STROKES = {
    a: [5, 2, 6, 3], b: [11, 5, 3, 9], c: [11, 17, 3, 9], d: [5, 26, 6, 3], e: [2, 17, 3, 9], f: [2, 5, 3, 9],
    g: [5, 14, 6, 3], ':': [6, 9, 4, 4, 6, 19, 4, 4], '.': [6, 25, 4, 4],
};

function font() {
    const w = 16 * GLYPHS.length, px = Buffer.alloc(w * 32);
    GLYPHS.split('').forEach((ch, cell) => SEGMENTS[ch].split('').forEach((s) => {
        const r = STROKES[s];
        for (let k = 0; k < r.length; k += 4)
            for (let y = r[k + 1]; y < r[k + 1] + r[k + 3]; y++)
                px.fill(255, y * w + cell * 16 + r[k], y * w + cell * 16 + r[k] + r[k + 2]);
    }));
    return px;
}

/* RGBA pixels of a w x h image from f(x, y) -> [r, g, b, a] or null. */
function paint(w, h, f) {
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const c = f(x + 0.5, y + 0.5);
            if (c) px.set(c, (y * w + x) * 4);
        }
    }
    return px;
}

/* Polar coordinates about (c, c): radius and degrees clockwise from up. */
function polar(x, y, c) {
    const dx = x - c, dy = y - c;
    return [Math.sqrt(dx * dx + dy * dy), Math.atan2(dx, -dy) * 180 / Math.PI];
}

/* A 32x32 gauge icon. */
function icon() {
    return paint(32, 32, (x, y) => {
        const [r, a] = polar(x, y, 16);
        const off = Math.abs(r * Math.sin((a - 45) * Math.PI / 180));
        if (r < 2.5) return [255, 255, 255, 255];
        if (r < 12 && off < 1.4 && Math.abs(a - 45) < 90) return [255, 70, 30, 255];
        if (r > 11 && r < 14.5 && Math.abs(a) < 135) return [0, 200, 255, 255];
        return null;
    });
}

/* A dial of radius R: ring, ticks every 20 degrees over +-120 (red past 80),
 * a hub at the centre. */
function dial(R) {
    return paint(2 * R, 2 * R, (x, y) => {
        const [r, a] = polar(x, y, R);
        const t = Math.round(a / 20) * 20;
        if (r < R * 0.06) return [230, 230, 230, 255];
        if (r > R * 0.7 && r < R * 0.85 && Math.abs(t) <= 120 && r * Math.abs(Math.sin((a - t) * Math.PI / 180)) < R * 0.015 + 1)
            return t > 80 ? [255, 40, 40, 255] : [240, 240, 240, 255];
        if (r > R * 0.87 && r < R * 0.93) return [150, 160, 175, 255];
        if (r < R * 0.93) return [8, 12, 20, 190];
        return null;
    });
}

/* A needle pointing up, w x l, its pivot (w/2, l - w/2). */
function needle(w, l) {
    return paint(w, l, (x, y) => {
        const half = (w / 2) * (0.3 + 0.7 * Math.min(y / (l - w / 2), 1));
        return Math.abs(x - w / 2) < half ? [255, 90, 20, 255] : null;
    });
}

/* A 128x128 tile: thin rings and spokes, fine enough to shimmer when drawn
 * small without mipmaps. */
function tiles() {
    return paint(128, 128, (x, y) => {
        const [r, a] = polar(x, y, 0);
        const ring = Math.abs((r % 12) - 6) < 1.2, spoke = Math.abs((a + 360) % 15 - 7.5) < 1;
        return ring ? [255, 200, 40, 255] : spoke ? [40, 160, 255, 255] : [10, 14, 24, 255];
    });
}

/* 6 faces x 4 vertices with their normals, wound counter-clockwise outside. */
function cube() {
    const g = { positions: [], normals: [], indices: [] };
    [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]].forEach((n) => {
        const a = [n[1], n[2], n[0]];
        const b = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
        const base = g.positions.length / 3;
        for (let v = 0; v < 4; v++) {
            const sa = v & 1 ? 1 : -1, sb = v & 2 ? 1 : -1;
            for (let c = 0; c < 3; c++) {
                g.positions.push(n[c] + sa * a[c] + sb * b[c]);
                g.normals.push(n[c]);
            }
        }
        [0, 1, 2, 2, 1, 3].forEach((k) => g.indices.push(base + k));
    });
    return g;
}

/* A 4:2:0 atlas of vertical bars moving right, framed in white. */
function bars(vw, vh, n) {
    const px = Buffer.alloc(vw * vh * 3 / 2);
    const band = (x) => Math.floor((x + n * 6) / 40) & 3;
    const Y = [180, 90, 140, 60], U = [60, 200, 90, 160], V = [200, 60, 220, 90];
    for (let y = 0; y < vh; y++) {
        for (let x = 0; x < vw; x++) {
            const edge = x < 6 || y < 6 || x >= vw - 6 || y >= vh - 6 || (x < 40 && y < 40);
            px[y * vw + x] = edge ? 235 : Y[band(x)];
        }
    }
    for (let y = 0; y < vh / 2; y++) {
        for (let x = 0; x < vw / 2; x++) {
            const row = vw * vh + y * vw, b = band(x * 2);
            px[row + x] = U[b];
            px[row + vw / 2 + x] = V[b];
        }
    }
    return px;
}

function parse(argv) {
    const a = { socket: DEFAULT_PATH, page: 'all', target: 'panel' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--socket') a.socket = argv[++i];
        else if (argv[i] === '--target') a.target = argv[++i];
        else if (argv[i] === '--size') a.size = String(argv[++i]).split('x').map(Number);
        else a.page = argv[i];
    }
    if (!a.size && Object.prototype.hasOwnProperty.call(SIZES, a.target))
        a.size = SIZES[a.target];
    if (!a.socket || !a.size || !(a.size[0] >= 16 && a.size[1] >= 16) ||
        (a.page !== 'all' && PAGES.indexOf(a.page) < 0)) {
        console.error('usage: node showcase.js [--socket PATH] [all|' + PAGES.join('|') +
            '] [--target panel|map|hud|guide|widget|popup] [--size WxH]');
        process.exit(2);
    }
    return a;
}

function main() {
    const args = parse(process.argv.slice(2));
    const target = args.target, W = args.size[0], H = args.size[1];
    const on = (page) => args.page === 'all' || args.page === page;
    const cr = new ClusterRender('showcase', args.socket);
    const names = {};
    const log = (s) => console.log(new Date().toISOString() + ' ' + s);
    const name = (ref, n) => { names[ref] = n; log('made ' + n + '(' + ref + ')'); return ref; };
    const who = (ref) => (names[ref] || '') + '(' + ref + ')';
    const why = (reason) => (reason ? ': ' + reason : '');
    cr.on('ready', () => log('ready: backend ' + cr.backend + ', targets ' + cr.targets));
    cr.on('disconnected', () => log('disconnected'));
    cr.on('layer', (ref, state, reason) => log('layer ' + who(ref) + ' ' + state + why(reason)));
    cr.on('target', (t, state, holder, reason) =>
        log('target ' + t + ' ' + state + (holder && holder !== 'none' ? ' (holder ' + holder + ')' : '') + why(reason)));
    cr.on('budget', (cap, max, reason) => log('budget ' + cap + ' of ' + max + ' KB/s' + why(reason)));
    cr.on('refused', (op, ref, reason) => log('refused ' + op + ' ' + who(ref) + why(reason)));

    if (on('plasma')) {
        name(cr.effect({ target: target, klass: 'ambient', fs: PLASMA_FS, time: true }), 'plasma');
    }

    if (on('needle')) {
        const R = Math.round(H * 0.36), cx = R + Math.round(W * 0.02), cy = Math.round(H / 2);
        const nw = 2 * Math.max(4, Math.round(R * 0.04)), nl = Math.round(R * 0.84);
        const ring = name(cr.image({ target: target, x: cx - R, y: cy - R, w: 2 * R, h: 2 * R }), 'dial');
        cr.pixels(ring, null, dial(R));
        const hand = name(cr.image({ target: target, z: 1, x: cx - nw / 2, y: cy - (nl - nw / 2), w: nw, h: nl,
            px: nw / 2, py: nl - nw / 2, sampling: 'bilinear' }), 'needle');
        cr.pixels(hand, null, needle(nw, nl));
        cr.animate(hand, { property: 'rotate', keys: '0:-120 3000:120 6000:-120', loop: true });
    }

    if (on('cube')) {
        const box = name(cr.mesh({ target: target, x: Math.round(W * 0.36), y: Math.round(H * 0.06),
            w: Math.round(W * 0.28), h: Math.round(H * 0.78), fov: 30, cz: 8 }), 'cube');
        cr.part(box, 1, { vs: LIT_VS, fs: LIT_FS, depth: true, cull: 'back' });
        cr.geometry(box, 1, cube());
        cr.uniform(box, 'u_color', [1, 0.45, 0, 1], { part: 1 });
        cr.animate(box, { part: 1, property: 'rotate', keys: '0:25,0,0 6000:25,360,0', loop: true });
    }

    if (on('video')) {
        const vw = 320, vh = 180, w = Math.round(W * 0.26), h = Math.round(w * 9 / 16);
        const vid = name(cr.video({ target: target, x: Math.round(W * 0.71), y: Math.round((H - h) / 2), w: w, h: h,
            vw: vw, vh: vh, fps: 15, rotate: 5, sx: 0.8 }), 'video');
        let n = 0;
        setInterval(() => { n++; cr.frame(vid, bars(vw, vh, n), n); }, 1000 / 15);
    }

    if (on('text')) {
        const h = Math.round(H * 0.11), w = 9 * h;
        const glyphs = name(cr.asset({ target: target, format: 'r8', w: 512, h: 32, sampling: 'bilinear' }), 'font');
        const sprite = name(cr.asset({ target: target, w: 32, h: 32, sampling: 'bilinear' }), 'icon');
        cr.pixels(glyphs, null, font());
        cr.pixels(sprite, null, icon());
        const label = name(cr.effect({ target: target, klass: 'overlay', x: Math.round((W - w) / 2),
            y: Math.round(H * 0.68), w: w, h: h, fs: TEXT_FS }), 'text');
        cr.bind(label, 'u_font', glyphs);
        cr.bind(label, 'u_icon', sprite);
        const start = Date.now();
        const show = () => {
            const d = new Date(), two = (v) => ('0' + v).slice(-2);
            const count = ('     ' + Math.floor((Date.now() - start) / 1000)).slice(-6);
            const s = two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + '  ' + count;
            cr.uniform(label, 'u_text', s.split('').map((ch) => GLYPHS.indexOf(ch)), { type: 'vec4' });
        };
        show();
        setInterval(show, 1000);
    }

    if (on('glow')) {
        /* Trilinear and mirrored: the renderer shrinks it to a fifth and
         * back, every level made by the service from the one picture. */
        const t = Math.round(H * 0.5), tx = Math.round(W * 0.04), ty = Math.round(H * 0.1);
        const pattern = name(cr.asset({ target: target, w: 128, h: 128, sampling: 'trilinear', wrap: 'mirror',
            anisotropy: 4 }), 'tiles');
        cr.pixels(pattern, null, tiles());
        const tile = name(cr.effect({ target: target, x: tx, y: ty, w: t, h: t, fs: TILES_FS, blend: 'none' }), 'tile');
        cr.bind(tile, 'u_tiles', pattern);
        cr.animate(tile, { property: 'scale', keys: '0:1,1,1 4000:0.2,0.2,1 8000:1,1,1', loop: true });
        /* Three glows over each other: each channel the brightest. */
        const g = Math.round(H * 0.42), gx = Math.round(W * 0.6), gy = Math.round(H * 0.08);
        [[1, 0.2, 0.1, 1, 0, 0], [0.1, 1, 0.3, 1, g * 0.45, 0], [0.2, 0.4, 1, 1, g * 0.22, g * 0.4]].forEach((c, k) => {
            const glow = name(cr.effect({ target: target, klass: 'overlay', z: k, x: gx + c[4], y: gy + c[5], w: g, h: g,
                fs: GLOW_FS, blend: 'max' }), 'glow');
            cr.uniform(glow, 'u_color', c.slice(0, 4));
        });
        /* A shadow taken away from what is below, its alpha left as it is. */
        const shadow = name(cr.effect({ target: target, klass: 'overlay', z: 5, x: Math.round(gx - g * 0.1),
            y: Math.round(gy + g * 0.35), w: Math.round(g * 1.65), h: Math.round(g * 0.4), fs: GLOW_FS,
            blend: 'subtract', color_mask: 'rgb' }), 'shadow');
        cr.uniform(shadow, 'u_color', [0.6, 0.6, 0.6, 1]);
    }

    if (on('canvas')) {
        /* A ring in the stencil, plasma only inside it: the canvas's own
         * depth-stencil buffer, never the display's. */
        const cw = 512, ch = 256, x0 = Math.round(W * 0.05), y0 = Math.round(H * 0.15);
        const ring = name(cr.canvas({ target: target, w: cw, h: ch, depth: true, clear: [0.05, 0.07, 0.12, 1],
            sampling: 'bilinear' }), 'ring canvas');
        name(cr.effect({ target: target, canvas: ring, w: cw, h: ch, fs: RING_FS, color_mask: 'none',
            stencil_func: 'always', stencil_ref: 1, stencil_pass: 'replace' }), 'ring mask');
        name(cr.effect({ target: target, canvas: ring, z: 1, w: cw, h: ch, fs: PLASMA_FS, time: true,
            stencil_func: 'equal', stencil_ref: 1 }), 'ring plasma');
        /* a canvas's pixels are premultiplied: sampled as such */
        const shown = name(cr.effect({ target: target, x: x0, y: y0, w: cw, h: ch, fs: SAMPLE_FS,
            blend: 'premultiplied' }), 'ring');
        cr.bind(shown, 'u_canvas', ring);
        /* A cube drawn once, in a canvas drawn once, shown twice. */
        const cs = 256, cx = Math.round(W * 0.45);
        const still = name(cr.canvas({ target: target, w: cs, h: cs, depth: true, once: true, clear: [0, 0, 0, 0],
            sampling: 'bilinear' }), 'cube canvas');
        const box = name(cr.mesh({ target: target, canvas: still, w: cs, h: cs, fov: 30, cz: 7 }), 'cube in canvas');
        cr.part(box, 1, { vs: LIT_VS, fs: LIT_FS, depth: true, cull: 'back' });
        cr.geometry(box, 1, cube());
        cr.uniform(box, 'u_color', [0.2, 0.7, 1, 1], { part: 1 });
        cr.transform(box, 1, { rx: 25, ry: 35 });
        const a = name(cr.effect({ target: target, x: cx, y: y0, w: cs, h: cs, fs: SAMPLE_FS,
            blend: 'premultiplied' }), 'cube copy');
        const b = name(cr.effect({ target: target, x: cx + cs + 40, y: y0, w: cs, h: cs, fs: SAMPLE_FS,
            blend: 'premultiplied' }), 'cube turned');
        cr.bind(a, 'u_canvas', still);
        cr.bind(b, 'u_canvas', still);
        cr.animate(b, { property: 'rotate', keys: '0:0 6000:360', loop: true });
    }

    if (on('alert')) {
        const pop = () => {
            const alert = name(cr.effect({ target: target, klass: 'alert', exclusive: true, x: Math.round(W * 0.25),
                y: Math.round(H * 0.3), w: Math.round(W * 0.5), h: Math.round(H * 0.4), fs: ALERT_FS, time: true }), 'alert');
            setTimeout(() => { log('dropping alert(' + alert + ')'); cr.drop(alert); }, 4000);
        };
        setTimeout(() => { pop(); setInterval(pop, 30000); }, args.page === 'all' ? 12000 : 1000);
    }

    const end = () => { cr.close(); process.exit(0); };
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
    log('showcase ' + args.page + ' on ' + target + ' (' + W + 'x' + H + ') via ' + args.socket);
    cr.connect();
}

main();
