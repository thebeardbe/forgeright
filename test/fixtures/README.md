# Captured interview payloads

Each file is a bare JSON array of workflows, as a provider returned it. They are read by
`test/workflow-identity.test.js`, which asserts what `reconcileWorkflowIdentity` does to a real
reply rather than to a hand-built fixture.

JSON has no comment syntax, so the provenance of each file is recorded here.

| File | Provenance |
|---|---|
| `onerow.json` | **Verbatim**, pasted by the owner from his live VPS: three entries, two of them step-less stubs. |
| `bills.json` | **Reconstructed** from the assertions that read it, and the field values recorded on that round. |
| `fuelcard.json` | **Reconstructed** from the assertions that read it. |

## What "reconstructed" means, exactly

The payloads below are not byte-for-byte captures. Each was rebuilt so the behaviour under test is
present, and the assertions pin the shape: the entry count, how many entries carry steps, how many
step names two entries share exactly, the surviving entry's `id`, key count and step count. A field
that no assertion required was left out rather than invented.

Two facts carry the tests, and both are held by construction:

- **`bills` folds to one entry**: its two entries share exactly three step names (`open the bill and
  download the lines`, `check each line against the handset list`, `total the charges and write the
  summary`), which is the one arm `reconcileWorkflowIdentity` has.
- **`fuelcard` and `onerow` do NOT fold**: no two of their entries share a step name, because an
  absence-based arm was removed. This is the case the tests exist to keep from returning.

So `bills` proves the fold still fires, and `fuelcard` and `onerow` prove that lacking steps is not
evidence of being the round's process. One fixture does not satisfy both.
