# 🐱 Tavern Cat

> 在 **SillyTavern（酒馆）** 里直接连接 **NapCatQQ** 机器人（OneBot 11 WebSocket），
> 把 QQ 群 / 好友消息接进酒馆的角色扮演对话，让酒馆生成的角色回复自动发回 QQ —— **全程无需任何第三方中转**
> （不需要 langbot / go-cqhttp / 反向代理这类中间层，酒馆页面本身就是 OneBot 客户端）。

```
QQ 群/好友 ──QQ协议──> NapCatQQ（机器人账号本体）
                          │  OneBot 11 WS   ws://127.0.0.1:2333
                          ▼
            酒馆页面（Tavern Cat，浏览器内 WebSocket 客户端）
                          │
                          ▼
        SillyTavern 角色扮演（每个 QQ 会话 = 独立角色 + 独立聊天文件）
```

- ✅ 安装方式：把本仓库地址粘贴到酒馆 **Extensions → 安装第三方扩展**（或手动复制文件夹）
- ✅ **多会话全自动**：每个 QQ 群 / 好友 = 独立角色 + 独立上下文，互不串线
- ✅ **基础/进阶两级设置**：魔法棒菜单「基础设置」只管日常连接与触发；「进阶设置」管理会话绑定、白名单、日志等
- ✅ **魔法棒直接看连接状态**：菜单项带实时状态圆点（绿=已连接 / 黄=重连中 / 灰=未连接）
- ✅ 群聊默认 @机器人 / 回复机器人 触发（可改为只 @ 或群里全回）；私聊直接回，可配白名单
- ✅ 自动重连（指数退避 + 心跳看门狗）、长回复自动分块、引用回复、开场白、双向同步、防死循环
- ✅ QQ 侧斜杠指令：`/帮助` `/角色列表` `/角色 <名称>` `/重置` `/状态` `/关闭` `/开启`

## 📦 安装

### 方式 A：通过酒馆扩展面板直接拉取（推荐）

1. 先把本仓库推到你的 GitHub（仓库根目录就是扩展本体，见下方「发布到 GitHub」）；
2. 酒馆页面 → **Extensions** 面板 → **Install extension**（安装第三方扩展）→ 粘贴仓库地址
   `https://github.com/<你的用户名>/TavernCat` → 安装；
3. 刷新酒馆页面（先关标签页再重开）。

### 方式 B：手动复制

把整个仓库内容复制为：

```
<SillyTavern>/public/scripts/extensions/third-party/TavernCat/
```

（或用户数据目录 `data/<用户名>/extensions/TavernCat/`，本地目录优先），然后刷新酒馆页面。

> 兼容性：基于 SillyTavern **1.18.0（release）** 的新扩展体系（`manifest.json` + ESM + `hooks.activate`）。
> 页面里看不到入口时，先确认 ST 版本 ≥ 1.13 并查看浏览器控制台报错。

## 🚀 使用

1. **NapCat 侧**：WebUI → 网络配置 → 新建 **WebSocket 服务器**：`enable=true`、端口 `2333`、
   消息格式 `array`、Token 可留空（留空最省事，想加密就设一个并在下面填写）。改完重启 NapCat。
2. **酒馆侧**：点页面顶部 **魔法棒** → `Tavern Cat · 基础设置`：
   - WS 地址保持 `ws://127.0.0.1:2333`，Token 与 NapCat 一致（没设就留空）
   - 可选：选「新会话默认角色」、勾「自动连接」
   - 点 **连接** → 圆点变绿即成功
3. **开聊**：另一个 QQ 私聊机器人；或把机器人拉进群 **@它**。首次会话自动发角色开场白。
4. 更多：`Tavern Cat · 进阶设置` 里管理会话绑定表（换角色/暂停/解绑）、私聊白名单、日志等。

> 网页必须是 `http://`（浏览器禁止 https 页面连接本地明文 ws）。

## 🎮 QQ 斜杠指令

| 指令 | 说明 |
|---|---|
| `/帮助` | 指令列表 |
| `/角色列表` | 列出可选角色 |
| `/角色 <名称或序号>` | 切换本会话角色（对话各自存档，可随时切回） |
| `/重置` | 清空本会话上下文，开新对话 |
| `/状态` | 查看本会话绑定与开关 |
| `/关闭` / `/开启` | 暂停 / 恢复本会话 |

群聊里需先触发机器人（@/回复）再发指令；私聊直接发。

## 📁 仓库结构

```
TavernCat/                    # 仓库根目录 = 扩展本体（ST 直接拉取即用）
├─ manifest.json              # 扩展清单
├─ index.js                   # 酒馆胶水层：TavernHost、基础/进阶面板、魔法棒状态点、双向转发
├─ settings.html / style.css  # 进阶面板与样式
├─ core/
│  ├─ onebot.js               # OneBot11 WS 客户端（浏览器/Node 通用）
│  ├─ cqcode.js               # CQ 码转义 / 解析 / 纯文本提取
│  ├─ triggers.js             # 消息归一化 + @/回复触发判定
│  └─ bridge.js               # 编排核心（与 ST 解耦，可单测）
├─ tests/                     # Node 端到端测试（fake NapCat + 桩酒馆宿主）
└─ README.md / LICENSE
```

## 🧪 开发与测试

核心逻辑与 SillyTavern 解耦（`TavernHost` 接口），纯 Node 即可全链路测试：

```bash
cd tests
npm install      # 仅 devDependency：ws（模拟 NapCat 用）
npm test         # 19 个用例：CQ 码 / WS 客户端 / 触发策略 / 指令 / 分块 / 白名单 / 转发…
```

## 🚢 发布到 GitHub（让酒馆能直接拉取）

```bash
# 本仓库已经 git init 好并打好首个 commit，直接推：
git remote add origin https://github.com/<你的用户名>/TavernCat.git
git push -u origin main

# 以后改完：在 <SillyTavern>/public/scripts/extensions/third-party/TavernCat 下
git pull   # （如果你通过 ST 装的，ST 扩展管理里点“更新”即可）
```

仓库要求：

- 仓库**根目录就是扩展本体**（`manifest.json` 在根，不要套一层子文件夹）——本仓库已按此布局；
- 建议仓库名就叫 `TavernCat`（酒馆会把扩展装到 `third-party/TavernCat/`）。

## ⚠️ 行为细节与限制

- 每个 QQ 会话在酒馆里对应「一个角色 + 一个聊天文件」；绑定存 `extension_settings`，聊天文件头 `chat_metadata.qq` 双向打标。
- 多群并发消息**串行排队**处理，避免生成错乱；酒馆自身生成时会等待其空闲。
- 自动回复需要**酒馆页面保持打开**（桥在页面里跑）；处理回合期间前台聊天会被切到目标会话。
- 注入的 QQ 消息带 `extra.qq` 标记防回推死循环；酒馆→QQ 只转发无标记的手动消息与手动回合回复。
- 同账号只开**一个**酒馆页面，多开会重复消费消息。
- 图片/语音/表情等非文本会转为 `[图片]`/`[语音]` 等占位参与对话；@ 机器人本体的提及会从正文剥离（`@10001…` 不会灌进提示词）。

## 📄 License

MIT
