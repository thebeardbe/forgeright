# Spec: aggregation, weighting, grouping, and the roadmap

For inspection before anything is built. This is the business logic, the part the
tool exists for: everything below it currently collects answers and does nothing
with them.

**Status:** draft for Filip to correct. Open questions are marked **Q** and are not
guesses.

---

## The shape

```
raw responses  ->  AGGREGATION  ->  WEIGHTING  ->  GROUPING  ->  ROADMAP
   (stored)         LLM decides     arithmetic      arithmetic     LLM synthesis
                     sameness       on the LLM's    on the LLM's   of all three
                     and naming     grouping        grouping
```

**The division of labour, which is the point:**

- **The model reasons about language.** Which descriptions mean the same task.
  What to call it. Which department a phrase refers to. Nothing else can do this:
  "invoice intake", "processing incoming invoices" and "AP document handling" are
  one task, and no script knows that.
- **The script counts.** How many people mentioned it, how many departments, what
  the ratio is. Counting is not a language task, and a model doing arithmetic is
  a source of quiet errors.
- **The model writes the roadmap**, from the three analyses' output.

---

## 1. Aggregation

**Input:** every response for one organisation. Each is a participant's answer
about one or more processes, as natural language.

**Output:** a list of **processes**, each with the responses that described it.

**What the model does:**

1. **Decides sameness.** Two responses describing the same underlying task become
   one process, even when the wording differs completely. Three people describing
   the order-to-supplier chain are one process, not three.
2. **Decides the boundary.** Where one description contains more than one thing
   worth acting on, it may split — the job-search example was three tasks
   (classify mail, write the record, answer "have I applied here before"), each
   with a different verdict.
3. **Names it**, in the language of the responses, as a task a person would
   recognise. Not a category, the actual work.
4. **Reports its confidence and its reasoning** for a merge, so a human can
   disagree. *"These three describe the same reorder loop: each mentions a
   stock check followed by a supplier order."*

**What the script does:** holds the responses, passes them to the model, stores
the grouping that comes back, and keeps the mapping from process to the responses
that formed it.

**Q1.** Should a process that only one person described be included, or only ones
mentioned by several? My reading: **include it**, because one person's tedious
task is still a candidate and the weighting already reflects that only one person
said it.

**Q2.** When the model splits one response into three, what does the participant
see on their own summary? They described one thing and the analysis says three.

**Q3.** What happens when the model's grouping changes between runs — because a
later participant adds a description that merges two previous processes? Does the
roadmap regenerate, or is a human's edit preserved?

---

## 2. Weighting

**Arithmetic on the aggregation's output. No model involved.**

For each process, per department:

```
mentions in department / respondents in department
```

- **mentions** — how many responses named this process, where the respondent is
  in that department
- **respondents** — how many people in that department answered at all

**Reach:** how many departments the process touches.

```
reach = the number of distinct departments named in touchedDepartments
```

**Reach amplifies both sides, and that is deliberate:**

| | Effect |
|---|---|
| More departments | **higher effort** — more systems, more people to align, more integration surface |
| More departments | **higher reward** — more people affected, more duplicated work removed |

So a process spanning four departments is a bigger project *and* a bigger payoff.
The scoring shows both sides and the reader decides whether the complexity is
worth it. **It is not a penalty and not a bonus.**

**Displayed as counts, never a bare ratio:**

```
Ops 4/6      Warehouse 2/2      Finance 1/3      Web 0/2
```

**Q4.** The ratios are per department, so what is the number for the *overall*
roadmap ranking? My earlier reading was **the mean of the per-department ratios**,
with counts shown alongside and no minimum, so a two-person department is not
buried by a twenty-person one. Confirm or correct.

---

## 3. Grouping

**Where a process appears. Arithmetic, from `touchedDepartments`.**

Three sections:

| Section | Contains |
|---|---|
| **Per department** | processes touching that department, ranked within it |
| **Cross-department** | processes touching several, in their own section |
| **Overall** | everything |

**A cross-department process appears in the cross-department section, not filed
under one department and not duplicated into all of them.** That is what makes
the cross-department complexity visible as its own thing.

**Q5.** A department with **no respondents** — how does it appear? A process can
touch the warehouse with nobody from the warehouse having answered. I would show
it with `0/0` and the invitation count, so "nobody answered" is visibly different
from "everyone answered and disagreed".

---

## 4. The roadmap

**A separate tab in the console.** Not a document and not an export. Each item
**expands** to its detail.

**Input:** the three analyses above. **The model synthesises**, then the script
renders.

**Each roadmap item shows, collapsed:**

- what it is, in plain language
- the departments it touches, with the counts
- the three figures: effort, mistakes, consequence
- **where a human stays in the loop**, where relevant

**Expanded, what the handoff calls "the details of what is needed and
restrictions":**

- the steps, in order
- the systems involved
- what it waits on, and what has to happen first
- the dependencies and approvals
- **the improvement, observed rather than prescribed**

**Two things the roadmap does not do:**

- **It does not decide.** It lays out the evidence and the observation; the
  meeting decides. That was the owner's position and it is the design.
- **It does not exclude.** A process already automated is still shown, because an
  employee calling it tedious is a finding regardless. `currentState` is context,
  never a gate.

**Q6.** Expanded detail comes from the participant's own words, so it is only as
detailed as they were. Where a participant gave a short answer, does the roadmap
show what is known and say what is missing, or ask them again?

**Q7.** The three figures — effort, mistakes, consequence — are per process or per
step? My reading: **effort and consequence per process, judgement per step**,
since judgement is where the automation boundary sits.

---

## What is *not* in this phase

| Deferred | Why |
|---|---|
| PDF export | Polish on a shape not yet built |
| Roadmap generation by the model writing final prose | The shape must be proven by hand first, per the original build order |
| Emailing the roadmap | It is a console tab for now |
| V2 anything | Tenancy stops here |

---

## The one thing that worries me

**The aggregation is the load-bearing step and the hardest to test.** A wrong
grouping produces a plausible roadmap of the wrong things, and the client acts on
it. A script has deterministic tests; a model's grouping has to be judged.

**I would build it so the model's decisions are visible and inspectable** — the
merge reasoning, the confidence, the responses behind each process — rather than
producing a clean list that hides how it got there. That also gives the manual
test plan something to check.

**Is that the right instinct?** It costs a little UI and makes the output
reviewable, which matters more for the one step no test can fully pin.
