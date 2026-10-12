/**
 * Builds a demo organisation from the illustrative fixture, through the real pipeline.
 *
 * WHAT IT IS FOR. The owner asked for "an organisation with mock data so we can have a
 * demo version running". This script builds one: it registers a real organisation in a
 * SEPARATE store, inserts the fixture's responses with real invitations, then runs
 * IDENTIFICATION AND WEIGHING for real, so the processes are grouped and scored by the
 * same code the product uses. Nothing is pre-baked into the database.
 *
 * THE DATA IS ILLUSTRATIVE. It comes from `ai/fixtures/mock-audit.js`, whose own header
 * says "Illustrative audit fixture ... Not a real client". It is deliberately
 * imperfect, and both imperfections are worth keeping in a demo: `invoice-processing`
 * and `invoice-processing-2` describe the SAME work with very different time estimates,
 * so the pipeline has a real disagreement to surface, and `proposal-drafting` is
 * judgement-heavy and should score low despite high effort. Using that file rather than
 * new invented data is deliberate: it already exercises the pipeline, including the
 * cases that separate a diagnostic from a wish list.
 *
 * RUN IT WITH A REAL PROVIDER, and it costs real calls:
 *
 *     AI_PROVIDER=deepseek STORE_DIR=data/demo node scripts/seed-demo-org.js
 *
 * `STORE_DIR` IS REQUIRED, NOT DEFAULTED, and it may not be the default store. This
 * script DELETES an organisation to make itself re-runnable, and the default store is
 * where real data lives. A separate directory also sidesteps the pre-v6 organisation
 * files already in `data/store/orgs/`, which this code refuses by design: the script
 * never reads them, because it never looks at that directory.
 *
 * `STORE_DIR=data/demo` IS THE COMMITTABLE LOCATION, and `data/store/orgs/` is NOT:
 * that directory is gitignored wholesale, because it holds live organisation files. A
 * seeded database under `data/demo/` is a checked-in artefact instead, which is the
 * point of it. See "SHIPPING THE SEEDED DATABASE" below.
 *
 * `.env` sets `AI_PROVIDER=mock`, and the mock is an INTERVIEW simulator: it answers
 * every call with the next scripted question, so identification and weighing cannot
 * work under it. That is the mock doing its job, not a pipeline failure, and both the
 * startup check and the per-reply check name it rather than letting a mock run read as
 * a broken demo. `scripts/check-weighing-order.js` handles it the same way.
 *
 * WHAT IT COSTS. One identification call per response, plus one weighing call per
 * process that results. The count is printed BEFORE any call, so the cost is known
 * rather than discovered. The fixture has 8 responses, so the run is 8 identifications
 * plus AT MOST 8 weighings: fewer in practice, because responses describing the same
 * work merge into one process and a process is weighed once.
 *
 * RE-RUNNABLE MEANS IT DELETES. Running it again removes the previous demo organisation
 * and rebuilds it, so a demo somebody has clicked through can be reset. It matches its
 * own organisation by name, and it deletes through `orgDbPath`, which refuses an id
 * that would resolve outside the store directory.
 *
 * FAILURE IS LOUD AND PARTIAL WORK IS NAMED. A missing key, an unreachable provider or
 * a refused call stops the run with the reason, the organisation id and what had been
 * completed. Whatever was written stays where it is and is reported, so a half-built
 * organisation is never mistaken for a working one.
 *
 * SHIPPING THE SEEDED DATABASE. The result is one self-contained file at
 * `<STORE_DIR>/orgs/example-ltd-demo.db`, and it is meant to be COMMITTED so the demo
 * travels with the repository. To install it on another machine:
 *
 *   1. copy the file to that machine's `data/demo/orgs/`;
 *   2. set `STORE_DIR=data/demo` there, and `DEMO_LOGIN_ORG=example-ltd-demo`;
 *   3. set the three other `DEMO_LOGIN*` variables from `.env.example`.
 *
 * The final deployment then needs **no provider and no API key**: the processes are
 * already grouped and scored, and the console only reads them. Nothing re-runs the
 * pipeline there, which is the whole reason the database is committed rather than
 * rebuilt on the machine that shows it.
 *
 * THE READ-ONLY DEMO LINK IS THE OTHER HALF, AND IT IS CONFIGURED ELSEWHERE. This
 * script needs `STORE_DIR` and a real `AI_PROVIDER`; the link needs `DEMO_LOGIN=1`,
 * `DEMO_LOGIN_ORG`, `DEMO_LOGIN_TOKEN` and optionally `DEMO_LOGIN_DAYS`, and it is off
 * unless the first of those is set. A reader following only this script builds the
 * organisation and then has no documented way to send it, which is why the variables
 * are named here as well as in `.env.example`, where the reasoning for each lives.
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
    closeAll
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
    departmentFor, responseDataFor, demoEmailFor
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
 * THROUGH `orgDbPath`, so the path is checked to be inside the store directory before
 * anything is removed: a deletion that resolved elsewhere would be the worst bug this
 * script could have. The WAL and SHM sidecars go with it, or a later run finds a
 * database that looks present but is not.
 */
function removeOrganisationFiles(orgId) {
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
        const response = addResponse(orgId, invitation.token, { department, data });

        // THE REAL IDENTIFICATION PATH. `recordIdentification` defaults to a MODEL
        // decision, which is what a first pass is. The rejudge route would mark every
        // revision as an admin correction and require an admin's argument, and a demo
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
 * THIS IS WHAT MAKES THE FILE COMMITTABLE. The store runs in WAL mode, so while a
 * connection is open the recent writes live in a `-wal` sidecar beside the database.
 * Committing the `.db` without it would ship a database missing its last writes, and
 * committing both would ship two files that have to be restored together - a
 * corruption waiting for whoever copies only one. Closing the connection folds the WAL
 * back in and removes the sidecars, leaving one self-contained file.
 *
 * RUN WHETHER THE SEED SUCCEEDED OR FAILED. A partial organisation is still worth
 * checkpointing: the failure message tells the operator it is partial, and a
 * half-written file with a stale WAL would be worse than either.
 *
 * THE CONSEQUENCE FOR GIT is that `data/demo/orgs/` contains exactly one `.db`, and the
 * ignore rules for the WAL sidecars are there in case a run is interrupted rather than
 * as the normal state.
 */
/**
 * Closes every connection, which CHECKPOINTS THE WAL INTO THE DATABASE FILE.
 *
 * THIS IS WHAT MAKES THE FILE COMMITTABLE. The store runs in WAL mode, so while a
 * connection is open the recent writes live in a `-wal` sidecar beside the database.
 * Committing the `.db` without it would ship a database missing its last writes, and
 * committing both would ship two files that have to be restored together - a
 * corruption waiting for whoever copies only one. Closing the connection folds the WAL
 * back in and removes the sidecars, leaving one self-contained file.
 *
 * RUN WHETHER THE SEED SUCCEEDED OR FAILED. A partial organisation is still worth
 * checkpointing: the failure message tells the operator it is partial, and a
 * half-written file with a stale WAL would be worse than either.
 *
 * THE CONSEQUENCE FOR GIT is that `data/demo/orgs/` contains exactly one `.db`, and the
 * ignore rules for the WAL sidecars are there in case a run is interrupted rather than
 * as the normal state.
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
