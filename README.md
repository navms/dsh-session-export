[English](README.en.md) | 简体中文

# dsh-session-export

把 DeepSeek Harness 的会话导出为 **Markdown / HTML / JSON**，并且可以自由选择导出哪些**轮次**、哪些**事件类型**。

数据直接来自本地磁盘上的会话日志（`readSession` 的事件数组），不需要额外服务或网络请求。

![导出会话弹窗](images/image.png)

## 功能

| 能力 | 说明 |
|---|---|
| 三种格式 | `Markdown`（原始 Markdown 转录）、`HTML`（自包含单文件，可离线打开）、`JSON`（原始事件数组） |
| 轮次选择 | 逐轮勾选，支持「全选 / 全不选」，按轮号或提示词过滤；第一条 `turn/start` 之前的事件作为「会话前导」单独一项 |
| 事件类型选择 | 13 类开关自由组合，见下方事件类型表 |
| 实时计数 | 每个轮次显示事件条数，每个事件类型显示当前选中轮次内的条数；无内容的类型自动置灰 |
| 高级选项 | 工具结果最大字符数、HTML 内嵌图片、折叠思考块 |
| 可复用面板 | 导出完成后弹窗不关闭，可以直接换格式或换选择继续导出，支持一次会话导出多份 |
| 安全 | HTML 导出先转义再渲染，会话文本里的 `<script>`、`</style>`、`javascript:` 链接、`onerror=` 等无法逃逸 |
| 轻依赖 | 插件不声明任何运行时依赖，以 DSH bundle 形式分发；安装只是把包放进 profile 的 `node_modules` 并登记一行 `dsh.profile.bundles` |

**默认只导出「用户消息」和「AI 回复」**，开箱即得一份干净的对话记录。思考过程、工具调用/结果、图片、文件附件、注入上下文、Token 用量、轮次/步骤标记、未完成的尝试、原始流记录、其他事件默认都不勾选，需要时在弹窗里逐个勾上即可。

### 事件类型

| 事件类型 | 默认 | 导出内容 |
|---|:--:|---|
| 用户消息 | ✅ | 你输入的提示词（`user/message`，`source.kind === 'user'`） |
| AI 回复 | ✅ | 模型输出的正文 |
| 思考过程 | ☐ | 模型的 reasoning 内容（`thinking`），HTML 里默认折叠 |
| 工具调用 | ☐ | 工具名 + 参数（原始 JSON，导出时美化缩进） |
| 工具结果 | ☐ | 工具返回值，可按「工具结果最大字符数」截断，截断处会写明省略了多少字符 |
| 图片 | ☐ | 消息里的图片附件（HTML 可内嵌为 data URI，Markdown 输出占位说明） |
| 文件附件 | ☐ | 消息里的文件引用（名称与体积，不含文件内容） |
| 注入上下文 | ☐ | 系统提示、开发者消息，以及工具结果、子目录 AGENTS.md、技能内容等自动注入的上下文 |
| Token 用量 | ☐ | 每次模型调用的输入/输出/缓存 token |
| 轮次/步骤标记 | ☐ | `turn/start`、`turn/end`、`step/start`、`step/end` 时间线标记 |
| 未完成的尝试 | ☐ | 失败、被重试或中断的模型调用（`assistant/attempt`） |
| 原始流记录 | ☐ | 模型输出的原始流式记录（最详细，体积最大） |
| 其他事件 | ☐ | 以上未覆盖的会话级事件：权限预设、沙箱模式、审批策略、计划模式、会话前导里的注入记录等 |

## 环境要求

- DeepSeek Harness **桌面端**（内置 `desktop` profile）或 **Web profile**（`dsh web`）；两者渲染同一套 web 客户端，插件在两边行为一致
- 安装脚本需要 Node.js ≥ 20（`package.json` 的 `engines` 同口径；插件本身在 Harness 进程内运行，不额外启动进程）
- 插件以 **DSH bundle** 形式分发：`package.json` 声明 `dsh.bundle.patch`，包内 `cordis.patch.yml` 携带要挂载的 Loader 行。因此桌面端/网页端的「插件」面板可以直接用 GitHub 链接安装它

