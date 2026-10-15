/**
 * EJS comments must not contain a delimiter of their own language.
 *
 * THE SHAPE OF THE LEAK. A template comment can leak into the live page when it contains an
 * ESCAPED opener, `&lt;%=`. EJS looks for `%>` to end a comment and does not care that the `<` was
 * HTML-escaped, so the first `%>` inside that escaped tag terminates the comment there and
 * everything AFTER it becomes template output. The tail renders as body text in the detail block,
 * once per page, because an include is a single parse.
 *
 * WHY THIS IS A SOURCE CHECK AND NOT AN OUTPUT CHECK. The leaked text is not inside
 * the comment - it is what comes after the premature terminator - so the rendered page
 * contains prose with no output marker in the source to identify it by. Output-side
 * detection finds either nothing or legitimate `<h3>` markup, where the check is exact. The
 * unreliable part is proving a leak from the OUTPUT; proving it from the SOURCE is exact.
 *
 * THE RULE, stated so it can be applied by hand:
 *
 *   For every comment opener - `<%#` or `<% /*` - take the text up to the FIRST `%>`.
 *   That is the comment EJS will actually see. If that text contains ANOTHER opening
 *   delimiter, in either form - the literal `<%`, or an escaped `<` followed by `%` -
 *   the comment closes early and the remainder renders.
 *
 * THE ESCAPED FORMS ARE THE WHOLE POINT. A search for `<%` alone finds nothing on a
 * file that provably leaks, and no amount of hostile-input escaping catches a
 * template-parsing failure involving no input at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'views');

/**
 * An OPENING delimiter inside a comment's text.
 *
 * Two forms, and the second is the one that survived every review:
 *
 *   1. a literal `<%`
 *   2. an ESCAPED `<` followed by `%`
 *
 * The escaped form is matched BROADLY ON PURPOSE, because describing a `<` as an
 * entity is something a person does in many spellings and EJS decodes none of them -
 * every one is just text that happens to end in `%`. Covered here:
 *
 *   named:      &lt;             (&LT; too, since HTML named entities are written in
 *                                either case by hand and EJS never validates it)
 *   decimal:    &#60; &#060; &#0060; ... any number of leading zeros
 *   hex:        &#x3c; &#X3C; &#x03c; ... either case of x, either case of the digits,
 *               any number of leading zeros
 *
 * WHAT IS NOT COVERED, and why it does not need to be: a `<` written as any OTHER
 * character, or a delimiter split across a line, cannot arise from `%>` (which is
 * what EJS actually matches) - the `%` and `>` must be ADJACENT in the source for
 * EJS to see a close, so only the `<` before the `%` can be disguised. Matching the
 * `%` literally is therefore exact, and matching the `<` broadly loses nothing.
 */
const ESCAPED_LT = String.raw`(?:&lt;|&LT;|&#0*60;|&#[xX]0*3[cC];)`;
const OPENER_IN_COMMENT = new RegExp(`<%|${ESCAPED_LT}%`);

/** The comment openers EJS recognises: the hash form, and a JS-block delimited by percent. */
const COMMENT_OPENERS = ['<%#', '<% /*'];

/**
 * Every comment in a template, with the text EJS will actually treat as the comment.
 *
 * Taking text up to the FIRST `%>` is the whole method: that is where EJS ends the
 * comment, whether or not the `%>` is intended as the close.
 *
 * @param {string} source
 * @returns {Array<{line: number, text: string, opener: string}>}
 */
function commentBodies(source) {
    const found = [];

    let index = source.indexOf('<%');
    while (index !== -1) {
        const opener = COMMENT_OPENERS.find((candidate) => source.startsWith(candidate, index));
        if (opener) {
            const close = source.indexOf('%>', index + opener.length);
            // An unterminated comment is a compile error, not a leak; EJS reports it.
            // Included with the rest of the source so the check still sees any opener
            // inside it.
            const text = close === -1 ? source.slice(index + opener.length) : source.slice(index + opener.length, close);
            found.push({
                opener,
                line: source.slice(0, index).split('\n').length,
                text
            });
            index = close === -1 ? -1 : close + 2;
        } else {
            index = source.indexOf('<%', index + 2);
        }
    }

    return found;
}

/** Every .ejs file under views/, recursively. */
function templateFiles(dir = VIEWS_DIR) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...templateFiles(full));
        else if (entry.name.endsWith('.ejs')) files.push(full);
    }
    return files;
}

