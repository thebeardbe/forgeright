# Spec: the three workflows

**Revision 3.** Restructured around the three workflows, after Filip's
corrections. The earlier drafts buried the thing that matters most: **three
separate LLM sessions, each with one job.**

**Status:** draft for correction. Open questions are marked **Q** and are not
guesses.

---

## What the tool is for

**To produce a list that goes into a meeting.** The decision-makers see it and
work out:

- what needs automating
- what it would cost to build
- **which can be done quickly, for early results**
- whether it is legal or possible inside their company

**The tool does not decide.** The model proposes **what is possible** and **what
it takes**. Whether it *should* be done — legally, practically, whether the
company wants it — is the meeting's.

**The sort is by quickness of win.** If five processes can each be automated in a
day, they outrank one that takes three weeks, even a bigger one. **Early results
compound**, which is why build effort is a first-class input and not an
afterthought.

---

## The three workflows

```
WORKFLOW 1  Interview        matrix-driven questioning, per participant
WORKFLOW 2  Identification   is this the same process someone else described?
WORKFLOW 3  Weighing         one number per process, with reasoning
            |
            v
PRESENTATION  View 1: every answer        View 2: the roadmap
```

Each workflow is a **separate LLM session with one job**. They do not share a
prompt, and each can be changed without touching the others.

---

## Workflow 1 — the interview

**The model interviews the participant and decides when it has enough.**

### Why a matrix with a model, not a fixed list

**A fixed questionnaire gets answered to completion.** People give short answers,
pick the first plausible option, and move on, and the result is technically
complete and worth nothing. An interviewer that knows **what it is still missing**
asks for *that specific thing*, which is how you get detail that makes an analysis
possible.

**So the matrix exists so the model knows when it has enough. It is not a script
the participant follows.**

### The completeness matrix

The model must be able to extract every field below from what the participant has
said. It reports which it has and which are missing, and asks only for the
missing ones. **It keeps asking until every field is extractable**, then closes:
*"thank you, is there another process you would like to improve?"*

**Per process:**

```
task                  trigger              steps[]
frequencyPerWeek OR timePerPeriod
peopleAffected        handoffTo[]          waitsFor[]
dependsOn[]           systems[]            touchedDepartments[]
mistakesPerPeriod     mistakeConsequence   currentState
frustration
```

**Per step, within `steps[]`:**

```
name                  what happens
decidedHow            the BASIS on which a person decides, in their words
needsReasoning        DERIVED from decidedHow, not asked
```

**`needsReasoning` is never asked of the participant.** Asking "does this need
your judgement?" asks them to assess automability, which they are not placed to
do and would guess at. **The question is "on what basis do you decide?"** and the
model infers the answer:

```
"How do you decide whether to reorder?"
  -> "if stock is under ten, we reorder"           rules
  -> "depends on the customer, sometimes we wait"  judgement
```

The basis is the evidence; whether it is a rule is the model's reading of it.

**The field list stays as it is for V1.** Whether it is sufficient is exactly what
V1 exists to find out, by running real workflows through it, and expanding it is
cheap.

### Judgement is per step, and that is the discriminator

**Not per process.** A chain can be almost entirely mechanical with one judgement
step in the middle:

```
order arrives            rules
check stock              rules
reorder to supplier      rules (under a threshold)
bookkeeping approval     JUDGEMENT   <- the automation boundary
stock reservation        rules
```

Scored at process level this reads as "needs a person" and nothing gets
automated. Scored per step, five steps are automatable and the boundary is known.

**This is what makes workflow 3 possible**, because "how many steps need
reasoning" and "what parts can be automated" are readings of these flags.

---

## Workflow 2 — identification

**Input:** one completed participant answer.

**Output:** the process it belongs to, and the responses behind that process.

**The model decides whether this describes a process somebody has already
described.** Three people describing the order-to-supplier loop use different
words; the model knows they are one process.

**One participant answer is one process.** A description containing a chain is
recorded as one process with several steps — not several processes.

The model **reports its reasoning** for every match, and its confidence.

### The admin's correction

An admin who disagrees **does not set a category.** They **ask for a
reclassification, with a reason**:

```
Admin sees:   this process, its responses, the score, and the paragraph
              explaining the score
Admin asks:   "rejudge", and writes why they think it is wrong
              -> workflow 2 re-identifies, with that reasoning
              -> workflow 3 regenerates the score and its paragraph
              -> both versions are kept
```

**A dropdown would be worse than a reasoned request.** The classification depends
on factors nobody can enumerate in advance, so the admin's contribution is an
**argument to the model**, not a field to set.

**Settled, and one path for both kinds of disagreement:** a rejudge re-runs
**workflow 2** identification for that process with the admin's reasoning, then
**regenerates workflow 3** from the corrected result. Whether the admin is
disputing the score or the grouping, the flow goes back to workflow 2, because a
process cannot be reweighed before it is certain what it is. A merge implied by
the reasoning brings the other process in too.

---

## Workflow 3 — weighing

**Input:** each process, with its steps and their `needsReasoning` flags.

**Output:** **one number per process**, with the reasoning that produced it.

### The matrix

| Term | What it measures |
| :--- | :--- |
| **Frequency** | how often the work happens |
| **Time** | how long the work takes |
| **People** | how many are affected |
| **Results** | the gain when it is done well |
| **Consequences** | what a mistake costs |
| **Departments touched** | more departments means more steps and more integration |
| **Complexity** | how involved the process is |
| **Automatable share** | what fraction of steps need no reasoning |
| **Reasoning steps** | how many steps need a person |
| **BUILD EFFORT** | **how hard it is to automate** |

**Every term is weighed against the total**, and **every step is considered** to
see how hard it presses on the whole. A process of two steps can be very different
from two single-step processes:

