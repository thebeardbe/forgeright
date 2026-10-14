/**
 * Builds a demo organisation from the illustrative fixture, through the real pipeline.
 *
 * IT USES THE REAL CODE: it registers an organisation in a SEPARATE store, inserts the fixture's
 * responses with real invitations, then runs identification and weighing for real. NOTHING IS
 * PRE-BAKED into the database.
 *
 * THE DATA IS ILLUSTRATIVE and comes from `ai/fixtures/mock-audit.js`, which says so itself. It is
 * deliberately imperfect in ways worth keeping in a demo: two fixture processes describe the SAME
 * work with very different time estimates, so the pipeline has a real disagreement to surface, and
 * another is judgement-heavy and should score low despite high effort.
 *
 * RUN IT WITH A REAL PROVIDER, and it costs real calls:
 *
 *     AI_PROVIDER=deepseek STORE_DIR=data/demo node scripts/seed-demo-org.js
 *
 * `STORE_DIR` IS REQUIRED AND MAY NOT BE THE DEFAULT STORE: this script DELETES an organisation to
 * make itself re-runnable, and the default store is where real data lives. It also sidesteps the
 * pre-v6 files in `data/store/orgs/`, which this code refuses by design. `data/demo` is the
 * COMMITTABLE location - `data/store/orgs/` is gitignored wholesale because it holds live data -
 * and the result is meant to be committed so the demo travels with the repository.
 *
 * THE COST IS PRINTED BEFORE ANY CALL, so it is known rather than discovered: one identification per
 * response, plus at most one weighing per resulting process, since responses describing the same
 * work merge.
 *
 * RE-RUNNABLE MEANS IT DELETES: it matches its own organisation by name and removes it through
 * `orgDbPath`, which refuses an id resolving outside the store directory.
 *
 * FAILURE IS LOUD AND PARTIAL WORK IS NAMED. A missing key, an unreachable provider or a refused
 * call stops the run with the reason, the organisation id and what was completed, so a half-built
 * organisation is never mistaken for a working one.
 *
 * `AI_PROVIDER=mock` CANNOT SEED ANYTHING: the mock answers every call with the next scripted
 * interview question, so identification and weighing cannot work under it. That is the mock doing
 * its job, and both the startup and per-reply checks say so rather than letting it read as a broken
 * demo. `scripts/check-weighing-order.js` handles it the same way.
 *
 * THE READ-ONLY DEMO LINK IS CONFIGURED ELSEWHERE - see the DEMO_LOGIN block in .env.example, where
 * each variable and its reasoning lives. A deployment serving the committed database needs NO
 * provider and no API key, because the processes are already grouped and scored.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

// THE STORE IS CHOSEN BEFORE ANY STORE MODULE IS IMPORTED, because the store resolves
// its directories once and caches them. Importing first would bind this run to the real
// data directory, which is the one thing the demo must never touch.
const DEMO_STORE = (process.env.STORE_DIR || '').trim();
const DEFAULT_STORE = path.join(process.cwd(), 'data', 'store');

if (DEMO_STORE === '') {
    console.error(
        '[seed] STORE_DIR is not set. It is required rather than defaulted: this script\n' +
        '       DELETES and rebuilds an organisation, and it must never do that to the\n' +
        '       real store. Run it as:\n\n' +
        '         AI_PROVIDER=deepseek STORE_DIR=data/demo node scripts/seed-demo-org.js\n'
    );
    process.exit(2);
}
if (path.resolve(DEMO_STORE) === path.resolve(DEFAULT_STORE)) {
    console.error(
        `[seed] STORE_DIR resolves to the DEFAULT store (${DEFAULT_STORE}).\n` +
        '       Refusing: this script deletes an organisation, and that is where real\n' +
        '       data lives. Point STORE_DIR somewhere else, for example data/demo.'
    );
    process.exit(2);
}

const {
    createOrganisation, getOrganisation, addInvitation, addResponse, listOrganisationIds,
    closeAll, closeConnection
} = await import('../lib/store/index.js');
const { orgDbPath, storeDir } = await import('../lib/store/paths.js');
const { listProcessesForConsole, recordIdentification } = await import('../lib/store/processes.js');
const { addUserToOrganisation, ROLES } = await import('../lib/users.js');
const { listRoadmap, recordWeighing } = await import('../lib/store/weighing.js');
const { runIdentification } = await import('../ai/identify-core.js');
const { runWeighing } = await import('../ai/weigh-core.js');
const { buildMockAudit } = await import('../ai/fixtures/mock-audit.js');
// The fixture's transformation and the demo's identity, in their own module: see
// ./demo-fixture.js for the pinned org id, the name, and why the admin address must
// differ from the demo viewer's.
const {
    DEMO_ORG_ID, ORG_NAME, DEMO_ADMIN_EMAIL, DEMO_NAME_MARKERS,
    departmentFor, responseDataFor, demoEmailFor, synthesiseTranscript
} = await import('./demo-fixture.js');
const { loadAiConfig } = await import('../ai/config.js');

/** The name of an organisation, or null when it cannot be read. */
function nameOf(orgId) {
    try {
        return getOrganisation(orgId)?.name ?? null;
    } catch (err) {
        // A file this code refuses, or a corrupt one. Reported, because a silent null
        // here would mean a demo left behind that a re-run cannot find.
        console.warn(`[seed] could not read organisation ${orgId}: ${err.message}`);
        return null;
    }
}

