/**
 * Turning the illustrative fixture into the responses a demo organisation holds: a pure transformation,
 * split out of `seed-demo-org.js`, which keeps the run itself.
 *
 * It also holds the demo's identity - the pinned id, the name, the admin address and the markers a previous
 * demo is recognised by - so the seed reads as a sequence of steps rather than a list of constants.
 */

/**
 * The organisation's id, pinned so the file name is predictable. This seed is the one caller needing a fixed
 * id, because the database is committed and shipped and `DEMO_LOGIN_ORG` in the deployment is a constant;
 * re-seeding produces the same file rather than a second organisation beside it.
 *
 * It satisfies the store's safe-path rule. Changing it means re-seeding and updating `DEMO_LOGIN_ORG`.
 */
export const DEMO_ORG_ID = 'example-ltd-demo';

/**
 * The organisation's name. The console has no illustrative banner, because the `illustrative` flag is
 * rendered only by the participant client, so the name is the console's only marker that the data is
 * fabricated.
 */
export const ORG_NAME = 'EXAMPLE Ltd (illustrative demo data, not a real client)';

/**
 * The address attached to the demo organisation as its admin. The console resolves an organisation from the
 * signed-in email and `lib/provision.js` creates a new organisation for an unknown address, so signing in
 * with an address this seed did not register produces an empty organisation beside the seeded one.
 *
 * Deliberately different from the demo viewer's address, which must have no `users` row: registering it
 * would create the row that turns a deleted demo row into a writable session.
 */
export const DEMO_ADMIN_EMAIL = 'demo@example.test';

/**
 * How a previous demo organisation is recognised, so a re-run can remove it: matched on the name rather than
 * an id, with both fragments required, so an organisation that merely mentions "demo" is not deleted.
 */
export const DEMO_NAME_MARKERS = ['EXAMPLE', 'demo'];

/**
 * The department a fixture response belongs to, normalised from `reportedBy`, which says who gave the
 * estimate rather than a department: the parenthetical is dropped rather than stored as a department name.
 */
export function departmentFor(workflow) {
    return String(workflow.reportedBy || 'Unknown').replace(/\s*\(.*\)\s*$/, '').trim();
}

/**
 * The response data the pipeline reads: the fixture workflow minus its bookkeeping, because `reportedBy` and
 * `conflictsWith` are metadata about who said what and the matrix does not read them.
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
 * A synthetic interview transcript for a demo response: synthesised for presentation, not captured, so the
 * demo shows the raw-words view without a real participant.
 *
 * Every participant turn is built from the stored fields, so the transcript cannot contradict the summary
 * rendered beside it. The questions are the interview's own, from the scripted sequence in
 * `ai/adapters/mock.js`, and the format-commitment turn is absent because it is appended at the provider call
 * rather than stored.
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
