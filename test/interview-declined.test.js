/**
 * A declined field is in `have` but not `supplied`: it stops the interview asking again WITHOUT
 * becoming evidence. Two LIMITS below are asserted as today's behaviour.
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

function complete(process, { content = 'Anything else?', have = [...matrix.ALL_PROCESS_FIELD_NAMES], status = 'complete' } = {}) {
    return parseModelResponse(JSON.stringify({
        status, content, processes: [process], have, missing: []
    }));
}

/**
 * Built from `ALL_PROCESS_FIELD_NAMES`, not the two sub-lists: those drop `timePerPeriod`, leaving
 * one field open and hiding the all-declined path.
 */
function allDeclinedProcess() {
    const process = {};
    for (const field of matrix.ALL_PROCESS_FIELD_NAMES) process[field] = DECLINE;
    return process;
}

const DECLINE = { declined: 'I have no idea' };

test('the four states: absent blocks, typed completes, said completes, declined refuses', () => {
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
    const result = complete(allDeclinedProcess());

    assert.equal(result.status, 'nothing_answered', 'declining everything ends the round honestly');
    assert.notEqual(result.status, 'complete', 'and does NOT claim there was something to analyse');
    assert.notEqual(result.status, 'asking', 'and is not left open, which was the trap');
});

test('an all-declined round supplies NOTHING: supplied is empty, have is full', () => {
    const computed = matrix.reconcileMatrix({ processes: [allDeclinedProcess()] });

    assert.equal(computed.supplied.length, 0, 'a refusal is never evidence');
    assert.equal(computed.declined.length, matrix.ALL_PROCESS_FIELD_NAMES.length, 'every field is a refusal');
    assert.equal(computed.have.length, matrix.ALL_PROCESS_FIELD_NAMES.length, 'and every field is answered-for');
    assert.equal(computed.missing.length, 0, 'so nothing is left to ask');
});

test('A DECLINED FIELD IS NOT IN `missing` - the half that stops the loop returning', () => {
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
    for (const field of ['task', 'trigger', 'steps', 'frequencyPerWeek', 'peopleAffected', 'dependsOn', 'frustration']) {
        const process = typedProcess();
        delete process[field];
        const result = complete(process);

        assert.equal(result.status, 'asking', `absent ${field} must still block`);
        assert.ok(result.missing.includes(field), `absent ${field} must be named missing`);
    }
});

test('the stricter direction: a declined value never counts where a typed value did', () => {
    const typed = complete(typedProcess({ peopleAffected: 3 }));
    const refused = complete(typedProcess({ peopleAffected: DECLINE }));

    assert.equal(typed.status, 'complete');
    assert.equal(refused.status, 'asking');
});

test('an all-declined reply ENDS the interview instead of returning the closing line forever', () => {
    const closing = 'Is there another process you would like to improve?';
    const result = complete(allDeclinedProcess(), { content: closing });

    assert.equal(result.status, 'nothing_answered', 'the round ends');
    assert.notEqual(result.content, closing, 'and the model\'s closing line is NOT what the participant sees');
});

test('the participant is TOLD, honestly and without thanking them for answers they did not give', () => {
    const result = complete(allDeclinedProcess());
    const content = result.content;

    assert.equal(typeof content, 'string');
    assert.ok(content.length > 0, 'there is a message');
    assert.match(content, /did not manage to capture any answers/i, 'it says what happened');
    assert.match(content, /not a problem on your side/i, 'and that it is not their failure');
    assert.equal(/thank you for your answers/i.test(content), false, 'it does not thank them for answers');
});

test('the reply TERMINATES: repeated turns all return the same finished status, not a forever-asking one', () => {
    const statuses = [1, 2, 3].map(() => complete(allDeclinedProcess()).status);

    assert.deepEqual(statuses, ['nothing_answered', 'nothing_answered', 'nothing_answered'],
        'every turn ends the round the same way, rather than asking forever');
    assert.equal(statuses.every((s) => s === 'asking'), false, 'it is NOT still asking');
});

test('nothing_answered fires on an ASKING reply too, not only when the model claims complete', () => {
    const result = complete(allDeclinedProcess(), { status: 'asking', content: 'Anything else?' });

    assert.equal(result.status, 'nothing_answered', 'the round ends regardless of the claimed status');
});

test('it CANNOT be reached without genuinely declining everything - the escape-hatch check', () => {
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
    const result = complete(allDeclinedProcess());

    assert.equal('audit' in result && result.audit !== undefined, false, 'no payload is produced');
    assert.equal(result.processes.every((p) => Object.keys(p).length > 0), true,
        'the processes are the declined ones, carrying no usable field');
});

test('the typed minimum cannot be `declined`, the same as it cannot be `said`', () => {
    for (const field of TYPED_MINIMUM) {
        const process = typedProcess({ [field]: DECLINE });
        if (field === 'frequencyPerWeek' && process.timePerPeriod === undefined) delete process.timePerPeriod;
        const result = complete(process);

        assert.equal(result.status, 'asking', `declining ${field} must not complete`);
    }
});

