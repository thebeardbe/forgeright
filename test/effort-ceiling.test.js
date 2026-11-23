/**
 * The effort ceiling, and the two doors that must both apply it.
 *
 * M5 bounded each numeric field and stopped the Infinity. It did not stop the absurdity: all three at
 * their own defensible bounds is 1.67e12 h/week, which is FINITE, so round()'s floor never fires.
 * `ai/effort-ceiling.js` bounds the PRODUCT, and one function serves `/api/response` and `/api/score`
 * because the defect being closed is a number getting through one door and not the other.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { maskNonce } from './helpers/mask-nonce.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const SERVER = path.join(PROJECT_ROOT, 'server.js');

const ALLOWED_HOST = 'allowed.example.test';
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-ceiling-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'i'.repeat(64);

const store = await import('../lib/store/index.js');
const {
    checkEffortCeiling, checkEffortCeilings, MAX_MINUTES_PER_INSTANCE, MAX_EFFORT_HOURS_PER_WEEK
} = await import('../ai/effort-ceiling.js');
const { effortHoursPerWeek, aggregate } = await import('../lib/scoring.js');

const org = store.createOrganisation('Ceiling org');
const invitation = store.addInvitation(org.id, { email: 'ceiling@example.test', department: 'Finance' });
const TOKEN = invitation.token;

/** An organisation that has been closed, so the reset route has something to refuse. */
const closedOrg = store.createOrganisation('Ceiling closed org');
const closedInvite = store.addInvitation(closedOrg.id, { email: 'closed-ceiling@example.test', department: 'Ops' });
store.finishOrganisation(closedOrg.id);
const CLOSED_TOKEN = closedInvite.token;

const openInvite = store.addInvitation(org.id, { email: 'open-ceiling@example.test', department: 'Sales' });

// ===========================================================================
// 1. THE TWO NUMBERS, read from the code
// ===========================================================================

test('the two ceilings are what the code says', () => {
    assert.equal(MAX_MINUTES_PER_INSTANCE, 10080, 'a week, in minutes');
    assert.equal(MAX_EFFORT_HOURS_PER_WEEK, 168000000, '1.68e8 h/week');
});

/** A workflow with the given effort factors, all under the per-field bounds. */
const wf = (frequencyPerWeek, minutesPerInstance, peopleAffected) => ({
    id: 'w', title: 'A process', frequencyPerWeek, minutesPerInstance, peopleAffected,
    judgementScore: 5, stepsConsistent: true
});

// --- the per-instance ceiling: below, at, above ---

test('minutesPerInstance: 10079 and 10080 are accepted, 10081 is refused', () => {
    // FREQUENCY 1, not 40, so the consistency rule cannot fire first and this pins the PER-INSTANCE
    // bound on its own. frequencyPerWeek is ONE PERSON's load, so 40 occurrences of a week-long instance
    // is 40 weeks of work in a week, which consumes the ceiling it is meant to be testing beside.
    // At frequency 1, 10080 minutes is exactly one person's whole week: still consistent, still inside
    // the per-instance bound.
    assert.deepEqual(checkEffortCeiling(wf(1, 10079, 1)), { ok: true }, 'one minute under');
    assert.deepEqual(checkEffortCeiling(wf(1, 10080, 1)), { ok: true }, 'exactly at the ceiling');

    const over = checkEffortCeiling(wf(1, 10081, 1));
    assert.equal(over.ok, false, 'one minute over');
    assert.equal(over.limit, MAX_MINUTES_PER_INSTANCE);
    assert.equal(over.actual, 10081);
});

test('100000 minutes for one instance is refused, and the reason says a week', () => {
    // The figure the per-field bound allowed: 9.9 person-weeks for ONE occurrence.
    const problem = checkEffortCeiling(wf(40, 100000, 1));

    assert.equal(problem.ok, false);
    assert.match(problem.reason, /100000 minutes/, 'it names the figure');
    assert.match(problem.reason, /more than a week of work/i, 'and what it exceeds');
    assert.match(problem.reason, /10080/, 'and the ceiling');
});

// --- the effort ceiling: below, at, above ---

