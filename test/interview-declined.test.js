/**
 * The fourth state (`declined`), the completion gate that reads `supplied`, and the code gate
 * that suppresses a closing question while fields are still open.
 *
 * WHAT THIS FILE IS ABOUT. `{ said: ... }` accepts a refusal as a value when it checks only that
 * the string is non-empty, so an interview can record "I have no idea" against seven fields and
 * COMPLETE - an audit that says nothing reading as finished. Two things the one marker conflates:
 *
 *   have       "do not ask again"
 *   supplied   "the analysis has something to work with"
 *
 * and the completion gate reads `supplied`. A declined field is in `have` and not in `supplied`,
 * which is the whole point: it stops the interview asking again WITHOUT becoming evidence.
 *
 * TWO LIMITS ARE RECORDED BELOW AS ASSERTIONS ON THE CURRENT BEHAVIOUR, NOT AS PASSING CLAIMS.
 * They are localised with "KNOWN DEFECT" and they assert what the code DOES today, so they are
 * honest witnesses rather than a green wash. They are the two directions the fourth state pulls in
 * when EVERY field is declined.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const PROMPTS_DIR = path.join(PROJECT_ROOT, 'data', 'prompts', 'cartiere_audit');
const prompt = (lang) => fs.readFileSync(path.join(PROMPTS_DIR, `prompt_${lang}.md`), 'utf8');
const LANGS = ['en', 'nl'];

const { parseModelResponse } = await import('../ai/audit-core.js');
const matrix = await import('../ai/matrix.js');
const shapes = await import('../ai/field-shapes.js');
const weighCore = await import('../ai/weigh-core.js');

const TYPED_MINIMUM = ['task', 'trigger', 'steps', 'frequencyPerWeek', 'timePerPeriod'];

/** Every non-effort field with the shape it requires, so a test floods one field at a time. */
function typedValues() {
    return {
        peopleAffected: 3,
        handoffTo: ['the team'],
        waitsFor: ['the approval'],
        dependsOn: ['the advert being live'],
        systems: ['email'],
        touchedDepartments: ['Finance'],
        mistakesPerPeriod: 1,
        mistakeConsequence: 'a delay',
        currentState: 'by hand',
        frustration: 'the waiting'
    };
}

function typedProcess(overrides = {}) {
    return {
        task: 'entering invoices',
        trigger: 'the mail arrives',
        steps: [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'a value']))],
        frequencyPerWeek: 2,
        ...typedValues(),
        ...overrides
    };
}

/** Parses a completion reply through the REAL gate, so `status` reflects the outcome. */
function complete(process, { content = 'Anything else?', have = [...matrix.ALL_PROCESS_FIELD_NAMES], status = 'complete' } = {}) {
    return parseModelResponse(JSON.stringify({
        status, content, processes: [process], have, missing: []
    }));
}

/**
 * A process where EVERY field carries a `{ declined: ... }` marker.
 *
 * EVERY name in `ALL_PROCESS_FIELD_NAMES`, not `PROCESS_FIELDS` plus `EFFORT_FIELDS` - the effort
 * pair must BOTH be declined for the round to supply nothing, and building it from the two lists
 * separately drops `timePerPeriod`, which leaves one field open and hides the all-declined path.
 */
function allDeclinedProcess() {
    const process = {};
    for (const field of matrix.ALL_PROCESS_FIELD_NAMES) process[field] = DECLINE;
    return process;
}

const DECLINE = { declined: 'I have no idea' };

// ===========================================================================
// 1. THE FOUR STATES, EACH DIRECTION
// ===========================================================================

test('the four states: absent blocks, typed completes, said completes, declined refuses', () => {
    // The four-state table, asserted through the gate rather than against the lists.
    const absent = typedProcess();
    delete absent.frustration;

    assert.equal(complete(absent).status, 'asking', 'absent -> asking');
    assert.equal(complete(typedProcess()).status, 'complete', 'typed -> complete');
    assert.equal(
        complete(typedProcess({ frustration: { said: 'it depends on the mail' } })).status,
        'complete',
        'said -> complete, a real answer even in words'
    );
    assert.equal(
        complete(typedProcess({ frustration: DECLINE })).status,
        'asking',
        'declined -> asking, asked and no answer given'
    );
});

test('EVERY field declined -> nothing_answered, and it does NOT claim completion', () => {
    // Declining everything must not be an unbreakable `asking` fixed point: the round neither
    // closed nor moved. It ends with a status of its own, and the two halves of that are the whole
    // point - the round FINISHES, and it does NOT say `complete`, because an instance declaring
    // completion with zero evidence is exactly what the completion gate exists to refuse.
    const result = complete(allDeclinedProcess());

    assert.equal(result.status, 'nothing_answered', 'declining everything ends the round honestly');
    assert.notEqual(result.status, 'complete', 'and does NOT claim there was something to analyse');
    assert.notEqual(result.status, 'asking', 'and is not left open, which was the trap');
});

