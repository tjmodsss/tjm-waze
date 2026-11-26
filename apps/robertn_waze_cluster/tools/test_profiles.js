// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * profile_sync against the fake patch daemon (which keeps the map settings
 * per driver profile as patchd does) and the fake render: a read's profile
 * counts and is told to patchd at once; one without its own settings gets the
 * shared ones; ticked, it keeps a copy that changes on its own; a switch
 * puts the other profile's settings on the render (through a short
 * connection while the page is closed, through the page's own while it is
 * open, a display turned on first); Off as a profile's own, the render on
 * neither for it and back on the cluster for another; the HUD map kept shown
 * over BMW's pop-ups as a profile's own, and not told to the render by a
 * patchd before it; unticked, the shared ones back; a
 * tick patchd refuses (another profile in effect) tells the profile again;
 * a read or the head unit's event naming another profile greys the page
 * until patchd has it; the page's load (open, back in focus) shows the
 * stored settings of the profile it reads, after one round trip;
 * no profile (no proxy or field): patchd told none, the checkbox greyed;
 * reads with nothing to go by change nothing; a patchd before profiles: the
 * checkbox greyed, asked again later; patchd not running: asked at the next
 * read. The SessionManager reader: the field's id; none for good without
 * the proxy or the field; a value that is not an id, a read that fails, and
 * a proxy slow to set up or failing to start rejected (nothing changes), the
 * proxy set up again later.
 *
 *   node tools/test_profiles.js
 */
const assert = require('assert');
const fs = require('fs');
const { ProfileSync, sessionReader, IFACE, INSTANCE, FIELD } = require('../src/profile_sync.js');
const { WazeClusterControl, renderCommands } = require('../src/waze_cluster_control.js');
const { FakeRender, FakePatch } = require('./fakes.js');

const RSOCK = `/tmp/woc-sr-${process.pid}.sock`;
const PSOCK = `/tmp/woc-sp-${process.pid}.sock`;
const POLL = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function until(what, check, ms) {
    const deadline = Date.now() + (ms || 2000);
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) resolve();
            else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
            else setTimeout(poll, 10);
        };
        poll();
    });
}
/* keep left out: a patchd before hud_keep_shown */
const settings = (cluster, hud, pct, x, y, keep) => Object.assign({ cluster, hud, hud_width_pct: pct, hud_offset_x: x, hud_offset_y: y },
    keep === undefined ? {} : { hud_keep_shown: keep });

let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
}

/* A fake typed proxy factory: the field's value from value(), or a proxy
 * shaped by opts (no field, a build that fails, a read that fails; the
 * first builds that never answer, inits that never answer or fail). */
function builders(value, opts) {
    const o = opts || {};
    const b = { built: [], reads: 0 };
    b.buildTypedProxy = (iface, instance) => {
        b.built.push(`${iface} ${instance}`);
        if (o.buildFails) return Promise.reject(new Error('no interface configuration'));
        if (b.built.length <= (o.buildHangs || 0)) return new Promise(() => {});
        const slow = b.built.length <= (o.initHangs || 0), fails = b.built.length <= (o.initFails || 0);
        const proxy = { init: () => (slow ? new Promise(() => {}) : fails ? Promise.reject(new Error('not offered')) : Promise.resolve()),
            waitUntilAvailable: () => Promise.resolve() };
        if (!o.noField) {
            proxy[FIELD] = { getValue: () => {
                b.reads++;
                return o.readFails || b.readFails ? Promise.reject(new Error('timeout')) : Promise.resolve(value());
            } };
        }
        if (o.event) {
            /* as the SDK: subscribe registers a handler and resolves to its id, unsubscribe takes the
             * id; the handler registered before a refusal too, the worst an SDK could do */
            b.listeners = new Map();
            b.subscribes = 0;
            b.unsubscribed = [];
            b.send = (v) => [...b.listeners.values()].forEach((cb) => cb(v));
            proxy.currentUserOnChange = {
                subscribe: (cb) => {
                    b.subscribes++;
                    b.listeners.set(b.subscribes, cb);
                    return b.subscribes <= (o.subscribeFails || 0) ? Promise.reject(new Error('not offered yet')) : Promise.resolve(b.subscribes);
                },
                unsubscribe: (sid) => { b.unsubscribed.push(sid); b.listeners.delete(sid); return Promise.resolve(); }
            };
        }
        return Promise.resolve(proxy);
    };
    return b;
}
const quiet = () => {
    const l = { lines: [] };
    l.info = (m) => l.lines.push(`info: ${m}`);
    l.warn = (m) => l.lines.push(`warn: ${m}`);
    return l;
};

