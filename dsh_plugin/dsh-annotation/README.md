# @local/dsh-annotation

原位批注：在对话正文里选一个词，基于**当前这段对话**生成解释，写进工作区的笔记文件，并把这个词**原地**变成指向该笔记的链接。当前会话不新增任何消息、不触发对话轮次。

## 交互

1. 在对话正文里选中一个词（或短语）。
2. 松手即出浮层，**光标已经在输入框里**，可以直接打字：`[可写要求] [解释「词」] · 回车解释 · Esc 取消`
   - 选区旁自动浮出（无需点击输入框）
   - 快捷键 `Alt+Shift+E`
   - 在选区上**右键**

   **输入框是可选的**：留空直接回车 / 点「解释」= 按默认逻辑；写了要求（如「对比一下它和缓冲区的区别」）= 按你的要求生成。
3. 插件把 `会话 + 该消息 + 该词 + 上下文` 发给 Host；Host 调一次模型，把解释写进**该词自己的文件** `<工作区>/notes/注解/<词>.md`，并把批注记录写入 `$DSH_HOME/annotations/<sessionId>.json`。
4. 右侧栏立刻打开这个词的笔记并定位到这一条；这个词在原位置变成带下划线的链接。
5. 刷新页面/切换会话再回来，链接由批注表重新贴回原词——只匹配文字，不依赖任何 hash 过的 class 名。

**人工提示词**会作为 `user_request` 交给模型，并且写进笔记：

```md
## 语境 2

> 语境：…**背压**… · 2026-11-01 23:40
> 你的提问：对比一下它和缓冲区的区别

<按这条要求生成的解释>
```

提示词只用于**约束这次解释的角度**，不会把插件变成通用问答：system prompt 仍要求"只围绕选中的词展开"。留空时请求里根本没有 `user_request`，与之前完全一致。

输入框抢走光标之后还有两个细节：

- **选中的词仍然高亮**。焦点进 input 会让浏览器丢掉原生选区，所以插件用 CSS Custom Highlight（`::highlight()`，Chrome 105+/Safari 17.2+，不支持就自动跳过）把那段 range 重新画出来，你随时知道自己选的是哪几个字。
- **Cmd/Ctrl+C 照常复制**。输入框为空时按复制键，复制的是你选中的那段文字，然后浮层关掉——不会因为光标在输入框里就复制了个空。

**一词一文件**：`响应式` 与 `非阻塞` 分别落到 `notes/注解/响应式.md`、`notes/注解/非阻塞.md`。同一个词在不同语境里再批注一次，**不新建文件**，而是在该词文件里追加 `## 语境 2`，链接定位到对应小节。这样笔记数量增长时仍然一术语一页，而不是一个越写越长的总表。

同一个词被批注过一次后，再次点击它只会打开笔记；想重新解释，选中后重走一次即可。

## 安装与生效

在本机（已经装了 DSH 的开发机）：

```sh
node install.mjs                     # 装进 $DSH_PROFILE，否则 web
node install.mjs --profile desktop   # 装进另一个 profile
node install.mjs --dry-run           # 只打包、打印命令，不动 profile
```

`install.mjs` 是唯一的安装实现，Windows / macOS / Linux 跑的是同一份代码（POSIX 用户可以用 `./install.sh`，它只是转发）。

也可以从 GUI 的插件管理器装：`plugin_manager install_bundle target=<绝对路径>/plugins/dsh-annotation`。

- 客户端半边改动：**刷新页面**即生效（服务端按文件 mtime 生成新的 revision URL）。
- Host 半边（`index.js`）改动：需要**重启 `dsh web`** 才会换成新的模块代际；客户端会跟随 Host，无需单独处理。

## 换一台电脑（可移植性）

这个包**没有运行时依赖、没有构建步骤、没有原生模块**，`index.js` 和 `client.js` 是纯 ESM/浏览器 JS。
所以同一份 tarball 在任何装了 DSH 的机器上都能装，不需要源码 checkout，也不需要和 DSH 版本一起编译。

### 放到 GitHub 上

这个目录本身就是**一个完整、自包含的 npm 包**，可以直接当作一个独立仓库的根推上去。仓库里已经有 `.gitattributes`
（强制 LF、把 `*.tgz` 标成二进制，避免 Windows 检出改坏行尾）。

推上去之后，公司机器上装：

```sh
git clone https://github.com/<你的用户名>/<仓库>.git
cd <仓库>\dsh_plugin\dsh-annotation      # 包所在的目录，可以在任何深度
node install.mjs
```

`install.mjs` 按**脚本自身位置**工作（会往上找 4 层 DSH checkout），所以包放在仓库的任意子目录都能装。

