# dsh-telegram-control

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Telegram 远程控制插件。
它在 **harness 进程内部**运行一个 Telegram bot：你在手机上和 bot 聊天，普通文本会作为
follow-up 消息发给所选 agent，agent 的回复（一轮里所有 step 的输出）会在回合结束后回传到
Telegram。

dsh 里一切都是插件——这是一个 Cordis 函数插件，用长轮询对接 Telegram Bot API，除了 harness
自身之外没有任何运行时依赖。

## 功能

- **远程控制 agent**：普通文本消息作为 follow-up 发给当前 chat 选定的会话，并会以普通用户
  气泡的形式出现在桌面 Web UI 的对话记录里。agent 的回复——**包括 💭 标记的思考内容**——
  在它自己的回合（turn）结束时立刻回传（按 turn 追踪，不依赖 agent 进入 idle）。
- **命令面**：`/status`、`/agents`、`/agent <session id>`、`/jobs`、`/kill <job id>`、
  `/cancel`、`/watch` / `/unwatch`、`/chatid`、`/help`。
- **手机审批**：harness 的权限请求（沙箱升级等 `approval/request`）会以带 **✅ 允许一次 /
  ❌ 拒绝** 内联按钮的消息发到 Telegram；点击即生效并把结果回写原消息。Telegram 不可达时
  回退到 Web 对话框，不会 fail-closed。
- **提问也上手机**：`ask_user_question` 类提问（计划评审、选项确认）会带选项按钮转发到
  Telegram，Telegram 的回答与 Web 对话框竞争、先到先得。审批与提问提示都会无条件出现在
  Telegram（无论桌面当前聚焦在哪）。
- **实时推送**：`/watch` 开启后，所有 live session 的 assistant 消息都会转发到你的 chat。
- **白名单鉴权**：未授权 chat 只会收到一条提示（里面带上它自己的 chat id），其余全部忽略。
- **输出安全**：所有动态文本在发往 Telegram 前做 HTML 转义；超长回复自动分片。

## 环境要求

