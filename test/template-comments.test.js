/**
 * EJS comments must not contain a delimiter of their own language.
 *
 * THE RULE, to apply by hand: for every comment opener, take the text up to the FIRST `%>` - that
 * is what EJS sees. If it contains ANOTHER opening delimiter, literal `<%` or an escaped `<`
 * followed by `%`, the comment closes early and the remainder renders.
 *
 * WHY A SOURCE CHECK: the leaked text is what comes AFTER the premature terminator, so the rendered
 * page carries prose with no output marker to identify it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'views');

/**
 * An OPENING delimiter inside a comment's text: a literal `<%`, or an ESCAPED `<` followed by `%`.
 *
 * The escaped form is matched BROADLY ON PURPOSE: EJS decodes no entity, so every spelling is just
 * text ending in `%`. Only the `<` needs matching broadly - the `%` and `>` must be ADJACENT for
 * EJS to see a close.
 */
const ESCAPED_LT = String.raw`(?:&lt;|&LT;|&#0*60;|&#[xX]0*3[cC];)`;
const OPENER_IN_COMMENT = new RegExp(`<%|${ESCAPED_LT}%`);

const COMMENT_OPENERS = ['<%#', '<% /*'];

function commentBodies(source) {
    const found = [];

    let index = source.indexOf('<%');
    while (index !== -1) {
        const opener = COMMENT_OPENERS.find((candidate) => source.startsWith(candidate, index));
        if (opener) {
            const close = source.indexOf('%>', index + opener.length);
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

function templateFiles(dir = VIEWS_DIR) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...templateFiles(full));
        else if (entry.name.endsWith('.ejs')) files.push(full);
    }
    return files;
}

function leaksIn(source) {
    return commentBodies(source)
        .map((comment) => ({ ...comment, match: comment.text.match(OPENER_IN_COMMENT) }))
        .filter((comment) => comment.match !== null);
}

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
    const file = path.join(VIEWS_DIR, 'partials', 'response-fields.ejs');
    assert.ok(templateFiles().includes(file), 'response-fields.ejs is scanned');
    assert.ok(commentBodies(fs.readFileSync(file, 'utf8')).length > 0, 'it holds at least one comment');
});

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
    assert.equal(leaksIn('<% /* a comment naming &lt;%= the tag */ %>').length, 1);
    assert.equal(leaksIn('<% /* a comment with no delimiter in it */ %>').length, 0);
});

test('a plain `<` or a plain `%` in a comment is NOT flagged', () => {
    assert.equal(leaksIn('<%# a 50% saving, and 5 < 10, and a % sign %>').length, 0);
    assert.equal(leaksIn('<%# the price is &lt; 10 euros on a good day %>').length, 0);
});

test('an escaped opener with no percent-close after it is NOT a leak', () => {
    assert.equal(leaksIn('<%# mention &lt; in prose, no tag here %>').length, 0);
});

test('EJS really does end a comment at the first %> inside it', async () => {
    const ejs = await import('ejs');

    const leaking = '<%# see &lt;%= value %> LEAKED TAIL\n%>END';
    const rendered = ejs.render(leaking);

    assert.ok(rendered.includes('LEAKED TAIL'), 'the tail after the premature close renders');
    assert.ok(rendered.includes('END'), 'and so does everything after the intended close');
});

test('a literal opener inside a comment is a COMPILE ERROR rather than a leak', async () => {
    const ejs = await import('ejs');
    assert.throws(() => ejs.render('<%# a comment naming <%= the tag %>'), /matching close tag/);
});

test('a comment with no delimiter in it renders nothing at all', async () => {
    const ejs = await import('ejs');
    assert.equal(ejs.render('<%# a comment that is only a comment %>'), '');
});

test('why the check flags an opener even when only ONE percent-close is present', async () => {
    const ejs = await import('ejs');

    const original = '<%#\n see &lt;%= value %> here\nLEAKED\n%>';
    const rendered = ejs.render(original);
    assert.ok(rendered.includes('LEAKED'), 'the text between the early close and the real close renders');
});

// A comment may DESCRIBE the delimiter in words, and may not contain it.

test('a comment may describe the delimiter in words, which is how the fixed one reads', () => {
    const safe = '<%# EVERY VALUE GOES THROUGH the tag that prints with a percent-and-equals %>';
    assert.equal(leaksIn(safe).length, 0);
    assert.ok(safe.includes('percent-and-equals'));
});

test('a comment may DESCRIBE the delimiter in words, which is the only fully safe form', () => {
    const safe = '<%# EVERY VALUE GOES THROUGH the tag that prints with a percent-and-equals %>';
    assert.equal(leaksIn(safe).length, 0);
    assert.ok(safe.includes('percent-and-equals'));

    const writesThePair = '<%# never write &lt;% in a comment %>';
    assert.equal(leaksIn(writesThePair).length, 1, 'an escaped opener followed by a close leaks');
});

test('an entity is flagged only when a percent FOLLOWS it', () => {
    const lone = '<%# a lone &lt; is fine to mention in prose, and so is 50% of the time %>';
    assert.equal(leaksIn(lone).length, 0, 'an entity with no percent after it is prose');

    const paired = '<%# never write &lt;% next to a percent-close like this one %>';
    assert.equal(leaksIn(paired).length, 1, 'the entity followed by a percent IS the construct');
});

test('the shipped templates contain ZERO of these findings, which is the whole claim', () => {
    let total = 0;
    for (const file of templateFiles()) total += leaksIn(fs.readFileSync(file, 'utf8')).length;
    assert.equal(total, 0, 'no template comment closes early');
});
