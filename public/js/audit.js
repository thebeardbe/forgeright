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
        result: null,
        // The processes this round holds, by `id`, as last saved. `roundProcesses` is
        // what a completion claim is checked against before it is stored: see
        // mergeForwardDroppedProcesses. It is deliberately the SAVED set rather than the
        // last reply's, so a reply that drops a process cannot also overwrite the record
        // of what the round had.
        roundProcesses: new Map()
    };

    /**
     * The round this participant left open, if any.
     *
     * RESUMING, which the page has been handed data for all along and never used. The
     * server sends every response for this invitation; before this, the page ignored
     * them and a returning participant started from the greeting, having to answer
     * everything again.
     *
     * ONLY AN OPEN ROUND IS RESUMED. `submitted_at === null` means unfinished; a
     * timestamp means that process was concluded, and its work is done and recorded -
     * replaying it would ask the participant to redo a process the system already has.
     * So the newest unfinished round is the one to continue, and if there is none this
     * is a fresh participant and nothing changes.
     *
     * THE TRANSCRIPT IS REPLAYED, NOT THE EXTRACTED FIELDS. The participant sees the
     * conversation they actually had, which is what makes it recognisable as their own
     * work rather than a form that happens to be pre-filled. The extracted data lives in
     * the next payload the server upserts, so it needs no separate restoring here.
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

            // EVERY TURN IS SAVED, PARTIAL OR NOT.
            //
            // This used to save ONLY on completion, so an interview the participant
            // abandoned was never stored at all: no answers, no transcript, and an
            // empty console. That is the common case rather than the edge one - a
            // real participant stopped mid-interview and lost everything - and it is
            // the failure progressive saving exists to close. A turn that is not
            // saved is a turn that a closed tab destroys.
            //
            // `complete` IS SENT FROM THE SERVER'S OWN STATUS, not from anything
            // decided here. `data.status === 'complete'` is computed by the matrix on
            // the server, so "this process is finished" is never the page's opinion.
            // The server uses it to finalise the round; see recordTurn.
            //
            // A PAYLOAD IS NOT REQUIRED TO SAVE. An early turn has no usable payload
            // yet - the matrix is still filling - and skipping the save would lose
            // exactly the first answers a participant gives. Only the transcript is
            // essential, and the server stores whatever `data` it is given.
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

            // A COMPLETION CLAIM MUST NOT NARROW THE PAYLOAD.
            //
            // The matrix gate already refuses to FINISH a process with fields missing.
            // This is the same rule one step over: a reply claiming completion must not
            // carry FEWER processes than the round already holds, because dropping one
            // is how its answers stop being recorded and the participant is asked for all
            // of it again.
            //
            // It happens for a mundane reason - the model asked "is there another
            // process?" before the matrix was satisfied, believed a process had ended,
            // and started a fresh matrix for what it took to be the next one. On a real
            // deepseek run the payload went from 15 fields to 3 that way. The prompt now
            // tells it not to (see "drop the finished process only when the participant
            // has confirmed"), BUT THIS IS THE HALF THAT DOES NOT DEPEND ON THE MODEL
            // OBEYING: a wrong belief about completion costs the participant nothing,
            // whatever the model does.
            //
            // COMPARED BY PROCESS `id`, which is the only stable name a reply carries. A
            // process the round already had and the new payload no longer mentions is
            // carried forward from the saved round, so what was collected stays.
            // THE IDENTITY IS SETTLED FIRST, so everything below - the carry-forward, the
            // record of what the round holds, and the payload that is scored - agrees on how
            // many processes there are. See reconcileWorkflowIdentity for why this is here and
            // not on the server.
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
                // The round ends, and it is scored on what was supplied - unlike the
                // nothing-answered case, where there would be nothing to score.
                //
                // `toSave` RATHER THAN `payload`, and this matters: `payload` is the raw reply,
                // while `toSave` carries the reconciled identity and any process carried forward
                // from the round. Scoring the raw reply showed the participant a total built
                // from a stub while the full process sat unread beside it in the same round.
                $('input-area').classList.add('hidden');
                if (toSave) {
                    state.audit = toSave;
                    await runScoring();
                }
                return;
            }

            if (isComplete && toSave) {
                // `toSave` for the same reason as the exhausted branch above.
                state.audit = toSave;
                // THE INPUT STAYS OPEN, because the closing question is answerable.
                // Hiding it here is what made the second process unreachable: the
                // model asks "is there another process you would like to improve?"
                // in the SAME reply that reports completion, and the participant had
                // no way to answer it. Rounds 2 and beyond could therefore never
                // begin, which is the whole point of the round model.
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
     * Stores one turn of answers, WITH the conversation that produced them.
     *
     * EVERY TURN, NOT ONLY THE LAST. It is called after each reply, and it upserts the
     * round the participant is currently in. A turn that is not saved is a turn a
     * closed tab destroys, and the interview is long enough that abandoning it is
     * ordinary rather than exceptional.
     *
     * `complete` FINALISES THE ROUND, and it comes from the server's own `status`: the
     * page only passes that answer back. Null `submitted_at` means partial, a timestamp
     * means the process is done.
     *
     * THE TRANSCRIPT GOES WITH THE PAYLOAD because the raw data has to exist. An
     * answer is only meaningful against its question: "eight minutes" means one
     * thing asked about duration and another asked about the invoice count, so
     * storing the extracted fields alone gives text with no referent, and the
     * questions -- where the interview's quality lives -- are lost with the tab.
     *
     * The conversation is already here in `state.conversation`, so this passes
     * what exists rather than building anything new. It GROWS with every turn, and
     * the server rewrites the stored copy from it on each save - so the row always
     * holds the conversation as it stands, not as it stood at the first save.
     *
     * Only when the page was reached from an invitation link, since that is what
     * identifies the participant. A failure is logged rather than shown: the
     * participant has their analysis on screen, and an error box would suggest
     * their answers were lost when they were not.
     */
    /**
     * Carries forward any process a completion reply left out.
     *
     * WHY A PROCESS `id` AND NOT AN INDEX. The payload is a list, and the model may
     * reorder it as its understanding changes; an index would match the wrong process
     * and substitute one process's fields for another's, which is worse than losing
     * them. `id` is the name the prompt gives each process, and it is what the reply
     * itself uses to say which process it means.
     *
     * WHY NOTHING IS EVICTED. A process that is genuinely finished and superseded stays
     * in the round, because a round IS the work of one process: discarding a finished
     * process's fields is the failure this function exists to prevent. The next round
     * starts empty, which is where a finished process legitimately stops being recorded.
     *
     * THE WORKFLOWS ARRAY IS WHAT IS MERGED, because that is what the server stores and
     * what scoring reads. A reply with no usable payload comes back unchanged - there is
     * nothing to merge and nothing to guard against.
     *
     * @param {object|null} payload The payload from this reply, if any.
     * @param {Map<string, object>} held The processes the round already has, by id.
     * @returns {{ payload: object|null, dropped: string[] }}
     */
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
     * Gives each process in this reply the identity the round already gave it, and collapses a
     * reply that describes the SAME process twice.
     *
     * THE DEFECT, measured on a real interview. The server derives a process `id` from its `task`,
     * and THE MODEL REWORDS THE TASK BETWEEN TURNS. One participant describing one process produced
     * the same work under several ids, each reading as a NEW process, none matched, and they
     * accumulated: a score built from one variant while the others scored 0. Two runs of one
     * interview gave 385 h/wk and 25.5 h/wk depending on how many times the model reworded itself.
     *
     * THE CONTRACT THIS USED TO HAVE WAS UNREACHABLE, which is why four rounds of verification
     * missed it. It began `if (workflows.length !== 1) return workflows` - "exactly one workflow in
     * the reply" - and a real reply carries TWO for one process: the stale carry-forward beside the
     * current one. Measured: one entry in the reply merged correctly, two entries were returned
     * untouched, EVERY turn. The rule was dead code on every live interview, and the tests passed
     * because they were written to the guard's shape.
     *
     * THE CONTRACT NOW: EVERY workflow in the reply is matched against EVERY process the round
     * holds, on the exact step-name co-test below, and takes the id of the process it matches. The
     * number of entries on either side is not part of the contract, because it was never a property
     * of a real reply.
     *
     * A REPLY THAT DESCRIBES ONE PROCESS TWICE IS COLLAPSED, and this is the part that actually
     * removes the duplicate. Identity alone cannot do it: in the reported case BOTH entries share
     * the round's process, so both would take its id and the reply would still carry two entries
     * with the same id. So two entries that SHARE AN EXACT STEP NAME are one process, and the
     * RICHER one survives - the same work with less filled in and differently worded, not a copy
     * holding identical values.
     *
     * NOTHING IS FOLDED ON ABSENCE. An arm that discarded an entry carrying no steps, whenever
     * another entry in the reply carried something, was built and removed: a process the
     * participant had just NAMED arrives exactly that way (prompt line 511), so that arm discarded
     * a live answer. See the note where the fold is, for the measurement that settled it.
     *
     * THE HARM DIRECTION IS UNCHANGED, and it is why the matching is per-entry rather than
     * all-or-nothing:
     *
     *   two genuinely different processes, each matching a DIFFERENT held process
     *     -> each keeps its own id, the reply still carries two. This is the case that would break
     *        if the rule assumed "one on each side".
     *   two entries matching the SAME held process
     *     -> one process under two wordings, collapsed, and the console.warn below reports it.
     *   an entry matching nothing
     *     -> keeps its own id and is left alone, so a NEW process is never fused into an old one.
     *
     * A FALSE MERGE NEEDS A POSITIVE, VERBATIM AGREEMENT: two entries sharing an exactly equal step
     * name, both matching one held process. Nothing is inferred from the ABSENCE of evidence, which
     * is what makes this different from the boundary filter that was built and reverted - that one
     * could not tell a stale carry-forward from a process the participant had just named, because at
     * the boundary the round's history is not available. Here it is.
     *
     * WHY STEP NAMES AND NOT THE TASK: the task is the field the model rewrites, which is what broke
     * the id in the first place. A step is a named thing the participant described, so it is the most
     * stable name in the payload. The test is an EXACT comparison after trimming and case-folding -
     * no similarity, no threshold, no number to tune.
     *
     * @param {Array<object>} workflows The workflows from this reply.
     * @param {Map<string, object>} held The processes the round already has, by id.
     * @returns {Array<object>} The workflows, each carrying a held id where one matched, with a
     *   process described twice collapsed to its richest single entry.
     */
    function reconcileWorkflowIdentity(workflows, held) {
        if (!Array.isArray(workflows) || workflows.length === 0) return workflows;
        // NO EARLY RETURN ON AN EMPTY `held`. It looks like a cheap short-circuit and it is a bug:
        // the fold below compares entries WITHIN THIS REPLY and needs no round history at all, so
        // returning here would leave the duplicate on the very first turn it appears - which is
        // exactly when the stale copy is not yet in `held` and nothing else can catch it.

        // EACH ENTRY IS MATCHED ON ITS OWN, so a reply carrying several processes, several
        // wordings of one process, or both, is handled by the same pass.
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

        // ONE ENTRY PER PROCESS, and this is the part that actually removes a duplicate.
        //
        // TWO ENTRIES IN ONE REPLY CAN BE THE SAME PROCESS, and rule 1's own sentence says so:
        // it treats an exact shared step name as proof of identity, so two entries that share one
        // ARE one process by that rule. Resolving against `held` alone cannot see this, because on
        // the first turn both entries are new and neither is held - measured on the reported
        // payload, which came out as two entries with three identical step names between them.
        //
        // THE SAME CLAIM IS MADE IN TWO WAYS HERE, and they are deliberately one pass rather than
        // two rules, because they answer one question - "are these two entries the same process?"
        // - and differ only in what counts as evidence:
        //
        //   POSITIVE: they share an exactly equal step name. The evidence is present and verbatim.
        //   BY ABSENCE: one carries nothing at all - no steps and no measurable field - while a
        //     sibling in the same reply carries something. That is the model's own earlier wording
        //     carried forward without its content, which the prompt forbids (`prompt_en.md` line
        //     515: "`processes` holds the process you are working on NOW"). The evidence is the
        //     absence itself, which is why it needs the sibling's presence to mean anything.
        //
        // THE SECOND FORM CANNOT DISCARD A PROCESS THE PARTICIPANT JUST NAMED, and that is the
        // condition that matters. A newly named process "STARTS THE CONVERSATION AGAIN... as a
        // fresh matrix from its `task` and `trigger` onward" (line 511), so it arrives empty - but
        // A merge is REPORTED, because removing a participant's entry is the kind of change that
        // must be visible in a log rather than inferred from a missing row.
        //
        // PASS 1 IS ABOVE: every entry was resolved against `held`, so an entry the round knows
        // takes the round's identity.

        // PASS 2 — THE POSITIVE TEST, PAIRWISE: two entries sharing an exactly equal step name are
        // one process, because that is what rule 1 says a shared step name means. Repeated to a
        // fixed point, because a later entry can match an entry that was itself folded into an
        // earlier one: with [a, b, c] where a~c and b~c, one pass over the array would leave a and
        // b standing beside the merged c.
        //
        // THE RICHER ENTRY WINS, by `measurableCount` (steps first, then filled fields).
        //
        // WHAT THE LOSER ACTUALLY IS, stated precisely because "it is a subset" would invite a
        // reader to expect identical text and it is not. Measured on the artefacts: every key the
        // loser carried is present in the winner, so nothing is DROPPED - but the shared keys do
        // not always hold the same VALUE. Nine of them hold different wording, and some of the
        // loser's phrases read fuller ("the monthly bill arrives by email" against "the bill
        // arrives from email"). So the loser is the same work, LESS FILLED IN AND DIFFERENTLY
        // WORDED, and what survives is one account of one process rather than two.
        //
        // WHAT THAT COSTS, measured rather than assumed: the steps survive, and the score reads
        // the same apart from one `needsReasoning` flip, which is model noise rather than a lost
        // answer. The alternative - keeping both - is what produced the duplicate row this exists
        // to remove, and the score built from a stub while the real process sat beside it.
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

        // THERE IS NO BY-ABSENCE ARM, AND ITS ABSENCE IS A DELIBERATE DECISION RATHER THAN AN
        // OVERSIGHT. The arm existed to fold an entry with no steps and no measurable field into a
        // richer sibling, reading it as the model's own earlier wording carried forward - which
        // `prompt_en.md` line 515 forbids ("`processes` holds the process you are working on NOW").
        //
        // IT WAS REMOVED BECAUSE IT SILENTLY DISCARDED A PROCESS THE PARTICIPANT HAD JUST NAMED.
        // Measured through this function: a finished process with steps, sitting beside a process
        // the participant had just named ("Onboarding a new supplier", `task` and `trigger` only),
        // came out as ONE entry - the new process gone.
        //
        // THE TWO SITUATIONS ARE THE SAME SHAPE, and that is why no rule can separate them:
        //
        //   a stale carry-forward BESIDE ITS OWN PROCESS   -> an empty entry beside a rich sibling
        //   a NEWLY NAMED PROCESS beside an UNRELATED ONE  -> an empty entry beside a rich sibling
        //
        // Neither empty entry has steps to co-test on, both arrive with `task` and `trigger` only,
        // and the prompt creates BOTH: line 521 says keep holding the completed process until the
        // participant confirms, line 511 says a newly named process starts as a fresh matrix with
        // no steps. So `[rich, empty]` is a legitimate turn for two completely different reasons.
        //
        // I TESTED THE OBVIOUS DISCRIMINATOR - comparing the empty entry's task against its
        // sibling's - AND IT DOES NOT WORK. Measured on the artefacts: the case the arm was built
        // for (`/tmp/onerow.json`) shares only FOUR words with its rich sibling and one of its
        // stubs has NO TRIGGER AT ALL, while a newly named process in the same domain shares TWO.
        // Any overlap rule low enough to fold the first also destroys the second, and a participant
        // naming a second process in a domain they have already described is the ordinary case
        // rather than a corner one. There is no separating value, so there is no rule to write.
        //
        // THE ASYMMETRY DECIDES IT. An extra row is cosmetic: it renders as a second process
        // reading "not measured", which a reader sees and can ignore. A discarded process is SILENT
        // DATA LOSS, and it is unrecoverable - the participant is never asked again, because the
        // matrix reset from the new process's `task` onward and the next turn simply continues.
        // The cost of removing the arm is the extra rows it would have removed; the cost of keeping
        // it is somebody's answer disappearing with nothing to show for it.
        //
        // WHAT IS LEFT FOLDS ONLY ON POSITIVE, VERBATIM EVIDENCE: an exactly equal step name, which
        // the participant actually said twice. Nothing here is inferred from the ABSENCE of
        // evidence, so nothing can be discarded merely for being new.

        return merged;
    }

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

        // A RESUMED ROUND REBUILDS THE CONVERSATION IT ACTUALLY HAD, so the participant
        // can read what they said before continuing. `state.conversation` is what gets
        // posted back on the next turn, so restoring it also means the server receives
        // the whole conversation again rather than only the new part - which is what
        // `recordTurn` rewrites the stored transcript from.
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

    document.addEventListener('DOMContentLoaded', () => {
        // NO UNLOCK LISTENERS. The controls they bound to, #start-btn and #pass, are
        // not rendered any more and the function they called is gone, so a page with a
        // resolved token starts the conversation directly - which is the only case.
        if (hasToken) beginWithToken();
        $('send-btn').addEventListener('click', send);

        // THE GUARD IS REQUIRED, NOT DEFENSIVE. `#download-md` is hidden in the view for the
        // PoC, and this line bound it UNGUARDED: `$` is getElementById, so a hidden-or-absent
        // button made this `null.addEventListener` and threw a TypeError, which would take the
        // whole listener block with it - `#input`'s Enter key included - so the questionnaire
        // would have loaded and then silently ignored every answer. This codebase has had that
        // exact bug once already, which is why the check is here rather than assumed.
        //
        // THE HANDLER AND THE STRING ARE KEPT, so bringing the button back is removing the
        // `hidden` attribute in views/audit.ejs and nothing else.
        if ($('download-md')) $('download-md').addEventListener('click', downloadMarkdown);

        $('input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') send();
        });
    });
})();