> `dsh plugin add github:<用户名>/<仓库>` 这条直装**只认仓库根就是包**（`package.json` 在根）。
> 本包是放在 `dsh_plugin/dsh-annotation/` 子目录里的，所以用上面的 clone + `node install.mjs`。
> 如果你想用直装，就单独建一个仓库、把包的内容放在根。

`dsh-annotation-1.2.0.tgz` 是可选的**预打包产物**：方便在本机没有 pnpm/git 时一个文件搞定，但它会随源码改动而过期。
建议二选一——要么不提交 tgz（谁都现打），要么每次改完重新生成：

```sh
pnpm --dir plugins/dsh-annotation pack --pack-destination plugins   # 产出的 tgz 去掉 scope 前缀即可
```

**做法：把整个 `dsh-annotation/` 目录带过去（U 盘 / 内网 git / scp 均可），然后：**

```sh
cd dsh-annotation
node install.mjs        # 默认装进 web profile
```

等价的手工两步（任何平台）：

```sh
pnpm pack --pack-destination <某个目录>          # 产出 local-dsh-annotation-<版本>.tgz
dsh plugin --profile web add <那个目录>/local-dsh-annotation-<版本>.tgz
```

`dsh plugin add` 会把 tarball 复制进 profile 的包存储，并把 `@local/dsh-annotation` 加进
`<DSH_HOME>/profiles/<profile>/package.json`（Windows 上是 `%USERPROFILE%\.dsh\profiles\<profile>\`）的 `dsh.profile.bundles`。**装完之后源目录可以删掉**，
profile 不再依赖它（和源码 checkout 里的 `link:` 安装不同）。装完重启 dsh + 刷新页面。

### Windows 11 专节

这台机器多半是 PowerShell 或 Windows Terminal，上面所有命令**原样可用**（`node install.mjs` 不依赖 bash）：

```powershell
cd D:\dsh-annotation
node install.mjs
node install.mjs --profile desktop      # 桌面端
node install.mjs --dry-run
```

Windows 上已经处理掉的四件事：

| 问题 | 处理 |
|---|---|
| 文件名非法字符 | 词的 `/ \ : * ? " < > \| # %` 会被换成 `-`，空白折成 `-` |
| 保留设备名 | `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` 不能做文件名，这类词自动落成 `term-<8位摘要>.md` |
| 路径长度 | 文件名截断到 60 字符；`<cwd>/notes/注解/<词>.md` 正常远低于 260 |
| `.cmd` 启动不了 | `dsh`/`pnpm` 在 Windows 上是 `.cmd` 垫片，`spawn` 直接调用会失败；安装脚本改走 `cmd.exe /d /s /c` 并自己按 `CommandLineToArgvW` 规则转义，路径里有空格也不会断 |

另外三点 Windows 事实：

- `%USERPROFILE%\.dsh` 就是 `DSH_HOME`，批注表在 `%USERPROFILE%\.dsh\annotations\<sessionId>.json`，不需要配置。
- 笔记地址内部统一用 `/` 存储（`notes/注解/响应式.md`），Host 用 `node:path` 交叉处理，右侧栏定位不受盘符/反斜杠影响。
- 大小写不敏感的 NTFS：`Foo` 和 `foo` 会落到同一个文件，`termFileIn()` 发现既有文件标题不同就自动加摘要后缀，不会把两个词混进一个文件。

### 装之前要确认的四件事

| 项 | 怎么确认 | 不满足会怎样 |
|---|---|---|
| `dsh` 命令可用 | `dsh --version`（Windows 上 `dsh.cmd` 同样可以）；源码 checkout 里脚本会自动退回 `pnpm -s dsh` | 脚本直接报错退出，并打印手工两步 |
| profile 名 | Web 应用是 `web`；桌面端是 `desktop`（桌面端要先打开一次应用初始化 profile） | 装到了别的 profile，界面里看不到 |
| DSH 版本兼容 | 见下节 | 不兼容时控制台 15 秒后会有一条明确警告，不会静默失效 |
| **pnpm 在 PATH 上** | `pnpm --version`；没有就 `npm i -g pnpm` | `dsh plugin add` 内部调用 pnpm，缺了会直接失败 |

### 兼容性

本插件只用到 DSH 的**公开服务**和**渲染器发布的 DOM 锚点**，不 import 任何 `@deepseek-ai/*` 包，
也不改 DSH 源码。开发和验证基于 **DSH 0.2.0-rc.2**（`deepseek-harness` checkout，session 格式 v4）。

回到 Host 侧依赖：