test('an all-declined round supplies NOTHING: supplied is empty, have is full', () => {
    // `supplied` staying empty is why the status cannot be `complete`. `have` being full is why
    // there is nothing left to ask. Both are asserted, because they are the two facts that made
    // the old behaviour a fixed point and the new one a termination.
    const computed = matrix.reconcileMatrix({ processes: [allDeclinedProcess()] });

    assert.equal(computed.supplied.length, 0, 'a refusal is never evidence');
    assert.equal(computed.declined.length, matrix.ALL_PROCESS_FIELD_NAMES.length, 'every field is a refusal');
    assert.equal(computed.have.length, matrix.ALL_PROCESS_FIELD_NAMES.length, 'and every field is answered-for');
    assert.equal(computed.missing.length, 0, 'so nothing is left to ask');
});

test('A DECLINED FIELD IS NOT IN `missing` - the half that stops the loop returning', () => {
    // If a declined field stayed in `missing`, the interview would ask again forever: the
    // participant has nothing to give and the model has only that question. Both halves of the
    // fourth state are load-bearing, and this asserts the one that keeps the interview moving.
    // `supplied` lives on the MATRIX's output, so it is read there rather than off the gate
    // result, which carries only have/missing.
    const gateResult = complete(typedProcess({ frustration: DECLINE }));
    const computed = matrix.reconcileMatrix({ processes: [typedProcess({ frustration: DECLINE })] });

    assert.equal(gateResult.missing.includes('frustration'), false, 'declined must not be asked again');
    assert.ok(gateResult.have.includes('frustration'), 'it IS in have: the interview will not re-ask');
    assert.equal(computed.supplied.includes('frustration'), false, 'and it is NOT evidence');
});

test('a declined field is `have` but not `supplied`, asserted directly on the matrix', () => {
    const result = matrix.reconcileMatrix({ processes: [typedProcess({ frustration: DECLINE })] });

    assert.ok(result.have.includes('frustration'), 'have: do not ask again');
    assert.ok(result.declined.includes('frustration'), 'declined: named as a refusal');
    assert.equal(result.supplied.includes('frustration'), false, 'not supplied: nothing to work with');
    assert.equal(result.missing.includes('frustration'), false, 'and not missing');
});

test('`said` and `declined` are genuinely different, on the SAME field', () => {
    const asAnswer = complete(typedProcess({ currentState: { said: 'by hand, every time' } }));
    const asRefusal = complete(typedProcess({ currentState: DECLINE }));

    assert.equal(asAnswer.status, 'complete', 'their words are an answer');
    assert.equal(asRefusal.status, 'asking', 'their silence is not');
    assert.notEqual(asAnswer.status, asRefusal.status, 'two states, not two spellings of one');
});

test('a MISSING field still blocks exactly as before, so nothing is loosened', () => {
    // The safety claim: the change is strictly tighter. A field with no value at all must
    // behave exactly as it did, whether or not the declined machinery exists.
    for (const field of ['task', 'trigger', 'steps', 'frequencyPerWeek', 'peopleAffected', 'dependsOn', 'frustration']) {
        const process = typedProcess();
        delete process[field];
        const result = complete(process);

        assert.equal(result.status, 'asking', `absent ${field} must still block`);
        assert.ok(result.missing.includes(field), `absent ${field} must be named missing`);
    }
});

test('the stricter direction: a declined value never counts where a typed value did', () => {
    // Same field, same test, two values. The declined one is strictly weaker: it leaves the
    // field out of `supplied` while the typed one puts it in. That is the whole comparison.
    const typed = complete(typedProcess({ peopleAffected: 3 }));
    const refused = complete(typedProcess({ peopleAffected: DECLINE }));

    assert.equal(typed.status, 'complete');
    assert.equal(refused.status, 'asking');
});

// ===========================================================================
// THE ALL-DECLINED ROUND TERMINATES
// ===========================================================================
//
// The round that could not close or move now ends. `nothing_answered` is a THIRD status beside
// `asking` and `complete`, and the tests below are about what reaches which side: the interview
// ends, the participant is told something true and finite, and the round is finalised without
// claiming completion.

test('an all-declined reply ENDS the interview instead of returning the closing line forever', () => {
    // `have` full, `supplied` empty, `missing` empty, so there is nothing left to ask and the
    // completion gate never opens; without the third status the closing line reaches the
    // participant with no way out. The reply carries the completed status instead of the model's
    // own content.
    const closing = 'Is there another process you would like to improve?';
    const result = complete(allDeclinedProcess(), { content: closing });

    assert.equal(result.status, 'nothing_answered', 'the round ends');
    assert.notEqual(result.content, closing, 'and the model\'s closing line is NOT what the participant sees');
});

