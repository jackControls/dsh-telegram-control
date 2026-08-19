# dsh-telegram-control

Remote-control plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
Runs a Telegram bot **inside the harness process** so you can drive your agents, jobs, and harness
status from your phone: send a message to the bot and it becomes a follow-up to your agent, whose
reply comes back to you as a Telegram message.

Everything is a plugin in dsh — this one is a Cordis function plugin that talks to the Telegram
Bot API over long-polling with zero runtime dependencies beyond the harness itself.

## Features

- **Remote agent control** — plain text messages are sent as follow-ups to the chat's selected
  conversation and appear as ordinary user messages in the desktop Web UI conversation. The agent's
  reply — **including its thinking/reasoning blocks, marked with 💭** — is relayed back the moment
  its turn closes (turn-tracked, so delivery does not depend on the agent ever reporting idle).
- **Command surface** — `/status`, `/agents`, `/agent <session id>`, `/jobs`, `/kill <job id>`,
  `/cancel`, `/watch` / `/unwatch`, `/chatid`, `/help`.
- **Approval on the phone** — harness permission requests (sandbox escalations and other
  `approval/request` asks) arrive in Telegram with **✅ Allow once / ❌ Reject** inline buttons;
  the answer is applied and the message is edited with the outcome. If Telegram cannot be reached
  the question falls back to the Web UI dialog instead of failing closed.
- **Command menu** — the bot's slash commands are published via `setMyCommands`, so `/agents`,
  `/agent`, `/jobs`, … show up in the Telegram input field without being typed by hand.
- **Live push** — `/watch` forwards every assistant message from live sessions to your chat.
- **Auth by chat allowlist** — unknown chats get an onboarding hint with their chat id, nothing else.
- **Safe output** — all dynamic text is HTML-escaped before it reaches Telegram; long replies are
  split into Telegram-sized chunks.

## Requirements

- `dsh` running from the npm package (`npx @deepseek-ai/dsh`) or a repository checkout.
- Node.js with a global `fetch` (Node ≥ 18; dsh itself needs Node ≥ 22).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).

## Installation

1. Get a bot token: message [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the token.
2. Install the plugin into a profile. Either from this repository

   ```sh
   dsh plugin --profile web add github:jackControls/dsh-telegram-control
   ```

   or, from a local checkout:

   ```sh
   dsh plugin --profile web add /path/to/dsh-telegram-control
   ```

   (Replace `web` with the profile you run. The package declares `dsh.bundle`, so `dsh plugin add`
   installs it *and* activates it as a profile layer automatically — you don't need to touch
   `cordis.patch.yml`. `lib/` is committed, so git installs work without a build step.)
3. Configure via environment in the same process that runs `dsh`:

   ```sh
   export DSH_TELEGRAM_TOKEN='123456:ABC-DEF...'
   export DSH_TELEGRAM_ALLOWED_CHATS='123456789,987654321'   # comma-separated chat ids
   ```

4. Restart `dsh`. Start a private chat with your bot, send `/chatid` to learn your chat id if you
   haven't added it yet, then `/help`.

### Manual patch (no `dsh plugin add`)

If you prefer to mount it by hand, add a row to your profile's `cordis.patch.yml`
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: telegram-control
      name: 'dsh-telegram-control'
      config:
        # optional: pin values here instead of the environment
        token: '123456:ABC-DEF...'
        allowedChatIds: [123456789]
```

## Configuration

| Config key | Env fallback | Default | Meaning |
| --- | --- | --- | --- |
| `token` | `DSH_TELEGRAM_TOKEN` | — (required) | Telegram bot token. |
| `allowedChatIds` | `DSH_TELEGRAM_ALLOWED_CHATS` | `[]` (deny all) | Authorized chat ids. Note: schemastery validates a missing array to `[]`, so an empty/absent allowlist always falls back to the environment. |
| `apiBase` | — | `https://api.telegram.org` | Bot API base (useful for proxies and tests). |
| `defaultAgentId` | — | none | Session id plain messages target when the chat has no `/agent` selection. |
| `pollTimeoutSec` | — | `50` | Long-poll `getUpdates` timeout (Telegram accepts up to 50). |
| `replyTimeoutMs` | — | `600000` (10 min) | Max wait for an agent reply before flushing partial output with a note. |
| `showToolCalls` | — | `false` | Emit one-line `🔧 <name>` notices while a reply is pending. |
| `maxMessageChars` | — | `4000` | Per-message character cap before Telegram-side splitting. |

## Commands

| Command | What it does |
| --- | --- |
| `/help`, `/start` | Command list. |
| `/status` | Uptime, conversation count (live/total), background job count. |
| `/agents` | List every conversation — live agents **and** paused persisted sessions (the same set the Web UI sidebar shows): numbered, named by their session title, each with its workspace in brackets (`[~/path]`), status (`idle`/`running`/`paused`), model, and a 👈 marker on this chat's selection. |
| `/agent <number>` | Select the conversation at that position in the `/agents` list. |
| `/agent <name>` | Select by a case-insensitive substring of the conversation's title or session id; ambiguous matches list candidates. |
| `/agent <session id>` | Select by the exact session id. `/agent` with no argument shows the current selection. |
| `/jobs` | List background jobs. |
| `/kill <job id>` | Request a background job be stopped. |
| `/cancel` | Cancel the selected agent's current turn. |
| `/watch` / `/unwatch` | Toggle forwarding live agent output to this chat. |
| `/chatid` | Show this chat's id (for the allowlist). |

Plain messages are sent as follow-ups to the selected conversation. Selection order: the chat's
`/agent` choice, then `defaultAgentId`, then the single conversation if there is exactly one. A
paused (persisted-but-not-live) conversation is **resumed** on first message exactly like the Web
UI does it — the session's stored agent preset is re-mounted, so history replays under the same
composition it was produced under. Each chat's selection is **persisted** to
`$DSH_HOME/telegram-control-state.json`, so it survives harness restarts. Conversation names come
from the harness's session titles (`session/title` events — the auto-summary or your manual
rename, the same names the Web UI shows); the bracketed workspace is the session's `cwd`.

