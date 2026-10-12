/**
 * Turning the illustrative fixture into the responses a demo organisation holds.
 *
 * SPLIT OUT OF `seed-demo-org.js`, which had passed the project's file-size budget. The
 * seam is a real one rather than a mechanical cut: everything here is a PURE
 * TRANSFORMATION of fixture data, and everything left in the seed is the run itself -
 * reading configuration, refusing when the setup is wrong, calling the pipeline, and
 * reporting. The transformation is what a person would want to read on its own.
 *
 * IT ALSO HOLDS THE DEMO'S IDENTITY: the organisation's pinned id, its unmistakable
 * name, the address its admin signs in with, and the markers a previous demo is
 * recognised by. Those belong with the data rather than with the run, and putting them
 * here means the seed reads as a sequence of steps rather than a list of constants.
 */

/**
 * THE ORGANISATION'S ID, PINNED SO THE FILE NAME IS PREDICTABLE.
 *
 * `createOrganisation` generates a random UUID by default, which is right for every
 * other caller and stays that way. This seed is the ONE caller that needs a fixed id,
 * for three reasons that all follow from the database being COMMITTED and shipped:
 *
 *   - `DEMO_LOGIN_ORG` in the final deployment's environment is a constant, so it can
 *     be written down once and never change;
 *   - re-seeding produces the SAME file, so a rebuild replaces the committed database
 *     rather than adding a second organisation beside it;
 *   - copying the committed file to another machine needs no rename and no lookup: the
 *     id is in the name.
 *
 * IT SATISFIES THE STORE'S OWN SAFE-PATH RULE: lowercase letters and hyphens, well
 * under 64 characters. `assertSafeOrgId` checks it on the same path a generated id
 * takes, before any file is touched, so this constant cannot become a way to name a
 * path outside the store. Changing it means re-seeding AND updating `DEMO_LOGIN_ORG`,
 * which is why it is obviously illustrative rather than a plausible-looking UUID.
 */
export const DEMO_ORG_ID = 'example-ltd-demo';

/**
 * The organisation's name, and it does more for the demo's honesty than anything else
 * the console shows.
 *
 * THE CONSOLE HAS NO ILLUSTRATIVE BANNER. The `illustrative` flag is rendered only by
 * the participant client (`public/js/audit.js`), and nothing carries it into the
 * console's process or response views, so the roadmap gives a reader no signal at all
 * that the data is fabricated. The name is therefore the console's only marker, so it
 * carries the marker rather than being a tidy product name.
 *
 * `EXAMPLE Ltd` is the conventional fictitious-company name in English usage, so it
 * reads as illustrative without explanation. The parenthetical says what the data is,
 * because a demo left running is the state in which somebody forgets it is not real.
 */
export const ORG_NAME = 'EXAMPLE Ltd (illustrative demo data, not a real client)';

/**
 * The address attached to the demo organisation as its admin.
 *
 * THE DEMO IS UNREACHABLE WITHOUT THIS, which is not obvious and was found by running
 * it: the console resolves an organisation from the SIGNED-IN EMAIL, and
 * `lib/provision.js` creates a BRAND NEW organisation the first time an address signs
 * in. Signing in with an address this seed did not register therefore produces an
 * empty organisation beside the seeded one, and the roadmap shows nothing.
 *
 * It is a fixed address, and DELIBERATELY DIFFERENT from the demo viewer's
 * `demo-viewer@forgeright.invalid`. That address must have NO `users` row, which is
 * what the read-only guard relies on when a demo session's row is missing; a seed that
 * registered it would create exactly the row that turns a deleted demo row into a
 * writable session.
 */
export const DEMO_ADMIN_EMAIL = 'demo@example.test';

/**
 * How a previous demo organisation is recognised, so a re-run can remove it.
 *
 * MATCHED ON THE NAME rather than an id, because an id changes for a hand-made
 * organisation and the point of a re-run is to find the last one. Both fragments are
 * required, so a hand-made organisation that merely mentions "demo" is not deleted.
 */
export const DEMO_NAME_MARKERS = ['EXAMPLE', 'demo'];

