/**
 * dsh-telegram-control — remote control for DeepSeek Harness over Telegram.
 *
 * A Cordis function plugin that runs a long-polling Telegram bot inside the
 * harness process. Authorized chats can inspect the harness (`/status`,
 * `/agents`, `/jobs`), select and drive an agent (`/agent`, `/cancel`, plain
 * text as a follow-up), kill background jobs (`/kill`), and opt into a live
 * activity feed (`/watch` / `/unwatch`). Agent replies are relayed back to the
 * requesting chat when the agent's turn settles.
 *
 * All outbound text is HTML-escaped before it reaches Telegram.
 *
 * @module dsh-telegram-control
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type AssistantMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset, type AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import {
  TelegramApiError,
  TelegramClient,
  type BotCommand,
  type TelegramCallbackQuery,
  type TelegramUpdate,
} from './client.ts'
import { escapeHtml, homeShorten, parseApprovalCallback, parseBotCommand, parseQuestionCallback, renderUptime, splitMessage, trimReasoning } from './format.ts'

export const name = 'telegram-control'
export const inject = ['agents', 'sessions']

const DEFAULT_API_BASE = 'https://api.telegram.org'
const DEFAULT_REPLY_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_POLL_TIMEOUT_SEC = 50
const DEFAULT_REASONING_MAX_CHARS = 300
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_MESSAGE_CHARS = 4000
const MAX_BACKOFF_MS = 30_000

/** The bot's command menu, published via `setMyCommands` so the input field
 * offers the plugin's commands without typing the leading slash by hand. */
const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'help', description: '命令列表' },
  { command: 'status', description: 'harness 状态' },
  { command: 'agents', description: '列出会话' },
  { command: 'agent', description: '选择会话' },
  { command: 'jobs', description: '后台任务' },
  { command: 'kill', description: '停止任务' },
  { command: 'cancel', description: '取消回合' },
  { command: 'watch', description: '开启实时转发' },
  { command: 'unwatch', description: '关闭实时转发' },
  { command: 'chatid', description: '查看 chat id' },
]

/** Plugin config. Every field is optional in yml; token and allowlist fall back to environment. */
export interface Config {
  /** Telegram bot token; falls back to `$DSH_TELEGRAM_TOKEN`. */
  token?: string
  /** Authorized Telegram chat ids; falls back to `$DSH_TELEGRAM_ALLOWED_CHATS` (comma-separated). */
  allowedChatIds?: number[]
  /** Telegram Bot API base; defaults to the public endpoint. Overridable for tests and proxies. */
  apiBase?: string
  /** Optional agent session id plain messages target when a chat has no `/agent` selection. */
  defaultAgentId?: string
  /** Long-poll `getUpdates` timeout in seconds (Telegram accepts up to 50). */
  pollTimeoutSec?: number
  /** Max wait for an agent reply before flushing partial output with a note. */
  replyTimeoutMs?: number
  /** Emit one-line `tool/call` notices to the requesting chat while a reply is pending. */
  showToolCalls?: boolean
  /** Max characters of the agent's reasoning relayed per reply (0 disables thinking). */
  reasoningMaxChars?: number
  /** Max wait for a Telegram button answer to an approval request before it is cancelled. */
  approvalTimeoutMs?: number
  /** Per-message character cap before Telegram-side splitting (Telegram's own limit is 4096). */
  maxMessageChars?: number
}

export const Config: z<Config> = z.object({
  token: z.string(),
  allowedChatIds: z.array(z.number()),
  apiBase: z.string(),
  defaultAgentId: z.string(),
  pollTimeoutSec: z.number().step(1).min(1).max(50),
  replyTimeoutMs: z.number().step(1).min(1000),
  showToolCalls: z.boolean(),
  reasoningMaxChars: z.number().step(1).min(0),
  approvalTimeoutMs: z.number().step(1).min(1000),
  maxMessageChars: z.number().step(1).min(200).max(4096),
})

/** Per-chat plugin state. */
interface ChatState {
  /** The agent session id this chat selected with `/agent`, if any. */
  agentId: string | undefined
  /** Whether live agent activity is forwarded to this chat. */
  watching: boolean
}

/** One in-flight agent reply being accumulated for a chat. */
interface PendingReply {
  chatId: number
  buffer: string[]
  startedAt: number
  /** The exact follow-up message, so `agent/inbox/claimed` can own this entry's turn. */
  messageId: MessageId
  /** The turn the follow-up was claimed into, set when the agent claims it. */
  turn: number | undefined
  timeoutDispose: () => void
}

/** One conversation the plugin can drive: a live agent or a persisted session. */
interface ConversationEntry {
  sessionId: SessionId
  /** The live agent when this conversation is active in this process. */
  agent: Agent | undefined
  /** The session's working directory, when recorded. */
  cwd: string | undefined
  /** Creation time in epoch ms, for recency ordering. */
  createdAt: number
}

/** One Telegram-forwarded approval request awaiting a button press. */
interface PendingApproval {
  /** Settles the `approval/request` waterfall with the button outcome. */
  resolve: (outcome: ApprovalOutcome) => void
  /** The original message text, so the outcome can be edited back in. */
  text: string
  /** The chats and message ids the request was forwarded to. */
  sent: { chatId: number; messageId: number }[]
  /** Clears the pending timer. */
  timeoutDispose: () => void
}

/** One Telegram-forwarded user question awaiting a button press. */
interface PendingQuestion {
  /** Settles the wrapped `userQuestions.ask` with the chosen option. */
  resolve: (answer: AskUserQuestionAnswer) => void
  /** The original message text, so the answer can be edited back in. */
  text: string
  /** The chats and message ids the question was forwarded to. */
  sent: { chatId: number; messageId: number }[]
  /** The question's options, for mapping a button press to its label. */
  items: { id: string; label: string }[]
  /** Clears the pending timer. */
  timeoutDispose: () => void
}

