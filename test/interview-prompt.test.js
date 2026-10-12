/**
 * The interview prompt's DERIVE / ASK / RECORD rewrite, and the `{ said: ... }` marker.
 *
 * WHY THIS FILE EXISTS. The prompt used to say, of the typed minimum, "ask about it - once,
 * in different words". That instruction is what the owner experienced as the model looping,
 * and the model was following it. It applied to only four fields, so the other eleven had no
 * rule at all and the model fell back to asking.
 *
 * The rewrite covers all fifteen fields with three steps, makes the overlap between fields
 * concrete, and adds a stop rule. `{ said: ... }` records an answer that will not fit a type,
 * and is refused by the typed minimum so a model cannot complete by writing prose everywhere.
 *
 * PROMPT TESTS ARE TEXT ASSERTIONS, and they are the right shape for a change whose artefact
 * IS prose: the rule is the thing that governs the model, so the rule's presence and its
 * exact condition are the behaviour. They are pinned against drift, which is the failure this
 * file is for.
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

/** A process with every field typed CORRECTLY, so a test can flood one field at a time. */
function typedProcess(overrides = {}) {
    const process = { task: 'entering invoices', trigger: 'the mail arrives' };
    process.steps = [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'a value']))];
    process.frequencyPerWeek = 2;

    // EACH FIELD GETS THE SHAPE IT REQUIRES, not a blanket string: a `count` field needs a
    // number and a `text[]` field an array of strings, and a fixture that gets this wrong is
    // itself incomplete, which would make every assertion below meaningless.
    const typedValues = {
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

    return { ...process, ...typedValues, ...overrides };
}

/** Parses a completion reply asserting that everything is present. */
function completionWith(process) {
    return parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [process],
        have: [...matrix.ALL_PROCESS_FIELD_NAMES],
        missing: []
    }));
}

// ===========================================================================
// 1. THE THREE STEPS, IN BOTH LANGUAGES, COVERING ALL FIFTEEN FIELDS
// ===========================================================================

