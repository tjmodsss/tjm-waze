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
 *           twice, one of them turned by the renderer;
 *   motion  eased curves and part hierarchies (a service whose hello has
 *           curves and nodes): two needles swept the same way, linear and
 *           ease_in_out; an arm and a spinning tip that follow a pivot the
 *           renderer turns along a smooth curve;
 *   geometry draw modes and instances (a service whose hello has draw):
 *           16 cubes drawn as instances of one, a ring as a line loop and
 *           a field of points, all turned by the renderer;
 *   label   text from the text helper (cluster_render_text.js, a service
 *           whose hello has text): a clock, a speed changing ten times a
 *           second, a status line and a line of 82 characters in a
 *           proportional 5x7 font made here, each changed by its string;
 *   values  eight lamps whose glow follows one shared value the renderer
 *           animates, all in step, and whose rims follow a second value
 *           set every two seconds (a service whose hello has values);
 *   cubemap a cube map of six coloured faces (a service whose hello has
 *           cube) on a cube the renderer turns, and on one facing the
 *           camera, which shows the +z face (blue).
 * Every animation runs in the renderer; the client sends only the text and
 * the video's frames. Every layer, target, budget and refused
 * event is printed with its time.
 *
 * On the unit (Node 8): copy this file, cluster_render_client.js and
 * cluster_render_text.js into one directory and run it as a user that may
 * open the service's socket (group tm_oap_app, or root); Ctrl-C ends it and
 * its layers go with it.
 *   node showcase.js [--socket PATH] [all|cube|text|needle|plasma|alert|video|glow|canvas|motion|geometry|label|values|cubemap]
 *                    [--target panel|map|hud|guide|widget|popup] [--size WxH]
 * The sizes are iDrive 7's targets' and iDrive 8's guide, widget and popup
 * canvases; --size gives another (iDrive 8: map 874x749, hud 353x203).
 */
'use strict';

const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client.js');

const PAGES = ['cube', 'text', 'needle', 'plasma', 'alert', 'video', 'glow', 'canvas', 'motion', 'geometry', 'label',
    'values', 'cubemap'];
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

/* GLSL ES 3.00: each instance its own place in a 4x4 grid and colour. */
const INSTANCED_VS = `#version 300 es
in vec3 a_position;
in vec3 a_normal;
uniform mat4 u_mvp;
uniform mat4 u_normal;
out vec3 v_n;
out vec3 v_c;
void main() {
    float i = float(gl_InstanceID);
    vec3 at = vec3(mod(i, 4.0) * 2.6 - 3.9, floor(i / 4.0) * 2.6 - 3.9, 0.0);
    v_n = (u_normal * vec4(a_normal, 0.0)).xyz;
    v_c = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + i * 0.4);
    gl_Position = u_mvp * vec4(a_position * 0.8 + at, 1.0);
}`;

const INSTANCED_FS = `#version 300 es
precision mediump float;
in vec3 v_n;
in vec3 v_c;
out vec4 o;
void main() {
    float d = max(dot(normalize(v_n), normalize(vec3(0.4, 0.7, 0.6))), 0.0);
    o = vec4(v_c * (0.25 + 0.75 * d), 1.0);
}`;

/* Points and lines: a colour, each point 3 pixels. */
const FLAT_VS = `#version 100
attribute vec3 a_position;
uniform mat4 u_mvp;
void main() {
    gl_PointSize = 3.0;
    gl_Position = u_mvp * vec4(a_position, 1.0);
}`;

const FLAT_FS = `#version 100
precision mediump float;
uniform vec4 u_color;
void main() {
    gl_FragColor = u_color;
}`;

/* A 5x7 dot font: seven rows of five columns a glyph, '#' a dot. */
const DOTS = {
    '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
    '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
    '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
    'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
    'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
    'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'I': ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
    'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
    'N': ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
    'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
    'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
    ':': ['.', '#', '#', '.', '#', '#', '.'],
    '.': ['.', '.', '.', '.', '.', '#', '#'],
    '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
    '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....']
};

/* The dot font as glyph bitmaps for Font.fromGlyphs: each dot a round spot
 * s pixels across, a line 9 dots high (a dot above and below). */
