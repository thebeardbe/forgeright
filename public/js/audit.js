/**
 * Questionnaire client.
 *
 * Drives the conversation, then renders the scored analysis. All display text
 * comes from the server-rendered strings object, so the copy lives in one place.
 */
(function () {
    const cfg = window.AUDIT_CONFIG || {};
    const S = cfg.strings || {};

    /**
     * The app's base path from the page config, "" when served at the root.
     *
     * It comes from the server via AUDIT_CONFIG rather than being hardcoded, so
     * a deployment under a prefix needs no change here. One value, one place.
     */
    const BASE_PATH = cfg.basePath || '';

    /**
     * Prefixes an application path with the base path.
     *
     * @param {string} appPath Begins with "/", for example "/api/chat".
     * @returns {string}
     */
    const apiPath = (appPath) => `${BASE_PATH}${appPath}`;

    /**
     * The participant's token, when the page was reached from an invitation
     * link. THE TOKEN IS THE ONLY CREDENTIAL: it is sent as `participantToken` with
     * every request, and the server resolves the organisation from it.
     *
     * THERE WAS A SECOND FIELD, `state.pass`, ALSO SET TO THIS TOKEN and sent beside
     * `participantToken` on both requests. It was the access code's slot, reused to
     * carry the token while the code gate existed; the server no longer reads that
     * field at all, so both it and the field are gone. Sending the same credential
     * twice under two names invites a reader to think they are different things.
     */
    const TOKEN = cfg.participantToken || '';
    const hasToken = TOKEN !== '';

    const state = {
        conversation: [],
        waiting: false,
        audit: null,
        result: null
    };

    const $ = (id) => document.getElementById(id);

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function appendMessage(kind, label, text) {
        const history = $('history');
        const div = document.createElement('div');
        div.className = 'msg ' + kind;
        div.innerHTML =
            '<div class="label">' + escapeHtml(label) + '</div>' +
            '<div class="body">' + escapeHtml(text) + '</div>';
        history.appendChild(div);
        history.scrollTop = history.scrollHeight;
    }

    function appendTyping() {
        const history = $('history');
        const div = document.createElement('div');
        div.className = 'msg ai';
        div.id = 'typing';
        div.innerHTML =
            '<div class="label">' + escapeHtml(S.aiLabel) + '</div>' +
            '<div class="body typing"><span></span><span></span><span></span></div>';
        history.appendChild(div);
        history.scrollTop = history.scrollHeight;
    }

    function removeTyping() {
        const el = $('typing');
        if (el) el.remove();
    }

    // THERE IS NO start() HERE ANY MORE, and its absence is deliberate.
    //
    // It was the access-code step: it read the code from #pass, posted it as `pass` with the
    // first turn, then hid #unlock and revealed #conversation. The access code is gone (see
    // mayUseQuestionnaire in lib/routes-api.js) and so are #pass, #unlock and #start-btn,
    // which leaves nothing for this function to read, send, or hide.
    //
    // IT WAS ALSO A CRASH WAITING TO HAPPEN. It called $('unlock').classList.add(...) on an
    // element that no longer exists, which is a TypeError on null. It did not fire, because
    // both of the things that called it were the missing controls:
    //
    //   if ($('start-btn')) ...   // #start-btn is not rendered, so this never bound
    //   if ($('pass')) { ... }    // #pass is not rendered, so this never bound either
    //
    // Measured in a browser against a real invitation link, before this removal:
    //   elements start() depends on: {"startBtn":false,"pass":false,"unlock":false}
    //   if line 113 executed now -> TypeError: Cannot read properties of null
    // and the page was working, because nothing reached it.
    //
    // SO DELETING IS THE HONEST FIX rather than adding a third existence check to a function
    // that cannot be reached. A guard would preserve the shape of a flow that no longer
    // exists, leaving the next reader to work out why a control that is never rendered is
    // being defended. The token is the only credential, and beginWithToken() below is the
    // only way in.

    async function send() {
        if (state.waiting) return;
        const input = $('input');
        const text = input.value.trim();
        if (!text) return;

        input.value = '';
        appendMessage('user', S.userLabel, text);
        state.conversation.push({ role: 'user', content: text });

        state.waiting = true;
        $('send-btn').disabled = true;
        appendTyping();

        try {
            const res = await fetch(apiPath('/api/chat'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    toolId: cfg.toolId,
                    participantToken: TOKEN || undefined,
                    lang: cfg.lang,
                    messages: state.conversation
                })
            });

            const data = await res.json();
            removeTyping();

            if (data.status === 'error' || data.status === 'rejected') {
                appendMessage('ai', S.aiLabel, data.content);
                state.waiting = false;
                $('send-btn').disabled = false;
                return;
            }

            appendMessage('ai', S.aiLabel, data.content);
            state.conversation.push({ role: 'assistant', content: data.content });

            // THE PAYLOAD ARRIVES AS `audit`, NORMALISED BY THE SERVER, whatever
            // shape the model used: an interview reply carries `processes` and the
            // server wraps it, so the client does not have to know both shapes.
            //
            // It still falls back to `processes` directly, because a client that
            // only understood one shape is how this defect happened one layer up:
            // the parser demanded `audit` while the prompt had moved to
            // `processes`. Reading both here means a future change to the
            // server's normalisation cannot silently break the page.
            //
            // USABILITY, NOT TRUTHINESS. This was `data.audit || ...`, which
            // short-circuits on a truthy-but-unusable `audit`: an empty object or
            // an empty `workflows` array is truthy, so a perfectly good `processes`
            // array BESIDE it was discarded, the interview closed, an empty payload
            // was saved and scoring ran against nothing. The fallback exists to
            // survive a server that changes shape; a truthiness test survives
            // nothing, and it stopped anyone looking because it read as defence.
            const usable = (candidate) => (
                candidate && Array.isArray(candidate.workflows) && candidate.workflows.length > 0
                    ? candidate
                    : null
            );

            // `illustrative` and `note` come from the source that wins: a usable
            // `audit` already carries its own, and the `processes` fallback reads
            // them from the top level of the reply, which is where the server puts
            // them. The trailing `null` is kept: a reply with neither usable source
            // must leave the caller's `if (status === 'complete' && payload)` false
            // rather than close the interview on nothing.
            const payload = usable(data.audit)
                || usable({
                    workflows: data.processes,
                    illustrative: data.illustrative,
                    note: data.note
                })
                || null;

            if (data.status === 'complete' && payload) {
                state.audit = payload;
                $('input-area').classList.add('hidden');
                // Persist against the invitation, so a returning participant (and
                // a reset link) finds this work rather than an empty form.
                await saveResponse(payload);
                await runScoring();
            }
        } catch (err) {
            removeTyping();
            appendMessage('ai', S.aiLabel, S.networkError);
            console.error(err);
        }

        state.waiting = false;
        $('send-btn').disabled = false;
    }

    /**
     * Stores the completed answers against the invitation.
     *
     * Only when the page was reached from an invitation link, since that is what
     * identifies the participant. A failure is logged rather than shown: the
     * participant has their analysis on screen, and an error box would suggest
     * their answers were lost when they were not.
     */
    /**
     * Stores the completed answers, WITH the conversation that produced them.
     *
     * THE TRANSCRIPT GOES WITH THE PAYLOAD because the raw data has to exist. An
     * answer is only meaningful against its question: "eight minutes" means one
     * thing asked about duration and another asked about the invoice count, so
     * storing the extracted fields alone gives text with no referent, and the
     * questions -- where the interview's quality lives -- are lost with the tab.
     *
     * The conversation is already here in `state.conversation`, so this passes
     * what exists rather than building anything new.
     *
     * Only when the page was reached from an invitation link, since that is what
     * identifies the participant. A failure is logged rather than shown: the
     * participant has their analysis on screen, and an error box would suggest
     * their answers were lost when they were not.
     */
    async function saveResponse(audit) {
        if (!hasToken) return;
        try {
            const res = await fetch(apiPath('/api/response'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: TOKEN,
                    data: audit,
                    // Role and content for every turn, in order. The store keeps it
                    // as one JSON column rather than a row per message.
                    transcript: state.conversation.map((turn) => ({
                        role: turn.role,
                        content: turn.content
                    }))
                })
            });
            if (!res.ok) {
                console.error('saving the answers failed with ' + res.status);
            }
        } catch (err) {
            console.error('saving the answers failed', err);
        }
    }

    async function runScoring() {
        try {
            const res = await fetch(apiPath('/api/score'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    toolId: cfg.toolId,
                    participantToken: TOKEN || undefined,
                    audit: state.audit
                })
            });
            if (!res.ok) throw new Error('scoring failed with ' + res.status);
            state.result = await res.json();
            renderAnalysis(state.result);
        } catch (err) {
            console.error(err);
            // Distinguish "scoring broke" from "no analysis": the participant
            // should not be left thinking the interview produced nothing. But do
            // NOT offer the download: there is nothing scored to download, and a
            // file of raw answers titled "Analysis" is a plausible artefact that
            // is not the analysis.
            $('analysis').classList.remove('hidden');
            $('analysis-body').innerHTML =
                '<p style="color:#b91c1c">' + escapeHtml(S.scoringFailed) + '</p>';
            $('actions').classList.add('hidden');
        }
    }

    function renderAnalysis(result) {
        const parts = [];

        if (state.audit.illustrative) {
            parts.push('<div class="banner">' + escapeHtml(S.illustrativeBanner) + '</div>');
        }

        parts.push(
            '<div class="total">' + escapeHtml(S.totalRecoverable) + ': ' +
            '<strong>' + result.totalRecoverableHoursPerWeek + '</strong>' +
            ' <span style="color:var(--muted)">(' + result.workflowCount + ' workflows)</span></div>'
        );

        if (result.conflicts && result.conflicts.length) {
            parts.push('<div class="bucket"><h3>' + escapeHtml(S.conflictsTitle) + '</h3>');
            for (const c of result.conflicts) {
                parts.push(
                    '<div class="wf"><div class="wf-title">' + escapeHtml(c.title) + '</div>' +
                    '<div class="wf-meta">' + escapeHtml(c.note) + '</div></div>'
                );
            }
            parts.push('</div>');
        }

        parts.push(bucketHtml('do_first', S.doFirst, result.buckets.do_first, 'recoverable'));
        parts.push(bucketHtml('do_later', S.doLater, result.buckets.do_later, 'effort'));
        parts.push(bucketHtml('judgement_bound', S.judgementBound, result.buckets.judgement_bound, 'effort'));

        $('analysis-body').innerHTML = parts.join('');
        $('analysis').classList.remove('hidden');
        $('actions').classList.remove('hidden');
    }

    /**
     * Renders one bucket.
     *
     * `mode` decides the number shown and its label. For "do first" the score
     * is recoverable time and is summed into the total. For the other two
     * buckets the score is NOT counted, so showing it as "recoverable" would
     * claim hours this analysis is explicitly saying cannot be recovered. Those
     * buckets show the raw weekly effort instead.
     */
    /** Renders a measurement, or an explicit "not measured" when absent. */
    function metaPart(value, suffix) {
        return value === undefined || value === null
            ? '<em>' + escapeHtml(S.notMeasured) + '</em>'
            : escapeHtml(String(value)) + escapeHtml(suffix);
    }

    /** Same idea for the Markdown export. */
    function markdownValue(value, suffix) {
        return value === undefined || value === null ? S.notMeasured : value + suffix;
    }

    function bucketHtml(cssClass, title, items, mode) {
        if (!items || !items.length) return '';
        let html = '<div class="bucket ' + cssClass + '"><h3>' + escapeHtml(title) + '</h3>';
        for (const wf of items) {
            const value = mode === 'recoverable' ? wf.recoverableHoursPerWeek : wf.effortHoursPerWeek;
            const unit = mode === 'recoverable' ? 'h/wk recoverable' : 'h/wk effort';
            html +=
                '<div class="wf">' +
                '<div class="wf-top">' +
                '<span class="wf-title">' + escapeHtml(wf.title) + '</span>' +
                '<span class="wf-score">' + escapeHtml(String(value)) + ' ' + escapeHtml(unit) + '</span>' +
                '</div>' +
                '<div class="wf-meta">' +
                // An absent field means nobody gave a usable value. Show that,
                // rather than printing "undefined" as though it were a reading.
                metaPart(wf.frequencyPerWeek, '/wk') + ' · ' +
                metaPart(wf.minutesPerInstance, ' min') + ' · ' +
                metaPart(wf.peopleAffected, ' people') + ' · ' +
                'judgement ' + escapeHtml(String(wf.judgementScore)) + '/5' +
                '</div></div>';
        }
        return html + '</div>';
    }

    /**
     * Exports the scored analysis.
     *
     * This file is the deliverable: it is handed to a client without anyone
     * present to explain it. An earlier version exported the raw questionnaire
     * answers under the heading "Analysis", with no score, no bucket, no
     * ranking and no total, which is a document that looks like the analysis
     * and is not. It now exports what was actually produced.
     */
    function downloadMarkdown() {
        if (!state.audit || !state.result) return;
        const result = state.result;
        const lines = ['# ' + S.analysisTitle, ''];

        if (state.audit.illustrative) {
            const note = state.audit.note || S.illustrativeBanner;
            lines.push('> ' + note, '');
        }

        lines.push('**' + S.totalRecoverable + ': ' + result.totalRecoverableHoursPerWeek +
            '** (' + result.workflowCount + ' workflows)', '');

        if (result.conflicts && result.conflicts.length) {
            lines.push('## ' + S.conflictsTitle, '');
            for (const c of result.conflicts) {
                lines.push('- **' + c.title + '** - ' + c.note);
            }
            lines.push('');
        }

        for (const [cssClass, title, mode] of [
            ['do_first', S.doFirst, 'recoverable'],
            ['do_later', S.doLater, 'effort'],
            ['judgement_bound', S.judgementBound, 'effort']
        ]) {
            const items = result.buckets[cssClass] || [];
            if (!items.length) continue;
            lines.push('## ' + title, '');
            for (const wf of items) {
                const value = mode === 'recoverable' ? wf.recoverableHoursPerWeek : wf.effortHoursPerWeek;
                const unit = mode === 'recoverable' ? ' h/wk recoverable' : ' h/wk effort';
                lines.push(
                    '### ' + wf.title + ' - ' + value + unit, '',
                    '- How often: ' + markdownValue(wf.frequencyPerWeek, ' per week'),
                    '- Time for one instance: ' + markdownValue(wf.minutesPerInstance, ' minutes'),
                    '- People involved: ' + markdownValue(wf.peopleAffected, ''),
                    '- Needs judgement: ' + wf.judgementScore + '/5 (1 = always, 5 = follows rules)',
                    '- Same steps every time: ' + (wf.stepsConsistent ? 'yes' : 'no'),
                    '- Tools today: ' + ((wf.tools && wf.tools.length) ? wf.tools.join(', ') : S.notMeasured),
                    ''
                );
                if (wf.conflictNote) lines.push('> ' + wf.conflictNote, '');
            }
        }

        const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'workflow-audit.md';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    /**
     * Opens the conversation without the access-code step, for a page reached
     * from an invitation link. The token in the page config is already the
     * credential, and it is sent with each answer, so no separate code is
     * collected or verified here.
     */
    function beginWithToken() {
        $('conversation').classList.remove('hidden');
        state.conversation = [{ role: 'assistant', content: S.initialMessage }];
        appendMessage('ai', S.aiLabel, S.initialMessage);
        $('actions').classList.remove('hidden');
    }

    document.addEventListener('DOMContentLoaded', () => {
        // NO UNLOCK LISTENERS. The controls they bound to, #start-btn and #pass, are
        // not rendered any more and the function they called is gone, so a page with a
        // resolved token starts the conversation directly - which is the only case.
        if (hasToken) beginWithToken();
        $('send-btn').addEventListener('click', send);
        $('download-md').addEventListener('click', downloadMarkdown);

        $('input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') send();
        });
    });
})();
