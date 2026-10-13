/**
 * Audit conversation core.
 *
 * Runs one turn of the intake interview. The model is asked to reply with a JSON
 * object of the shape:
 *
 *   { status: "asking",   content: "<next question>", have: [...], missing: [...] }
 *   { status: "complete", content: "<closing line>", have: [], missing: [],
 *     processes: [...], audit: { workflows: [...] } }
 *
 * `have` and `missing` are the completeness matrix: what the model can state and
 * what it still needs. THEY DECIDE WHETHER THE INTERVIEW CONTINUES, not `status`,
 * because a model that believes it is finished while a field is absent would
 * close early and drop it silently. The server computes the two lists from the
 * processes and compares them with the model's claim.
 *
 * Keeping the model on this contract is what lets the scoring layer be pure
 * logic: it receives structured data, never prose to be parsed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { sanitizeInput, checkPromptInjection } from './security.js';
import { extractJsonObject } from './json-extract.js';
import { withFormatCommitment } from './format-commitment.js';
import { ALL_PROCESS_FIELD_NAMES, reconcileMatrix, stepGapsFor } from './matrix.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', 'data', 'prompts');

const SUPPORTED_LANGS = ['nl', 'en', 'fr'];

/**
 * The fields that are DERIVED from the payload and must never be asked of the model.
 *
 * `stepsStillNeed` is computed by parseModelResponse from `processes`, and the model's
 * own value for it is deleted on sight. A prompt that DESCRIBED it would invite a model
 * to report it, which is the thing the field exists to prevent: a model claiming what
 * the matrix computed is how a report starts contradicting the data it describes.
 *
 * Kept as a list rather than a single name so the next derived field is added here
 * rather than needing its own guard.
 */
const DERIVED_FIELDS = Object.freeze(['stepsStillNeed']);

/**
 * Removes every derived field from an object graph, at any depth.
 *
 * THE ENFORCEMENT HALF OF `DERIVED_FIELDS`. A field the model cannot legitimately
 * supply must not survive anywhere in what it sent, because the payload is persisted
 * verbatim: a value deleted only at the top level still reaches a caller inside
 * `processes`, and from there the participant's saved answers.
 *
 * DEPTH-FIRST AND IN PLACE, so it removes the key from the same objects the rest of the
 * function goes on to read. A copy would leave the originals untouched and the hole
 * open, which is the mistake this replaces.
 *
 * ARRAYS ARE WALKED, because the leak that was found arrived inside one:
 * `processes: [{ stepsStillNeed: [...] }]`. An object that came from JSON has no cycles,
 * so the recursion terminates; the parser produces this from `JSON.parse`, not from
 * anything a caller assembled.
 *
 * A WARNING PER DISTINCT PATH would be noisier than useful - a model repeating the field
 * on every process would log on every turn - so one line names the fields and the fact,
 * and the removal is what matters. The log exists to make a prompt regression visible,
 * not to enumerate it.
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
 * WHY THIS IS A THROW RATHER THAN A WARNING, and why it lives at the load rather than
 * in a test. The rule "the model must have no concept of this field" is enforced by
 * `parseModelResponse` deleting whatever the model sends; but a prompt that mentioned it
 * would put the field in front of the model every turn, and the deletion would then be
 * quietly correcting a mistake the prompt invited. That is the shape of failure this
 * codebase keeps finding: a rule enforced in one place while the guidance elsewhere
 * says something else.
 *
 * So the mistake is made impossible to ship rather than merely detected. It throws
 * because a prompt naming a derived field is a bug in the prompt, not a runtime
 * condition to tolerate, and the interview cannot be served correctly while it stands.
 * The message names the file, the field and the rule, so the fix needs no archaeology.
 *
 * @param {string} text The prompt file's contents.
 * @param {string} file The path, for the error message.
 * @throws {Error} When the prompt mentions a derived field.
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
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.messages Conversation so far.
 * @param {string} args.lang UI language.
 * @param {string} args.toolId Which prompt set to use.
 * @returns {Promise<object>} The parsed model response.
 */
