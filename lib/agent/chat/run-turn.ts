import type { SupabaseClient } from '@supabase/supabase-js'
import { SONNET_MODEL } from '@/lib/agent/composer/client'
import type { AgentIntent } from '@/lib/agent/intents/types'
import { agentToolRegistry } from '@/lib/agent/tools/registry'
import type { AgentTool, AgentActorContext, StagedOperationResult } from '@/lib/agent/tools/types'
import { isStagedOperation } from '@/lib/agent/tools/types'
import {
  getModelProvider,
  type ModelContentBlock,
  type ModelMessage,
} from '@/lib/agent/model-provider'
import { MalformedModelToolCallError } from '@/lib/agent/model-provider/types'
import { buildSystemPrompt } from './system-prompt'
import { createLogger } from '@/lib/logger'
import { swedishToday } from '@/lib/utils'

const log = createLogger('agent.chat.run-turn')

/**
 * Normalize a model/transport error into a short, friendly Swedish message.
 * Raw AWS Bedrock SDK errors (throttling, timeouts, 5xx) are English and
 * technical; the chat surface renders this verbatim, so keep it human.
 */
export function friendlyModelError(err: unknown): string {
  const status = (err as { status?: number } | null)?.status
  const name = (err as { name?: string } | null)?.name ?? ''
  const raw = err instanceof Error ? err.message : ''
  const text = `${name} ${raw}`.toLowerCase()
  if (
    name === 'AiProviderUnavailableError' ||
    text.includes('ai_provider=none') ||
    text.includes('ai_provider=local') ||
    text.includes('local_only=true')
  ) {
    return 'Assistenten är inte aktiverad i den här installationen.'
  }
  if (
    status === 429 ||
    text.includes('throttl') ||
    text.includes('too many') ||
    text.includes('rate limit') ||
    text.includes('rate exceeded')
  ) {
    return 'Anna är upptagen just nu. Vänta en liten stund och försök igen.'
  }
  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('etimedout') ||
    text.includes('econnreset') ||
    text.includes('network') ||
    text.includes('socket')
  ) {
    return 'Anslutningen till assistenten bröts. Försök igen.'
  }
  if (typeof status === 'number' && status >= 500) {
    return 'Assistenttjänsten har ett tillfälligt fel. Försök igen om en stund.'
  }
  return 'Något gick fel hos assistenten. Försök igen om en stund.'
}

// One turn of the chat loop:
//
//   1. Resolve context (company, profile, ranked memory).
//   2. Resolve the intent's atom + tool set.
//   3. Build system prompt with two cache_control breakpoints.
//   4. Append message history + new user message.
//   5. Stream from Anthropic.
//   6. On tool_use: dispatch via agentToolRegistry → tool_result → continue.
//   7. On staged op: stamp pending_operations.agent_metadata.
//   8. Persist all messages to agent_messages.
//
// Plan refs: §9 (chat loop), §10 (caching), §5 (BFL audit on
// pending_operations.agent_metadata).

export type StreamEvent =
  | { kind: 'text_delta'; delta: string }
  // Extended-thinking reasoning stream. Emitted token-by-token while the model
  // reasons, before it answers or calls a tool. Stream-time only — not
  // persisted, not hydrated on resume.
  | { kind: 'reasoning_delta'; delta: string }
  | { kind: 'tool_use'; tool_use_id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; tool_use_id: string; result: unknown }
  | {
      kind: 'staged_operation'
      tool_use_id: string
      tool_name: string
      staged: StagedOperationResult
    }
  | {
      // The agent successfully wrote a memory mid-conversation (remember_fact
      // or forget_fact). Stream-time only — not persisted. The chat surface
      // renders a discreet "Sparat: …" chip so users know memory happened
      // without having to visit /settings/agent-memory.
      kind: 'memory_captured'
      tool_use_id: string
      action: 'remembered' | 'forgotten'
      memory_id: string
      memory_kind?: 'fact' | 'preference' | 'pattern' | 'correction'
      content?: string
    }
  | { kind: 'turn_complete'; assistant_text: string }
  | { kind: 'error'; message: string }

