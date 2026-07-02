// Bedrock model IDs. Region prefix `eu.` keeps inference inside eu-north-1.
// Both are env-overridable so ops can swap models without a code deploy.
//
// The active provider may remap these ids internally. The local provider, for
// example, always uses LOCAL_AI_MODEL because OpenAI-compatible local servers
// cannot be expected to know Bedrock model names.
export const OPUS_MODEL = process.env.BEDROCK_OPUS_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6'
export const SONNET_MODEL = process.env.BEDROCK_SONNET_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6'

// Extended-thinking budgets (budget_tokens) for the chat intents. These are
// ceilings, not floors: the model spends only what a turn needs, so a generous
// cap improves hard turns (multi-source VAT synthesis, anomaly detection)
// without taxing simple ones. The Bedrock provider maps this to Claude's
// thinking config; local providers may ignore it if unsupported.
export const THINKING_BUDGET_STANDARD = 6000
export const THINKING_BUDGET_DEEP = 12000