| 侧 | 依赖 | 用途 |
|---|---|---|
| Host | `webServer` / `llm` / `connection` / `agentDefaultModel`（可选） | 注册两条路由、一次性模型调用、鉴权栅栏、默认模型 |
| Client | `sessions` / `sidebarRight` / `locale` | 取会话 cwd、在右侧栏开文件、界面文案 |
| Client DOM | `[data-chat-flow]`、`[data-chat-node-key]`、`[data-conversation-session]` | 定位对话列、一条消息、当前会话 |

如果公司机器的 DSH 更新后改了对话 DOM 的锚点，插件会**在浏览器控制台明确报警**（`transcript anchor "[data-chat-flow]" never appeared`），
而不是装作没事。此时要改的是 `client.js` 顶部那三个选择器常量。

### 公司网络要注意的

- 安装**不需要联网**：本地 tarball 安装，`pnpm add <本地路径>` 不走 registry（包本身零依赖）。
- 插件**不发任何网络请求**，除了你自己页面对 `/annotation/list`、`/annotation/explain` 的两个同源请求。
- 解释走的是**当前 profile 配置的模型**；公司机器模型不同也没关系，想固定就用配置里的 `provider` / `model`。
- 笔记写在**会话工作目录**，不写 profile、不写仓库；跨机器不会串。


## 为什么不是「新开一个 session」

DSH 里没有“改写已渲染消息里某个词”的通道，也没有注解载荷。所以解释**不进入任何 session**：`ctx.llm.stream()` 以 `sessionId` 缺省的方式调用，唯一产物是笔记文件和批注表。这同时满足两条硬边界——主导权在人（只有人选中才触发）、当前会话零新增内容。

## 实现要点（便于以后维护）

| 位置 | 职责 |
|---|---|
| `index.js` | 两条 Host 路由（`/annotation/list`、`/annotation/explain`）、模型调用、笔记追加、批注表读写 |
| `client.js` | 选区读取、浮动触发、DOM 注入链接、重渲染后重新贴回 |

- **鉴权**：两条路由都先问 `connection.requestRejection(req)`；该服务不可用时直接 503，绝不裸奔。整条链路走浏览器同源 cookie，页面里是普通 `fetch`。
- **写盘范围**：笔记路径恒为 `<cwd>/<notesFile>`，`notePathFor()` 拒绝任何越出工作区的配置。
- **找词**：批注记录存 `data-chat-node-key`（由 `turn:step` / `MessageId` 等持久 id 派生，刷新不变）＋词两侧各 60 字符的指纹。渲染重建后先按 node key 定位，再按指纹在文本里检索，最后按字符偏移包裹 DOM。指纹对不上时退化为只按词检索，所以流式渲染期间（那时 DOM 里还留着未解析的 `**`）标注的词，settle 之后照样能找回。
- **加载必须重试**：页面可能比 Host 行先就绪——重启 `dsh web` 后立刻刷新时，首次 `annotation/list` 会拿到 SPA 回退的 index.html（200 但不是 JSON）。这类失败会按 250ms→5s 退避一直重试，绝不把"读不到"当成"没有批注"。
- **贴回也会重试**：暂时找不到文字的词按 5s 起、60s 封顶的退避持续重试，而不是静默放弃。
- **不打架**：`MutationObserver` 只看 `document.body`，插件自身写入时置 `mutating` 并 `takeRecords()`；两次重建之间至少间隔 500 ms，避免流式输出时抖动。
- **不占槽位**：不注册任何 slot，不改 React 树，全部通过 `div[data-chat-flow]` / `[data-chat-node-key]` 这两个渲染器发布的锚点工作。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `notesDir` | `notes/注解` | 相对工作区；目录不存在会自动创建，每个词一个 `.md` |
| `maxTokens` | `3000` | 解释的输出上限 |
| — | — | 右键提示词上限 800 字符；输入框本身就限长，Host 收到超长值直接 400 |
| `timeoutMs` | `120000` | 单次调用超时，同时用于页面断开时的中止 |
| `provider` / `model` | 缺省 | 同时给出才生效；否则用 profile 的默认模型选择 |

## 已知限制

- DOM 注入的固有代价：React 重渲染会冲掉链接，由观察器补回（一般在一个动画帧内）。滚动中不会闪烁，但会看到一次极短的重绘。
- 折叠的思考过程行是 `hidden="until-found"`，其文本在 DOM 里但不可见；对它做批注不会报错，只是看不见链接。
- 插件只追加不整理：同名小节不会去重，`## 语境 N` 按写入顺序编号。想清空就删掉 `notes/注解/` 并删除对应的 `$DSH_HOME/annotations/<sessionId>.json`。
- 文件名由词净化而来（去掉 `/ : * ? " < > | # %`、空白折成 `-`、上限 60 字符）；两个不同的词净化后撞名时，后一个自动加 8 位摘要后缀，绝不混进同一个文件。
- 目前不支持删除单条批注。
