/**
 * THE CLASSIC-SCRIPT BUILD OF ./save-outcome.js, for the questionnaire page.
 *
 * WHY A SECOND FILE. public/js/audit.js must stay a classic script: test/workflow-identity.test.js runs it
 * in a node:vm context and drives 27 behavioural tests through it, and a module cannot be loaded that way.
 * A classic script cannot `import`, and ONE FILE cannot be both a module and a classic script, because the
 * `export` keyword is a syntax error in a classic script.
 *
 * So the rule lives in save-outcome.js as an ES module, where test/save-outcome.test.js covers it, and this
 * file installs the same rule on `window` for the page. The two are kept in step by
 * test/save-outcome.test.js, which runs BOTH against the same inputs and fails if they disagree - a second
 * copy is only a risk if nothing compares them.
 *
 * If you change a rule, change save-outcome.js first, then mirror it here, and the test will tell you if
 * you missed the mirror.
 */
(function (global) {
    'use strict';

    /**
     * Classify the outcome of a save attempt. See save-outcome.js for the rule and the reasoning.
     *
     * @param {number} status the HTTP status
     * @param {unknown} body the parsed JSON body, or anything at all when it did not parse
     * @returns {{ok: true} | {ok: false, refusal: string} | {ok: false, failure: true}}
     */
    function saveOutcome(status, body) {
        if (typeof status === 'number' && status >= 200 && status < 300) return { ok: true };

        if (status === 400) {
            const refusal = body && typeof body === 'object' && typeof body.error === 'string'
                ? body.error
                : '';
            if (refusal.trim() !== '') return { ok: false, refusal };
            return { ok: false, failure: true };
        }

        return { ok: false, failure: true };
    }

    /** The outcome when the request never completed. See save-outcome.js. */
    function saveFailed() {
        return { ok: false, failure: true };
    }

    global.saveOutcome = { saveOutcome, saveFailed };
}(window));