test('the effort ceiling is a strict inequality: at it passes, one hour over is refused', () => {
    // TO REACH THE CEILING AT ALL, the record must first survive the consistency rule, which allows at
    // most peopleAffected x 168. So the fixture names 1000000 people: their capacity IS the ceiling, and
    // the effort is built to land exactly on it. This is the only shape in which the ceiling can fire,
    // and it cannot arrive from a participant - peopleAffected is bounded at 100000 on the write path.
    // It is reachable from /api/score, which does not apply the field bounds, which is why the ceiling
    // is kept.
    const PEOPLE = 1_000_000;
    const atCeiling = (MAX_EFFORT_HOURS_PER_WEEK * 60) / PEOPLE;
    assert.deepEqual(checkEffortCeiling(wf(atCeiling, 1, PEOPLE)), { ok: true },
        `exactly ${MAX_EFFORT_HOURS_PER_WEEK} h/week is accepted`);

    const over = checkEffortCeiling(wf(atCeiling + 60, 1, PEOPLE));
    assert.equal(over.ok, false, 'and 60 minutes more is refused');
    assert.equal(over.limit, MAX_EFFORT_HOURS_PER_WEEK);
});

test('all three fields at their per-field bounds is refused, and it is finite', () => {
    // THE ABUSE CASE. Each factor is defensible alone; the multiplication is what is absurd. It is
    // FINITE, so round()'s non-finite floor never fires on it, which is why the ceiling is here.
    const abuse = wf(10000, 100000, 100000);

    assert.equal(Number.isFinite(effortHoursPerWeek(abuse)), true, 'the product is finite');
    assert.ok(effortHoursPerWeek(abuse) > MAX_EFFORT_HOURS_PER_WEEK, 'and far over the ceiling');

    const problem = checkEffortCeiling(abuse);
    assert.equal(problem.ok, false);
    assert.equal(problem.limit, MAX_MINUTES_PER_INSTANCE,
        'the per-instance ceiling catches the absurd factor before the total one is reached');
});

// ===========================================================================
// 1b. THE ACCEPTANCE CASES - what stops a future tightening refusing real work
// ===========================================================================

test('the demo\u2019s largest real product, 44 h/week, is ACCEPTED', () => {
    // MEASURED from a read-only copy of the demo store: the largest raw product across its responses is
    // 44 h/week (40 occurrences of 66 minutes for one person).
    const demoLargest = wf(40, 66, 1);
    assert.equal(effortHoursPerWeek(demoLargest), 44, 'the fixture reproduces the measured figure');

    assert.deepEqual(checkEffortCeiling(demoLargest), { ok: true }, 'and it is accepted');
});

// --- the per-person reading, and the team total that is now refused ---
//
// frequencyPerWeek is ONE PERSON'S LOAD, not the organisation's total. The prompt says so in both
// languages, and the demo confirms it: 40 invoices a week x 22 minutes is 14.7 hours for one person,
// and 44 across three. These two fixtures were first written with the TEAM TOTAL in that field, which
// is why they appeared to be refused by a consistency rule: 100,000 calls a week each, for 200 people,
// is 39.7 weeks of work per person per week. The operation was real; the figure was in the wrong
// reading. Both readings are asserted below, so the difference cannot come back unnoticed.

test('a CALL CENTRE described PER PERSON - 500 calls each, 4 minutes, 200 people - is ACCEPTED', () => {
    // 100,000 calls a week across 200 people is 500 each. At 4 minutes that is 33.3 hours per person per
    // week, and 6,667 hours in total, well inside the 33,600 those 200 people can work.
    const callCentre = wf(500, 4, 200);

    const hours = effortHoursPerWeek(callCentre);
    assert.equal(Math.round(hours * 100) / 100, 6_666.67, 'measured 6,666.67 h/week');
    assert.deepEqual(checkEffortCeiling(callCentre), { ok: true }, 'and it is accepted');
});

test('the SAME CALL CENTRE written as a TEAM TOTAL - 100,000 each - is REFUSED', () => {
    // THE TEST THAT EARNS THE RULE ITS PLACE. This payload is the same operation with the organisation's
    // total in a per-person field. It scores 200 times too high, which is exactly the harm: 1,333,333
    // h/week claimed by 200 people who can work 33,600 between them.
    const teamTotal = wf(100_000, 4, 200);

    const hours = effortHoursPerWeek(teamTotal);
    assert.equal(Math.round(hours * 100) / 100, 1_333_333.33, 'the mis-stated figure, for the record');
    const problem = checkEffortCeiling(teamTotal);
    assert.equal(problem.ok, false, 'refused');
    assert.match(problem.reason, /200 people do this/, 'naming the people');
    assert.match(problem.reason, /1,333,333/, 'and the hours they would have to work');
    assert.match(problem.reason, /33,600/, 'and what those people can actually work');
});