## 安装

最省事的方式是在应用里装：打开 **插件（Plugins）** 面板，在输入框里粘贴仓库地址后安装。

```
https://github.com/navms/dsh-session-export
```

面板会执行 `pnpm add` 把包装进当前 profile 的 `node_modules`，把它登记到
`dsh.profile.bundles`；包自带的 `cordis.patch.yml` 随即作为一层补丁挂上导出接口与会话头部的导出按钮。
**装完后按 Cmd/Ctrl+R 重新加载窗口。**

### 命令行安装

不想点面板的话，脚本提供两种方式：

```sh
# 1) 从 GitHub 安装：走 pnpm add，和插件面板完全一致
node scripts/install.mjs --github
#   不写值就用 package.json 的 repository 推导；也可以显式指定：
node scripts/install.mjs --github https://github.com/navms/dsh-session-export
node scripts/install.mjs --github github:navms/dsh-session-export

# 2) 本地克隆 + 符号链接安装：改代码即时生效，适合开发
git clone https://github.com/navms/dsh-session-export.git
cd dsh-session-export
node scripts/install.mjs
```

两种方式都做同样两件事（幂等，可重复执行）：

1. 把包放到 profile 的 `node_modules`（`--github` 交给 pnpm，默认方式建符号链接指向本目录）；
2. 把包名登记进 `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles`。

`--profile` 不写时按 `$DSH_PROFILE` → 已存在的 `desktop` → 已存在的 `web` → `desktop` 的顺序挑，
所以默认落在桌面端使用的 profile 上。

常用参数：

```sh
node scripts/install.mjs --dry-run             # 只打印将要做的动作，不写任何文件
node scripts/install.mjs --profile web         # 指定 profile（默认 desktop）
node scripts/install.mjs --home /path/to/.dsh  # 指定 Harness home（默认 $DSH_HOME 或 ~/.dsh）
node scripts/install.mjs --dsh /path/to/dsh    # --github 用的 Harness CLI（默认 $DSH_BIN，再默认 PATH 上的 dsh）
node scripts/install.mjs --pnpm /path/to/pnpm  # 强制用 pnpm 直装（默认 $DSH_PNPM，再默认 PATH 上的 pnpm）
node scripts/install.mjs --uninstall           # 卸载：移除链接/依赖、bundle 登记，以及旧版遗留的那一行
```

`--github` 默认优先调用 `dsh plugin --profile <profile> add <spec>`：它用的是安装自带的 pnpm，还会带上 profile
写锁、失败回滚和 bundle 激活，并且只有桌面端自己的启动器才有权操作保留的 `desktop` profile。找不到 CLI 时
自动退化成直接 `pnpm add` 再自行登记 bundle；显式给 `--pnpm` 则跳过 CLI。

> 桌面端自带的 CLI 在 `<应用>/Contents/Resources/runtime/cli/bin/dsh`
> （macOS 即 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`）。
> 如果 PATH 上的 `dsh` 指向别处或已失效，用 `--dsh` 显式指定它。

安装或更新后需要**重新加载窗口**：桌面端 Cmd/Ctrl+R，网页端刷新页面。

> 早期版本把加载行直接插进 profile 的 `cordis.patch.yml`。脚本现在改用 bundle 层，并在安装时把那一行迁走——
> 两边同时存在会让同一个行 id 被插入两次。

### 手动安装

等价于脚本的第一步和第二步：

```sh
PROFILE=~/.dsh/profiles/desktop        # 网页端换成 web
mkdir -p "$PROFILE/node_modules"
ln -s "$PWD" "$PROFILE/node_modules/dsh-session-export"
```

再把 `dsh-session-export` 追加进 `$PROFILE/package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-session-export"]
    }
  }
}
```

也可以绕过 bundle 机制，直接在 profile 的 `cordis.patch.yml` 里插一行（包仍需能从 `node_modules` 解析到）：

```sh
cat >> "$PROFILE/cordis.patch.yml" <<'YAML'

- insert:
    - id: session-transcript-export
      name: 'dsh-session-export'