/** The findings for one source string: comments containing another opener. */
function leaksIn(source) {
    return commentBodies(source)
        .map((comment) => ({ ...comment, match: comment.text.match(OPENER_IN_COMMENT) }))
        .filter((comment) => comment.match !== null);
}

// ===========================================================================
// 1. THE SOURCE CHECK OVER EVERY TEMPLATE
// ===========================================================================

test('no template comment contains an opener of its own language', () => {
    const files = templateFiles();
    assert.ok(files.length > 0, 'the views directory really holds templates');

    const findings = [];
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const leak of leaksIn(source)) {
            findings.push(
                `${path.relative(path.join(__dirname, '..'), file)}:${leak.line} ` +
                `(${leak.opener} comment contains ${JSON.stringify(leak.match[0])})`
            );
        }
    }

    assert.deepEqual(findings, [], `template comments that close early:\n  ${findings.join('\n  ')}`);
});

test('the check runs over the file that actually leaked', () => {
    // A guard against the sweep silently covering nothing: the file the leak was found
    // in must be among those scanned, and it must contain comments for the scan to
    // have exercised anything.
    const file = path.join(VIEWS_DIR, 'partials', 'response-fields.ejs');
    assert.ok(templateFiles().includes(file), 'response-fields.ejs is scanned');
    assert.ok(commentBodies(fs.readFileSync(file, 'utf8')).length > 0, 'it holds at least one comment');
});

// ===========================================================================
// 2. THE ESCAPED FORMS — THE TRAP
// ===========================================================================

test('every escaped spelling of an opener INSIDE a comment is detected', () => {
    const spellings = [
        '&lt;%',
        '&LT;%',
        '&#60;%',
        '&#060;%',
        '&#0060;%',
        '&#x3c;%',
        '&#x3C;%',
        '&#X3c;%',
        '&#x03c;%',
        '&#x003c;%',
        '&#X003C;%'
    ];

    for (const spelling of spellings) {
        const source = `<%# a comment naming ${spelling} the escaping tag %>`;
        assert.equal(leaksIn(source).length, 1, `${spelling} must be detected inside a comment`);
    }
});

test('the literal opener inside a comment is detected', () => {
    assert.equal(leaksIn('<%# a comment naming <%= the escaping tag %>').length, 1);
});

test('the other comment form is checked too, not only <%#', () => {
    // `<% /* ... */ %>` is the second opener EJS accepts, and it takes the same `%>`
    // terminator, so it is exposed to the same early close.
    assert.equal(leaksIn('<% /* a comment naming &lt;%= the tag */ %>').length, 1);
    assert.equal(leaksIn('<% /* a comment with no delimiter in it */ %>').length, 0);
});

test('a plain `<` or a plain `%` in a comment is NOT flagged', () => {
    // The false-positive guard: ordinary prose about percentages and comparisons is
    // common in these comments and must not trip the check.
    assert.equal(leaksIn('<%# a 50% saving, and 5 < 10, and a % sign %>').length, 0);
    assert.equal(leaksIn('<%# the price is &lt; 10 euros on a good day %>').length, 0);
});

test('an escaped opener with no percent-close after it is NOT a leak', () => {
    // The mechanism needs a `%>` AFTER the escaped opener: that `%>` is what ends the
    // comment early. An entity alone is harmless text.
    assert.equal(leaksIn('<%# mention &lt; in prose, no tag here %>').length, 0);
});

// ===========================================================================
// 3. THE MECHANISM, PINNED AGAINST EJS ITSELF
// ===========================================================================
//
// The source check encodes a claim about EJS's parser. These tests hold that claim
// against EJS, so if the parser's behaviour changed the check would be seen to be
// describing a rule that does not hold - rather than silently passing.

test('EJS really does end a comment at the first %> inside it', async () => {
    const ejs = await import('ejs');

    // The construct that leaks: an escaped opener whose own `%>` ends the comment
    // before the intended close.
    const leaking = '<%# see &lt;%= value %> LEAKED TAIL\n%>END';
    const rendered = ejs.render(leaking);

    assert.ok(rendered.includes('LEAKED TAIL'), 'the tail after the premature close renders');
    // The intended close is now ordinary text, and whatever follows it renders
    // too - so the damage runs past the end of the intended comment.
    assert.ok(rendered.includes('END'), 'and so does everything after the intended close');
});