test('a NATIONAL SERVICE described PER PERSON - 0.5 occurrences each, 10 minutes, 20,000 people - is ACCEPTED', () => {
    // 10,000 occurrences a week across 20,000 people is 0.5 each. At 10 minutes that is 5 minutes per
    // person per week, and 1,667 hours in total, far inside the 3,360,000 those people can work.
    const national = wf(0.5, 10, 20_000);

    const hours = effortHoursPerWeek(national);
    assert.equal(Math.round(hours * 100) / 100, 1_666.67, 'measured 1,666.67 h/week');
    assert.deepEqual(checkEffortCeiling(national), { ok: true }, 'and it is accepted');
});

test('the SAME NATIONAL SERVICE written as a TEAM TOTAL - 10,000 each - is REFUSED', () => {
    const teamTotal = wf(10_000, 10, 20_000);
    const problem = checkEffortCeiling(teamTotal);

    assert.equal(problem.ok, false, 'refused');
    assert.match(problem.reason, /20,000 people do this/, 'naming the people');
    assert.match(problem.reason, /33,333,333/, 'and the hours they would have to work');
});

test('the national scenario is well inside the ceiling, not merely under it', () => {
    // Stated as a margin, so a future halving of the ceiling is a visible decision rather than a
    // silent refusal of real work.
    const hours = effortHoursPerWeek(wf(10_000, 10, 20_000));
    assert.ok(MAX_EFFORT_HOURS_PER_WEEK / hours > 5,
        `the ceiling is more than 5x the largest national scenario (measured ${(MAX_EFFORT_HOURS_PER_WEEK / hours).toFixed(1)}x)`);
});

// ===========================================================================
// 2. ONE FUNCTION, TWO DOORS
// ===========================================================================

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

const PORT = await freePort();

function postJson(urlPath, body) {
    const text = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
            headers: {
                host: ALLOWED_HOST, 'x-forwarded-proto': 'https',
                'content-type': 'application/json', 'content-length': Buffer.byteLength(text)
            }
        }, (res) => {
            let out = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: out, headers: res.headers }));
        });
        req.on('error', reject);
        req.write(text);
        req.end();
    });
}

let child;
let childLog = '';
before(async () => {
    child = spawn(process.execPath, [SERVER], {
        env: {
            PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
            PORT: String(PORT), HOST: '127.0.0.1', BASE_PATH: '',
            PUBLIC_BASE_URL: `https://${ALLOWED_HOST}`, TRUST_PROXY: '127.0.0.1',
            ALLOWED_HOST, SESSION_SECRET: 'i'.repeat(64), STORE_DIR,
            AI_PROVIDER: 'mock', MAIL_SENDER: 'console',
            DEMO_LOGIN: '', DEMO_LOGIN_ORG: '', DEMO_LOGIN_TOKEN: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => { childLog += d; });
    child.stderr.on('data', (d) => { childLog += d; });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    host: '127.0.0.1', port: PORT, path: '/healthz',
                    headers: { host: ALLOWED_HOST, 'x-forwarded-proto': 'https' }
                }, (r) => { r.resume(); resolve(r.statusCode); });
                req.on('error', reject);
                req.end();
            });
            if (res === 200) break;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 50));
    }
});

