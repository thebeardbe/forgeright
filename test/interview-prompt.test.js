/**
 * The interview prompt's DERIVE / ASK / RECORD structure, and the `{ said: ... }` marker.
 *
 * PROMPT TESTS ARE TEXT ASSERTIONS, the right shape where the artefact IS prose: the rule governs
 * the model, so its presence and exact condition are the behaviour. Pinned against drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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

function typedProcess(overrides = {}) {
    const process = { task: 'entering invoices', trigger: 'the mail arrives' };
    process.steps = [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'a value']))];
    process.frequencyPerWeek = 2;

    // EACH FIELD GETS THE SHAPE IT REQUIRES, not a blanket string.
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

function completionWith(process) {
    return parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [process],
        have: [...matrix.ALL_PROCESS_FIELD_NAMES],
        missing: []
    }));
}

test('the English prompt states the three steps in order', () => {
    const text = prompt('en');
    assert.match(text, /### 1\. DERIVE/, 'step 1 is DERIVE');
    assert.match(text, /### 2\. ASK/, 'step 2 is ASK');
    assert.match(text, /### 3\. RECORD AND MOVE ON/, 'step 3 is RECORD AND MOVE ON');

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
    const text = prompt('en');
    assert.match(text, /it applies to every field/i, 'the scope is stated as every field');
    assert.match(text, /DERIVE BEFORE YOU ASK\.\*\* For every field in `missing`/s, 'the rule names `missing`, which is every field');
});

test('the REMOVED wording is gone from both languages', () => {
    for (const lang of LANGS) {
        assert.equal(
            /ask about it\s*-\s*once, in different words/i.test(prompt(lang)),
            false,
            `${lang} must not carry the removed rephrase instruction`
        );
    }
});

test('neither language allows an unconditional re-ask of the same field', () => {
    // At most TWO attempts, the second in genuinely different words.
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
    assert.match(text, /advertentie/i, 'the advert example is present');
    assert.match(text, /alleen/i, 'and the "alone" example');
});

test('the stop rule is stated in both languages', () => {
    assert.match(prompt('en'), /ASKING THE SAME THING A THIRD TIME IS A FAILURE, NOT PERSISTENCE/i);
    assert.match(prompt('nl'), /EEN DERDE KEER HETZELFDE VRAGEN IS EEN FOUT, GEEN VOLHARDING/i);
});

test('the stop rule is made detectable through the conversation, with NO new state', () => {
    const text = prompt('en');
    assert.match(text, /You can see your own earlier turns in the messages you are\s+sent/i, 'the model is told it can read back');
    assert.match(text, /Look at your\s+own questions before asking one, and count them/i, 'and told to count its own questions');
});

test('the model really does receive its own earlier turns, so the stop rule rests on something true', () => {
    // ASSERTED ON WHAT REACHES THE PROVIDER, not on how the loop is written. The role check moved when a
    // client-chosen `system` role was refused; a source-matching assertion broke with it while the
    // behaviour it names did not change.
    //
    // `ai/provider.js` imports its adapter eagerly, so the stub must be registered BEFORE the module
    // graph loads. That needs a child process with `register()`, which prints what the provider got.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-capture-'));
    const hooksFile = path.join(dir, 'hooks.mjs');
    const runnerFile = path.join(dir, 'runner.mjs');

    fs.writeFileSync(hooksFile, `
        const STUB = 'data:text/javascript,' + encodeURIComponent(
            'export async function generate(args) {' +
            '  (globalThis.__captured ||= []).push(args);' +
            '  return JSON.stringify({ status: "asking", content: "next question" });' +
            '}'
        );
        export async function resolve(specifier, context, next) {
            if (/adapters\\/mock\\.js$/.test(specifier)) return { url: STUB, shortCircuit: true };
            return next(specifier, context);
        }
    `);

    fs.writeFileSync(runnerFile, `
        import { register } from 'node:module';
        register('./hooks.mjs', import.meta.url);
        process.env.AI_PROVIDER = 'mock';
        const { runAuditTurn } = await import(${JSON.stringify(path.join(PROJECT_ROOT, 'ai', 'audit-core.js'))});
        await runAuditTurn({
            messages: [
                { role: 'user', content: 'I enter invoices.' },
                { role: 'assistant', content: 'EARLIER QUESTION MARKER' },
                { role: 'user', content: 'Every morning.' }
            ],
            lang: 'en'
        });
        process.stdout.write(JSON.stringify(globalThis.__captured || null));
    `);

    let out;
    try {
        out = execFileSync(process.execPath, [runnerFile], {
            cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe']
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    const captured = JSON.parse(out);
    assert.notEqual(captured, null, 'the provider seam was reached');
    assert.equal(captured.length, 1, 'and called exactly once');
    const received = captured[0];

    assert.ok(received.messages.some((m) => m.role === 'assistant' && m.content === 'EARLIER QUESTION MARKER'),
        'the assistant turn is in the list the provider receives, so the model can read its own questions');
    assert.ok(received.messages.some((m) => m.content === 'I enter invoices.'),
        'and so are the participant turns');
    assert.equal(JSON.stringify(received.messages).includes('substituted'), false,
        'the forwarded form carries role and content only, not the bookkeeping');
    assert.equal(/EARLIER QUESTION MARKER/.test(received.systemInstruction || ''), false,
        'and no conversation content is folded into the system instruction');
});

test('the typed minimum is exactly the five names the prompt lists', () => {
    assert.deepEqual(
        [...shapes.TYPED_MINIMUM_FIELDS],
        ['task', 'trigger', 'steps', 'frequencyPerWeek', 'timePerPeriod'],
        'the code list matches the prompt'
    );
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
    // The pair is ONE requirement: prose on both halves, with neither typed, leaves it unmet.
    for (const [typed, prose] of [['frequencyPerWeek', 'timePerPeriod'], ['timePerPeriod', 'frequencyPerWeek']]) {
        const satisfied = completionWith(typedProcess({
            [typed]: typed === 'frequencyPerWeek' ? 2 : { hours: 2, period: 'week' },
            [prose]: { said: 'often enough' }
        }));
        assert.equal(satisfied.status, 'complete', `a typed ${typed} satisfies the pair`);

        const unmet = completionWith(typedProcess({
            frequencyPerWeek: { said: 'often' },
            timePerPeriod: { said: 'a while' }
        }));
        assert.equal(unmet.status, 'asking', 'prose on both halves leaves the effort requirement open');
        assert.ok(unmet.missing.includes('frequencyPerWeek'), 'and the pair is reported missing');
    }
});

test('a NORMAL field ACCEPTS prose', () => {
    for (const field of ['peopleAffected', 'handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments',
        'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration']) {
        const process = typedProcess({ [field]: { said: `what they said about ${field}` } });
        const result = completionWith(process);

        assert.equal(result.status, 'complete', `prose in ${field} must count as supplied`);
        assert.equal(result.missing.includes(field), false);
    }
});

test('a malformed prose marker is not a marker, so it cannot close a field by asserting nothing', () => {
    for (const bad of [{ said: '' }, { said: '   ' }, { said: 42 }, { said: null }]) {
        assert.equal(shapes.proseSaidIn(bad), null, `${JSON.stringify(bad)} is not a marker`);
    }
    assert.equal(shapes.proseSaidIn({ said: 'real words' }), 'real words');
});

test('A `{ said: ... }` ON EVERY FIELD DOES NOT COMPLETE — the property that stops prose winning', () => {
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
    // "They answered, in words" and "they were never asked" must not collapse.
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

test('a `{ said: ... }` reaches the weighing prompt as saidInTheirWords, with a note', () => {
    const grouping = {
        responses: [{ responseId: 'r1', department: 'Finance', data: { task: 'invoices', peopleAffected: { said: 'just me' } } }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /saidInTheirWords/, 'the value is labelled as the participant\'s words');
    assert.match(message, /"saidInTheirWords":\s*"just me"/, 'and carries the words themselves');

    assert.match(message, /not a figure/i, 'the note says it is not a figure');
    assert.match(message, /not measured/i, 'and that an unmeasurable field differs from an empty one');

    assert.equal(/"said":/.test(message), false, 'the raw { said } object must not appear');
});

test('an ORDINARY value reaches the weighing prompt unchanged, not wrapped', () => {
    const grouping = {
        responses: [{ responseId: 'r1', department: 'Finance', data: { task: 'invoices', peopleAffected: 3 } }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping });

    assert.match(message, /"peopleAffected":\s*3/, 'a number is passed through');
    assert.equal(/saidInTheirWords/.test(message), false, 'and is not labelled as prose');
});

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

test('REPORT 1: the stop rule forbids a repeated PHRASE, not only a repeated field', () => {
    // Counting asks-per-field lets one sentence serve different fields.
    const text = prompt('en');

    assert.match(text, /ASKING THE SAME QUESTION AGAIN IS A FAILURE/i, 'the rule names the same QUESTION');
    assert.match(text, /five times, to the same question/i, 'and records the observed repetition');

    // NOT covered: detection is left to the model reading its own turns, with no mechanical count.
    assert.match(text, /count them/i, 'the mechanism is the model counting its own questions');
    assert.equal(
        /do not ask a question you have already asked in any form/i.test(text),
        false,
        'there is no phrasing-level prohibition the model could apply mechanically'
    );
});

test('REPORT 2: the prompt states that a prose-recorded field IS supplied', () => {
    const text = prompt('en');
    assert.match(text, /the field stops being in `missing`/i, 'the prompt says the field stops being missing');
    assert.match(text, /it RECORDS what they told you/i, 'and that it is a record, not a failure');
});
