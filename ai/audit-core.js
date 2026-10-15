/**
 * Audit conversation core: one turn of the intake interview.
 *
 * The model replies with:
 *
 *   { status: "asking",   content: "<next question>", have: [...], missing: [...] }
 *   { status: "complete", content: "<closing line>", have: [], missing: [],
 *     processes: [...], audit: { workflows: [...] } }
 *
 * `have` and `missing` decide whether the interview continues, not `status`: the server computes both
 * lists and compares the model's claim against them, so a model that believes it is finished while a
 * field is absent cannot close early and drop it silently.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { sanitizeInput, checkPromptInjection } from './security.js';
import { extractJsonObject } from './json-extract.js';
import { withFormatCommitment } from './format-commitment.js';
import { ALL_PROCESS_FIELD_NAMES, reconcileMatrix, stepGapsFor } from './matrix.js';
import { withWorkflowIdentity } from './workflow-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', 'data', 'prompts');

const SUPPORTED_LANGS = ['nl', 'en', 'fr'];

/**
 * The fields derived from the payload, never asked of the model. The model's own value is deleted on
 * sight, and a list so the next derived field is added here rather than guarded separately.
 */
const DERIVED_FIELDS = Object.freeze(['stepsStillNeed']);

/**
 * Removes every derived field from an object graph at any depth, in place, walking arrays: the payload
 * is persisted verbatim, so a value deleted only at the top level still reaches a caller inside
 * `processes` and the saved answers.
 *
 * @param {*} value Any part of the parsed reply.
 * @param {string[]} fields The field names to remove.
 * @returns {number} How many properties were removed, for the caller's log.
 */
function stripDerivedFields(value, fields) {
    if (value === null || typeof value !== 'object') return 0;

    let removed = 0;
    if (Array.isArray(value)) {
        for (const entry of value) removed += stripDerivedFields(entry, fields);
        return removed;
    }

    for (const field of fields) {
        if (Object.hasOwn(value, field)) {
            delete value[field];
            removed += 1;
        }
    }
    for (const key of Object.keys(value)) {
        removed += stripDerivedFields(value[key], fields);
    }
    return removed;
}

/**
 * Refuses to serve a prompt that describes a derived field, at load rather than as a warning: a prompt
 * that mentioned the field would put it in front of the model every turn, so the deletion would be
 * quietly correcting a mistake the prompt invited.
 *
 * @param {string} text The prompt file's contents.
 * @param {string} file Its path, for the error.
 */
function assertPromptDoesNotDescribeDerivedFields(text, file) {
    for (const field of DERIVED_FIELDS) {
        if (text.includes(field)) {
            throw new Error(
                `The prompt ${file} mentions "${field}", which is DERIVED from the payload and ` +
                'must never be described to the model. It is computed by parseModelResponse and ' +
                'any value the model sends for it is discarded. Remove it from the prompt: ' +
                'describing it invites the model to report something that is not its to report.'
            );
        }
    }
}

/**
 * Loads a prompt, falling back to English then Dutch. Returns null rather than throwing so the caller
 * reports a clean error instead of a stack trace.
 */
