# Changelog

## 0.1.0 — 2026-08-19

Initial community release.

- Long-polling Telegram bot inside the harness process (zero runtime deps beyond the harness).
- Conversations: list live agents **and** paused persisted sessions with session titles and
  workspace paths; a paused conversation resumes on demand exactly like the Web UI (stored
  agent preset re-mounted).
- Turn-tracked reply relay: a reply returns the moment its own turn closes; GUI-originated
  output never leaks into it. Thinking is relayed as a first-line summary (Web UI collapsed
  Think-row semantics), `reasoningMaxChars` configurable.
- Approvals: `approval/request` asks arrive in Telegram with ✅/❌ inline buttons; the answer is
  applied and the message is edited with the outcome; falls back to the Web dialog when Telegram
  is unreachable. `approvalTimeoutMs` configurable.
- Commands: `/status /agents /agent /jobs /kill /cancel /watch /unwatch /chatid /help`, published
  via `setMyCommands`.
- Authorization: every inbound message is checked against the chat allowlist before any action;
  an empty allowlist denies everyone (fail closed). Selection persistence across restarts.
- Tests: 22 unit tests (formatting, callback parsing, Telegram client) and a two-phase
  end-to-end smoke suite (26 checks) covering live agent, paused-session resume, and the full
  approval round-trip.