/**
 * Removes every previous demo organisation from the demo store.
 *
 * @returns {string[]} The ids removed.
 */
function removePreviousDemos() {
    const removed = [];
    for (const orgId of listOrganisationIds()) {
        const name = nameOf(orgId);
        if (name && DEMO_NAME_MARKERS.every((marker) => name.includes(marker))) {
            removeOrganisationFiles(orgId);
            removed.push(orgId);
        }
    }
    return removed;
}

/**
 * Deletes one organisation's files.
 *
 * THROUGH `orgDbPath`, so the path is checked to be inside the store before anything is
 * removed: a deletion resolving elsewhere would be the worst bug this script could have.
 * The WAL and SHM sidecars go with it, or a later run finds a database that only looks present.
 */
function removeOrganisationFiles(orgId) {
    // CLOSE FIRST, OR THE DELETION IS INVISIBLE TO THIS PROCESS. A re-run failed with
    // "organisation already exists": the files were unlinked but the OPEN CONNECTION
    // still held the row, so `createOrganisation` read what had just been removed. The
    // store caches connections per organisation and a deleted file does not invalidate
    // that. Closing also checkpoints the WAL, so the removal is complete.
    closeConnection(orgId);

    const target = orgDbPath(orgId);
    for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(target + suffix)) {
            fs.rmSync(target + suffix);
            console.log(`[seed] removed ${path.basename(target + suffix)}`);
        }
    }
}

/** Prints the cost before spending it, so the owner knows what the run will do. */
function announceCost(responseCount) {
    console.log('[seed] this run makes REAL provider calls:');
    console.log(`[seed]   ${responseCount} identification call(s), one per response`);
    console.log(`[seed]   UP TO ${responseCount} weighing call(s), one per process that results`);
    console.log(`[seed]   so at most ${responseCount * 2} calls. Fewer weighings is the usual`);
    console.log('[seed]   case: responses describing the same work merge into one process,');
    console.log('[seed]   and a process is weighed once.');
    console.log();
}

/** Stops the run, naming what was written, so partial work is recognised as partial. */
function failLoudly(step, err, orgId, completed) {
    console.error();
    console.error(`[seed] FAILED during ${step}: ${err.message}`);
    console.error(`[seed] organisation:  ${orgId ?? '(none created)'}`);
    console.error(`[seed] completed:     ${completed}`);
    console.error('[seed] THE ORGANISATION IS PARTIAL. Do not demo it as if it were');
    console.error('[seed] complete. Reset it by re-running the same command: the script');
    console.error('[seed] removes a previous demo before it builds one.');
    process.exit(1);
}

/**
 * A reply that is not a result is usually the MOCK, named rather than reported as a
 * pipeline failure. The same handling as `scripts/check-weighing-order.js`.
 */
