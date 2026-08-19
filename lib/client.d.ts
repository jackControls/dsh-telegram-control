/**
 * Minimal Telegram Bot API client over the global `fetch`. Covers long-poll
 * `getUpdates`, `sendMessage` with inline keyboards, `sendChatAction`,
 * callback-query answering, message editing, and the bot command menu. No
 * third-party runtime dependencies.
 * @module dsh-telegram-control/client
 */
/** One inline keyboard button. */
export interface InlineKeyboardButton {
    text: string;
    callback_data: string;
}
/** One callback-query update (a user tapped an inline button). */
export interface TelegramCallbackQuery {
    id: string;
    from: {
        id: number;
    };
    message?: {
        message_id: number;
        chat: {
            id: number;
        };
    };
    data?: string;
}
/** One Telegram update; `message` and `callback_query` are consumed. */
export interface TelegramUpdate {
    update_id: number;
    message?: {
        message_id: number;
        chat: {
            id: number;
            type: string;
            title?: string;
            username?: string;
        };
        from?: {
            id: number;
            username?: string;
            first_name?: string;
        };
        text?: string;
        date: number;
    };
    callback_query?: TelegramCallbackQuery;
}
/** One bot-command menu entry shown in the Telegram input field. */
export interface BotCommand {
    /** Lowercase command name without the slash (1–32 chars, `[a-z0-9_]`). */
    command: string;
    /** Short user-facing description (≤ 256 chars). */
    description: string;
}
/** Options for {@link TelegramClient.sendMessage}. */
export interface TelegramSendOptions {
    /** Override the default `HTML` parse mode; pass `undefined` for plain text. */
    parseMode?: 'HTML' | 'MarkdownV2' | undefined;
    /** Disable link previews (defaults to true — agent output is not preview-safe). */
    disableWebPagePreview?: boolean;
    /** Inline keyboard rows to attach, when present. */
    replyMarkup?: {
        inline_keyboard: InlineKeyboardButton[][];
    } | undefined;
}
/** Actions supported by `sendChatAction`. */
export type TelegramChatAction = 'typing' | 'upload_document' | 'find_location';
/** A Telegram API error with the API's numeric error code when supplied. */
export declare class TelegramApiError extends Error {
    /** The `error_code` field from the API response, when present. */
    readonly code: number | undefined;
    constructor(message: string, code: number | undefined);
}
/**
 * Long-polling Telegram bot client. Webhook deployments should disable
 * polling and adapt the inbound path themselves; this client owns the
 * outbound half only.
 */
export declare class TelegramClient {
    private readonly token;
    private readonly baseUrl;
    /**
     * @param token - the bot token (`123456:ABC-DEF...`).
     * @param apiBase - API base URL; defaults to the public endpoint. Overridable
     *   for tests and self-hosted proxies.
     */
    constructor(token: string, apiBase?: string);
    private url;
    /** Perform one API call and unwrap the `{ ok, result }` envelope. */
    private call;
    /**
     * Long-poll `getUpdates`. Resolves with the updates available within
     * `timeoutSec` seconds.
     * @param offset - first update id to return; pass the last consumed id + 1.
     * @param timeoutSec - long-poll seconds (Telegram accepts up to 50).
     * @param signal - optional abort; the underlying fetch rejects on abort.
     */
    getUpdates(offset: number, timeoutSec?: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
    /** Send one text message to a chat, optionally with an inline keyboard. */
    sendMessage(chatId: number, text: string, options?: TelegramSendOptions, signal?: AbortSignal): Promise<{
        message_id: number;
    }>;
    /** Show a chat-action indicator (e.g. `typing`) while work is pending. */
    sendChatAction(chatId: number, action: TelegramChatAction, signal?: AbortSignal): Promise<void>;
    /** Acknowledge a callback-query button press (required to stop its spinner). */
    answerCallbackQuery(callbackQueryId: string, text?: string, signal?: AbortSignal): Promise<void>;
    /** Replace the text of a previously sent message (e.g. to show an approval outcome). */
    editMessageText(chatId: number, messageId: number, text: string, signal?: AbortSignal): Promise<void>;
    /** Publish the bot's command menu (shown above the Telegram input field). */
    setMyCommands(commands: readonly BotCommand[], signal?: AbortSignal): Promise<void>;
}