YAML
```

## 卸载

```sh
node scripts/install.mjs --uninstall
```

会移除符号链接或 profile 依赖、`dsh.profile.bundles` 里的登记，以及早期版本留在
`cordis.patch.yml` 里的那一行。桌面端也可以直接在「插件」面板里停用或移除。

## 使用

1. 打开任意会话，点击会话头部的 **导出按钮**（下载图标）；
2. 选择 **格式**：Markdown / HTML / JSON；
3. 勾选要导出的 **轮次**（可全选/全不选，轮次多时可用过滤框按轮号或提示词搜索）；
4. 勾选要包含的 **事件类型**（可按需展开「高级选项」调整截断阈值等）；
5. 点击 **导出**，浏览器开始下载；弹窗保持打开，可以换一组选择继续导出。

导出的文件名由服务端生成：`dsh-session-<会话ID>-<YYYYMMDD-HHmm>.<扩展名>`（时间为 UTC）。

### 选择规则

- **未勾选的轮次**：完全不出现在导出结果中。
- **勾选了但被事件类型过滤为空**的轮次：Markdown / HTML 会跳过（文首摘要里写明跳过了几轮），JSON 会保留该轮并给出 `events: []`。
- **会话前导**：第一条 `turn/start` 之前的事件集合（权限预设、沙箱模式、审批策略这类会话级记录）。它的事件都属于「其他事件」，只勾「会话前导」而「其他事件」保持关闭时，这一段不会输出任何内容。会话如果没有前导事件，弹窗里不会出现这一行。
- **内容为空的消息**：例如只带图片、没有文字的消息，在「图片」关闭时不会输出。
- **轮次过多**：单次导出的轮次数量受 `maxTurns` 限制（默认 2000），超出时弹窗会提示先缩小选择范围。

### 导出格式说明

**Markdown**：文首是会话信息（ID、创建时间、工作目录、模型、选中轮次、导出时间），随后每轮一个 `## 轮次 N` 小节，事件按发生顺序排列；思考块用可折叠的 `<details>`；工具参数与结果用围栏代码块，并按内容自动加长围栏避免冲突。

**HTML**：单文件、内联样式、无外部资源，可直接发给别人或离线打开；跟随系统亮/暗主题；顶部有轮次目录；开启「HTML 内嵌图片」时图片以 data URI 内嵌（有总字节预算，超出部分回退为占位说明）。

> **消息内容怎么处理**
>
> - **用户消息放进代码块**（标记为 `text`）：提示词原样保留——包括它自带的 `#` 标题、列表、代码围栏、表格与行首缩进。外围反引号会**自动加长**（提示词里已有 ``` 就用 ````），所以提示词里的围栏既不会被解析，也不会吞掉后面的内容。
> - **AI 回复 / 注入上下文 / 思考过程**仍按 Markdown 渲染（列表、代码块、粗体等保留），但其中的标题会**自动降级**（`#` → `####`、`##` → `#####`），因此永远不会和导出自身的 `#` 标题、`## 轮次 N` 同级。

**JSON**：原始事件数组按选择过滤后输出，便于二次处理。事件对象保持会话日志原样（`type` / `seq` / `time` / `data`）。

```json
{
  "format": "dsh-session-transcript",
  "version": 1,
  "exportedAt": "2026-09-29T04:13:20.000Z",
  "generator": { "name": "dsh-session-export", "version": "0.2.0" },
  "selection": {
    "format": "json",
    "turns": [1, 2],
    "includePreamble": true,
    "sections": { "user": true, "assistant": true, "thinking": false, "…": false },
    "options": { "maxToolResultChars": 20000 }
  },
  "session": {
    "id": "session-…",
    "createdAt": 0,
    "cwd": "…",
    "model": { "provider": "…", "model": "…" },
    "title": "…"
  },
  "preamble": { "eventCount": 3, "events": [{ "type": "permission/preset", "seq": 0, "time": 0, "data": { "preset": "workspace-write" } }] },
  "turns": [
    {
      "turn": 1,
      "startSeq": 3,
      "endSeq": 11,
      "startedAt": 0,
      "endedAt": 0,
      "endReason": "completed",
      "open": false,
      "eventCount": 9,
      "events": [{ "type": "user/message", "seq": 4, "time": 0, "data": { "…": "…" } }]
    }
  ]
}
```