interface RunTurnArgs {
  supabase: SupabaseClient
  userId: string
  companyId: string
  companyName: string
  firstName: string | null
  intent: AgentIntent
  conversationId: string
  contextRef?: string | null
  userMessage: string
  // Whether to persist this user message + assistant turn to agent_messages.
  // Tests use false to keep the DB untouched.
  persist: boolean
  // True when userMessage was synthesized by /api/agent/invoke from the
  // intent's promptTemplate (i.e. the user didn't type it). The message is
  // still persisted for Anthropic context on subsequent turns, but flagged
  // hidden=true so /chat/[id] hydration doesn't surface it as a user bubble.
  userMessageHidden?: boolean
  // Emit events back to the caller. Returns false if the stream was cancelled
  // and the loop should stop emitting (best-effort).
  emit: (event: StreamEvent) => boolean
}

// Safety net: bound the tool-loop iterations so a misbehaving model can't
// run away forever. Real conversations rarely use more than 5-6 round trips.
const MAX_TOOL_ITERATIONS = 12
const MAX_MALFORMED_TOOL_REPAIRS = 2

// Bound a tool result before it enters the model context. Read tools — above
// all gnubok_get_document_content, which returns full OCR/PDF text — can return
// arbitrarily large payloads. Unbounded, that payload is re-sent on every later
// iteration of this turn's loop AND replayed on every future turn (it is
// persisted as a 'tool' message and rehydrated by loadConversationMessages),
// re-introducing the exact context rot we keep out of the system prompt. We cap
// the serialized result and tell the model how to narrow if it was truncated.
//
// Per Anthropic's tool guidance: truncate with sensible defaults and steer the
// agent to a narrower request; the practical ceiling cited for a single tool
// return is ~25k tokens, so 40k chars (~10k tokens) sits well under that while
// leaving multi-page receipts/invoices intact — only pathological dumps get cut.
export const MAX_TOOL_RESULT_CHARS = 40_000

export function boundToolResultText(raw: string): string {
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return raw
  const head = raw.slice(0, MAX_TOOL_RESULT_CHARS)
  return `${head}\n\n[avkortat: resultatet var ${raw.length} tecken, visar de första ${MAX_TOOL_RESULT_CHARS}. Be om en smalare sökning (limit, datumintervall, specifikt dokument-id eller fält) för att se mer.]`
}

// Wrap a bounded tool-result string in <tool_output> markers before feeding
// it back to the model. Paired with the system-prompt rule that text inside
// <tool_output> is third-party data, never instructions — mitigates the
// prompt-injection surface from OCR'd documents, inbox items, and any
// other tool that returns untrusted vendor/customer text. Closing tag uses a
// distinct strings so a malicious payload containing the literal token can't
// trivially escape; the contained JSON is serialized so embedded `<` chars
// are escaped by JSON.stringify (which they are not — they survive
// stringification) — to defend, we additionally strip the literal close-tag
// sequence from the content.
export function wrapToolResult(toolUseId: string, raw: string): string {
  const safe = raw.replaceAll('</tool_output>', '</tool_​output>') // ZWSP injected
  return `<tool_output id="${toolUseId}">\n${safe}\n</tool_output>`
}

