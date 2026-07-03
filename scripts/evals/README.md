# Local AI Eval

This eval checks whether local OpenAI-compatible models are good enough for the
Accounted model-provider contract.

It exercises three fixture groups:

- `smoke`: strict JSON and tool-call contract checks.
- `composer`: real onboarding atom-selection prompt and schema validation.
- `transaction`: real transaction-categorization prompt with local tool schemas.

## What We Are Testing

The goal is to derisk whether a local model on a 48 GB Mac can support the two
AI surfaces we care about before doing more integration work:

- **Provider contract:** can the local OpenAI-compatible endpoint return strict
  structured JSON and OpenAI-style tool calls that Accounted can parse?
- **Composer/onboarding:** can the model follow the real atom-selection prompt,
  choose known atom IDs, avoid forbidden atoms, and avoid re-asking questions
  already answered by company settings or TIC data?
- **Transaction assistant:** can the model use the real transaction
  categorization prompt, preserve the exact `transaction_id`, call only allowed
  tools, choose allowed category enums, and avoid staging when the case requires
  a follow-up question?

This eval is intentionally not measuring receipt extraction, OCR, embeddings, or
end-to-end bookkeeping commits. It only checks whether candidate local models are
good enough for local assistant and composer behavior. Deterministic
classification remains separate and does not require a model.

The most important failure signals are invalid structured output, malformed tool
arguments, hallucinated tool names, wrong transaction IDs, unsafe categorization
of ambiguous cases, and redundant onboarding questions.

## Nix Setup

The local eval profile provisions Node, `tsx`, Ollama, and npm dependencies. It
also starts Ollama if needed:

```bash
nix develop .#local-ai
```

Default candidates:

```bash
qwen2.5:14b qwen2.5:32b llama3.1:8b mistral-nemo:12b
```

Override the candidate list before entering the shell:

```bash
ACCOUNTED_LOCAL_AI_MODELS="qwen2.5:14b qwen2.5:32b" nix develop .#local-ai
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
LOCAL_AI_MODEL=qwen2.5:14b \
npm run eval:local-ai
```

Useful options:

```bash
npm run eval:local-ai -- --models qwen2.5:14b,llama3.1:8b
npm run eval:local-ai -- --groups smoke,transaction
npm run eval:local-ai -- --json
```

The script reports model-quality failures as case failures instead of aborting,
so weak models can still be compared in one run. It exits nonzero for
configuration or runtime failures.