test('the participant is TOLD, honestly and without thanking them for answers they did not give', () => {
    // The status is not an error, and not a closed door: the message says what happened. Two
    // things are asserted - it does not thank them for answers they did not give, and it says this
    // is not their fault.
    const result = complete(allDeclinedProcess());
    const content = result.content;

    assert.equal(typeof content, 'string');
    assert.ok(content.length > 0, 'there is a message');
    assert.match(content, /did not manage to capture any answers/i, 'it says what happened');
    assert.match(content, /not a problem on your side/i, 'and that it is not their failure');
    // The thing it must NOT do: thank them for answers.
    assert.equal(/thank you for your answers/i.test(content), false, 'it does not thank them for answers');
});

test('the reply TERMINATES: repeated turns all return the same finished status, not a forever-asking one', () => {
    // The status is stable across turns, and it is an END rather than an `asking` that never
    // moves: the client finalises the round and hides the input.
    const statuses = [1, 2, 3].map(() => complete(allDeclinedProcess()).status);

    assert.deepEqual(statuses, ['nothing_answered', 'nothing_answered', 'nothing_answered'],
        'every turn ends the round the same way, rather than asking forever');
    assert.equal(statuses.every((s) => s === 'asking'), false, 'it is NOT still asking');
});

test('nothing_answered fires on an ASKING reply too, not only when the model claims complete', () => {
    // The model does not have to claim completion for the round to end. A participant who has
    // declined everything while the model keeps reporting `asking` must still get out, or the
    // fixed point returns whenever the model does not happen to say "complete".
    const result = complete(allDeclinedProcess(), { status: 'asking', content: 'Anything else?' });

    assert.equal(result.status, 'nothing_answered', 'the round ends regardless of the claimed status');
});

test('it CANNOT be reached without genuinely declining everything - the escape-hatch check', () => {
    // The claim that this is safe to add, verified rather than accepted. The condition is
    // `missing` empty AND `supplied` empty, which needs EVERY field to be a refusal. A payload
    // that merely lacks fields, or claims `have` for fields it does not carry, still has open
    // fields and gets `asking` - so a model cannot finish early by asserting completion on an
    // empty payload.
    const attempts = {
        'a process with no fields at all': {},
        'a process with one typed field': { task: 'entering invoices' },
        'a process with one said field': { task: { said: 'entering invoices' } }
    };
    for (const [label, process] of Object.entries(attempts)) {
        const result = complete(process);
        assert.notEqual(result.status, 'nothing_answered', `${label} must NOT reach nothing_answered`);
        assert.equal(result.status, 'asking', `${label} is still an open interview`);
    }
});

test('an all-declined round carries NO process and NO payload - nothing to score', () => {
    // Declining everything must gain a model exactly what answering nothing gains: nothing. The
    // round ends with no `audit` payload, so there is nothing for the client to score and no
    // process is created - a refusal cannot become an escape hatch by producing a scorable audit.
    const result = complete(allDeclinedProcess());

    assert.equal('audit' in result && result.audit !== undefined, false, 'no payload is produced');
    assert.equal(result.processes.every((p) => Object.keys(p).length > 0), true,
        'the processes are the declined ones, carrying no usable field');
});

// ===========================================================================
// 2. THE TYPED MINIMUM CANNOT BE `declined`, AND A MALFORMED MARKER IS NOT A MARKER
// ===========================================================================

test('the typed minimum cannot be `declined`, the same as it cannot be `said`', () => {
    for (const field of TYPED_MINIMUM) {
        const process = typedProcess({ [field]: DECLINE });
        if (field === 'frequencyPerWeek' && process.timePerPeriod === undefined) delete process.timePerPeriod;
        const result = complete(process);

        assert.equal(result.status, 'asking', `declining ${field} must not complete`);
    }
});

test('a malformed declined marker is NOT a marker, each shape checked', () => {
    // `{declined:"   "}` IS a marker: a wordless refusal. The rest are not markers and fall
    // through to the shape check, which refuses them, so the field stays OPEN rather than silently
    // closed.
    assert.deepEqual(shapes.declinedIn({ declined: '   ' }), { declined: true, words: null },
        'a whitespace-only refusal is a wordless refusal, not a malformed one');
    assert.deepEqual(shapes.declinedIn({ declined: true }), { declined: true, words: null });
    assert.deepEqual(shapes.declinedIn({ declined: 'words' }), { declined: true, words: 'words' });

    for (const bad of [{ declined: 5 }, { decline: true }, { declined: false }, [], null, 'declined']) {
        assert.equal(shapes.declinedIn(bad), null, `${JSON.stringify(bad)} is not a marker`);
    }
});

