/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Text for cluster-render (PROTOCOL.md "Text"): a Font packs its glyphs
 * into an r8 atlas and sends it once as an asset with its table
 * (ClusterRender.font()); a Text is a text layer drawing a line of it, laid
 * out by the service (ClusterRender.text()), so changing the string sends
 * the string alone. Both need a service whose hello has text (cr.texts);
 * they are held until then.
 *
 *   const { Font, Text } = require('./cluster_render_text.js');
 *   const font = Font.fromGrid({ pixels, w: 160, h: 64, cols: 10, rows: 2, chars: '0123456789ABCDEFGHIJ' });
 *   const fontRef = font.asset(cr, 'panel');
 *   const speed = new Text(cr, font, fontRef, { target: 'panel', x: 100, y: 100, w: 300, h: 64,
 *       color: [1, 1, 1, 1], align: 'right' });
 *   speed.set('123');
 *
 * Node 8. */
'use strict';

const MAX_ATLAS = 2048;
/* The most glyphs a Text holds, and how many it holds unless told. */
const MAX_GLYPHS = 256;
const DEFAULT_GLYPHS = 64;

class Font {
    /* glyphs: [{ code, w, h, left, top, advance, pixels }]: each glyph's
     * bitmap w x h R8, its offset from the pen and the line's top, its
     * advance, in pixels; kerning: Map of 'first,second' code pairs to
     * pixels; sdf: the glyphs are distance fields, their range in pixels
     * each side of the edge (0: coverage). Throws when the glyphs do not fit
     * a 2048 x 2048 atlas. */
    constructor(lineHeight, glyphs, kerning, sdf) {
        if (!(lineHeight >= 1 && lineHeight <= MAX_ATLAS)) throw new Error('lineHeight is 1 to 2048');
        if (!(Number.isInteger(sdf || 0) && (sdf || 0) >= 0 && (sdf || 0) <= 64)) throw new Error('sdf is 0 to 64');
        this.lineHeight = lineHeight;
        this.kerning = kerning || new Map();
        this.sdf = sdf || 0;
        this.glyphs = new Map();
        /* Shelves of glyphs, a column and a row of 0 around each: nothing
         * bleeds in when sampled bilinear. As wide as a square of their
         * area, a power of two. */
        let area = 0, widest = 0;
        glyphs.forEach((g) => {
            if (Math.abs(g.left || 0) > 2048 || Math.abs(g.top || 0) > 2048 || g.advance > 2048)
                throw new Error('glyph ' + g.code + ': left and top are -2048 to 2048, advance at most 2048');
            area += (g.w + 1) * (g.h + 1);
            widest = Math.max(widest, g.w + 2);
        });
        let w = 16;
        while (w < MAX_ATLAS && (w * w < area || w < widest)) w *= 2;
        const at = [];
        let x = 1, y = 1, shelf = 0;
        glyphs.forEach((g) => {
            if (x + g.w + 1 > w) { x = 1; y += shelf + 1; shelf = 0; }
            at.push([x, y]);
            x += g.w + 1;
            shelf = Math.max(shelf, g.h);
        });
        const h = y + shelf + 1;
        if (widest > w || h > MAX_ATLAS) throw new Error('the glyphs do not fit a 2048 x 2048 atlas');
        this.w = w;
        this.h = h;
        this.pixels = Buffer.alloc(w * h);
        glyphs.forEach((g, i) => {
            for (let row = 0; row < g.h; row++)
                g.pixels.copy(this.pixels, (at[i][1] + row) * w + at[i][0], row * g.w, row * g.w + g.w);
            this.glyphs.set(g.code, { x: at[i][0], y: at[i][1], w: g.w, h: g.h, left: g.left || 0, top: g.top || 0,
                advance: g.advance });
        });
    }

    /* Glyphs of bitmaps (each w x h R8, top: its first row's distance below
     * the line's top) in a line lineHeight high; an advance absent or
     * negative: the glyph's width. */
    static fromGlyphs(lineHeight, glyphs, kerning, sdf) {
        return new Font(lineHeight, glyphs.map((g) => ({
            code: typeof g.char === 'string' ? g.char.codePointAt(0) : g.code, w: g.w, h: g.h, left: g.left || 0,
            top: g.top || 0, advance: g.advance === undefined || g.advance < 0 ? g.w : g.advance, pixels: g.pixels
        })), kerning, sdf);
    }

