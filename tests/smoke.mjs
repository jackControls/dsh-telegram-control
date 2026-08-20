/**
 * End-to-end smoke test: boots a real `dsh web` profile from the installed CLI
 * in an isolated $DSH_HOME, mounts dsh-telegram-control, and drives it against
 * fake Telegram and mock-LLM servers.
 *
 * Phase A: live agent — /status, follow-up + reply relay, /agents, selection,
 * /jobs, unauthorized chat, persistence.
 * Phase B: paused conversation — the harness restarts WITHOUT the agent-loop
 * override, the persisted session from phase A appears as paused, and a plain
 * message resumes it (mock-LLM reply comes back).
 *
 *   node tests/smoke.mjs [--keep]
 *
 * Requires: the dsh CLI installed under the npx cache (or $DSH_CLI pointing at
 * its bin.js), pnpm on PATH, and a built plugin in lib/ (run `npx tsc` first).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGIN_DIR = ROOT
const CLI = process.env.DSH_CLI ?? join(
  '/Users/jack/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js',
)
const KEEP = process.argv.includes('--keep')

const TELEGRAM_PORT = 3187
const LLM_PORT = 3199
const WEB_PORT = 3188
const TOKEN = '123456:SMOKE-TEST-TOKEN'
const CHAT_ID = 111222333

const failures = []
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

// ---- fake Telegram API ----
const tgQueue = [] // updates still to deliver
const tgSent = [] // sendMessage payloads
const tgActions = []
const tgApprovals = [] // approval messages with buttons
const tgQuestions = [] // question messages with buttons
const tgCallbackAnswers = [] // answerCallbackQuery payloads
const tgEdits = [] // editMessageText payloads
const tgCommands = [] // setMyCommands payloads
const tgPollQueries = [] // getUpdates query strings
let tgPollCount = 0

const tgServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname.endsWith('/getUpdates')) {
    tgPollCount += 1
    tgPollQueries.push(url.search)
    json(200, { ok: true, result: tgQueue.splice(0) })
  } else if (url.pathname.endsWith('/sendMessage')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const payload = JSON.parse(body)
      tgSent.push(payload)
      const messageId = tgSent.length
      // Auto-press the first "approve" button of any approval message and the
      // first option button of any forwarded question.
      const buttons = (payload.reply_markup?.inline_keyboard ?? []).flat()
      const approveButton = buttons.find(b => b.callback_data?.startsWith('approve:'))
      if (approveButton !== undefined) {
        tgApprovals.push(payload)
        setTimeout(() => {
          tgQueue.push({
            update_id: 10_000 + tgApprovals.length,
            callback_query: {
              id: `cb-${tgApprovals.length}`,
              from: { id: CHAT_ID },
              message: { message_id: messageId, chat: { id: CHAT_ID } },
              data: approveButton.callback_data,
            },
          })
        }, 400)
      } else {
        const questionButton = buttons.find(b => b.callback_data?.startsWith('question:'))
        if (questionButton !== undefined) {
          tgQuestions.push(payload)
          setTimeout(() => {
            tgQueue.push({
              update_id: 20_000 + tgQuestions.length,
              callback_query: {
                id: `qb-${tgQuestions.length}`,
                from: { id: CHAT_ID },
                message: { message_id: messageId, chat: { id: CHAT_ID } },
                data: questionButton.callback_data,
              },
            })
          }, 400)
        }
      }
      json(200, { ok: true, result: { message_id: messageId } })
    })
  } else if (url.pathname.endsWith('/sendChatAction')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      tgActions.push(JSON.parse(body))
      json(200, { ok: true, result: true })
    })
  } else if (url.pathname.endsWith('/answerCallbackQuery')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      tgCallbackAnswers.push(JSON.parse(body))
      json(200, { ok: true, result: true })
    })
  } else if (url.pathname.endsWith('/editMessageText')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      tgEdits.push(JSON.parse(body))
      json(200, { ok: true, result: { message_id: 1 } })
    })
  } else if (url.pathname.endsWith('/setMyCommands')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      tgCommands.push(JSON.parse(body))
      json(200, { ok: true, result: true })
    })
  } else {
    json(404, { ok: false, description: `no route ${url.pathname}` })
  }
})

// ---- mock LLM (OpenAI-compatible /chat/completions, SSE) ----
const llmRequests = []
const llmServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404)
      res.end('{}')
      return
    }
    const payload = JSON.parse(body)
    llmRequests.push(payload)
    const content = 'Hello from mock LLM \u2705'
    // Only the CURRENT prompt's last user message may trigger the approval
    // tool call — matching against full history would loop forever.
    const messages = payload.messages ?? []
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const lastUserText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : (Array.isArray(lastUser?.content) ? lastUser.content.map(p => p.text ?? '').join('') : '')
    const wantsApproval = lastUserText.includes('run approval test')
    const wantsQuestion = lastUserText.includes('run question test')
    const toolCallArgs = JSON.stringify({
      command: 'echo hi > /tmp/tg-approval-smoke',
      description: 'run approval smoke test',
      sandbox_permissions: 'workspace-write',
      justification: 'smoke test approval flow',
    })
    const questionCallArgs = JSON.stringify({
      questions: [{ id: 'q1', question: 'Approve the smoke plan?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    })
    if (payload.stream !== false) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = wantsApproval
        ? [
          { id: 'mock-tc-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
          { id: 'mock-tc-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: toolCallArgs } }] }, finish_reason: 'tool_calls' }] },
        ]
        : wantsQuestion
          ? [
            { id: 'mock-q-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
            { id: 'mock-q-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'ask_user_question', arguments: questionCallArgs } }] }, finish_reason: 'tool_calls' }] },
          ]
          : [
          { id: 'mock-0', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: 'Let me think carefully about this request.' }, finish_reason: null }] },
          { id: 'mock-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
          { id: 'mock-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] },
          { id: 'mock-3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'mock-1', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }))
    }
  })
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await Promise.all([
  new Promise((resolve) => tgServer.listen(TELEGRAM_PORT, '127.0.0.1', resolve)),
  new Promise((resolve) => llmServer.listen(LLM_PORT, '127.0.0.1', resolve)),
])

// ---- harness boot ----
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-tg-smoke-'))
mkdirSync(join(dshHome, 'profiles'), { recursive: true })

const baseOverlay = [
  // The web persona templates {{cwd}}, which config-created agents do not get.
  '- id: system-prompt',
  '  config:',
  '    persona: You are a smoke test agent.',
  // read-only sandbox so a `sandbox_permissions` escalation is strictly wider
  // and deterministically raises an approval request.
  '- id: sandbox-policy',
  '  config:',
  '    mode: read-only',
  '- id: webserver',
  '  config:',
  `    host: 127.0.0.1`,
  `    port: ${WEB_PORT}`,
  '- id: llm-deepseek',
  '  config:',
  `    baseURL: http://127.0.0.1:${LLM_PORT}`,
  '    apiKeyEnv: DEEPSEEK_API_KEY',
  '- id: telegram-control',
  '  config:',
  `    apiBase: http://127.0.0.1:${TELEGRAM_PORT}`,
  '    replyTimeoutMs: 30000',
  '    showToolCalls: true',
]

const agentLoopRows = [
  '- id: agent-loop',
  '  config:',
  '    agents:',
  '      - id: telegram-smoke',
  '        provider: deepseek-official',
  '        model: deepseek-v4-flash',
  `        cwd: ${dshHome}`,
]

const overlayA = join(dshHome, 'overlay-a.yml')
writeFileSync(overlayA, [...baseOverlay.slice(0, 14), ...agentLoopRows, ...baseOverlay.slice(14), ''].join('\n'))
const overlayB = join(dshHome, 'overlay-b.yml')
writeFileSync(overlayB, [...baseOverlay, ''].join('\n'))

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_TELEGRAM_TOKEN: TOKEN,
  DSH_TELEGRAM_ALLOWED_CHATS: String(CHAT_ID),
  DEEPSEEK_API_KEY: 'smoke-key',
  DSH_TELEMETRY_DISABLED: '1',
}

console.log(`DSH_HOME=${dshHome}`)
console.log(`installing plugin into the web profile...`)
const install = spawnSync(process.execPath, [CLI, 'plugin', '--profile', 'web', 'add', PLUGIN_DIR], {
  env, stdio: 'pipe', timeout: 120_000,
})
if (install.status !== 0) {
  console.log('plugin install failed:\n', install.stdout.toString(), install.stderr.toString())
  process.exit(1)
}

/** Boot a harness child and capture its output. */
function bootHarness(overlayPath) {
  const child = spawn(process.execPath, [CLI, 'web', '--patch', overlayPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = { text: '' }
  child.stdout.on('data', (c) => { log.text += c })
  child.stderr.on('data', (c) => { log.text += c })
  return { child, log }
}

/** Wait for a predicate against live state; fails fast if the harness exits. */
function waitFor(child, log, predicate, what, timeoutMs = 45_000) {
  return (async () => {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (predicate()) return true
      if (child.exitCode !== null) {
        console.log(`dsh exited early (code ${child.exitCode}); last log:\n${log.text.slice(-3000)}`)
        return false
      }
      await sleep(250)
    }
    console.log(`timed out waiting for ${what}; last log:\n${log.text.slice(-3000)}`)
    return false
  })()
}

let child
let bootLog = { text: '' }
let ok = true
try {
  // ================= phase A: live agent =================
  console.log('booting dsh web (phase A: live agent)...')
  ;({ child, log: bootLog } = bootHarness(overlayA))

  tgQueue.push(
    { update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: '/status', date: 0 } },
    { update_id: 2, message: { message_id: 2, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: 'hello from telegram', date: 0 } },
  )

  ok = await waitFor(child, bootLog, () => tgPollCount >= 3, 'the bot to start polling Telegram')
  check('bot starts long-polling Telegram', ok)

  ok = ok && await waitFor(child, bootLog, () => tgSent.length >= 1, 'a sendMessage for /status')
  const statusMsg = tgSent.find(m => m.text.includes('dsh status'))
  check('status reply delivered', statusMsg !== undefined)
  if (statusMsg) {
    check('status reply reports the live conversation', statusMsg.text.includes('conversations: 1 (1 live)'),
      statusMsg.text.split('\n').join(' | '))
  }

  ok = ok && await waitFor(child, bootLog, () => tgSent.some(m => m.text.includes('Hello from mock LLM')), 'the agent reply relay')
  const replyMsg = tgSent.find(m => m.text.includes('Hello from mock LLM'))
  check('agent follow-up reply relayed to Telegram', replyMsg !== undefined)
  if (replyMsg) {
    check('reply HTML is escaped', !/<\w/.test(replyMsg.text.replace(/&lt;|&gt;|&amp;|&quot;/g, '')))
  }
  check('reasoning (thinking) included in the relayed reply',
    tgSent.some(m => m.text.includes('\u{1F4AD} Let me think')))

  check('follow-up reached the mock LLM', llmRequests.some(r => JSON.stringify(r).includes('hello from telegram')))
  check('poll offset advanced past delivered updates', tgPollCount >= 3)
  check('typing actions were sent', tgActions.some(a => a.action === 'typing'))

  // /help, /agents, /agent selection, a post-selection follow-up, /jobs, and
  // an unauthorized chat round out command coverage.
  const sentBeforePhase2 = tgSent.length
  const llmBeforePhase2 = llmRequests.length
  tgQueue.push(
    { update_id: 3, message: { message_id: 3, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: '/help', date: 0 } },
    { update_id: 4, message: { message_id: 4, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: '/agents', date: 0 } },
    { update_id: 5, message: { message_id: 5, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: '/agent 1', date: 0 } },
    { update_id: 6, message: { message_id: 6, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: 'second followup after selection', date: 0 } },
    { update_id: 7, message: { message_id: 7, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: '/jobs', date: 0 } },
    { update_id: 8, message: { message_id: 8, chat: { id: 999_999_999, type: 'private' }, from: { id: 999_999_999 }, text: '/status', date: 0 } },
  )
  ok = ok && await waitFor(child, bootLog, () => tgSent.length >= sentBeforePhase2 + 4, 'the phase-2 command replies')
  check('help reply delivered', tgSent.some(m => m.text.includes('dsh remote control')))
  const agentsMsg = tgSent.find(m => m.text.includes('Conversations — pick one'))
  check('agents reply is a numbered list', agentsMsg !== undefined
    && agentsMsg.text.includes('1.')
    && (agentsMsg.text.includes('telegram-smoke') || agentsMsg.text.includes('<b>')))
  check('agent selection by number works', tgSent.some(m => m.text.includes('Selected')))
  check('post-selection follow-up reached the agent', llmRequests.length >= llmBeforePhase2 + 1
    && JSON.stringify(llmRequests.at(-1)).includes('second followup'))
  check('post-selection follow-up reply relayed', tgSent.filter(m => m.text.includes('Hello from mock LLM')).length >= 2)
  check('jobs reply delivered', tgSent.some(m => m.text.includes('No background jobs.')))
  const deniedMsg = tgSent.find(m => m.text.includes('Not authorized'))
  check('unauthorized chat gets the onboarding hint', deniedMsg !== undefined && deniedMsg.text.includes('999999999'))
  let persisted = false
  try {
    const state = JSON.parse(readFileSync(join(dshHome, 'telegram-control-state.json'), 'utf8'))
    persisted = typeof state[String(CHAT_ID)] === 'string' && state[String(CHAT_ID)].includes('telegram-smoke')
  } catch { /* file missing or corrupt */ }
  check('agent selection persisted to $DSH_HOME', persisted)

  // Command menu + callback subscription are boot-time behavior; the approval
  // round-trip itself lives in phase C, on the resumed (preset-mounted) agent
  // that actually has tools.
  check('bot command menu published via setMyCommands', tgCommands.length >= 1
    && tgCommands[0].commands.some(c => c.command === 'agents')
    && tgCommands[0].commands.some(c => c.command === 'agent'))
  check('getUpdates subscribes to callback_query', tgPollQueries.some(q => q.includes('callback_query')))

  // ================= phase B: paused conversation resumes =================
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
  tgQueue.length = 0
  const llmBeforePhaseB = llmRequests.length
  const tgSentBeforePhaseB = tgSent.length

  console.log('booting dsh web (phase B: no agent-loop, paused session)...')
  ;({ child, log: bootLog } = bootHarness(overlayB))

  tgQueue.push(
    { update_id: 101, message: { message_id: 101, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: '/agents', date: 0 } },
    { update_id: 102, message: { message_id: 102, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: 'resume me please', date: 0 } },
  )

  ok = ok && await waitFor(child, bootLog, () => tgSent.some(m => m.text.includes('paused')), 'the paused conversation listing')
  const pausedMsg = tgSent.find(m => m.text.includes('paused'))
  check('phase B: /agents lists the paused conversation', pausedMsg !== undefined
    && pausedMsg.text.includes('Conversations') && pausedMsg.text.includes('1.'))

  ok = ok && await waitFor(child, bootLog, () => llmRequests.length >= llmBeforePhaseB + 1, 'the resumed follow-up reaching the mock LLM')
  check('phase B: plain message resumed the persisted session',
    JSON.stringify(llmRequests.at(-1) ?? {}).includes('resume me please'))
  ok = ok && await waitFor(child, bootLog, () => tgSent.some(m => m.text.includes('Hello from mock LLM')), 'the resumed reply relay')
  check('phase B: resumed reply relayed', tgSent.length >= tgSentBeforePhaseB + 1
    && tgSent.some(m => m.text.includes('Hello from mock LLM')))

  // ================= phase C: approval round-trip =================
  // The resumed agent has the standard preset mounted, so it owns the bash
  // tool: a follow-up whose model response requests a sandbox escalation
  // raises an approval ask, which must arrive in Telegram with buttons, get
  // answered, and let the turn continue.
  const llmBeforeApproval = llmRequests.length
  tgQueue.push(
    { update_id: 201, message: { message_id: 201, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: 'run approval test', date: 0 } },
  )
  ok = ok && await waitFor(child, bootLog, () => tgApprovals.length >= 1, 'the approval request to reach Telegram')
  const approvalMsg = tgApprovals[0]
  check('phase C: approval request forwarded to Telegram', approvalMsg !== undefined
    && approvalMsg.text.includes('Approval required') && approvalMsg.text.includes('bash'))
  check('phase C: approval message carries Allow/Reject buttons', approvalMsg !== undefined
    && approvalMsg.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data?.startsWith('approve:'))
    && approvalMsg.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data?.startsWith('reject:')))
  ok = ok && await waitFor(child, bootLog, () => tgCallbackAnswers.length >= 1, 'the callback to be answered')
  check('phase C: callback query answered', tgCallbackAnswers[0] !== undefined && tgCallbackAnswers[0].text === '已批准')
  check('phase C: approval message edited with the outcome', tgEdits.some(m => m.text.includes('Approved')))
  ok = ok && await waitFor(child, bootLog, () => llmRequests.length >= llmBeforeApproval + 1, 'the post-approval model call')
  check('phase C: approved tool call continued the turn', llmRequests.length >= llmBeforeApproval + 1)

  // ---- phase C2: user-question round-trip ----
  const llmBeforeQuestion = llmRequests.length
  tgQueue.push(
    { update_id: 202, message: { message_id: 202, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: 'run question test', date: 0 } },
  )
  ok = ok && await waitFor(child, bootLog, () => tgQuestions.length >= 1, 'the question to reach Telegram')
  const questionMsg = tgQuestions[0]
  check('phase C2: question forwarded to Telegram', questionMsg !== undefined
    && questionMsg.text.includes('Question') && questionMsg.text.includes('Approve the smoke plan'))
  check('phase C2: question carries option buttons', questionMsg !== undefined
    && questionMsg.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data?.startsWith('question:')))
  ok = ok && await waitFor(child, bootLog, () => tgCallbackAnswers.some(a => a.text === '已选择'), 'the question callback to be answered')
  check('phase C2: question callback answered', tgCallbackAnswers.some(a => a.text === '已选择'))
  check('phase C2: question message edited with the answer', tgEdits.some(m => m.text.includes('已选择')))
  ok = ok && await waitFor(child, bootLog, () => llmRequests.length >= llmBeforeQuestion + 1, 'the post-question model call')
  check('phase C2: answered question continued the turn', llmRequests.length >= llmBeforeQuestion + 1)
} finally {
  if (child !== undefined) child.kill('SIGTERM')
  await new Promise((resolve) => child?.once('exit', resolve))
  await new Promise((resolve) => tgServer.close(resolve))
  await new Promise((resolve) => llmServer.close(resolve))
  if (!KEEP) {
    spawnSync('rm', ['-rf', dshHome])
    console.log(`removed ${dshHome}`)
  } else {
    console.log(`kept ${dshHome} (overlays: ${overlayA}, ${overlayB})`)
  }
}

console.log(failures.length === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST FAILED: ${failures.join(', ')}`)
if (failures.length > 0) {
  console.log('---- sent messages ----')
  console.log(JSON.stringify(tgSent, null, 2))
  console.log('---- actions ----')
  console.log(JSON.stringify(tgActions, null, 2))
  console.log('---- boot log ----')
  console.log(bootLog.text.slice(-12000))
}
process.exit(failures.length === 0 ? 0 : 1)
