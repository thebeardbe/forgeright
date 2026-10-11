# Spec: aggregation, weighting, grouping, and the roadmap

**Revision 2**, after Filip's corrections. Written for inspection before anything
is built.

Everything below the store currently collects answers and does nothing with them.
This is the business logic, and it is the part the tool exists for.

**Status:** draft for correction. Open questions are marked **Q** and are not
guesses.

---

## The shape

```
raw responses  ->  AGGREGATION  ->  WEIGHTING  ->  GROUPING  ->  ROADMAP
   (stored)         the model       arithmetic      arithmetic     the model
                    groups and     over the        over the       synthesises
                    names          grouping        grouping
```

**The division of labour, which is the point:**

- **The model reasons about language.** Which descriptions mean the same task,
  what to call it, which department a phrase refers to. No script can do this:
  "invoice intake", "processing incoming invoices" and "AP document handling" are
  one task.
- **The script counts.** How many people mentioned it, how many departments, the
  ratios. Arithmetic is not a language task and a model doing it is a source of
  quiet errors.
- **The model writes the roadmap**, from the three analyses.

---

## 0. Two matrices, and keeping them apart

They were confused in the first draft. They are unrelated and belong to different
phases.

| | **Completeness matrix** | **Scoring matrix** |
| :--- | :--- | :--- |
| Where | the interview | the roadmap |
| Decides | is this answer complete enough to score? | what ranks highest? |
| Who uses it | the model, mid-questionnaire | the reader, in the console |
| **This phase?** | **yes** | provisional; fine-tuned later |

---

## 1. The questionnaire's completeness matrix

**This is already the design of the intake; it needs its fields settled and
stated.**

The model must fill an agreed set of fields from what the participant says. It
reports which it has and which are missing, and asks only for the missing ones.

**It keeps asking until every field is extractable from the answers.** A
participant who describes the process, its steps, the departments involved and
the effort it takes has satisfied everything, and the model says so: *"thank you,
is there another process you would like to improve?"*

**The fields, per process:**

```
task, trigger, steps[], frequencyPerWeek OR timePerPeriod,
peopleAffected, handoffTo[], waitsFor[], dependsOn[],
judgement per step, stepsConsistent, systems[],
mistakesPerPeriod, mistakeConsequence, touchedDepartments[],
currentState, frustration
```

**Judgement is recorded per step, not per process.** That is the correction that
matters: a chain can be almost entirely mechanical with one judgement step in the
middle, and that step is the automation boundary. Scores at process level would
mark the whole chain as needing a person and automate none of it.

**Q1.** Is that field list right, and is anything missing or superfluous? It is
the contract the model works to and the shape the scoring reads.

---

## 2. Aggregation

**Input:** every response for one organisation, in natural language.

**Output:** a list of **processes**, each with the responses that described it and
the participant who gave each.

**What the model does:**

1. **Decides sameness.** Responses describing the same task become one process,
   however differently worded. Three people describing the order-to-supplier loop
   are one process.
2. **Records the segmentation**, which is internal. A description containing a
   chain is recorded as **one process with several steps** — not several
   processes.
3. **Names it**, in the language of the responses, as the actual work rather than
   a category.
4. **Reports its reasoning** for every merge, and its confidence, so a human can
   disagree and say why.

**One response is one process.** A participant describes a thing they do; the
steps inside it are how it is recorded, not separate answers.

**What the script does:** holds the responses, passes them to the model, stores
the grouping, and keeps the mapping from process to responses.

**Q2.** Every process is recorded, including one mentioned by a single person.
Confirm that holds for the roadmap too, or whether single mentions rank
differently.

---

## 3. Aggregation is inspectable, and reclassifiable

**The model's decisions are visible rather than hidden behind a clean list.**
Beside each process:

- the responses that formed it
- the reasoning for the merge
- the confidence

**This is the one step no test can fully pin.** A wrong grouping produces a
plausible roadmap of the wrong things and the client acts on it, so the working
is shown and can be challenged.

### Reclassification

An admin who disagrees **does not set a category.** They **ask for a
reclassification, with a reason**:

```
Admin sees:   this process, grouped from 4 responses, and why
Admin clicks: "ask for a reclassification"
Admin writes: why they think the grouping is wrong
  -> the model is asked again, with that reasoning
  -> a new grouping comes back, with its own reasoning
  -> both versions are visible
```