function dotFont(Font, s) {
    const glyphs = Object.keys(DOTS).map((c) => {
        const rows = DOTS[c], w = rows[0].length * s, h = 7 * s, px = Buffer.alloc(w * h);
        rows.forEach((row, r) => Array.from(row).forEach((d, k) => {
            if (d !== '#') return;
            for (let y = 0; y < s; y++)
                for (let x = 0; x < s; x++) {
                    const dx = (x + 0.5) / s - 0.5, dy = (y + 0.5) / s - 0.5;
                    const a = Math.max(0, Math.min(1, (0.46 - Math.sqrt(dx * dx + dy * dy)) * s));
                    px[(r * s + y) * w + k * s + x] = Math.round(255 * a);
                }
        }));
        return { char: c, w: w, h: h, top: s, advance: w + s, pixels: px };
    });
    glyphs.push({ char: ' ', w: 0, h: 0, top: 0, advance: 3 * s, pixels: Buffer.alloc(0) });
    return Font.fromGlyphs(9 * s, glyphs);
}

/* The label page's lines, [x, y, h, w] as fractions of the target: each
 * wide enough for its longest text in dotFont() on the panel. */
const LABEL_LINES = { clock: [0.05, 0.08, 0.18, 0.31], speed: [0.37, 0.3, 0.3, 0.58],
    status: [0.05, 0.66, 0.1, 0.9], ticker: [0.02, 0.86, 0.05, 0.96] };
/* The status line's states, and the long line: of the font's letters. */
const LABEL_STATES = ['READY', 'ECO MODE', 'RANGE 412 KM', 'SPORT'];
const LABEL_TICKER = 'RANGE 412 KM - ETA 14:35 - ECO MODE ON - STOP: MUNICH 28 KM - SPEED LIMIT 120 KM/H';
/* Every text each line shows, to check they fit. */
const LABEL_TEXTS = { clock: ['00:00:00', '23:59:59', '08:08:08'], status: LABEL_STATES, ticker: [LABEL_TICKER],
    speed: Array.from({ length: 180 }, (_, i) => i + ' KM/H') };

/* A lamp: its colour lit by u_glow, a rim of u_rim; premultiplied. */
const LAMP_FS = `#version 100
precision mediump float;
uniform float u_glow;
uniform vec3 u_color;
uniform vec3 u_rim;
varying vec2 v_uv;
void main() {
    float d = length(v_uv - 0.5) * 2.0;
    float core = smoothstep(0.85, 0.0, d) * (0.15 + 0.85 * u_glow);
    float ring = smoothstep(0.07, 0.0, abs(d - 0.9));
    float a = max(core, ring);
    gl_FragColor = vec4(u_color * core + u_rim * ring, a);
}`;

/* A cube sampling a cube map by its own direction from its centre. */
const SKY_VS = `#version 100
attribute vec3 a_position;
uniform mat4 u_mvp;
varying vec3 v_d;
void main() {
    v_d = a_position;
    gl_Position = u_mvp * vec4(a_position, 1.0);
}`;

const SKY_FS = `#version 100
precision mediump float;
uniform samplerCube u_sky;
varying vec3 v_d;
void main() {
    gl_FragColor = textureCube(u_sky, v_d);
}`;

/* Six 64x64 faces, +x, -x, +y, -y, +z, -z: red, cyan, green, magenta, blue,
 * yellow, each with a white rim. */