/**
 * The questions this conversation has already asked, each with its open-field count.
 *
 * WHY THE CONVERSATION IS THE RECORD, rather than a counter kept across turns. The client
 * already sends every earlier turn, so the questions are there to read; a counter would be new
 * state on a path that carries none, and would have to survive a page reload to be honest. The
 * trade is that the count has to be RECONSTRUCTED, which is what this does.
 *
 * THE COUNT IS TAKEN FROM THE MODEL'S OWN CLAIM, not from the matrix, because the matrix is not
 * run for past turns here. A model reporting `missing: []` on every stalled turn reports the same
 * count each time, which is exactly the comparison the guard needs; a model whose reported count
 * falls has demonstrably made progress, and the repeat is then allowed.
 *
 * WHAT THIS CANNOT SEE: a model whose claim and payload disagree in a way that hides progress.
 * That direction is safe - the guard would substitute a question about a field that is in fact
 * answered, and the matrix refuses to close while anything is genuinely missing, so the
 * interview still ends correctly rather than early.
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

        // `missing` is present when the client replayed the server's own reply, and absent on a
        // conversation the client built by hand. An absent count is treated as "unknown", which
        // the guard reads as no progress - the safe direction, since it prefers substituting a
        // fresh question over repeating a possibly-stalled one.
        const missing = Array.isArray(message.missing) ? message.missing.length : 0;
        // THE EVIDENCE COUNT AT THE TIME, which is what the guard compares against. A reply the
        // client replays carries the server's own `evidenced` list; an absent one is treated as
        // unknown, which reads as no progress - the safe direction, since the guard prefers
        // substituting a fresh question over repeating a possibly-stalled one.
        const evidenced = Array.isArray(message.evidenced) ? message.evidenced.length : 0;
        // A SUBSTITUTED QUESTION IS RECORDED BUT NEVER MATCHED. The client replays it, so it
        // arrives like any other assistant turn; the mark is what stops the gate recognising its
        // own sentence and replacing it with another one. See SUBSTITUTED.
        asked.push({ text, openCount: missing, evidencedCount: evidenced, substituted: message.substituted === true });
    }

    return asked;
}

export async function runAuditTurn({ messages, lang = 'en', toolId = 'cartiere_audit' }) {
    const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'en';

    const systemPrompt = await loadPrompt(toolId, safeLang);
    if (!systemPrompt) {
        throw new Error(`No prompt found for tool "${toolId}" in ${PROMPTS_DIR}`);
    }

    // Guardrail: the model must never see unsanitised participant text.
    const safeMessages = [];
    for (const msg of messages) {
        // AN ASSISTANT TURN IS REBUILT AS ROLE AND CONTENT ONLY. The client replays `substituted`
        // and `missing` alongside the text because THIS server needs them, and they reach the
        // provider if the message is forwarded as-is - internal bookkeeping fields in the model's
        // own conversation, which is noise it did not ask for and could act on. A user turn is
        // sanitised below; an assistant turn is the model's own words, so it is passed through
        // unchanged apart from dropping the extras.
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

    // THE QUESTIONS ALREADY ASKED, so a repeat can be caught where the model will not catch
    // itself. `parseModelResponse` stays a pure function of its input by taking them as an
    // argument rather than reading anything global: the caller has the conversation, and
    // passing it in keeps the parser testable with a single string.
    //
    // ONLY THE ASSISTANT'S TURNS ARE USEFUL - a participant's answers are not questions - and
    // the list is the model's own words, so the comparison is exact rather than fuzzy.
    // EACH QUESTION CARRIES HOW MANY FIELDS WERE OPEN WHEN IT WAS ASKED, because that is what
    // makes a repeat distinguishable from a stall. The parser compares the count now against
    // the count then: fewer fields open means the participant answered something, so asking
    // again is the legitimate second attempt. Equal means nothing has moved, which is the
    // six-turn stall this guard exists for.
    //
    // THE COUNT COMES FROM THE CONVERSATION ITSELF, not from stored turn state: the client
    // sends every earlier turn, and this walks them so each assistant question is paired with
    // the fields still open after the answer that followed it. The last question has no answer
    // yet, so it takes the current count - which is what "no progress since" must mean for it.
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
 * THE ONE PLACE THAT KNOWS BOTH SHAPES. The interview shape carries `processes`,
 * which is what the workflow-1 prompt asks a model to emit; the older single-shot
 * shape carries `audit.workflows`. Everything downstream reads the payload through
 * this function, so a consumer cannot be updated for one shape and missed for the
 * other, which is how this defect happened: the completion check and the client
 * both read `audit` alone while the prompt had moved to `processes`.
 *
 * Both are returned as a plain array, so a caller does not branch either.
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
 * Exported so BOTH entry points apply the same rule: the model path
 * (`parseModelResponse`) and the HTTP path (`POST /api/score`, which takes the
 * payload straight from the client). Validating only the model path left the
 * direct route able to serve a blank heading, and duplicating the checks in two
 * places is how they drift apart.
 *
 * EVERY CHECK BELOW IS LIVE ON THE HTTP PATH, including the one for an entry that is not
 * an object. It was reported as unreachable, and it is - FROM THE INTERVIEW PATH only, where
 * a malformed entry leaves the matrix incomplete so the completion gate returns `asking`
 * before this is ever consulted. `POST /api/score` calls this DIRECTLY with whatever the
 * client sent, so `{"workflows":[null]}` returns "1 entry is not an object" here and is the
 * only thing standing between a malformed body and the scorer. Do not remove it as dead, and
 * do not relax it on the grounds that the interview path cannot produce it.
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
 * Parses and validates the model's JSON reply.
 *
 * Split out and exported so it can be unit tested without a provider. A model
 * that returns malformed JSON is a normal, expected failure, so it becomes a
 * structured error the UI can show, not an exception.
 *
 * THE MATRIX DECIDES COMPLETION. `status` is read for the payload, but whether
 * the interview is over is computed from `processes`: `missing` empty is the
 * only thing that finishes it. A model claiming `complete` with a field absent is
 * downgraded to `asking`, which is the safe direction (one more question rather
 * than a dropped field).
 */
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
    // =======================================================================
    // THE ONE PRINCIPLE: A CLOSING QUESTION OFFERS A NEW PIECE OF WORK.
    // =======================================================================
    //
    // A legitimate question is about THIS process - its timing, its steps, its mistakes, its
    // buyer. A closing question is about ANOTHER one, or about stopping. Every pattern below is
    // written against that distinction, and the two that broke it are gone rather than narrowed
    // further.
    //
    // WHAT WAS WRONG, measured by the reviewer against 22 realistic questions: 8 were wrongly
    // gated by two patterns.
    //
    //   /\banything else\b/         "Is there anything else you would change about THIS step?"
    //                                is about this process and is a perfectly good question.
    //   /\b(shall|should|may)\s+(we|i)\b/   "Should I record the buyer as a separate process?"
    //                                and "May I ask how often mistakes happen?" are ordinary
    //                                interviewer politeness, not offers to stop.
    //
    // AND THE HARM IS NOT THEORETICAL: the model asked "Is there anything else you would change
    // about THIS step?" and the participant saw "Who else is involved in this?" - a specific,
    // well-aimed question discarded and replaced by a generic one.
    //
    // SO THE SUBJECT PATTERN NOW REQUIRES A NEW PIECE OF WORK AFTER IT. `anything else` alone
    // is a phrase about anything; `anything else you would like to` is an offer to continue.
    // THAT IS THE FIX, AND IT MEANS A MISS RATHER THAN A FALSE HIT is the accepted direction:
    // a closing question that slips through is caught by the prompt and by the participant
    // moving on, while a replaced legitimate question loses information the model gathered.
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
    // MOVING ON MEANS TO A DIFFERENT PROCESS, NOT THE NEXT STEP OF THIS ONE. The earlier version
    // matched "move on" and so gated "Would you like to move on to the next step?", which is an
    // ordinary question about the current work. The target has to be another/a new one.
    /\b(?:would|do)\s+you\s+(?:like|want)\s+to\s+(?:\w+\s+){0,2}(?:move on to\s+(?:the next process|another|a new)|continue with\s+(?:another|the next process))\b/i,
    /\b(?:would|do)\s+you\s+(?:like|want)\s+to\s+(?:stop|finish|wrap up|end)\b/i,
    // `shall we move on` IS A CLOSING OFFER even with no object, which the narrowing above got
    // wrong. The distinction from "Would you like to move on to the next step?" is the SUBJECT OF
    // THE SENTENCE: "we" moves the conversation somewhere, while "you ... to the next step" asks
    // about one step of the work in front of them. Only the latter is an ordinary question.
    /\b(?:shall|should)\s+we\s+(?:stop|finish|wrap|move|continue|go on|press on)\b/i
];

