# Finding: DeepSeek's JSON mode returns whitespace as a conversation grows

Measured 2026-10-11 against the live API. This is the answer to "why does the
prompt break at around 2K tokens" — it does not, and the token theory was a
correlation reported as a cause.

## The finding

**`response_format: {type: "json_object"}` becomes unreliable as a conversation
grows. Plain mode does not.**

```
JSON mode,  synthetic conversation:
   2 turns  4/4
   3 turns  3/4
   4 turns  3/4
   5 turns  3/4
   6 turns  1/4

plain mode, same conversations:
   2 turns  4/4
   5 turns  4/4        <- stable

real 7-message conversation:
   json mode   0/6 non-blank
   plain mode  6/6 non-blank
```

The response is **11 to 16 spaces**, with `finish_reason: "stop"` and HTTP 200.
Not an error, not a truncation, not a rate limit.

## Why the earlier explanations were wrong

| Observation | The appearance | The reality |
| :--- | :--- | :--- |
| Failed "around 2000 tokens" | a length threshold | longer conversations have more turns; length was correlated, not causal |
| 3584 tokens succeeded | length is not it | a different, shorter-turn conversation |
| 31 filler messages succeeded | count is not it | repeated identical turns, not distinct generated ones |
| A retry did not help | transient? | deterministic in JSON mode on that input |
| `max_tokens: 8192` did not help | truncation? | not truncation |
| Both model names did it | not the model | it is the response format |
| Removing the assistant turns fixed it | role pattern? | fewer turns, below the threshold |

Every one of those was a real observation and a wrong conclusion, because none of
them varied the response format.

## What to do

**Stop relying on JSON mode for DeepSeek, and parse the JSON out of a prose
reply.** Three parts:

1. the adapter stops sending `response_format` for this provider
2. the parser extracts JSON from surrounding prose — a fenced block, or the
   outermost balanced `{...}`
3. **tests for that extraction**, because it is now load-bearing and a model that
   wraps JSON in ```json fences is the normal case, not an edge

**Check whether Gemini has the same behaviour** before assuming the workaround is
provider-specific. The config treats `responseMimeType` as generic, and if both
providers degrade then the parsing fallback is not a workaround but the design.

## What this says about the process

The mock could not show it, the unit tests could not show it, and four rounds of
reasoning about the prompt were wrong. **One live conversation found it in
minutes, and the answer was in a request parameter nobody had questioned.**

Related, and probably the same phenomenon: a reply in the parent session was
truncated to 13 characters — `"Agreed — repr"` — on the same model family. Both
are a short output where a substantial one was expected, accepted as complete.
