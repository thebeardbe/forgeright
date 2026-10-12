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