/**
 * The department a fixture response belongs to.
 *
 * NORMALISED FROM `reportedBy`, WHICH IS NOT A DEPARTMENT: the fixture uses it to say
 * WHO gave the estimate, and one value is "Finance (second respondent)". `addResponse`
 * requires a real department name, and the console groups and counts by it, so the
 * parenthetical is dropped rather than stored as a department called "Finance (second
 * respondent)".
 */
export function departmentFor(workflow) {
    return String(workflow.reportedBy || 'Unknown').replace(/\s*\(.*\)\s*$/, '').trim();
}

/**
 * The response data the pipeline reads: the fixture workflow minus its bookkeeping.
 *
 * `reportedBy` and `conflictsWith` are fixture metadata ABOUT who said what. They are
 * not fields the matrix reads, and copying them into a response would put
 * unattributable commentary into the data a reader is shown.
 */
export function responseDataFor(workflow) {
    const { reportedBy, conflictsWith, ...data } = workflow;
    return data;
}

/** The stable demo email for a fixture workflow's invitation. */
export function demoEmailFor(workflowId) {
    return `${workflowId}@example.test`;
}

/**
 * A synthetic interview transcript for a demo response.
 *
 * SYNTHESISED FOR PRESENTATION, NOT CAPTURED. A real transcript is the browser's own
 * conversation, stored by `/api/response` as the participant answers. This function
 * builds a conversation that READS like one, from the fields the fixture already
 * carries, so the demo shows the raw-words view without a real participant having to
 * sit through an interview. Nothing here is a record of anything a person said.
 *
 * IT LIVES HERE RATHER THAN IN `ai/fixtures/mock-audit.js`, which is the point of the
 * fixture's own header: that file exists to exercise the pipeline, and demo-presentation
 * concerns must not enter the data the identification and weighing tests run against.
 * It sits beside `responseDataFor` because it is the same kind of thing - a pure
 * transformation of one fixture workflow.
 *
 * THE QUESTIONS ARE THE INTERVIEW'S OWN, taken from the scripted sequence in
 * `ai/adapters/mock.js` and matching the rules in `data/prompts/cartiere_audit/prompt_en.md`:
 * one question per turn, never two joined with "and", and the judgement question asks
 * for the BASIS rather than whether judgement was needed.
 *
 * THE PARTICIPANT'S WORDS COME FROM THE STORED FIELDS, NEVER FROM NOWHERE. Every
 * participant turn is built from `task`, `trigger`, the steps' `name` and `decidedHow`,
 * `systems`, `handoffTo` and the rest, so the transcript cannot contradict the summary
 * rendered beside it. A demo where the two disagree is worse than no transcript.
 *
 * THE FORMAT-COMMITMENT TURN IS DELIBERATELY ABSENT. `withFormatCommitment` appends it at
 * the PROVIDER call, server-side, after the browser has sent its conversation, so it was
 * never part of a stored transcript. This function replaces the browser side, and adding
 * it would be inventing a turn the real path cannot produce.
 *
 * LENGTH VARIES BY RESPONSE. Every fixture workflow carries a different number of steps,
 * and the question list is derived from what it actually has, so a short process gets a
 * short interview. That is also why it does not look generated: eight identical
 * conversations would.
 *
 * @param {object} workflow One fixture workflow, as `buildMockAudit` returns it.
 * @returns {Array<{role: string, content: string}>} Turns in order, in the shape
 *   `lib/auth/participant-routes.js` validates: `role` and `content`, both strings.
 */
