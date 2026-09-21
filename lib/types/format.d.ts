/**
 * Pure formatting helpers for Telegram payloads. No harness or network
 * dependencies, so they are unit-testable in isolation.
 * @module dsh-telegram-control/format
 */
/** Escape text so it is safe inside Telegram's HTML parse mode. */
export declare function escapeHtml(text: string): string;
/**
 * Split one message into Telegram-safe chunks (hard cap `max` chars each).
 * Prefers newline boundaries; a single over-long line is hard-split.
 * @param text - the full message to split.
 * @param max - per-chunk character cap (Telegram's own limit is 4096).
 * @returns the ordered chunks; `[text]` when it already fits.
 */
export declare function splitMessage(text: string, max?: number): string[];
/** Render a duration in seconds as a compact `1h 23m 45s` string. */
export declare function renderUptime(seconds: number): string;
/**
 * Shorten an absolute path under the user's home directory to `~/…` form.
 * @param path - the absolute path to shorten.
 * @param home - the home directory to anchor on (empty means `path` is already `~`).
 * @returns `~`/`~/…` for paths under `home`, otherwise the path unchanged.
 */
export declare function homeShorten(path: string, home: string): string;
/**
 * Summarize a reasoning chain the way the Web UI's collapsed Think row does:
 * the first line of the finished chain. A single over-long line is capped at
 * `maxChars`, cut at a sentence boundary when one fits, ellipsized.
 * @param text - the full reasoning text.
 * @param maxChars - the per-line cap; `0` (or below) suppresses reasoning entirely.
 * @returns the summary, or `''` when suppressed.
 */
export declare function trimReasoning(text: string, maxChars: number): string;
/** One parsed bot command: `/name@bot extra` → `{ command: 'name', rawInput: 'extra' }`. */
export interface ParsedBotCommand {
    /** Lowercase command name without the leading slash or bot username. */
    command: string;
    /** Exact text after the command (whitespace-stripped), empty when absent. */
    rawInput: string;
}
/**
 * Parse a Telegram message as a bot command. Group-chat mentions
 * (`/status@my_bot`) are normalized away; anything that does not start with a
 * slash returns `undefined`.
 * @param text - the raw message text.
 * @returns the parsed command, or `undefined` for a plain message.
 */
export declare function parseBotCommand(text: string): ParsedBotCommand | undefined;
/** One parsed approval-button callback: which choice and which request token. */
export interface ParsedApprovalCallback {
    /** Whether the button granted (`approve`) or denied (`reject`) the request. */
    approve: boolean;
    /** The random request token embedded in the button's callback_data. */
    token: string;
}
/**
 * Parse an inline-button callback for an approval request.
 * @param data - the raw `callback_data` from a Telegram callback query.
 * @returns the parsed choice, or `undefined` for stale or malformed data.
 */
export declare function parseApprovalCallback(data: string): ParsedApprovalCallback | undefined;
/** One parsed question-button callback: the request token and the option index. */
export interface ParsedQuestionCallback {
    token: string;
    /** Index into the question's `options` array that was pressed. */
    optionIndex: number;
}
/**
 * Parse an inline-button callback for a forwarded user question.
 * @param data - the raw `callback_data` from a Telegram callback query.
 * @returns the parsed choice, or `undefined` for stale or malformed data.
 */
export declare function parseQuestionCallback(data: string): ParsedQuestionCallback | undefined;