export async function runChatTurn(args: RunTurnArgs): Promise<void> {
  const {
    supabase,
    userId,
    companyId,
    companyName,
    firstName,
    intent,
    conversationId,
    contextRef,
    userMessage,
    persist,
    userMessageHidden,
    emit,
  } = args

  // 1 + 2 — load profile + ranked memory + atoms + tools.
  const [profile, memory, vatStatus] = await Promise.all([
    loadProfileSummary(supabase, companyId),
    loadRankedMemory(supabase, companyId, 30),
    loadVatStatus(supabase, companyId),
  ])

  const systemPrompt = await buildSystemPrompt({
    intent,
    companyId,
    companyName,
    firstName,
    profileSummary: profile,
    rankedMemory: memory,
    vatStatus,
    today: swedishToday(),
    supabase,
  })

  const tools = await collectIntentTools(intent)
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))

  // 3 — assemble provider-neutral messages: prior history + new user turn.
  const history = await loadConversationMessages(supabase, conversationId)
  const newUserMessage: ModelMessage = {
    role: 'user',
    content: [{ kind: 'text', text: userMessage }],
  }

  if (persist) {
    await persistMessage(
      supabase,
      conversationId,
      'user',
      userMessage,
      userMessageHidden === true,
    )
  }

  const messages: ModelMessage[] = [
    ...history,
    newUserMessage,
  ]
  const expectedTransactionId = expectedTransactionIdForIntent(intent, contextRef, messages)

  const actor: AgentActorContext = {
    type: 'agent_chat',
    id: conversationId,
    label: 'In-app chat',
  }

  const provider = getModelProvider()
  const model = intent.model || SONNET_MODEL

  let assistantText = ''
  let iterations = 0
  let malformedToolRepairAttempts = 0

  // Extended thinking ("tänka längre"): when the intent opts in, every model
  // call in the loop gets a reasoning channel so the agent reasons BEFORE it
  // answers or commits to a tool, instead of narrating its steps in the
  // visible reply. budget_tokens must be ≥ 1024 and strictly below max_tokens,
  // so the normal 4096 output budget is added on top. The reasoning streams to
  // the client as reasoning_delta and renders in a collapsible "Tänkte…" block.
  const maxTokens = (intent.thinking?.budgetTokens ?? 0) + 4096

  // 4 + 5 + 6 — iterate until the model stops requesting tools.
  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++

    // Track which tool_call ids have already been announced to the client so
    // the dispatch loop below doesn't re-emit them.
    const eagerToolIds = new Set<string>()
    let response
    try {
      response = await provider.streamWithTools({
        model,
        maxTokens,
        system: systemPrompt.blocks,
        messages,
        tools,
        thinkingBudgetTokens: intent.thinking?.budgetTokens,
        onEvent: (event) => {
          if (event.kind === 'text_delta') {
            assistantText += event.delta
            emit({ kind: 'text_delta', delta: event.delta })
          } else if (event.kind === 'reasoning_delta') {
            emit({ kind: 'reasoning_delta', delta: event.delta })
          } else if (event.kind === 'tool_call') {
            eagerToolIds.add(event.id)
            emit({
              kind: 'tool_use',
              tool_use_id: event.id,
              name: event.name,
              input: event.input,
            })
          }
        },
      })
    } catch (err) {
      if (
        err instanceof MalformedModelToolCallError &&
        malformedToolRepairAttempts < MAX_MALFORMED_TOOL_REPAIRS
      ) {
        malformedToolRepairAttempts++
        messages.push({
          role: 'user',
          content: [
            {
              kind: 'text',
              text: buildToolCallRepairPrompt(err, malformedToolRepairAttempts),
            },
          ],
        })
        continue
      }
      if (err instanceof MalformedModelToolCallError) {
        const message = manualReviewMessage()
        assistantText += message
        emit({ kind: 'text_delta', delta: message })
        if (persist) {
          await persistMessage(supabase, conversationId, 'assistant', message)
        }
        break
      }
      // Surface as a chat error so the UI clears its streaming state. Re-throw
      // to let the route's outer try/catch persist the failure if needed.
      // Normalize Bedrock throttling/timeout/5xx into a friendly Swedish line.
      log.error('Model stream failed', err, {
        conversationId,
        companyId,
        model,
        provider: provider.name,
        iterations,
      })
      emit({ kind: 'error', message: friendlyModelError(err) })
      throw err
    }

    const assistantContent = response.content

    // Persist the assistant turn (text + tool_call blocks). Reasoning blocks are
    // stripped for storage but kept in `messages` below for the in-turn loop.
    if (persist) {
      await persistMessage(supabase, conversationId, 'assistant', stripReasoning(assistantContent))
    }
    messages.push({ role: 'assistant', content: assistantContent })

    // If the model didn't request any tool, we're done.
    const toolCalls = assistantContent.filter(
      (b): b is Extract<ModelContentBlock, { kind: 'tool_call' }> => b.kind === 'tool_call',
    )
    if (toolCalls.length === 0 || response.stopReason !== 'tool_call') {
      break
    }

    // 7 — dispatch each tool call sequentially. Providers accept parallel
    // tool results within a single user turn, so we collect them and emit
    // one combined user message.
    const toolResultBlocks: ModelContentBlock[] = []
    for (const tu of toolCalls) {
      // The chip was already announced via the streamEvent listener above;
      // skip re-emitting unless we missed the early signal (defensive — the
      // dispatch loop should never run faster than the stream events).
      if (!eagerToolIds.has(tu.id)) {
        emit({
          kind: 'tool_use',
          tool_use_id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
        })
      }

      const tool = toolsByName.get(tu.name)
      if (!tool) {
        const content = `Verktyget ${tu.name} är inte tillåtet för intent ${intent.id}. Använd bara verktygen i tools-parametern.`
        emit({
          kind: 'tool_result',
          tool_use_id: tu.id,
          result: { error: content },
        })
        toolResultBlocks.push(toolErrorBlock(tu.id, content))
        continue
      }

      const validation = validateToolCall(tu, tool, intent, expectedTransactionId)
      if (!validation.ok) {
        emit({
          kind: 'tool_result',
          tool_use_id: tu.id,
          result: { error: validation.message },
        })
        toolResultBlocks.push(toolErrorBlock(tu.id, validation.message))
        continue
      }

      try {
        const result = await tool.execute(
          validation.input,
          companyId,
          userId,
          supabase,
          actor,
        )

        // If the tool staged a pending_operation, stamp the agent metadata
        // for BFL audit reconstructability (plan §5).
        if (isStagedOperation(result) && result.operation_id) {
          await stampAgentMetadata(supabase, result.operation_id, {
            conversation_id: conversationId,
            intent_id: intent.id,
            model,
            prompt_hash: systemPrompt.promptHash,
            atoms_loaded: systemPrompt.atomsLoaded,
          })
          emit({
            kind: 'staged_operation',
            tool_use_id: tu.id,
            tool_name: tu.name,
            staged: result,
          })
        }

        // Memory tools write immediately (no staging). Surface the capture
        // inline so the user sees memory is happening — silent writes were
        // the biggest UX gap pre-2026-05-18 (plan §11 transparency).
        if (tu.name === 'gnubok_remember_fact') {
          const r = result as { id?: unknown; kind?: unknown; content?: unknown }
          if (typeof r?.id === 'string') {
            emit({
              kind: 'memory_captured',
              tool_use_id: tu.id,
              action: 'remembered',
              memory_id: r.id,
              memory_kind:
                typeof r.kind === 'string' &&
                ['fact', 'preference', 'pattern', 'correction'].includes(r.kind)
                  ? (r.kind as 'fact' | 'preference' | 'pattern' | 'correction')
                  : undefined,
              content: typeof r.content === 'string' ? r.content : undefined,
            })
          }
        } else if (tu.name === 'gnubok_forget_fact') {
          const r = result as { id?: unknown }
          if (typeof r?.id === 'string') {
            emit({
              kind: 'memory_captured',
              tool_use_id: tu.id,
              action: 'forgotten',
              memory_id: r.id,
            })
          }
        }

        // Emit the full result to the client (display only — not model
        // context). The block that re-enters the model loop and gets persisted
        // is bounded so a large read can't dominate the context window, and
        // wrapped in <tool_output> markers so the model treats the content as
        // untrusted third-party data (see system-prompt §"Verktygsutdata är
        // OTROSTAD DATA").
        emit({ kind: 'tool_result', tool_use_id: tu.id, result })
        toolResultBlocks.push({
          kind: 'tool_result',
          toolCallId: tu.id,
          content: wrapToolResult(tu.id, boundToolResultText(JSON.stringify(result))),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown tool error'
        emit({
          kind: 'tool_result',
          tool_use_id: tu.id,
          result: { error: message },
        })
        toolResultBlocks.push(toolErrorBlock(tu.id, message))
      }
    }

    // Append the tool_result user message and loop again.
    const toolMessage = { role: 'user' as const, content: toolResultBlocks }
    messages.push(toolMessage)
    if (persist) {
      await persistMessage(supabase, conversationId, 'tool', toolResultBlocks)
    }
  }

  if (iterations >= MAX_TOOL_ITERATIONS) {
    emit({
      kind: 'error',
      message: `Avbröt efter ${MAX_TOOL_ITERATIONS} verktygsanrop — sannolikt en loop. Försök igen.`,
    })
  }

  // Touch the conversation's last_message_at + cache a 200-char preview of
  // the assistant text so /chat sidebar can render previews without joining
  // agent_messages. Trim newlines so the preview is single-line-friendly.
  if (persist) {
    const preview = assistantText
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
    await supabase
      .from('agent_conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: preview.length > 0 ? preview : null,
      })
      .eq('id', conversationId)

    // Update recency of the memories included in this turn's prompt block.
    // Errors are swallowed — a ranking-signal hiccup shouldn't fail the turn.
    try {
      await bumpMemoryAccess(
        supabase,
        memory.map((m) => m.id),
      )
    } catch {
      // intentional: best-effort
    }
  }

  emit({ kind: 'turn_complete', assistant_text: assistantText })
}