```
auto-sort incoming email     easy   — boilerplate subjects
analyse what is being mailed harder — needs reading and judgement
one process, two steps, weighted by BOTH
```

### The direction of each term

**Up:**

- frequently done
- simple
- few steps needing reasoning
- a large automatable share
- mistakes that cost a lot
- **cheap to build**

**Down:**

- rare
- **complex**
- **many departments** — more steps, more integration
- many steps needing reasoning
- **expensive to build**

**Complexity and departments are costs, not rewards.** An earlier draft had reach
amplifying effort *and* reward, which would have made a sprawling process look
attractive. It is worse, not better.

**Results and frequency are the reward side** — volume and repetition, which is
why *"a very often simple process gets the highest weight"*.

### Build effort is its own estimate

It is **not** the same as current effort. A process can be high-effort today and
cheap to automate, and that is exactly the quick win the sort exists to find.

**Settled:** build effort is **an estimate with its reasoning**. The number sorts
and the reasoning explains, so both are stored.

### The score comes with a paragraph, and is verifiable against the answers

**The model writes a paragraph explaining why the process got that score**,
weighing every requirement it was given. That paragraph is part of the output.

**It does not open a conversation.** It is a written justification attached to the
score, not an invitation to discuss it. `getResponsesForAnalysis`-style prose, not
a chat.

**And the paragraph is not the thing you check.** The admin verifies against the
participant's own words:

```
paragraph   why the model leaned this way            (read it)
answers     what the participants actually said      (check it)
```

**If the paragraph feels wrong, the answers are where you look** — and if they
disagree with it, that is a rejudge, not an argument with the paragraph.

### Rejudging goes back to workflow 2

**Either kind of disagreement takes the same path**, because you cannot reweigh a
process without first being sure what it is:

```
a rejudge
  -> workflow 2 re-identifies the process, with the admin's reasoning
  -> workflow 3 regenerates the score and paragraph from that
```

Disputing the **score** and disputing the **grouping** both go back to workflow 2,
because the admin's reasoning might change what the process *is*, and the weight
depends on that. The earlier score and paragraph are kept, so a rejudge is a
revision rather than an overwrite.

**The formula is provisional** and fine-tuned once there are real responses. V1 is
where that happens.

---

## Presentation

**Two views in the console.** An earlier draft had three, with a separate view
for the assembled processes. That was redundant: **the ordered list contains every
process**, so it is where a wrong flow is fixed. A second view showing the same
processes in a different order would be the same data twice, and the two would
drift.

### View 1 — every answer

- every answer, listed as the participant gave it
- **expandable** to its reasoning: which process it was matched to, and why
- the score and the paragraph explaining it
- **"rejudge"** with a reason
- earlier versions kept

**The subject here is one response.** *"This answer was read wrong"* — matched to
the wrong process, or miscategorised.

### View 2 — the roadmap

**Both the deliverable and the debugging surface**, because they are the same
objects.

- the sorted priority list, highest weight first
- **each item expands** to its detail

**Collapsed:** what it is, the departments and their counts, the weight, and where
a human stays in the loop.

**Expanded:** the steps in order **with reasoning marked per step**, the systems,
what it waits on, dependencies and approvals, **the improvement observed rather
than prescribed**, the paragraph explaining the score, the answers behind the
process, and **a rejudge**.

**A badly grouped process sinks down the list**, which is right for the client's
attention — and it stays rejudgeable there, so it is not hidden from the admin.
Inspecting a process where you are already looking at it beats a separate view.

### Two entry points, one mechanism

**A rejudge is offered in both views, and both do the same thing:**

```
from an ANSWER   in view 1      "this answer was read wrong"
from a PROCESS   in the roadmap "this flow is wrong"
       |
       v
  workflow 2 re-identifies, with the admin's reasoning
  workflow 3 regenerates the score and its paragraph
```

**They are two places, not two mechanisms.** The subject differs; the path does
not, because a process cannot be reweighed before it is certain what the process
is.

### What the console never shows

**Which person gave which answer.** The database holds the link;
`getResponsesForAnalysis` omits the join, so the console cannot receive it.

**And the participant never sees where their answer was grouped, or with what.**
Deliberate: people would write answers to influence the grouping. **There is no
right answer to the questionnaire.** There are processes, and whether any is worth
doing is decided later by people comparing and weighing them.

---

## Two different counts, which are not the same thing

They were merged in an earlier draft and they measure different things.

**A process carries how many PEOPLE DESCRIBED IT**, splittable per department:

```
described by 7 people      Ops 4, Warehouse 2, Finance 1
```

**That is the process's figure.** It feeds the weight.

**Response rate is a fact about the INVITATIONS, not about the process:**

```
Ops        4 answered of 6 invited
Warehouse  2 of 2
Finance    1 of 3
Web        0 of 2      <- nobody replied, which is worth the admin knowing
```

**That lives in the invitation part of the console.** It is diagnostic — "nobody
from the warehouse has answered" is a follow-up task — and it does not belong in
the ranking, where it would confuse "few people described this" with "few people
were asked".

---

## Out of scope

| Deferred | Why |
| :--- | :--- |
| PDF export | Polish on a shape not yet built |
| Emailing the roadmap | A console view for now |
| Tenancy beyond what exists | Frozen: store, accounts, links, HTTPS, console |

---

## The risk this spec is written around

**Workflow 2 is the load-bearing step and the hardest to test.** A wrong grouping
produces a plausible roadmap of the wrong things, and the client acts on it.

Scoring has deterministic tests. A model's grouping has to be judged. **So the
reasoning is surfaced, every process can be challenged with an argument, and
revisions are kept.** That is not polish: it is the only way the one unverifiable
step can be reviewed.
