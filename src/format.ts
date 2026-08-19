/**
 * Pure formatting helpers for Telegram payloads. No harness or network
 * dependencies, so they are unit-testable in isolation.
 * @module dsh-telegram-control/format
 */

/** Escape text so it is safe inside Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return char
    }
  })
}

/**
 * Split one message into Telegram-safe chunks (hard cap `max` chars each).
 * Prefers newline boundaries; a single over-long line is hard-split.
 * @param text - the full message to split.
 * @param max - per-chunk character cap (Telegram's own limit is 4096).
 * @returns the ordered chunks; `[text]` when it already fits.
 */
export function splitMessage(text: string, max = 4000): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Render a duration in seconds as a compact `1h 23m 45s` string. */
export function renderUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`)
  parts.push(`${secs}s`)
  return parts.join(' ')
}

/**
 * Shorten an absolute path under the user's home directory to `~/…` form.
 * @param path - the absolute path to shorten.
 * @param home - the home directory to anchor on (empty means `path` is already `~`).
 * @returns `~`/`~/…` for paths under `home`, otherwise the path unchanged.
 */
export function homeShorten(path: string, home: string): string {
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}

/**
 * Summarize a reasoning chain the way the Web UI's collapsed Think row does:
 * the first line of the finished chain. A single over-long line is capped at
 * `maxChars`, cut at a sentence boundary when one fits, ellipsized.
 * @param text - the full reasoning text.
 * @param maxChars - the per-line cap; `0` (or below) suppresses reasoning entirely.
 * @returns the summary, or `''` when suppressed.
 */
export function trimReasoning(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const newline = text.indexOf('\n')
  let summary = (newline === -1 ? text : text.slice(0, newline)).trim()
  if (summary.length <= maxChars) return summary
  let cut = maxChars
  for (const match of summary.slice(0, maxChars).matchAll(/[。！？!?.]\s*/g)) {
    cut = (match.index ?? 0) + match[0].length
  }
  if (cut < maxChars * 0.5) cut = maxChars
  return `${summary.slice(0, cut).trimEnd()}…`
}

/** One parsed bot command: `/name@bot extra` → `{ command: 'name', rawInput: 'extra' }`. */
export interface ParsedBotCommand {
  /** Lowercase command name without the leading slash or bot username. */
  command: string
  /** Exact text after the command (whitespace-stripped), empty when absent. */
  rawInput: string
}

/**
 * Parse a Telegram message as a bot command. Group-chat mentions
 * (`/status@my_bot`) are normalized away; anything that does not start with a
 * slash returns `undefined`.
 * @param text - the raw message text.
 * @returns the parsed command, or `undefined` for a plain message.
 */
export function parseBotCommand(text: string): ParsedBotCommand | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (match === null) return undefined
  return {
    command: (match[1] ?? '').toLowerCase(),
    rawInput: match[2] === undefined ? '' : match[2].trim(),
  }
}

/** One parsed approval-button callback: which choice and which request token. */
export interface ParsedApprovalCallback {
  /** Whether the button granted (`approve`) or denied (`reject`) the request. */
  approve: boolean
  /** The random request token embedded in the button's callback_data. */
  token: string
}

/**
 * Parse an inline-button callback for an approval request.
 * @param data - the raw `callback_data` from a Telegram callback query.
 * @returns the parsed choice, or `undefined` for stale or malformed data.
 */
export function parseApprovalCallback(data: string): ParsedApprovalCallback | undefined {
  const match = /^(approve|reject):([0-9a-f-]+)$/.exec(data)
  if (match === null) return undefined
  return { approve: match[1] === 'approve', token: match[2] ?? '' }
}