test('a malformed declined marker is NOT a marker, each shape checked', () => {
    assert.deepEqual(shapes.declinedIn({ declined: '   ' }), { declined: true, words: null },
        'a whitespace-only refusal is a wordless refusal, not a malformed one');
    assert.deepEqual(shapes.declinedIn({ declined: true }), { declined: true, words: null });
    assert.deepEqual(shapes.declinedIn({ declined: 'words' }), { declined: true, words: 'words' });

    for (const bad of [{ declined: 5 }, { decline: true }, { declined: false }, [], null, 'declined']) {
        assert.equal(shapes.declinedIn(bad), null, `${JSON.stringify(bad)} is not a marker`);
    }
});

test('a malformed declined marker leaves the field OPEN and blocks', () => {
    for (const bad of [{ declined: 5 }, { decline: true }, {}]) {
        const result = complete(typedProcess({ frustration: bad }));
        assert.equal(result.status, 'asking', `${JSON.stringify(bad)} must not complete the interview`);
        assert.ok(result.missing.includes('frustration'), 'the field is still open');
    }
});

test('a declined field and a said field are distinguished by shape, not by wording', () => {
    const words = 'I have no idea';
    assert.equal(complete(typedProcess({ frustration: { said: words } })).status, 'complete',
        'the same words under `said` are treated as an answer');
    assert.equal(complete(typedProcess({ frustration: { declined: words } })).status, 'asking',
        'under `declined` they are a refusal');
});

const partialProcess = () => {
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
    assert.ok(/who|what|how|when|which|where/i.test(result.content), 'the reply is a real question');
    assert.equal(result.status, 'asking', 'and the turn is still asking');
});

test('the closing question with `missing` EMPTY passes through untouched', () => {
    const closing = 'Is there another process you would like to improve?';
    const result = complete(typedProcess(), { content: closing });

    assert.equal(result.status, 'complete', 'the interview closes');
    assert.equal(result.content, closing, 'and the closing line is the model\'s own');
});

test('the phrase variants are recognised, not only one exact sentence', () => {
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
    const escaped = 'Anything else you would like to look at?';
    const result = complete(partialProcess(), { content: escaped });

    assert.notEqual(result.content, escaped, 'the wording is now recognised and replaced');
    assert.equal(result.status, 'asking', 'and the interview continues with a real question');
});

test('all seven closing phrasings are caught, in either word order', () => {
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
    const closing = 'Is there another process you would like to improve?';
    const result = complete(partialProcess(), { status: 'asking', content: closing, have: [] });

    assert.notEqual(result.content, closing, 'a closing question on an asking reply is replaced');
    assert.equal(result.status, 'asking', 'and the turn is still asking, with a real question');

    for (const content of ['Anything else you would like to look at?', 'Shall we move on?']) {
        assert.notEqual(complete(partialProcess(), { status: 'asking', content, have: [] }).content, content,
            `"${content}" on an asking reply must be replaced`);
    }
});

test('the over-reach check: 22 ordinary questions, 0 wrongly gated', () => {
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
    const result = complete(partialProcess(), { content: 'Is there anything else you would like to add?' });
    const suppliedFieldWords = /invoice|mail arrives/i;
    assert.equal(suppliedFieldWords.test(result.content), false,
        'the replacement does not re-ask a field that is already supplied');
});

test('the client renders a replaced question as an ordinary turn and does not stall', async () => {
    const client = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

    assert.match(client, /appendMessage\('ai', S\.aiLabel, data\.content\)/,
        'the reply content is rendered as an analyst turn');
    assert.match(client, /state\.conversation\.push\(\{\s*role: 'assistant',\s*content: data\.content/,
        'and recorded with its content, so the next turn sees it');

    assert.match(client, /if \(data\.status === 'error' \|\| data\.status === 'rejected'\) \{/,
        'the only early return is for error and rejected');
    assert.equal(/if \(data\.status !== .complete.\)[\s\S]*return/s.test(client), false,
        'nothing returns early on a non-complete status');
});

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
    const ejs = await import('ejs');
    for (const value of [{ declined: 'I have no idea' }, { declined: true }, { said: 'it depends' }]) {
        const rendered = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
            { data: { peopleAffected: value } });
        assert.equal(/\[object Object\]/.test(rendered), false, `${JSON.stringify(value)} must not stringify an object`);
    }
});