export function synthesiseTranscript(workflow) {
    const turns = [];
    const analyst = (content) => turns.push({ role: 'assistant', content });
    const participant = (content) => turns.push({ role: 'user', content });

    // The opening, from the script's first question and the workflow's own task.
    analyst('What is the task that takes up the most time, and what starts one instance of it?');
    participant(`${workflow.task}. It starts when ${workflow.trigger}.`);

    // The steps, asked for in order and answered from the fixture's own sequence.
    analyst('What is the first step, and which steps come after it?');
    if (workflow.steps.length > 0) {
        const names = workflow.steps.map((s) => s.name);
        const first = names[0];
        const rest = names.slice(1);
        participant(rest.length === 0
            ? `Just ${first.toLowerCase()}. There is nothing else to it.`
            : `First ${first.toLowerCase()}, then ${rest.map((n) => n.toLowerCase()).join(', then ')}.`);
    }

    // The basis question, asked at EVERY step whose `decidedHow` the fixture records.
    //
    // THE TURN COUNT FOLLOWS THE PROCESS, which is what makes the length vary: a
    // four-step workflow and a five-step one produce different interviews, because a real
    // interview asks about each step it heard. Capping this loop made every response
    // exactly 24 turns, which is the "obviously generated" look a demo should not have.
    //
    // ASKED AT EVERY STEP, NOT SAMPLED, because the prompt requires the basis for each
    // one - a sampling would misrepresent what the interview does.
    const withBasis = workflow.steps.filter((s) => typeof s.decidedHow === 'string' && s.decidedHow !== '');
    for (const step of withBasis) {
        analyst(`On what basis do you decide at "${step.name}"?`);
        participant(`${capitalise(step.decidedHow)}.`);
    }

    // The frequency, answered the way the fixture states it.
    analyst('How often does this happen, or is it more continuous work?');
    if (typeof workflow.frequencyPerWeek === 'number') {
        participant(`About ${workflow.frequencyPerWeek} times a week, and each one takes roughly ${workflow.minutesPerInstance} minutes.`);
    }

    // People. Asked only when the fixture gives a figure, so a workflow without one does
    // not get an answer invented for it.
    if (typeof workflow.peopleAffected === 'number') {
        analyst('How many people in the company are involved in this?');
        // The answer reflects whether it is one person or several, which is the
        // difference a real participant would state.
        participant(workflow.peopleAffected === 1
            ? 'Just me, really.'
            : `${workflow.peopleAffected} of us, mostly in ${workflow.touchedDepartments[0]}.`);
    }

    // The handoff, which the fixture records as a list.
    if (workflow.handoffTo.length > 0) {
        analyst('Who does the work go to next, and what does it wait on?');
        participant(`It goes to ${listOf(workflow.handoffTo)}, and it waits for ${listOf(workflow.waitsFor)}.`);
    }

    // Systems and the prerequisite.
    if (workflow.systems.length > 0) {
        analyst('What has to happen first, and which systems do you use?');
        participant(`${capitalise(listOf(workflow.dependsOn))} has to happen first. We use ${listOf(workflow.systems)}.`);
    }

    // The closing question, which asks for several fields at once because the prompt
    // permits it there and a real interview does exactly this.
    analyst('Which departments does it cross, does it ever go wrong, and how does the team do this today?');
    const closing = [`It crosses ${listOf(workflow.touchedDepartments)}.`];
    if (workflow.mistakesPerPeriod > 0) {
        closing.push(`It goes wrong about ${workflow.mistakesPerPeriod} times a month: ${lowerFirst(workflow.mistakeConsequence)}`);
    } else {
        closing.push('It does not really go wrong.');
    }
    closing.push(`Today ${lowerFirst(workflow.currentState)}`);
    participant(closing.join(' '));

    // THE PARTICIPANT'S OWN COMPLAINT, quoted rather than paraphrased, because this is
    // the field a reader checks the rest of the summary against.
    if (typeof workflow.frustration === 'string' && workflow.frustration !== '') {
        analyst('What is the worst part of it for you?');
        participant(workflow.frustration);
    }

    // The scripted close, exactly as the interview ends.
    analyst('Thank you. Is there another process you would like to improve?');
    participant('Not right now, that is the main one.');

    return turns;
}

/** "a, b and c" - a readable list, with no Oxford comma, matching the prompts' register. */
function listOf(values) {
    const items = (Array.isArray(values) ? values : []).filter((v) => typeof v === 'string' && v !== '');
    if (items.length === 0) return 'nothing in particular';
    if (items.length === 1) return items[0];
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The first character upper-cased, so a field reads as the start of a sentence. */
function capitalise(text) {
    const s = String(text ?? '');
    return s === '' ? s : s[0].toUpperCase() + s.slice(1);
}

/** The first character lower-cased, for a field embedded mid-sentence. */
function lowerFirst(text) {
    const s = String(text ?? '').trim();
    if (s === '') return s;
    // Left alone when the first word looks like a proper noun or an acronym.
    if (/^[A-Z]{2,}/.test(s)) return s;
    return s[0].toLowerCase() + s.slice(1);
}
