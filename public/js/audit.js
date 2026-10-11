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

    const state = {
        conversation: [],
        pass: '',
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

    async function start() {
        const entered = $('pass').value.trim();
        if (!entered) {
            alert(S.invalidCode);
            return;
        }
        state.pass = entered;

        // Verify the code against the server before showing the chat, so a wrong
        // code fails here rather than on the participant's first answer.
        try {
            const res = await fetch(apiPath('/api/chat'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    toolId: cfg.toolId,
                    pass: state.pass,
                    lang: cfg.lang,
                    messages: []
                })
            });
            if (res.status === 403) {
                alert(S.invalidCode);
                return;
            }
        } catch (err) {
            console.error(err);
            alert(S.networkError);
            return;
        }

        $('unlock').classList.add('hidden');
        $('conversation').classList.remove('hidden');

        state.conversation = [{ role: 'assistant', content: S.initialMessage }];
        appendMessage('ai', S.aiLabel, S.initialMessage);
    }

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
                    pass: state.pass,
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

            if (data.status === 'complete' && data.audit) {
                state.audit = data.audit;
                $('input-area').classList.add('hidden');
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

    async function runScoring() {
        try {
            const res = await fetch(apiPath('/api/score'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    toolId: cfg.toolId,
                    pass: state.pass,
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

    document.addEventListener('DOMContentLoaded', () => {
        $('start-btn').addEventListener('click', start);
        $('send-btn').addEventListener('click', send);
        $('download-md').addEventListener('click', downloadMarkdown);

        $('pass').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') start();
        });
        $('input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') send();
        });
    });
})();