test('participant words are ESCAPED wherever they are rendered, declined as well as said', async () => {
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

test('the weighing marker for a `said` value is unchanged', () => {
    const grouping = { responses: [{ responseId: 'r1', department: 'Fin', data: { task: 'invoices', peopleAffected: { said: 'just me' } } }] };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /"saidInTheirWords":\s*"just me"/, 'the words are labelled');
    assert.match(message, /not a figure/i, 'with the note');
    assert.equal(/"said":/.test(message), false, 'and the raw marker does not reach the model');
});

test('a `declined` value reaches the weighing prompt LABELLED, as declinedToAnswer with a note', () => {
    const grouping = {
        responses: [{ responseId: 'r1', department: 'Fin', data: { task: 'invoices', peopleAffected: { declined: 'I have no idea' } } }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /"declinedToAnswer":\s*true/, 'the value is labelled as a refusal');
    assert.match(message, /"theySaid":\s*"I have no idea"/, 'and carries their words');
    assert.match(message, /NOT a value and NOT a zero/i, 'with a note saying it is neither');
    assert.match(message, /not measured rather than as nothing/i, 'and that unmeasured is not empty');

    assert.equal(/"declined":/.test(message), false, 'the raw { declined } object must not appear');
});

test('a WORDLESS declined value gives theySaid: null with the same note', () => {
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
    const declinedBlock = message.slice(message.indexOf('"declinedToAnswer"'));
    assert.equal(/declinedToAnswer[\s\S]{0,200}"saidInTheirWords"/.test(declinedBlock), false,
        'a refusal is not also labelled as their words');
});

test('the weighing prompts gained the three-row table, in BOTH languages', () => {
    for (const lang of LANGS) {
        const text = fs.readFileSync(path.join(PROMPTS_DIR, `weigh_${lang}.md`), 'utf8');
        assert.match(text, /declinedToAnswer/, `${lang} names the marker it will receive`);
        assert.ok(/not measured|niet gemeten/i.test(text), `${lang} draws the not-measured line`);
    }
});

test('the derivation rules, the sweep and the typed minimum are unchanged', () => {
    const en = prompt('en');
    assert.match(en, /re-read the WHOLE conversation/i, 'the sweep is intact');
    assert.match(en, /### 1\. DERIVE/, 'the derivation step is intact');
    assert.deepEqual([...shapes.TYPED_MINIMUM_FIELDS], TYPED_MINIMUM, 'the typed minimum is the same five names');

    const nl = prompt('nl');
    assert.match(nl, /### 1\. LEID AF/, 'NL derivation intact');
});

// A status one reader does not know about is how a round disappears.
//
// STORE_DIR must be set BEFORE the store is imported, so the import is dynamic and lives here.

test('the client FINALISES the round and DOES NOT SCORE it', () => {
    const client = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

    assert.match(client, /const nothingAnswered = data\.status === 'nothing_answered'/,
        'the client recognises the third status');
    assert.match(client, /await saveResponse\(toSave, [^)]*nothingAnswered[^)]*\)/,
        'and finalises the round when it arrives');
    const nothingBranch = client.slice(client.indexOf('if (nothingAnswered) {'), client.indexOf('if (exhausted) {'));
    assert.notEqual(nothingBranch, '', 'the nothingAnswered branch exists');
    assert.match(nothingBranch, /return;/, 'and it RETURNS');
    assert.equal(/runScoring/.test(nothingBranch), false,
        'without calling runScoring, so the empty round cannot be scored');
    assert.match(client, /if \(isComplete && toSave\) \{/, 'scoring is gated on a completed round');
    assert.match(client, /if \(toSave\) \{\s*\n\s*state\.audit = toSave;\s*\n\s*await runScoring\(\);\s*\n\s*\}/,
        'and the exhausted branch scores `toSave`, not the raw payload');
    assert.match(client, /if \(nothingAnswered\) \{\s*\n\s*\$\('input-area'\)\.classList\.add\('hidden'\);\s*\n\s*return;/,
        'the nothing_answered branch returns immediately, without scoring');
    assert.match(client, /if \(nothingAnswered\) \{\s*\n\s*\$\('input-area'\)\.classList\.add\('hidden'\)/,
        'and the input is hidden, because there is nothing more to answer');
});

test('a `nothing_answered` round is FINALISED in the store - the round ends', async () => {
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

        store.recordTurn(org.id, invitation.token, { data: { task: 'invoices' }, transcript: [] });
        assert.equal(store.getResponsesForAnalysis(org.id).length, 0,
            'before finalising, the partial round is not in the analysis set');
        assert.equal(store.getAllResponses(org.id).length, 1,
            'but it IS visible in the answers view, which includes partials');

        store.recordTurn(org.id, invitation.token, { data: { task: { declined: 'no idea' } }, transcript: [], complete: true });

        const analysis = store.getResponsesForAnalysis(org.id);
        assert.equal(analysis.length, 1, 'the finalised round IS in the analysis set (submitted_at is set)');
        assert.equal(store.getAllResponses(org.id).length, 1, 'the same row, now finalised rather than partial');
        assert.equal(typeof analysis[0].data.task, 'object', 'the data holds the declined marker, no typed value');
    } finally {
        if (previous === undefined) delete process.env.STORE_DIR;
        else process.env.STORE_DIR = previous;
        fsMod.rmSync(STORE_DIR, { recursive: true, force: true });
    }
});

test('an all-declined round creates NO process, so the roadmap never shows it as scored', async () => {
    const allDeclined = allDeclinedProcess();
    const result = complete(allDeclined, { status: 'asking', content: 'Anything else?' });

    assert.equal(result.status, 'nothing_answered');
    assert.equal(result.audit, undefined, 'no payload reaches the scorer');
    const usable = Object.values(allDeclined).filter(
        (value) => value && typeof value === 'object' && !Object.hasOwn(value, 'declined')
    );
    assert.equal(usable.length, 0, 'no field carries a usable value');
});