- `dsh`（`npx @deepseek-ai/dsh` 或仓库源码运行均可）。
- Node.js ≥ 18（`fetch` 全局可用；dsh 本身要求 ≥ 22）。
- 从 [@BotFather](https://t.me/BotFather) 申请的 bot token。

## 安装

1. 找 [@BotFather](https://t.me/BotFather) 发 `/newbot` 创建 bot，复制 token。
2. 把插件装进某个 profile。可以从本仓库装：

   ```sh
   dsh plugin --profile web add github:jackControls/dsh-telegram-control
   ```

   或从本地目录装：

   ```sh
   dsh plugin --profile web add /path/to/dsh-telegram-control
   ```

   （把 `web` 换成你实际使用的 profile。该包声明了 `dsh.bundle`，所以 `dsh plugin add` 会自动挂成 profile 的一个 layer，不需要手改 `cordis.patch.yml`。`lib/` 已提交，git 安装无需构建步骤。）

3. 在运行 `dsh` 的同一个环境里配置：

   ```sh
   export DSH_TELEGRAM_TOKEN='123456:ABC-DEF...'
   export DSH_TELEGRAM_ALLOWED_CHATS='123456789,987654321'   # 逗号分隔的 chat id
   ```

4. 重启 `dsh`。用你的 Telegram 账号私聊 bot：先发 `/chatid` 拿到自己的 chat id（如果还没加
   进白名单），再发 `/help`。

### 手动挂载（不用 `dsh plugin add`）

也可以直接在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）
里加一行：

```yaml
- insert:
    - id: telegram-control
      name: 'dsh-telegram-control'
      config:
        # 可选：在这里写死配置，而不是用环境变量
        token: '123456:ABC-DEF...'
        allowedChatIds: [123456789]
```

## 配置项

| 配置键 | 环境变量兜底 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `token` | `DSH_TELEGRAM_TOKEN` | —（必填） | Telegram bot token。 |
| `allowedChatIds` | `DSH_TELEGRAM_ALLOWED_CHATS` | `[]`（全部拒绝） | 授权 chat id。注意：schemastery 会把缺失的数组字段校验成 `[]`，所以空/缺失白名单一律回退到环境变量。 |
| `apiBase` | — | `https://api.telegram.org` | Bot API 地址（代理或测试时覆盖）。 |
| `defaultAgentId` | — | 无 | 当 chat 没有 `/agent` 选择时，普通消息默认发往的 session id。 |
| `pollTimeoutSec` | — | `50` | `getUpdates` 长轮询超时（Telegram 上限 50）。 |
| `replyTimeoutMs` | — | `600000`（10 分钟） | 等待 agent 回复的最长时间，超时后把已产生的输出带提示先发出去。 |
| `showToolCalls` | — | `false` | 回复等待期间是否逐条推送 `🔧 <name>` 工具调用提示。 |
| `reasoningMaxChars` | — | `300` | 思考以一行摘要回传（同 Web UI 折叠 Think 行的第一行），单行超过此字符数再截断（`0` 关闭）。 |
| `approvalTimeoutMs` | — | `600000` | 审批请求等待 Telegram 按钮答复的超时，超时按取消处理。 |
| `maxMessageChars` | — | `4000` | 单条消息长度上限，超出自动分片。 |

## 命令

| 命令 | 作用 |
| --- | --- |
| `/help`、`/start` | 命令列表。 |
| `/status` | 运行时长、会话数（live/总数）、后台 job 数。 |
| `/agents` | 列出全部会话——live agent **和** 暂停的持久化会话（与 Web UI 侧边栏一致）：带编号，名字取 session 标题，每个带方括号工作目录（`[~/path]`）、状态（`idle`/`running`/`paused`）、模型，当前 chat 已选中的带 👈 标记。 |
| `/agent <编号>` | 按 `/agents` 列表里的编号选中会话。 |
| `/agent <名字>` | 按 agent 标题或 session id 的子串（不区分大小写）选中；多个匹配时列出候选。 |
| `/agent <session id>` | 按完整 session id 精确选中。`/agent` 不带参数显示当前选择。 |
| `/jobs` | 列出后台 job。 |
| `/kill <job id>` | 请求停止某个后台 job。 |
| `/cancel` | 取消所选 agent 当前回合。 |
| `/watch` / `/unwatch` | 开关 live agent 输出的转发。 |
| `/chatid` | 显示当前 chat 的 id（用于配置白名单）。 |

普通文本会作为 follow-up 发给所选会话。选择顺序：chat 里 `/agent` 的选择 →
`defaultAgentId` → 若恰好只有一个会话则用它。暂停的（已持久化但未 live 的）会话会在
第一条消息时**自动恢复**（和 Web UI 的恢复方式一致：重新挂载会话记录的 agent preset，
历史在相同的组合下回放）。每个 chat 的选择会**持久化**到
`$DSH_HOME/telegram-control-state.json`，harness 重启后依然生效。会话名字来自 harness 的
session 标题（`session/title` 事件——自动总结或你手动改的名字，和 Web UI 显示一致）；
方括号里是 session 的工作目录（`cwd`）。

## 工作原理

- `apply(ctx, config)` 在 harness 进程内跑一个基于 `fetch` 的 `getUpdates` 长轮询循环。
  遇到 409（有别的 poller）会干净地停掉当前 poller；网络错误按指数退避重试（上限 30 s）。
- 普通消息通过 `createUserMessage({ source: { kind: 'user' } })` 构造（与 Web UI 自己发消息
  使用完全相同的来源，所以会显示在桌面对话记录里），再调用 `agent.followup(...)` 入队。
- 插件订阅持久化事件流 `session/event` 和 live 事件 `agent/inbox/claimed` / `agent/status` /
  `agent/error` / `agent/disposed`：用消息 id 匹配 `agent/inbox/claimed` 拿到自己的回合号，
  该回合 `turn/end` 时把累积的回复（可见文本 + 💭 思考）发出——即使 agent 一直忙、从不
  报 idle 也能及时送达；idle 兜底和超时提示覆盖其余情况。工具调用与错误提示即时转发；
  agent 运行期间发送打字指示。
- 所有注册都是 Cordis effect，插件卸载（HMR、profile 重载）时 bot 会被干净地拆掉。

## 安全

- **每条入站消息在采取任何动作前都会先做授权校验**：处理前把 chat id 与 `allowedChatIds`
  （或 `DSH_TELEGRAM_ALLOWED_CHATS`）比对——未列出的 chat 不会执行任何命令、不会向 agent
  投递任何消息、也不会被接受任何审批答复。仅存储/记录 userId 不构成授权。
- **空白名单 = 拒绝所有人**（fail closed）：没有配置任何 chat id 时，所有消息都被拒绝，
  未授权 chat 唯一能收到的回复是告诉它自己 chat id 的引导提示。
- 这个 bot 本质上是你的 harness 的**远程遥控器**：只有白名单内的 chat 能下命令或应答审批。
  白名单务必收紧。
- token 是凭据：优先用环境变量，别写进提交到仓库的 patch 文件。
- 插件不会放大 harness 的任何能力——它只能做你的 harness 本身能做的事，harness 的
  sandbox / 审批策略对 agent 执行的工作依然生效。

## 开发

```sh
npm install                       # 开发依赖（类型检查 + 构建）
npx tsc                          # 类型检查并产出 lib/
node --test 'tests/*.test.mjs'   # 纯函数单元测试
node tests/smoke.mjs             # 端到端冒烟：在隔离的 $DSH_HOME 里启动真实的 `dsh web`，
                                 # 用假的 Telegram 服务和 mock LLM 验证完整的
                                 # 消息→agent→回传链路（需要时可设 DSH_CLI 指向你的 dsh bin）
```

## 已知限制

- 只支持长轮询，不支持 Telegram webhook（个人远程控制够用了）。
- 插件观察会话事件流；高频会话可能刷屏 watching 的 chat——用 `/unwatch` 关掉。
- 回复缓冲按 `sessionId` 组织，假设一个用户驱动一个 agent；两个 chat 驱动同一个 agent 时，
  每个回合会合并成一条回复发给每个 chat。

## License

MIT