**A dropdown would be worse than a reasoned request.** The classification depends
on factors nobody can enumerate in advance, so the admin's contribution is an
**argument to the model**, not a field to set.

**Versions are kept**, so a reclassification is a revision rather than an
overwrite, and the earlier grouping can be seen.

**The participant never sees where their process was grouped, or with what.**
Deliberate: people would write answers to influence the grouping. **There is no
right answer to the questionnaire.** There are processes, and whether any is worth
doing is decided later by people comparing and weighing them.

**Q3.** Does a reclassification regenerate the whole roadmap, or only the affected
process's placement?

---

## 4. Weighting

**Arithmetic on the aggregation's output. No model involved.**

Per process, per department:

```
mentioned by / invited in
```

- **mentioned by** — how many responses named this process, from that department
- **invited in** — how many people in that department were **invited**

**Invited, not answered.** A department where nobody replied shows `0/6`, which
is visibly different from a department where all six answered and none named it
(`0/6` with the counts) — and both are different from `6/6`.

**Displayed as counts, never a bare ratio:**

```
Ops 4/6      Warehouse 2/2      Finance 1/3      Web 0/2
```

### Reach

`reach` = the number of distinct departments a process touches.

**It amplifies both sides, deliberately:**

| | Effect |
| :--- | :--- |
| More departments | **higher effort** — more systems, more people, more integration |
| More departments | **higher reward** — more people affected, more duplication removed |

So a process spanning four departments is a bigger project *and* a bigger payoff.
**The roadmap shows both sides and the reader decides.** It is not a penalty and
not a bonus.

### The scoring formula is provisional

**The goal is a sorted list by importance and gain in time or money.** The exact
matrix is to be fine-tuned once there are real responses to look at; this phase
starts with the simple form:

```
effort            = frequency * time * people
automability      = from the judgement scores, per step
mistakes × consequence = what a failure costs
reach             = amplifies both effort and reward
```

**Marked provisional on purpose**, so a placeholder is not later treated as
settled.

**Q4.** Must the score be defensible to a client — "why is this first?" —
in which case every term needs a plain-language explanation in the UI. I assume
yes.

---

## 5. Grouping

**Where a process appears, from `touchedDepartments`.**

| Section | Contains |
| :--- | :--- |
| **Per department** | processes touching it, ranked within it |
| **Cross-department** | processes touching several, in their own section |
| **Overall** | everything |

A cross-department process appears **in the cross-department section**, not filed
under one department and not duplicated.

---

## 6. The roadmap

**A separate tab in the console.** Not a document, not an export. Each item
**expands** to its detail.

**Input:** the three analyses. **The model synthesises**, then the script renders.

**Collapsed, each item shows:**

- what it is, in plain language
- the departments it touches, with the counts
- effort, mistakes, consequence
- **where a human stays in the loop**

**Expanded:**

- the steps, in order, **with judgement marked per step**
- the systems involved
- what it waits on, what has to happen first
- dependencies and approvals
- **the improvement, observed rather than prescribed**

**Two things the roadmap does not do:**

- **It does not decide.** It lays out evidence and observations; the meeting
  decides.
- **It does not exclude.** An already-automated process still appears, because an
  employee calling it tedious is a finding. `currentState` is context, never a
  gate.

---

## 7. Visibility, and its limit

**Answers are visible in the console and can be challenged.** The admin sees each
response, how it was grouped, and the reasoning.

**The console never shows which person gave which answer.** The database holds the
link; `getResponsesForAnalysis` omits the join, so the console cannot receive it.
This is the rule the store already enforces and it holds here unchanged.

A person with direct database access can join the two. That is the accepted,
documented limit, not an oversight.

---

## Out of scope

| Deferred | Why |
| :--- | :--- |
| PDF export | Polish on a shape not yet built |
| Emailing the roadmap | A console tab for now |
| Model-written final prose | The shape is proven by hand first |
| Tenancy beyond what exists | Frozen: store, accounts, links, HTTPS, console |

---

## The risk this spec is written around

**Aggregation is the load-bearing step and the hardest to test.** A wrong
grouping produces a plausible roadmap of the wrong things, and the client acts on
it. Scoring has deterministic tests; a model's grouping has to be judged.

**So the model's reasoning is surfaced rather than hidden**, every process can be
challenged with an argument, and revisions are kept. That is not polish: it is
the only way the one unverifiable step can be reviewed.