过滤规则：关闭「原始流记录」会删除 `data.stream`，关闭「Token 用量」会删除 `data.usage`，关闭「思考过程」「AI 回复」「工具调用」「图片」「文件附件」会从 `data.message.content` 中移除对应类型的块。

## 配置

可以在 profile 的 `cordis.patch.yml` 里按需覆盖默认值（bundle 层已经声明了 `session-transcript-export` 这一行，profile 的补丁层按 id 覆盖它即可）：

```yaml
- id: session-transcript-export
  name: 'dsh-session-export'
  config:
    maxTurns: 2000                  # 单次导出的轮次上限
    maxToolResultChars: 20000       # 工具结果 / 其他事件的截断阈值
    maxOutputBytes: 33554432        # 导出文件字节上限
    maxEmbeddedImageBytes: 8388608  # HTML 内嵌图片总预算
    defaultSections:                # 只写想改的键，其余保持默认
      thinking: true
      toolCalls: true
```

## 常见问题

| 问题 | 原因 / 处理 |
|---|---|
| 「插件」面板显示已安装，但会话头部没有导出按钮 | 包必须声明 `dsh.bundle` **并且**被登记进 profile 的 `dsh.profile.bundles`。面板安装会自动登记；手工 `pnpm add` 不会，需要自己补上（或改用 `node scripts/install.mjs --github`）。确认 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `dsh-session-export` |
| 面板提示无法访问 GitHub / 连接超时 | GitHub 地址和 `.tgz` 直链不经过安装源，需要本机能直接访问 `github.com`（或配置代理）。也可以先在别处 `git clone`，再用 `node scripts/install.mjs` 走符号链接安装 |
| 安装后行没生效 | 需要重新加载窗口（桌面端 Cmd/Ctrl+R，网页端刷新），新的客户端 bundle 才会进入 `window.__DSH_BOOT__` |
| 同一个行 id 被插入两次的报错 | profile 的 `cordis.patch.yml` 里还留着早期版本插入的 `session-transcript-export`；删掉那一行，或重跑一次 `node scripts/install.mjs` 让它自动迁走 |
| 勾了「会话前导」却什么也没有 | 前导事件全部属于「其他事件」，需要同时勾选「其他事件」 |
| 图片没有导出 | 「图片」默认关闭；另外只含图片的消息在关闭该开关时不会输出任何内容 |
| 某个轮次消失了 | 该轮勾选后被事件类型过滤为空，Markdown / HTML 会跳过（JSON 会保留 `events: []`） |
| 弹窗内出现红色错误提示 | 会话日志读取失败或会话已被清理；按提示调整后点「重试」，或关闭弹窗重开 |
| 只想导出最近几轮 | 点「全不选」后按轮号勾选，或在上方过滤框里按轮号/关键词筛选 |
| 提示词里带 `#`、代码块、表格，会变成导出文件的标题吗 | 不会。用户消息放在代码块里原样输出，这些语法不会被解析 |
| 导出后再导一次 | 弹窗不会关闭，换格式或换选择继续点「导出」即可 |

## 已知限制

- 一次只导出**当前会话**；子会话（subagent）不会递归导出，附件也不打包（Harness 自带的 `/export` 命令会导出 ZIP 归档）。
- 入口只有会话头部的导出按钮，不注册斜杠命令。
- HTML 里的 Markdown 渲染为内置子集（标题、围栏代码、引用、列表、分隔线、段落、行内代码/粗体/斜体/删除线/链接）；表格、脚注、数学公式、原始 HTML 会按转义文本输出。
- 导出会把会话日志读入内存，因此超大会话受「工具结果最大字符数」与产物字节上限约束。
- 轮次数量超过 `maxTurns` 时需要先缩小选择范围。
- 插件声明了对 `@deepseek-ai/dsh` 的可选 peer 版本区间（`peerDependenciesMeta.optional`，所以 pnpm 不会去安装它）。运行时版本落在区间外时，Harness 会**跳过**这一层 bundle 并提示授予精确版本豁免，而不是带着可能已变的 API 硬跑。

## 许可证

[MIT](LICENSE)