after(async () => {
    if (child) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/** The same unparseable figure posted to both doors. */
const IMPOSSIBLE = wf(40, 100_000, 1);

test('BOTH doors refuse the SAME impossible payload', async () => {
    // The defect being closed is a number getting through one door and not the other, so a test at one
    // door would not cover it.
    const viaResponse = await postJson('/api/response', {
        token: TOKEN, data: { task: 'Entering invoices', ...IMPOSSIBLE }
    });
    const viaScore = await postJson('/api/score', {
        participantToken: TOKEN, audit: { workflows: [IMPOSSIBLE] }
    });

    assert.equal(viaResponse.status, 400, '/api/response refuses it');
    assert.equal(viaScore.status, 400, '/api/score refuses it');
});

test('and both doors NAME THE SAME FIGURE, though they speak to different readers', async () => {
    // The two doors now give DIFFERENT sentences on purpose: /api/response explains the misreading to a
    // participant who has just been refused, and /api/score says a figure is not believable to a caller
    // with no participant behind it. What must not differ is the FACTS, so this pins the figure both
    // carry rather than the wording, which is what it really meant.
    const viaResponse = await postJson('/api/response', {
        token: TOKEN, data: { task: 'Entering invoices', ...IMPOSSIBLE }
    });
    const viaScore = await postJson('/api/score', {
        participantToken: TOKEN, audit: { workflows: [IMPOSSIBLE] }
    });

    const expected = checkEffortCeiling({ ...IMPOSSIBLE, title: 'A process' });
    assert.equal(expected.ok, false);

    const responseBody = JSON.parse(viaResponse.text);
    const scoreBody = JSON.parse(viaScore.text);

    assert.match(responseBody.error, /100,000 minutes/, '/api/response carries the figure');
    assert.match(scoreBody.error, /100000 minutes/, '/api/score carries the same figure');
    assert.match(scoreBody.error, /more than a week of work/i, 'and the same test of it');
    assert.notEqual(responseBody.error, scoreBody.error,
        'but the wording differs: one explains to a person, the other reports to a caller');
});

// ===========================================================================
// 3. /api/score - the door that was fully open
// ===========================================================================

test('/api/score refuses minutesPerInstance 100001 with a 400 naming the process and the figure', async () => {
    // Before this, `validateWorkflows` checked ids and titles and never looked at a number, so a browser
    // client could post this and have it scored. MEASURED then: it returned 133334.67.
    const res = await postJson('/api/score', {
        participantToken: TOKEN,
        audit: { workflows: [{ ...wf(40, 100_001, 1), title: 'Checking the invoice totals' }] }
    });

    assert.equal(res.status, 400, 'refused');
    const body = JSON.parse(res.text);
    assert.match(body.error, /Checking the invoice totals/, 'it names the process');
    assert.match(body.error, /100001/, 'and the figure');
});

test('the figure that used to score 133334.67 is refused rather than scored', async () => {
    // MEASURED: 40 occurrences of 100001 minutes across 2 PEOPLE is 66667.33 effort, which the
    // judgement factor leaves at 133334.67 - the figure the commit message names. The number of people
    // matters, so the fixture states it.
    const wf100001 = wf(40, 100_001, 2);
    const original = console.warn;
    console.warn = () => {};
    let wouldHaveScored;
    try {
        wouldHaveScored = aggregate([wf100001]).scored[0].score;
    } finally {
        console.warn = original;
    }
    assert.equal(wouldHaveScored, 133334.67, 'unscored by any bound it is 133334.67');

    const res = await postJson('/api/score', {
        participantToken: TOKEN, audit: { workflows: [wf100001] }
    });
    assert.equal(res.status, 400, 'and the door now refuses it');
});

test('an HONEST workflow still scores 200 - the control against "refuse everything"', async () => {
    const res = await postJson('/api/score', {
        participantToken: TOKEN,
        audit: {
            workflows: [{
                id: 'honest', title: 'Entering supplier invoices',
                frequencyPerWeek: 40, minutesPerInstance: 15, peopleAffected: 6,
                judgementScore: 5, stepsConsistent: true
            }]
        }
    });

    assert.equal(res.status, 200, 'an ordinary workflow is still scored');
    const body = JSON.parse(res.text);
    assert.equal(body.scored[0].score, 60, 'and at the same figure as before');
});

test('the national-scale workflow is accepted by /api/score too, not only by the checker', async () => {
    // The acceptance case through the real door: a bound that refuses this is a finding. PER PERSON, as
    // the prompt states the field: 10,000 occurrences across 20,000 people is 0.5 each.
    const res = await postJson('/api/score', {
        participantToken: TOKEN,
        audit: { workflows: [{ ...wf(0.5, 10, 20_000), title: 'A national service' }] }
    });

    assert.equal(res.status, 200, 'a national-scale operation is scored');
});

test('the TEAM-TOTAL version of the same workflow is refused by /api/score', async () => {
    // The other half of the pair above, through the same door: the mis-stated payload that would score
    // 20,000 times too high is refused rather than scored.
    const res = await postJson('/api/score', {
        participantToken: TOKEN,
        audit: { workflows: [{ ...wf(10_000, 10, 20_000), title: 'A national service' }] }
    });

    assert.equal(res.status, 400, 'refused');
    assert.match(res.text, /not believable/i, 'and it says a figure is the problem');
});

// ===========================================================================
// 4. THE CLOSED ORGANISATION RESET
// ===========================================================================

function postForm(urlPath, form) {
    const payload = new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
            headers: {
                host: ALLOWED_HOST, 'x-forwarded-proto': 'https',
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let out = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: out, headers: res.headers }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

test('an address in a CLOSED organisation gets NO reset and NO mail', async () => {
    const before = childLog.length;
    const res = await postForm('/lost-link', { email: 'closed-ceiling@example.test' });
    const after = childLog.slice(before);

    assert.equal(res.status, 200, 'the form answers normally, so nothing leaks');
    assert.equal(/reset access/i.test(after), false, 'no reset was logged');
    assert.match(after, /not resetting access for a closed organisation/i,
        'and the reason is logged, so an operator can see it');
});

test('the closed-organisation refusal is BYTE-IDENTICAL to an unknown address', async () => {
    // Nothing may distinguish "invited, but closed" from "never invited", or the form becomes a
    // membership oracle for an organisation that was closed.
    const closed = await postForm('/lost-link', { email: 'closed-ceiling@example.test' });
    const unknown = await postForm('/lost-link', { email: 'never-invited-at-all@example.test' });

    assert.equal(closed.status, unknown.status, 'the same status');
    // THE NONCE DIFFERS PER RESPONSE and says nothing about the address, so it is masked. Every other
    // byte must match, so a difference anywhere else still fails.
    assert.equal(maskNonce(closed.text), maskNonce(unknown.text),
        'and the same body once the per-response nonce is masked');
});

test('the masking does not hide a difference: two DIFFERENT pages stay different', async () => {
    // Proved by reading, not assuming: a closed questionnaire page and the lost-link form are different
    // pages, and masking their nonces must not make them equal.
    const closedPage = await new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: `/q/${CLOSED_TOKEN}`,
            headers: { host: ALLOWED_HOST, 'x-forwarded-proto': 'https' }
        }, (r) => {
            let out = '';
            r.on('data', (c) => { out += c; });
            r.on('end', () => resolve(out));
        });
        req.on('error', reject);
        req.end();
    });
    const lostLink = await postForm('/lost-link', { email: 'closed-ceiling@example.test' });

    assert.equal(closedPage === lostLink.text, false, 'the raw bodies differ');
    assert.notEqual(maskNonce(closedPage), maskNonce(lostLink.text),
        'and still differ once the nonce is masked, so the comparison is not vacuous');
});