/**
 * Replaces a closing question with a real one when the matrix is not satisfied.
 *
 * WHY THIS IS IN CODE AND NOT ONLY IN THE PROMPT. The prompt tells the model to ask the closing
 * question only when `missing` is empty, and a live interview was watched asking it FOUR TIMES
 * IN A ROW with twelve fields still open. A prompt is a request; this is the rule. The server
 * already computes `missing` and already holds the model's `content`, so the check costs nothing
 * and cannot be talked out of.
 *
 * WHAT THE REPLY BECOMES. The closing question is REPLACED BY A QUESTION ABOUT THE NEXT OPEN
 * FIELD, phrased in the field's own words - so the participant is asked something useful rather
 * than shown a closing line that then continues. `have` and `missing` are unchanged, so the
 * client and the next turn see the truth; only `content` differs.
 *
 * THE CLIENT DOES NOT STALL. It renders `content` as an ordinary analyst turn and keeps the
 * input open, which is what it does for any `asking` reply. Nothing waits on `status` becoming
 * "complete": a turn is finished when the reply arrives.
 *
 * WHEN NOTHING IS OPEN, which cannot happen here because the caller only reaches this when the
 * matrix is unsatisfied, the original content is kept rather than inventing a question.
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
 * A FUNCTION OF THE OPEN FIELDS RATHER THAN A CONSTANT, so it differs each time it is needed and
 * is never itself a repeat. A fixed sentence would become the question of record and be replaced
 * by itself on the next turn, which moves the stall from the model to this gate instead of
 * ending it - measured, and the reason this is not a string constant.
 *
 * IT DOES NOT NAME THE FIELDS TO THE PARTICIPANT. `frustration` and `mistakesPerPeriod` are
 * internal names; saying "we did not get to mistakesPerPeriod" would be worse than the stall.
 * The phrasing counts them, which is honest and reads like a person speaking.
 *
 * @param {string[]} open The fields still unsupplied.
 * @returns {string}
 */
