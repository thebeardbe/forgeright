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
PRESENTATION  View 1: every answer        View 2: the sorted roadmap
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
needsReasoning        true when a person must decide, false when it follows rules
```

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

**Q1.** Is the field list right — anything missing or superfluous? It is the
contract the interview works to.

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
Admin sees:   this process, its responses, and why they were grouped
Admin asks:   "ask for a rerank", and writes why they think it is wrong
              -> the model is asked again, with that reasoning
              -> a new grouping comes back, with its own reasoning
              -> both versions are kept
```

**A dropdown would be worse than a reasoned request.** The classification depends
on factors nobody can enumerate in advance, so the admin's contribution is an
**argument to the model**, not a field to set.

**Q2.** Does a reclassification re-run identification for that process only, or
for everything? I assume that process only, unless the admin's reason implies a
merge with another.

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

**Q3.** Should build effort be its own field the model estimates in a fixed unit
(days? a 1–5 scale?), or a phrase? A number sorts; a phrase explains. I assume
both — an estimate and its reasoning.

**Q4.** The formula itself is **provisional** and to be fine-tuned once there are
real responses. Should the UI explain each term in plain language, so a
decision-maker can ask *"why is this first?"* and get an answer? I assume yes,
because the list's whole purpose is to be discussed.

---

## Presentation

**Two views in the console.**

### View 1 — every answer

- every answer, listed
- **expandable** to its reasoning: how it was identified, what it matched, why
- **"ask for a rerank"** with a reason
- the earlier versions kept

**This is the review mechanism for the one step no test can pin.** A wrong
grouping produces a plausible roadmap of the wrong things, so the working is
visible and challengeable.

### View 2 — the roadmap

- the sorted priority list, highest weight first
- **each item expands** to its detail

**Collapsed:** what it is, the departments and their counts, the weight, and where
a human stays in the loop.

**Expanded:** the steps in order **with reasoning marked per step**, the systems,
what it waits on, dependencies and approvals, and **the improvement observed
rather than prescribed**.

### What the console never shows

**Which person gave which answer.** The database holds the link;
`getResponsesForAnalysis` omits the join, so the console cannot receive it.

**And the participant never sees where their answer was grouped, or with what.**
Deliberate: people would write answers to influence the grouping. **There is no
right answer to the questionnaire.** There are processes, and whether any is worth
doing is decided later by people comparing and weighing them.

---

## Counting, and what a department figure means

Per process, per department:

```
mentioned by / invited in
```

**Invited, not answered.** A department where nobody replied reads `0/6` — which
is visibly different from six people answering and none naming it.

```
Ops 4/6      Warehouse 2/2      Finance 1/3      Web 0/2
```

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
