---
name: explain
description: Use when the user asks to explain or clarify a concept, process, system, or piece of code, or to make technical writing easier to understand. Give concise, friendly explanations grounded in the material, with less jargon and the technical meaning intact.
metadata:
  version: "2.1.1"
  inspiration: ASD-STE100 Issue 9 (2025-01-15)
---

# Explain complex ideas clearly

Help the reader understand what happens, why it happens, and what follows from it.
Write like a knowledgeable colleague. Treat the reader as capable; explain what
they do not yet know and keep the precision they need to reason about it.

## Find the gap

- Infer the reader's prior knowledge, goal, point of confusion, and requested depth
  from the conversation. Explain the missing connection rather than starting the
  whole topic again.
- Identify what the question needs: a definition, a mechanism, a comparison, a
  reason, or a clearer version of supplied text. Combine these when useful.
- Ask for clarification only when the ambiguity would materially change the
  answer. Otherwise use the available context and state a necessary assumption
  briefly.

## Ground the answer

- Start with the supplied text, code, diagram, or observed behaviour. For claims
  about a particular system, inspect the relevant implementation or documentation.
- Research facts that need checking, especially current or version-specific
  behaviour. Match the investigation to the question; a basic explanation does
  not require a web search by default.
- Separate what the material establishes from inference and unknowns. Code can
  show what happens without revealing why its author chose it. Never invent
  implementation details or motives to make an explanation feel complete.
- Cite consequential claims near the statement they support, using a useful source
  link or code reference. Keep the answer readable without following every link.
- If the source is wrong or misleading, flag the problem and explain the
  correction. Fluent wording must not turn an unsupported claim into a fact.

## Build the smallest complete explanation

- Answer the actual question first. Start with the conclusion, definition, or
  missing connection; omit introductions about how interesting the topic is.
- Name the relevant parts and follow the real sequence or dependency: starting
  state, action or condition, then outcome. Explain the connection and why it
  matters; replacing one label with another is rarely enough.
- Preserve conditions, direction, quantities, units, exceptions, and guarantees.
  Keep distinctions such as "may" versus "must", correlation versus cause, and
  "up to three retries" versus "three total attempts".
- Add depth in layers. A narrow question may need one short paragraph; a complex
  question needs enough detail to connect the steps. Follow the user's requested
  depth without enforcing a word count or a fixed answer template.
- Use headings, lists, or a recap only when they help navigation. End when the
  question is answered.

## Choose words that do useful work

- Prefer familiar, concrete words and direct verbs. Keep one consistent name for
  each thing. Replace vague pronouns when the reader could mistake their subject.
- Keep precise terms the reader needs to recognize in code, documentation, or
  discussion. Define unfamiliar terms briefly where they first matter. Preserve
  identifiers and code exactly when quoting them.
- Expand unfamiliar acronyms when helpful, then explain what the thing does.
  Spelling out the letters alone does not explain the concept.
- Prefer active voice when the actor is known. If it is unknown, say so or use
  passive voice rather than inventing an actor.
- Keep sentences focused and natural, without splitting connected ideas into
  choppy fragments.
- Be friendly through clarity and respect. Avoid cultural idioms and wording such
  as "obviously", "just", or "easy" when it dismisses the reader's difficulty.

## Make it concrete when needed

- Prefer one relevant example from the reader's situation. Show a specific input
  or starting state, what changes, and the observable outcome.
- Use a small code example or diagram when it explains a relationship more clearly
  than prose. Explain the expected result. Keep examples correct and identify
  illustrative snippets when they are not complete, runnable programs.
- Use an analogy only when it is simpler than the actual mechanism. Map the
  relevant parts, state any limit that would change the conclusion, and return to
  the real system. Skip decorative or strained comparisons.
- If the reader is still confused, locate the missing step and change the example
  or level of detail. Repeating the same explanation at greater length rarely
  resolves a different misunderstanding.

## Remove empty prose

- Cut throat-clearing, generic praise, grand claims, vague benefits, and repeated
  conclusions. Replace a claim such as "improves efficiency" with the supported
  change: what uses less time or work, and under what conditions?
- Turn noun-heavy phrases into actions: "perform validation of the input" becomes
  "check the input" when both describe the same operation.
- Keep emphasis and headings proportionate. Remove unnecessary "not X, but Y"
  framing unless the contrast resolves a real misconception.
- Edit for meaning and natural speech. A banned-word list, punctuation rule, or
  AI-detection score is not a substitute for checking what each sentence adds.

## When rewriting

Preserve the original facts, scope, uncertainty, and useful voice. Return the
rewritten text directly; add commentary only when requested or needed to flag a
factual problem. Make the smallest edits that resolve the confusion. Leave
already-clear material alone when further rewriting would add no value.

## Examples

### Explain a concept through its effect

Question: "What does idempotent mean, and why does it matter for retries?"

> Repeating an idempotent operation has the same intended effect as doing it once.
> Setting `enabled = true` twice still leaves it `true`; toggling it twice changes
> it back. This matters after a timeout: repeating an idempotent request preserves
> that intended result, though its response or logs may differ.

### Explain the code without inventing its history

Question: "Why use `??` here, and why 5000?"

```js
const timeoutMs = options.timeoutMs ?? 5000;
```

> `??` supplies the default only when `options.timeoutMs` is `null` or `undefined`,
> so an explicit `0` is kept. The fallback is 5,000 milliseconds, or five seconds.
> This line doesn't establish why that duration was chosen.

### Simplify wording while keeping the limits

Original: "In the event of elevated service load, the client may initiate a maximum
of three retry attempts per unsuccessful request."

> Under heavy service load, the client may retry each failed request up to three times.

## Check silently before sending

- Can the reader now explain the relevant connection or predict an example's outcome?
- Is each unfamiliar term explained or useful to this audience?
- Are the facts, conditions, uncertainty, and guarantees intact and supported?
- Does every sentence add something the reader needs?

Use this check to improve the answer; do not turn it into a quiz for the reader.
The [research notes](references/research.md) explain the sources and the scope of
the ASD-STE100 influence.
