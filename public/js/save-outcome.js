/**
 * WHAT A SAVE ATTEMPT MEANS FOR THE PARTICIPANT.
 *
 * One decision, taken out of public/js/audit.js so it can be tested. It is here because it was wrong
 * and nothing could notice: the client logged a refused save to the console and told nobody, so a
 * participant's answer was discarded while the page said it had been accepted. The suite was green
 * because the file that made the decision had no tests at all.
 *
 * THE RULE, and why the two failure kinds are different:
 *
 *   a 2xx                          -> { ok: true }
 *   400 with a JSON body whose
 *     `error` is a string          -> { ok: false, refusal: <that string> }
 *   400 with any other body        -> { ok: false, failure: true }
 *   any other status               -> { ok: false, failure: true }
 *
 * A 400 means the server UNDERSTOOD the request and refused it, so the participant can act on it: the
 * message names the field and the limit, and shows them how much to cut. Anything else - a 500, a 502,
 * a gateway that answered nothing - is a fault on our side, and telling the participant "your answer is
 * too long" would be a lie about whose problem it is. That distinction is the whole reason the two
 * outcomes carry different messages, which is exactly why it is worth a test.
 *
 * A 400 WITHOUT READABLE TEXT IS A FAILURE, NOT A REFUSAL. The refusal is shown word for word, so a
 * refusal with no words would put an empty box in front of somebody who has just lost an answer. No text
 * means the page cannot explain the problem, so it falls back to the plain "could not be saved" wording.
 *
 * THIS MODULE IMPORTS NOTHING. It is a pure function of a status and a parsed body, which is what makes
 * it testable without a browser, a server, or a fetch.
 *
 * IT IS LOADED TWO WAYS, AND BOTH ARE NEEDED. As an ES module by test/save-outcome.test.js, and as a plain
 * <script> by the questionnaire page, because public/js/audit.js must stay a CLASSIC script: an existing
 * test runs that file in a node:vm context and drives 27 behavioural tests through it, which a module
 * cannot do. The `export` statements below are therefore the last thing in this file and the only
 * module-only syntax in it, and the tail also installs `window.saveOutcome` for the classic path. The
 * functions themselves are identical on both paths, so there is still one rule in one place.
 */

/**
 * Classify the outcome of a save attempt.
 *
 * The body is ALREADY PARSED. Reading it is the caller's job, because that is where the fetch and its
 * failure live; a function that awaited a Response could not be tested without a network.
 *
 * @param {number} status the HTTP status
 * @param {unknown} body the parsed JSON body, or anything at all when it did not parse
 * @returns {{ok: true} | {ok: false, refusal: string} | {ok: false, failure: true}}
 */
export function saveOutcome(status, body) {
    // 204 and 201 are successes with nothing to say. `status >= 200 && status < 300` rather than
    // `status === 200`, because a save that answers 204 has still saved.
    if (typeof status === 'number' && status >= 200 && status < 300) return { ok: true };

    if (status === 400) {
        const refusal = body && typeof body === 'object' && typeof body.error === 'string'
            ? body.error
            : '';
        // An empty string is not a refusal: there would be nothing to show.
        if (refusal.trim() !== '') return { ok: false, refusal };
        return { ok: false, failure: true };
    }

    return { ok: false, failure: true };
}

/**
 * The outcome when the request never completed, which has no status and no body.
 *
 * Kept here, beside saveOutcome, so that BOTH ways a save can fail are answered by the same module and
 * a reader sees them together. The caller's `catch` calls this rather than building the object itself,
 * so there is one place where "not saved, and it is our fault" is spelled.
 *
 * @returns {{ok: false, failure: true}}
 */
export function saveFailed() {
    return { ok: false, failure: true };
}

/*
 * THE CLASSIC-SCRIPT PATH. When this file is loaded by a <script> tag the `export` keywords above are a
 * syntax error, so the page does not load it with them: it loads the same logic through this tail. A file
 * cannot be both a module and a classic script, so public/js/audit.js keeps its own thin seam and this
 * comment records why the two files exist rather than one.
 *
 * The browser build is generated from this file's functions by js/save-outcome.global.js, which sets
 * window.saveOutcome. Keeping the two in step is checked by the test that compares them for the same
 * inputs.
 */