async function loadPrompt(toolId, lang) {
    for (const candidate of [lang, 'en', 'nl']) {
        const file = path.join(PROMPTS_DIR, toolId, `prompt_${candidate}.md`);
        try {
            const text = await fs.readFile(file, 'utf8');
            assertPromptDoesNotDescribeDerivedFields(text, file);
            return text;
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }
    return null;
}

/**
 * The questions this conversation has already asked, each with its open-field count. The count comes
 * from the model's own claim, because past turns are not re-matrixed, and an absent `missing`/`evidenced`
 * reads as no progress, which is the safe direction.
 *
 * @param {Array<{role: string, content: string, missing?: string[]}>} messages
 * @returns {Array<{text: string, openCount: number}>}
 */
function assistantQuestionsWithOpenCounts(messages) {
    const asked = [];

    for (const message of messages) {
        if (!message || message.role !== 'assistant') continue;
        const text = typeof message.content === 'string' ? message.content.trim() : '';
        if (text === '') continue;

        // Absent counts read as 0, i.e. unknown, which the guard treats as no progress.
        const missing = Array.isArray(message.missing) ? message.missing.length : 0;
        const evidenced = Array.isArray(message.evidenced) ? message.evidenced.length : 0;
        // Recorded but never matched.
        asked.push({ text, openCount: missing, evidencedCount: evidenced, substituted: message.substituted === true });
    }

    return asked;
}

/**
 * An assistant turn is rebuilt as role and content only: the client replays `substituted` and `missing`
 * beside the text because this server needs them, and they would otherwise reach the provider as
 * internal bookkeeping in the model's own conversation.
 *
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.messages Conversation so far.
 * @param {string} args.lang UI language.
 * @param {string} args.toolId Which prompt set to use.
 * @returns {Promise<object>} The parsed model response.
 */
export async function runAuditTurn({ messages, lang = 'en', toolId = 'cartiere_audit' }) {
    const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'en';

    const systemPrompt = await loadPrompt(toolId, safeLang);
    if (!systemPrompt) {
        throw new Error(`No prompt found for tool "${toolId}" in ${PROMPTS_DIR}`);
    }

    // Guardrail: the model must never see unsanitised participant text.
    const safeMessages = [];
    for (const msg of messages) {
        // Assistant turns are rebuilt as role and content only.
        if (msg.role !== 'user') {
            safeMessages.push({ role: msg.role, content: msg.content });
            continue;
        }

        const cleaned = sanitizeInput(msg.content);
        if (await checkPromptInjection(cleaned)) {
            // Refuse rather than pass it through, even if the model is persuaded to ignore the prompt.
            console.warn('[audit] blocked an input that matched an injection pattern');
            return {
                status: 'rejected',
                content: 'That message looks like an instruction to the system rather than an answer. Could you rephrase it as a description of your workflow?'
            };
        }
        safeMessages.push({ role: msg.role, content: cleaned });
    }

    const raw = await generateText({
        messages: withFormatCommitment(safeMessages),
        systemInstruction: systemPrompt,
        temperature: 0.3,
        maxTokens: 4096,
        responseMimeType: 'application/json',
        lang: safeLang
    });

    // The questions already asked, passed in rather than read from anywhere global, so
    // `parseModelResponse` stays a pure function of its input. Only the assistant's turns are useful, and
    // each carries the open-field count from when it was asked, which is what makes a legitimate second
    // attempt distinguishable from the stall this guard exists for.
    const askedBefore = assistantQuestionsWithOpenCounts(messages);

    return parseModelResponse(raw, { askedBefore, messages });
}


/** Pluralises a count for an error message the operator reads. */
function countReason(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The workflows a completion reply carries, from either shape: the interview shape carries `processes`
 * and the older single-shot shape carries `audit.workflows`. Every consumer reads the payload through
 * here, so none can be updated for one shape and missed for the other.
 *
 * @param {object} parsed A parsed model response.
 * @returns {Array<object>|undefined} The workflows, or undefined when neither is present.
 */
export function workflowsFrom(parsed) {
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (Array.isArray(parsed.processes) && parsed.processes.length > 0) return parsed.processes;
    if (Array.isArray(parsed.audit?.workflows)) return parsed.audit.workflows;
    return undefined;
}

/**
 * Whether a reply carries a payload at all: `processes` present but empty is not one, because an
 * interview that produced no process has produced nothing to score.
 *
 * @param {object} parsed
 * @returns {boolean}
 */
function hasPayload(parsed) {
    const workflows = workflowsFrom(parsed);
    return Array.isArray(workflows);
}

/**
 * Validates an audit payload's workflows, exported so both entry points apply the same rule: the model
 * path and `POST /api/score`, which takes the payload straight from the client.
 *
 * Every check below is live on the HTTP path, including the one for an entry that is not an object. That
 * check is unreachable from the interview path, where a malformed entry leaves the matrix incomplete, but
 * `POST /api/score` calls this directly, so `{"workflows":[null]}` returns "1 entry is not an object". Do
 * not remove it as dead.
 *
 * @param {*} workflows
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateWorkflows(workflows) {
    if (!Array.isArray(workflows) || workflows.length === 0) {
        return { ok: false, reason: 'workflows is missing, not an array, or empty' };
    }

    const malformed = workflows.filter((w) => !w || typeof w !== 'object' || Array.isArray(w));
    if (malformed.length > 0) {
        return { ok: false, reason: countReason(malformed.length, 'entry is not an object', 'entries are not objects') };
    }

    const missingId = workflows.filter((w) => typeof w.id !== 'string' || w.id.trim() === '');
    if (missingId.length > 0) {
        return { ok: false, reason: countReason(missingId.length, 'entry has no id', 'entries have no id') };
    }

    // `title` is the heading the client reads, and requiring it keeps a blank heading out of the
    // document.
    const missingTitle = workflows.filter((w) => typeof w.title !== 'string' || w.title.trim() === '');
    if (missingTitle.length > 0) {
        return { ok: false, reason: countReason(missingTitle.length, 'entry has no title', 'entries have no title') };
    }

    return { ok: true };
}

/**
 * What the participant sees when the round ends with nothing answered: honest rather than a closed door,
 * saying what happened and that somebody can follow up rather than thanking them for answers they did not
 * give.
 */
const NOTHING_ANSWERED_CONTENT =
    'Thank you for your time. We did not manage to capture any answers for this one, so there '
    + 'is nothing to analyse yet. That is not a problem on your side: some work is hard to put '
    + 'into words, and saying so is useful in itself. You can close this page, and someone can '
    + 'follow up with you directly if it is worth a conversation.';

/**
 * The closing question's fingerprint, matched as a phrase rather than by exact text, because a model that
 * asks the closing question early rarely quotes the prompt verbatim. A false positive is the accepted
 * direction: the reply becomes a question the interview asked anyway, while the opposite leaves the
 * participant staring at "is there another process?" with twelve fields unanswered.
 */
const CLOSING_QUESTION_SHAPES = [
    // The one principle: a closing question offers a NEW piece of work. A legitimate question is about
    // this process, while a closing question is about another one, or about stopping. Each pattern
    // therefore requires a new piece of work after it, and a miss rather than a false hit is the
    // accepted direction.
    /\b(?:another|any other|more)\s+(?:process|work|task|piece of work|one)\b/i,
    /\bother processes\b/i,
    // `anything else` only when it offers to continue or to stop. The offer must be the whole clause,
    // not merely present in it: "anything else you would change about this step" is about this process.
    // `you'd`, `we'd` and the spelled-out forms, with a straight or curly apostrophe.
    /\banything else\s+(?:you|we)(?:['\u2019]d|\s+would)?\s+(?:like|want|wish|add|cover)\b/i,
    /\banything else\s+(?:to add|to cover|before we)\b/i,
    /\bsomething else\b/i,
    // Moving on means to a different process, not the next step of this one: "move on" alone would gate
    // "Would you like to move on to the next step?".
    /\b(?:would|do)\s+you\s+(?:like|want)\s+to\s+(?:\w+\s+){0,2}(?:move on to\s+(?:the next process|another|a new)|continue with\s+(?:another|the next process))\b/i,
    /\b(?:would|do)\s+you\s+(?:like|want)\s+to\s+(?:stop|finish|wrap up|end)\b/i,
    // `shall we move on` is a closing offer with no object, and the distinction is the subject of the
    // sentence: "we" moves the conversation somewhere, while "you ... to the next step" does not.
    /\b(?:shall|should)\s+we\s+(?:stop|finish|wrap|move|continue|go on|press on)\b/i
];

/**
 * Replaces a closing question with a real one when the matrix is not satisfied. This is in code and not
 * only in the prompt because the prompt was watched asking the closing question four times in a row with
 * twelve fields open, and a prompt is a request while this is the rule.
 *
 * The closing question is replaced by a question about the next open field, and `have` and `missing` are
 * unchanged; only `content` differs.
 *
 * @param {string} content The model's own question.
 * @param {{ missing: string[], have: string[] }} computed The matrix's view.
 * @returns {string}
 */
function withoutClosingQuestion(content, computed) {
    const text = typeof content === 'string' ? content : '';
    if (!CLOSING_QUESTION_SHAPES.some((shape) => shape.test(text))) return text;

    const open = computed.missing[0];
    if (!open) return text;

    // The field's own words, so the question reads like something a person would ask; a field with no
    // phrasing falls back to its name rather than a premature goodbye.
    const phrasing = FIELD_QUESTIONS[open];
    console.warn(
        `[audit] the model asked the closing question with ${computed.missing.length} field(s) ` +
        `still open; replacing it with a question about "${open}"`
    );
    return phrasing || `Could you tell me more about "${open}"?`;
}

/**
 * What to say when every open field has already been asked and nothing is moving. A function of the open
 * fields rather than a constant, so it differs each time and is never itself a repeat, and it does not
 * name the fields because those are internal names.
 *
 * The caller has seen a model repeat, so the participant is never asked a question they answered: the text
 * invites them to add anything and the interview closes on the next completing turn.
 *
 * @param {string[]} open The fields still unsupplied.
 * @returns {string}
 */
function moveOnLine(open) {
    const count = open.length === 1 ? 'one thing' : `${open.length} things`;

    // A fixed line would repeat itself, so the variant is chosen from the field set.
    const variants = [
        'If you think of something later, it can be added.',
        'Anything you can add now would still be useful.',
        'A rough answer is better than none, if you have one.',
        'We can leave it there if that is everything.',
        'Anything else you want me to know before we finish?'
    ];
    // Indexed by the sum of the field names, which changes when the set does.
    const fingerprint = open.join('').split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const index = fingerprint % variants.length;

    return `Thank you - let us move on rather than keep circling this. There are ${count} I could `
        + `not pin down, and that is useful to know in itself. ${variants[index]}`;
}

/**
 * A question this gate wrote, marked so it is not mistaken for the model's.
 *
 * Termination depends on this mark: the client replays every assistant turn verbatim, so without it the
 * gate matches its own previous sentence and replaces it with another. With the mark, a substituted
 * question is never a match target. It is a property of the reply rather than of the transcript, so
 * nothing about the stored conversation changes.
 */
const SUBSTITUTED = true;

/**
 * What the participant sees when the round closes because the interview stopped gaining evidence. It says
 * what is true of a stall and of a dip alike, which is a statement about the interviewer's judgement, and
 * it does not apologise because an admin may read the page.
 *
 * Distinct from the other two terminal messages: `nothing_answered` means they declined everything,
 * `exhausted` means every question was asked, and this one means the interview stopped gaining.
 */
const EVIDENCE_CAP_CONTENT =
    'Thank you - let us stop here. I have everything I can usefully take from this one, so rather '
    + 'than keep asking I will work with what you have told me. Everything you gave is saved, and '
    + 'it counts. Someone can follow up with you if there is more to capture.';

/**
 * How many turns the interview may go without gaining any evidence: the net under the whole guard,
 * because oscillation, claim churn and rewording all have the same shape, an interview not gaining
 * evidence, and a cap on turns catches every one of them. That is why it is a property of the conversation
 * rather than another text heuristic.
 *
 * The cost is named: a stuck participant sees up to twenty questions, while cutting off a working
 * interview would lose evidence the participant gave.
 */
const TURNS_WITHOUT_EVIDENCE_CAP = 20;

/**
 * How many consecutive turns the conversation has gone without gaining evidence. Derived from the
 * conversation rather than carried as state: every assistant turn already carries `evidenced`, and a
 * counter the client kept and the server trusted would be a claim, which is what this guard exists to
 * stop reading as progress.
 *
 * @param {Array<{role: string, evidenced?: string[]}>} messages The conversation so far.
 * @returns {number} Turns since the evidence last grew.
 */
function turnsWithoutEvidence(messages) {
    const counts = [];
    for (const message of messages) {
        if (!message || message.role !== 'assistant') continue;

        if (Array.isArray(message.evidenced)) {
            counts.push(message.evidenced.length);
            continue;
        }

        // A turn the server wrote always carries something to judge from, so an absent `evidenced` on
        // one means the client did not send it, not that the turn is unjudgeable: this is the last
        // mechanism, so a client omitting the field would make every earlier guard unreachable and the
        // interview would run forever, silently. `missing` and `substituted` are the server's own
        // fields, so seeing either proves the turn came from this server.
        //
        // A bare user turn, and a turn with no server fields at all, are still skipped, which keeps a
        // conversation recorded before the field existed from reading as stalled.
        const fromThisServer = Array.isArray(message.missing) || message.substituted !== undefined;
        if (fromThisServer) counts.push(0);
    }

    // Nothing to judge yet, so a new interview and a hand-built fixture both start uncapped.
    if (counts.length === 0) return 0;

    let peak = 0;
    let since = 0;
    for (const count of counts) {
        if (count > peak) {
            peak = count;
            since = 0;
        } else {
            since += 1;
        }
    }
    return since;
}

/**
 * Whether every field's question has appeared in the conversation. The count of distinct field questions
 * asked only grows, so once this is true it stays true, where a comparison against the open field set can
 * be defeated indefinitely.
 *
 * Limited to the fields currently open: requiring all of them would never fire, because a field the model
 * claims to hold is never offered as a question. A field with no phrasing is not counted, so a field added
 * without a question cannot make this never true.
 *
 * @param {Set<string>} askedQuestions The texts already sent to the participant.
 * @returns {boolean}
 */
function asksEveryField(askedQuestions, openFields) {
    const phrasings = openFields
        .map((field) => FIELD_QUESTIONS[field])
        .filter((phrasing) => phrasing !== undefined);
    if (phrasings.length === 0) return false;
    return phrasings.every((phrasing) => askedQuestions.has(phrasing));
}

/**
 * Replaces a question the conversation has already asked, when nothing has moved since. Both conditions
 * must hold: the content is identical to a question already asked, and `missing` has not shrunk, because
 * asking twice is legitimate and the second condition stops this firing on a legitimate repeat.
 *
 * Only the model's own repeats are matched. A substitute this function wrote is never a match target, or
 * the gate would argue with itself rather than ending the loop; a gate sentence the model echoed is still
 * the gate's, because the mark travels with the text.
 *
 * Progress is measured from `evidenced` rather than from a claim, because `computed.missing` is built
 * partly from the model's own `have`, so a model that re-partitions what it claims shrinks `missing` while
 * nothing is recorded. The `openCount` branch is a narrow fallback for a conversation recorded before
 * `evidencedCount` existed.
 *
 * It terminates because it only ever moves to an unasked field, so the available questions strictly
 * decrease.
 *
 * @param {string} content The question, already through the closing-question rule.
 * @param {{ missing: string[], have: string[] }} computed The matrix's view.
 * @param {Array<{text: string, openCount: number}>} askedBefore Questions already asked, with
 *   how many fields were open at the time. Oldest first.
 * @returns {string}
 */
function withoutRepeatedQuestion(content, computed, askedBefore) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (text === '') return content;

    // A gate-owned or echoed sentence; see the note above.
    const gateOwned = askedBefore.some((entry) => entry.text === text && entry.substituted === true);
    const wasAsked = askedBefore.find((entry) => entry.text === text);

    if (!wasAsked) return { text: content, substituted: false };

    // `evidenced` is authoritative; the `openCount` branch is the narrow fallback above.
    const hasEvidenceData = wasAsked.evidencedCount !== undefined;
    const progressed = hasEvidenceData
        ? computed.evidenced.length > wasAsked.evidencedCount
        : computed.missing.length < wasAsked.openCount;

    if (progressed) return { text: content, substituted: gateOwned };

    // ASKED, NO PROGRESS. Prefer an open field whose question has not appeared yet.
    const askedQuestions = new Set(askedBefore.map((entry) => entry.text));
    const fresh = computed.missing.find((field) => {
        const phrasing = FIELD_QUESTIONS[field];
        return phrasing !== undefined && !askedQuestions.has(phrasing);
    });

    // Exhaustion is decided by what has been asked, not by what is open, because a comparison against the
    // open set is not monotonic: a model that rotates its payload produces a new set every turn and
    // exhaustion is never recognised.
    if (fresh === undefined && asksEveryField(askedQuestions, computed.missing)) {
        console.warn(
            '[audit] the model repeated a question with no progress, and every field question has ' +
            'already been asked; closing the interview on the ' +
            `${computed.supplied.length} field(s) that were supplied`
        );
        return {
            text: 'Thank you - that gives me a good picture of this one. I will stop there '
                + 'rather than keep asking, and the analysis will work from what you have told me.',
            substituted: SUBSTITUTED,
            exhausted: true
        };
    }

    if (fresh === undefined) {
        // The move-on line.
        console.warn(
            '[audit] the model repeated a question with no progress and every open field has ' +
            `been asked already (${computed.missing.join(', ')}); asking the participant to move on`
        );
        return { text: moveOnLine(computed.missing), substituted: SUBSTITUTED };
    }

    console.warn(
        `[audit] the model repeated its question with ${computed.missing.length} field(s) still ` +
        `open and no progress since it asked it; replacing it with a question about "${fresh}"`
    );
    return { text: FIELD_QUESTIONS[fresh], substituted: SUBSTITUTED };
}

/**
 * How to ask about each field in words a participant recognises. Cosmetic rather than a rule: it only runs
 * when the model closed early, and the interview's own prompt phrases these better.
 */
const FIELD_QUESTIONS = {
    task: 'What is the work, in your own words?',
    trigger: 'What starts one instance of this work?',
    steps: 'What are the steps, from beginning to end?',
    frequencyPerWeek: 'About how many times a week does this happen?',
    timePerPeriod: 'About how much time does this take per week?',
    peopleAffected: 'Who else is involved in this?',
    handoffTo: 'Who does this go to next?',
    waitsFor: 'Does this wait on anything before it can proceed?',
    dependsOn: 'What has to happen first, before this can start?',
    systems: 'Which systems or tools do you use for this?',
    touchedDepartments: 'Which departments does this cross?',
    mistakesPerPeriod: 'How often does something go wrong with this?',
    mistakeConsequence: 'What happens when something goes wrong?',
    currentState: 'How is this done today, overall?',
    frustration: 'What is the most frustrating part of this for you?'
};

/**
 * Parses and validates the model's JSON reply. Exported so it is unit testable without a provider, and
 * malformed JSON becomes a structured error rather than an exception.
 *
 * Which shape is authoritative is decided as `workflowsFrom` decides it, so validation and the payload
 * cannot disagree: an empty `audit.workflows` is unusable alone and merely stale beside a good `processes`
 * array, which wins.
 *
 * Each shape is validated against its own requirements, because `workflowsFrom` prefers `processes`, whose
 * field matrix never mentions `id` or `title`, while `audit.workflows` keeps the stricter check that the
 * scorer consumes.
 *
 * The matrix decides completion: `missing` empty is the only thing that finishes the interview, and a model
 * claiming `complete` with a field absent is downgraded to `asking`.
 */
export function parseModelResponse(raw, { askedBefore = [], messages = [] } = {}) {
    // Parsed out of prose rather than handed to JSON.parse: DeepSeek's JSON mode returns whitespace as a
    // conversation grows, so that provider is asked in plain mode and its replies arrive with the object
    // somewhere inside them, often in a fence.
    const parsed = extractJsonObject(raw);
    if (parsed === null) {
        // What came back, truncated at 120 characters, so a blank reply is diagnosable from the log.
        console.error(
            `[audit] no JSON object in the model reply (${String(raw).length} chars): ` +
            (String(raw).trim() === '' ? '(blank reply)' : JSON.stringify(String(raw).slice(0, 120)))
        );
        return {
            status: 'error',
            content: 'The analysis service returned an unreadable response. Please try again.'
        };
    }

    if (!parsed.status) {
        console.error('[audit] model response had no status field');
        return { status: 'error', content: 'The analysis service returned an unexpected response. Please try again.' };
    }

    // The model's claim and the computed truth side by side: while the interview is running the claim is
    // believed for anything the payload does not yet carry, and on completion only the payload counts.
    const processes = Array.isArray(parsed.processes) ? parsed.processes : [];
    const claimedHave = Array.isArray(parsed.have) ? parsed.have : null;
    const claimedMissing = Array.isArray(parsed.missing) ? parsed.missing : null;

    const computed = reconcileMatrix({
        processes,
        claimedHave,
        claimedMissing,
        closing: parsed.status === 'complete'
    });

    // `stepsStillNeed` is derived here and the model's own value is deleted. `steps` is the only field
    // whose completeness gate sits inside a container, so a participant who answers the basis question
    // before the step has a label moves nothing and the interviewer re-asks in different words; this says
    // which step fields are absent so the next question can differ.
    //
    // The deletion is recursive, because deleting only the top-level key let a value inside `processes`
    // survive, and the client persists the payload verbatim.
    const stripped = stripDerivedFields(parsed, DERIVED_FIELDS);
    if (stripped > 0) {
        console.warn(
            `[audit] the model sent ${stripped} derived field value(s) ` +
            `(${DERIVED_FIELDS.join(', ')}), which are computed from the payload and not the ` +
            'model\'s to report; discarded at every depth and replaced with the computed value'
        );
    }

    // The union across incomplete steps, because the consumer is one question for the whole
    // conversation. Empty when no step is incomplete, which coincides with `steps` leaving `missing`.
    const stepsStillNeed = [...new Set(processes.flatMap((process) => stepGapsFor(process && process.steps)))];
    // The matrix decides completion only when the model is playing the matrix game: a reply carrying
    // `processes` is an interview turn and its field list is authoritative, while a reply with a valid
    // `audit` and no `processes` is the older single-shot shape, already supplying everything downstream
    // needs.
    const playingTheMatrix = processes.length > 0 || claimedMissing !== null;

    // Completion reads `supplied`, not `missing`, and the difference is one state: a field the participant
    // declined leaves `missing` and does not enter `supplied`, so reading `missing` here would let an
    // interview complete on nothing but refusals. A missing field still blocks, so this is strictly
    // tighter than before.
    const matrixComplete = computed.supplied.length === computed.have.length
        && computed.missing.length === 0
        && processes.length > 0;

    // Nothing was answered, so the interview ends as `nothing_answered`. Without this an all-declined round
    // is a fixed point: every field declined leaves `have` full and `supplied` empty, the model has nothing
    // to ask, and the completion gate never opens.
    //
    // `submitted_at` is set and the status is not `complete`: the round has to end and `submitted_at` is
    // the store's only way to say so, while `complete` would be a lie the roadmap renders. Nothing reaches
    // the roadmap, because a process is only created by identification.
    if (playingTheMatrix && computed.missing.length === 0 && computed.supplied.length === 0) {
        console.warn(
            '[audit] every field was declined and none supplied; ending the round as ' +
            '"nothing_answered" rather than leaving it open with nothing to ask'
        );
        return {
            status: 'nothing_answered',
            content: NOTHING_ANSWERED_CONTENT,
            have: computed.have,
            missing: computed.missing,
            stepsStillNeed,
            processes
        };
    }

    // The evidence cap, checked before any question is considered, because the exact-text guard below
    // cannot see a reworded repeat and the interview would then run indefinitely.
    //
    // It closes the round rather than substituting, and it must not pre-empt completion: `evidenced` can
    // plateau while `missing` reaches zero, so the `missing.length > 0` condition is what keeps a finished
    // interview from being told it recorded nothing.
    if (playingTheMatrix && computed.supplied.length > 0
        && computed.missing.length > 0
        && turnsWithoutEvidence(messages) >= TURNS_WITHOUT_EVIDENCE_CAP) {
        console.warn(
            `[audit] no new evidence in ${TURNS_WITHOUT_EVIDENCE_CAP} turns ` +
            `(${turnsWithoutEvidence(messages)} and counting), with ${computed.supplied.length} ` +
            'field(s) supplied; closing the round on what was recorded rather than asking again'
        );
        return {
            status: 'asking',
            content: EVIDENCE_CAP_CONTENT,
            exhausted: true,
            evidenced: computed.evidenced,
            have: computed.have,
            missing: computed.missing,
            stepsStillNeed,
            processes
        };
    }

    if (parsed.status === 'complete' && playingTheMatrix && !matrixComplete) {
        // The model thinks it is done and the matrix disagrees: one more question is cheap, a missing
        // field is not.
        const unsupplied = computed.have.filter((field) => !computed.supplied.includes(field));
        const reasons = [];
        if (computed.missing.length > 0) reasons.push(`${computed.missing.length} still missing (${computed.missing.join(', ')})`);
        if (unsupplied.length > 0) reasons.push(`${unsupplied.length} declined (${unsupplied.join(', ')})`);
        console.warn(`[audit] model claimed complete with ${reasons.join(' and ')}; continuing`);
        // The same two guards as the final return: a reply downgraded from `complete` is still a reply
        // the participant reads, and a repeated question in it stalls the interview.
        const question = withoutRepeatedQuestion(
            withoutClosingQuestion(parsed.content, computed),
            computed,
            askedBefore
        );
        return {
            status: 'asking',
            content: question.text,
            substituted: question.substituted,
            exhausted: question.exhausted === true,
            have: computed.have,
            missing: computed.missing,
            stepsStillNeed,
            processes
        };
    }

    if (parsed.status === 'complete' && !hasPayload(parsed)) {
        console.error('[audit] model declared completion with neither processes nor audit data');
        return { status: 'error', content: 'The analysis completed without usable data. Please try again.' };
    }

    // Validate at the boundary: without this the browser posts a malformed payload to /api/score and
    // shows a generic network error for what is a model contract violation. Each shape is validated
    // against its own requirements, as `workflowsFrom` resolves them.
    if (parsed.status === 'complete') {
        // Which shape is authoritative.
        const processesPresent = Array.isArray(parsed.processes) && parsed.processes.length > 0;
        const auditIsArray = Array.isArray(parsed.audit?.workflows);
        const auditUsable = auditIsArray && parsed.audit.workflows.length > 0;
        const auditPresent = auditIsArray && !(processesPresent && !auditUsable);

        if (auditPresent) {
            const check = validateWorkflows(parsed.audit.workflows);
            if (!check.ok) {
                console.error(`[audit] model returned an unusable payload: ${check.reason}`);
                return { status: 'error', content: 'The analysis could not read the questionnaire answers. Please try again.' };
            }
        } else if (Array.isArray(parsed.processes) && parsed.processes.length > 0) {
            // The interview shape, already judged by the matrix. A process here with fields missing is
            // not an error but an unfinished interview, which the completion gate above has already
            // downgraded; only a shape that cannot be read at all is a fault.
            const unreadable = parsed.processes.filter(
                (process) => !process || typeof process !== 'object' || Array.isArray(process)
            );
            if (unreadable.length > 0) {
                console.error(
                    `[audit] model returned ${unreadable.length} process entr(ies) that are not objects`
                );
                return { status: 'error', content: 'The analysis could not read the questionnaire answers. Please try again.' };
            }
        }
    }

    // The reported lists are the model's and the computed ones are the server's; a discrepancy means the
    // prompt is not being followed, and callers read the computed pair.
    if (claimedMissing && claimedMissing.length !== computed.missing.length) {
        console.warn(
            `[audit] the model reported ${claimedMissing.length} missing field(s) and the matrix ` +
            `computes ${computed.missing.length}; using the computed list`
        );
    }

    // The payload is normalised from the best available source, decided on content rather than nullness:
    // a merely non-null `audit` kept `audit: { workflows: [] }`, which reached the client as an empty list
    // and the participant saw the scoring-failed panel after a successful interview.
    //
    // `workflowsFrom` is the only resolver, so there is no fallback arm here: it already returns
    // `parsed.audit.workflows` when that is the only source, so `best` is always an array on this line.
    const best = workflowsFrom(parsed);

    // The closing-question rule first, because a repeated closing line is a closing line; then the repeat
    // guard, which sees the substituted text.
    const question = withoutRepeatedQuestion(
        withoutClosingQuestion(parsed.content, computed),
        computed,
        askedBefore
    );

    return {
        ...parsed,
        // Absent rather than `{}` when there is nothing to normalise: an empty object is truthy, so a
        // caller using `data.audit || ...` would take `{}` and find `.workflows === undefined`.
        audit: Array.isArray(best) ? normaliseProcessesPayload(parsed, best) : undefined,
        // The closing question is suppressed here, the one place every reply passes through. It was once
        // applied only inside the "claimed complete and the matrix disagreed" branch, so a model asking the
        // closing question while reporting `asking` was never checked, which is the ordinary way the defect
        // appears. It is a no-op when the question is genuine and the matrix satisfied.
        content: question.text,
        // True when the gate has run out of questions, which the client treats as the end of the round.
        exhausted: question.exhausted === true,
        // The payload's own evidence, so the next turn can tell real progress from a change in what the
        // model claims; a reply without it reads as no progress.
        evidenced: computed.evidenced,
        // True when the gate wrote the question rather than the model. Termination rests on it: a
        // substituted question is never a match target, so a stalled conversation re-asks nothing.
        substituted: question.substituted,
        have: computed.have,
        missing: computed.missing,
        stepsStillNeed,
        processes
    };
}

/**
 * Wraps a workflows array in the payload shape the client reads: the interview shape carries a bare array
 * under `processes` while the client wants an object with `workflows`.
 *
 * This is the one place the interview payload is built, so the one place the `id` and `title` the scorer
 * requires are supplied; the prompt's `processes` example carries neither field, and without them the
 * answers reached `/api/score` and were refused. See `ai/workflow-identity.js`.
 *
 * The flags are read from either place a model might put them, the top level or an `audit` envelope.
 *
 * @param {object} parsed The parsed reply, which may carry the flags.
 * @param {Array<object>} workflows A non-empty array, already resolved.
 * @returns {object}
 */
function normaliseProcessesPayload(parsed, workflows) {
    const payload = { workflows: withWorkflowIdentity(workflows) };

    const envelope = parsed && typeof parsed.audit === 'object' && parsed.audit !== null ? parsed.audit : {};

    if (parsed && parsed.illustrative === true) payload.illustrative = true;
    else if (envelope.illustrative === true) payload.illustrative = true;

    const note = typeof parsed?.note === 'string' && parsed.note.trim() !== ''
        ? parsed.note
        : (typeof envelope.note === 'string' && envelope.note.trim() !== '' ? envelope.note : null);
    if (note !== null) payload.note = note;

    return payload;
}
