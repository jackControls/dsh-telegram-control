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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "telegram-control";
export declare const inject: string[];
/** Plugin config. Every field is optional in yml; token and allowlist fall back to environment. */
export interface Config {
    /** Telegram bot token; falls back to `$DSH_TELEGRAM_TOKEN`. */
    token?: string;
    /** Authorized Telegram chat ids; falls back to `$DSH_TELEGRAM_ALLOWED_CHATS` (comma-separated). */
    allowedChatIds?: number[];
    /** Telegram Bot API base; defaults to the public endpoint. Overridable for tests and proxies. */
    apiBase?: string;
    /** Optional agent session id plain messages target when a chat has no `/agent` selection. */
    defaultAgentId?: string;
    /** Long-poll `getUpdates` timeout in seconds (Telegram accepts up to 50). */
    pollTimeoutSec?: number;
    /** Max wait for an agent reply before flushing partial output with a note. */
    replyTimeoutMs?: number;
    /** Emit one-line `tool/call` notices to the requesting chat while a reply is pending. */
    showToolCalls?: boolean;
    /** Max characters of the agent's reasoning relayed per reply (0 disables thinking). */
    reasoningMaxChars?: number;
    /** Max wait for a Telegram button answer to an approval request before it is cancelled. */
    approvalTimeoutMs?: number;
    /** Per-message character cap before Telegram-side splitting (Telegram's own limit is 4096). */
    maxMessageChars?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
