/**
 * Tests for lib/token-index.js: which organisation a participant token belongs to.
 *
 * This is the ROUTING FACT that decides which tenant a participant's link opens.
 * A mutation that returns the wrong organisation here produced a fully green suite
 * (489 tests) with every participant routed to the wrong tenant, because a second
 * layer in resolveParticipant happened to catch it. That mitigation is exactly
 * what a later refactor removes, so the property is pinned here directly.
 *
 * STORE_DIR is set to a temp directory per run, before anything is imported, so
 * data/store/ is never touched.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-tokenindex-test-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const tokenIndex = await import('../lib/token-index.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/** An organisation with one invited participant. */
function orgWithInvitation(name, email, department) {
    const org = store.createOrganisation(name);
    const invitation = store.addInvitation(org.id, { email, department });
    return { org, invitation };
}

// ===========================================================================
// 1. THE TOKEN INDEX RESOLVES A TOKEN TO ITS OWN ORGANISATION
// ===========================================================================

test('a token resolves to its own organisation and invitation', () => {
    const a = orgWithInvitation('Org A', 'a@orga.example', 'Finance');

    const route = tokenIndex.routeForParticipantToken(a.invitation.token);

    assert.equal(route.organisationId, a.org.id, 'the token resolves to its own organisation');
    assert.equal(route.invitationId, a.invitation.id, 'and to its own invitation id');
});

test('two organisations: each token resolves to its OWN organisation, never the other', () => {
    // The property the mutation broke: routeForParticipantToken returning a
    // different organisation for every token. Both directions are asserted,
    // because a swap would satisfy one and fail the other.
    const a = orgWithInvitation('Org A', 'a@orga.example', 'Finance');
    const b = orgWithInvitation('Org B', 'b@orgb.example', 'Ops');

    const routeA = tokenIndex.routeForParticipantToken(a.invitation.token);
    const routeB = tokenIndex.routeForParticipantToken(b.invitation.token);

    assert.equal(routeA.organisationId, a.org.id);
    assert.equal(routeA.invitationId, a.invitation.id);
    assert.equal(routeB.organisationId, b.org.id);
    assert.equal(routeB.invitationId, b.invitation.id);

    assert.notEqual(routeA.organisationId, b.org.id, "A's token must not name B");
    assert.notEqual(routeB.organisationId, a.org.id, "B's token must not name A");
});

test('a token cannot be induced to resolve elsewhere by a lookalike value', () => {
    // Near-misses that must not resolve to A: the raw token against a different
    // case, a truncated form, and a value that hashes differently.
    const a = orgWithInvitation('Org A', 'a@orga.example', 'Finance');

    for (const bad of [
        a.invitation.token.slice(0, -1),
        `${a.invitation.token}x`,
        a.invitation.token.toUpperCase(),
        a.invitation.token.toLowerCase(),
        'not-a-token-at-all'
    ]) {
        const route = tokenIndex.routeForParticipantToken(bad);
        assert.equal(route, null, `a lookalike must not resolve: ${JSON.stringify(bad)}`);
    }
});

test('an unknown or malformed token resolves to nothing, and does not throw', () => {
    orgWithInvitation('Org A', 'a@orga.example', 'Finance');

    for (const bad of ['no-such-token', '', null, undefined, 42, {}, []]) {
        assert.equal(
            tokenIndex.routeForParticipantToken(bad),
            null,
            `token ${JSON.stringify(bad)} must resolve to nothing`
        );
    }
});

test('a forgotten token stops resolving', () => {
    const a = orgWithInvitation('Org A', 'a@orga.example', 'Finance');
    const hash = store.hashToken(a.invitation.token);

    assert.notEqual(tokenIndex.routeForParticipantToken(a.invitation.token), null, 'resolves before forgetting');

    assert.equal(tokenIndex.forgetParticipantToken(hash), true, 'the row was removed');
    assert.equal(tokenIndex.routeForParticipantToken(a.invitation.token), null, 'it resolves to nothing after');

    // Forgetting again is a no-op, not an error.
    assert.equal(tokenIndex.forgetParticipantToken(hash), false);
});

test('a reset removes every indexed token for an invitation', () => {
    const a = orgWithInvitation('Org A', 'a@orga.example', 'Finance');
    const extra = store.issueAdditionalLink(a.org.id, a.invitation.id);

    // Both tokens route to A before the reset.
    assert.notEqual(tokenIndex.routeForParticipantToken(a.invitation.token), null);
    assert.notEqual(tokenIndex.routeForParticipantToken(extra), null);

    const replacement = store.resetAccess(a.org.id, a.invitation.id);

    assert.equal(tokenIndex.routeForParticipantToken(a.invitation.token), null, 'the first token is unrouted');
    assert.equal(tokenIndex.routeForParticipantToken(extra), null, 'the second token is unrouted');
    assert.equal(
        tokenIndex.routeForParticipantToken(replacement).organisationId,
        a.org.id,
        'the replacement routes to the same organisation'
    );
});

test('tokenHashesForOrganisation lists only that organisation\'s hashes', () => {
    const a = orgWithInvitation('Org A', 'a@orga.example', 'Finance');
    const b = orgWithInvitation('Org B', 'b@orgb.example', 'Ops');

    const hashesA = tokenIndex.tokenHashesForOrganisation(a.org.id);
    const hashesB = tokenIndex.tokenHashesForOrganisation(b.org.id);

    assert.ok(hashesA.includes(store.hashToken(a.invitation.token)));
    assert.equal(hashesA.includes(store.hashToken(b.invitation.token)), false, "B's hash must not appear under A");
    assert.ok(hashesB.includes(store.hashToken(b.invitation.token)));
    assert.equal(hashesB.includes(store.hashToken(a.invitation.token)), false, "A's hash must not appear under B");
});

test('the index stores a hash, never the raw token', () => {
    const a = orgWithInvitation('Org A', 'a@orga.example', 'Finance');

    const hashes = tokenIndex.tokenHashesForOrganisation(a.org.id);
    assert.equal(hashes.includes(a.invitation.token), false, 'the raw token must not be an index key');
    assert.ok(hashes.includes(store.hashToken(a.invitation.token)), 'the hash is the key');
});

test('indexParticipantToken refuses a missing hash, organisation or invitation', () => {
    assert.throws(() => tokenIndex.indexParticipantToken('', 'org', 'inv'), /token hash/);
    assert.throws(() => tokenIndex.indexParticipantToken(null, 'org', 'inv'), /token hash/);
    assert.throws(() => tokenIndex.indexParticipantToken('h', '', 'inv'), /organisation id/);
    assert.throws(() => tokenIndex.indexParticipantToken('h', 'org', ''), /invitation id/);
});