test('a malformed declined marker leaves the field OPEN and blocks', () => {
    // The consequence of the previous test, through the gate: an unrecognised object is not a
    // value and not a refusal, so the field is absent and the interview asks again.
    for (const bad of [{ declined: 5 }, { decline: true }, {}]) {
        const result = complete(typedProcess({ frustration: bad }));
        assert.equal(result.status, 'asking', `${JSON.stringify(bad)} must not complete the interview`);
        assert.ok(result.missing.includes('frustration'), 'the field is still open');
    }
});

test('a declined field and a said field are distinguished by shape, not by wording', () => {
    // The same words in the two markers behave differently, which is what makes the distinction
    // real rather than a keyword the model could game.
    const words = 'I have no idea';
    assert.equal(complete(typedProcess({ frustration: { said: words } })).status, 'complete',
        'the same words under `said` are treated as an answer');
    assert.equal(complete(typedProcess({ frustration: { declined: words } })).status, 'asking',
        'under `declined` they are a refusal');
});

// ===========================================================================
// 3. THE CODE GATE
// ===========================================================================

const partialProcess = () => {
    // Few fields typed, so `missing` is non-empty and a replacement has something to name.
    return {
        task: 'entering invoices',
        trigger: 'the mail arrives',
        steps: [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'v']))],
        frequencyPerWeek: 2
    };
};

test('the closing question with fields OPEN is REPLACED by a question about the next open field', () => {
    const result = complete(partialProcess(), { content: 'Is there another process you would like to improve?' });

    assert.notEqual(result.content, 'Is there another process you would like to improve?', 'the closing line is replaced');
    assert.ok(result.content.length > 0, 'and replaced by something, not blanked');
    // The replacement is about an open field: it must name one.
    assert.ok(/who|what|how|when|which|where/i.test(result.content), 'the reply is a real question');
    assert.equal(result.status, 'asking', 'and the turn is still asking');
});

test('the closing question with `missing` EMPTY passes through untouched', () => {
    // Nothing is open, so there is nothing to replace the closing line with, and the model's
    // own words are kept rather than an invented question.
    const closing = 'Is there another process you would like to improve?';
    const result = complete(typedProcess(), { content: closing });

    assert.equal(result.status, 'complete', 'the interview closes');
    assert.equal(result.content, closing, 'and the closing line is the model\'s own');
});

test('the phrase variants are recognised, not only one exact sentence', () => {
    // The closing question is phrased several ways in practice, so matching exact text would catch
    // only the one quoted. Each of these must be replaced.
    const variants = [
        'Would you like to improve another process?',
        'Is there any other process involved here?',
        "Thank you - is there anything else you'd like to add?",
        "Is there another process you'd like to improve?"
    ];
    for (const content of variants) {
        const result = complete(partialProcess(), { content });
        assert.notEqual(result.content, content, `"${content}" must be recognised and replaced`);
    }
});

test('a closing question with `else` before `you` is GATED - the word order does not matter', () => {
    // The matcher anchors on the SUBJECT wherever it sits, not on word order. A matcher that
    // anchored on `would you like to <verb>` would miss "Anything else you would like to look
    // at?", where `you` comes first, and a closing question in that form would reach the
    // participant with the matrix unsatisfied.
    const escaped = 'Anything else you would like to look at?';
    const result = complete(partialProcess(), { content: escaped });

    assert.notEqual(result.content, escaped, 'the wording is now recognised and replaced');
    assert.equal(result.status, 'asking', 'and the interview continues with a real question');
});

test('all seven closing phrasings are caught, in either word order', () => {
    // Each of these is a way a model has phrased or could phrase the closing question; the
    // word-order pair is included because the ORDER is where a subject-anchored matcher can slip.
    const closings = [
        'Is there another process you would like to improve?',
        "Is there another process you'd like to improve?",
        'Anything else you would like to look at?',
        'Would you like to tell me about another process?',
        'Is there anything else you would like to add?',
        'Any other process involved here?',
        'Shall we look at something else?'
    ];
    for (const content of closings) {
        const result = complete(partialProcess(), { content });
        assert.notEqual(result.content, content, `"${content}" must be recognised and replaced`);
    }
});

test('a closing question on an `asking` reply is also gated', () => {
    // The gate runs at the one place every reply passes through, not inside the "claimed complete
    // and the matrix disagreed" branch alone - so a model asking the closing question while
    // reporting `status: "asking"` is checked too. This asserts that path, not only the reported
    // phrasing.
    const closing = 'Is there another process you would like to improve?';
    // `have: []` so the matrix is UNSATISFIED and there is an open field to substitute: the
    // replacement only happens when something is missing (there is nothing to ask otherwise).
    const result = complete(partialProcess(), { status: 'asking', content: closing, have: [] });

    assert.notEqual(result.content, closing, 'a closing question on an asking reply is replaced');
    assert.equal(result.status, 'asking', 'and the turn is still asking, with a real question');

    // The same for several phrasings, so the coverage is not one sentence.
    for (const content of ['Anything else you would like to look at?', 'Shall we move on?']) {
        assert.notEqual(complete(partialProcess(), { status: 'asking', content, have: [] }).content, content,
            `"${content}" on an asking reply must be replaced`);
    }
});