    /* A monospace grid: pixels (w x h R8, or RGBA with bpp 4: its alpha)
     * of cols x rows cells, chars the characters cell by cell; advance: the
     * cells' (their width by default). */
    static fromGrid(o) {
        const bpp = o.bpp || 1, cw = Math.floor(o.w / o.cols), ch = Math.floor(o.h / o.rows);
        const chars = Array.from(o.chars);
        if (chars.length > o.cols * o.rows) throw new Error('more chars than cells');
        return new Font(ch, chars.map((c, i) => {
            const cx = (i % o.cols) * cw, cy = Math.floor(i / o.cols) * ch, px = Buffer.alloc(cw * ch);
            for (let y = 0; y < ch; y++)
                for (let x = 0; x < cw; x++)
                    px[y * cw + x] = o.pixels[((cy + y) * o.w + cx + x) * bpp + bpp - 1];
            return { code: c.codePointAt(0), w: cw, h: ch, left: 0, top: 0, advance: o.advance || cw, pixels: px };
        }));
    }

    /* An AngelCode BMFont (its text .fnt) and its page's pixels (page.w x
     * page.h, R8, or RGBA with bpp 4: its alpha); sdf as the constructor's.
     * Throws for a font of several pages, of glyphs packed in channels, of
     * a glyph outside the page or of a negative xadvance. */
    static fromBMFont(fnt, page, sdf) {
        const bpp = page.bpp || 1;
        const field = (line, k) => { const m = new RegExp('\\b' + k + '=(-?\\d+)').exec(line); return m ? Number(m[1]) : 0; };
        let lineHeight = 0;
        const glyphs = [], kerning = new Map();
        fnt.split(/\r?\n/).forEach((line) => {
            if (/^common\b/.test(line)) {
                lineHeight = field(line, 'lineHeight');
                if (field(line, 'pages') > 1 || field(line, 'packed')) throw new Error('a BMFont of one page, unpacked');
            } else if (/^char\b/.test(line)) {
                const g = { code: field(line, 'id'), x: field(line, 'x'), y: field(line, 'y'), w: field(line, 'width'),
                    h: field(line, 'height'), left: field(line, 'xoffset'), top: field(line, 'yoffset'),
                    advance: field(line, 'xadvance') };
                const chnl = field(line, 'chnl');
                if (field(line, 'page') || (chnl && chnl !== 15)) throw new Error('a BMFont of one page, unpacked');
                if (g.x < 0 || g.y < 0 || g.w < 0 || g.h < 0 || g.x + g.w > page.w || g.y + g.h > page.h)
                    throw new Error('glyph ' + g.code + ' outside the page');
                if (g.advance < 0) throw new Error('glyph ' + g.code + ': a negative xadvance');
                const px = Buffer.alloc(g.w * g.h);
                for (let y = 0; y < g.h; y++)
                    for (let x = 0; x < g.w; x++)
                        px[y * g.w + x] = page.pixels[((g.y + y) * page.w + g.x + x) * bpp + bpp - 1];
                g.pixels = px;
                glyphs.push(g);
            } else if (/^kerning\b/.test(line)) {
                kerning.set(field(line, 'first') + ',' + field(line, 'second'), field(line, 'amount'));
            }
        });
        return Font.fromGlyphs(lineHeight, glyphs, kerning, sdf);
    }

