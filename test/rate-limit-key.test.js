/**
 * H5: the rate limiter keyed the IP bucket on `req.socket.remoteAddress`, which behind the owner's
 * Nginx Proxy Manager is NPM's own address for every visitor - one shared bucket for the world.
 *
 * The fix keys on `req.ip`, which is the address Express resolves through the peers `TRUST_PROXY`
 * names. `TRUST_PROXY` cannot be re-implemented from headers: `X-Forwarded-For` is a list whose
 * leftmost entry is whatever the client sent, so a hand-rolled read lets a caller pick their bucket.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import net from 'node:net';

const rateLimit = await import('../lib/auth/rate-limit.js');
const express = (await import('express')).default;

beforeEach(() => {
    rateLimit.resetRateLimits();
});

// ===========================================================================
// A request fixture whose `ip` and socket DISAGREE
// ===========================================================================

/** A request as Express builds it when a trusted proxy is in front: the socket is the proxy. */
function proxiedRequest(clientIp, { socketAddress = '10.0.0.1' } = {}) {
    return { ip: clientIp, socket: { remoteAddress: socketAddress } };
}

/** A request as the unit tests build it: no Express, so `ip` falls back to the socket. */
function bareRequest(address = '10.1.1.1') {
    return { socket: { remoteAddress: address } };
}

// ===========================================================================
// 1. THE REGRESSION - fails on the old key
// ===========================================================================

test('two clients behind a trusted proxy get SEPARATE buckets', () => {
    // The fault: both requests carry the same socket address (the proxy's), and the old code keyed on
    // it, so client B was refused by client A's attempts.
    const clientA = proxiedRequest('203.0.113.10');
    const clientB = proxiedRequest('198.51.100.20');

    for (let i = 1; i <= 10; i += 1) {
        assert.equal(rateLimit.checkLoginRate(clientA, `a${i}@example.test`).allowed, true,
            `client A attempt ${i} is allowed`);
    }

    // Client A has now spent its whole IP budget.
    const aAfter = rateLimit.checkLoginRate(clientA, 'a-final@example.test');
    assert.equal(aAfter.allowed, false, 'client A is now refused');
    assert.equal(aAfter.reason, 'ip');

    // Client B has made no attempt at all, and must be unaffected.
    const firstForB = rateLimit.checkLoginRate(clientB, 'b1@example.test');
    assert.equal(firstForB.allowed, true,
        'client B is NOT locked out by client A: the bucket is per client, not per proxy');
});

test('the same client still gets ONE bucket, so the limit is not simply disabled', () => {
    // The control: separate buckets must not mean no buckets.
    const client = proxiedRequest('203.0.113.10');
    for (let i = 1; i <= 10; i += 1) {
        assert.equal(rateLimit.checkLoginRate(client, `x${i}@example.test`).allowed, true);
    }
    assert.equal(rateLimit.checkLoginRate(client, 'eleventh@example.test').allowed, false);
});

test('the key is req.ip, not the socket, stated directly', () => {
    // Two requests with the SAME socket but different `ip` must not share the IP budget.
    const throughProxyA = proxiedRequest('203.0.113.10', { socketAddress: '127.0.0.1' });
    const throughProxyB = proxiedRequest('198.51.100.20', { socketAddress: '127.0.0.1' });

    for (let i = 1; i <= 10; i += 1) {
        rateLimit.checkLoginRate(throughProxyA, `a${i}@example.test`);
    }
    assert.equal(rateLimit.checkLoginRate(throughProxyA, 'ax@example.test').allowed, false, 'A exhausted');
    assert.equal(rateLimit.checkLoginRate(throughProxyB, 'b1@example.test').allowed, true,
        'B shares the socket but not the bucket');
});

// ===========================================================================
// 2. THE SECURITY PROPERTY - a caller cannot choose its bucket
// ===========================================================================

/**
 * A real HTTP server behind a real Express `trust proxy` setting, so `req.ip` is resolved by Express
 * and not by this test. The connection peer is deterministic: loopback.
 */