/** Parse the comma-separated `DSH_TELEGRAM_ALLOWED_CHATS` environment value. */
function parseChatIdsEnv(): number[] {
  const raw = process.env.DSH_TELEGRAM_ALLOWED_CHATS
  if (raw === undefined || raw === '') return []
  return raw
    .split(',')
    .map(part => Number(part.trim()))
    .filter(value => Number.isSafeInteger(value) && value !== 0)
}

/** Render an arbitrary thrown value without trusting its string coercion. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return '<unprintable error>'
  }
}

/** Extract the visible text and trimmed thinking blocks of an assistant message. */
function assistantText(message: AssistantMessage, reasoningMaxChars: number): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'reasoning') {
      const trimmed = trimReasoning(block.text, reasoningMaxChars)
      if (trimmed !== '') parts.push(`💭 ${trimmed}`)
    }
  }
  return parts.join('\n\n')
}

/** A sleep that resolves early when the abort signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export function apply(ctx: Context, config: Config): void {
  const token = config.token !== undefined && config.token !== ''
    ? config.token
    : process.env.DSH_TELEGRAM_TOKEN
  if (token === undefined || token === '') {
    throw new Error('telegram-control: no bot token — set config.token or DSH_TELEGRAM_TOKEN')
  }
  // schemastery validates a missing array field to `[]`, so an explicit empty
  // array and an absent one both mean "resolve from the environment".
  const allowedChatIds = config.allowedChatIds !== undefined && config.allowedChatIds.length > 0
    ? config.allowedChatIds
    : parseChatIdsEnv()
  const apiBase = config.apiBase ?? DEFAULT_API_BASE
  const defaultAgentId = config.defaultAgentId ?? ''
  const pollTimeoutSec = config.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC
  const replyTimeoutMs = config.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS
  const showToolCalls = config.showToolCalls ?? false
  const reasoningMaxChars = config.reasoningMaxChars ?? DEFAULT_REASONING_MAX_CHARS
  const approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  const maxMessageChars = config.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS

  const client = new TelegramClient(token, apiBase)
  const chats = new Map<number, ChatState>()
  const pendingBySession = new Map<SessionId, Map<number, PendingReply>>()
  const abort = new AbortController()

  // Resolve the Harness home through the launcher-provided accessor when
  // present, then the environment, then the platform default.
  const homePath = (): string => {
    const provided = ctx.get('dshHomePath')
    if (typeof provided === 'function') return provided()
    return process.env.DSH_HOME ?? join(homedir(), '.dsh')
  }

  // Per-chat agent selections persist across harness restarts so a chat keeps
  // talking to the same agent.
  const stateFile = join(homePath(), 'telegram-control-state.json')
  const chatSelections: Record<string, string> = {}
  try {
    if (existsSync(stateFile)) {
      Object.assign(chatSelections, JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, string>)
    }
  } catch (error) {
    ctx.logger.warn(`telegram-control: cannot read ${stateFile}: ${describeError(error)}`)
  }

  // Human-readable agent names: the latest `session/title` event per session.
  // The map is a cache: seeding covers sessions live at mount, `session/created`
  // covers later appearances, and the conversation helpers re-fold the log as a
  // fallback, so a session whose title predates this plugin is still named.
  const titles = new Map<SessionId, string>()
  const seedTitle = (session: Session): void => {
    const snapshot = foldSessionTitle(session.events)
    if (snapshot !== undefined) titles.set(session.id, snapshot.title)
  }
  for (const session of ctx.sessions.list()) seedTitle(session)

  ctx.effect(() => () => abort.abort())

  // Approval requests awaiting a Telegram button press, keyed by the random
  // token embedded in the button callback_data.
  const pendingApprovals = new Map<string, PendingApproval>()
  ctx.effect(() => () => {
    for (const entry of pendingApprovals.values()) {
      entry.timeoutDispose()
      entry.resolve('cancelled')
    }
    pendingApprovals.clear()
  })

  // User questions forwarded to Telegram; settled by a button press or by the
  // wrapped `ask` falling through to the Web dialog's answer.
  const pendingQuestions = new Map<string, PendingQuestion>()
  const disposePendingQuestions = (): void => {
    for (const entry of pendingQuestions.values()) entry.timeoutDispose()
    pendingQuestions.clear()
  }
  ctx.effect(() => disposePendingQuestions)

  // User questions flow through a SINGLE UI provider, and the Web UI owns that
  // seat. Instead of fighting for it, wrap `userQuestions.ask` — deferred until
  // the service exists, because it may mount after this plugin — so every
  // question is also surfaced in Telegram with option buttons; the first answer
  // (a Telegram button or the Web dialog) wins.
  ctx.inject(['userQuestions'], (scope) => {
    if (allowedChatIds.length === 0) return
    const questionService = scope.userQuestions as unknown as {
      ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>
    }
    const originalAsk = questionService.ask.bind(questionService)
    questionService.ask = (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
      if (request.questions.length === 0) return originalAsk(request)
      const web = Promise.resolve(originalAsk(request))
      const { promise, resolve, reject } = Promise.withResolvers<AskUserQuestionAnswer>()
      let settled = false
      const settle = (answer: AskUserQuestionAnswer): void => {
        if (settled) return
        settled = true
        disposePendingQuestions()
        resolve(answer)
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        disposePendingQuestions()
        reject(error)
      }
      void web.then(settle, fail)
      void forwardQuestions(request, settle).catch((error: unknown) => {
        ctx.logger.warn(`telegram-control: question forwarding failed: ${describeError(error)}`)
      })
      return promise
    }
  })

  const logWarn = (error: unknown): void => {
    ctx.logger.warn(`telegram-control: ${describeError(error)}`)
  }

  const jobsService = (): JobRegistry | undefined => ctx.get('jobs') as JobRegistry | undefined
  const persistence = (): SessionPersistence | undefined => ctx.get('sessionPersistence') as SessionPersistence | undefined
  const presetsService = (): AgentPresets | undefined => ctx.get('agentPresets') as AgentPresets | undefined
  const defaultModel = (): AgentDefaultModelConfig | undefined => ctx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined

  /** Shorten a session id for display when it has no title. */
  function shortSessionId(id: SessionId): string {
    return id.length > 18 ? `${id.slice(0, 15)}…` : id
  }

  /** Resolve one persisted session's title from its stored log, cached per session. */
  const storedTitles = new Map<SessionId, string>()
  async function storedTitle(sessionId: SessionId): Promise<string | undefined> {
    const cached = storedTitles.get(sessionId)
    if (cached !== undefined) return cached
    const service = persistence()
    if (service === undefined) return undefined
    try {
      const inspected = await service.inspect(sessionId)
      const snapshot = foldSessionTitle(inspected.events)
      if (snapshot !== undefined) {
        storedTitles.set(sessionId, snapshot.title)
        return snapshot.title
      }
    } catch (error) {
      ctx.logger.warn(`telegram-control: reading title for ${sessionId} failed: ${describeError(error)}`)
    }
    return undefined
  }

  /** All conversations: live agents plus persisted sessions, most recent first. */
  async function listConversations(): Promise<ConversationEntry[]> {
    const agents = ctx.agents.list()
    const entries: ConversationEntry[] = agents.map(agent => ({
      sessionId: agent.session.id,
      agent,
      cwd: agent.session.header.cwd,
      createdAt: agent.session.header.createdAt,
    }))
    const service = persistence()
    if (service !== undefined) {
      try {
        const stored = await service.list()
        const liveIds = new Set(agents.map(agent => agent.session.id))
        for (const header of stored) {
          // Subagent children are work products, not conversations.
          if (header.origin === 'subagent') continue
          if (liveIds.has(header.id)) continue
          entries.push({ sessionId: header.id, agent: undefined, cwd: header.cwd, createdAt: header.createdAt })
        }
      } catch (error) {
        ctx.logger.warn(`telegram-control: listing persisted sessions failed: ${describeError(error)}`)
      }
    }
    entries.sort((a, b) => b.createdAt - a.createdAt)
    return entries
  }

  /** The title of a conversation entry, live-folded or read from storage. */
  async function conversationTitle(entry: ConversationEntry): Promise<string | undefined> {
    if (entry.agent !== undefined) {
      return titles.get(entry.sessionId) ?? foldSessionTitle(entry.agent.session.events)?.title
    }
    return storedTitle(entry.sessionId)
  }

  /** Bring a conversation live, resuming a persisted session exactly like the Web UI does. */
  async function ensureLiveAgent(sessionId: SessionId): Promise<Agent | undefined> {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const service = persistence()
    if (service === undefined) return undefined
    try {
      const presets = presetsService()
      let presetId: string | undefined
      if (presets !== undefined) {
        try {
          const inspected = await service.inspect(sessionId)
          presetId = resolveSessionPreset({ header: inspected.meta, events: inspected.events })
        } catch (error) {
          ctx.logger.warn(`telegram-control: preset resolution for ${sessionId} failed: ${describeError(error)}`)
        }
      }
      const selection = defaultModel()?.currentSelection() ?? {}
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: selection,
        setup: async (agentCtx) => {
          // Mount the session's recorded preset, or the deployment default
          // when none is recorded — exactly like the Web UI's cold resume.
          if (presets !== undefined) {
            await presets.mount(agentCtx, (await presets.resolve(presetId)).id)
          }
        },
      })
      return handle.agent
    } catch (error) {
      // A concurrent resume from the Web UI may have won the identity race.
      const winner = ctx.agents.get(sessionId)
      if (winner !== undefined) return winner
      ctx.logger.warn(`telegram-control: resuming ${sessionId} failed: ${describeError(error)}`)
      return undefined
    }
  }

  /** Look up a chat's state, creating it on first contact with the persisted selection. */
  function ensureChat(chatId: number): ChatState {
    let state = chats.get(chatId)
    if (state === undefined) {
      state = { agentId: chatSelections[String(chatId)] ?? undefined, watching: false }
      chats.set(chatId, state)
    }
    return state
  }

  /** The display name of an agent: its session title, or a short id when untitled. */
  function agentDisplay(agent: Agent): { name: string; hasTitle: boolean } {
    const title = titles.get(agent.session.id) ?? foldSessionTitle(agent.session.events)?.title
    if (title !== undefined) return { name: title, hasTitle: true }
    const id = agent.id
    return { name: id.length > 18 ? `${id.slice(0, 15)}…` : id, hasTitle: false }
  }

  /** `[~/Code]`-style workspace suffix from the session header cwd, when present. */
  function workspacePart(agent: Agent): string {
    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd === '') return ''
    return ` [${escapeHtml(homeShorten(cwd, homedir()))}]`
  }

  /** One-line agent description for listings and confirmations: name + workspace. */
  function describeAgent(agent: Agent): string {
    const { name, hasTitle } = agentDisplay(agent)
    const body = hasTitle ? `<b>${escapeHtml(name)}</b>` : `<code>${escapeHtml(name)}</code>`
    return `${body}${workspacePart(agent)}`
  }

  /** Persist one chat's agent selection to the state file. */
  function persistChatSelections(): void {
    try {
      writeFileSync(stateFile, `${JSON.stringify(chatSelections, null, 2)}\n`)
    } catch (error) {
      ctx.logger.warn(`telegram-control: cannot write ${stateFile}: ${describeError(error)}`)
    }
  }

  /** Record a selection and return the confirmation text to send. */
  async function selectEntry(chatId: number, entry: ConversationEntry): Promise<void> {
    const state = ensureChat(chatId)
    state.agentId = entry.sessionId
    chatSelections[String(chatId)] = entry.sessionId
    persistChatSelections()
    const title = await conversationTitle(entry)
    const namePart = title !== undefined
      ? `<b>${escapeHtml(title)}</b>`
      : `<code>${escapeHtml(shortSessionId(entry.sessionId))}</code>`
    const cwdPart = entry.cwd !== undefined && entry.cwd !== ''
      ? ` [${escapeHtml(homeShorten(entry.cwd, homedir()))}]`
      : ''
    const pausedNote = entry.agent === undefined ? ' (paused — resumes on your first message)' : ''
    await client.sendMessage(chatId, `Selected ${namePart}${cwdPart}.${pausedNote}`)
  }

  /** Resolve the agent a chat's plain messages target: explicit selection, default, then the single conversation. */
  async function resolveAgent(chatId: number): Promise<Agent | undefined> {
    const state = ensureChat(chatId)
    for (const candidate of [state.agentId, defaultAgentId]) {
      if (candidate === undefined || candidate === '') continue
      return await ensureLiveAgent(SessionId(candidate))
    }
    const entries = await listConversations()
    if (entries.length === 1) return await ensureLiveAgent(entries[0]!.sessionId)
    return undefined
  }

  /** Send a message, splitting over-long payloads into Telegram-safe chunks. */
  async function sendChunks(chatId: number, text: string): Promise<void> {
    for (const chunk of splitMessage(text, maxMessageChars)) {
      await client.sendMessage(chatId, chunk)
    }
  }

  /** Register a pending reply for `chatId` on `agent`'s session; call before `agent.followup`. */
  function registerPending(agent: Agent, chatId: number, messageId: MessageId): void {
    const sessionId = agent.session.id
    let byChat = pendingBySession.get(sessionId)
    if (byChat === undefined) {
      byChat = new Map()
      pendingBySession.set(sessionId, byChat)
    }
    const existing = byChat.get(chatId)
    if (existing !== undefined) existing.timeoutDispose()
    const entry: PendingReply = {
      chatId,
      buffer: [],
      startedAt: Date.now(),
      messageId,
      turn: undefined,
      timeoutDispose: () => { /* replaced below */ },
    }
    entry.timeoutDispose = ctx.effect(() => {
      const timer = setTimeout(() => flush(sessionId, chatId, 'timeout'), replyTimeoutMs)
      return () => clearTimeout(timer)
    }, 'telegram-control.replyTimeout()')
    byChat.set(chatId, entry)
  }

  /** Remove a pending reply and deliver whatever was accumulated. */
  function flush(sessionId: SessionId, chatId: number, reason: 'idle' | 'timeout'): void {
    const byChat = pendingBySession.get(sessionId)
    const entry = byChat?.get(chatId)
    if (byChat === undefined || entry === undefined) return
    byChat.delete(chatId)
    if (byChat.size === 0) pendingBySession.delete(sessionId)
    entry.timeoutDispose()
    const text = entry.buffer.join('\n\n').trim()
    const note = reason === 'timeout'
      ? `(agent still busy after ${Math.round((Date.now() - entry.startedAt) / 1000)}s)`
      : '(agent finished without textual output)'
    void sendChunks(chatId, text === '' ? note : text).catch(logWarn)
  }

  /** Forward one assistant message to every watching chat. */
  function forwardWatching(text: string): void {
    for (const [chatId, state] of chats) {
      if (state.watching) void sendChunks(chatId, text).catch(logWarn)
    }
  }

  /** Edit every forwarded approval message to show the settled outcome. */
  async function updateApprovalMessages(entry: PendingApproval, suffix: string): Promise<void> {
    for (const { chatId, messageId } of entry.sent) {
      try {
        await client.editMessageText(chatId, messageId, `${entry.text}\n\n${suffix}`)
      } catch (error) {
        ctx.logger.warn(`telegram-control: editing approval message ${messageId} failed: ${describeError(error)}`)
      }
    }
  }

  /** Edit every forwarded question message to show the chosen answer. */
  async function updateQuestionMessages(entry: PendingQuestion, suffix: string): Promise<void> {
    for (const { chatId, messageId } of entry.sent) {
      try {
        await client.editMessageText(chatId, messageId, `${entry.text}\n\n${suffix}`)
      } catch (error) {
        ctx.logger.warn(`telegram-control: editing question message ${messageId} failed: ${describeError(error)}`)
      }
    }
  }

  /** Forward one user-question request to Telegram with option buttons. */
  async function forwardQuestions(
    request: AskUserQuestionRequest,
    settle: (answer: AskUserQuestionAnswer) => void,
  ): Promise<void> {
    if (request.questions.length === 0) return
    for (const item of request.questions) {
      // Multi-select and free-text questions have no one-button answer; show
      // them as notifications and let the Web dialog collect the answer.
      const singleSelect = item.multiSelect !== true && (item.options?.length ?? 0) > 0
      const token = randomUUID()
      const options = item.options ?? []
      const header = item.header !== undefined ? `${item.header}\n` : ''
      const text = [
        '❓ <b>Question</b>',
        `Agent: ${describeAgentSafe(request.agent)}`,
        `${header}${escapeHtml(item.question)}`,
        item.detail !== undefined && item.detail !== '' ? `\n${escapeHtml(item.detail)}` : '',
      ].filter(part => part !== '').join('\n')
      const sent: { chatId: number; messageId: number }[] = []
      const entry: PendingQuestion = {
        resolve: settle,
        text,
        sent,
        items: options.map(option => ({ id: item.id, label: option.label })),
        timeoutDispose: () => { /* replaced below */ },
      }
      if (singleSelect) {
        const timer = setTimeout(() => {
          const current = pendingQuestions.get(token)
          if (current === undefined) return
          pendingQuestions.delete(token)
          void updateQuestionMessages(current, '⏹️ <b>Cancelled</b> (no answer in time).').catch(logWarn)
        }, approvalTimeoutMs)
        entry.timeoutDispose = () => clearTimeout(timer)
        pendingQuestions.set(token, entry)
      }
      try {
        const keyboard = singleSelect ? {
          inline_keyboard: [options.map((option, index) => ({
            text: option.label,
            callback_data: `question:${token}:${index}`,
          }))],
        } : undefined
        for (const chatId of allowedChatIds) {
          const result = await client.sendMessage(chatId, text, keyboard === undefined ? {} : { replyMarkup: keyboard })
          sent.push({ chatId, messageId: result.message_id })
        }
      } catch (error) {
        ctx.logger.warn(`telegram-control: forwarding question failed: ${describeError(error)}`)
        if (pendingQuestions.has(token)) pendingQuestions.delete(token)
      }
    }
  }

  /** Agent label without a live agent (questions may lack one). */
  function describeAgentSafe(agent: Agent | undefined): string {
    return agent === undefined ? '<code>unknown</code>' : describeAgent(agent)
  }

  /** Answer one inline-button press on a forwarded approval request. */
  async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const data = query.data
    if (data === undefined) {
      await client.answerCallbackQuery(query.id, 'no action')
      return
    }
    const question = parseQuestionCallback(data)
    if (question !== undefined) {
      const entry = pendingQuestions.get(question.token)
      if (entry === undefined) {
        await client.answerCallbackQuery(query.id, 'question already settled')
        return
      }
      pendingQuestions.delete(question.token)
      entry.timeoutDispose()
      const item = entry.items[question.optionIndex]
      if (item === undefined || question.optionIndex < 0) {
        await client.answerCallbackQuery(query.id, 'invalid option')
        return
      }
      const answer: AskUserQuestionAnswer = { answers: [{ id: item.id, selected: [item.label] }] }
      await client.answerCallbackQuery(query.id, '已选择')
      entry.resolve(answer)
      void updateQuestionMessages(entry, `✅ 已选择: ${item.label}`).catch(logWarn)
      return
    }
    const parsed = parseApprovalCallback(data)
    if (parsed === undefined) {
      await client.answerCallbackQuery(query.id, 'stale button')
      return
    }
    const { approve, token } = parsed
    const entry = pendingApprovals.get(token)
    if (entry === undefined) {
      await client.answerCallbackQuery(query.id, 'request already settled')
      return
    }
    pendingApprovals.delete(token)
    entry.timeoutDispose()
    const outcome: ApprovalOutcome = approve ? 'allowed-once' : 'rejected'
    await client.answerCallbackQuery(query.id, approve ? '已批准' : '已拒绝')
    entry.resolve(outcome)
    ctx.logger.info(`telegram-control: approval ${token.slice(0, 8)} ${approve ? 'approved' : 'rejected'} via Telegram`)
    void updateApprovalMessages(entry, approve
      ? '✅ <b>Approved</b> (allowed once).'
      : '❌ <b>Rejected</b>.').catch(logWarn)
  }

  /** Handle one Telegram message from an authorized chat. */
  async function handleMessage(message: NonNullable<TelegramUpdate['message']>): Promise<void> {
    const chatId = message.chat.id
    if (message.text === undefined) return
    const parsed = parseBotCommand(message.text)
    if (parsed !== undefined) {
      await handleCommand(chatId, parsed.command, parsed.rawInput)
    } else {
      await handlePlain(chatId, message.text)
    }
  }

  /** Dispatch a parsed bot command. */
  async function handleCommand(chatId: number, command: string, rawInput: string): Promise<void> {
    switch (command) {
      case 'start':
      case 'help':
        await sendChunks(chatId, helpText())
        return
      case 'chatid':
        await client.sendMessage(chatId, `Your chat id is <code>${chatId}</code>.`)
        return
      case 'status': {
        const entries = await listConversations()
        const live = entries.filter(entry => entry.agent !== undefined).length
        const jobs = jobsService()?.list() ?? []
        const lines = [
          '🤖 <b>dsh status</b>',
          `uptime: ${renderUptime(process.uptime())}`,
          `conversations: ${entries.length} (${live} live)`,
          `jobs: ${jobs.length}`,
        ]
        await sendChunks(chatId, lines.join('\n'))
        return
      }
      case 'agents': {
        const state = ensureChat(chatId)
        const entries = await listConversations()
        if (entries.length === 0) {
          await client.sendMessage(chatId, 'No conversations yet. Start one from the Web UI first.')
          return
        }
        const lines: string[] = []
        for (const [index, entry] of entries.entries()) {
          const icon = entry.agent === undefined ? '⚪' : entry.agent.status === 'running' ? '⏳' : '🟢'
          const selected = state.agentId === entry.sessionId ? ' 👈' : ''
          const title = await conversationTitle(entry)
          const namePart = title !== undefined
            ? `<b>${escapeHtml(title)}</b>`
            : `<code>${escapeHtml(shortSessionId(entry.sessionId))}</code>`
          const cwdPart = entry.cwd !== undefined && entry.cwd !== ''
            ? ` [${escapeHtml(homeShorten(entry.cwd, homedir()))}]`
            : ''
          const statusPart = entry.agent !== undefined
            ? `${entry.agent.status} — ${escapeHtml(entry.agent.options.model ?? entry.agent.options.provider ?? 'unknown')}`
            : 'paused'
          lines.push(`${index + 1}. ${icon} ${namePart}${cwdPart}${selected} — ${statusPart}`)
        }
        await sendChunks(chatId,
          `Conversations — pick one with <code>/agent &lt;number&gt;</code> or <code>/agent &lt;name&gt;</code> (paused ones resume on your first message):\n${lines.join('\n')}`)
        return
      }
      case 'agent': {
        const state = ensureChat(chatId)
        const requested = rawInput.trim()
        if (requested === '') {
          const current = state.agentId
          if (current === undefined) {
            await client.sendMessage(chatId, 'No agent selected. Use <code>/agents</code> then <code>/agent &lt;number&gt;</code>.')
          } else {
            const entries = await listConversations()
            const entry = entries.find(candidate => candidate.sessionId === SessionId(current))
            if (entry === undefined) {
              await client.sendMessage(chatId, `Selected session <code>${escapeHtml(current)}</code> (not found).`)
            } else {
              const title = await conversationTitle(entry)
              const namePart = title !== undefined
                ? `<b>${escapeHtml(title)}</b>`
                : `<code>${escapeHtml(shortSessionId(entry.sessionId))}</code>`
              const cwdPart = entry.cwd !== undefined && entry.cwd !== ''
                ? ` [${escapeHtml(homeShorten(entry.cwd, homedir()))}]`
                : ''
              await client.sendMessage(chatId, `Selected: ${namePart}${cwdPart}`)
            }
          }
          return
        }
        const entries = await listConversations()
        // 1) exact session id
        const exact = entries.find(entry => entry.sessionId === SessionId(requested))
        if (exact !== undefined) {
          await selectEntry(chatId, exact)
          return
        }
        // 2) 1-based index into the /agents listing
        const index = Number(requested)
        if (Number.isSafeInteger(index) && index >= 1 && index <= entries.length) {
          const entry = entries[index - 1]
          if (entry !== undefined) {
            await selectEntry(chatId, entry)
            return
          }
        }
        // 3) case-insensitive substring match on the title or session id
        const needle = requested.toLowerCase()
        const matches: ConversationEntry[] = []
        for (const entry of entries) {
          const label = (await conversationTitle(entry)) ?? ''
          if (label.toLowerCase().includes(needle) || entry.sessionId.toLowerCase().includes(needle)) {
            matches.push(entry)
          }
        }
        if (matches.length === 1) {
          await selectEntry(chatId, matches[0]!)
          return
        }
        if (matches.length > 1) {
          const candidateLines: string[] = []
          for (const match of matches) {
            const label = (await conversationTitle(match)) ?? shortSessionId(match.sessionId)
            candidateLines.push(`• ${escapeHtml(label)}`)
          }
          await client.sendMessage(chatId,
            `Multiple conversations match "<code>${escapeHtml(requested)}</code>":\n${candidateLines.join('\n')}\nUse <code>/agent &lt;number&gt;</code> to pick one.`)
          return
        }
        await client.sendMessage(chatId,
          `No conversation matches "<code>${escapeHtml(requested)}</code>". Use <code>/agents</code> to list them.`)
        return
      }
      case 'jobs': {
        const service = jobsService()
        if (service === undefined) {
          await client.sendMessage(chatId, 'jobs service unavailable in this profile.')
          return
        }
        const jobs = service.list()
        if (jobs.length === 0) {
          await client.sendMessage(chatId, 'No background jobs.')
          return
        }
        const lines = jobs.map(job =>
          `• <code>${escapeHtml(job.id)}</code> — ${job.kind} — ${job.status} — ${escapeHtml(job.label)}`)
        await sendChunks(chatId, `Background jobs:\n${lines.join('\n')}`)
        return
      }
      case 'kill': {
        const service = jobsService()
        const jobId = rawInput.trim()
        if (service === undefined) {
          await client.sendMessage(chatId, 'jobs service unavailable in this profile.')
          return
        }
        if (jobId === '') {
          await client.sendMessage(chatId, 'Usage: <code>/kill &lt;job id&gt;</code>')
          return
        }
        const outcome = service.kill(jobId as JobId, undefined, 'telegram-control')
        await client.sendMessage(chatId, outcome === 'requested'
          ? `Kill requested for <code>${escapeHtml(jobId)}</code>.`
          : `Job <code>${escapeHtml(jobId)}</code> was already finished.`)
        return
      }
      case 'cancel': {
        const state = ensureChat(chatId)
        const selectedId = state.agentId
        const liveAgents = ctx.agents.list()
        const agent = selectedId !== undefined
          ? ctx.agents.get(SessionId(selectedId))
          : liveAgents.length === 1 ? liveAgents[0] : undefined
        if (agent === undefined) {
          await client.sendMessage(chatId,
            'No live agent to cancel. Send a message to resume one first, then <code>/cancel</code>.')
          return
        }
        agent.cancel({ kind: 'user' })
        await client.sendMessage(chatId, `Cancellation requested for ${describeAgent(agent)}.`)
        return
      }
      case 'watch': {
        ensureChat(chatId).watching = true
        await client.sendMessage(chatId, 'Watching: live agent output will be forwarded to this chat. <code>/unwatch</code> to stop.')
        return
      }
      case 'unwatch': {
        ensureChat(chatId).watching = false
        await client.sendMessage(chatId, 'Watching stopped.')
        return
      }
      default:
        await client.sendMessage(chatId, `Unknown command <code>/${escapeHtml(command)}</code>. Send <code>/help</code> for the command list.`)
    }
  }

  /** Send a plain message as a follow-up to the chat's selected agent. */
  async function handlePlain(chatId: number, text: string): Promise<void> {
    const agent = await resolveAgent(chatId)
    if (agent === undefined) {
      await client.sendMessage(chatId,
        'No conversation selected. Use <code>/agents</code> then <code>/agent &lt;number&gt;</code>, or start one from the Web UI.')
      return
    }
    const sessionId = agent.session.id
    const message = createUserMessage({
      // A `user` source — exactly what the Web UI's own input uses — so the
      // message renders as a normal user bubble in the desktop conversation
      // instead of an invisible plugin context card.
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    })
    // Register before followup so the turn's events land in the reply buffer.
    registerPending(agent, chatId, message.id)
    try {
      agent.followup(message)
    } catch (error) {
      // A follow-up that fails synchronously (agent disposed mid-flight) would
      // otherwise leave the pending entry to time out; close it immediately.
      flush(sessionId, chatId, 'idle')
      throw error
    }
    void client.sendChatAction(chatId, 'typing').catch(logWarn)
    ctx.logger.info(`telegram-control: follow-up queued for agent ${sessionId} from chat ${chatId}`)
  }

  /** Handle one update from the poll loop; never throws. */
  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query !== undefined) {
      try {
        await handleCallbackQuery(update.callback_query)
      } catch (error) {
        ctx.logger.warn(`telegram-control: callback query failed: ${describeError(error)}`)
      }
      return
    }
    const message = update.message
    if (message === undefined || message.text === undefined) return
    const chatId = message.chat.id
    const authorized = allowedChatIds.includes(chatId)
    if (!authorized) {
      if (message.text.trimStart().startsWith('/')) {
        await client.sendMessage(chatId,
          `Not authorized. Add chat id <code>${chatId}</code> to <code>allowedChatIds</code> (or <code>DSH_TELEGRAM_ALLOWED_CHATS</code>).`)
      }
      return
    }
    try {
      await handleMessage(message)
    } catch (error) {
      ctx.logger.warn(`telegram-control: handling message from chat ${chatId} failed: ${describeError(error)}`)
      try {
        await client.sendMessage(chatId, `⚠️ Handling failed: ${escapeHtml(describeError(error))}`)
      } catch {
        // The failure report itself failed; the log above is the record.
      }
    }
  }

  /** Long-poll the Telegram API until the plugin unloads. */
  async function poll(): Promise<void> {
    let offset = 0
    let backoffMs = 1000
    while (!abort.signal.aborted) {
      try {
        const updates = await client.getUpdates(offset, pollTimeoutSec, abort.signal)
        backoffMs = 1000
        for (const update of updates) {
          if (update.update_id >= offset) offset = update.update_id + 1
          void handleUpdate(update).catch(logWarn)
        }
      } catch (error) {
        if (abort.signal.aborted) return
        if (error instanceof TelegramApiError && error.code === 409) {
          ctx.logger.warn('telegram-control: 409 Conflict — another getUpdates instance is polling; this one stops')
          return
        }
        ctx.logger.warn(`telegram-control: getUpdates failed: ${describeError(error)}; retrying in ${backoffMs}ms`)
        await sleep(backoffMs, abort.signal)
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      }
    }
  }

  // ---- live harness events ----

  // Approval requests: forward to every authorized chat with Allow/Reject
  // buttons, and claim the request (prepended, so this runs before the Web
  // UI answerer). Any Telegram-side failure falls back to `next()` so the
  // Web UI dialog still gets the question instead of failing the ask closed.
  ctx.on('approval/request', (req, next) => {
    if (allowedChatIds.length === 0) return next()
    if (req.signal !== undefined && req.signal.aborted) {
      return Promise.resolve<ApprovalOutcome>('cancelled')
    }
    const token = randomUUID()
    const sent: { chatId: number; messageId: number }[] = []
    const { promise, resolve } = Promise.withResolvers<ApprovalOutcome>()
    const entry: PendingApproval = {
      resolve,
      text: '',
      sent,
      timeoutDispose: () => { /* replaced below */ },
    }
    const timer = setTimeout(() => {
      const current = pendingApprovals.get(token)
      if (current === undefined) return
      pendingApprovals.delete(token)
      current.resolve('cancelled')
      void updateApprovalMessages(current, '⏹️ <b>Cancelled</b> (no answer in time).').catch(logWarn)
    }, approvalTimeoutMs)
    entry.timeoutDispose = () => clearTimeout(timer)
    pendingApprovals.set(token, entry)
    if (req.signal !== undefined) {
      req.signal.addEventListener('abort', () => {
        const current = pendingApprovals.get(token)
        if (current === undefined) return
        pendingApprovals.delete(token)
        current.timeoutDispose()
        current.resolve('cancelled')
      }, { once: true })
    }
    return (async () => {
      try {
        const text = [
          '🔒 <b>Approval required</b>',
          `Agent: ${describeAgent(req.agent)}`,
          `Tool: <code>${escapeHtml(req.toolName)}</code>`,
          req.reason !== undefined && req.reason !== ''
            ? `Reason: ${escapeHtml(req.reason)}`
            : 'Reason: (none given)',
        ].join('\n')
        entry.text = text
        const keyboard = {
          inline_keyboard: [[
            { text: '✅ Allow once', callback_data: `approve:${token}` },
            { text: '❌ Reject', callback_data: `reject:${token}` },
          ]],
        }
        for (const chatId of allowedChatIds) {
          const result = await client.sendMessage(chatId, text, { replyMarkup: keyboard })
          sent.push({ chatId, messageId: result.message_id })
        }
        ctx.logger.info(`telegram-control: approval request ${token.slice(0, 8)} for ${req.toolName} forwarded`)
        return await promise
      } catch (error) {
        const current = pendingApprovals.get(token)
        if (current !== undefined) {
          pendingApprovals.delete(token)
          current.timeoutDispose()
          current.resolve('cancelled')
        }
        ctx.logger.warn(`telegram-control: forwarding approval failed, delegating: ${describeError(error)}`)
        return next()
      }
    })()
  }, true)

  // A session appearing after this plugin mounted (GUI resume, new chat)
  // carries its stored `session/title` events in its seed, which never replay
  // through the event feed — fold them on publication.
  ctx.on('session/created', (session) => {
    seedTitle(session)
  })

  // Durable event feed: accumulate assistant text for pending replies and
  // forward to watching chats. `turn/end` delivers a pending reply the moment
  // its own turn closes — reliable even when the agent stays busy with other
  // work and never reports `idle`.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      const text = assistantText(event.data.message, reasoningMaxChars)
      if (text === '') return
      const byChat = pendingBySession.get(session.id)
      if (byChat !== undefined) {
        // Only buffer output from OUR follow-up's own turn: a GUI-initiated
        // turn that runs while a reply is pending must not leak into it.
        for (const entry of byChat.values()) {
          if (entry.turn === event.data.turn) entry.buffer.push(text)
        }
      } else {
        forwardWatching(text)
      }
    } else if (event.type === 'turn/end') {
      const byChat = pendingBySession.get(session.id)
      if (byChat === undefined) return
      for (const chatId of [...byChat.keys()]) {
        const entry = byChat.get(chatId)
        if (entry !== undefined && entry.turn === event.data.turn) {
          flush(session.id, chatId, 'idle')
        }
      }
    } else if (event.type === 'session/title') {
      titles.set(session.id, event.data.title)
    } else if (event.type === 'tool/call' && showToolCalls) {
      const byChat = pendingBySession.get(session.id)
      if (byChat === undefined) return
      const notice = `🔧 <code>${escapeHtml(event.data.name)}</code>`
      for (const entry of byChat.values()) {
        if (entry.turn === event.data.turn) {
          void client.sendMessage(entry.chatId, notice).catch(logWarn)
        }
      }
    }
  })

  // When our follow-up is claimed into a turn, remember the turn so its
  // `turn/end` can flush the reply precisely.
  ctx.on('agent/inbox/claimed', (payload) => {
    const byChat = pendingBySession.get(payload.agent.session.id)
    if (byChat === undefined) return
    for (const entry of byChat.values()) {
      if (entry.messageId === payload.message.id) entry.turn = payload.turn
    }
  })

  // A discarded follow-up (cancellation, agent shutdown) never gets a turn;
  // tell the requesting chat instead of leaving it pending until timeout.
  ctx.on('agent/inbox/discarded', (payload) => {
    const byChat = pendingBySession.get(payload.agent.session.id)
    if (byChat === undefined) return
    for (const [chatId, entry] of byChat) {
      if (entry.messageId !== payload.message.id) continue
      entry.buffer.push('⚠️ message was discarded before the agent processed it')
      flush(payload.agent.session.id, chatId, 'idle')
    }
  })

  // Status flips: typing while running, plus an idle flush as a fallback
  // (turn/end already delivered the reply in the common case).
  ctx.on('agent/status', (payload) => {
    const sessionId = payload.agent.session.id
    const byChat = pendingBySession.get(sessionId)
    if (byChat === undefined) return
    if (payload.status === 'idle') {
      for (const chatId of [...byChat.keys()]) flush(sessionId, chatId, 'idle')
    } else if (payload.status === 'running') {
      for (const entry of byChat.values()) {
        void client.sendChatAction(entry.chatId, 'typing').catch(logWarn)
      }
    }
  })

  // Terminal failures land in the pending buffer so the requesting chat sees why.
  ctx.on('agent/error', (payload) => {
    const byChat = pendingBySession.get(payload.agent.session.id)
    if (byChat === undefined) return
    const note = `⚠️ <b>agent error</b>: ${escapeHtml(describeError(payload.error))}`
    for (const entry of byChat.values()) {
      if (entry.turn === payload.turn) entry.buffer.push(note)
    }
  })

  // An agent leaving the registry resolves its pending replies with a notice.
  ctx.on('agent/disposed', (payload) => {
    const sessionId = payload.agent.session.id
    const byChat = pendingBySession.get(sessionId)
    if (byChat === undefined) return
    pendingBySession.delete(sessionId)
    for (const entry of byChat.values()) {
      entry.timeoutDispose()
      void client.sendMessage(entry.chatId, '⚠️ agent was disposed while working').catch(logWarn)
    }
  })

  ctx.logger.info(
    `telegram-control: bot active (${allowedChatIds.length} authorized chat(s), token ${token.slice(0, 8)}…)`,
  )
  // Publish the command menu so the plugin's slash commands show up in the
  // Telegram input field without being typed by hand.
  void client.setMyCommands(BOT_COMMANDS).catch((error: unknown) => {
    ctx.logger.warn(`telegram-control: setMyCommands failed: ${describeError(error)}`)
  })
  void poll().catch(logWarn)
}

/** The `/help` text. */
function helpText(): string {
  return [
    '🤖 <b>dsh remote control</b>',
    '',
    '<code>/status</code> — harness uptime, agent and job counts',
    '<code>/agents</code> — list live agents (numbered, with names)',
    '<code>/agent &lt;number|name&gt;</code> — select the agent this chat drives',
    '<code>/jobs</code> — list background jobs',
    '<code>/kill &lt;job id&gt;</code> — stop a background job',
    '<code>/cancel</code> — cancel the selected agent\u2019s current turn',
    '<code>/watch</code> / <code>/unwatch</code> — toggle forwarding live agent output',
    '<code>/chatid</code> — show this chat\u2019s id (for setup)',
    '<code>/help</code> — this list',
    '',
    'Plain messages are sent as follow-ups to the selected agent; its reply is relayed here.',
  ].join('\n')
}