test('a literal opener inside a comment is a COMPILE ERROR rather than a leak', async () => {
    // The literal form fails loudly ("Could not find matching close tag"), which is
    // why only the escaped forms ever reached production. Both are caught by the
    // source check, for different reasons, and both are worth preventing.
    const ejs = await import('ejs');
    assert.throws(() => ejs.render('<%# a comment naming <%= the tag %>'), /matching close tag/);
});

test('a comment with no delimiter in it renders nothing at all', async () => {
    const ejs = await import('ejs');
    assert.equal(ejs.render('<%# a comment that is only a comment %>'), '');
});

test('why the check flags an opener even when only ONE percent-close is present', async () => {
    // WORTH KNOWING, because it is why the check is conservative rather than precise.
    // EJS ends the comment at the first `%>` and renders whatever follows. If the
    // comment is INTENDED to be longer than that - where an `<%= ... %>` inside the comment
    // supplies the premature close - the text between that close and the intended close becomes
    // OUTPUT.
    //
    // A source check cannot know the INTENT. What it can see is an
    // opener inside the comment text, which is the construct that makes an early
    // close possible. So it flags the construct rather than the outcome, and a
    // comment that legitimately writes an opener with no `%>` after it inside the
    // comment - see the safe form below - is not flagged, because the extracted text
    // then contains no `%>` to close on.
    const ejs = await import('ejs');

    // An escaped opener whose own `%>` ends the comment early.
    const original = '<%#\n see &lt;%= value %> here\nLEAKED\n%>';
    const rendered = ejs.render(original);
    assert.ok(rendered.includes('LEAKED'), 'the text between the early close and the real close renders');
});

// ===========================================================================
// THE LEGITIMATE CASE, AND HOW TO WRITE IT SAFELY
// ===========================================================================
//
// A comment that DOCUMENTS this rule is the obvious way to reintroduce the leak: the
// natural way to explain "do not write an opener here" is to write one. The fixed
// comment in `response-fields.ejs` shows the safe form, and this test pins it - a
// comment may DESCRIBE the delimiter in words, and may not contain it.

test('a comment may describe the delimiter in words, which is how the fixed one reads', () => {
    // The shipped wording: "the tag that prints with a percent-and-equals". No `<%`,
    // no escaped opener, no `%>` - so it cannot close itself early.
    const safe = '<%# EVERY VALUE GOES THROUGH the tag that prints with a percent-and-equals %>';
    assert.equal(leaksIn(safe).length, 0);
    assert.ok(safe.includes('percent-and-equals'));
});

test('a comment may DESCRIBE the delimiter in words, which is the only fully safe form', () => {
    // The shipped wording: "the tag that prints with a percent-and-equals". No opener
    // in any form, so the comment cannot close early and there is nothing to flag.
    const safe = '<%# EVERY VALUE GOES THROUGH the tag that prints with a percent-and-equals %>';
    assert.equal(leaksIn(safe).length, 0);
    assert.ok(safe.includes('percent-and-equals'));

    // THE TRAP FOR THE NEXT PERSON. An entity on its own is fine, but a comment that
    // writes an escaped opener AND continues to a real `%>` has an opener inside its
    // extracted text, so EJS ends it at that `%>` - which is exactly the leak. There
    // is no safe way to write a full escaped OPENER-and-close pair inside a comment;
    // describe it in words instead.
    const writesThePair = '<%# never write &lt;% in a comment %>';
    assert.equal(leaksIn(writesThePair).length, 1, 'an escaped opener followed by a close leaks');
});

test('an entity is flagged only when a percent FOLLOWS it', () => {
    // The precision that keeps the check from flagging ordinary prose: the entity is
    // matched with a `%` immediately after it, because that pair is what EJS treats as
    // an opener. A lone `&lt;` in a sentence is not.
    const lone = '<%# a lone &lt; is fine to mention in prose, and so is 50% of the time %>';
    assert.equal(leaksIn(lone).length, 0, 'an entity with no percent after it is prose');

    const paired = '<%# never write &lt;% next to a percent-close like this one %>';
    assert.equal(leaksIn(paired).length, 1, 'the entity followed by a percent IS the construct');
});

test('the shipped templates contain ZERO of these findings, which is the whole claim', () => {
    // The headline assertion, restated small so a reader sees it without the loop.
    let total = 0;
    for (const file of templateFiles()) total += leaksIn(fs.readFileSync(file, 'utf8')).length;
    assert.equal(total, 0, 'no template comment closes early');
});