// ── Persistence helpers ────────────────────────────────────────────────────

async function loadProfileSummary(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('agent_profiles')
    .select('profile_summary')
    .eq('company_id', companyId)
    .maybeSingle()
  return (data?.profile_summary as string | null) ?? null
}

// Hard-fact VAT status the agent must cite before any moms recommendation.
// Lives on company_settings.vat_registered + vat_number — the single source of
// truth. Agent has historically guessed this from the conversation ("eftersom
// du inte är momsregistrerad…") instead of reading the company profile;
// surfacing it as a structured fact in the prompt removes the temptation.
async function loadVatStatus(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ vat_registered: boolean; vat_number: string | null } | null> {
  try {
    const { data } = await supabase
      .from('company_settings')
      .select('vat_registered, vat_number')
      .eq('company_id', companyId)
      .maybeSingle()
    if (!data) return null
    return {
      vat_registered: Boolean(data.vat_registered),
      vat_number: (data.vat_number as string | null) ?? null,
    }
  } catch {
    return null
  }
}

async function loadRankedMemory(
  supabase: SupabaseClient,
  companyId: string,
  cap: number,
): Promise<{ id: string; content: string; kind: string }[]> {
  const { data } = await supabase
    .from('agent_memory')
    .select('id, content, kind, relevance_score, last_accessed_at, is_pinned')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('is_pinned', { ascending: false })
    .order('relevance_score', { ascending: false })
    .order('last_accessed_at', { ascending: false, nullsFirst: false })
    .limit(cap)
  return (data ?? []).map((r: { id: string; content: string; kind: string }) => ({
    id: r.id,
    content: r.content,
    kind: r.kind,
  }))
}