## How it works

- `apply(ctx, config)` runs a long-polling `getUpdates` loop inside the harness process
  (`fetch`-based, no bot framework). A 409 from the API (another poller) stops that poller cleanly;
  network errors back off up to 30 s.
- Plain messages call `agent.followup(createUserMessage(...))` with `source: { kind: 'user' }` —
  the same source the Web UI's own input uses, so the text shows up as a normal user bubble in the
  desktop conversation.
- The plugin listens to the durable `session/event` feed and the live `agent/inbox/claimed` /
  `agent/status` / `agent/error` / `agent/disposed` events. Each follow-up's message id is matched
  against `agent/inbox/claimed` to learn its turn number, and the accumulated reply (visible text +
  💭 reasoning) is flushed when that turn's `turn/end` lands — an idle flush and a timeout note
  cover the remaining cases. Tool-call and error notices relay as they happen; typing indicators
  show while the agent runs.
- All registrations are Cordis effects, so unloading the plugin (HMR, profile reload) tears the
  bot down cleanly.

## Security

- The bot is a **remote shell into your harness** by design: only chats listed in
  `allowedChatIds` (or `DSH_TELEGRAM_ALLOWED_CHATS`) may issue commands. Keep the allowlist tight.
- The token is a bearer credential: prefer the environment variable over a committed patch file.
- The plugin does not widen any harness capability — it can only do what your running harness can
  do, and the harness's own sandbox/approval policies still apply to agent work.

## Development

```sh
npm install                 # dev deps (typecheck + build)
npx tsc                     # typecheck + emit lib/
node --test 'tests/*.test.mjs'   # unit tests for the pure helpers
node tests/smoke.mjs        # end-to-end: boots a real `dsh web` in an isolated $DSH_HOME,
                            # with fake Telegram + mock-LLM servers, and asserts the whole
                            # message→agent→relay loop (set DSH_CLI to your dsh bin if needed)
```

## Known limitations

- Telegram webhooks are not supported; long-polling only (fine for a personal remote control).
- The plugin observes the session event feed; very high-frequency sessions could flood a watching
  chat — `/unwatch` is your friend.
- `sessionId`-keyed reply buffering assumes one user drives one agent; two chats driving the same
  agent get one combined reply per turn (each chat receives it).

## License

MIT