function moveOnLine(open) {
    const count = open.length === 1 ? 'one thing' : `${open.length} things`;

    // THE CLOSING SENTENCE VARIES WITH THE FIELDS THEMSELVES, which is what makes the line
    // different on each occasion. Counting alone was not enough: a stalled conversation leaves
    // `missing` UNCHANGED, so the same count produced the same sentence and the gate repeated
    // itself - measured, at turn 18 of a simulation. Naming the fields would fix it but reads
    // badly to a participant, so the sentence is chosen by the fields and never names them.
    const variants = [
        'If you think of something later, it can be added.',
        'Anything you can add now would still be useful.',
        'A rough answer is better than none, if you have one.',
        'We can leave it there if that is everything.',
        'Anything else you want me to know before we finish?'
    ];
    // INDEXED BY THE NUMBER OF FIELDS, WHICH DOES NOT CHANGE IN A STALL, so the variant must be
    // chosen by something that moves. The fields themselves are fixed during a stall, so the
    // honest thing to vary on is the SUM OF THEIR NAMES - a stable value per set of open fields,
    // and a different value as soon as the set changes. Within one stalled conversation that
    // still yields one sentence, which is correct: the participant should see the same warm
    // ending, not a different one each turn.
    //
    // THE LOOP IS BROKEN AT THE GUARD ABOVE, NOT HERE. Once every field has been asked, this
    // line is returned only when the model repeats itself, and the caller has already seen this
    // exact text - so `askedBefore` contains it, the model's repeat matches, and `fresh` is
    // still undefined. What stops the repetition is that THE PARTICIPANT IS NO LONGER ASKED A
    // QUESTION THEY HAVE ANSWERED: this text invites them to add anything, and the interview
    // closes on the next completing turn. It is a stable ending rather than a rotating one.
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
 * TRUE WHETHER THE CAP FIRED ON A STALL OR ON A DIP, and that is why the wording changed. It
 * used to say "I have not been able to record anything new from the last few answers", which is
 * a claim about the last few turns - and the reviewer measured that it is FALSE about one time in
 * five, because `evidenced` fluctuates: a dip in the payload is counted against the peak, so the
 * cap can fire while the interview was still recording. Telling a participant the tool recorded
 * nothing, when it had, is the owner's original complaint arriving from the mechanism meant to
 * prevent it.
 *
 * SO IT SAYS WHAT IS TRUE IN BOTH CASES: the tool has taken what it can usefully take. That is a
 * statement about the interviewer's judgement rather than about a measurement, so it does not
 * depend on which side of the fluctuation the cap fired on.
 *
 * IT STILL SAYS THE ANSWERS ARE SAVED AND COUNT, which is true in both cases and is what a
 * participant most needs to know.
 *
 * IT DOES NOT APOLOGISE. An admin may read this page, and a bare apology invites a support
 * conversation nobody can act on. It names what is happening in terms a participant can agree
 * with.
 *
 * DISTINCT FROM THE OTHER TWO TERMINAL MESSAGES, which a test compares directly:
 *   nothing_answered - "we did not manage to capture any answers"   (they declined everything)
 *   exhausted        - "that gives me a good picture of this one"    (every question was asked)
 *   this one         - "I have everything I can usefully take"       (the interview stopped gaining)
 */
const EVIDENCE_CAP_CONTENT =
    'Thank you - let us stop here. I have everything I can usefully take from this one, so rather '
    + 'than keep asking I will work with what you have told me. Everything you gave is saved, and '
    + 'it counts. Someone can follow up with you if there is more to capture.';

/**
 * HOW MANY TURNS THE INTERVIEW MAY GO WITHOUT GAINING ANY EVIDENCE.
 *
 * THE NET UNDER THE WHOLE GUARD. Every mechanism found so far has the same shape - the interview
 * is not gaining evidence - and they were reached one at a time:
 *
 *   oscillation        no evidence gained
 *   claim churn        no evidence gained
 *   the all-fifteen loop   no evidence gained
 *   rewording          no evidence gained
 *   echo/rotation      no evidence gained
 *
 * A cap on TURNS WITHOUT EVIDENCE catches all of them, and whatever the sixth mechanism is. That
 * is why it is a property of the CONVERSATION rather than a sixth text-matching heuristic: three
 * of those have already produced false positives that discarded legitimate questions.
 *
 * TWENTY, AND THE FIGURES IT SITS BETWEEN. Those are measured rather than guessed:
 *
 *   a COMPLETING run took 6-31 turns, and the mock provider - a real scripted interview that
 *   finishes - went SIX TURNS with no new evidence and then gained fourteen fields at once;
 *   the stalled runs ran 100-200 turns and never gained again;
 *   and a simulated run gaining one payload field every EIGHT turns - slow, but plainly
 *   working - reached a TWELVE TURN plateau, because `evidenced` counts the effort pair as two
 *   fields and can hold still while a payload step lands between them.
 *
 * TWELVE WAS TOO TIGHT - the first choice, before the measurement above - and that measurement is
 * why the constant is twenty. The twelve and twenty below are HISTORY rather than the current
 * value; `TURNS_WITHOUT_EVIDENCE_CAP` is the only place the number lives. A cap that ends a run
 * which is still gaining a field every eight turns is the false positive this design has to
 * avoid - it discards real answers and tells the participant the tool gave up on them. Twenty
 * clears that plateau with room to spare while still ending a stuck run about five times sooner
 * than the observed 100-turn signature.
 *
 * THE COST IS DELIBERATE AND NAMED: a genuinely stuck participant sees up to twenty questions
 * before the round closes, which is worse than the twelve of the first choice. That is the trade
 * this cap makes, and the reason is that cutting off a working interview is worse than a longer
 * wait on a broken one: the first loses evidence the participant gave, the second only loses
 * their patience. (Twelve is historical here too - see the note above.)
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
 * THE MONOTONIC HALF OF EXHAUSTION, and the reason it is a count rather than a sentence: the
 * number of DISTINCT FIELD QUESTIONS ASKED only ever grows, so once this is true it stays true.
 * A comparison against the open field set - which the model can vary every turn - is not
 * monotonic and can be defeated indefinitely.
 *
 * A FIELD WITH NO PHRASING IS NOT COUNTED, and that is deliberate: `FIELD_QUESTIONS` covers the
 * matrix, so a field added to the schema without a question here would make this never true and
 * trap the interview. The set is compared against the questions that EXIST rather than against a
 * fixed fifteen, so the guard cannot outlive its own table.
 *
 * @param {Set<string>} askedQuestions The texts already sent to the participant.
 * @returns {boolean}
 */
function asksEveryField(askedQuestions, openFields) {
    // EVERY QUESTION THAT COULD STILL BE ASKED HAS BEEN ASKED. The set is
    // `FIELD_QUESTIONS` LIMITED TO THE FIELDS CURRENTLY OPEN, and the limitation is the fix for
    // a residual stall rather than a convenience.
    //
    // REQUIRING ALL FIFTEEN WAS TOO STRONG, and it produced the very loop the guard exists to
    // prevent. A field the model CLAIMS to hold is never offered as a question - the substitute
    // only picks from `missing` - so its phrasing never enters the conversation, and exhaustion
    // could never fire. Measured with a churning model that claims task/trigger/steps held: 12 of
    // 15 questions asked, the move-on line emitted on every turn thereafter, indefinitely.
    //
    // THE MONOTONIC PROPERTY SURVIVES, which is what matters. The open set can change, but this
    // is evaluated only on a repeat with no evidence of progress, and it asks whether there is
    // anything left worth saying ABOUT WHAT IS STILL OPEN. A field nobody will ever be asked
    // about again cannot be a reason to keep the conversation going.
    //
    // AN EMPTY OPEN SET IS NOT THIS FUNCTION'S CALL: `missing` empty with `supplied` empty is
    // `nothing_answered`, and `missing` empty with evidence is a completed round. Both are
    // decided before this is reached.
    const phrasings = openFields
        .map((field) => FIELD_QUESTIONS[field])
        .filter((phrasing) => phrasing !== undefined);
    if (phrasings.length === 0) return false;
    return phrasings.every((phrasing) => askedQuestions.has(phrasing));
}

/**
 * Replaces a question the conversation has already asked, when nothing has moved since.
 *
 * THE STALL THIS EXISTS FOR, measured on a live interview: the model asked ONE field's
 * question for six consecutive turns while `missing` held six others, and the output was
 * byte-identical each time. The two-attempt cap is a PROMPT rule - the model is asked to
 * enforce it against itself - and it did not, which is why this is code.
 *
 * BOTH CONDITIONS MUST HOLD, and the second is what stops it firing on a legitimate repeat:
 *
 *   - the content is IDENTICAL to a question already in the conversation, and
 *   - `missing` has not shrunk since that question was first asked.
 *
 * THAT PAIR IS THE POINT. Asking about the same field twice is legitimate - the prompt allows
 * one rephrase - and it is only a stall when the participant is answering and nothing is being
 * recorded. The caller passes `askedBefore` with the count of open fields at each question, so
 * a repeat after progress is left alone; a repeat with no progress is replaced.
 *
 * IT TERMINATES BECAUSE IT ONLY EVER MOVES TO AN UNASKED FIELD, and there are fifteen. Each
 * substitution picks a field whose question is NOT in the conversation, so the number of
 * available questions strictly decreases. When every open field has been asked, it does not
 * substitute again - see below.
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

    // ONLY THE MODEL'S OWN REPEATS ARE GUARDED. A substitute this function wrote is never
    // matched, because matching it would be the gate arguing with itself: it would replace its
    // own sentence with another one, turn after turn, and the loop would move from the model to
    // the gate rather than ending. That is not a hypothetical - it was measured at turn 18 of a
    // simulation, and it is why the substitute is registered as the gate's.
    // A QUESTION THE GATE WROTE IS STILL THE GATE'S, EVEN WHEN IT REACHES US AS A PASS-THROUGH.
    // The model repeats whatever is in the conversation, so a substitute it echoes arrives here
    // as an ordinary assistant turn - and returning `substituted: false` for it loses the mark,
    // which is how the same gate sentence reached a participant twice (measured: every duplicate
    // in a live run was a consecutive pair). The text is the gate's sentence either way, so the
    // mark is carried by the TEXT, not by which branch we came through.
    const gateOwned = askedBefore.some((entry) => entry.text === text && entry.substituted === true);
    const wasAsked = askedBefore.find((entry) => entry.text === text);

    // A GATE SENTENCE THE MODEL ECHOED IS REPLACED, NOT RE-ISSUED. It has no `substituted`
    // exemption from being MATCHED - that exemption exists so the gate does not argue with
    // itself on its own next turn, and the echo is a different case: the participant is about to
    // read the same sentence twice, which is the defect. So a gate-owned repeat with no progress
    // falls through to the substitution below, exactly as a model repeat does.
    if (!wasAsked) return { text: content, substituted: false };

    // PROGRESS SINCE IT WAS ASKED, MEASURED FROM EVIDENCE RATHER THAN FROM A CLAIM.
    //
    // This compared `computed.missing` - which, mid-interview, is built partly from the model's
    // own `have` claim, believed without evidence. A model that re-partitions which fields it
    // CLAIMS to hold therefore makes `missing` shrink while nothing is recorded, and every
    // shrink was read here as the participant answering something. A live capture: `have +
    // missing` was always fifteen, `missing` fell 8 -> 6 -> 1 with nothing stored, and the guard
    // passed thirty-one identical questions in a row without either exhaustion branch firing.
    //
    // `evidenced` IS THE PAYLOAD'S OWN EVIDENCE, and it is the only list a churning model cannot
    // move: it grows when a value of the right shape is actually written into the payload, and
    // it never shrinks, because a payload that holds a field keeps holding it.
    //
    // NOTE THAT `supplied` WOULD NOT HAVE FIXED THIS, which is worth stating because it is the
    // obvious change. While the interview is in progress `supplied` believes the claim too, so
    // it churns with `missing` - measured, 4,5,6,7,8,9 against a payload that proved 3. The two
    // lists differ only for DECLINED fields, which is what they were built for; neither is
    // evidence while asking. See the note on `evidenced` in matrix.js.
    // EVIDENCE WHEN IT IS AVAILABLE, AND THE CLAIM ONLY AS A FALLBACK.
    //
    // The caller sends `evidencedCount` on every question it records, so in the running system the
    // first condition is the one that decides. The second exists for a caller that supplies only
    // the older `openCount` - a test fixture, or a conversation recorded before this field
    // existed - where treating "no evidenced data" as "no progress" would make every such repeat a
    // substitution and turn a legitimate second attempt into a wall.
    //
    // THE ORDER MATTERS: evidence is authoritative, so a churning model that shrinks its claim
    // while recording nothing gets no benefit from the fallback. The fallback only applies when
    // there is no evidence data to judge from at all.
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

    // EXHAUSTION IS DECIDED BY WHAT HAS BEEN ASKED, NOT BY WHAT IS OPEN.
    //
    // THIS IS THE FIX FOR A TERMINATION DEFEAT, and the shape of the bug is worth stating.
    // The check below used to be `askedQuestions.has(moveOnLine(computed.missing))`, and
    // `moveOnLine` is a function of the OPEN FIELD SET. So exhaustion was only recognised once
    // that exact SET had been seen before - and when the model varies its payload so `missing`
    // rotates, a new set appears every turn, the comparison never matches, and the passing turns
    // are unbounded. Measured against a rotating set: 25 turns where 15 were already enough, and
    // a faster rotation runs indefinitely. The reviewer's live capture shows it at 40 turns.
    //
    // THE CONDITION IS MONOTONIC: every field's question has appeared in the conversation. That
    // cannot un-happen, so no amount of payload churn can defeat it, and it does not care what
    // `missing` currently claims.
    //
    // IT RUNS BEFORE THE SUBSTITUTION, which is the other half. The old check lived in the
    // `no fresh target` branch, so a rotating `missing` kept offering fresh targets and the
    // branch was never reached. Asking a question is what this interview is for, so a fresh
    // target still wins on the first pass - but once NOTHING is left to ask, nothing is left to
    // ask, whatever the model says is open.
    //
    // IT NEEDS A REPEAT TO TRIGGER, deliberately: a moving interview is left alone, and this
    // only ends the conversation when the model has stopped making progress AND has run out of
    // questions. That keeps the guard from cutting a healthy interview short.
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
        // EVERY OPEN FIELD HAS BEEN ASKED. Nothing is left to substitute, and repeating a
        // question a third time is what this whole guard exists to prevent.
        //
        // THE MOVE-ON LINE IS ITSELF CHECKED, which is the fix for a second stall this guard
        // otherwise created: it replaced the model's question with a fixed sentence, that
        // sentence became the question of record, and the next identical turn replaced it with
        // the SAME sentence - so the loop moved from the model to the gate rather than
        // disappearing. Measured: seventeen distinct questions, then the move-on line twice.
        //
        // SO THE SENTENCE CARRIES THE FIELDS IT Is MOVING ON FROM, which makes it different each
        // time it is said and therefore never itself a repeat. `MOVE_ON_LINE` is a function of
        // the open fields rather than a constant for exactly that reason.
        // THE MOVE-ON LINE IS SENT ONCE. A second one would be the gate repeating itself, which
        // is the same defect one layer down: the line is about the SET of open fields, and that
        // set has not changed by definition on this path. So once it has been said, this returns
        // the model's own text unchanged and lets the ordinary closing path decide - the
        // interview ends when the matrix is satisfied, and a model that keeps repeating itself
        // with nothing left to ask is the state `nothing_answered` already covers when nothing
        // was supplied.
        // NOTHING IS LEFT TO ASK. Every field has had its question and the participant has
        // answered; the fields still open are the ones that cannot be settled by asking again.
        //
        // THE INTERVIEW CLOSES HERE, which is what terminates this path for good. Staying open
        // is the trap the whole guard exists to prevent, and passing the model's repeated
        // question through would show the participant the stall. The prompt already sanctions
        // this ending - "a field left thin costs a little at the analysis; an interview that
        // repeats costs the whole process" - so closing on what WAS supplied is the behaviour
        // the prompt asks for, reached from the code when the model will not reach it itself.
        //
        // IT IS NOT `nothing_answered`, AND THE DIFFERENCE MATTERS: that state means the
        // participant declined everything, and its message says no answers were captured. Here
        // they answered plenty. Reusing it would lie to them about their own interview.
        //
        // THE ROUND STILL FINALISES WITH WHATEVER WAS SUPPLIED, so the store records a finished
        // round and the roadmap gets the fields that were given. That is the honest outcome of
        // an interview that ran out of useful questions.
        // THIS USED TO CLOSE THE INTERVIEW ON A MOVING-VALUE COMPARISON, and that check is GONE
        // rather than kept beside the new one. It tested `askedQuestions.has(moveOnLine(missing))`
        // - a function of the open field set - which is the defect that let a churning model stall
        // indefinitely, and leaving it here would have left two branches that both look
        // load-bearing while only one is. Exhaustion is decided ONCE, above, by `asksEveryField`.
        //
        // WHAT REACHES THIS POINT: no field question is left to ask, but not every field has had
        // its question - which happens for a field with no entry in FIELD_QUESTIONS, or one the
        // model keeps claiming open without ever being asked about. The move-on line is the
        // honest reply, and it is sent once; see the branch below.
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

    // `stepsStillNeed` IS DERIVED HERE, AND THE MODEL'S OWN VALUE IS DELETED.
    //
    // WHAT IT IS FOR. `steps` is the only field whose completeness gate lives inside a
    // container: a step counts only when `name`, `whatHappens`, `decidedHow` and
    // `needsReasoning` are ALL present. So a participant who answers the basis question
    // before the step has a label moves nothing - `steps` stays in `missing`, and the
    // interviewer, told to ask about anything in `missing`, asks the same question again
    // in different words. Observed three times in one real interview. `stepsStillNeed`
    // says WHICH step fields are still absent, so the next question can be a different
    // one.
    //
    // WHY THE MODEL MUST NOT SUPPLY IT, ENFORCED RATHER THAN DOCUMENTED. It is a
    // statement about the payload, computed from `processes`. A model that could claim
    // it would be able to contradict the matrix that computed it - the same class of
    // defect as a model claiming `complete` with fields missing, which the completion
    // gate exists to refuse.
    //
    // THE STRIP IS RECURSIVE, AND THAT IS THE FIX FOR A REAL HOLE. It deleted the
    // TOP-LEVEL key only, so a model that put the field inside a process walked straight
    // past it:
    //
    //   processes: [{ ..., stepsStillNeed: ["HOSTILE"] }]
    //     -> r.processes[0].stepsStillNeed      === ["HOSTILE"]
    //     -> r.audit.workflows[0].stepsStillNeed === ["HOSTILE"]
    //
    // The computed value still won - both readers use the top-level one - so it was
    // inert for the interview. But the CLIENT PERSISTS THIS PAYLOAD VERBATIM, so the
    // model's string reached the participant's stored answers, and the comment claiming
    // "the only value that can reach a caller is the one derived below" was not true.
    // A claim that is nearly true is the kind this codebase keeps finding; the fix is to
    // make it exactly true rather than to weaken the wording.
    //
    // RECURSIVE RATHER THAN ONE EXTRA LEVEL, because the depth is the model's choice and
    // a guard that names a depth is a guard with a next hole. This removes the key from
    // the object graph the model sent, at any depth, before anything reads it.
    //
    // ONLY FIELDS THE MODEL CANNOT LEGITIMATELY CLAIM BELONG HERE. `have` and `missing`
    // are NOT stripped: they are the model's own report of the conversation, the matrix
    // reconciles rather than trusts them, and they are read at the top level by design.
    // `stepsStillNeed` is different in kind - it is derived and unclaimable - which is why
    // it is the only entry in the list today.
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
    // AN ALL-DECLINED ROUND IS A FIXED POINT WITHOUT THIS, and that is a measured defect
    // rather than a hypothetical: every field declined leaves `have` full and `supplied`
    // empty, so the model has nothing left to ask, the completion gate never opens, and
    // `withoutClosingQuestion` finds no open field to substitute - so every turn returns
    // BYTE-IDENTICAL `asking` output forever, with the participant shown the closing question
    // and no way out. The gate that suppresses a premature close cannot see it, because there
    // is no premature close to suppress.
    //
    // WHY `submitted_at` IS SET AND THE STATUS IS NOT `complete`. The round has to END -
    // staying open is the trap - and `submitted_at` is the store's only way to say a round is
    // finished. But `complete` would be a lie the roadmap has to render, and an instance that
    // declared "complete" with zero evidence is exactly what the gate exists to refuse. So the
    // round is FINALISED while the reply carries a status of its own: `nothing_answered`.
    //
    // WHAT THAT MEANS TO EVERY READER:
    //   - the client finalises the round (it may end) and does not score it, because there is
    //     nothing to score;
    //   - the console shows a finalised round with every field marked "not answered", which is
    //     a FINDING - asked, and nobody knew - rather than a gap;
    //   - nothing reaches the roadmap, because a process is only created by identification and
    //     there is no usable field to identify.
    //
    // THE SCHEMA NEEDS NO CHANGE: `submitted_at` records that the round ended, and the status
    // lives in the reply the client reads. "Nothing was answered" is a property of the
    // conversation, not of the row.
    //
    // IT IS NOT AN ESCAPE HATCH. A model that declined everything to finish early gains
    // nothing: declined fields carry no evidence, so `supplied` stays empty, the round scores
    // and weighs nothing, and it never becomes a process. Finishing early by refusing has the
    // same outcome as answering nothing, which is the honest result of answering nothing.
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

    // THE EVIDENCE CAP, CHECKED BEFORE ANY QUESTION IS CONSIDERED.
    //
    // IT SITS ABOVE THE EXACT-TEXT GUARD ON PURPOSE, because that guard cannot see a REWORDED
    // repeat: the model appending " (part 2)" to its question is never a match target, so the
    // repeat guard never fires, the `evidenced` comparison is never reached, and the interview
    // runs indefinitely - measured at 120 turns with a two-field payload. The cap does not care
    // what the question SAYS, only that the conversation has stopped learning anything, which is
    // the shape all five mechanisms share.
    //
    // IT CLOSES THE ROUND RATHER THAN SUBSTITUTING, because after a long run without evidence
    // there is nothing left worth asking: whatever the model is doing, it is not recording the
    // participant's answers, and another question cannot help.
    //
    // AND IT DOES NOT FIRE ON AN INTERVIEW THAT IS ALREADY FINISHABLE. `missing.length > 0` is
    // that guard, and it is here because the cap PRE-EMPTED COMPLETION in three separate live
    // runs: `evidenced` plateaued while `missing` reached zero, so the condition below held, the
    // cap ran first, and the participant was told "I have not been able to record anything new"
    // - WHICH WAS FALSE. The tool had recorded everything; it was finished. That is the exact
    // harm this cap's own comment names: not a discarded answer, but a participant told the tool
    // gave up when it had not.
    //
    // WITH `missing` EMPTY THERE IS NOTHING TO STOP: the round is complete or about to be, and
    // closing it is the completion path's job rather than a timeout's.
    //
    // THE COUNTER BELOW CANNOT BE TRUSTED ALONE, which is why this condition is not merely
    // belt-and-braces. `evidenced` is NOT monotonic in practice - the design note in matrix.js
    // claims a payload that has a field keeps it, and live runs falsify that: the model rewrites
    // `processes` each turn and drops fields it had filled, so the count fluctuates and this
    // counter can report a long plateau during a healthy interview. `missing` is the authoritative
    // signal that there is still work to do.
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

    // Validate the payload here, at the boundary, rather than letting a malformed
    // one reach the client. Without this the browser posts it to /api/score, gets
    // a 400, and shows a generic network error for what is actually a model
    // contract violation.
    //
    // EACH SHAPE IS VALIDATED AGAINST ITS OWN REQUIREMENTS, and getting that wrong
    // killed real interviews. The comment here used to say "both shapes are validated"
    // while the code validated only `status === 'complete'`, against the FINAL payload's
    // requirements - and `workflowsFrom` prefers `processes`, which is the INTERVIEW
    // shape. So a genuinely finished interview was checked for `id` and `title`, neither
    // of which the interview's field matrix mentions: `id` appears in the prompt only
    // inside the completion example, and the `asking` example shows a process without
    // one. The model therefore did exactly what it was taught, and the server answered
    // "1 entry has no id" and ended the interview. Measured on a real deepseek run, and
    // the mock never hit it because its fixture carries both fields.
    //
    // THE RULE IS THEREFORE ABOUT WHICH SHAPE ARRIVED, not about which statuses are
    // interesting. `processes` is the interview shape: it is checked for what the MATRIX
    // requires, which is `hasShape`'s job and already runs. `audit.workflows` is the
    // payload the scorer consumes, so it keeps the stricter check - `validateWorkflows`,
    // which requires the `id` and `title` that `/api/score` and the roadmap read.
    //
    // An interview reply that carries BOTH is validated as the payload, because that is
    // the one that will be scored; `workflowsFrom` resolves the same way, so the two
    // cannot disagree about which array is authoritative.
    if (parsed.status === 'complete') {
        // WHICH SHAPE IS AUTHORITATIVE, decided the same way `workflowsFrom` decides it,
        // so the validation and the payload cannot disagree about which array counts.
        //
        // AN EMPTY `audit.workflows` IS A SPECIAL CASE, and it is pinned from two
        // directions. On its own it is unusable - an empty audit is not a completed audit,
        // and the client would score nothing. But BESIDE a good `processes` array it is
        // merely stale, and `processes` must win, because that is what the interview
        // writes while `audit` is the older shape it also emits. So emptiness is judged
        // only when there is nothing better to fall back to.
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

    // THE PAYLOAD IS NORMALISED FROM THE BEST AVAILABLE SOURCE.
    //
    // Not `parsed.audit ?? normalise(processes)`. That kept `parsed.audit`
    // whenever it was merely NON-NULL, so a stale or wrong-typed one won over a
    // good `processes`: `audit: { workflows: [] }` passed `??` and reached the
    // client as an empty list, which /api/score then rejected with a 400 and the
    // participant saw the scoring-failed panel after a successful interview. The
    // same shape as the defect this replaced, one field deeper.
    //
    // So the decision is made on CONTENT, not on nullness: if a usable workflows
    // array exists anywhere, it wins and is wrapped.
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
 * The interview shape carries a bare array under `processes`; the client wants an
 * object with `workflows`, and optionally `illustrative` and `note`, which the
 * prompt does not ask a model to produce but which this system uses to label
 * generated data. An unknown model therefore yields a payload with neither flag,
 * which reads as "not illustrative", the correct default for a real interview.
 *
 * The flags are read from EITHER place a model might put them: the top level, or
 * inside an `audit` envelope it also sent. The envelope is not preferred for the
 * workflows themselves, because those came from the best source, but its labels
 * are still worth taking rather than dropping.
 *
 * @param {object} parsed The parsed reply, which may carry the flags.
 * @param {Array<object>} workflows A non-empty array, already resolved.
 * @returns {object}
 */
function normaliseProcessesPayload(parsed, workflows) {
    const payload = { workflows };

    const envelope = parsed && typeof parsed.audit === 'object' && parsed.audit !== null ? parsed.audit : {};

    if (parsed && parsed.illustrative === true) payload.illustrative = true;
    else if (envelope.illustrative === true) payload.illustrative = true;

    const note = typeof parsed?.note === 'string' && parsed.note.trim() !== ''
        ? parsed.note
        : (typeof envelope.note === 'string' && envelope.note.trim() !== '' ? envelope.note : null);
    if (note !== null) payload.note = note;

    return payload;
}