// Bump last_accessed_at for the memories that participated in this turn.
// Plan §11 ranking is "recency-weighted relevance": the column was being
// read for ordering but never written, so the recency signal was dead.
// Writing here keeps memories the agent actually uses fresh at the top.
// Awaited before turn_complete so the update isn't dropped when the handler
// finalizes on Vercel.
async function bumpMemoryAccess(
  supabase: SupabaseClient,
  memoryIds: string[],
): Promise<void> {
  if (memoryIds.length === 0) return
  await supabase
    .from('agent_memory')
    .update({ last_accessed_at: new Date().toISOString() })
    .in('id', memoryIds)
}

async function loadConversationMessages(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<ModelMessage[]> {
  const { data } = await supabase
    .from('agent_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  // role='tool' messages were written as user messages on the Anthropic side.
  return (data ?? []).map((m: { role: string; content: unknown }) => {
    if (m.role === 'assistant') {
      return { role: 'assistant', content: normalizeModelContent(m.content) }
    }
    return { role: 'user', content: normalizeModelContent(m.content) }
  })
}

async function persistMessage(
  supabase: SupabaseClient,
  conversationId: string,
  role: 'user' | 'assistant' | 'tool',
  content: unknown,
  hidden: boolean = false,
): Promise<void> {
  // For text-only user/assistant messages we store a provider-neutral content
  // array. loadConversationMessages also understands legacy Anthropic-shaped
  // rows for existing conversations.
  await supabase.from('agent_messages').insert({
    conversation_id: conversationId,
    role,
    content: typeof content === 'string' ? [{ kind: 'text', text: content }] : content,
    hidden,
  })
}

async function stampAgentMetadata(
  supabase: SupabaseClient,
  operationId: string,
  meta: {
    conversation_id: string
    intent_id: string
    model: string
    prompt_hash: string
    atoms_loaded: string[]
  },
): Promise<void> {
  await supabase
    .from('pending_operations')
    .update({ agent_metadata: meta })
    .eq('id', operationId)
}

// ── Tool helpers ───────────────────────────────────────────────────────────

async function collectIntentTools(intent: AgentIntent): Promise<AgentTool[]> {
  return agentToolRegistry.getMany(intent.tools)
}

function toolErrorBlock(toolCallId: string, message: string): ModelContentBlock {
  return {
    kind: 'tool_result',
    toolCallId,
    isError: true,
    content: wrapToolResult(toolCallId, boundToolResultText(JSON.stringify({ error: message }))),
  }
}

function buildToolCallRepairPrompt(err: MalformedModelToolCallError, attempt: number): string {
  return [
    'Ditt senaste verktygsanrop hade ogiltig JSON i arguments och kunde inte köras.',
    `Fel: ${err.message}`,
    `Reparationsförsök ${attempt}/${MAX_MALFORMED_TOOL_REPAIRS}.`,
    'Svara nu med antingen ett kort vanligt svar eller exakt ett verktygsanrop med strikt giltig JSON.',
    'Regler: inga kommentarer i JSON, inga markdown-block, dubbla citattecken runt alla strängar, bara fält som finns i verktygets schema, och category/vat_treatment måste vara exakta enum-värden.',
  ].join('\n')
}

function manualReviewMessage(): string {
  return 'Jag kan inte tolka modellens verktygsanrop säkert. Den här behöver manuell granskning.'
}

function validateToolCall(
  toolCall: Extract<ModelContentBlock, { kind: 'tool_call' }>,
  tool: AgentTool,
  intent: AgentIntent,
  expectedTransactionId: string | null,
): { ok: true; input: Record<string, unknown> } | { ok: false; message: string } {
  if (!isRecord(toolCall.input)) {
    return { ok: false, message: `Verktyget ${tool.name} kräver ett JSON-objekt som input.` }
  }

  const schemaError = validateJsonSchemaObject(toolCall.input, tool.inputSchema, tool.name)
  if (schemaError) return { ok: false, message: schemaError }

  if (intent.id === 'transaction.categorization') {
    const txId = toolCall.input.transaction_id
    if (typeof txId === 'string' && expectedTransactionId && txId !== expectedTransactionId) {
      return {
        ok: false,
        message:
          `Fel transaction_id för ${tool.name}: fick ${txId}, men den här konversationen gäller ${expectedTransactionId}. ` +
          'Använd bara transaktionen som öppnades i hjälpfönstret.',
      }
    }
  }

  return { ok: true, input: toolCall.input }
}

function validateJsonSchemaObject(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
  toolName: string,
): string | null {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : []
  const hasUsefulShape = Object.keys(properties).length > 0 || required.length > 0
  if (!hasUsefulShape) return null

  if (schema.type && schema.type !== 'object') {
    return `Verktyget ${toolName} har ett ogiltigt server-schema: root måste vara object.`
  }

  for (const key of required) {
    if (!(key in input)) return `Ogiltigt anrop till ${toolName}: saknar obligatoriskt fält "${key}".`
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties))
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        return `Ogiltigt anrop till ${toolName}: fältet "${key}" finns inte i verktygets schema.`
      }
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const propertySchema = properties[key]
    if (!isRecord(propertySchema)) continue
    const error = validateJsonSchemaValue(value, propertySchema, `${toolName}.${key}`)
    if (error) return error
  }

  return null
}

function validateJsonSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `Ogiltigt värde för ${path}: "${String(value)}" finns inte i enum-listan.`
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const ok = types.some((type) => jsonTypeMatches(value, type))
    if (!ok) return `Ogiltig typ för ${path}: väntade ${types.join(' eller ')}.`
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `Ogiltigt värde för ${path}: måste vara minst ${schema.minimum}.`
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return `Ogiltigt värde för ${path}: måste vara större än ${schema.exclusiveMinimum}.`
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `Ogiltigt värde för ${path}: måste vara högst ${schema.maximum}.`
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return `Ogiltigt värde för ${path}: texten är för kort.`
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return `Ogiltigt värde för ${path}: texten är för lång.`
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const error = validateJsonSchemaValue(value[i], schema.items, `${path}[${i}]`)
      if (error) return error
    }
  }

  if (isRecord(value) && isRecord(schema.properties)) {
    return validateJsonSchemaObject(value, schema, path)
  }

  return null
}

function jsonTypeMatches(value: unknown, type: unknown): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isRecord(value)
  if (type === 'null') return value === null
  return true
}

function expectedTransactionIdForIntent(
  intent: AgentIntent,
  contextRef: string | null | undefined,
  messages: ModelMessage[],
): string | null {
  if (intent.id !== 'transaction.categorization') return null
  if (contextRef?.startsWith('transaction:')) {
    const txId = contextRef.slice('transaction:'.length).trim()
    if (txId) return txId
  }

  for (const message of messages) {
    for (const block of message.content) {
      if (block.kind !== 'text') continue
      const match = block.text.match(/\btransaction_id:\s*([0-9A-Za-z_-]+)/)
      if (match?.[1]) return match[1]
    }
  }
  return null
}