function assertNotMock(reply, what) {
    // ONLY the mock's interview shape is caught here: `status: 'asking'`. A genuine
    // error or refusal is left to the caller, which reports it as a pipeline failure
    // with its own reason, because those are two different problems.
    if (reply && reply.status === 'asking') {
        console.error(
            `[seed] ${what} came back as an INTERVIEW reply, not a result. AI_PROVIDER is\n` +
            `       "${loadAiConfig().name}", and the mock provider answers every call with the\n` +
            '       next scripted interview question, so it cannot identify or weigh anything.\n' +
            '       This is the mock doing its job. Re-run with a real provider.'
        );
        process.exit(1);
    }
}

async function main() {
    const config = loadAiConfig();
    console.log(`[seed] store:     ${storeDir()}`);
    console.log(`[seed] provider:  ${config.name} (${config.type})`);
    console.log(`[seed] org:       ${ORG_NAME}`);
    console.log();

    if (config.type === 'mock') {
        console.error(
            '[seed] AI_PROVIDER is "mock". The mock simulates the INTERVIEW, so it answers\n' +
            '       every identification and weighing call with the next scripted question.\n' +
            '       The pipeline cannot run under it. That is the mock working, not a fault\n' +
            '       in this script or the store. Set AI_PROVIDER to a real provider:\n\n' +
            '         AI_PROVIDER=deepseek STORE_DIR=... node scripts/seed-demo-org.js\n'
        );
        process.exit(2);
    }

    const audit = buildMockAudit('en');
    const responses = audit.workflows;
    announceCost(responses.length);

    // THE PREVIOUS DEMO GOES FIRST, so a re-run resets rather than appends. After the
    // cost announcement, so reading the price costs nothing.
    const removed = removePreviousDemos();
    if (removed.length > 0) console.log(`[seed] removed ${removed.length} previous demo organisation(s)`);

    const orgId = createOrganisation(ORG_NAME, DEMO_ORG_ID).id;
    console.log(`[seed] created organisation ${orgId}`);

    // THE ADMIN, WITHOUT WHICH THE CONSOLE CANNOT SEE THIS ORGANISATION. Signing in
    // with any other address creates a separate, empty organisation instead.
    addUserToOrganisation({ organisationId: orgId, email: DEMO_ADMIN_EMAIL, role: ROLES.ADMIN });
    console.log(`[seed] admin attached: ${DEMO_ADMIN_EMAIL}`);
    console.log();

    let identifications = 0;
    let weighings = 0;
    const progress = () => `${identifications} identification(s), ${weighings} weighing(s)`;

    for (const workflow of responses) {
        const department = departmentFor(workflow);
        const invitation = addInvitation(orgId, { email: demoEmailFor(workflow.id), department });
        const data = responseDataFor(workflow);

        // Synthesised, not captured: see `synthesiseTranscript` in ./demo-fixture.js.
        // Without it the response stores null and the answers view shows no conversation.
        const transcript = synthesiseTranscript(workflow);
        const response = addResponse(orgId, invitation.token, { department, data, transcript });

        // THE REAL IDENTIFICATION PATH. `recordIdentification` defaults to DECIDED_BY.MODEL,
        // which is what a first pass is - and what a LIVE interview now gets too, since
        // lib/auth/identify-response.js calls this with no decidedBy. The rejudge route would
        // mark every revision as an admin correction AND require an admin's argument, and a demo
        // should show the ordinary result rather than a console full of regroupings.
        const known = listProcessesForConsole(orgId).map((process) => ({
            id: process.id,
            name: process.name,
            reasoning: process.current?.reasoning ?? null
        }));

        let reply;
        try {
            reply = await runIdentification({ response: { id: response.id, data }, knownProcesses: known, lang: 'en' });
            assertNotMock(reply, `the identification of ${workflow.id}`);
            if (reply.status === 'error' || reply.status === 'rejected') {
                throw new Error(reply.reason ?? reply.content ?? reply.status);
            }
            recordIdentification({ orgId, responseId: response.id, reply });
            identifications += 1;
        } catch (err) {
            failLoudly(`the identification of ${workflow.id}`, err, orgId, progress());
        }
        console.log(`[seed] identified ${workflow.id.padEnd(24)} -> ${reply.matches ? 'joined a process' : 'a new process'}`);
    }

    console.log();
    const processes = listRoadmap(orgId);
    console.log(`[seed] ${processes.length} process(es) to weigh`);
    for (const entry of processes) {
        if (!entry.grouping) {
            console.warn(`[seed] skipping ${entry.name}: no current grouping, which is a data fault`);
            continue;
        }
        let reply;
        try {
            reply = await runWeighing({ process: { id: entry.id, name: entry.name }, grouping: entry.grouping, lang: 'en' });
            assertNotMock(reply, `the weighing of ${entry.name}`);
            if (reply.status === 'error' || reply.status === 'rejected') {
                throw new Error(reply.reason ?? reply.content ?? reply.status);
            }
            recordWeighing({ orgId, processId: entry.id, reply });
            weighings += 1;
        } catch (err) {
            failLoudly(`the weighing of ${entry.name}`, err, orgId, progress());
        }
        const stored = listRoadmap(orgId).find((process) => process.id === entry.id);
        console.log(`[seed] weighed    ${entry.name.slice(0, 44).padEnd(46)} ${stored?.score?.value ?? '(no score)'}`);
    }

    report(orgId, responses.length, identifications, weighings);
}

