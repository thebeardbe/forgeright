/**
 * The fourth state (`declined`), the completion gate that reads `supplied`, and the code gate
 * that suppresses a closing question while fields are still open.
 *
 * WHY THIS FILE EXISTS. `{ said: ... }` accepted a refusal as a value, because it checked only
 * that the string was non-empty. A live interview recorded "I have no idea" against seven fields
 * and COMPLETED, so an audit that says nothing read as finished - the shape this project keeps
 * meeting. The fix separates two things the one marker conflated:
 *
 *   have       "do not ask again"
 *   supplied   "the analysis has something to work with"
 *
 * and the completion gate reads `supplied`. A declined field is in `have` and not in `supplied`,
 * which is the whole point: it stops the interview asking again WITHOUT becoming evidence.
 *
 * TWO DEFECTS FOUND WHILE WRITING THIS FILE ARE RECORDED BELOW AS ASSERTIONS ON THE CURRENT
 * BEHAVIOUR, NOT AS PASSING CLAIMS. They are localised with "KNOWN DEFECT" and they assert what
 * the code DOES today, so they are honest witnesses rather than a green wash. They are the two
 * directions the fourth state pulls in when EVERY field is declined.
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
function complete(process, { content = 'Anything else?', have = [...matrix.ALL_PROCESS_FIELD_NAMES] } = {}) {
    return parseModelResponse(JSON.stringify({
        status: 'complete', content, processes: [process], have, missing: []
    }));
}

const DECLINE = { declined: 'I have no idea' };

// ===========================================================================
// 1. THE FOUR STATES, EACH DIRECTION
// ===========================================================================

test('the four states: absent blocks, typed completes, said completes, declined refuses', () => {
    // The table the commit gives, asserted through the gate rather than against the lists.
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

test('EVERY field declined -> asking, never complete (the reviewer\'s live failure, refused)', () => {
    const allDeclined = {};
    for (const field of [...matrix.PROCESS_FIELDS, ...matrix.EFFORT_FIELDS]) allDeclined[field] = DECLINE;

    const result = complete(allDeclined);

    assert.equal(result.status, 'asking', 'refusing everything must not finish the interview');
    assert.notEqual(result.status, 'complete');
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
// KNOWN DEFECT 1 - EVERY FIELD DECLINED IS A FIXED POINT THAT CANNOT CLOSE OR MOVE
// ===========================================================================

test('KNOWN DEFECT 1: declining everything leaves `missing` empty, so the interview cannot progress or close', () => {
    // THIS IS THE TRAP THE COMMIT NAMES - "leaving it in missing keeps it open forever" - REACHED
    // FROM THE OTHER SIDE.
    //
    // When EVERY field of a process is declined: `have` holds all fifteen (so the prompt says
    // do not ask again, and there is no open field to ask about), `missing` is EMPTY (so the
    // closing-question replacement in audit-core has nothing to replace with and passes the
    // model's closing line through unchanged), and `supplied` is empty (so the gate refuses
    // completion). The turn is a FIXED POINT: every identical input returns identical `asking`
    // output, the participant sees a closing question, and the interview never ends.
    //
    // THE ASSERTIONS BELOW RECORD WHAT THE CODE DOES TODAY, so a future fix turns them red on
    // purpose. They are NOT a claim that this is correct.
    const allDeclined = {};
    for (const field of [...matrix.PROCESS_FIELDS, ...matrix.EFFORT_FIELDS]) allDeclined[field] = DECLINE;

    const result = complete(allDeclined, { content: 'Is there another process you would like to improve?' });
    const computed = matrix.reconcileMatrix({ processes: [allDeclined] });

    assert.equal(result.status, 'asking', 'DEFECT: never completes');
    assert.equal(result.missing.length, 0, 'DEFECT: nothing left to ask, so nothing can be replaced');
    assert.equal(result.have.length, matrix.ALL_PROCESS_FIELD_NAMES.length, 'DEFECT: every field is have');
    assert.equal(computed.supplied.length, 0, 'DEFECT: nothing supplied, so the gate can never open');
    // The closing question is NOT replaced, because there is no open field to replace it with.
    assert.equal(result.content, 'Is there another process you would like to improve?',
        'DEFECT: the closing line reaches the participant unchanged');
});

test('KNOWN DEFECT 1 (cont.): the state is a fixed point - repeated turns are identical', () => {
    // The same input three times, asserting the output does not move. If the interview could
    // progress, one of these would differ; if it closed, one would be `complete`.
    const allDeclined = {};
    for (const field of [...matrix.PROCESS_FIELDS, ...matrix.EFFORT_FIELDS]) allDeclined[field] = DECLINE;

    const turns = [1, 2, 3].map(() => complete(allDeclined, { content: 'Is there another process you would like to improve?' }));
    const signature = (r) => JSON.stringify({ s: r.status, m: r.missing, h: r.have, c: r.content });

    assert.equal(signature(turns[1]), signature(turns[0]), 'DEFECT: turn 2 is identical to turn 1');
    assert.equal(signature(turns[2]), signature(turns[1]), 'DEFECT: turn 3 is identical to turn 2');
    assert.ok(turns.every((r) => r.status === 'asking'), 'DEFECT: it never closes');
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
    // `{declined:"   "}` IS a marker: a wordless refusal, which the commit says is accepted.
    // The rest are not markers and fall through to the shape check, which refuses them, so the
    // field stays OPEN rather than silently closed.
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
    // A live run phrased the closing question two different ways in ONE interview, so matching
    // exact text would have caught neither. Each of these must be replaced.
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

test('FINDING: a natural closing phrasing escapes the gate because of WORD ORDER', () => {
    // THE GAP THE VARIANT TEST ABOVE WOULD HAVE HIDDEN. One shape is written
    // `/would you like to (?:improve|look at|add)/`, which requires "would you like to". A
    // single-character reordering - "Anything else you would like to look at?" - puts `you`
    // first and matches NOTHING, so a closing question in that form reaches the participant with
    // the matrix unsatisfied: precisely the abandonment the code gate exists to prevent. A live
    // model is at least as likely to produce this word order as the matched one.
    //
    // RECORDED AS TODAY'S BEHAVIOUR so a broader shape turns it red on purpose.
    const escaped = 'Anything else you would like to look at?';
    const result = complete(partialProcess(), { content: escaped });

    assert.equal(result.content, escaped, 'FINDING: this wording is NOT recognised and passes through');
    assert.equal(result.status, 'asking', 'FINDING: and the interview is still open when it is shown');
});

test('a question that is NOT the closing question is untouched - the over-reach check', () => {
    // THE OBVIOUS OVER-REACH. The replacement must fire on the closing question and not on the
    // hundreds of ordinary questions an interview is made of, or it would silently rewrite the
    // interview. Asserted with questions that share words ("process", "anything") with the
    // closing shapes but are genuinely about a field.
    const ordinary = [
        'What systems do you use for this?',
        'How often does this happen?',
        'Who else is involved in this process?',
        'What happens next after you send it?',
        'Can you describe the steps you take?',
        'Is this process something you do alone?'
    ];
    for (const content of ordinary) {
        const result = complete(partialProcess(), { content });
        assert.equal(result.content, content, `"${content}" must pass through unchanged`);
    }
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
    // A suppressed question that stalls the interview would be worse than the bug, so this
    // checks the client: it appends `content` as an assistant turn and keeps the input open for
    // any reply that is not an error, regardless of `status`.
    const client = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

    // The content of every non-error reply is appended and pushed to the conversation.
    assert.match(client, /appendMessage\('ai', S\.aiLabel, data\.content\)/,
        'the reply content is rendered as an analyst turn');
    assert.match(client, /state\.conversation\.push\(\{ role: 'assistant', content: data\.content \}\)/,
        'and recorded, so the next turn sees it');

    // Only `error` and `rejected` stop the turn; `asking` does not, so nothing waits on complete.
    assert.match(client, /if \(data\.status === 'error' \|\| data\.status === 'rejected'\) \{/,
        'the only early return is for error and rejected');
    assert.equal(/if \(data\.status !== .complete.\).*return/s.test(client), false,
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

test('THE AUTHOR\'S RENDER BUG: a declined value must not render [object Object]', async () => {
    // The author found this while verifying. It is asserted directly, because "not answered"
    // reads as a question that was not answered while [object Object] reads as corruption.
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

test('KNOWN DEFECT 2: a `declined` value reaches the weighing prompt UNLABELLED', () => {
    // THE SAME BUG CLASS THE LAST ROUND FOUND, ONE STEP OVER, and item 6 of this brief asks
    // specifically that no raw `{declined:...}` object reach the model as something it might
    // score. It does. `mergeParticipants` transforms `proseSaidIn` values only; a declined
    // value passes through untouched, so the weighing model sees `{"declined":"I have no idea"}`
    // where every other field is a number or a list - exactly the situation the `said` note was
    // added to prevent, now in a marker whose entire meaning is "there is nothing here".
    //
    // THE ASSERTIONS RECORD TODAY'S BEHAVIOUR, so a fix turns them red on purpose.
    const grouping = {
        responses: [{ responseId: 'r1', department: 'Fin', data: { task: 'invoices', peopleAffected: { declined: 'I have no idea' } } }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /"declined":\s*"I have no idea"/, 'DEFECT: the raw declined object reaches the model');
    assert.equal(/declined/.test(message) && /not supplied|not an answer|no answer given/i.test(message), false,
        'DEFECT: and it carries no note saying what it means');

    // The wordless form is worse: the model sees a bare `{"declined":true}`.
    const wordless = weighCore.buildWeighingMessage({
        process: { name: 'P' },
        grouping: { responses: [{ responseId: 'r1', department: 'Fin', data: { mission: 1, peopleAffected: { declined: true } } }] }
    });
    assert.match(wordless, /"declined":\s*true/, 'DEFECT: {"declined":true} reaches the model as-is');
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
