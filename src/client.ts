/**
 * Minimal Telegram Bot API client over the global `fetch`. Covers long-poll
 * `getUpdates`, `sendMessage` with inline keyboards, `sendChatAction`,
 * callback-query answering, message editing, and the bot command menu. No
 * third-party runtime dependencies.
 * @module dsh-telegram-control/client
 */

/** One inline keyboard button. */
export interface InlineKeyboardButton {
  text: string
  callback_data: string
}

/** One callback-query update (a user tapped an inline button). */
export interface TelegramCallbackQuery {
  id: string
  from: { id: number }
  message?: { message_id: number; chat: { id: number } }
  data?: string
}

/** One Telegram update; `message` and `callback_query` are consumed. */
export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number; type: string; title?: string; username?: string }
    from?: { id: number; username?: string; first_name?: string }
    text?: string
    date: number
  }
  callback_query?: TelegramCallbackQuery
}

/** One bot-command menu entry shown in the Telegram input field. */
export interface BotCommand {
  /** Lowercase command name without the slash (1–32 chars, `[a-z0-9_]`). */
  command: string
  /** Short user-facing description (≤ 256 chars). */
  description: string
}

/** Options for {@link TelegramClient.sendMessage}. */
export interface TelegramSendOptions {
  /** Override the default `HTML` parse mode; pass `undefined` for plain text. */
  parseMode?: 'HTML' | 'MarkdownV2' | undefined
  /** Disable link previews (defaults to true — agent output is not preview-safe). */
  disableWebPagePreview?: boolean
  /** Inline keyboard rows to attach, when present. */
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] } | undefined
}

/** Actions supported by `sendChatAction`. */
export type TelegramChatAction = 'typing' | 'upload_document' | 'find_location'

/** A Telegram API error with the API's numeric error code when supplied. */
export class TelegramApiError extends Error {
  /** The `error_code` field from the API response, when present. */
  readonly code: number | undefined

  constructor(message: string, code: number | undefined) {
    super(message)
    this.name = 'TelegramApiError'
    this.code = code
  }
}

/**
 * Long-polling Telegram bot client. Webhook deployments should disable
 * polling and adapt the inbound path themselves; this client owns the
 * outbound half only.
 */
export class TelegramClient {
  private readonly token: string
  private readonly baseUrl: string

  /**
   * @param token - the bot token (`123456:ABC-DEF...`).
   * @param apiBase - API base URL; defaults to the public endpoint. Overridable
   *   for tests and self-hosted proxies.
   */
  constructor(token: string, apiBase = 'https://api.telegram.org') {
    this.token = token
    this.baseUrl = apiBase.replace(/\/+$/, '')
  }

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`
  }

  /** Perform one API call and unwrap the `{ ok, result }` envelope. */
  private async call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response
    const init: RequestInit = { method: body === undefined ? 'GET' : 'POST' }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    if (signal !== undefined) init.signal = signal
    try {
      response = await fetch(this.url(method), init)
    } catch (error) {
      if (signal !== undefined && signal.aborted) throw error
      throw new TelegramApiError(`telegram request ${method} failed: ${String(error)}`, undefined)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new TelegramApiError(`telegram ${method} returned non-JSON (HTTP ${response.status})`, response.status)
    }
    const envelope = payload as { ok: boolean; description?: string; error_code?: number; result?: T }
    if (envelope.ok !== true) {
      throw new TelegramApiError(
        `telegram ${method} error${envelope.error_code === undefined ? '' : ` ${envelope.error_code}`}: ${envelope.description ?? 'unknown'}`,
        envelope.error_code,
      )
    }
    return envelope.result as T
  }

  /**
   * Long-poll `getUpdates`. Resolves with the updates available within
   * `timeoutSec` seconds.
   * @param offset - first update id to return; pass the last consumed id + 1.
   * @param timeoutSec - long-poll seconds (Telegram accepts up to 50).
   * @param signal - optional abort; the underlying fetch rejects on abort.
   */
  async getUpdates(offset: number, timeoutSec = 50, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const query = new URLSearchParams({
      timeout: String(timeoutSec),
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    })
    if (offset > 0) query.set('offset', String(offset))
    return this.call<TelegramUpdate[]>(`getUpdates?${query.toString()}`, undefined, signal)
  }

  /** Send one text message to a chat, optionally with an inline keyboard. */
  async sendMessage(
    chatId: number,
    text: string,
    options: TelegramSendOptions = {},
    signal?: AbortSignal,
  ): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode ?? 'HTML',
      disable_web_page_preview: options.disableWebPagePreview ?? true,
      ...options.replyMarkup === undefined ? {} : { reply_markup: options.replyMarkup },
    }, signal)
  }

  /** Show a chat-action indicator (e.g. `typing`) while work is pending. */
  async sendChatAction(chatId: number, action: TelegramChatAction, signal?: AbortSignal): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action }, signal)
  }

  /** Acknowledge a callback-query button press (required to stop its spinner). */
  async answerCallbackQuery(callbackQueryId: string, text?: string, signal?: AbortSignal): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...text === undefined ? {} : { text },
    }, signal)
  }

  /** Replace the text of a previously sent message (e.g. to show an approval outcome). */
  async editMessageText(chatId: number, messageId: number, text: string, signal?: AbortSignal): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }, signal)
  }

  /** Publish the bot's command menu (shown above the Telegram input field). */
  async setMyCommands(commands: readonly BotCommand[], signal?: AbortSignal): Promise<void> {
    await this.call('setMyCommands', { commands: commands.map(({ command, description }) => ({ command, description })) }, signal)
  }
}
