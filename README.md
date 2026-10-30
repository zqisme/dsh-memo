# dsh-memo

DSH 的极简备忘录：左侧栏一个「备忘录」按钮，主面板一块自动保存的 Markdown 便签。
数据就是**一个普通文件**，用任何编辑器都能打开。

```
左侧栏「备忘录」 →  主面板
┌ 备忘录  已保存 18:20 · 1,240 字                       收起目录 ┐
├──────────┬──────────────────────────────────────────────────────┤
│ 目录      │                                                      │
│  索引     │   # 索引                                             │
│  提示词一 │                                                      │
│  提示词二 │   （正文栏最宽 820px，居中；再宽就两侧留白）           │
├──────────┴──────────────────────────────────────────────────────┤
│ ~/.dsh/memo/memo.md            Ctrl / ⌘ + S 保存 · 自动保存       │
└─────────────────────────────────────────────────────────────────┘
```

## 数据在哪

| 项 | 值 |
|---|---|
| 默认路径 | `~/.dsh/memo/memo.md`（Windows 即 `C:\Users\<你>\.dsh\memo\memo.md`） |
| 换成别处 | 启动前设环境变量 `DSH_MEMO_FILE=<绝对路径>` |
| 上限 | 单文件 1 MiB |

它跟着**你**走，不跟工作区走：换会话、换目录，备忘录都是同一份。

**不拆分文件**：所有内容都在同一个 `memo.md` 里，用 `##` 标题分节，左侧目录用来跳转。
好处是备份/同步/用别的编辑器打开都只有一份文件；代价是「删除某一条」得手动删那一段。

## 怎么用

- 点左侧栏「备忘录」，直接写。
- 停止输入约 0.7 秒自动保存；`Ctrl/⌘ + S` 立刻保存；失焦也会保存。
- 切到别的面板、关标签页时会尽力把未保存内容带出去（`keepalive` 请求）。
- 标题旁显示状态与字数：`保存中…` / `已保存 18:20 · 1,240 字` / `保存失败：<原因>`。
  失败时内容不丢，下次输入会重试。
- 正文里的 `#` / `##` / `###` 会出现在左侧目录：点一下跳到那一段，滚到哪里就亮哪一条。
  **代码块（``` 或 ~~~）里的 `#` 不算标题**。面板窄于 900px 时目录自动收起；
  右上角「收起目录 / 目录」随时能手动开合，点过一次之后按你的意思来。
- **新建一节**（目录栏顶部的 `+ 新建`）：在文末追加一节，自动切到单节模式并把标题选中，
  直接打字就能改名；新节立刻写盘，不等自动保存的计时器。单文件模型下「新建」只能是
  新建**节** —— 想改成「多个独立便签文件」是另一套数据模型。
  目录被收起、面板太窄或还没有任何标题时，这个按钮会回到标题行右侧。
  - **新节的级别跟着文档走**：跟「最后一个标题」同级。全用 `#` 分节的笔记新建出来是
    `# 新的一节`；`# 索引` 下面挂 `## 提示词` 那种「壳 + 子项」结构，新建出来是 `##`
    （这类结构里写 `##` 才对：`#` 级区间会一路吃到下一个 `#`，硬塞 `##` 会被上一个
    `#` 节吞掉，根本不算独立的一节）。文首还没有任何标题时用 `#`。
- **只看单节**：**默认就是这个视角** —— 点进面板只显示目录里选中的那一节，点目录换节。
  想通读全篇点标题行的「看整篇」。改动会立刻拼接回整篇 ——
  内存里始终只有一份正文，文件结构不变。
  一节的范围是「它的标题行」到「下一个同级或更高级标题」之前，所以 `##` 节会把下面的
  `###` 小节一起带上。
  - 没选过时落在第一节；但如果全篇只有一个 `#` 级标题（比如 `# 索引`），它会一路覆盖到
    文末，那算「整篇的壳」而不是一节，于是默认落到它下面第一个 `##` —— 否则「只看单节」
    看起来和整篇没区别。
  - 标题之前那段没有归属的前导文字跟着第一节走：单节视图里不会出现「看不见但还在文件里」的字。
- **这个选择会被记住**：切到「看整篇」后下次进来还是整篇，切回单节同理。偏好存在浏览器
  `localStorage`（键 `dsh-memo:prefs`），所以只影响这一个浏览器，清站点数据会回到默认的单节。
  正文不在里面 —— 永远只有 `memo.md` 那一份。

## 安装