test('an address in an OPEN organisation still mints a token and mails a link', async () => {
    // The control: the closed check must not stop a working reset.
    const before = childLog.length;
    const res = await postForm('/lost-link', { email: 'open-ceiling@example.test' });
    const after = childLog.slice(before);

    assert.equal(res.status, 200);
    assert.match(after, /reset access/i, 'a reset was performed');

    // And a real token was minted, which the old one no longer resolves against.
    const invitations = store.listInvitations(org.id);
    const openInv = invitations.find((inv) => inv.email === 'open-ceiling@example.test');
    assert.notEqual(openInv.token, openInvite.token, 'the token was replaced');
});

// ===========================================================================
// 5. THE PARTICIPANT'S SENTENCE
// ===========================================================================

test('the impossible-figures refusal has its own wording, and does not describe a length', async () => {
    // The length wording produces "Use no more than 10080 at most", which tells a participant to shorten
    // an answer that is not long.
    //
    // THE SENTENCE NO LONGER SAYS "cannot be true", and that assertion was WRONG rather than merely
    // out of date: the figures usually CAN be true, and the record is what is wrong. A team total read
    // as a per-person figure refuses a record built from an accurate sentence. So the participant's
    // sentence names the misreading and asks for the one number that would settle it, and this test now
    // pins that it EXPLAINS rather than accuses.
    const res = await postJson('/api/response', {
        token: TOKEN, data: { task: 'Entering invoices', ...IMPOSSIBLE }
    });
    const body = JSON.parse(res.text);

    assert.equal(res.status, 400);
    // IMPOSSIBLE is a per-INSTANCE case (40 occurrences of a 100,000-minute instance), so the participant
    // sentence here is the one about a single occurrence. The consistency case - a team total read as a
    // per-person figure - has its own sentence, asserted in its own test below.
    assert.match(body.error, /100,000 minutes for one occurrence/i, 'it names the figure it worked out');
    assert.match(body.error, /longer than a working week/i, 'and what it exceeds, in words');
    assert.match(body.error, /how long one occasion takes you/i, 'and asks for what would settle it');
    assert.equal(/cannot be true/i.test(body.error), false, 'it does not accuse the participant');
    assert.equal(/no more than/i.test(body.error), false, 'it does not say "no more than"');
    assert.equal(/is too long/i.test(body.error), false, 'nor that the answer is too long');
    assert.equal(/characters/i.test(body.error), false, 'nor talk about characters');
});