function skyFaces() {
    const S = 64, colours = [[230, 40, 40], [40, 220, 220], [40, 200, 60], [210, 50, 210], [50, 90, 240], [240, 220, 40]];
    const px = Buffer.alloc(6 * S * S * 4);
    colours.forEach((c, f) => {
        for (let y = 0; y < S; y++) {
            for (let x = 0; x < S; x++) {
                const rim = x < 3 || y < 3 || x >= S - 3 || y >= S - 3;
                px.set(rim ? [255, 255, 255, 255] : [c[0], c[1], c[2], 255], ((f * S + y) * S + x) * 4);
            }
        }
    });
    return px;
}

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

    if (on('motion')) {
        /* Two needles, one sweep: linear on the left, eased on the right. */
        const R = Math.round(H * 0.3), cy = Math.round(H * 0.55);
        const nw = 2 * Math.max(4, Math.round(R * 0.05)), nl = Math.round(R * 0.9);
        ['linear', 'ease_in_out'].forEach((interp, k) => {
            const cx = Math.round(W * (0.12 + 0.24 * k));
            const ring = name(cr.image({ target: target, x: cx - R, y: cy - R, w: 2 * R, h: 2 * R }), 'dial ' + interp);
            cr.pixels(ring, null, dial(R));
            const hand = name(cr.image({ target: target, z: 1, x: cx - nw / 2, y: cy - (nl - nw / 2), w: nw, h: nl,
                px: nw / 2, py: nl - nw / 2, sampling: 'bilinear' }), 'needle ' + interp);
            cr.pixels(hand, null, needle(nw, nl));
            cr.animate(hand, { property: 'rotate', keys: '0:-120 2000:120 4000:-120', loop: true, interp: interp });
        });
        /* An arm and its tip following a pivot turned along a smooth curve. */
        const rig = name(cr.mesh({ target: target, x: Math.round(W * 0.55), y: Math.round(H * 0.05),
            w: Math.round(W * 0.4), h: Math.round(H * 0.9), fov: 30, cz: 24 }), 'arm');
        cr.part(rig, 10, { node: true });
        cr.part(rig, 1, { vs: LIT_VS, fs: LIT_FS, depth: true, cull: 'back', parent: 10 });
        cr.geometry(rig, 1, cube());
        cr.transform(rig, 1, { tx: 2.2, sx: 2.2, sy: 0.25, sz: 0.25 });
        cr.uniform(rig, 'u_color', [0.9, 0.9, 0.95, 1], { part: 1 });
        cr.part(rig, 11, { node: true, parent: 10 });
        cr.transform(rig, 11, { tx: 4.6 });
        cr.part(rig, 2, { vs: LIT_VS, fs: LIT_FS, depth: true, cull: 'back', parent: 11 });
        cr.geometry(rig, 2, cube());
        cr.transform(rig, 2, { sx: 0.7, sy: 0.7, sz: 0.7 });
        cr.uniform(rig, 'u_color', [1, 0.45, 0, 1], { part: 2 });
        cr.animate(rig, { part: 10, property: 'rotate', interp: 'smooth', loop: true,
            keys: '0:0,0,0 1500:0,0,70 2500:0,0,40 4000:0,0,160 6000:0,0,360' });
        cr.animate(rig, { part: 2, property: 'rotate', loop: true, keys: '0:0,0,0 1000:360,360,0' });
    }

    if (on('geometry')) {
        /* 16 cubes: one cube's geometry, drawn 16 times. */
        const grid = name(cr.mesh({ target: target, x: Math.round(W * 0.02), y: Math.round(H * 0.05),
            w: Math.round(W * 0.4), h: Math.round(H * 0.9), fov: 30, cz: 22 }), 'instances');
        /* made once the hello says whether the service draws instances: one
         * cube where it does not */
        cr.once('ready', () => {
            if (!cr.instances) log('instances are off on this service: one cube');
            cr.part(grid, 1, { vs: INSTANCED_VS, fs: INSTANCED_FS, depth: true, cull: 'back',
                instances: cr.instances ? 16 : 1 });
            cr.geometry(grid, 1, cube());
            cr.animate(grid, { part: 1, property: 'rotate', keys: '0:0,0,0 8000:0,360,0', loop: true });
        });
        /* A ring as a line loop and a field of points, turned together. */
        const sky = name(cr.mesh({ target: target, x: Math.round(W * 0.5), y: Math.round(H * 0.05),
            w: Math.round(W * 0.45), h: Math.round(H * 0.9), fov: 30, cz: 9 }), 'lines and points');
        const ring = { positions: [], indices: [] };
        for (let k = 0; k < 96; k++) {
            const a = k * Math.PI * 2 / 96;
            ring.positions.push(Math.cos(a) * 2.2, Math.sin(a) * 2.2, 0);
            ring.indices.push(k);
        }
        cr.part(sky, 1, { vs: FLAT_VS, fs: FLAT_FS, depth: false, cull: 'none', draw: 'line_loop' });
        cr.geometry(sky, 1, ring);
        cr.uniform(sky, 'u_color', [0.4, 0.8, 1, 1], { part: 1 });
        const stars = { positions: [], indices: [] };
        let seed = 7;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        for (let k = 0; k < 600; k++) {
            stars.positions.push(rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 2 - 1);
            stars.indices.push(k);
        }
        cr.part(sky, 2, { vs: FLAT_VS, fs: FLAT_FS, depth: false, cull: 'none', draw: 'points' });
        cr.geometry(sky, 2, stars);
        cr.uniform(sky, 'u_color', [1, 0.9, 0.6, 1], { part: 2 });
        cr.animate(sky, { part: 1, property: 'rotate', keys: '0:60,0,0 6000:60,0,360', loop: true });
        cr.animate(sky, { part: 2, property: 'rotate', keys: '0:0,0,0 12000:0,360,0', loop: true });
    }

    if (on('label')) {
        /* Four text layers from one font sent once; each change sends its
         * string. */
        const { Font, Text } = require('./cluster_render_text.js');
        const font = dotFont(Font, 8);
        const atlas = name(font.asset(cr, target), 'dot font');
        const line = (at, opts) => new Text(cr, font, atlas, Object.assign({ target: target, x: Math.round(W * at[0]),
            y: Math.round(H * at[1]), w: Math.round(W * at[3]), h: Math.round(H * at[2]) }, opts));
        const clock = line(LABEL_LINES.clock, { color: [1, 1, 1, 1], maxGlyphs: 8 });
        const speed = line(LABEL_LINES.speed, { color: [0.3, 0.85, 1, 1], align: 'right', maxGlyphs: 8 });
        const status = line(LABEL_LINES.status, { color: [1, 0.75, 0.2, 1], align: 'center' });
        const ticker = line(LABEL_LINES.ticker, { color: [0.85, 0.85, 0.85, 1], maxGlyphs: 96 });
        /* a target narrower than the panel may cut a line: said once */
        let cut = false;
        const show = (t, text, what) => {
            const fits = t.set(text);
            if (!fits && !cut) log(what + ' "' + text + '" is wider than its line on this target: shown cut');
            cut = cut || !fits;
        };
        name(clock.ref, 'clock');
        name(speed.ref, 'speed');
        name(status.ref, 'status');
        name(ticker.ref, 'ticker');
        const states = LABEL_STATES;
        let v = 0, k = 0, fast = false;
        const clockTick = () => {
            const d = new Date();
            show(clock, ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' +
                ('0' + d.getSeconds()).slice(-2), 'the clock');
        };
        /* the speed ten times a second, red past 130 */
        const speedTick = () => {
            v = (v + 1) % 180;
            show(speed, v + ' KM/H', 'the speed');
            if (fast !== v > 130) speed.color(v > 130 ? [1, 0.3, 0.25, 1] : [0.3, 0.85, 1, 1]);
            fast = v > 130;
        };
        clockTick();
        speedTick();
        show(status, states[0], 'the status');
        show(ticker, LABEL_TICKER, 'the long line');
        setInterval(clockTick, 1000);
        setInterval(speedTick, 100);
        setInterval(() => show(status, states[++k % states.length], 'the status'), 2000);
    }

    if (on('values')) {
        /* One value the renderer animates, which every lamp's u_glow
         * follows; another the app sets, every lamp's u_rim. */
        const glow = name(cr.value({ target: target, v: 0 }), 'glow');
        const rim = name(cr.value({ target: target, type: 'vec3', v: [1, 1, 1] }), 'rim');
        const colours = [[1, 0.2, 0.2], [1, 0.55, 0.1], [1, 0.9, 0.1], [0.3, 1, 0.3], [0.1, 0.9, 0.9],
            [0.2, 0.5, 1], [0.6, 0.3, 1], [1, 0.3, 0.8]];
        const size = Math.round(Math.min(W / 10, H * 0.6));
        colours.forEach((c, i) => {
            const lamp = name(cr.effect({ target: target, x: Math.round(W * 0.05 + i * W * 0.113), y: Math.round((H - size) / 2),
                w: size, h: size, fs: LAMP_FS, blend: 'premultiplied' }), 'lamp ' + i);
            cr.uniform(lamp, 'u_color', c);
            cr.link(lamp, 'u_glow', glow);
            cr.link(lamp, 'u_rim', rim);
        });
        cr.animate(glow, { property: 'value', keys: '0:0 700:1 1400:0', loop: true, interp: 'smooth' });
        const rims = [[1, 1, 1], [1, 0.8, 0.2], [0.3, 0.8, 1]];
        let k = 0;
        setInterval(() => cr.setValue(rim, rims[++k % rims.length]), 2000);
    }

    if (on('cubemap')) {
        const sky = name(cr.asset({ target: target, w: 64, h: 64, cube: true, sampling: 'bilinear' }), 'cube map');
        cr.pixels(sky, null, skyFaces());
        [[0.05, true], [0.55, false]].forEach((c) => {
            const m = name(cr.mesh({ target: target, x: Math.round(W * c[0]), y: Math.round(H * 0.05),
                w: Math.round(W * 0.4), h: Math.round(H * 0.9), fov: 30, cz: 7 }), c[1] ? 'turned' : 'facing');
            cr.part(m, 1, { vs: SKY_VS, fs: SKY_FS, depth: true, cull: 'back' });
            cr.geometry(m, 1, cube());
            cr.bind(m, 'u_sky', sky, 1);
            if (c[1])
                cr.animate(m, { part: 1, property: 'rotate', keys: '0:20,0,0 8000:20,360,360', loop: true });
        });
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

/* Run, or required (the test): the label page's font and lines. */
if (require.main === module) main();
else module.exports = { dotFont, LABEL_LINES, LABEL_TEXTS };