前提：DSH ≥ 0.2.1-rc.2，且有一个带 Web 界面的 profile（默认名字 `web`）。

**别的设备（从 GitHub 装，不用 clone）**

```powershell
# 1. 确认/创建 profile（已存在会直接成功）
dsh --profile web --from-default-profile web --dump-config > $null

# 2. 从仓库装
dsh plugin --profile web add "git+https://github.com/zqisme/dsh-memo.git"

# 3. 登记到 bundle 清单（pnpm 只放 node_modules，这一步才会应用本包的 cordis.patch.yml）
node "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-memo\tools\patch-profile.mjs" "$env:USERPROFILE\.dsh\profiles\web\package.json"
```

然后**重启** `dsh web`：客户端 bundle 是启动时读取并缓存的，热改磁盘不会生效。

**本机改代码时（link 方式，改完即生效只要重启）**

```powershell
$pr = "$env:USERPROFILE\.dsh\profiles\web"
dsh plugin --profile web add "link:C:/path/to/dsh-memo"
node C:/path/to/dsh-memo/tools/patch-profile.mjs "$pr\package.json"
```

装完检查：`dsh --profile web --dump-config` 的组合配置里应该出现 `id: memo`。

卸载：

```powershell
dsh plugin --profile web remove dsh-memo
# 再把 package.json 的 dsh.profile.bundles 里的 "dsh-memo" 删掉
```

数据不会被卸载动到 —— 想清掉就自己删 `~/.dsh/memo/`。

## 结构

```
package.json          dsh.bundle.patch + dsh.client（platform: web）
cordis.patch.yml      bundle 层：插入 id: memo 这一行
lib/index.js          Host 半边：一条路由，读/写一个固定文件
lib/client.js         客户端半边：手写模块表产物，注册侧栏按钮 + 主面板
test/                 Host 与客户端的自测（不依赖 DSH 进程）
tools/patch-profile.mjs  把包登记进 profile 的 dsh.profile.bundles
```

**没有构建步骤**：`lib/client.js` 直接就是 `window.__ModuleLoader__.load({ id, factory })`
的工厂格式（与官方 `dsh-client-ui-*` 的产物同协议），运行时只 `require('react')`，
由平台提供的模块表解析。所以改完代码不需要 tsc / esbuild，只要重启 DSH。

## 设计上的几个取舍

**路由没有路径参数。** 客户端不能告诉宿主「读哪个文件」——路径在服务端算好。
没有路径参数就没有 `../` 穿越面，也没有「把根目录传宽一点」这类问题。

**自己立围栏。** `webServer` 本身不做鉴权（官方文档原话：*No server-wide
authentication or origin policy*），所以这条路由自己校验：socket 必须回环、
`Host` 头必须指向回环、拒绝 `sec-fetch-site: cross-site`、`Origin` 必须同源。
跨站页面因此改不动你的备忘录。

**但这条路由在 `dsh web` 的 token 门之外。** `/api/*` 的 token 校验由
`@deepseek-ai/dsh-client-connection` 负责，本插件的路由直接挂在 `webServer` 上，
所以本机进程（curl / 脚本）不带 token 也能读写这个文件。考虑到「本机进程本来就能
直接读写 `~/.dsh/memo/memo.md`」，这个边界是一致的；但如果你以后把它改成写别处
的敏感文件，记得先把这层补上。

**原子写。** 先写同目录临时文件再 `rename`，中途失败不会留下半个备忘录。

**单个文件，不做冲突合并。** 两个窗口同时改，后保存的覆盖先保存的（与直接用
编辑器改同一个文件一样）。真需要多端同时编辑，那该用 Git 或别的工具。

## 自测

```powershell
node test/host.test.mjs     # 路由登记、读写往返、跨站/局域网拒绝、方法与载荷校验
node test/client.test.mjs   # 工厂格式、两个槽位注册、面板渲染一遍不抛错
```

两个脚本都不启动 DSH，可以直接跑。

## 已知边界

- 只支持纯文本 / Markdown 编辑，不做预览渲染（要预览用左侧「文件」面板或笔记类插件）。
- 没有多文件、标签页、置顶、搜索 —— 那些是「笔记」应用的事，这里刻意只做一块便签。
- 大小上限 1 MiB；超了界面会明确报错，不会静默截断。

## 发布 / 迁移到别的设备

见 [PUBLISH.md](./PUBLISH.md)：DSH 插件契约（槽位名、客户端 bundle 格式、路由围栏）、
上传 GitHub 前要替换的占位符、其他设备的三步安装命令。