test('the over-reach check: 22 ordinary questions, 0 wrongly gated', () => {
    // THE OVER-REACH A NARROWER MATCHER MUST AVOID: a pattern can gate a legitimate question about
    // the CURRENT process ("Do you want to describe the steps in more detail?") alongside the
    // closing offers it is meant to catch. Replacing a real question is worse than the escape it
    // fixes, so the check is wider than the closing set. These share words ("process", "anything",
    // "else", "another", "describe", "steps") with the closing shapes on purpose.
    const ordinary = [
        'What systems do you use for this?',
        'How often does this happen?',
        'Who else is involved in this process?',
        'What happens next after you send it?',
        'Can you describe the steps you take?',
        'Is this process something you do alone?',
        'Do you want to describe the steps in more detail?',
        'How long does it usually take?',
        'What goes wrong most often?',
        'Where does the information come from?',
        'What do you do when it is busy?',
        'Who decides what happens next?',
        'Which tool do you open first?',
        'What makes this frustrating?',
        'How many mistakes happen in a month?',
        'What would you change if you could?',
        'Do you check the work yourself?',
        // Mine, chosen to share words with the closing shapes.
        'Can you walk me through a typical day?',
        'What is the hardest part of this?',
        'Who signs this off?',
        'Do you ever look at the email again?',
        'Is there anything about the process you would change?'
    ];
    for (const content of ordinary) {
        const result = complete(partialProcess(), { content });
        assert.equal(result.content, content, `"${content}" must pass through unchanged`);
    }
    assert.equal(ordinary.length, 22, 'the set is pinned to the number checked');
});

test('the replacement names an OPEN field, not a closed one', () => {
    // The replacement is useful only if it aims at what is actually missing. Given a process
    // with a known gap, the reply must not be a question about a field already supplied.
    const result = complete(partialProcess(), { content: 'Is there anything else you would like to add?' });
    const suppliedFieldWords = /invoice|mail arrives/i;
    assert.equal(suppliedFieldWords.test(result.content), false,
        'the replacement does not re-ask a field that is already supplied');
});

test('the client renders a replaced question as an ordinary turn and does not stall', async () => {
    // A substituted question is rendered and recorded like any other analyst turn, so the
    // interview does not stall on it. The turn carries `role`, `content` AND the guard's
    // bookkeeping (`substituted`, `missing`), and this reads the purpose: the content is rendered,
    // and the turn is recorded with its content, whatever extra fields travel beside it.
    const client = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

    // The content of every non-error reply is appended and pushed to the conversation.
    assert.match(client, /appendMessage\('ai', S\.aiLabel, data\.content\)/,
        'the reply content is rendered as an analyst turn');
    // The assistant turn is recorded WITH ITS CONTENT - the extra fields are additive, not a
    // replacement for it, which is the thing that changing the line could have broken.
    assert.match(client, /state\.conversation\.push\(\{\s*role: 'assistant',\s*content: data\.content/,
        'and recorded with its content, so the next turn sees it');

    // Only `error` and `rejected` stop the turn; `asking` does not, so nothing waits on complete.
    assert.match(client, /if \(data\.status === 'error' \|\| data\.status === 'rejected'\) \{/,
        'the only early return is for error and rejected');
    assert.equal(/if \(data\.status !== .complete.\)[\s\S]*return/s.test(client), false,
        'nothing returns early on a non-complete status');
});

// ===========================================================================
// 4. THE PROMPT CHANGES, BOTH LANGUAGES
// ===========================================================================

test('both languages state `said` is an answer and `declined` is not', () => {
    const en = prompt('en');
    assert.match(en, /`declined` is NOT an answer/i, 'EN says declined is not an answer');
    assert.match(en, /RECORDING A REFUSAL AS `said` IS A SERIOUS MISTAKE/i, 'EN names the mistake');

    const nl = prompt('nl');
    assert.match(nl, /`declined` is GEEN antwoord/i, 'NL says the same');
    assert.match(nl, /SERIEUZE FOUT|ernstige fout/i, 'NL names the mistake');
});

test('both languages define the declined marker with its wordless form', () => {
    for (const lang of LANGS) {
        const text = prompt(lang);
        assert.match(text, /\{\s*"declined":/, `${lang} shows the marker`);
        assert.match(text, /declined": true/, `${lang} accepts the wordless form`);
    }
});

test('both languages forbid sending the same sentence twice, even about different fields', () => {
    const en = prompt('en');
    assert.match(en, /NEVER SEND THE SAME SENTENCE TWICE/i, 'EN states the prohibition');
    assert.match(en, /even about two different fields|nominally about\s+different fields/i,
        'EN says it holds across fields');

    const nl = prompt('nl');
    assert.match(nl, /NOOIT DEZELFDE ZIN TWEE KEER/i, 'NL states the prohibition');
    assert.match(nl, /verschillende velden/i, 'NL says it holds across fields');
});

test('both languages give the attempt its unit: asked and answered counts, partial or not', () => {
    const en = prompt('en');
    assert.match(en, /A question you SENT and they\s+ANSWERED counts as one attempt/i, 'EN defines the unit');
    assert.match(en, /even if their answer was partial/i, 'EN says partial still counts');

    const nl = prompt('nl');
    assert.match(nl, /Een vraag die je VERSTUURDE en die ze\s+BEANTWOORDDEN telt als één poging/i,
        'NL defines the unit');
    assert.match(nl, /ook als hun antwoord gedeeltelijk was/i, 'NL says partial still counts');
});

test('the two languages agree on the declined/answer distinction, field for field', () => {
    // A weak equality, but it catches the asymmetry the earlier round almost shipped: both must
    // name the marker, the mistake and the two-attempt unit, or one language instructs the model
    // differently from the other.
    for (const [en, nl] of [
        [/`declined` is NOT an answer/i, /`declined` is GEEN antwoord/i],
        [/declined": true/, /declined": true/],
        [/NEVER SEND THE SAME SENTENCE TWICE/i, /NOOIT DEZELFDE ZIN TWEE KEER/i],
        [/There is no attempt three|no attempt three/i, /geen poging drie/i]
    ]) {
        assert.equal(en.test(prompt('en')), true, `EN carries ${en}`);
        assert.equal(nl.test(prompt('nl')), true, `NL carries ${nl}`);
    }
});

// ===========================================================================
// 5. THE RENDER
// ===========================================================================

test('a declined value is tagged "not answered", distinct from "in their own words"', async () => {
    const ejs = await import('ejs');
    const declined = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: { peopleAffected: { declined: 'I have no idea' } } });
    const said = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: { peopleAffected: { said: 'just me' } } });

    assert.ok(declined.includes('not answered'), 'a refusal is tagged not answered');
    assert.equal(declined.includes('in their own words'), false, 'and NOT as words, which is a different thing');
    assert.ok(said.includes('in their own words'), 'an answer is tagged in their own words');
    assert.equal(said.includes('not answered'), false, 'and NOT as unanswered');
});

test('a wordless refusal renders as "they did not say"', async () => {
    const ejs = await import('ejs');
    const rendered = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: { frustration: { declined: true } } });

    assert.ok(rendered.includes('they did not say'), 'a refusal with no words says so');
});

