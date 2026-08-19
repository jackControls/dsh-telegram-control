/**
 * Unit tests for the Telegram Bot API client, exercised against a tiny local
 * HTTP server that mimics the API envelope. Run with: node --test tests/
 */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import http from 'node:http'
import { TelegramApiError, TelegramClient } from '../lib/client.js'

/** A minimal fake Telegram API: records requests, replies with a configurable envelope. */
function fakeTelegram() {
  const calls = []
  let respond = (path, body) => ({ ok: true, result: { message_id: 1 } })
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body
      try { body = JSON.parse(raw || 'null') } catch { body = raw }
      calls.push({ path: req.url, body })
      const out = respond(req.url, body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  return {
    server,
    calls,
    setRespond: (fn) => { respond = fn },
    url: null,
  }
}

const fakes = []
const makeClient = async () => {
  const fake = fakeTelegram()
  fakes.push(fake)
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve))
  const port = fake.server.address().port
  const client = new TelegramClient('test:token', `http://127.0.0.1:${port}`)
  return { fake, client }
}

after(async () => {
  await Promise.all(fakes.map((f) => new Promise((resolve) => f.server.close(resolve))))
})

test('getUpdates sends offset and callback_query subscription', async () => {
  const { fake, client } = await makeClient()
  await client.getUpdates(42, 50)
  const [call] = fake.calls
  assert.ok(call.path.includes('timeout=50'))
  assert.ok(call.path.includes('offset=42'))
  assert.ok(call.path.includes('callback_query'))
})

test('sendMessage carries HTML mode and inline keyboard', async () => {
  const { fake, client } = await makeClient()
  const keyboard = { inline_keyboard: [[{ text: '✅', callback_data: 'approve:x' }]] }
  await client.sendMessage(1, '<b>hi</b>', { replyMarkup: keyboard })
  assert.deepEqual(fake.calls[0].body, {
    chat_id: 1,
    text: '<b>hi</b>',
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard,
  })
})

test('answerCallbackQuery and editMessageText post the expected payloads', async () => {
  const { fake, client } = await makeClient()
  await client.answerCallbackQuery('cb-1', '已批准')
  await client.editMessageText(1, 5, 'done ✅')
  assert.deepEqual(fake.calls[0].body, { callback_query_id: 'cb-1', text: '已批准' })
  assert.deepEqual(fake.calls[1].body, { chat_id: 1, message_id: 5, text: 'done ✅', parse_mode: 'HTML' })
})

test('setMyCommands posts the command list', async () => {
  const { fake, client } = await makeClient()
  await client.setMyCommands([{ command: 'agents', description: '列出会话' }])
  assert.deepEqual(fake.calls[0].body, { commands: [{ command: 'agents', description: '列出会话' }] })
})

test('a failed envelope throws TelegramApiError with the API code', async () => {
  const { fake, client } = await makeClient()
  fake.setRespond(() => ({ ok: false, error_code: 409, description: 'Conflict' }))
  await assert.rejects(client.getUpdates(0), (error) =>
    error instanceof TelegramApiError && error.code === 409 && error.message.includes('Conflict'))
})