// Reasoning blocks stay in the in-memory `messages` array when a provider
// requires that for tool-result continuation, but we strip them before
// persistence: they hold raw reasoning, and replaying past-turn reasoning on
// resume is neither required nor shown. The chat surface shows reasoning live
// via reasoning_delta; it is not hydrated.
export function stripReasoning(content: ModelContentBlock[]): ModelContentBlock[] {
  if (!Array.isArray(content)) return content
  return content.filter(
    (b) => b?.kind !== 'reasoning' && b?.kind !== 'redacted_reasoning',
  )
}

export const stripThinking = stripReasoning

function normalizeModelContent(content: unknown): ModelContentBlock[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => normalizeModelContentBlock(block))
}

function normalizeModelContentBlock(block: unknown): ModelContentBlock[] {
  const b = block as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return []

  if (b.kind === 'text' && typeof b.text === 'string') return [{ kind: 'text', text: b.text }]
  if (b.kind === 'tool_call' && typeof b.id === 'string' && typeof b.name === 'string') {
    return [
      {
        kind: 'tool_call',
        id: b.id,
        name: b.name,
        input: isRecord(b.input) ? b.input : {},
      },
    ]
  }
  if (b.kind === 'tool_result' && typeof b.toolCallId === 'string') {
    return [
      {
        kind: 'tool_result',
        toolCallId: b.toolCallId,
        content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
        isError: b.isError === true,
      },
    ]
  }
  if (b.kind === 'reasoning') {
    return [
      {
        kind: 'reasoning',
        text: typeof b.text === 'string' ? b.text : '',
        providerMetadata: b.providerMetadata,
      },
    ]
  }
  if (b.kind === 'redacted_reasoning') {
    return [{ kind: 'redacted_reasoning', providerMetadata: b.providerMetadata }]
  }

  // Backward compatibility for persisted Anthropic-shaped content.
  if (b.type === 'text' && typeof b.text === 'string') return [{ kind: 'text', text: b.text }]
  if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
    return [
      {
        kind: 'tool_call',
        id: b.id,
        name: b.name,
        input: isRecord(b.input) ? b.input : {},
      },
    ]
  }
  if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
    return [
      {
        kind: 'tool_result',
        toolCallId: b.tool_use_id,
        content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
        isError: b.is_error === true,
      },
    ]
  }
  if (b.type === 'thinking') {
    return [
      {
        kind: 'reasoning',
        text: typeof b.thinking === 'string' ? b.thinking : '',
        providerMetadata: b,
      },
    ]
  }
  if (b.type === 'redacted_thinking') {
    return [{ kind: 'redacted_reasoning', providerMetadata: b }]
  }
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