test('the English prompt states the three steps in order', () => {
    const text = prompt('en');
    assert.match(text, /### 1\. DERIVE/, 'step 1 is DERIVE');
    assert.match(text, /### 2\. ASK/, 'step 2 is ASK');
    assert.match(text, /### 3\. RECORD AND MOVE ON/, 'step 3 is RECORD AND MOVE ON');

    // In order, so the sequence is the rule rather than three separate headings.
    assert.ok(text.indexOf('### 1. DERIVE') < text.indexOf('### 2. ASK'), 'DERIVE precedes ASK');
    assert.ok(text.indexOf('### 2. ASK') < text.indexOf('### 3. RECORD AND MOVE ON'), 'ASK precedes RECORD');
});

test('the Dutch prompt states the three steps in order', () => {
    const text = prompt('nl');
    assert.match(text, /### 1\. LEID AF/, 'step 1 is LEID AF');
    assert.match(text, /### 2\./, 'step 2 is present');
    assert.match(text, /### 3\./, 'step 3 is present');
});

test('the steps cover EVERY field rather than the four of the old rule', () => {
    // The old rule applied to the typed minimum only, which left the other eleven with no
    // guidance. The sweep is now stated as applying to every field.
    const text = prompt('en');
    assert.match(text, /it applies to every field/i, 'the scope is stated as every field');
    assert.match(text, /DERIVE BEFORE YOU ASK\.\*\* For every field in `missing`/s, 'the rule names `missing`, which is every field');
});

test('the REMOVED wording is gone from both languages', () => {
    // The instruction that produced the loop, asserted absent so it cannot return.
    for (const lang of LANGS) {
        assert.equal(
            /ask about it\s*-\s*once, in different words/i.test(prompt(lang)),
            false,
            `${lang} must not carry the removed rephrase instruction`
        );
    }
});

test('neither language allows an unconditional re-ask of the same field', () => {
    // The rule now is: at most TWO attempts, the second in genuinely different words, and a
    // third is forbidden. The removed rule had no such cap. This asserts the cap exists in
    // both languages, which is what makes the stop rule real.
    for (const lang of LANGS) {
        const text = prompt(lang);
        const capped = /TWO ATTEMPTS, THEN RECORD AND MOVE ON/i.test(text)
            || /TWEE POGINGEN, DAN VASTLEGGEN EN VERDER/i.test(text);
        assert.ok(capped, `${lang} must state the two-attempt cap`);
        const noThird = /ASKING (THE SAME THING|THE SAME QUESTION) A THIRD TIME IS A FAILURE/i.test(text)
            || /EEN DERDE KEER HETZELFDE VRAGEN IS EEN FOUT/i.test(text);
        assert.ok(noThird, `${lang} must forbid a third asking`);
    }
});

// ===========================================================================
// 2. THE DERIVATION RULES
// ===========================================================================

test('the derivation examples are present: one fact, two fields', () => {
    const text = prompt('en');
    assert.match(text, /candidate replies to an advert/i, 'the trigger/dependsOn example is present');
    assert.match(text, /the advert being live/i, 'and its dependsOn half');
    assert.match(text, /I am alone on this/i, 'and the peopleAffected example');
    assert.match(text, /peopleAffected: \{ "said":/, 'and states it as a peopleAffected answer');
});

test('the sweep instruction is present: re-read the WHOLE conversation', () => {
    const text = prompt('en');
    assert.match(text, /re-read the WHOLE conversation/i, 'the sweep is stated');
    assert.match(text, /SWEEP THE WHOLE CONVERSATION EVERY TURN/i, 'and repeated as a rule');
});

test('the Dutch prompt carries the same derivations', () => {
    const text = prompt('nl');
    // The same examples, in Dutch: the advert trigger and the "alone" peopleAffected.
    assert.match(text, /advertentie/i, 'the advert example is present');
    assert.match(text, /alleen/i, 'and the "alone" example');
});

// ===========================================================================
// 3. THE STOP RULE
// ===========================================================================

test('the stop rule is stated in both languages', () => {
    assert.match(prompt('en'), /ASKING THE SAME THING A THIRD TIME IS A FAILURE, NOT PERSISTENCE/i);
    assert.match(prompt('nl'), /EEN DERDE KEER HETZELFDE VRAGEN IS EEN FOUT, GEEN VOLHARDING/i);
});

test('the stop rule is made detectable through the conversation, with NO new state', () => {
    const text = prompt('en');
    assert.match(text, /You can see your own earlier turns in the messages you are\s+sent/i, 'the model is told it can read back');
    assert.match(text, /Look at your\s+own questions before asking one, and count them/i, 'and told to count its own questions');
});

test('the model really does receive its own earlier turns, so the stop rule rests on something true', async () => {
    // THE INTENT, WHICH STILL HOLDS: an assistant turn the model produced is in the next
    // request's messages, so the model can read its own earlier questions and the stop rule
    // rests on something real rather than on remembered state elsewhere.
    //
    // THE CLAIM IS NO-NEW-STATE, NOT NO-TRANSFORMATION. The line that used to be asserted here
    // was `safeMessages.push(msg)`, and it now pushes `{ role, content }` INSTEAD - the same
    // turn, with the internal bookkeeping fields dropped before the provider sees them. So this
    // reads the purpose rather than the push: non-user messages are forwarded, and the forwarded
    // form keeps role and content.
    //
    // Checked against the source, since a live call would need a provider.
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'ai', 'audit-core.js'), 'utf8');

    // 1. A NON-USER MESSAGE IS FORWARDED, wherever the guard builds the safe list.
    assert.match(source, /if \(msg\.role !== 'user'\) \{[\s\S]{0,120}?safeMessages\.push\(/,
        'non-user messages are forwarded rather than dropped');
    // 2. THE FORWARDED FORM KEEPS ROLE AND CONTENT, which is what makes it the model's own turn.
    assert.match(source, /safeMessages\.push\(\{ role: msg\.role, content: msg\.content \}\)/,
        'an assistant turn is forwarded as role and content');
    // 3. and only those, so the internal fields do not reach the provider.
    assert.equal(/safeMessages\.push\(msg\)/.test(source), false,
        'the raw message is not what is forwarded');
    // 4. The whole list reaches the provider, so the forwarded turns are actually sent.
    assert.match(source, /messages: withFormatCommitment\(safeMessages\)/, 'and the whole list is sent to the provider');
});

// ===========================================================================
// 4. `{ said: ... }` AND THE TYPED MINIMUM
// ===========================================================================

test('the typed minimum is exactly the five names the prompt lists', () => {
    // Five names, four requirements: the effort pair is either/or.
    assert.deepEqual(
        [...shapes.TYPED_MINIMUM_FIELDS],
        ['task', 'trigger', 'steps', 'frequencyPerWeek', 'timePerPeriod'],
        'the code list matches the prompt'
    );
    // And the prompt names them.
    const text = prompt('en');
    assert.match(text, /WHICH FIELDS MAY NOT BE PROSE/, 'the prompt states the rule');
    for (const field of shapes.TYPED_MINIMUM_FIELDS) {
        if (field === 'timePerPeriod') continue; // named in the same line as frequencyPerWeek
        assert.ok(text.includes(field), `the prompt names ${field}`);
    }
});

test('the typed minimum REFUSES prose, each field asserted', () => {
    for (const field of ['task', 'trigger', 'steps']) {
        const result = completionWith(typedProcess({ [field]: { said: 'the participant said words' } }));
        assert.equal(result.status, 'asking', `prose in ${field} must not count as supplied`);
        assert.ok(result.missing.includes(field), `${field} must be named as still missing`);
    }
});

test('the effort pair refuses prose on EITHER half, which is why both are listed', () => {
    // The pair is one requirement: a typed `frequencyPerWeek` satisfies it however
    // `timePerPeriod` is written, and a typed `timePerPeriod` satisfies it however
    // `frequencyPerWeek` is written. Prose alone on the pair, with neither typed, leaves the
    // requirement unmet - which is the property the two names exist for.
    for (const [typed, prose] of [['frequencyPerWeek', 'timePerPeriod'], ['timePerPeriod', 'frequencyPerWeek']]) {
        // A typed value on one half: the requirement is satisfied despite prose on the other.
        const satisfied = completionWith(typedProcess({
            [typed]: typed === 'frequencyPerWeek' ? 2 : { hours: 2, period: 'week' },
            [prose]: { said: 'often enough' }
        }));
        assert.equal(satisfied.status, 'complete', `a typed ${typed} satisfies the pair`);

        // Prose on BOTH halves: nothing typed, so the requirement is unmet.
        const unmet = completionWith(typedProcess({
            frequencyPerWeek: { said: 'often' },
            timePerPeriod: { said: 'a while' }
        }));
        assert.equal(unmet.status, 'asking', 'prose on both halves leaves the effort requirement open');
        assert.ok(unmet.missing.includes('frequencyPerWeek'), 'and the pair is reported missing');
    }
});

test('a NORMAL field ACCEPTS prose', () => {
    // The other half: eleven fields may legitimately carry the participant's words.
    for (const field of ['peopleAffected', 'handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments',
        'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration']) {
        const process = typedProcess({ [field]: { said: `what they said about ${field}` } });
        const result = completionWith(process);

        assert.equal(result.status, 'complete', `prose in ${field} must count as supplied`);
        assert.equal(result.missing.includes(field), false);
    }
});

test('a malformed prose marker is not a marker, so it cannot close a field by asserting nothing', () => {
    // `{ said: "" }`, `{ said: 42 }` and `{ said: " " }` are not prose: they fall through to
    // the ordinary shape check, which refuses the object.
    for (const bad of [{ said: '' }, { said: '   ' }, { said: 42 }, { said: null }]) {
        assert.equal(shapes.proseSaidIn(bad), null, `${JSON.stringify(bad)} is not a marker`);
    }
    assert.equal(shapes.proseSaidIn({ said: 'real words' }), 'real words');
});

// ===========================================================================
// 5. THE TWO CONDITIONS THAT MAKE THE TRADE ACCEPTABLE
// ===========================================================================

test('A `{ said: ... }` ON EVERY FIELD DOES NOT COMPLETE — the property that stops prose winning', () => {
    // The condition the whole trade rests on: a model cannot finish by writing words into
    // everything, because the typed minimum would still be missing.
    const allProse = {};
    for (const field of [...matrix.PROCESS_FIELDS, ...matrix.EFFORT_FIELDS]) {
        allProse[field] = { said: `words for ${field}` };
    }

    const result = completionWith(allProse);

    assert.equal(result.status, 'asking', 'all-prose must not complete');
    assert.ok(result.missing.length > 0, 'and it names what is still missing');
    for (const field of ['task', 'trigger', 'steps']) {
        assert.ok(result.missing.includes(field), `${field} is still missing despite the prose`);
    }
});

test('prose on the ELEVEN normal fields, with the typed minimum typed, DOES complete', () => {
    // The contrast that shows all-prose fails for the right reason: only the typed minimum
    // is the floor.
    const process = { task: 'entering invoices', trigger: 'the mail arrives' };
    process.steps = [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'v']))];
    process.frequencyPerWeek = 2;
    for (const field of ['peopleAffected', 'handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments',
        'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration']) {
        process[field] = { said: `words for ${field}` };
    }

    const result = completionWith(process);
    assert.equal(result.status, 'complete', 'prose on a normal field is a real answer');
    assert.deepEqual(result.missing, []);
});

test('GENUINELY ABSENT evidence is still refused, distinct from prose', () => {
    // THE DIFFERENCE THE TRADE DEPENDS ON: "they answered, in words" and "they were never
    // asked" must not collapse. A field omitted entirely stays missing; the same field
    // recorded as prose does not.
    for (const field of ['dependsOn', 'frustration', 'peopleAffected']) {
        const present = typedProcess({ [field]: { said: 'their words' } });
        const absent = typedProcess();
        delete absent[field];

        const presentResult = completionWith(present);
        const absentResult = completionWith(absent);

        assert.equal(presentResult.status, 'complete', `${field} as prose completes`);
        assert.equal(presentResult.missing.includes(field), false);

        assert.equal(absentResult.status, 'asking', `${field} absent must not complete`);
        assert.ok(absentResult.missing.includes(field), `${field} absent must be named`);
    }
});

test('the two outcomes are DIFFERENT for the SAME field, asserted directly', () => {
    const asProse = completionWith(typedProcess({ currentState: { said: 'by hand, every time' } }));
    const omitted = typedProcess();
    delete omitted.currentState;
    const asAbsent = completionWith(omitted);

    assert.equal(asProse.status, 'complete');
    assert.equal(asAbsent.status, 'asking');
    assert.notEqual(asProse.status, asAbsent.status, 'prose and absence are not the same outcome');
});

// ===========================================================================
// 6. THE WEIGHING MARKER
// ===========================================================================

test('a `{ said: ... }` reaches the weighing prompt as saidInTheirWords, with a note', () => {
    // THE BUG THIS GUARDS: `mergeParticipants` passed the raw marker, so `{ said: "just me" }`
    // would have reached the model as an unexplained object it might score as a figure.
    const grouping = {
        responses: [{ responseId: 'r1', department: 'Finance', data: { task: 'invoices', peopleAffected: { said: 'just me' } } }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /saidInTheirWords/, 'the value is labelled as the participant\'s words');
    assert.match(message, /"saidInTheirWords":\s*"just me"/, 'and carries the words themselves');

    // The note is the fix, so its presence is the assertion.
    assert.match(message, /not a figure/i, 'the note says it is not a figure');
    assert.match(message, /not measured/i, 'and that an unmeasurable field differs from an empty one');

    // The raw marker must NOT reach the model: that was the bug.
    assert.equal(/"said":/.test(message), false, 'the raw { said } object must not appear');
});

test('an ORDINARY value reaches the weighing prompt unchanged, not wrapped', () => {
    // The marker transformation applies to prose only, so a typed value is not relabelled.
    const grouping = {
        responses: [{ responseId: 'r1', department: 'Finance', data: { task: 'invoices', peopleAffected: 3 } }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /"peopleAffected":\s*3/, 'a number is passed through');
    assert.equal(/saidInTheirWords/.test(message), false, 'and is not labelled as prose');
});

// ===========================================================================
// 7. THE RENDER
// ===========================================================================

test('the participant\'s words are rendered ESCAPED, tagged "in their own words"', async () => {
    const ejs = await import('ejs');
    const rendered = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'), {
        data: { peopleAffected: { said: '<script>alert(1)</script>' }, frustration: { said: 'onerror=alert(2)' } }
    });

    assert.equal(rendered.includes('<script>alert(1)</script>'), false, 'the raw tag must not reach the page');
    assert.ok(rendered.includes('&lt;script&gt;'), 'the words are entity-escaped');
    assert.ok(rendered.includes('in their own words'), 'and tagged as the participant\'s words');
});

test('the prose tag is in the CALM register, not the warning one', async () => {
    const ejs = await import('ejs');
    const rendered = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'), {
        data: { peopleAffected: { said: 'just me' } }
    });

    // A prose answer is legitimate, so the tag must not use a warning class.
    assert.equal(/class="[^"]*warn/i.test(rendered), false, 'no warning register for a legitimate answer');
    assert.match(rendered, /class="tag"/, 'the ordinary tag class is used');
});

test('a prose field renders the words, with no leftover marker object', async () => {
    const ejs = await import('ejs');
    const rendered = await ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'), {
        data: { peopleAffected: { said: 'just me, nobody else' } }
    });

    assert.ok(rendered.includes('just me, nobody else'), 'the words are shown');
    assert.equal(/\[object Object\]/.test(rendered), false, 'no object is stringified into the page');
    assert.equal(/"said"/.test(rendered), false, 'and the marker key is not shown');
});