test('a declined value must not render [object Object]', async () => {
    // Asserted directly for each marker shape, because "not answered" reads as a question that
    // was not answered while [object Object] reads as corruption.
    const ejs = await import('ejs');
    for (const value of [{ declined: 'I have no idea' }, { declined: true }, { said: 'it depends' }]) {
        const rendered = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
            { data: { peopleAffected: value } });
        assert.equal(/\[object Object\]/.test(rendered), false, `${JSON.stringify(value)} must not stringify an object`);
    }
});

test('participant words are ESCAPED wherever they are rendered, declined as well as said', async () => {
    // This is participant text on a console page, so both markers carry the same obligation.
    const ejs = await import('ejs');
    const hostile = '<script>alert(1)</script>';

    const declined = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: { peopleAffected: { declined: hostile } } });
    const said = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: { peopleAffected: { said: hostile } } });

    for (const [label, rendered] of [['declined', declined], ['said', said]]) {
        assert.equal(rendered.includes(hostile), false, `${label}: the raw tag must not reach the page`);
        assert.ok(rendered.includes('&lt;script&gt;'), `${label}: the words are entity-escaped`);
    }
});

// ===========================================================================
// 6. NOTHING ELSE MOVED
// ===========================================================================

test('the weighing marker for a `said` value is unchanged', () => {
    const grouping = { responses: [{ responseId: 'r1', department: 'Fin', data: { task: 'invoices', peopleAffected: { said: 'just me' } } }] };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /"saidInTheirWords":\s*"just me"/, 'the words are labelled');
    assert.match(message, /not a figure/i, 'with the note');
    assert.equal(/"said":/.test(message), false, 'and the raw marker does not reach the model');
});