async function main() {
    [RSOCK, PSOCK].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* none */ } });
    const render = new FakeRender(RSOCK);
    await render.listen();
    const patch = new FakePatch(PSOCK);
    await patch.listen();
    patch.map = settings(1, 0, 0, 0, 0, 0);

    /* ---- the reader ---- */
    await check('the reader: the field\'s id, read-only through the typed SessionManager proxy', async () => {
        let v = 'a1b2c3d4-0000-4000-8000-000000000001';
        const b = builders(() => v);
        const read = sessionReader(b, quiet());
        assert.strictEqual(await read(), v);
        v = 'de.bmw.infotainment.personalization.UserAccountManager.guest';
        assert.strictEqual(await read(), v);
        v = 'x'.repeat(128);
        assert.strictEqual(await read(), v);
        assert.deepStrictEqual(b.built, [`${IFACE} ${INSTANCE}`], 'one proxy, built once');
    });
    await check('the reader: a value that is not a profile id is no information (rejected), warned once', async () => {
        let v = '';
        const log = quiet();
        const read = sessionReader(builders(() => v), log);
        for (v of ['', 'x'.repeat(129), 'a/b', '../x', '__proto__', 42, null, { value: 'A' }, ['A']]) {
            await assert.rejects(read(), /no profile id read/, JSON.stringify(v));
        }
        assert.strictEqual(log.lines.filter((l) => /^warn: driver profiles/.test(l)).length, 1, log.lines.join('\n'));
    });
    await check('the reader: the event\'s subscription refused, asked again after a backoff, never doubled; again after the service was lost', async () => {
        const b = builders(() => 'driverA', { event: true, subscribeFails: 2 });
        const read = sessionReader(b, quiet(), { retryMs: 60, retryMaxMs: 1000 });
        const got = [];
        read.watch((id) => got.push(id));
        await read();
        await sleep(10);
        assert.strictEqual(b.subscribes, 1, 'asked');
        await read();
        await sleep(10);
        assert.strictEqual(b.subscribes, 1, 'refused: not asked again at once');
        await sleep(70);
        await read();
        await sleep(10);
        assert.strictEqual(b.subscribes, 2, 'asked again after the backoff');
        await sleep(80);
        await read();
        await sleep(10);
        assert.strictEqual(b.subscribes, 2, 'refused again: not asked after the first backoff (60 ms), it doubled');
        await sleep(60);
        await read();
        await sleep(10);
        assert.strictEqual(b.subscribes, 3, 'asked a third time after the doubled backoff (120 ms)');
        assert.strictEqual(b.listeners.size, 3, 'the refusals left their handlers registered');
        b.send('driverB');
        assert.deepStrictEqual(got, ['driverB'], 'each event once all the same');
        await read();
        await sleep(10);
        assert.strictEqual(b.subscribes, 3, 'subscribed: not asked again');
        b.readFails = true;
        await assert.rejects(read());
        b.readFails = false;
        await read();
        await sleep(10);
        assert.strictEqual(b.subscribes, 4, 'the service lost and back: subscribed again');
        assert.deepStrictEqual(b.unsubscribed, [3], 'the subscription before it unsubscribed by its id');
        b.send('driverC');
        assert.deepStrictEqual(got, ['driverB', 'driverC']);
    });
    await check('the reader: the subscription\'s backoff stops doubling at its cap', async () => {
        const b = builders(() => 'driverA', { event: true, subscribeFails: 4 });
        const read = sessionReader(b, quiet(), { retryMs: 100, retryMaxMs: 150 });
        const askAfter = async (ms) => { await sleep(ms); await read(); await sleep(10); return b.subscribes; };
        await read();
        await sleep(10);
        assert.strictEqual(b.subscribes, 1);
        assert.strictEqual(await askAfter(110), 2, 'after 100 ms');
        assert.strictEqual(await askAfter(170), 3, 'after 150 ms, not 200');
        assert.strictEqual(await askAfter(170), 4, 'after 150 ms again, not 300');
    });
    await check('the reader: the head unit\'s currentUserOnChange event, subscribed once a read works, gives each valid id it sends', async () => {
        const b = builders(() => 'driverA', { event: true });
        const read = sessionReader(b, quiet());
        const got = [];
        read.watch((id) => got.push(id));
        assert.strictEqual(await read(), 'driverA');
        await sleep(10);
        assert(typeof b.send === 'function', 'subscribed');
        b.send('driverB');
        b.send({ currentUserAccountReference: 'driverC' });
        b.send('');
        b.send('a/b');
        assert.deepStrictEqual(got, ['driverB', 'driverC'], 'ids only, in order');
    });
    await check('the reader: no proxy, or no field: none for good', async () => {
        for (const opts of [{ buildFails: true }, { noField: true }]) {
            const log = quiet();
            const b = builders(() => 'A', opts);
            const read = sessionReader(b, log);
            assert.strictEqual(await read(), null);
            assert.strictEqual(await read(), null);
            assert.strictEqual(b.built.length, 1, 'not built again');
            assert(log.lines.some((l) => /^warn: driver profiles: .*; the map settings are shared$/.test(l)), log.lines.join('\n'));
        }
    });
    await check('the reader: a read that fails is rejected (nothing changes)', async () => {
        const read = sessionReader(builders(() => 'A', { readFails: true }), quiet());
        await assert.rejects(read());
    });
    await check('the reader: a proxy slow to set up, or failing to start, is rejected and set up again later, with backoff', async () => {
        for (const opts of [{ buildHangs: 2 }, { initHangs: 2 }, { initFails: 2 }]) {
            const b = builders(() => 'driverA', opts);
            const read = sessionReader(b, quiet(), { readMs: 40, retryMs: 200, retryMaxMs: 2000 });
            await assert.rejects(read(), JSON.stringify(opts));
            await assert.rejects(read(), /set up again later/, 'not set up again before the backoff');
            assert.strictEqual(b.built.length, 1);
            await sleep(260);
            await assert.rejects(read(), JSON.stringify(opts));
            assert.strictEqual(b.built.length, 2);
            await sleep(100);
            await assert.rejects(read(), /set up again later/, 'the backoff doubled');
            await sleep(360);
            assert.strictEqual(await read(), 'driverA', `${JSON.stringify(opts)}: set up at the third try`);
            assert.strictEqual(b.built.length, 3);
        }
    });
    await check('the sync with a proxy slow to set up: nothing told meanwhile, then the profile', async () => {
        const told = patch.count('profile');
        const b = builders(() => 'driverS', { initHangs: 1 });
        const s = new ProfileSync({ readProfile: sessionReader(b, quiet(), { readMs: 40, retryMs: 80 }), patchPath: PSOCK, renderPath: RSOCK,
            pollMs: POLL, log: quiet() });
        s.start();
        await sleep(100);
        assert.strictEqual(patch.count('profile'), told, 'nothing told while it is set up');
        assert.strictEqual(s.canChooseOwn(), false);
        await until('told', () => s.profile === 'driverS');
        assert.strictEqual(patch.count('profile'), told + 1);
        s.stop();
    });

    /* ---- the sync, page closed ---- */
    let id = 'driverA';
    let reads = 0;
    const sync = new ProfileSync({ readProfile: () => { reads++; return Promise.resolve(id); }, patchPath: PSOCK, renderPath: RSOCK,
        pollMs: POLL, retryMs: 300, log: quiet() });
    let changes = 0;
    sync.on('change', () => changes++);
    assert.strictEqual(sync.canChooseOwn(), false, 'greyed before patchd has said');
    sync.start();
    await check('the first read\'s profile is told at once; the shared settings, the render left alone', async () => {
        await until('told', () => sync.profile === 'driverA');
        assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'profile' && m.id !== 'driverS'), [{ cmd: 'profile', id: 'driverA' }]);
        assert(reads >= 1, 'read');
        assert.strictEqual(sync.own, false);
        assert(sync.canChooseOwn(), 'the checkbox acts');
        await sleep(POLL * 4);
        assert.strictEqual(patch.received.filter((m) => m.cmd === 'profile' && m.id === 'driverA').length, 1, 'told once while it stays');
        assert.deepStrictEqual(render.received, []);
    });
    await check('a write names the profile and set patchd has in effect, and none until patchd has answered', async () => {
        assert(sync.settled());
        assert.deepStrictEqual(sync.writeTarget(), { profile: 'driverA', own: 0 });
        patch.profileDelayMs = 100;
        const fresh = new ProfileSync({ readProfile: () => Promise.resolve('driverA'), patchPath: PSOCK, renderPath: RSOCK, pollMs: 600000,
            log: quiet() });
        const seen = [];
        fresh.on('change', () => seen.push(fresh.settled()));
        fresh.start();
        await sleep(40);
        assert.strictEqual(fresh._confirmed, 'driverA', 'one read counts');
        assert.strictEqual(fresh.settled(), false, 'patchd has not answered: not settled');
        assert.strictEqual(fresh.writeTarget(), null, 'no write');
        await until('settled', () => fresh.settled());
        assert(seen.indexOf(true) >= 0, 'a change when it settles');
        patch.profileDelayMs = 0;
        fresh.stop();
    });
    await check('ticked: shown ticked at once; own settings, a copy of the ones in effect; nothing moves', async () => {
        const asked = sync.setOwn(true);
        assert.strictEqual(sync.settled(), false, 'while the tick waits for patchd: not settled');
        assert.strictEqual(sync.writeTarget(), null, 'while the tick waits for patchd: no write');
        assert.strictEqual(sync.ownShown(), true, 'ticked as pressed');
        await sync.setOwn(false);
        assert.strictEqual(patch.count('profile-own'), 0, 'a press while one is asked: nothing asked yet');
        await asked;
        assert.strictEqual(sync.own, true);
        assert.deepStrictEqual(patch.received.slice(-1), [{ cmd: 'profile-own', id: 'driverA', on: 1 }]);
        assert.deepStrictEqual(render.received, []);
        await sync.setOwn(true);
        assert.strictEqual(patch.count('profile-own'), 1, 'ticked again: nothing asked');
        assert.deepStrictEqual(sync.writeTarget(), { profile: 'driverA', own: 1 }, 'a write names A\'s own settings');
    });
    /* driver A picks the HUD alone at 60 %, moved left, kept shown over BMW's pop-ups (the page's commands, which patchd saves) */
    patch.map = settings(0, 1, 60, -40, 0, 1);
    id = 'driverB';
    await check('another profile, without its own: the shared settings on the render over a short connection, a display on first', async () => {
        await until('B in effect', () => sync.profile === 'driverB' && sync.own === false);
        await until('render moved', () => render.received.length === 3);
        assert.deepStrictEqual(render.received, [{ cmd: 'cluster', on: '1' }, { cmd: 'hud', on: '0' },
            { cmd: 'hud', hud_width_pct: '0', hud_x: '0', hud_y: '0', hud_keep_shown: '0' }]);
        await until('short connection closed', () => render._clients.size === 0);
    });
    render.received.length = 0;
    id = 'driverA';
    await check('back to A: its own settings on the render, the HUD turned on before the cluster off', async () => {
        await until('A in effect', () => sync.profile === 'driverA' && sync.own === true);
        await until('render moved', () => render.hud === 1 && render.cluster === 0 && render.hudWidth === 60 && render.hudX === -40 &&
            render.hudKeep === 1);
        assert.deepStrictEqual(render.received.map((m) => m.cmd + (m.on || '')), ['hud1', 'cluster0', 'hud']);
    });
    /* driver A picks Off (the page turns the render to neither, patchd saves it as A's own) */
    patch.map = settings(0, 0, 60, -40, 0, 1);
    render.hud = 0;
    render.received.length = 0;
    id = 'driverB';
    await check('Off as A\'s own: another profile without its own gets the shared settings, the map back on the cluster', async () => {
        await until('B in effect', () => sync.profile === 'driverB' && sync.own === false);
        await until('render moved', () => render.cluster === 1 && render.hud === 0 && render.hudWidth === 0 && render.hudKeep === 0);
        assert.deepStrictEqual(render.received.map((m) => m.cmd + (m.on || '')), ['cluster1', 'hud0', 'hud']);
    });
    render.received.length = 0;
    id = 'driverA';
    await check('back to A: Off again, the render on neither, its HUD size and place kept', async () => {
        await until('A in effect', () => sync.profile === 'driverA' && sync.own === true);
        await until('render moved', () => render.cluster === 0 && render.hud === 0 && render.hudWidth === 60 && render.hudX === -40);
        assert.deepStrictEqual(render.received.map((m) => m.cmd + (m.on || '')), ['cluster0', 'hud0', 'hud']);
    });

    await check('a tick patchd refuses (another profile in effect): nothing changed, the profile told again, patchd\'s state shown', async () => {
        patch.current = 'driverB';
        const told = patch.count('profile');
        await sync.setOwn(false);
        await until('told again', () => patch.count('profile') === told + 1);
        await until('state re-read', () => sync.profile === 'driverA' && sync.own === true && sync.ownShown() === true);
        assert.strictEqual(patch.own.driverA !== undefined, true, 'A keeps its own settings');
    });
    await check('reads with nothing to go by: nothing told, the profile in effect stays; two change nothing, the third greys', async () => {
        const told = patch.count('profile');
        const saved = sync._read;
        let failed = 0;
        sync._read = () => { failed++; return Promise.reject(new Error('no profile id read')); };
        await until('two failed reads', () => failed >= 2 && !sync._polling);
        sync._read = () => new Promise(() => {});
        assert(sync.canChooseOwn() && sync.settled() && !sync.unreadable(), 'two: nothing changes');
        sync._read = () => { failed++; return Promise.reject(new Error('no profile id read')); };
        sync.stop();
        sync.start();
        await until('unreadable', () => sync.unreadable());
        assert(!sync.canChooseOwn() && !sync.settled(), 'greyed');
        assert.strictEqual(patch.count('profile'), told, 'nothing told');
        assert.strictEqual(sync.profile, 'driverA', 'the profile in effect stays');
        sync._read = saved;
        await until('back', () => sync.canChooseOwn() && sync.settled());
    });

    await check('a switch: never settled at any change until patchd has the new profile in effect', async () => {
        const seen = [];
        const watch = () => seen.push(`${sync._confirmed}:${sync.settled()}`);
        sync.on('change', watch);
        patch.profileMute = true;
        id = 'driverB';
        await until('B counts', () => sync._confirmed === 'driverB');
        await sleep(POLL * 2);
        assert(seen.length > 0 && seen.every((v) => /:false$/.test(v)), `settled while B is not patchd's: ${seen.join(' ')}`);
        patch.profileMute = false;
        await until('B in effect', () => sync.profile === 'driverB' && sync.settled(), 6000);
        sync.removeListener('change', watch);
        id = 'driverA';
        await until('A again', () => sync.profile === 'driverA' && sync.settled(), 1500);
    });
    await check('a single read naming another profile: greyed at once and told at once; settled on it once patchd answers', async () => {
        assert(sync.canChooseOwn());
        const saved = sync._read;
        patch.profileDelayMs = 150;
        sync._read = () => Promise.resolve('driverB');
        await until('greyed at once', () => !sync.canChooseOwn() && sync._confirmed === 'driverB');
        assert.strictEqual(sync.writeTarget(), null, 'no write until patchd has B');
        const asked = patch.count('profile-own');
        await sync.setOwn(false);
        assert.strictEqual(patch.count('profile-own'), asked, 'a tick meanwhile asks nothing');
        await until('B told and in effect', () => sync.profile === 'driverB' && sync.settled());
        patch.profileDelayMs = 0;
        sync._read = saved;
        await until('A again', () => sync.canChooseOwn() && sync.profile === 'driverA');
    });

    /* ---- with the page open: its own render connection ---- */
    const c = new WazeClusterControl({ renderPath: RSOCK, patchPath: PSOCK, retryMs: 50 });
    await until('short connection gone', () => render._clients.size === 0);
    const sync2 = new ProfileSync({ control: c, readProfile: () => Promise.resolve(id), patchPath: PSOCK, renderPath: `/tmp/woc-nowhere-${process.pid}.sock`,
        pollMs: POLL, log: quiet() });
    sync.stop();
    c.open();
    await until('page connected', () => c.render.connected());
    render.received.length = 0;
    sync2.start();
    await until('A again', () => sync2.profile === 'driverA' && sync2.own === true);
    await check('unticked with the page open: the shared settings through the page\'s render connection', async () => {
        await sync2.setOwn(false);
        assert.strictEqual(sync2.own, false);
        await until('render moved', () => render.cluster === 1 && render.hud === 0 && render.hudWidth === 0);
        assert.strictEqual(render._clients.size, 1, 'only the page\'s connection');
        assert.deepStrictEqual(patch.own, {}, 'no profile with its own settings');
    });

    /* ---- no profile detected ---- */
    render.received.length = 0;
    id = null;
    await check('no profile (no proxy or field, for good): patchd told none, the shared settings, the checkbox greyed', async () => {
        await until('none', () => sync2.profile === null);
        assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'profile').slice(-1), [{ cmd: 'profile', id: null }]);
        assert.strictEqual(sync2.canChooseOwn(), false);
        assert.deepStrictEqual(sync2.writeTarget(), {}, 'no driver with own settings: a write names none');
        patch.own.driverX = Object.assign({}, patch.map);
        patch._broadcast(patch._status());
        await until('own settings said', () => c.ownSettings === true);
        assert.deepStrictEqual(sync2.writeTarget(), { profile: null, own: 0 }, 'own settings in use: a write names no profile, the shared settings');
        delete patch.own.driverX;
        patch._broadcast(patch._status());
        await until('none said', () => c.ownSettings === false);
        const asked = patch.count('profile-own');
        await sync2.setOwn(true);
        assert.strictEqual(patch.count('profile-own'), asked, 'a greyed tick asks nothing');
    });
    await check('an answer patchd gave before a page write, arriving after it: the page\'s change stays on the render', async () => {
        await until('the shared settings on the render', () => render.cluster === 1 && render.hud === 0 && c.shownOn() === 'cluster');
        patch.profileDelayMs = 200;
        /* an answer on its way (as one after patchd reconnected) when the page writes */
        sync2._ask({ cmd: 'profile', id: sync2._confirmed });
        await sleep(50);
        c.showOn('both');
        await until('both on the render', () => render.hud === 1 && c.shownOn() === 'both');
        await sleep(400);
        patch.profileDelayMs = 0;
        assert.strictEqual(render.hud, 1, 'the late answer did not take the HUD off');
        c.showOn('cluster');
        await until('the cluster again', () => render.hud === 0 && c.shownOn() === 'cluster');
    });
    await check('a patchd before hud_keep_shown: the render not told it', async () => {
        assert.deepStrictEqual(renderCommands(settings(1, 0, 0, 0, 0))[2], { cmd: 'hud', hud_width_pct: '0', hud_x: '0', hud_y: '0' });
    });
    sync2.stop();
    c.close();

    /* ---- the page and the profile sync wired as the app wires them, reads
     * only when the test asks (no poll in between) ---- */
    const BOTH = settings(1, 1, 0, 0, 0, 0), CLUSTER = settings(1, 0, 0, 0, 0, 0);
    let who = 'driverG';
    let readFails = false;
    const page = new WazeClusterControl({ renderPath: RSOCK, patchPath: PSOCK, retryMs: 50 });
    const sync5 = new ProfileSync({ control: page, readProfile: () => (readFails ? Promise.reject(new Error('timeout')) : Promise.resolve(who)),
        patchPath: PSOCK, renderPath: RSOCK, pollMs: 600000, replyMs: 200, log: quiet() });
    page.setWriteTarget(() => sync5.writeTarget(), (w) => sync5.confirmWrite(w), () => sync5.loading());
    const mapWrites = () => patch.received.filter((m) => ['cluster', 'hud', 'hud-size', 'hud-pos', 'hud-keep-shown'].includes(m.cmd));
    /* G with its own settings (both), the shared ones both; G in effect */
    const setUp = async () => {
        sync5.stop();
        page.close();
        page.setWriteTarget(() => sync5.writeTarget(), (w) => sync5.confirmWrite(w), () => sync5.loading());
        patch.profileDelayMs = 0;
        patch.saveMs = 0;
        patch.own = { driverG: Object.assign({}, BOTH) };
        patch.shared = Object.assign({}, BOTH);
        patch.active = 'driverG';
        patch.current = 'driverG';
        patch.map = patch.own.driverG;
        Object.assign(render, { cluster: 1, hud: 1, hudWidth: 0, hudX: 0, hudY: 0, hudKeep: 0 });
        who = 'driverG';
        readFails = false;
        page.open();
        await until('page connected', () => page.render.connected() && page.connectedPatch() && page.ownSettings === true);
        sync5.start();
        await until('G settled', () => sync5.settled() && sync5.profile === 'driverG' && page.canChooseShownOn() && page.shownOn() === 'both');
    };
    await setUp();
    await check('a driver switch, then a pick before the next poll: the read before the write finds the new driver; nothing sent, greyed', async () => {
        const writes = mapWrites().length;
        render.received.length = 0;
        who = 'driverB';
        page.showOn('cluster');
        await until('B told', () => sync5.profile === 'driverB');
        await sleep(100);
        assert.strictEqual(mapWrites().length, writes, 'nothing written for G');
        assert.deepStrictEqual(render.received, [], 'nothing to the render');
        assert.strictEqual(page.shownOn(), 'both', 'the pick gone');
        assert.deepStrictEqual([patch.own.driverG, patch.shared], [BOTH, BOTH], 'G\'s and the shared settings unchanged');
        sync5._poll();
        await until('B settled on the shared settings', () => sync5.settled() && sync5.profile === 'driverB' && page.canChooseShownOn());
        page.showOn('cluster');
        await until('saved for B, on the shared settings', () => patch.active === null && patch.map.hud === 0 && render.hud === 0);
        assert.deepStrictEqual(mapWrites().slice(-1), [{ cmd: 'hud', on: 0, profile: 'driverB', own: 0 }]);
        assert.deepStrictEqual(patch.own.driverG, BOTH, 'G\'s own settings unchanged');
    });
    await check('a driver switch, then the page opened (or back in focus): loading, then the new driver\'s stored settings at once', async () => {
        sync5.stop();
        page.close();
        await setUp();
        patch.shared = Object.assign({}, CLUSTER);   /* B's: the shared settings, the cluster alone */
        who = 'driverB';
        patch.profileDelayMs = 150;
        const t0 = Date.now();
        sync5.load();
        assert(sync5.loading() && !page.canChooseShownOn() && sync5.writeTarget() === null && page.shownOn() === null,
            'loading: greyed, no setting shown');
        await until('B\'s stored settings shown and usable', () => sync5.settled() && sync5.profile === 'driverB' && page.shownOn() === 'cluster' &&
            render.hud === 0 && page.canChooseShownOn());
        const ms = Date.now() - t0;
        assert(ms < 1000, `one round trip, not a poll: ${ms} ms`);
        assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'profile').slice(-1), [{ cmd: 'profile', id: 'driverB' }]);
        patch.profileDelayMs = 0;
    });
    await check('the head unit says the driver changed (its event): greyed at once, the new driver told and its settings shown, no poll', async () => {
        sync5.stop();
        page.close();
        let notify = null;
        const read = () => Promise.resolve(who);
        read.watch = (cb) => { notify = cb; };
        const watched = new ProfileSync({ control: page, readProfile: read, patchPath: PSOCK, renderPath: RSOCK, pollMs: 600000, log: quiet() });
        page.setWriteTarget(() => watched.writeTarget(), (w) => watched.confirmWrite(w), () => watched.loading());
        patch.shared = Object.assign({}, CLUSTER);
        patch.own = { driverG: Object.assign({}, BOTH) };
        patch.active = 'driverG';
        patch.current = 'driverG';
        patch.map = patch.own.driverG;
        Object.assign(render, { cluster: 1, hud: 1 });
        who = 'driverG';
        page.open();
        watched.start();
        await until('G settled', () => watched.settled() && page.shownOn() === 'both');
        who = 'driverB';
        patch.profileDelayMs = 100;
        notify('driverB');
        assert(!watched.settled() && watched.writeTarget() === null, 'greyed at once');
        await until('B in effect, its settings on the render', () => watched.settled() && watched.profile === 'driverB' && render.hud === 0 &&
            page.shownOn() === 'cluster');
        patch.profileDelayMs = 0;
        watched.stop();
        page.close();
    });
    await check('a read that began before the head unit\'s event: its older id does not override the event\'s', async () => {
        let notify = null;
        let release = null;
        const read = () => new Promise((resolve) => { release = resolve; });
        read.watch = (cb) => { notify = cb; };
        const late = new ProfileSync({ readProfile: read, patchPath: PSOCK, renderPath: RSOCK, pollMs: 600000, log: quiet() });
        late.start();
        await until('a read on its way', () => release);
        const told = patch.received.filter((m) => m.cmd === 'profile').length;
        notify('driverB');
        await until('B told', () => late.profile === 'driverB');
        release('driverG');
        await sleep(50);
        assert.strictEqual(late._confirmed, 'driverB', 'B stands');
        assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'profile').slice(told), [{ cmd: 'profile', id: 'driverB' }], 'G never told');
        late.stop();
    });
    await check('the page opened while the first read fails: read again at once, not at the poll', async () => {
        let n = 0;
        const flaky = new ProfileSync({ control: page, readProfile: () => (n++ < 2 ? Promise.reject(new Error('timeout')) : Promise.resolve('driverG')),
            patchPath: PSOCK, renderPath: RSOCK, pollMs: 600000, readRetryMs: 50, log: quiet() });
        page.setWriteTarget(() => flaky.writeTarget(), (w) => flaky.confirmWrite(w), () => flaky.loading());
        page.open();
        flaky.start();
        await until('the start\'s read failed', () => n === 1 && !flaky._polling);
        clearTimeout(flaky._timer);
        flaky.load();
        await until('loaded after one retry', () => !flaky.loading() && flaky.settled() && n === 3, 1000);
        flaky.stop();
        page.close();
    });
    await check('a profile that cannot be read: greyed with own settings in use, the line\'s state set; not without', async () => {
        sync5.stop();
        page.close();
        patch.own = { driverG: Object.assign({}, BOTH) };
        patch.current = undefined;
        readFails = true;
        const fresh = new ProfileSync({ control: page, readProfile: () => Promise.reject(new Error('timeout')), patchPath: PSOCK,
            renderPath: RSOCK, pollMs: POLL, log: quiet() });
        page.setWriteTarget(() => fresh.writeTarget(), (w) => fresh.confirmWrite(w));
        page.open();
        fresh.start();
        await until('unreadable', () => fresh.unreadable() && page.ownSettings === true);
        assert.strictEqual(fresh.writeTarget(), null, 'own settings in use: greyed');
        assert(!page.canChooseShownOn(), 'Show on greyed');
        patch.own = {};
        patch._broadcast(patch._status());
        await until('no own settings', () => page.ownSettings === false);
        assert.deepStrictEqual(fresh.writeTarget(), {}, 'no own settings: a write names none');
        await until('Show on acts', () => page.canChooseShownOn());
        fresh.stop();
        page.close();
    });
    await check('a driver profile confirmed, then reads that keep failing: greyed with own settings in use, back once a read comes', async () => {
        sync5.stop();
        page.close();
        await setUp();
        readFails = true;
        for (let i = 0; i < 3; i++) {
            sync5._poll();
            await until('read', () => !sync5._polling);
        }
        assert(sync5.unreadable(), 'unreadable');
        assert.strictEqual(sync5.writeTarget(), null, 'greyed');
        assert(!page.canChooseShownOn() && !sync5.canChooseOwn(), 'Show on and Own greyed');
        readFails = false;
        sync5._poll();
        await until('settled again', () => sync5.settled() && page.canChooseShownOn());
    });
    await check('the first own settings ticked: the page names the profile at once, before patchd\'s next status', async () => {
        sync5.stop();
        page.close();
        await setUp();
        patch.own = {};
        patch.active = null;
        patch._broadcast(patch._status());
        sync5.load();
        await until('no own settings', () => page.ownSettings === false && sync5.settled() && !sync5.own);
        patch.statusDelayMs = 1000;
        await sync5.setOwn(true);
        assert.strictEqual(sync5.own, true, 'ticked');
        assert.strictEqual(page.ownSettings, true, 'own settings known from the reply');
        assert.deepStrictEqual(sync5.writeTarget(), { profile: 'driverG', own: 1 }, 'a write names G\'s own settings');
        patch.statusDelayMs = 0;
        await sleep(1100);
    });
    await check('patchd drops a page load\'s ask (restarting), then is back: the page usable within a round trip, no backoff', async () => {
        sync5.stop();
        page.close();
        await setUp();
        page.close();
        const onConnect = () => sync5.load();   /* as the app does */
        page.patch.on('connect', onConnect);
        patch.profileDrop = true;
        page.open();
        await until('the load\'s ask dropped', () => sync5.loading() && sync5.profile === undefined, 1500);
        patch.profileDrop = false;
        const t0 = Date.now();
        patch.dropClients();   /* patchd back: the page connects again */
        await until('usable', () => sync5.settled() && page.canChooseShownOn() && page.shownOn() === 'both', 1500);
        assert(Date.now() - t0 < 500, `within a round trip: ${Date.now() - t0} ms`);
        page.patch.removeListener('connect', onConnect);
    });
    await check('a load ends only once the render shows the stored settings', async () => {
        sync5.stop();
        page.close();
        await setUp();
        patch.shared = Object.assign({}, CLUSTER);
        who = 'driverB';
        render.statusDelayMs = 150;
        let shownAtEnd;
        const watch = () => { if (shownAtEnd === undefined && !sync5.loading()) shownAtEnd = page.shownOn(); };
        sync5.load();
        sync5.on('change', watch);
        await until('loaded', () => shownAtEnd !== undefined);
        sync5.removeListener('change', watch);
        render.statusDelayMs = 0;
        assert.strictEqual(shownAtEnd, 'cluster', 'B\'s stored settings on the render when the controls act');
    });
    await check('the page\'s render connected after patchd\'s answer: the stored settings put on it then', async () => {
        sync5.stop();
        page.close();
        await setUp();
        page.close();
        await render.close();
        render.cluster = 1;
        render.hud = 1;                      /* the render shows other settings than B's */
        patch.shared = Object.assign({}, CLUSTER);
        patch.own = { driverG: Object.assign({}, BOTH) };
        patch.active = null;                 /* B (on the shared settings) already in effect: unchanged */
        patch.current = 'driverB';
        patch.map = patch.shared;
        who = 'driverB';
        page.open();
        sync5.load();
        await until('B in effect, the render not yet up', () => sync5.profile === 'driverB' && !page.render.connected(), 1500);
        await render.listen();
        await until('B\'s stored settings on the render', () => render.hud === 0 && render.cluster === 1 && page.shownOn() === 'cluster', 2000);
    });
    await check('a page load\'s ask that gets no answer: asked again by the load itself, no backoff', async () => {
        await setUp();
        patch.profileMute = true;
        const asked = patch.count('profile');
        sync5.load();
        await until('the first ask', () => patch.count('profile') > asked);
        patch.profileMute = false;
        await until('the load\'s own retry answered', () => !sync5.loading() && sync5.settled(), 1500);
    });
    await check('a no-answer backoff does not hold up a page load: asked at once', async () => {
        await setUp();
        patch.profileMute = true;
        who = 'driverB';
        sync5._poll();
        await until('no answer, backing off', () => sync5._retryAt > Date.now() + 5000 && sync5.profile === undefined);
        patch.profileMute = false;
        const asked = patch.count('profile');
        sync5.load();
        await until('asked at once and in effect', () => patch.count('profile') > asked && sync5.settled() && sync5.profile === 'driverB', 1000);
    });
    await check('a late profile answer while a write is on its way, the render showing another key too: it ends on patchd\'s stored set', async () => {
        await setUp();
        patch.own = {};
        patch.active = null;
        patch._broadcast(patch._status());
        await until('no own settings', () => page.ownSettings === false);
        page.showOn('cluster');
        await until('the cluster alone, stored', () => render.hud === 0 && patch.map.hud === 0 && page.shownOn() === 'cluster');
        await sleep(100);
        render.hudWidth = 70;   /* a key the render shows and patchd does not have */
        render.announce(render.state, render.reason);
        patch.profileDelayMs = 150;
        patch.saveMs = 400;
        sync5._ask({ cmd: 'profile', id: sync5._confirmed });
        await sleep(30);
        page.showOn('both');
        await until('both on the render', () => render.hud === 1 && page.shownOn() === 'both');
        await until('the stored set on the render', () => render.hudWidth === 0 && render.hud === 1 && render.cluster === 1, 3000);
        assert.deepStrictEqual(patch.map, settings(1, 1, 0, 0, 0, 0));
        patch.profileDelayMs = 0;
        patch.saveMs = 0;
    });
    sync5.stop();
    page.close();

    /* ---- a patchd before profiles; none running ---- */
    patch.profileMute = true;
    const log = quiet();
    const sync3 = new ProfileSync({ readProfile: () => Promise.resolve('driverA'), patchPath: PSOCK, renderPath: RSOCK, pollMs: POLL,
        replyMs: 100, retryMs: 300, retryMaxMs: 1000, log });
    const asks = () => patch.received.filter((m) => m.cmd === 'profile').map((m) => m.at);
    patch.on('command', (m) => { m.at = Date.now(); });
    sync3.start();
    await check('a patchd that takes the connection and does not answer: greyed, asked again after a backoff that doubles, logged once', async () => {
        const from = asks().length;
        await until('four asks', () => asks().length >= from + 4, 6000);
        const at = asks().slice(from);
        /* each ask waits replyMs (100) for its answer; then the backoff: 300, 600, 1000 (the cap) */
        const gaps = [at[1] - at[0], at[2] - at[1], at[3] - at[2]].map((g) => g - 100);
        assert(gaps[0] >= 280 && gaps[0] < 550, `first backoff ~300 ms: ${gaps}`);
        assert(gaps[1] >= 580 && gaps[1] < 900, `doubled ~600 ms: ${gaps}`);
        assert(gaps[2] >= 980 && gaps[2] < 1300, `capped at 1000 ms: ${gaps}`);
        assert.strictEqual(sync3.canChooseOwn(), false);
        assert.strictEqual(log.lines.filter((l) => /patchd did not take profile: no answer/.test(l)).length, 1, 'one warning for the streak');
        patch.profileMute = false;
        await until('asked again and taken', () => sync3.profile === 'driverA', 2500);
        assert(sync3.canChooseOwn());
        assert.strictEqual(sync3._noAnswerMs, 300, 'an answer resets the backoff');
    });
    sync3.stop();
    await patch.close();
    const log4 = quiet();
    const sync4 = new ProfileSync({ readProfile: () => Promise.resolve('driverB'), patchPath: PSOCK, renderPath: RSOCK, pollMs: POLL,
        retryMs: 60000, log: log4 });
    sync4.start();
    await sleep(POLL * 4);
    await check('patchd not running: asked at the next read once it runs, logged once', async () => {
        assert.strictEqual(sync4.profile, undefined);
        assert.strictEqual(log4.lines.filter((l) => /patchd did not take profile: not running/.test(l)).length, 1, 'one warning for the streak');
        const p2 = new FakePatch(PSOCK);
        await p2.listen();
        await until('taken', () => sync4.profile === 'driverB');
        sync4.stop();
        await p2.close();
    });

    await render.close();
    [RSOCK, PSOCK].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* gone */ } });
    console.log(`${passed}/${passed} passed`);
    assert(changes > 0);
}

main().then(() => process.exit(0), (e) => {
    console.log(`FAIL ${e && e.stack}`);
    process.exit(1);
});
