# Local AI Eval

This eval checks whether local OpenAI-compatible models are good enough for the
Accounted model-provider contract.

It exercises five fixture groups:

- `smoke`: strict JSON and tool-call contract checks.
- `composer`: real onboarding atom-selection prompt and schema validation.
- `assistant`: scenario-based multi-turn chat assistant checks, run in both
  `oracle-context` and `end-to-end` modes.
- `transaction`: real transaction-categorization prompt with local tool schemas.
- `classification`: queued strict-JSON transaction classification decisions.

## What We Are Testing

The goal is to derisk whether a local model on a 48 GB Mac can support the two
AI surfaces we care about before doing more integration work:

- **Provider contract:** can the local OpenAI-compatible endpoint return strict
  structured JSON and OpenAI-style tool calls that Accounted can parse?
- **Composer/onboarding:** can the model follow the real atom-selection prompt,
  choose known atom IDs, avoid forbidden atoms, and avoid re-asking questions
  already answered by company settings or TIC data?
- **Assistant with oracle context:** can the full interactive assistant reason
  from known-correct company context, memories, atom bodies, prompt blocks, tool
  definitions, and tool-result continuations without relying on the composer?
- **End-to-end assistant:** can the complete production pipeline start from the
  user/company fixture, run atom selection, resolve selected atoms through the
  production context builder, and then complete the assistant turn safely?
- **Transaction assistant:** can the model use the real transaction
  categorization prompt, preserve the exact `transaction_id`, call only allowed
  tools, choose allowed category enums, and avoid staging when the case requires
  a follow-up question?
- **Queued classification:** can the model return conservative structured
  decisions for background staging, including `needs_review` for ambiguous
  restaurant/alcohol cases and correct VAT treatment for known cases?

This eval is intentionally not measuring receipt extraction, OCR, embeddings, or
end-to-end bookkeeping commits. It only checks whether candidate local models are
good enough for local assistant and composer behavior. Deterministic
classification remains separate and does not require a model.

The most important failure signals are invalid structured output, malformed tool
arguments, hallucinated tool names, wrong transaction IDs, unsafe categorization
of ambiguous cases, wrong VAT treatment, and redundant onboarding questions.

The `assistant` group is the full interactive chat surface. It uses
`runChatTurn`, `buildSystemPrompt`, production intent definitions, production
tool-loop continuation, fixture-backed atom registry/company context/memories,
and deterministic fixture tools. Each assistant fixture is evaluated twice:

- `oracle-context`: injects the known-correct vertical/modifier atoms into the
  production context builder. This isolates whether the assistant can follow the
  supplied accounting context.
- `end-to-end`: runs the real composer/atom-selection path first, stores the
  selected atoms in the fixture-backed profile, resolves them through the same
  production context builder, then runs the assistant.

The `transaction` group is narrower: it evaluates the transaction-categorization
intent and its local tool boundaries. The `classification` group is separate
again: it evaluates queued noninteractive strict-JSON classification, where
`needs_review` is a valid deterministic outcome for ambiguous inputs. Composer
eligibility is reported on its own because it feeds the end-to-end assistant
path but is also a distinct onboarding surface.

## Nix Setup

The local eval profile provisions Node, `tsx`, Ollama, and npm dependencies. It
also starts Ollama if needed:

```bash
nix develop .#local-ai
```

Default candidates:

```bash
qwen3:32b qwen3:30b gpt-oss:20b mistral-small3.1:24b command-r:35b deepseek-r1:32b
```

Override the candidate list before entering the shell:

```bash
ACCOUNTED_LOCAL_AI_MODELS="qwen3:32b gpt-oss:20b" nix develop .#local-ai
```

Optional heavier candidates for offline runs:

```bash
ACCOUNTED_LOCAL_AI_MODELS="llama3.3:70b hermes3:70b" nix develop .#local-ai
```

Skip npm install or Ollama startup when you already prepared them:

```bash
ACCOUNTED_SKIP_NPM_CI=1 nix develop .#local-ai
ACCOUNTED_LOCAL_AI_SKIP_PREPARE=1 nix develop .#local-ai
```

## Run

Inside the `.#local-ai` shell:

```bash
accounted-local-ai-eval
```

The helper evaluates one model at a time. It pulls the first model before its
eval, then pulls the next model in the background while the current model is
running.

Or run the npm script directly:

```bash
AI_PROVIDER=local \
LOCAL_AI_BASE_URL=http://127.0.0.1:11434/v1 \
LOCAL_AI_MODEL=qwen3:32b \
npm run eval:local-ai
```

Useful options:

```bash
npm run eval:local-ai -- --models qwen3:32b,gpt-oss:20b
npm run eval:local-ai -- --groups assistant
npm run eval:local-ai -- --groups smoke,transaction
npm run eval:local-ai -- --groups classification
npm run eval:local-ai -- --runs 5
npm run eval:local-ai -- --results-dir /tmp/accounted-local-ai-results
npm run eval:local-ai -- --json
```

## Persisted Results

The harness persists JSONL while it runs, so a killed session keeps completed
attempts and the exact case definitions already seen. By default it writes to
`scripts/evals/results/`, which is gitignored:

- `case-manifest.jsonl`: one row per unique content-addressed case definition.
- `attempt-results-<run_id>.jsonl`: one row per completed model attempt.

Each case hash is computed from a canonical preimage containing the effective
prompt/messages, resolved assistant context, selected atoms, tool or
structured-output schema, fixture expectations, variant wording, and
scoring-policy version. For assistant cases, every attempt persists the full
turn transcript, resolved context, selected atoms, tool calls, tool results,
final response, latency, scoring result, and a structured manual-review rubric.
If a fixture name stays the same but the prompt, resolved context, atom
selection, or expected behavior changes, the hash changes. The manifest stores
the preimage the first time the hash is encountered so old results remain
auditable after the TypeScript fixtures evolve.

Use `--no-persist` for stdout-only probing.

The script reports model-quality failures as case failures instead of aborting,
so weak models can still be compared in one run. It exits nonzero for
configuration or runtime failures.