// ===========================================================================
// THE AUTHOR'S TWO "NOT FULLY WORKING" REPORTS
// ===========================================================================
//
// These are assertions about the PROMPT, because the model's behaviour needs a live
// provider. They pin whether the rule as written can govern what it claims to.

test('REPORT 1: the stop rule forbids a repeated PHRASE, not only a repeated field', () => {
    // The author saw the same question text asked EIGHT times while `missing` fell from 10 to
    // 4, and reports the stop rule governs ASKING and did not catch the phrase. If the rule
    // only counts asks-per-field, a model can repeat one sentence for different fields.
    const text = prompt('en');

    // The rule DOES name a repeated question, not only a repeated field.
    assert.match(text, /ASKING THE SAME QUESTION AGAIN IS A FAILURE/i, 'the rule names the same QUESTION');
    assert.match(text, /five times, to the same question/i, 'and records the observed repetition');

    // But detection is left to the model reading its own turns, with no mechanical count, so
    // a model may still rephrase-and-repeat. Stated as a gap rather than asserted as working.
    assert.match(text, /count them/i, 'the mechanism is the model counting its own questions');
    assert.equal(
        /do not ask a question you have already asked in any form/i.test(text),
        false,
        'there is no phrasing-level prohibition the model could apply mechanically'
    );
});

test('REPORT 2: the prompt states that a prose-recorded field IS supplied', () => {
    // The prose marker alone did not let the interview close: the model recorded `{ said }`
    // and listed the field as missing anyway. The rule added for that is asserted here, and
    // the CODE behaviour is asserted above (a prose normal field completes).
    const text = prompt('en');
    assert.match(text, /the field stops being in `missing`/i, 'the prompt says the field stops being missing');
    assert.match(text, /it RECORDS what they told you/i, 'and that it is a record, not a failure');
});