async function withTrustedProxy(trustProxy, body) {
    const app = express();
    app.set('trust proxy', trustProxy);
    app.get('/', (req, res) => res.json({ ip: req.ip, socket: req.socket.remoteAddress }));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        return await body(port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function get(port, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('an UNTRUSTED peer cannot choose its bucket by writing X-Forwarded-For', async () => {
    // Asserted THROUGH THE LIMITER, not only on req.ip: a spoofed header must not buy a fresh IP
    // budget. The peer is loopback for every request here, and the header varies.
    const app = express();
    app.set('trust proxy', false);
    // A DIFFERENT email each time, so the email limit (3) cannot refuse before the IP limit (10) does.
    // The header varying is the attack; the email varying is only to isolate the IP bucket.
    app.get('/', (req, res) => {
        const n = String(req.headers['x-forwarded-for'] || '0');
        res.json(rateLimit.checkLoginRate(req, `spoof-${n}@example.test`));
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        const decided = [];
        for (let i = 0; i < 11; i += 1) {
            // A different claimed address on every request, all from the one loopback peer.
            const res = await get(port, { 'x-forwarded-for': `203.0.113.${100 + i}` });
            decided.push(res.json().allowed);
        }

        // Ten IP spends are all allowed; the eleventh is refused DESPITE a fresh header each time.
        assert.deepEqual(decided.slice(0, 10), new Array(10).fill(true),
            'the first ten are allowed');
        assert.equal(decided[10], false,
            'and the eleventh is refused: the varying header bought no extra budget');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('a TRUSTED proxy DOES honour X-Forwarded-For, which is why trust must be narrow', async () => {
    // The other half: with the loopback proxy trusted, the header is believed. This is the setting a
    // deployment needs, and it is why an untrusted peer honouring it would be a fault.
    await withTrustedProxy('loopback', async (port) => {
        const first = await get(port, { 'x-forwarded-for': '203.0.113.10' });
        const second = await get(port, { 'x-forwarded-for': '198.51.100.20' });

        assert.equal(first.json().ip, '203.0.113.10');
        assert.equal(second.json().ip, '198.51.100.20');
        assert.notEqual(first.json().ip, second.json().ip, 'two clients, two buckets');
    });
});

test('the spoof attempt reaches the same rate-limit bucket as no header at all', async () => {
    // The property stated on the LIMITER, not only on req.ip: from an untrusted peer, four requests
    // with four DIFFERENT forwarded addresses must still share one bucket.
    const app = express();
    app.set('trust proxy', false);
    app.get('/', (req, res) => res.json(rateLimit.checkLoginRate(req, 'spoof@example.test')));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        const decided = [];
        for (let i = 0; i < 4; i += 1) {
            // A different claimed address each time, all from the one loopback peer.
            const res = await get(port, { 'x-forwarded-for': `203.0.113.${100 + i}` });
            decided.push(res.json());
        }

        // Four attempts, three allowed by the email limit of 3, the fourth refused.
        assert.deepEqual(decided.map((d) => d.allowed), [true, true, true, false],
            'the four spoofed addresses shared one bucket, so the third-attempt limit applied');
        assert.equal(decided[3].reason, 'email',
            'and it was the EMAIL bucket that refused, which is the one a spoofed IP could have dodged');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

// ===========================================================================
// 3. The sweep
// ===========================================================================

test('the sweep removes a key whose newest attempt is older than the longest window', () => {
    const req = bareRequest('10.2.2.2');
    rateLimit.checkLoginRate(req, 'old@example.test');

    // An hour and a bit later, nothing under the longest window can refuse anything.
    const later = Date.now() + 61 * 60_000;
    const { before, after } = rateLimit.sweepRateLimits(later);

    assert.ok(before >= 1, 'there was something to sweep');
    assert.equal(after, 0, 'every expired key is gone');
});

test('a FRESH key survives an early sweep', () => {
    // The direction that matters: a sweep must not clear a live budget.
    const req = bareRequest('10.3.3.3');
    rateLimit.checkLoginRate(req, 'fresh@example.test');

    const { after } = rateLimit.sweepRateLimits(Date.now() + 1000);
    assert.ok(after > 0, 'a key one second old survives');

    // And it still refuses, so its budget was not reset.
    const client = bareRequest('10.3.3.3');
    for (let i = 0; i < 2; i += 1) rateLimit.checkLoginRate(client, 'fresh@example.test');
    assert.equal(rateLimit.checkLoginRate(client, 'fresh@example.test').allowed, false,
        'the surviving key still counts its earlier attempts');
});

test('the sweep timer is unref()ed, so it cannot hold the process open', () => {
    // A setInterval that keeps the process alive is worse than the leak it fixes: node would never exit.
    const realSetInterval = globalThis.setInterval;
    let captured = null;
    globalThis.setInterval = (fn, ms) => {
        captured = realSetInterval(fn, ms);
        return captured;
    };

    try {
        rateLimit.stopRateLimitSweep();
        rateLimit.startRateLimitSweep();
    } finally {
        globalThis.setInterval = realSetInterval;
    }

    assert.notEqual(captured, null, 'startRateLimitSweep created an interval');
    // A Timer has hasRef(); an unref'd timer reports false.
    assert.equal(typeof captured.hasRef, 'function', 'the handle is a Timer');
    assert.equal(captured.hasRef(), false, 'and it does NOT keep the event loop alive');

    rateLimit.stopRateLimitSweep();
});

test('starting the sweep twice creates only ONE interval', () => {
    // Idempotent, or every call to start would add another timer.
    let created = 0;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (...args) => { created += 1; return realSetInterval(...args); };

    try {
        rateLimit.stopRateLimitSweep();
        rateLimit.startRateLimitSweep();
        rateLimit.startRateLimitSweep();
        rateLimit.startRateLimitSweep();
    } finally {
        globalThis.setInterval = realSetInterval;
        rateLimit.stopRateLimitSweep();
    }

    assert.equal(created, 1, 'the second and third calls reuse the first interval');
});

test('stopRateLimitSweep leaves no timer behind', () => {
    rateLimit.stopRateLimitSweep();
    rateLimit.startRateLimitSweep();
    rateLimit.stopRateLimitSweep();

    // Starting again after a stop is allowed, which shows the state was cleared.
    let created = 0;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (...args) => { created += 1; return realSetInterval(...args); };
    try {
        rateLimit.startRateLimitSweep();
    } finally {
        globalThis.setInterval = realSetInterval;
        rateLimit.stopRateLimitSweep();
    }
    assert.equal(created, 1, 'a stopped sweep can be started again');
});

// ===========================================================================
// 4. The size bound - clearing can only ADMIT, never refuse
// ===========================================================================

test('the size bound warns and clears rather than refusing anything', () => {
    // Over the cap the map is cleared. The direction matters: the next request must be ALLOWED, because
    // clearing a map of timestamps cannot make an attempt more refused than it already was.
    const req = bareRequest('10.4.4.4');
    for (let i = 1; i <= 10; i += 1) rateLimit.checkLoginRate(req, `flood${i}@example.test`);
    assert.equal(rateLimit.checkLoginRate(req, 'flood-x@example.test').allowed, false,
        'the IP budget is spent before the sweep');

    const lines = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { lines.push(args.join(' ')); };
    let swept;
    try {
        // A time past every window empties the map, so size is 0 and the size branch does not fire.
        // Run it at the CURRENT time instead, where the keys are all still live.
        swept = rateLimit.sweepRateLimits(Date.now());
    } finally {
        console.warn = originalWarn;
    }

    assert.ok(swept.before > 0, 'there were keys before the sweep');
    // Nothing was cleared by age, so the request is still refused: age alone did not admit it.
    assert.equal(rateLimit.checkLoginRate(req, 'flood-y@example.test').allowed, false,
        'an age sweep that removes nothing does not admit anything either');
});

test('the size bound WARNS and CLEARS when the map is over the cap after the age sweep', () => {
    // The branch fires only above 100,000 LIVE keys, so this fills the map for real with keys that are
    // all current. Distinct email and IP pairs, so every one is its own key and none is swept by age.
    //
    // It is a memory cost (100,000 short arrays) and worth it: this is the second bound, and a bound
    // tested only by reading it is not tested.
    const startedAt = Date.now();
    for (let i = 0; i < 100_001; i += 1) {
        rateLimit.checkLoginRate({ ip: `198.51.${Math.floor(i / 250)}.${i % 250}`, socket: {} }, `f${i}@example.test`);
    }
    assert.ok(Date.now() - startedAt < 30_000, 'filling the map stays inside a test timeout');

    const lines = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { lines.push(args.join(' ')); };
    let swept;
    try {
        // At the CURRENT time every key is live, so the age sweep removes nothing and only the size
        // branch can act.
        swept = rateLimit.sweepRateLimits(Date.now());
    } finally {
        console.warn = originalWarn;
    }

    assert.ok(swept.before > 100_000, `the map held ${swept.before} keys, over the cap`);
    assert.equal(swept.after, 0, 'and it was cleared');
    assert.equal(lines.length, 1, 'with exactly one warning');
    assert.match(lines[0], /over the 100000 bound: clearing/,
        'naming the size, the bound and the action');

    // THE DIRECTION: clearing can only admit. A request that would have been refused now passes.
    assert.equal(rateLimit.checkLoginRate(bareRequest('203.0.113.7'), 'after-clear@example.test').allowed, true,
        'a cleared map admits the next request rather than refusing it');
});

test('clearing the map ADMITS the next request, which is the safe direction', () => {
    const req = bareRequest('10.5.5.5');
    for (let i = 1; i <= 10; i += 1) rateLimit.checkLoginRate(req, `spend${i}@example.test`);
    assert.equal(rateLimit.checkLoginRate(req, 'spent@example.test').allowed, false);

    rateLimit.resetRateLimits();

    assert.equal(rateLimit.checkLoginRate(req, 'after-clear@example.test').allowed, true,
        'a cleared map can only let a request through, never refuse one');
});

// ===========================================================================
// 5. The email validation
// ===========================================================================

test('a 64KB address creates NO email key, and still spends the IP bucket', () => {
    const req = bareRequest('10.6.6.6');
    const huge = `${'a'.repeat(64 * 1024)}@example.test`;

    assert.equal(rateLimit.isRateLimitableEmail(huge), false, 'a 64KB address is not limitable');

    const first = rateLimit.checkLoginRate(req, huge);
    assert.equal(first.allowed, true, 'the first request is allowed');

    // The IP bucket was spent: nine more (plus the three-email budget being irrelevant) brings it to 10.
    for (let i = 0; i < 9; i += 1) rateLimit.checkLoginRate(req, huge);
    const eleventh = rateLimit.checkLoginRate(req, huge);
    assert.equal(eleventh.allowed, false, 'the 64KB body still counts against the IP bucket');
    assert.equal(eleventh.reason, 'ip', 'and the reason is the IP bucket, not an email one');
});

test('a malformed address creates no email key either', () => {
    for (const bad of ['not-an-address', 'no@dot', '@example.test', 'spaces in @example.test', '']) {
        assert.equal(rateLimit.isRateLimitableEmail(bad), false, `${JSON.stringify(bad)} is not limitable`);
    }
});

test('a malformed address still spends the IP bucket, so the request is still limited', () => {
    const req = bareRequest('10.7.7.7');
    for (let i = 0; i < 10; i += 1) {
        assert.equal(rateLimit.checkLoginRate(req, 'not-an-address').allowed, true, `attempt ${i + 1}`);
    }
    assert.equal(rateLimit.checkLoginRate(req, 'not-an-address').allowed, false,
        'ten attempts exhaust the IP bucket even with an unusable address');
});

test('an EMPTY address does not spend the IP bucket twice, and creates no email key', () => {
    // The bug the builder fixed: an empty address previously recorded `email:<ip>` - because the key
    // fell back to the request's own address - so one blank submission spent the IP budget twice.
    const req = bareRequest('10.8.8.8');

    // Ten requests with an empty address must ALL be allowed: exactly ten IP spends, not twenty.
    for (let i = 1; i <= 10; i += 1) {
        assert.equal(rateLimit.checkLoginRate(req, '').allowed, true,
            `blank attempt ${i} is allowed: one IP spend per request`);
    }
    assert.equal(rateLimit.checkLoginRate(req, '').allowed, false, 'and the eleventh is refused');
});

test('an empty address must not create an email:<ip> key', () => {
    // Asserted through the sweep: after one blank request the map holds the IP key only.
    const req = bareRequest('10.9.9.9');
    rateLimit.checkLoginRate(req, '');

    // A sweep at the current time removes nothing, so the count is the number of keys created.
    const { before } = rateLimit.sweepRateLimits(Date.now());
    assert.equal(before, 1, 'one blank request creates exactly ONE key (the IP), not two');
});

test('a real address creates both keys, so the bug was specifically the blank one', () => {
    const req = bareRequest('10.10.10.10');
    rateLimit.checkLoginRate(req, 'real@example.test');

    const { before } = rateLimit.sweepRateLimits(Date.now());
    assert.equal(before, 2, 'a valid address creates the IP key AND the email key');
});

test('an address of exactly 254 characters is limitable, and 255 is not', () => {
    assert.equal(rateLimit.MAX_EMAIL_CHARS, 254);

    const local = 'a'.repeat(254 - '@example.test'.length);
    const atLimit = `${local}@example.test`;
    assert.equal(atLimit.length, 254);
    assert.equal(rateLimit.isRateLimitableEmail(atLimit), true, 'exactly 254 is limitable');

    const over = `a${local}@example.test`;
    assert.equal(over.length, 255);
    assert.equal(rateLimit.isRateLimitableEmail(over), false, '255 is not');
});

// ===========================================================================
// 6. The startup sentence
// ===========================================================================

test('with TRUST_PROXY unset the sentence says what breaks, not merely that something is off', () => {
    const sentence = rateLimit.describeAddressSource({ setting: false, summary: 'none' });

    assert.match(sentence, /TRUST_PROXY is unset/i, 'it names the setting');
    assert.match(sentence, /every visitor shares that one address/i,
        'and says the consequence: every visitor shares one address');
    assert.match(sentence, /one bucket/i, 'and one bucket');
    assert.match(sentence, /set TRUST_PROXY/i, 'with the thing to do');
});

test('with TRUST_PROXY set the sentence says each visitor gets their own bucket', () => {
    const sentence = rateLimit.describeAddressSource({ setting: 'loopback', summary: 'loopback only' });

    assert.match(sentence, /client address Express resolves/i, 'it names how the address is found');
    assert.match(sentence, /their own bucket/i, 'and that it is per visitor');
    assert.equal(/TRUST_PROXY is unset/i.test(sentence), false, 'without the warning');
});

test('a null or undefined setting is treated as unset', () => {
    for (const setting of [null, undefined, false]) {
        assert.match(rateLimit.describeAddressSource({ setting, summary: 'x' }), /TRUST_PROXY is unset/i);
    }
});

// ===========================================================================
// 7. The limits are unchanged
// ===========================================================================

test('the login limits are still 3 per email and 10 per IP over 15 minutes', () => {
    // Pinned WITHOUT adding a key: test/auth.test.js:423 deepEquals this object.
    assert.deepEqual(rateLimit.LIMITS, {
        email: { max: 3, windowMinutes: 15 },
        ip: { max: 10, windowMinutes: 15 }
    });
    assert.equal(Object.keys(rateLimit.LIMITS).length, 2, 'exactly two keys, so the deepEqual there holds');
});

test('the chat limit is still 60 turns per hour', () => {
    assert.deepEqual(rateLimit.CHAT_LIMITS, { max: 60, windowMinutes: 60 });
});

test('three attempts per email and the fourth refused', () => {
    const req = bareRequest('10.11.11.11');
    for (let i = 1; i <= 3; i += 1) {
        assert.equal(rateLimit.checkLoginRate(req, 'three@example.test').allowed, true, `attempt ${i}`);
    }
    const refused = rateLimit.checkLoginRate(req, 'three@example.test');
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, 'email');
    assert.equal(refused.retryAfterSeconds, 900, '15 minutes');
});

test('the chat budget is per token and refuses the sixty-first', () => {
    for (let i = 0; i < 60; i += 1) {
        assert.equal(rateLimit.checkChatRate('a-token').allowed, true, `turn ${i + 1}`);
    }
    const refused = rateLimit.checkChatRate('a-token');
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterSeconds, 3600);

    assert.equal(rateLimit.checkChatRate('another-token').allowed, true, 'a different token is unaffected');
});