    /* The table ClusterRender.font() takes: { line, sdf, glyphs, kerning },
     * glyphs in code order, kerning only of glyphs the font has. */
    options() {
        const codes = Array.from(this.glyphs.keys()).sort((a, b) => a - b);
        const glyphs = codes.map((c) => {
            const g = this.glyphs.get(c);
            return c + ':' + [g.x, g.y, g.w, g.h, g.left, g.top, g.advance].join(',');
        }).join(' ');
        const pairs = [];
        this.kerning.forEach((amount, key) => {
            const p = key.split(',').map(Number);
            if (amount && this.glyphs.has(p[0]) && this.glyphs.has(p[1])) pairs.push([p[0], p[1], amount]);
        });
        pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return { line: this.lineHeight, sdf: this.sdf, glyphs: glyphs,
            kerning: pairs.map((p) => p[0] + ',' + p[1] + ':' + p[2]).join(' ') };
    }

    /* The font and its atlas, an r8 asset on target sampled bilinear,
     * which goes when the font is dropped (ClusterRender.font()); the
     * font's ref, 0 when refused here. */
    asset(cr, target) {
        return cr.font(Object.assign({ target: target, w: this.w, h: this.h, pixels: this.pixels }, this.options()));
    }

    /* text in a line h pixels high, spacing pixels between characters, as
     * the service lays it out: { width: its advance, glyphs: the glyphs it
     * draws }. A character the font lacks advances by a space, or not at
     * all. */
    measure(text, h, spacing) {
        const s = h / this.lineHeight, space = this.glyphs.get(32);
        let x = 0, n = 0, prev = -1;
        Array.from(String(text)).forEach((c) => {
            const code = c.codePointAt(0), g = this.glyphs.get(code);
            if (prev >= 0) {
                const k = this.kerning.get(prev + ',' + code);
                if (k && g && this.glyphs.has(prev)) x += k * s;
                x += spacing || 0;
            }
            if (g) {
                if (g.w && g.h) n++;
                x += g.advance * s;
            } else if (space) {
                x += space.advance * s;
            }
            prev = code;
        });
        return { width: x, glyphs: n };
    }
}

class Text {
    /* A text layer drawing strings from font (whose ref on cr is fontRef,
     * Font.asset()) over its rect, a line as high as the rect: opts the
     * layer's (target, x, y, w, h, klass, z, ...), color [r, g, b, a] (0-1,
     * white by default), align 'left' (default), 'center' or 'right',
     * spacing (pixels between characters), maxGlyphs (the glyphs it holds:
     * 1 to MAX_GLYPHS, DEFAULT_GLYPHS by default). ref 0, nothing sent, when
     * w or h is not a number above 0 or maxGlyphs is out of range. */
    constructor(cr, font, fontRef, opts) {
        this.cr = cr;
        this.font = font;
        this.opts = Object.assign({ align: 'left', spacing: 0, maxGlyphs: DEFAULT_GLYPHS, color: [1, 1, 1, 1] }, opts);
        this.max = this.opts.maxGlyphs;
        this.ref = 0;
        if (!(this.opts.w > 0 && this.opts.h > 0 && isFinite(this.opts.w) && isFinite(this.opts.h)) ||
            !(Number.isInteger(this.max) && this.max >= 1 && this.max <= MAX_GLYPHS)) return;
        const lo = Object.assign({}, opts);
        ['color', 'align', 'spacing', 'maxGlyphs'].forEach((k) => delete lo[k]);
        this.ref = cr.text(Object.assign(lo, { font: fontRef, max: this.max, align: this.opts.align,
            spacing: this.opts.spacing, color: this.opts.color }));
    }

    /* The string shown, sent as it is; false when it has more glyphs than
     * the layer holds or is wider than its rect (it is shown cut), or,
     * nothing sent and the last string kept, when it is past 1024 bytes of
     * UTF-8 or has a lone surrogate. */
    set(text) {
        if (!this.ref || !this.cr.setText(this.ref, String(text))) return false;
        const m = this.font.measure(String(text), this.opts.h, this.opts.spacing);
        return m.glyphs <= this.max && m.width <= this.opts.w;
    }

    color(rgba) {
        if (!this.ref) return;
        this.opts.color = [].concat(rgba);
        this.cr.textStyle(this.ref, { color: this.opts.color });
    }

    drop() {
        if (this.ref) this.cr.drop(this.ref);
        this.ref = 0;
    }
}

module.exports = { Font, Text, MAX_GLYPHS, DEFAULT_GLYPHS };