test('the CONSISTENCY refusal explains the misreading rather than accusing', async () => {
    // The case the branch exists for: a team total read as a per-person figure. The figures CAN be true,
    // so "cannot be true" was wrong. This sentence names the misreading and asks for the number that
    // would settle it, which is the difference between a record they can argue with and one they cannot.
    const res = await postJson('/api/response', {
        token: TOKEN,
        data: {
            task: 'Handling supplier calls', title: 'Handling supplier calls',
            frequencyPerWeek: 75, minutesPerInstance: 150, peopleAffected: 4
        }
    });
    const body = JSON.parse(res.text);

    assert.equal(res.status, 400);
    assert.match(body.error, /750 hours a week/i, 'it names the figure it worked out');
    assert.match(body.error, /per person/i, 'and names the reading that usually causes it');
    assert.match(body.error, /handle yourself/i, 'and asks for the number that would settle it');
    assert.equal(/cannot be true/i.test(body.error), false, 'it does not accuse the participant');
    assert.equal(/too long/i.test(body.error), false, 'and it is not the length wording');
});

test('the LENGTH refusal does not talk about figures - the two wordings are distinct', async () => {
    // The other direction, so neither sentence has leaked into the other.
    const res = await postJson('/api/response', {
        token: TOKEN, data: { task: 'x'.repeat(4001) }
    });
    const body = JSON.parse(res.text);

    assert.equal(res.status, 400);
    assert.match(body.error, /too long/i, 'the length refusal is about length');
    assert.equal(/cannot be true/i.test(body.error), false, 'and not about figures');
});

test('the impossible-figures message NAMES the process, where the length one names the field', async () => {
    // A participant needs to know which answer to fix. The messages name different things because they
    // are about different things: one is a field, the other is a process's figures.
    const figures = await postJson('/api/response', {
        token: TOKEN,
        data: { task: 'Entering invoices', ...IMPOSSIBLE, title: 'Checking the invoice totals' }
    });
    const length = await postJson('/api/response', {
        token: TOKEN, data: { task: 'x'.repeat(4001) }
    });

    const figuresBody = JSON.parse(figures.text).error;
    const lengthBody = JSON.parse(length.text).error;

    assert.match(figuresBody, /Checking the invoice totals|one process|A process/i,
        'the figures message names the process it is about');
    assert.match(lengthBody, /description of the work/i, 'the length message names the field');
    assert.notEqual(figuresBody, lengthBody, 'and the two are different sentences');
});

// ===========================================================================
// 7. THE DEMO
// ===========================================================================

test('the demo scores are unchanged: 68, 58, 58, 58, 58, 38, 38', () => {
    // Read from a COPY in /tmp, opened read-only. data/demo is never opened for writing.
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-demo-copy-'));
    try {
        fs.cpSync(path.join(PROJECT_ROOT, 'data', 'demo'), copyDir, { recursive: true });
        const db = new DatabaseSync(path.join(copyDir, 'orgs', 'example-ltd-demo.db'), { readOnly: true });
        try {
            const scores = db.prepare('SELECT score FROM process_score WHERE is_current = 1 ORDER BY score DESC')
                .all().map((row) => row.score);
            assert.deepEqual(scores, [68, 58, 58, 58, 58, 38, 38], 'the committed demo scores are unchanged');
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(copyDir, { recursive: true, force: true });
    }
});