test('a `declined` value reaches the weighing prompt LABELLED, as declinedToAnswer with a note', () => {
    // A refusal must not reach the weighing model raw: `{"declined":"I have no idea"}` sits
    // where every other field is a number or a list, so the model can read a refusal as a figure
    // or ignore the field without knowing why - and this is the marker whose WHOLE MEANING is
    // "there is nothing here". It arrives as `declinedToAnswer` with `theySaid` and a note, so
    // the note's PRESENCE is the assertion.
    const grouping = {
        responses: [{ responseId: 'r1', department: 'Fin', data: { task: 'invoices', peopleAffected: { declined: 'I have no idea' } } }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /"declinedToAnswer":\s*true/, 'the value is labelled as a refusal');
    assert.match(message, /"theySaid":\s*"I have no idea"/, 'and carries their words');
    assert.match(message, /NOT a value and NOT a zero/i, 'with a note saying it is neither');
    assert.match(message, /not measured rather than as nothing/i, 'and that unmeasured is not empty');

    // The raw marker must NOT reach the model.
    assert.equal(/"declined":/.test(message), false, 'the raw { declined } object must not appear');
});

test('a WORDLESS declined value gives theySaid: null with the same note', () => {
    // `{ declined: true }` is a refusal with no words to keep. The model must still be told what
    // it is looking at, with `theySaid: null` rather than a missing key or a bare boolean.
    const grouping = {
        responses: [{ responseId: 'r1', department: 'Fin', data: { task: 'invoices', peopleAffected: { declined: true } } }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /"declinedToAnswer":\s*true/, 'still labelled as a refusal');
    assert.match(message, /"theySaid":\s*null/, 'with null for the words');
    assert.match(message, /NOT a value and NOT a zero/i, 'and the same note');
    assert.equal(/"declined":/.test(message), false, 'the raw marker does not appear');
});

test('a refusal and a prose answer are labelled DIFFERENTLY, so neither can be read as the other', () => {
    // The distinction the weighing model depends on: "we could not measure this" and "there is
    // nothing here" are different statements. A prose answer says saidInTheirWords; a refusal
    // says declinedToAnswer; a typed value says neither.
    const grouping = {
        responses: [{
            responseId: 'r1', department: 'Fin',
            data: { peopleAffected: { declined: 'no idea' }, frustration: { said: 'the waiting' }, mistakesPerPeriod: 2 }
        }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /"declinedToAnswer":\s*true/, 'the refusal is a refusal');
    assert.match(message, /"saidInTheirWords":\s*"the waiting"/, 'the answer is an answer');
    assert.match(message, /"mistakesPerPeriod":\s*2/, 'the typed value passes through');
    // The refused field must NOT also be presented as words.
    const declinedBlock = message.slice(message.indexOf('"declinedToAnswer"'));
    assert.equal(/declinedToAnswer[\s\S]{0,200}"saidInTheirWords"/.test(declinedBlock), false,
        'a refusal is not also labelled as their words');
});

test('the weighing prompts gained the three-row table, in BOTH languages', () => {
    // The commit claims both weighing prompts gained a table distinguishing a measured zero from
    // an unmeasurable field. Pinned so the prompt half cannot drift from the code half.
    for (const lang of LANGS) {
        const text = fs.readFileSync(path.join(PROMPTS_DIR, `weigh_${lang}.md`), 'utf8');
        assert.match(text, /declinedToAnswer/, `${lang} names the marker it will receive`);
        // "not measured" is the English wording; the Dutch says "niet gemeten". Either is the
        // line the note draws, so the test accepts the language's own word for it.
        assert.ok(/not measured|niet gemeten/i.test(text), `${lang} draws the not-measured line`);
    }
});

test('the derivation rules, the sweep and the typed minimum are unchanged', () => {
    // Item 6: the rest of the prompt must not have drifted with the declined change.
    const en = prompt('en');
    assert.match(en, /re-read the WHOLE conversation/i, 'the sweep is intact');
    assert.match(en, /### 1\. DERIVE/, 'the derivation step is intact');
    assert.deepEqual([...shapes.TYPED_MINIMUM_FIELDS], TYPED_MINIMUM, 'the typed minimum is the same five names');

    const nl = prompt('nl');
    assert.match(nl, /### 1\. LEID AF/, 'NL derivation intact');
});

// ===========================================================================
// 7. WHAT CONSUMES THE THIRD STATUS - every reader of `status`
// ===========================================================================
//
// `nothing_answered` is a new value beside `asking` and `complete`, and a status one reader does
// not know about is how a round disappears. These are the readers: the client (which decides
// whether to finalise and whether to score), the store (which records the round as finished),
// the roadmap (which must not show it as a scored process), and the console (which must show it
// with every field marked).
//
// The store tests need a temp STORE_DIR set BEFORE the store is imported, so the import is
// dynamic and lives here rather than at the top of the file.

test('the client FINALISES the round and DOES NOT SCORE it', () => {
    // A `nothing_answered` reply ends the round (the client passes `complete: true`) and does NOT
    // go through scoring, because scoring an empty round would produce a figure from no evidence.
    // The assertion is that the round finalises with `nothingAnswered` among the conditions, and
    // that no nothing_answered path reaches scoring.
    const client = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

    assert.match(client, /const nothingAnswered = data\.status === 'nothing_answered'/,
        'the client recognises the third status');
    // FINALISES: `nothingAnswered` is one of the conditions passed to saveResponse.
    assert.match(client, /await saveResponse\(toSave, [^)]*nothingAnswered[^)]*\)/,
        'and finalises the round when it arrives');
    // DOES NOT SCORE: the nothing_answered branch RETURNS before the scoring call, so an empty
    // round cannot reach `runScoring`. Asserted as ORDER rather than as the text of the scoring
    // line, because a source-text pattern pinned to a local variable name says nothing about the
    // intent. What the intent needs is that the `return` precedes scoring, in the branch that
    // handles the empty round.
    const nothingBranch = client.slice(client.indexOf('if (nothingAnswered) {'), client.indexOf('if (exhausted) {'));
    assert.notEqual(nothingBranch, '', 'the nothingAnswered branch exists');
    assert.match(nothingBranch, /return;/, 'and it RETURNS');
    assert.equal(/runScoring/.test(nothingBranch), false,
        'without calling runScoring, so the empty round cannot be scored');
    // And the scoring call that DOES exist is reached only for a complete or exhausted round.
    assert.match(client, /if \(isComplete && toSave\) \{/, 'scoring is gated on a completed round');
    assert.match(client, /if \(toSave\) \{\s*\n\s*state\.audit = toSave;\s*\n\s*await runScoring\(\);\s*\n\s*\}/,
        'and the exhausted branch scores `toSave`, not the raw payload');
    assert.match(client, /if \(nothingAnswered\) \{\s*\n\s*\$\('input-area'\)\.classList\.add\('hidden'\);\s*\n\s*return;/,
        'the nothing_answered branch returns immediately, without scoring');
    // The input is hidden, so the participant is not left able to answer a closed round.
    assert.match(client, /if \(nothingAnswered\) \{\s*\n\s*\$\('input-area'\)\.classList\.add\('hidden'\)/,
        'and the input is hidden, because there is nothing more to answer');
});

test('a `nothing_answered` round is FINALISED in the store - the round ends', async () => {
    // `submitted_at` is the store's only way to say a round is finished, and the client sets it
    // (`complete: true`) for a nothing_answered reply. This asserts the round actually ends: staying
    // open is the trap the third status closes.
    const fsMod = await import('node:fs');
    const os = await import('node:os');
    const STORE_DIR = fsMod.mkdtempSync(path.join(os.tmpdir(), 'fr-nothing-'));
    const previous = process.env.STORE_DIR;
    process.env.STORE_DIR = STORE_DIR;
    process.env.SESSION_SECRET = 'b'.repeat(64);

    try {
        const store = await import(`../lib/store/index.js?nothing=${Date.now()}`);
        const org = store.createOrganisation('Nothing org');
        const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });

        // The first turn is a partial round (submitted_at null), as any early turn is.
        store.recordTurn(org.id, invitation.token, { data: { task: 'invoices' }, transcript: [] });
        assert.equal(store.getResponsesForAnalysis(org.id).length, 0,
            'before finalising, the partial round is not in the analysis set');
        assert.equal(store.getAllResponses(org.id).length, 1,
            'but it IS visible in the answers view, which includes partials');

        // The client finalises with `complete: true` when the status is nothing_answered.
        store.recordTurn(org.id, invitation.token, { data: { task: { declined: 'no idea' } }, transcript: [], complete: true });

        const analysis = store.getResponsesForAnalysis(org.id);
        assert.equal(analysis.length, 1, 'the finalised round IS in the analysis set (submitted_at is set)');
        assert.equal(store.getAllResponses(org.id).length, 1, 'the same row, now finalised rather than partial');
        // But it carries no usable evidence, which is why no process is created from it.
        assert.equal(typeof analysis[0].data.task, 'object', 'the data holds the declined marker, no typed value');
    } finally {
        if (previous === undefined) delete process.env.STORE_DIR;
        else process.env.STORE_DIR = previous;
        fsMod.rmSync(STORE_DIR, { recursive: true, force: true });
    }
});

test('an all-declined round creates NO process, so the roadmap never shows it as scored', async () => {
    // An all-declined round carries no evidence, so declining everything gains a model exactly
    // what answering nothing gains. A process is only created by identification, which needs a
    // usable field, so no process exists to appear on the roadmap. Asserted through the code path
    // the gate feeds: the reply carries no `audit` payload, so the client has nothing to score and
    // identification has nothing to group.
    const allDeclined = allDeclinedProcess();
    const result = complete(allDeclined, { status: 'asking', content: 'Anything else?' });

    assert.equal(result.status, 'nothing_answered');
    assert.equal(result.audit, undefined, 'no payload reaches the scorer');
    // Every field in the payload is a refusal, so nothing can be identified from it.
    const usable = Object.values(allDeclined).filter(
        (value) => value && typeof value === 'object' && !Object.hasOwn(value, 'declined')
    );
    assert.equal(usable.length, 0, 'no field carries a usable value');
});
