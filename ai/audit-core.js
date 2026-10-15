/**
 * Audit conversation core: one turn of the intake interview.
 *
 * The model replies with:
 *
 *   { status: "asking",   content: "<next question>", have: [...], missing: [...] }
 *   { status: "complete", content: "<closing line>", have: [], missing: [],
 *     processes: [...], audit: { workflows: [...] } }
 *
 * `HAVE` AND `MISSING` DECIDE WHETHER THE INTERVIEW CONTINUES, NOT `STATUS`. The server
 * computes both lists and compares the model's claim against them, so a model that believes
 * it is finished while a field is absent cannot close early and drop it silently.
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
 * The fields DERIVED from the payload, never asked of the model.
 *
 * `stepsStillNeed` is computed by `parseModelResponse` from `processes`; the model's own value
 * is deleted on sight. A prompt that DESCRIBED it would invite the model to report it, and a
 * model claiming what the matrix computed is how a report starts contradicting its own data.
 * A list, so the next derived field is added here rather than guarded separately.
 */
const DERIVED_FIELDS = Object.freeze(['stepsStillNeed']);

/**
 * Removes every derived field from an object graph, at any depth.
 *
 * THE ENFORCEMENT HALF OF `DERIVED_FIELDS`. The payload is persisted verbatim, so a value
 * deleted only at the top level still reaches a caller inside `processes` and the saved
 * answers. DEPTH-FIRST, IN PLACE, WALKING ARRAYS - the leak found arrived inside one.
 * Terminates: `JSON.parse` output has no cycles. ONE LOG LINE FOR ALL PATHS, or a model
 * repeating the field per process logs every turn.
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
 * Refuses to serve a prompt that describes a derived field.
 *
 * A THROW AT LOAD, not a warning and not a test: `parseModelResponse` deletes whatever the model
 * sends, but a prompt that MENTIONED the field would put it in front of the model every turn, so
 * the deletion would be quietly correcting a mistake the prompt invited.
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
 * Loads a prompt, falling back to English then Dutch when a translation is
 * missing. Returns null rather than throwing so the caller can report a clean
 * error to the user instead of a stack trace.
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
 * The questions this conversation has already asked, each with its open-field count.
 *
 * THE CONVERSATION IS THE RECORD, not a counter: the client already sends every earlier turn,
 * and a counter is new state that must survive a reload.
 *
 * THE COUNT COMES FROM THE MODEL'S OWN CLAIM, because past turns are not re-matrixed. A model
 * reporting `missing: []` every stalled turn reports the same count, which is the comparison
 * the guard needs; a falling count has progressed.
 *
 * An absent `missing`/`evidenced` reads as unknown, i.e. no progress - the safe direction, as
 * a fresh question beats repeating a stalled one. IT CANNOT SEE a claim and payload disagreeing
 * so as to hide progress, and that is safe: the matrix refuses to close on anything missing.
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

        // Absent counts read as 0, i.e. "unknown", which the guard treats as no progress.
        const missing = Array.isArray(message.missing) ? message.missing.length : 0;
        const evidenced = Array.isArray(message.evidenced) ? message.evidenced.length : 0;
        // Recorded but never matched; see SUBSTITUTED.
        asked.push({ text, openCount: missing, evidencedCount: evidenced, substituted: message.substituted === true });
    }

    return asked;
}

/**
 * AN ASSISTANT TURN IS REBUILT AS ROLE AND CONTENT ONLY. The client replays `substituted` and
 * `missing` beside the text because THIS server needs them, and they reach the provider if the
 * message is forwarded as-is - internal bookkeeping in the model's own conversation. A user
 * turn is sanitised; an assistant turn is passed through apart from dropping the extras.
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
        // Assistant turns are rebuilt as role and content only - see the guardrail above.
        if (msg.role !== 'user') {
            safeMessages.push({ role: msg.role, content: msg.content });
            continue;
        }

        const cleaned = sanitizeInput(msg.content);
        if (await checkPromptInjection(cleaned)) {
            // Refuse rather than pass it through. The prompt sets the same rule,
            // but this holds even if the model is persuaded to ignore it.
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

    // THE QUESTIONS ALREADY ASKED, passed IN rather than read from anywhere global, so
    // `parseModelResponse` stays a pure function of its input and testable with one string.
    //
    // ONLY THE ASSISTANT'S TURNS ARE USEFUL - a participant's answers are not questions - and the
    // list is the model's own words, so the comparison is exact rather than fuzzy. EACH CARRIES THE
    // OPEN-FIELD COUNT FROM WHEN IT WAS ASKED, which is what makes a repeat distinguishable from a
    // stall: fewer fields open means the participant answered something, so a second attempt is
    // legitimate, while an equal count is the six-turn stall this guard exists for. The count comes
    // from the conversation, not stored state; the last question has no answer yet, so it takes the
    // current count.
    const askedBefore = assistantQuestionsWithOpenCounts(messages);

    return parseModelResponse(raw, { askedBefore, messages });
}


/** Pluralises a count for an error message the operator reads. */
function countReason(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The workflows a completion reply carries, from either shape.
 *
 * THE ONE PLACE THAT KNOWS BOTH SHAPES: the interview shape carries `processes`, which is what the
 * prompt asks the model to emit, and the older single-shot shape carries `audit.workflows`. Every
 * consumer reads the payload through here, so none can be updated for one shape and missed for the
 * other - which is how this defect happened. Both are returned as a plain array, so no caller
 * branches.
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
 * Whether a reply carries a payload at all, in either shape.
 *
 * `processes` present but EMPTY is not a payload: an interview that produced no
 * process has produced nothing to score, and treating an empty array as success
 * is how a blank analysis reaches the reader.
 *
 * @param {object} parsed
 * @returns {boolean}
 */
function hasPayload(parsed) {
    const workflows = workflowsFrom(parsed);
    return Array.isArray(workflows);
}

/**
 * Validates an audit payload's workflows.
 *
 * EXPORTED SO BOTH ENTRY POINTS APPLY THE SAME RULE - the model path and `POST /api/score`, which
 * takes the payload straight from the client. Validating only the model path left the direct route
 * able to serve a blank heading, and duplicated checks drift apart.
 *
 * EVERY CHECK BELOW IS LIVE ON THE HTTP PATH, including the one for an entry that is not an object.
 * That check IS unreachable from the INTERVIEW path, where a malformed entry leaves the matrix
 * incomplete so the completion gate returns `asking` first - but `POST /api/score` calls this
 * DIRECTLY, so `{"workflows":[null]}` returns "1 entry is not an object". DO NOT REMOVE IT AS DEAD.
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

    // `title` is the heading the client reads. Requiring it (rather than
    // falling back) keeps a blank heading out of the document; scoring has its
    // own fallback so a direct caller cannot crash, but the route should not
    // accept the payload in the first place.
    const missingTitle = workflows.filter((w) => typeof w.title !== 'string' || w.title.trim() === '');
    if (missingTitle.length > 0) {
        return { ok: false, reason: countReason(missingTitle.length, 'entry has no title', 'entries have no title') };
    }

    return { ok: true };
}

/**
 * What the participant sees when the round ends with nothing answered.
 *
 * HONEST RATHER THAN A CLOSED DOOR. It does not thank them for answers they did not give, and
 * it does not pretend the interview went well - it says what happened, that this is not their
 * failure, and that somebody can follow up. A participant who declined every question has still
 * told the reader something true: the work is not something they can put into words, which is
 * worth knowing.
 */
const NOTHING_ANSWERED_CONTENT =
    'Thank you for your time. We did not manage to capture any answers for this one, so there '
    + 'is nothing to analyse yet. That is not a problem on your side: some work is hard to put '
    + 'into words, and saying so is useful in itself. You can close this page, and someone can '
    + 'follow up with you directly if it is worth a conversation.';

/**
 * The closing question's fingerprint, so a version of it can be recognised.
 *
 * MATCHED AS A PHRASE RATHER THAN BY EXACT TEXT, because a model that asks the closing question
 * early rarely quotes the prompt verbatim: the live run that prompted this said "Is there
 * another process you'd like to improve?" and "Thank you. Is there anything else you would like
 * to look at?" within the same interview. A literal comparison would have caught neither.
 *
 * THE RISK OF A PHRASE MATCH IS A FALSE POSITIVE - a real question about a second process being
 * replaced. That direction is safe: the reply becomes a question the interview asked anyway, and
 * the next turn can still close. The opposite direction leaves the participant staring at "is
 * there another process?" with twelve fields unanswered, which is an abandonment trigger, so it
 * is the risk worth taking.
 */
const CLOSING_QUESTION_SHAPES = [
    // THE ONE PRINCIPLE: A CLOSING QUESTION OFFERS A NEW PIECE OF WORK. A legitimate question is
    // about THIS process - its timing, steps, mistakes, buyer - while a closing question is about
    // ANOTHER one, or about stopping.
    //
    // MEASURED BY THE REVIEWER against 22 realistic questions: 8 were wrongly gated, because
    // `\banything else\b` matched "Is there anything else you would change about THIS step?" and
    // `\b(shall|should|may)\s+(we|i)\b` matched "Should I record the buyer as a separate
    // process?". The harm was not theoretical: the participant was shown "Who else is involved in
    // this?" in place of a specific, well-aimed question.
    //
    // SO EACH PATTERN NOW REQUIRES A NEW PIECE OF WORK AFTER IT, and A MISS RATHER THAN A FALSE HIT
    // is the accepted direction: a closing question that slips through is caught by the prompt,
    // while a replaced legitimate question loses information the model gathered.
    /\b(?:another|any other|more)\s+(?:process|work|task|piece of work|one)\b/i,
    /\bother processes\b/i,
    // `anything else` ONLY when it offers to continue or to stop. The trailing forms are what
    // distinguish the offer from a question about this process.
    // THE OFFER MUST BE THE WHOLE CLAUSE, not merely present in it. "anything else you would
    // change about THIS step" contains `anything else you would` and is about this process;
    // `like`/`want` immediately after `you` is what makes it an offer, so the gap between them
    // is at most two words and the stop-forms are explicit.
    // `you'd`, `we'd` AND the spelled-out forms, and a straight or curly apostrophe: a model
    // writes whichever it likes, and matching only one spelling is how a variant escapes. The
    // apostrophe class covers both characters rather than assuming the plain one.
    /\banything else\s+(?:you|we)(?:['\u2019]d|\s+would)?\s+(?:like|want|wish|add|cover)\b/i,
    /\banything else\s+(?:to add|to cover|before we)\b/i,
    /\bsomething else\b/i,
    // MOVING ON MEANS TO A DIFFERENT PROCESS, NOT THE NEXT STEP OF THIS ONE: matching "move on" alone
    // would gate "Would you like to move on to the next step?", which asks about the current work.
    /\b(?:would|do)\s+you\s+(?:like|want)\s+to\s+(?:\w+\s+){0,2}(?:move on to\s+(?:the next process|another|a new)|continue with\s+(?:another|the next process))\b/i,
    /\b(?:would|do)\s+you\s+(?:like|want)\s+to\s+(?:stop|finish|wrap up|end)\b/i,
    // `shall we move on` IS A CLOSING OFFER even with no object, and THE DISTINCTION IS THE SUBJECT
    // OF THE SENTENCE: "we" moves the conversation somewhere, while "you ... to the next step" asks
    // about one step of the work in front of them.
    /\b(?:shall|should)\s+we\s+(?:stop|finish|wrap|move|continue|go on|press on)\b/i
];

/**
 * Replaces a closing question with a real one when the matrix is not satisfied.
 *
 * IN CODE AND NOT ONLY IN THE PROMPT: the prompt asks the model to reserve the closing question for
 * an empty `missing`, and a live interview was watched asking it FOUR TIMES IN A ROW with twelve
 * fields open. A prompt is a request; this is the rule, and it cannot be talked out of.
 *
 * WHAT THE REPLY BECOMES: the closing question is REPLACED BY A QUESTION ABOUT THE NEXT OPEN FIELD,
 * so the participant is asked something useful rather than shown a closing line that continues.
 * `have` and `missing` are unchanged - only `content` differs - and the client renders it as an
 * ordinary analyst turn, so nothing stalls waiting for `status`.
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

    // THE FIELD'S OWN WORDS, so the question reads like something a person would ask rather
    // than an internal field name. A field with no phrasing falls back to its name, which is
    // still a question the participant can answer rather than a premature goodbye.
    const phrasing = FIELD_QUESTIONS[open];
    console.warn(
        `[audit] the model asked the closing question with ${computed.missing.length} field(s) ` +
        `still open; replacing it with a question about "${open}"`
    );
    return phrasing || `Could you tell me more about "${open}"?`;
}

/**
 * What to say when every open field has already been asked and nothing is moving.
 *
 * A FUNCTION OF THE OPEN FIELDS RATHER THAN A CONSTANT, so it differs each time and is never itself a
 * repeat. A fixed sentence would become the question of record and be replaced by itself on the next
 * turn, which moves the stall from the model to this gate instead of ending it - MEASURED, and the
 * reason this is not a string constant.
 *
 * IT DOES NOT NAME THE FIELDS: `frustration` and `mistakesPerPeriod` are internal names, so the
 * phrasing counts them, which is honest and reads like a person speaking.
 *
 * COUNTING ALONE WAS NOT ENOUGH: a stall leaves `missing` UNCHANGED, so the same count gave the
 * same sentence and the gate repeated itself - MEASURED at turn 18 of a simulation.
 *
 * THE LOOP IS BROKEN AT THE GUARD, NOT HERE. This line returns only on a model repeat, and the
 * caller has seen that exact text - so the participant is never asked a question they answered.
 * The text invites them to add anything and the interview closes on the next completing turn.
 *
 * @param {string[]} open The fields still unsupplied.
 * @returns {string}
 */
function moveOnLine(open) {
    const count = open.length === 1 ? 'one thing' : `${open.length} things`;

    // Counting alone was not enough; see the caveat above.
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
 * TERMINATION DEPENDS ON THIS MARK, and that is why it exists rather than being inferred. The
 * client replays every assistant turn verbatim, substitutes included, so without the mark the
 * gate matches its own previous sentence, replaces it with another, and the loop moves from the
 * model to the gate. With the mark, a substituted question is never a match target, so each turn
 * either passes a model question through or substitutes exactly once.
 *
 * IT IS A PROPERTY OF THE REPLY, not of the transcript: the client pushes `{ role, content }` and
 * this travels beside them, so nothing about the stored conversation changes.
 */
const SUBSTITUTED = true;

/**
 * What the participant sees when the round closes because the interview stopped gaining evidence.
 *
 * TRUE WHETHER THE CAP FIRED ON A STALL OR ON A DIP. It said "I have not been able to record
 * anything new from the last few answers" - a claim about recent turns, MEASURED FALSE about one
 * time in five, because `evidenced` fluctuates and a dip is counted against the peak. So it says
 * what is true in both cases, which is a statement about the interviewer's judgement.
 *
 * IT STILL SAYS THE ANSWERS ARE SAVED AND COUNT, and IT DOES NOT APOLOGISE: an admin may read this
 * page, and a bare apology invites a support conversation nobody can act on.
 *
 * DISTINCT FROM THE OTHER TWO TERMINAL MESSAGES, which a test compares directly: `nothing_answered`
 * means they declined everything, `exhausted` means every question was asked, and this one means the
 * interview stopped gaining.
 */
const EVIDENCE_CAP_CONTENT =
    'Thank you - let us stop here. I have everything I can usefully take from this one, so rather '
    + 'than keep asking I will work with what you have told me. Everything you gave is saved, and '
    + 'it counts. Someone can follow up with you if there is more to capture.';

/**
 * HOW MANY TURNS THE INTERVIEW MAY GO WITHOUT GAINING ANY EVIDENCE.
 *
 * THE NET UNDER THE WHOLE GUARD: oscillation, claim churn, the all-fifteen loop, rewording and
 * echo/rotation all have the same shape - the interview is not gaining evidence - so a cap on turns
 * catches every one of them and whatever the sixth turns out to be. That is why it is a property of
 * the CONVERSATION rather than a sixth text heuristic, three of which produced false positives.
 *
 * TWENTY IS MEASURED, not guessed: a completing run took 6-31 turns; the mock went SIX with no new
 * evidence and then gained fourteen fields at once; stalled runs ran 100-200 and never gained again;
 * and a run gaining a field every EIGHT turns reached a TWELVE-turn plateau, because `evidenced`
 * counts the effort pair as two fields. THAT IS WHY TWELVE WAS TOO TIGHT.
 *
 * THE COST IS NAMED: a stuck participant sees up to twenty questions. Cutting off a working
 * interview loses evidence the participant gave; a longer wait on a broken one costs patience.
 */
const TURNS_WITHOUT_EVIDENCE_CAP = 20;

/**
 * How many consecutive turns the conversation has gone without gaining evidence.
 *
 * DERIVED FROM THE CONVERSATION, NOT CARRIED AS STATE, and that is the same principle as the
 * evidence-over-claims fix. Every assistant turn the client replays already carries `evidenced` -
 * the payload's own proof at that moment - so walking the turns gives the count. A counter the
 * client kept and the server trusted would be a CLAIM, and a claim is exactly what this guard
 * exists to stop reading as progress.
 *
 * A TURN WITH NO `evidenced` IS SKIPPED RATHER THAN COUNTED, because a conversation recorded
 * before the field existed cannot be judged, and treating absence as "no evidence" would end a
 * healthy interview at the first replay.
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

        // A TURN THE SERVER WROTE ALWAYS CARRIES SOMETHING WE CAN JUDGE FROM, so an absent
        // `evidenced` on such a turn means the client did not send it - not that the turn is
        // unjudgeable. That is read as [] rather than skipped, which is the difference between a
        // working cap and none.
        //
        // WHY IT MATTERS: this is the LAST mechanism, so a client that omits the field would make
        // every earlier guard unreachable again and the interview would run forever, silently.
        // Measured before this change: `evidenced` replayed -> the cap fires; `evidenced` omitted
        // -> the cap never fires. `missing` and `substituted` are the server's own fields, so
        // seeing either proves the turn came from this server and had an `evidenced` to omit.
        //
        // A BARE USER TURN, AND A TURN WITH NO SERVER FIELDS AT ALL, ARE STILL SKIPPED. That is
        // what keeps this from treating a conversation recorded before the field existed - or one
        // the client built by hand for a test - as a stalled one.
        const fromThisServer = Array.isArray(message.missing) || message.substituted !== undefined;
        if (fromThisServer) counts.push(0);
    }

    // NOTHING TO JUDGE YET. A conversation with no turns the server wrote is left alone, so a new
    // interview and a hand-built fixture both start uncapped.
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
 * Whether every field's question has appeared in the conversation.
 *
 * THE MONOTONIC HALF OF EXHAUSTION: the number of DISTINCT FIELD QUESTIONS ASKED only grows, so once
 * this is true it stays true - where a comparison against the open field set, which the model can
 * vary every turn, can be defeated indefinitely.
 *
 * LIMITED TO THE FIELDS CURRENTLY OPEN, which is the fix for a residual stall rather than a
 * convenience. REQUIRING ALL FIFTEEN was too strong: a field the model CLAIMS to hold is never
 * offered as a question, so its phrasing never enters and exhaustion can never fire - MEASURED
 * with a churning model claiming task/trigger/steps, 12 of 15 asked then the move-on line
 * indefinitely. The monotonic property survives: this runs only on a repeat with no progress.
 *
 * AN EMPTY OPEN SET IS NOT THIS FUNCTION'S CALL: `missing` empty with `supplied` empty is
 * `nothing_answered`, and `missing` empty with evidence is a completed round. Both are decided
 * before this is reached.
 *
 * A FIELD WITH NO PHRASING IS NOT COUNTED, deliberately: comparing against the questions that EXIST
 * rather than a fixed fifteen means a field added without a question cannot make this never true.
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
 * Replaces a question the conversation has already asked, when nothing has moved since.
 *
 * THE STALL THIS EXISTS FOR, MEASURED on a live interview: the model asked ONE field's question
 * for six consecutive turns while `missing` held six others, byte-identically each time. The
 * two-attempt cap is a PROMPT rule the model enforces on itself, and it did not.
 *
 * BOTH CONDITIONS MUST HOLD: the content is IDENTICAL to a question already asked, AND `missing`
 * has not shrunk since. Asking twice is legitimate - the prompt allows one rephrase - so the
 * second condition stops this firing on a legitimate repeat.
 *
 * ONLY THE MODEL'S OWN REPEATS ARE GUARDED. A substitute this function wrote is never matched,
 * because matching it is the gate arguing with itself: it would replace its own sentence turn
 * after turn, moving the loop from the model to the gate rather than ending it - MEASURED at
 * turn 18 of a simulation. A GATE SENTENCE THE MODEL ECHOED IS STILL THE GATE'S: the mark is
 * carried by the TEXT, not by which branch it arrived through, or the same sentence reaches a
 * participant twice (every duplicate in a live run was a consecutive pair). An echoed gate
 * sentence with no progress is REPLACED, not re-issued - the `substituted` exemption is about
 * not arguing with itself, and the echo is the defect.
 *
 * PROGRESS IS MEASURED FROM EVIDENCE, NOT FROM A CLAIM. Comparing `computed.missing` is wrong
 * mid-interview because it is built partly from the model's own `have` claim: a model that
 * re-partitions what it CLAIMS shrinks `missing` while nothing is recorded. MEASURED: `have +
 * missing` stayed fifteen, `missing` fell 8 -> 6 -> 1 with nothing stored, and thirty-one
 * identical questions passed the guard in a row. `evidenced` is what a churning model cannot
 * move. The `openCount` branch is a NARROW FALLBACK for a fixture or a conversation recorded
 * before `evidencedCount` existed - reading "no evidence data" as "no progress" there would turn
 * a legitimate second attempt into a wall.
 *
 * EVERY OPEN FIELD ASKED LEAVES NOTHING TO SUBSTITUTE, so the MOVE-ON LINE is used. It carries
 * the fields it moves on from and is sent ONCE - a second would be the gate repeating itself.
 * WHAT REACHES THAT PATH: no field question is left, but not every field has had its question -
 * one with no entry in FIELD_QUESTIONS, or one the model keeps claiming open. THE INTERVIEW
 * CLOSES THERE, which terminates this path; the prompt already sanctions it, and it is NOT
 * `nothing_answered`, which would lie to a participant who answered plenty.
 *
 * IT TERMINATES BECAUSE IT ONLY EVER MOVES TO AN UNASKED FIELD, of which there are fifteen, so the
 * available questions strictly decrease.
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

    // See the gate-owned note above.
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

    // EXHAUSTION IS DECIDED BY WHAT HAS BEEN ASKED, NOT BY WHAT IS OPEN, because a comparison against
    // the open set is not monotonic: a model that rotates its payload produces a new set every turn
    // and exhaustion is never recognised. MEASURED against a rotating set: 25 turns where 15 were
    // enough, unbounded under faster rotation, and 40 in the reviewer's live capture.
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
        // The move-on line; see the closing note above.
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
 * How to ask about each field in words a participant recognises.
 *
 * A COSMETIC TABLE, not a rule: the interview's own prompt phrases these better, and this only
 * ever runs when the model closed early. Kept beside the guard that uses it so the two are read
 * together.
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
 * Parses and validates the model's JSON reply.
 *
 * Exported so it is unit testable without a provider. Malformed JSON is an expected failure, so it
 * becomes a structured error the UI can show rather than an exception.
 *
 * WHICH SHAPE IS AUTHORITATIVE IS DECIDED AS `workflowsFrom` DECIDES IT, so the validation and
 * the payload cannot disagree about which array counts.
 *
 * AN EMPTY `audit.workflows` IS PINNED FROM TWO DIRECTIONS. Alone it is unusable - an empty
 * audit is not a completed audit and the client would score nothing. Beside a good `processes`
 * array it is merely stale, and `processes` must win, because that is what the interview writes
 * while `audit` is the older shape it also emits. Emptiness is judged only when there is nothing
 * better to fall back to.
 *
 * EACH SHAPE IS VALIDATED AGAINST ITS OWN REQUIREMENTS. Checking only `status === 'complete'`
 * against the FINAL payload's requirements killed real interviews: `workflowsFrom` prefers
 * `processes`, whose field matrix never mentions `id` or `title`, so a finished interview was
 * refused with "1 entry has no id" - MEASURED on a real deepseek run. `audit.workflows` keeps the
 * stricter check because it is what the scorer consumes.
 *
 * THE MATRIX DECIDES COMPLETION. `status` is read for the payload, but whether the interview is
 * over is computed from `processes`: `missing` empty is the only thing that finishes it. A model
 * claiming `complete` with a field absent is downgraded to `asking`, which is the safe direction -
 * one more question rather than a dropped field.
 */
export function parseModelResponse(raw, { askedBefore = [], messages = [] } = {}) {
    // PARSED OUT OF PROSE, not handed to JSON.parse.
    //
    // DeepSeek's JSON mode returns whitespace as a conversation grows, so that
    // provider is asked in plain mode and its replies arrive with the object
    // somewhere inside them, often in a ```json fence. The prompt still demands
    // JSON and nothing outside it; the extractor is what makes a fence or a stray
    // sentence survivable rather than fatal. See ai/json-extract.js and
    // NOTES-deepseek-json-mode.md.
    //
    // A reply with NO object is reported as unreadable rather than parsed into a
    // fragment, so a silently empty model response surfaces as a clear error
    // instead of a downstream field access that fails for no visible reason.
    const parsed = extractJsonObject(raw);
    if (parsed === null) {
        // WHAT CAME BACK IS LOGGED, not just that it was unreadable. The message
        // alone ("returned an unreadable response") sent an earlier investigation
        // back to the live API to find out what the model had actually said, when
        // the answer was a bare prose question. Truncated at 120 characters: enough
        // to see the shape, short enough not to dump a whole reply into the log.
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

    // The model's claim and the computed truth, side by side. While the interview
    // is running the claim is believed for anything the payload does not yet
    // carry (the payload is a stub early on); on completion only the payload
    // counts, so a claimed field cannot let a real gap vanish. See
    // reconcileMatrix for the full rule.
    const processes = Array.isArray(parsed.processes) ? parsed.processes : [];
    const claimedHave = Array.isArray(parsed.have) ? parsed.have : null;
    const claimedMissing = Array.isArray(parsed.missing) ? parsed.missing : null;

    const computed = reconcileMatrix({
        processes,
        claimedHave,
        claimedMissing,
        closing: parsed.status === 'complete'
    });

    // `stepsStillNeed` IS DERIVED HERE AND THE MODEL'S OWN VALUE IS DELETED. `steps` is the only
    // field whose completeness gate sits inside a container, so a participant who answers the basis
    // question before the step has a label moves nothing: `steps` stays in `missing` and the
    // interviewer re-asks in different words, MEASURED three times in one interview. This says WHICH
    // step fields are absent, so the next question can differ.
    //
    // THE MODEL MUST NOT SUPPLY IT, because it is computed from `processes` and a model that claimed
    // it would contradict the matrix that computed it. THE DELETION IS RECURSIVE, which is the fix
    // for a real hole: deleting only the top-level key let
    // `processes: [{ ..., stepsStillNeed: ["HOSTILE"] }]` survive, and the client persists the
    // payload verbatim, so the model's string reached the participant's STORED answers.
    const stripped = stripDerivedFields(parsed, DERIVED_FIELDS);
    if (stripped > 0) {
        console.warn(
            `[audit] the model sent ${stripped} derived field value(s) ` +
            `(${DERIVED_FIELDS.join(', ')}), which are computed from the payload and not the ` +
            'model\'s to report; discarded at every depth and replaced with the computed value'
        );
    }

    // THE UNION ACROSS INCOMPLETE STEPS. The consumer is ONE question for the whole
    // conversation, so what it needs is the set of fields that would move some step
    // forward. A per-step breakdown would name `name` for one step while another needs
    // `needsReasoning`, and choosing between them is a decision this layer cannot make
    // well. Computed across every process, because a question is asked about the
    // interview rather than about one process.
    //
    // EMPTY WHEN NO STEP IS INCOMPLETE, which coincides with `steps` leaving `missing`.
    // The two are separate signals from one value: this one says what to ask next, and
    // `stepIsComplete` still alone decides whether the interview may close.
    const stepsStillNeed = [...new Set(processes.flatMap((process) => stepGapsFor(process && process.steps)))];
    // The matrix decides completion ONLY when the model is playing the matrix
    // game. A reply carrying `processes` is an interview turn and its field list
    // is authoritative; a reply with a valid `audit` and no `processes` is the
    // older single-shot shape, which has already supplied everything the
    // downstream payload needs. Judging that shape by the matrix would refuse a
    // complete audit for having no `frustration` field, which is not this
    // function's business.
    const playingTheMatrix = processes.length > 0 || claimedMissing !== null;

    // COMPLETION READS `supplied`, NOT `missing`, AND THE DIFFERENCE IS ONE STATE.
    //
    // `missing` empty means there is no question left to ask. That is NOT the same as having
    // evidence: a field the participant DECLINED is answered-but-unsupplied, so it leaves
    // `missing` and does not enter `supplied`. Reading `missing` here would let an interview
    // complete on nothing but refusals - measured on a live run, which recorded
    // `{"said":"I have no idea"}` against seven fields and closed. See declinedIn in
    // field-shapes.js.
    //
    // A MISSING FIELD STILL BLOCKS, as it always did, so nothing is loosened for the ordinary
    // case: this is a strictly tighter gate.
    const matrixComplete = computed.supplied.length === computed.have.length
        && computed.missing.length === 0
        && processes.length > 0;

    // NOTHING WAS ANSWERED, SO THE INTERVIEW ENDS AS "NOTHING ANSWERED".
    //
    // AN ALL-DECLINED ROUND IS A FIXED POINT WITHOUT THIS, MEASURED: every field declined leaves
    // `have` full and `supplied` empty, so the model has nothing to ask and the completion gate
    // never opens - every turn returns BYTE-IDENTICAL `asking` output forever.
    //
    // `submitted_at` IS SET AND THE STATUS IS NOT `complete`: the round has to END and
    // `submitted_at` is the store's only way to say so, but `complete` would be a lie the roadmap
    // renders. TO EACH READER: the client finalises and does not score; the console shows every
    // field "not answered", which is a FINDING - asked, and nobody knew - rather than a gap; nothing
    // reaches the roadmap, because a process is only created by identification.
    //
    // NOT AN ESCAPE HATCH: a model that declined everything to finish early gains nothing, since
    // declined fields carry no evidence. THE SCHEMA NEEDS NO CHANGE - this is a property of the
    // conversation, not of the row.
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

    // THE EVIDENCE CAP, CHECKED BEFORE ANY QUESTION IS CONSIDERED. IT SITS ABOVE THE EXACT-TEXT GUARD
    // ON PURPOSE, because that guard cannot see a REWORDED repeat: the model appending " (part 2)" is
    // never a match target, so the guard never fires, the `evidenced` comparison is never reached,
    // and the interview runs indefinitely - MEASURED at 120 turns with a two-field payload.
    //
    // IT CLOSES THE ROUND RATHER THAN SUBSTITUTING: after a long run without evidence there is
    // nothing left worth asking, because whatever the model is doing it is not recording answers.
    //
    // AND IT MUST NOT PRE-EMPT COMPLETION, MEASURED IN THREE SEPARATE LIVE RUNS: `evidenced`
    // plateaued while `missing` reached zero, so the cap ran first and the participant was told "I
    // have not been able to record anything new" - WHICH WAS FALSE, because the tool had recorded
    // everything and was finished. The `missing.length > 0` condition below is that guard.
    //
    // THE COUNTER CANNOT BE TRUSTED ALONE: `evidenced` is NOT monotonic in practice, because the
    // model rewrites `processes` each turn and drops fields it had filled, so this counter can
    // report a long plateau during a healthy interview. `missing` is the authoritative signal.
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
        // The model thinks it is done and the matrix disagrees. Continue rather
        // than closing: one more question is cheap, a missing field is not.
        const unsupplied = computed.have.filter((field) => !computed.supplied.includes(field));
        const reasons = [];
        if (computed.missing.length > 0) reasons.push(`${computed.missing.length} still missing (${computed.missing.join(', ')})`);
        if (unsupplied.length > 0) reasons.push(`${unsupplied.length} declined (${unsupplied.join(', ')})`);
        console.warn(`[audit] model claimed complete with ${reasons.join(' and ')}; continuing`);
        // THE SAME TWO GUARDS AS THE FINAL RETURN, and for the same reason: a reply downgraded
        // from `complete` is still a reply the participant reads, and a repeated question in it
        // stalls the interview exactly as one anywhere else does.
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

    // VALIDATE AT THE BOUNDARY: without this the browser posts a malformed payload to /api/score,
    // gets a 400, and shows a generic network error for what is a model contract violation.
    //
    // EACH SHAPE IS VALIDATED AGAINST ITS OWN REQUIREMENTS, and getting that wrong killed real
    // interviews: the code checked only `status === 'complete'` against the FINAL payload's
    // requirements, while `workflowsFrom` prefers `processes`, whose field matrix never mentions
    // `id` or `title` - so a finished interview was refused with "1 entry has no id". MEASURED on a
    // real deepseek run. `audit.workflows` is the payload the scorer consumes, so it keeps the
    // stricter check, and `workflowsFrom` resolves the same way so the two cannot disagree.
    //
    if (parsed.status === 'complete') {
        // Which shape is authoritative; see the note above.
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
            // The interview shape, already judged by the matrix. A process here with
            // fields missing is not an ERROR - it is an interview that has not finished,
            // and the completion gate above has already downgraded it to `asking` and
            // named what is absent. So nothing is refused for incompleteness here; only
            // a shape that cannot be read at all is a fault.
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

    // The reported lists are the model's; the computed ones are the server's. A
    // discrepancy is logged, because it means the prompt is not being followed,
    // and the computed pair is what callers read.
    if (claimedMissing && claimedMissing.length !== computed.missing.length) {
        console.warn(
            `[audit] the model reported ${claimedMissing.length} missing field(s) and the matrix ` +
            `computes ${computed.missing.length}; using the computed list`
        );
    }

    // THE PAYLOAD IS NORMALISED FROM THE BEST AVAILABLE SOURCE, decided on CONTENT rather than
    // nullness: if a usable workflows array exists anywhere, it wins and is wrapped.
    //
    // NOT `parsed.audit ?? normalise(processes)`, which kept `parsed.audit` whenever it was merely
    // NON-NULL - so `audit: { workflows: [] }` passed `??` and reached the client as an empty list,
    // which /api/score rejected with a 400 and the participant saw the scoring-failed panel after a
    // successful interview.
    //
    // `workflowsFrom` IS THE ONLY RESOLVER, and that is why there is no fallback
    // arm here. There used to be one, `: parsed.audit`, which read as a safety net;
    // it was unreachable. `workflowsFrom` already returns `parsed.audit.workflows`
    // when that is the only source, so `best` is an array in every case that
    // reaches this line: a `complete` reply without a payload returned earlier, and
    // an `asking` reply's `audit` field is meaningless. An arm that cannot run
    // while looking like protection is worse than no arm, because it suggests a
    // case is handled that nothing has ever exercised.
    const best = workflowsFrom(parsed);

    // THE TWO QUESTION GUARDS, IN ORDER. The closing-question rule first, because a repeated
    // closing line is a closing line; then the repeat guard, which sees the substituted text and
    // can therefore catch a substitute that is itself a repeat - it never does, because a
    // substitute is marked, but the order means no path escapes both.
    const question = withoutRepeatedQuestion(
        withoutClosingQuestion(parsed.content, computed),
        computed,
        askedBefore
    );

    return {
        ...parsed,
        // ABSENT WHEN THERE IS NOTHING TO NORMALISE, rather than `{}`. With no
        // workflows, `normaliseProcessesPayload` builds `{ workflows: undefined }`,
        // which serialises to an empty object, and AN EMPTY OBJECT IS TRUTHY: a
        // caller using the `data.audit || ...` idiom the client already uses would
        // take `{}` and find `.workflows === undefined`. That is the same subtle
        // class of defect this file has been fixed for twice. On an `asking` turn
        // there is no payload and no `audit` key at all.
        audit: Array.isArray(best) ? normaliseProcessesPayload(parsed, best) : undefined,
        // THE CLOSING QUESTION IS SUPPRESSED HERE, WHICH IS THE ONE PLACE EVERY REPLY PASSES
        // THROUGH, and the fix for a real escape. It used to be applied only inside the
        // "claimed complete and the matrix disagreed" branch - so a model that asked the
        // closing question while reporting `status: "asking"` was never checked at all, and
        // that is the ordinary way the defect appears: the live interview watched asking it
        // four times in a row was doing exactly this, not claiming completion. A gate on one
        // branch of one status is a gate that most of the traffic goes around.
        //
        // It is a no-op when the question is genuine and the matrix is satisfied, which is the
        // case the prompt asks for, and when the content is an ordinary question.
        //
        // AND THE REPEAT GUARD RUNS FIRST, because a repeated question is a question whatever
        // it is about: a closing line that repeats is caught here too, and only a first-time
        // closing line reaches the rule below.
        content: question.text,
        // TRUE WHEN THE GATE HAS RUN OUT OF QUESTIONS, which the client treats as the end of the
        // round: every field has been asked, the participant has answered, and what is still open
        // cannot be settled by asking again. The round finalises on what was supplied.
        exhausted: question.exhausted === true,
        // THE PAYLOAD'S OWN EVIDENCE, sent so the next turn can tell real progress from a
        // change in what the model CLAIMS. A reply without it reads as no progress.
        evidenced: computed.evidenced,
        // TRUE WHEN THIS GATE WROTE THE QUESTION rather than the model. The client replays every
        // assistant turn, so without this flag the gate would match its own substitute on the
        // next turn and the loop would move from the model to the gate. Termination rests on it:
        // a substituted question is never a match target, so a stalled conversation re-asks no
        // question it has already asked.
        substituted: question.substituted,
        have: computed.have,
        missing: computed.missing,
        stepsStillNeed,
        processes
    };
}

/**
 * Wraps a workflows array in the payload shape the client reads.
 *
 * The interview shape carries a bare array under `processes`; the client wants an object with
 * `workflows`, and optionally `illustrative` and `note`. An unknown model yields a payload with
 * neither flag, which reads as "not illustrative" - the correct default for a real interview.
 *
 * THE FLAGS ARE READ FROM EITHER PLACE a model might put them, the top level or an `audit` envelope
 * it also sent. The envelope is not preferred for the workflows themselves, which came from the
 * best source, but its labels are worth taking rather than dropping.
 *
 * @param {object} parsed The parsed reply, which may carry the flags.
 * @param {Array<object>} workflows A non-empty array, already resolved.
 * @returns {object}
 */
function normaliseProcessesPayload(parsed, workflows) {
    // THE ONE PLACE THE INTERVIEW PAYLOAD IS BUILT, so this is the one place the `id` and `title`
    // the scorer requires are supplied. `workflowsFrom` resolves the payload from `parsed.processes`
    // on a live interview, and the prompt's `processes` example carries NEITHER field, so without
    // this the participant's own answers reached `/api/score` without them and were refused with a
    // 400 and "The analysis could not be computed." See `ai/workflow-identity.js` for why the
    // fields are generated rather than the validator relaxed, and for how stability is guaranteed.
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
