/**
 * Questionnaire client: drives the conversation, then renders the scored analysis. All display text comes
 * from the server-rendered strings object.
 */
(function () {
    const cfg = window.AUDIT_CONFIG || {};
    const S = cfg.strings || {};

    /**
     * The app's base path from the page config, "" when served at the root. From the server via
     * AUDIT_CONFIG rather than hardcoded, so a deployment under a prefix needs no change here.
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
     * The participant's token, when the page was reached from an invitation link, sent as
     * `participantToken` with every request. The token is the only credential, and the server resolves the
     * organisation from it.
     */
    const TOKEN = cfg.participantToken || '';
    const hasToken = TOKEN !== '';

    const state = {
        conversation: [],
        waiting: false,
        audit: null,
        result: null,
        // The processes this round holds, by `id`, as last saved.
        //
        // WHAT A COMPLETION CLAIM IS CHECKED AGAINST before it is stored; see
        // mergeForwardDroppedProcesses. Deliberately the SAVED set rather than the last
        // reply's, so a reply that drops a process cannot overwrite the record of what the
        // round had.
        //
        // IT ALSO GOES WITH EVERY TURN, so the server can tell a process the model re-worded
        // from one the participant has just named. The reply cannot carry that distinction -
        // both arrive as an entry with content - and neither can the client, because two
        // accounts of one process and two accounts of two are the same shape. What separates
        // them is knowing WHICH PROCESS THE ROUND WAS ON. It is the map the client already
        // keeps, so this is one field rather than new state, and `lib/routes-api.js` resolves
        // no organisation and reads no participant data (see its header), which is why the
        // client sends it rather than the route looking it up.
        roundProcesses: new Map()
    };

    /**
     * The round this participant left open, if any: only an open round is resumed, because a timestamp
     * means that process was concluded.
     *
     * The transcript is replayed rather than the extracted fields, so the participant sees the conversation
     * they actually had.
     */
    const existing = Array.isArray(cfg.existingResponses) ? cfg.existingResponses : [];
    const openRound = existing
        .filter((response) => response && response.submitted_at === null)
        .pop() || null;
    const resumedTranscript = openRound && Array.isArray(openRound.transcript)
        ? openRound.transcript.filter((turn) => turn && typeof turn.content === 'string' && turn.content !== '')
        : [];

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

    /**
     * Sends the participant's turn and acts on the reply. There is no access-code step: the token is the only
     * credential, enforced by `mayUseQuestionnaire` in lib/routes-api.js.
     *
     * Scoring uses `toSave` rather than the raw reply, because `toSave` carries the reconciled identity and
     * any carried-forward process; scoring the raw reply showed a total built from a stub.
     *
     * The input stays open when `complete`, because the model asks the closing question in the same reply that
     * reports completion, and hiding it would make rounds 2 and beyond unreachable.
     */
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
                    messages: state.conversation,
                    // The round's processes, so the server can tell a re-worded process
                    // from a newly named one; see the note above `state.roundProcesses`.
                    roundProcesses: Array.from(state.roundProcesses.values())
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
            // `substituted` AND `missing` TRAVEL WITH THE TURN, because the server needs them
            // on the way back. A question this gate wrote must not be mistaken for the model's
            // own on a later turn - that is what stops the gate replacing its own sentence in a
            // loop - and the open-field count is what tells a legitimate second attempt from a
            // stall. Both are replayed verbatim, like every other assistant turn.
            state.conversation.push({
                role: 'assistant',
                content: data.content,
                substituted: data.substituted === true,
                missing: Array.isArray(data.missing) ? data.missing : [],
                // THE EVIDENCE THE PAYLOAD ACTUALLY CARRIED, replayed so the server can tell
                // real progress from a change in what the model CLAIMS to hold. A model that
                // re-partitions its `have`/`missing` lists moves `missing` without recording
                // anything; this list only grows when a field is truly written down.
                evidenced: Array.isArray(data.evidenced) ? data.evidenced : []
            });

            // THE SERVER NORMALISES THE PAYLOAD, so the client does not have to know both shapes - but
            // it still reads `processes` directly, because a client that understood only one shape is
            // how this defect happened one layer up: the parser demanded `audit` while the prompt had
            // moved to `processes`.
            //
            // USABILITY, NOT TRUTHINESS. This was `data.audit || ...`, which short-circuits on a
            // truthy-but-unusable `audit`: an empty object or empty `workflows` array is truthy, so a
            // good `processes` array BESIDE it was discarded, the interview closed and scoring ran
            // against nothing. A truthiness test reads as defence and survives nothing.
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

            // EVERY TURN IS SAVED, PARTIAL OR NOT. Saving only on completion meant an abandoned
            // interview was never stored at all - no answers, no transcript, an empty console - and
            // that is the COMMON case, not the edge one.
            //
            // `complete` COMES FROM THE SERVER'S OWN STATUS, computed by the matrix, so "this
            // process is finished" is never the page's opinion.
            //
            // A PAYLOAD IS NOT REQUIRED: an early turn has none worth having, and skipping the save
            // would lose exactly the first answers a participant gives.
            const isComplete = data.status === 'complete';

            // NOTHING WAS ANSWERED: THE ROUND ENDS, AND THE INTERVIEW ENDS WITH IT.
            //
            // The server sends this when every field was declined, which is the one state where
            // the matrix has nothing left to ask AND nothing to score. Without the client
            // honouring it the participant is trapped: the reply is `asking`, so the page keeps
            // the input open and the model has no new question to send, which produced
            // byte-identical output forever on a real defect.
            //
            // SO IT IS TREATED AS AN ENDING, NOT AS A TURN. The round is finalised (so the store
            // knows it is closed and the participant may leave), the input is hidden, and the
            // honest closing line is shown. Nothing is scored because there is nothing to score.
            //
            // IT DOES NOT GO THROUGH runScoring: scoring an empty round would produce a figure
            // from no evidence, which is the failure the completion gate exists to prevent. The
            // server has already declined to treat this as a completed interview, and the page
            // must not contradict it.
            const nothingAnswered = data.status === 'nothing_answered';

            // THE GATE HAS RUN OUT OF QUESTIONS. Every field has had its question and the
            // participant has answered; what is still open cannot be settled by asking again, so
            // the round ends here on what WAS supplied. Without this the page keeps the input
            // open and the model repeats itself, which is the stall the guard exists to end.
            //
            // IT IS NOT `nothing_answered`: this round has answers in it. It finalises like a
            // completion and is scored like one, because the fields that were given are real.
            const exhausted = data.exhausted === true;

            // A COMPLETION CLAIM MUST NOT NARROW THE PAYLOAD. The matrix gate refuses to FINISH a
            // process with fields missing; this is the same rule one step over, because dropping a
            // process is how its answers stop being recorded and the participant is asked for all
            // of it again.
            //
            // IT HAPPENS MUNDANELY: the model asked "is there another process?" before the matrix
            // was satisfied and started a fresh matrix for what it took to be the next one. MEASURED
            // on a real deepseek run, the payload went from 15 fields to 3 that way. The prompt now
            // forbids it, BUT THIS IS THE HALF THAT DOES NOT DEPEND ON THE MODEL OBEYING.
            //
            // COMPARED BY PROCESS `id`, the only stable name a reply carries, so what was collected
            // stays.
            // THE IDENTITY IS SETTLED FIRST, so everything below - the carry-forward, the record
            // of what the round holds, and the payload that is scored - agrees on how many
            // processes there are. THE SERVER DOES THE SAME at lib/routes-api.js, and this runs
            // again here because a page can reload mid-round: the server's fold is a reply's own,
            // while this one reconciles against what the browser has already saved.
            const reconciled = payload && Array.isArray(payload.workflows)
                ? { ...payload, workflows: reconcileWorkflowIdentity(payload.workflows, state.roundProcesses) }
                : payload;
            const narrowed = mergeForwardDroppedProcesses(reconciled, state.roundProcesses);
            if (narrowed.dropped.length > 0) {
                console.warn(
                    'a completion claim dropped ' + narrowed.dropped.length + ' process(es) the round ' +
                    'already had; carrying them forward so the answers are not lost: ' + narrowed.dropped.join(', ')
                );
            }
            // THE CARRY-FORWARD APPLIES TO EVERY TURN THAT SAVES, NOT ONLY A COMPLETION.
            //
            // This was `isComplete ? narrowed.payload : reconciled`, and the gating was
            // WRONG for the case the carry-forward exists to serve. An exhausted round - the
            // evidence cap - arrives with `status: 'asking'` and `exhausted: true`, so
            // `isComplete` is false and the carried-forward payload was DISCARDED: the reply
            // that dropped a process was saved and scored on its own, losing what the round
            // had already collected, with the warning above firing and being ignored.
            //
            // Measured both ways on one drop: complete yields ['proc-full','proc-stub'],
            // exhausted yielded ['proc-stub'] alone.
            //
            // A TURN THAT SAVES IS A TURN WHOSE DROP IS RECORDED, and the three callers below
            // already decide the round's fate. Gating on `isComplete` conflated "do not lose
            // the answers" with "the round is over", which are different questions.
            const toSave = narrowed.payload;
            // `complete: true` FORCES THE ROUND CLOSED even though the status is not
            // `complete`: `submitted_at` is the store's only way to say a round is finished,
            // and leaving it open is the trap. The STATUS is what says it ended with nothing
            // in it, and that lives in the reply the console already reads.
            await saveResponse(toSave, isComplete || nothingAnswered || exhausted);

            // THE RECORD OF WHAT THE ROUND HOLDS IS UPDATED FROM WHAT WAS SAVED, BEFORE ANY
            // RETURN BELOW. This block used to sit after the `exhausted` return, so an exhausted
            // round closed without ever recording its processes: the map stayed empty as it
            // started (`new Map()` at the top of this file), so the carry-forward on any later
            // turn had nothing to carry, and a round that had collected a full process could be
            // saved away beside a three-field stub with no warning at all. THAT IS THE ORDER THIS
            // IS IN NOW, and the order is the fix rather than a tidy-up.
            if (toSave && Array.isArray(toSave.workflows)) {
                for (const workflow of toSave.workflows) {
                    const id = workflow && typeof workflow.id === 'string' ? workflow.id : '';
                    if (id !== '') state.roundProcesses.set(id, workflow);
                }
            }

            if (nothingAnswered) {
                $('input-area').classList.add('hidden');
                return;
            }
            if (exhausted) {
                // The round ends and is scored on what was supplied; see the `toSave` note above.
                $('input-area').classList.add('hidden');
                if (toSave) {
                    state.audit = toSave;
                    await runScoring();
                }
                return;
            }

            if (isComplete && toSave) {
                state.audit = toSave;
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

    /** The step names of a workflow, trimmed and case-folded, for an EXACT comparison. */
    function stepNamesOf(workflow) {
        if (!workflow || !Array.isArray(workflow.steps)) return [];
        return workflow.steps
            .map((step) => (step && typeof step.name === 'string' ? step.name.trim().toLowerCase() : ''))
            .filter((name) => name !== '');
    }

    /** Whether two workflows share at least one EXACTLY equal step name. */
    function sharesAStepName(a, b) {
        const mine = stepNamesOf(a);
        if (mine.length === 0) return false;
        const theirs = new Set(stepNamesOf(b));
        return mine.some((name) => theirs.has(name));
    }

    /** The measurable fields, in one place, for "which of these two entries is the richer one". */
    function measurableCount(workflow) {
        const fields = ['frequencyPerWeek', 'timePerPeriod', 'minutesPerInstance', 'peopleAffected'];
        const filled = fields.filter((f) => workflow[f] !== undefined && workflow[f] !== null).length;
        const steps = Array.isArray(workflow.steps) ? workflow.steps.length : 0;
        // STEP COUNT DOMINATES, because the steps are what the merge and the score read: an entry
        // with seven steps and a frequency is the process, and one with four fields and no steps
        // is the fragment of it. Weighting them equally would let two counts of fields beat steps.
        return steps * 100 + filled;
    }

    /**
     * Gives each process in this reply the identity the round already gave it, and collapses a reply that
     * describes the same process twice.
     *
     * The server derives a process `id` from its `task` and the model rewords the task between turns, so one
     * process accumulates under several ids and the score comes from one variant. Every workflow takes the id
     * of a held process it matches on the exact step-name co-test, and then a reply describing one process
     * twice is collapsed to the richer entry.
     *
     * There must be no early return on an empty `held`: the fold below compares entries within this reply, so
     * returning early would leave the duplicate on the first turn it appears, when the stale copy is not yet
     * in `held`.
     *
     * The co-test's server-side implementation is in `ai/workflow-identity.js`.
     *
     * @param {Array<object>} workflows The workflows from this reply.
     * @param {Map<string, object>} held The processes the round already has, by id.
     * @returns {Array<object>} The workflows, each carrying a held id where one matched.
     */
    function reconcileWorkflowIdentity(workflows, held) {
        if (!Array.isArray(workflows) || workflows.length === 0) return workflows;

        const resolved = workflows.map((workflow) => {
            if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return workflow;

            // An entry already naming a process the round holds has matched on its own.
            if (typeof workflow.id === 'string' && held.has(workflow.id)) return workflow;

            for (const [heldId, heldWorkflow] of held) {
                if (!sharesAStepName(workflow, heldWorkflow)) continue;
                console.warn(
                    'the model reworded the process it was describing (id was "' + String(workflow.id) +
                    '", the round knows it as "' + heldId + '"); keeping the round\'s id so the same ' +
                    'answers are not counted twice'
                );
                // REPLACED rather than mutated, so the reply's own object is left alone.
                return { ...workflow, id: heldId };
            }

            return workflow;
        });

        // ONE ENTRY PER PROCESS, which is the part that actually removes a duplicate.
        //
        // TWO ENTRIES IN ONE REPLY CAN BE THE SAME PROCESS: rule 1 treats an exact shared step name
        // as proof of identity, so two entries sharing one ARE one process. Resolving against `held`
        // alone cannot see this, because on the first turn both entries are new and neither is held
        // - MEASURED on the reported payload, which came out as two entries with three identical
        // step names between them.
        //
        // THE ONLY CLAIM IS THE POSITIVE ONE, whose evidence is present and verbatim, so there is
        // nothing to weigh and no number to tune. The by-absence claim was removed; see the note
        // beginning "THERE IS NO BY-ABSENCE ARM" below.
        //
        // A MERGE IS REPORTED, because removing a participant's entry must be visible in a log
        // rather than inferred from a missing row. PASS 1 IS ABOVE.

        // PASS 2 — THE POSITIVE TEST, PAIRWISE: two entries sharing an exactly equal step name are
        // one process, which is what rule 1 says a shared step name means.
        //
        // A SINGLE FORWARD PASS, AND NOT A FIXED POINT: an entry arriving EARLY is never re-examined
        // against a bridge arriving later. Where the bridge sits decides whether one pass is enough -
        // MEASURED on the real function across [a,b,c], [b,a,c] and [a,c,b]: 1, 1, 2 entries. LEFT
        // UNFIXED DELIBERATELY, because the case it would rescue needs a bridge sharing a step name
        // with two others, which no live run has produced. What survives either way is an extra row
        // reading "not measured", never a lost answer.
        //
        // THE RICHER ENTRY WINS, by `measurableCount` (steps first, then filled fields). THE LOSER IS
        // NOT A SUBSET VERBATIM - every key it carried is present in the winner, so nothing is
        // dropped, but nine shared keys hold DIFFERENT WORDING and some loser phrases read fuller.
        // The loser is the same work, less filled in AND differently worded. MEASURED COST: the steps
        // survive and the score reads the same apart from one `needsReasoning` flip.
        let merged = [];
        for (const workflow of resolved) {
            const at = merged.findIndex((standing) => sharesAStepName(standing, workflow));
            if (at === -1) {
                merged.push(workflow);
                continue;
            }

            const standing = merged[at];
            const winner = measurableCount(standing) >= measurableCount(workflow) ? standing : workflow;
            const loser = winner === standing ? workflow : standing;
            console.warn(
                'the reply described ONE process twice (ids "' + String(standing.id) + '" and "' +
                String(workflow.id) + '"); keeping the fuller entry (steps ' +
                (Array.isArray(winner.steps) ? winner.steps.length : 0) + ', ' +
                (measurableCount(winner) % 100) + ' measurable field(s)) and discarding the ' +
                'sparser one (steps ' + (Array.isArray(loser.steps) ? loser.steps.length : 0) + '), ' +
                'so the same work is not counted twice'
            );
            merged[at] = winner;
        }

        // THERE IS NO BY-ABSENCE ARM, AND ITS ABSENCE IS DELIBERATE. An arm folding an entry with
        // no steps and no measurable field into a richer sibling WAS BUILT AND REMOVED, because it
        // silently discarded a process the participant had just NAMED: MEASURED through this
        // function, a finished process beside "Onboarding a new supplier" (`task` and `trigger` only)
        // came out as ONE entry, the new process gone.
        //
        // THE TWO SITUATIONS ARE THE SAME SHAPE: a stale carry-forward beside its own process, and a
        // newly named process beside an unrelated one, are both an empty entry beside a rich sibling,
        // and the prompt creates BOTH: on a naming turn, under its ONE PROCESS PER ROUND rule, one
        // entry holds the completed process and another starts the new one with no steps. THE OBVIOUS DISCRIMINATOR - comparing the empty entry's task with its
        // sibling's - WAS TESTED AND DOES NOT WORK: MEASURED, the case the arm was built for shares
        // only FOUR words with its rich sibling while a newly named process in the same domain shares
        // TWO, so any overlap rule low enough to fold the first destroys the second.
        //
        // THE ASYMMETRY DECIDES IT: an extra row is cosmetic - a second process reading "not
        // measured" - while a discarded process is SILENT DATA LOSS.
        return merged;
    }

    /**
     * Carries forward any process a completion reply left out.
     *
     * Keyed on a process `id` rather than an index, because the model may reorder the list. Nothing is
     * evicted, because a round is the work of one process.
     *
     * @param {object|null} payload The payload from this reply, if any.
     * @param {Map<string, object>} held The processes the round already has, by id.
     * @returns {{ payload: object|null, dropped: string[] }}
     */
    function mergeForwardDroppedProcesses(payload, held) {
        if (!payload || !Array.isArray(payload.workflows) || payload.workflows.length === 0) {
            return { payload, dropped: [] };
        }

        const incoming = new Map();
        for (const workflow of payload.workflows) {
            const id = workflow && typeof workflow.id === 'string' ? workflow.id : '';
            if (id !== '') incoming.set(id, workflow);
        }

        const dropped = [];
        const carried = [];
        for (const [id, workflow] of held) {
            if (!incoming.has(id)) {
                dropped.push(id);
                carried.push(workflow);
            }
        }
        if (dropped.length === 0) return { payload, dropped };

        return {
            payload: { ...payload, workflows: [...carried, ...payload.workflows] },
            dropped
        };
    }

    /**
     * Stores one turn of answers, with the conversation that produced them.
     *
     * Every turn rather than only the last, because a turn that is not saved is a turn a closed tab
     * destroys. `complete` comes from the server's own `status`.
     *
     * The transcript goes with the payload because an answer is only meaningful against its question, and
     * the transcript is already in `state.conversation`.
     *
     * Only when the page came from an invitation link, which is what identifies the participant, and a
     * failure is logged rather than shown, because an error box would suggest their answers were lost.
     */
    async function saveResponse(audit, complete) {
        if (!hasToken) return;
        try {
            const res = await fetch(apiPath('/api/response'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: TOKEN,
                    // WHAT COMPLETES A PROCESS IS THE SERVER'S CALL, and this flag is
                    // how the page passes the server's own answer back to it: the
                    // server computed `status`, and the server finalises the round.
                    // The page never decides that an interview is done.
                    complete: complete === true,
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

        // THE TOTAL IS A FLOOR WHEN ANY WORKFLOW'S EFFORT COULD NOT BE COMPUTED, and saying so is
        // the point. The sum is over the workflows whose factors were all figures, so it is
        // CORRECT as far as it goes - but presenting it bare reads as the whole answer, and the
        // owner's live run had a workflow that describes real work contributing 0 to it because
        // one factor was prose. "at least" keeps the figure true without inventing a number for a
        // sentence. The per-workflow line above says which one is missing and why.
        const anyUnmeasurable = result.scored.some(effortIsUnmeasurable);
        parts.push(
            '<div class="total">' + escapeHtml(S.totalRecoverable) + ': ' +
            (anyUnmeasurable ? escapeHtml(S.totalIsFloor) + ' ' : '') +
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
     * The four states a stored field can be in, and what each reads as: absent is not measured, prose is the
     * participant's own words, declined is their refusal, and typed is the value with its unit.
     *
     * This decides only how a field looks; the marker's meaning is unchanged. Copied from
     * `views/partials/response-fields.ejs`, because a browser script cannot reach a view's locals, and an
     * object that is neither marker is not printed, so a marker added later degrades to "not measured".
     */
    function isProse(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
            && typeof value.said === 'string' && value.said.trim() !== '';
    }

    function isDeclined(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
            && (value.declined === true || typeof value.declined === 'string');
    }

    /** The text for one field, in the four states above. ONE formatter for both renderers. */
    function fieldText(value) {
        if (value === undefined || value === null) return S.notMeasured;
        if (isProse(value)) return value.said;
        if (isDeclined(value)) {
            return typeof value.declined === 'string' && value.declined.trim() !== ''
                ? value.declined
                : S.notMeasured;
        }
        if (Array.isArray(value)) return value.join(', ');
        if (typeof value === 'object') return S.notMeasured;
        return String(value);
    }

    /**
     * Whether a factor was answered in words, so no figure exists to multiply. The three factors of the effort
     * formula, with `timePerPeriod` holding the either/or alternative to minutes; prose in any of them means
     * the product cannot be computed, which is a different statement from a product of zero.
     */
    function effortIsUnmeasurable(workflow) {
        const factors = [workflow.frequencyPerWeek, workflow.minutesPerInstance, workflow.peopleAffected];
        if (workflow.timePerPeriod !== undefined && workflow.timePerPeriod !== null) {
            factors.push(workflow.timePerPeriod);
            if (isProse(workflow.timePerPeriod) || isDeclined(workflow.timePerPeriod)) return true;
            if (workflow.timePerPeriod.hours !== undefined) factors.push(workflow.timePerPeriod.hours);
        }
        return factors.some((f) => isProse(f) || isDeclined(f));
    }

    /**
     * `timePerPeriod` in words, or null when it is not a figure. It is an object rather than a number, and
     * `metaPart` below renders any object as unknown, so without this the card would read "not measured" for
     * effort while the score used the participant's own number.
     *
     * The line is ai/period.js `timePerPeriodIsScorable`: a description is an accepted answer with unknown
     * hours, treated as unmeasurable rather than zero, so it must not read as a measurement here either.
     *
     * @param {*} value The workflow's `timePerPeriod`.
     * @returns {string|null} For example "2 hours per week", or null when there is no figure.
     */
    function timePerPeriodText(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        if (typeof value.hours !== 'number' || !Number.isFinite(value.hours) || value.hours <= 0) return null;
        if (typeof value.period !== 'string' || value.period.trim() === '') return null;
        return value.hours + ' hours per ' + value.period.trim();
    }

    /** Renders a measurement in HTML, or the reason there is none. */
    function metaPart(value, suffix) {
        const text = fieldText(value);
        const unknown = value === undefined || value === null || isProse(value) || isDeclined(value)
            || (typeof value === 'object' && !Array.isArray(value));
        // A value in words carries no unit, so it is shown as words rather than "56 servers/wk".
        return unknown
            ? '<em>' + escapeHtml(text) + '</em>'
            : escapeHtml(text) + escapeHtml(suffix);
    }

    /** Same idea for the Markdown export, through the same formatter so the two cannot drift. */
    function markdownValue(value, suffix) {
        const text = fieldText(value);
        const unknown = value === undefined || value === null || isProse(value) || isDeclined(value)
            || (typeof value === 'object' && !Array.isArray(value));
        return unknown ? text : text + suffix;
    }

    /**
     * Renders one bucket. `mode` decides the number and its label: for "do first" the score is recoverable
     * time and is summed into the total, while the other two buckets show the raw weekly effort, because
     * showing it as "recoverable" would claim hours the analysis says cannot be recovered.
     *
     * A zero that means "not computable" must not be shown as a zero: the effort formula multiplies three
     * factors and the prose marker makes any of them unreadable, so the product is 0, and printing `0 h/wk`
     * would say the work takes no time. Only the label changes; the score cannot multiply a sentence.
     */
    function bucketHtml(cssClass, title, items, mode) {
        if (!items || !items.length) return '';
        let html = '<div class="bucket ' + cssClass + '"><h3>' + escapeHtml(title) + '</h3>';
        for (const wf of items) {
            const value = mode === 'recoverable' ? wf.recoverableHoursPerWeek : wf.effortHoursPerWeek;
            const unit = mode === 'recoverable' ? 'h/wk recoverable' : 'h/wk effort';
            const unmeasurable = effortIsUnmeasurable(wf);
            const scoreText = mode === 'effort' && unmeasurable
                ? '<em>' + escapeHtml(S.effortNotMeasured) + '</em>'
                : escapeHtml(String(value)) + ' ' + escapeHtml(unit);
            html +=
                '<div class="wf">' +
                '<div class="wf-top">' +
                '<span class="wf-title">' + escapeHtml(wf.title) + '</span>' +
                '<span class="wf-score">' + scoreText + '</span>' +
                '</div>' +
                '<div class="wf-meta">' +
                metaPart(wf.frequencyPerWeek, '/wk') + ' · ' +
                metaPart(wf.minutesPerInstance, ' min') + ' · ' +
                metaPart(timePerPeriodText(wf.timePerPeriod) ?? wf.timePerPeriod, '') + ' · ' +
                metaPart(wf.peopleAffected, ' people') + ' · ' +
                'judgement ' + escapeHtml(String(wf.judgementScore)) + '/5' +
                '</div></div>';
        }
        return html + '</div>';
    }

    /**
     * Exports the scored analysis, which is the deliverable: it is handed to a client with nobody present to
     * explain it, so it must contain the score, the bucket, the ranking and the total rather than the raw
     * answers.
     */
    function downloadMarkdown() {
        if (!state.audit || !state.result) return;
        const result = state.result;
        const lines = ['# ' + S.analysisTitle, ''];

        if (state.audit.illustrative) {
            const note = state.audit.note || S.illustrativeBanner;
            lines.push('> ' + note, '');
        }

        // Same floor rule as the card, from the same predicate, so the exported document cannot
        // claim a total the card hedges.
        const anyUnmeasurableMd = result.scored.some(effortIsUnmeasurable);
        lines.push('**' + S.totalRecoverable + ': ' +
            (anyUnmeasurableMd ? S.totalIsFloor + ' ' : '') + result.totalRecoverableHoursPerWeek +
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
                // A zero that means "not computable" is labelled as such here too, or the exported
                // document - which is handed to a client with nobody to explain it - repeats the
                // claim that the work takes no time.
                const scoreLabel = mode === 'effort' && effortIsUnmeasurable(wf)
                    ? S.effortNotMeasured
                    : value + unit;
                lines.push(
                    '### ' + wf.title + ' - ' + scoreLabel, '',
                    '- How often: ' + markdownValue(wf.frequencyPerWeek, ' per week'),
                    '- Time for one instance: ' + markdownValue(wf.minutesPerInstance, ' minutes'),
                    // The either/or partner of the line above, through the same helper as the card.
                    '- Time per period: ' +
                        markdownValue(timePerPeriodText(wf.timePerPeriod) ?? wf.timePerPeriod, ''),
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
     * Opens the conversation for a page reached from an invitation link. The token in the page config is
     * already the credential and is sent with each answer, so no separate code is collected.
     */
    function beginWithToken() {
        $('conversation').classList.remove('hidden');

        if (resumedTranscript.length > 0) {
            state.conversation = resumedTranscript.map((turn) => ({
                role: turn.role,
                content: turn.content
            }));
            for (const turn of state.conversation) {
                appendMessage(turn.role === 'user' ? 'user' : 'ai',
                    turn.role === 'user' ? S.userLabel : S.aiLabel,
                    turn.content);
            }
            appendMessage('ai', S.aiLabel, S.resumedNotice);
            $('actions').classList.remove('hidden');
            return;
        }

        state.conversation = [{ role: 'assistant', content: S.initialMessage }];
        appendMessage('ai', S.aiLabel, S.initialMessage);
        $('actions').classList.remove('hidden');
    }

    // No unlock listeners: a page with a resolved token starts the conversation directly.
    //
    // The `#download-md` guard is required rather than defensive: `$` is getElementById, so an absent
    // button made the listener throw and took the whole block with it, `#input`'s Enter key included.
    document.addEventListener('DOMContentLoaded', () => {
        if (hasToken) beginWithToken();
        $('send-btn').addEventListener('click', send);

        // The guard is required, not defensive; see the block above.
        if ($('download-md')) $('download-md').addEventListener('click', downloadMarkdown);

        $('input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') send();
        });
    });
})();