/** What the run produced, and where to look at it. */
function report(orgId, responseCount, identifications, weighings) {
    const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const roadmap = listRoadmap(orgId);

    console.log();
    console.log('[seed] DONE');
    console.log(`[seed]   store:          ${storeDir()}`);
    console.log(`[seed]   organisation:   ${orgId}`);
    console.log(`[seed]   responses:      ${responseCount} (${identifications} identified)`);
    console.log(`[seed]   processes:      ${roadmap.length}`);
    console.log(`[seed]   weighings:      ${weighings}`);
    console.log(`[seed]   provider calls: ${identifications + weighings}`);
    console.log();
    console.log('[seed] the roadmap, highest score first:');
    for (const [index, entry] of roadmap.entries()) {
        const score = entry.score ? String(entry.score.value).padStart(4) : '  --';
        const people = entry.grouping ? entry.grouping.responses.length : 0;
        console.log(`[seed]   ${String(index + 1).padStart(2)}. ${score}  ${entry.name.slice(0, 48).padEnd(50)} ${people} response(s)`);
    }
    console.log();
    console.log('[seed] WHERE TO LOOK');
    console.log(`[seed]   console:  ${base}/admin`);
    console.log(`[seed]             sign in as ${DEMO_ADMIN_EMAIL}`);
    console.log('[seed]             ANY OTHER ADDRESS GETS A NEW, EMPTY ORGANISATION: the');
    console.log('[seed]             console resolves the organisation from the signed-in email.');
    console.log(`[seed]   roadmap:  ${base}/admin/roadmap`);
    console.log(`[seed]   answers:  ${base}/admin/answers`);
    console.log('[seed]   Participant links are NOT printed: an invitation token is a');
    console.log('[seed]   credential and the store keeps only its hash, so it cannot be read');
    console.log('[seed]   back. Invite yourself from the console to walk the participant half.');
}

/**
 * Closes every connection, which CHECKPOINTS THE WAL INTO THE DATABASE FILE.
 *
 * THIS IS WHAT MAKES THE FILE COMMITTABLE. The store runs in WAL mode, so while a connection is
 * open the recent writes live in a `-wal` sidecar. Committing the `.db` without it ships a database
 * missing its last writes, and committing both ships two files that must be restored together - a
 * corruption waiting for whoever copies one. Closing folds the WAL back in and removes the
 * sidecars, leaving one self-contained file.
 *
 * RUN WHETHER THE SEED SUCCEEDED OR FAILED: a partial organisation is still worth checkpointing,
 * and a half-written file with a stale WAL is worse than either. The consequence for git is that
 * `data/demo/orgs/` holds exactly one `.db`; the ignore rules for the sidecars exist in case a run
 * is interrupted.
 */
await main();

// AFTER the work, not before: this is the checkpoint.
try {
    const closed = closeAll();
    console.log(`[seed] checkpointed and closed ${closed} store connection(s)`);
} catch (err) {
    console.error(`[seed] could not close the store cleanly: ${err.message}`);
    console.error('[seed] the -wal sidecar may still hold writes; do NOT commit the file yet.');
    process.exit(1);
}
