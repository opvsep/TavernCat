// Tavern Cat —— SillyTavern 扩展（酒馆端胶水层）
// 让酒馆直连 NapCatQQ（OneBot 11 WebSocket），把 QQ 群/好友消息接进角色扮演对话。
// 目录：public/scripts/extensions/third-party/<TavernCat>/ （GitHub 仓库根目录即扩展本体）
//
// 职责：把 core/ 里的纯逻辑桥接到 SillyTavern 页面：
//   - 实现 TavernHost 接口（聊天切换/注入/生成/开场白）
//   - 维护连接（OneBotClient）
//   - 魔法棒菜单：基础设置 / 进阶设置 两个入口，入口与面板实时显示连接状态
//   - 监听酒馆本地收发事件，回推给绑定的 QQ 会话
//
// 兼容目标：SillyTavern 1.18+（manifest + ESM + hooks.activate 扩展体系）
// 注意第三方扩展比内置扩展深一层目录，所有相对导入都要多一个 ../

import { event_types, eventSource } from '../../../events.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { waitUntilCondition } from '../../../utils.js';
import { is_group_generating } from '../../../group-chats.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';
// 不依赖酒馆的 callGenericPopup/Popup：其内部 DOM 结构随版本变化且尺寸难控，
// 设置窗口由本扩展自绘（openAdvancedPanel），保证 800x600 稳定呈现。
// 注意：script.js 主模块（酒馆 hub）不静态导入——某版本若缺其中任一导出会导致扩展整体加载失败、界面静默无入口。
// 改为 init() 中动态 import 并逐个检查（loadTavernHub），引用一律走 hub.xxx（ESM namespace 为 live 绑定）。
import { OneBotClient } from './core/onebot.js';
import { NapcatBridge, DEFAULT_SETTINGS } from './core/bridge.js';

const APP_NAME = 'Tavern Cat';
const MODULE = 'tavernCat';
// 目录名自适应：无论把本扩展目录改叫什么名字，资源路径都能正确解析
const EXT_ID_MATCH = /scripts\/extensions\/(third-party\/[^/]+)\/index\.js/.exec(import.meta.url);
const EXT_ID = EXT_ID_MATCH ? EXT_ID_MATCH[1] : 'third-party/TavernCat';
// NapCat 官方 logo（GitHub camo 直链）
const LOGO_URL = 'https://camo.githubusercontent.com/b1e872f1bb3e3cfba16a94dee84ae17fb9fc9038a95b04e1538cc88a4ee92507/68747470733a2f2f6e61706e656b6f2e6769746875622e696f2f6173736574732f6e65776e65776c6f676f2e706e67';

const DEFAULT_CONFIG = {
    wsUrl: 'ws://127.0.0.1:2333',
    token: '',
    autoConnect: false,
    defaultCharacterKey: '',
    ownerIdsText: '',
    ...DEFAULT_SETTINGS, // mapping/bindings/peerEnabled/groupMode/replyQuote/greetNewChat/maxReplyChars
};

let bot = null;            // 当前 OneBotClient
let bridge = null;         // 桥接编排核心
let host = null;           // TavernHost 实现
let injectingUser = false; // 正在注入 QQ 用户消息（避免 MESSAGE_SENT 回推）
let advancedEl = null;     // 当前打开的设置弹窗容器（基础/进阶为同一弹窗的标签页）
let lastStatus = { connected: false, selfId: null };
const logLines = [];
const MAX_LOG = 300;
const menuDots = [];       // 魔法棒菜单里的状态圆点 <span>
let statsTimer = null;
let hub = null;            // 酒馆主模块（script.js）命名空间，init 时动态加载；hub.xxx 实时反映酒馆状态
const HUB_KEYS = [
    'chat_metadata', 'characters', 'doNewChat', 'Generate', 'getCurrentChatId',
    'is_send_press', 'openCharacterChat', 'saveChatConditional',
    'saveSettingsDebounced', 'selectCharacterById', 'sendMessageAsUser',
];
let missingHubApi = [];    // 当前酒馆版本缺失的 API（用于友好提示）

// ---------------- 配置读写 ----------------

function config() {
    return extension_settings[MODULE];
}

function persist() {
    if (hub?.saveSettingsDebounced) hub.saveSettingsDebounced();
}

/** 动态加载酒馆主模块并校验关键 API：缺失项进 missingHubApi 供 UI 提示，不让扩展整体崩溃 */
async function loadTavernHub() {
    try {
        hub = await import('../../../../script.js');
    } catch (err) {
        console.error(`[${APP_NAME}] 酒馆主模块加载失败：`, err);
        hub = null;
    }
    missingHubApi = [];
    if (hub) {
        for (const key of HUB_KEYS) {
            if (!(key in hub)) missingHubApi.push(key);
        }
    } else {
        missingHubApi = [...HUB_KEYS];
    }
    if (missingHubApi.length > 0) {
        console.error(`[${APP_NAME}] 当前酒馆版本缺少 API：${missingHubApi.join(', ')}（需 SillyTavern 1.18+）`);
    }
}

function parseOwnerIds(text) {
    const ids = new Set();
    for (const part of String(text ?? '').split(/[\s,，、/;；]+/)) {
        const n = Number(part);
        if (Number.isInteger(n) && n > 0) ids.add(n);
    }
    return [...ids];
}

// ---------------- 日志 / 通知 ----------------

function pushLog(level, text) {
    const time = new Date().toLocaleTimeString();
    logLines.push(`[${time}] ${level === 'error' ? '✖' : '•'} ${text}`);
    if (logLines.length > MAX_LOG) logLines.shift();
    const box = advancedEl?.querySelector('#ncb_log');
    if (box) {
        box.textContent = logLines.join('\n');
        box.scrollTop = box.scrollHeight;
    }
}

function notify(kind, text) {
    try {
        if (kind === 'error') toastr.error(text, APP_NAME);
        else toastr.info(text, APP_NAME);
    } catch { /* 忽略 */ }
}

// ---------------- TavernHost ----------------

function charKeyOf(id) {
    const c = hub.characters[Number(id)];
    return c ? String(c.avatar) : null;
}

function findCharIndex(characterKey) {
    return hub.characters.findIndex((c) => String(c.avatar) === characterKey);
}

/** 该聊天名是否已被任何 QQ 会话绑定（mapping/bindings 中出现即“有主”） */
function isChatNameBoundElsewhere(chatName, characterKey) {
    try {
        const cfg = config();
        const refs = [];
        for (const b of Object.values(cfg.mapping ?? {})) refs.push(String(b?.chatName ?? ''));
        for (const map of Object.values(cfg.bindings ?? {})) {
            for (const cn of Object.values(map ?? {})) refs.push(String(cn ?? ''));
        }
        return refs.some((cn) => cn && cn === chatName);
    } catch {
        return false;
    }
}

function buildHost() {
    return {
        isReady: () => hub.characters.length > 0,

        listCharacters: () => hub.characters.map((c) => ({ key: String(c.avatar), name: c.name })),

        current: () => {
            const ctx = getContext();
            return {
                characterKey: ctx.characterId !== undefined && ctx.characterId !== null
                    ? charKeyOf(ctx.characterId)
                    : null,
                chatName: hub.getCurrentChatId() ?? null,
                peerKey: hub.chat_metadata?.qq?.peerKey ?? null,
            };
        },

        /**
         * 切到 (characterKey, chatName)。chatName=null 时新建聊天。
         * 返回 {chatName, created}
         */
        switchTo: async (characterKey, chatName, peerKey) => {
            const idx = findCharIndex(characterKey);
            if (idx < 0) throw new Error(`角色不存在（可能尚未加载或已删除）: ${characterKey}`);
            const ctx = getContext();
            const curId = ctx.characterId === undefined || ctx.characterId === null || ctx.characterId === ''
                ? -1 : Number(ctx.characterId);
            pushLog('info', `[trace] switchTo key=${characterKey} chatName=${chatName ?? '(新建)'} curId=${curId} 目标idx=${idx}`);

            if (curId !== idx) {
                // hub.selectCharacterById 在酒馆保存繁忙时会静默返回：必须校验 + 重试
                let switched = false;
                for (let attempt = 0; attempt < 5 && !switched; attempt++) {
                    pushLog('info', `[trace] selectCharacterById 尝试 ${attempt + 1}`);
                    try {
                        await waitUntilCondition(() => !hub.is_send_press && !is_group_generating, 10000, 100);
                    } catch { /* 继续尝试 */ }
                    await hub.selectCharacterById(idx);
                    const afterId = getContext().characterId;
                    switched = afterId !== undefined && afterId !== null && String(afterId) === String(idx);
                    if (!switched && attempt < 4) await new Promise((r) => setTimeout(r, 300));
                }
                if (!switched) throw new Error('切换角色失败（酒馆忙或正在保存），请稍后再试');
                pushLog('info', `[trace] 角色切换完成，当前 chat=${hub.getCurrentChatId() ?? '(空)'}`);
            }

            let created = false;
            if (!chatName) {
                // 若切换后角色已停留在一个“无主的新空聊天”上（酒馆 ST 自动放过开场白/用户刚新建），
                // 直接复用它作为绑定目标，避免再 doNewChat 造成“两个文件”
                const curChat = hub.getCurrentChatId();
                const ctxNow = getContext();
                const freshUnbound = curChat
                    && (ctxNow.chat?.length ?? 0) <= 1
                    && !isChatNameBoundElsewhere(curChat, characterKey);
                if (freshUnbound) {
                    chatName = curChat;
                    created = true;
                    pushLog('info', `[trace] 复用无主新聊天 ${chatName}（不再新建）`);
                } else {
                    const stackLine = (new Error()).stack?.split('\n').slice(2, 4).join(' ← ') ?? '';
                    pushLog('info', `[trace] ★ doNewChat 将被调用（调用方：${stackLine.trim()}）`);
                    await hub.doNewChat();
                    chatName = hub.getCurrentChatId();
                    pushLog('info', `[trace] doNewChat 完成 -> chat=${chatName}`);
                    if (!chatName) throw new Error('新建聊天失败');
                    created = true;
                }
            } else if (hub.getCurrentChatId() !== chatName) {
                // 先确认聊天文件真的还在（可能已被删除），避免把会话绑到幽灵文件
                if (!(await this.chatFileExists(characterKey, chatName))) {
                    throw new Error(`聊天文件已不存在：${chatName}`);
                }
                pushLog('info', `[trace] openCharacterChat -> ${chatName}`);
                await hub.openCharacterChat(chatName);
                if (hub.getCurrentChatId() !== chatName) throw new Error(`打开聊天失败: ${chatName}`);
            }

            // 打上“绑定到哪个 QQ 会话”的聊天级标记（随聊天文件存盘）
            if (peerKey && hub.chat_metadata?.qq?.peerKey !== peerKey) {
                hub.chat_metadata.qq = { peerKey };
                await hub.saveChatConditional();
            }
            return { chatName, created };
        },

        /**
         * 聊天文件是否存在（按角色全量聊天列表检测）；无法确认时返回 true 不拦截
         */
        chatFileExists: async (characterKey, chatName) => {
            if (!characterKey || !chatName) return false;
            try {
                const headers = hub?.getRequestHeaders ? hub.getRequestHeaders() : {};
                const res = await fetch('/api/characters/chats', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ avatar_url: characterKey }),
                    cache: 'no-cache',
                });
                if (!res.ok) return true;
                const data = await res.json();
                const names = data && typeof data === 'object'
                    ? Object.values(data).map((e) => String(e?.file_name ?? e?.file_id ?? ''))
                    : [];
                return names.some((n) => n === chatName || n === `${chatName}.jsonl`);
            } catch {
                return true;
            }
        },

        /**
         * 等待酒馆角色列表就绪（页面刚开时 characters 可能还没加载完，避免误报“没有角色”）
         */
        waitForCharacters: async () => {
            for (let i = 0; i < 40 && hub.characters.length === 0; i++) {
                await new Promise((r) => setTimeout(r, 500));
            }
            if (hub.characters.length === 0) {
                pushLog('warn', '等待 20 秒后酒馆角色列表仍为空（hub.characters 未加载）——请确认酒馆角色已导入、页面无报错');
            }
        },

        /**
         * 角色头像：只走“本地目录”方式。
         * 1) 未配置 charactersDir -> 不发送（记日志）；
         * 2) 先在酒馆侧确认该图片文件存在（NapCat 与酒馆同机时一致）——搜不到就不发；
         * 3) 找到了就按 `${目录}/${头像文件名}` 直接发给 NapCat 读文件发送，不管图片格式。
         */
        getAvatarImage: async (characterKey) => {
            const idx = findCharIndex(characterKey);
            if (idx < 0) return null;
            const av = hub.characters[idx]?.avatar;
            if (!av || av === 'none') {
                pushLog('info', `角色头像：跳过（无头像文件 avatar=${String(av ?? '')}）`);
                return null;
            }
            const fileName = String(av);

            const dir = String(config().charactersDir ?? '').trim();
            if (!dir) {
                pushLog('warn', '角色头像：未配置「角色头像本地目录」，不发送（可在进阶设置中填写酒馆 characters 文件夹路径）');
                return null;
            }

            // 预检文件是否存在（通过酒馆图片服务探测；同机时 NapCat 能看到同一文件）
            const probeUrl = `${location.origin}/img/avatars/${encodeURIComponent(fileName)}`;
            try {
                const res = await fetch(probeUrl, { cache: 'force-cache' });
                if (!res.ok) {
                    pushLog('info', `角色头像：未搜到图片文件 ${fileName}（HTTP ${res.status}），不发送`);
                    return null;
                }
            } catch (err) {
                pushLog('warn', `角色头像：文件探测失败（${err?.message ?? err}），按“未搜到”处理，不发送`);
                return null;
            }

            // 名字对上了 -> 直接发本地路径（NapCat 读文件上传，不管格式）
            const local = `${dir.replace(/[\\/]+$/, '')}/${fileName}`;
            pushLog('info', `角色头像：搜到 ${fileName}，按本地路径发送 ${local}`);
            return { file: local };
        },

        getGreeting: (characterKey) => {
            const idx = findCharIndex(characterKey);
            if (idx < 0) return '';
            const c = hub.characters[idx];
            const alternates = c?.data?.alternate_greetings;
            return c?.first_mes
                ?? c?.data?.first_mes
                ?? (Array.isArray(alternates) && alternates.length > 0 ? alternates[0] : '')
                ?? '';
        },

        injectUserMessage: async (text, meta = {}) => {
            const ctx = getContext();
            if (!ctx.chatId) throw new Error('当前没有打开的聊天');
            injectingUser = true;
            try {
                const msg = await hub.sendMessageAsUser(String(text), undefined, null, false, meta.senderName || '我');
                msg.extra.qq = { peerKey: meta.peerKey, userId: meta.userId, senderName: meta.senderName };
                hub.chat_metadata.qq = { peerKey: meta.peerKey };
                await hub.saveChatConditional();
            } finally {
                injectingUser = false;
            }
        },

        /** 拉取“整个程序”的聊天记录：遍历所有角色拉全量聊天列表（不受“每角色仅最新”限制） */
        fetchChatHistory: async (max = 60) => {
            try {
                const headers = hub?.getRequestHeaders ? hub.getRequestHeaders() : {};
                const characters = hub.characters ?? [];
                const collected = [];
                for (const ch of characters) {
                    if (!ch?.avatar || ch.avatar === 'none') continue;
                    try {
                        const res = await fetch('/api/characters/chats', {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ avatar_url: ch.avatar }),
                            cache: 'no-cache',
                        });
                        if (!res.ok) {
                            pushLog('warn', `角色 ${ch.name} 聊天接口 HTTP ${res.status}`);
                            continue;
                        }
                        const data = await res.json();
                        const entries = data && typeof data === 'object' ? Object.values(data) : [];
                        pushLog('info', `角色「${ch.name}」聊天接口返回 ${entries.length} 条：${entries.map((e) => String(e?.file_name ?? e?.file_id ?? '?')).join('、')}`);
                        for (const e of entries) {
                            if (!e || typeof e !== 'object') continue;
                            const rawName = String(e.file_name ?? e.file_id ?? '');
                            if (!rawName || !rawName.endsWith('.jsonl')) continue;
                            collected.push({
                                characterKey: ch.avatar,
                                chatName: rawName.replace(/\.jsonl$/i, ''),
                                preview: String(e.mes ?? '').replace(/\s+/g, ' ').slice(0, 30),
                                lastMes: e.last_mes ?? 0,
                            });
                        }
                    } catch { /* 单个角色失败不影响其它 */ }
                }
                // 按最后活动时间倒序（兼容时间戳与 ISO 字符串）
                collected.sort((a, b) => {
                    const ta = typeof a.lastMes === 'number' ? a.lastMes : new Date(a.lastMes ?? 0).getTime();
                    const tb = typeof b.lastMes === 'number' ? b.lastMes : new Date(b.lastMes ?? 0).getTime();
                    return (tb || 0) - (ta || 0);
                });
                pushLog('info', `程序聊天记录：全量读取 ${collected.length} 条（${characters.length} 个角色）`);
                return collected.slice(0, max);
            } catch (err) {
                pushLog('warn', `读取程序聊天记录失败: ${err?.message ?? err}`);
                return null;
            }
        },

        /** 当前聊天是否已被酒馆自动放置过开场白（首条为助手消息且非扩展注入） */
        hasExistingGreeting: () => {
            const chat = getContext().chat;
            if (chat.length === 0) return false;
            const first = chat[0];
            return !!(first && first.is_user === false && !first.extra?.qq);
        },

        injectAssistantMessage: async (text) => {
            const ctx = getContext();
            const ch = hub.characters[Number(ctx.characterId)];
            pushLog('info', `[trace] injectAssistant: chat=${hub.getCurrentChatId()} len=${ctx.chat.length}`);
            const message = {
                name: ch?.name ?? '角色',
                is_user: false,
                is_system: false,
                send_date: getMessageTimeStamp(),
                mes: String(text),
                extra: { qq: { assistant: true } },
            };
            ctx.chat.push(message);
            await hub.saveChatConditional();
            const id = ctx.chat.length - 1;
            await eventSource.emit(event_types.MESSAGE_RECEIVED, id, 'extension');
            ctx.addOneMessage(message);
        },

        waitTurnReady: async (timeoutMs = 60000) => {
            try {
                await waitUntilCondition(() => !hub.is_send_press && !is_group_generating, timeoutMs, 100);
            } catch {
                throw new Error('酒馆正在生成中，等待超时，请稍后再试');
            }
        },

        generateReply: async () => {
            const before = getContext().chat.length;
            pushLog('info', `[trace] Generate 前：chat=${hub.getCurrentChatId()} len=${before}`);
            let error = '';
            let stopped = false;
            try {
                await hub.Generate('normal');
            } catch (err) {
                error = String(err?.message ?? err);
                stopped = /abort|stop|取消|中断/i.test(error);
                if (!stopped) throw err; // 非取消类错误直接抛给桥上层处理
            }
            const chatNow = getContext().chat;
            pushLog('info', `[trace] Generate 后：chat=${hub.getCurrentChatId()} len=${chatNow.length}`);
            const appended = chatNow.slice(before).filter((m) => m && !m.is_user && !m.is_system);
            const last = appended[appended.length - 1];
            const text = last?.mes ?? '';
            if (!text && !error) {
                error = '生成结束但没有取到回复文本';
                stopped = true;
            }
            return { text, error, stopped };
        },

        notify,
        persist,
    };
}

// ---------------- 连接管理与状态同步 ----------------

// ---- 单实例互斥：同一酒馆账号只允许一个页面处理 QQ（防“双份开场白/双聊天文件”） ----
const SINGLETON_KEY = 'tavernCat.activeInstance';
const SINGLETON_HEARTBEAT_MS = 8000;
const SINGLETON_STALE_MS = 22000;
let singletonId = null;
let singletonTimer = null;
let singletonLost = false;

function singletonBeat() {
    if (!singletonId) return;
    try {
        const raw = localStorage.getItem(SINGLETON_KEY);
        let cur = null;
        if (raw) {
            try { cur = JSON.parse(raw); } catch { /* 忽略 */ }
        }
        if (cur && cur.id && cur.id !== singletonId && typeof cur.ts === 'number' && Date.now() - cur.ts < SINGLETON_STALE_MS) {
            // 锁被别人接管（例如本页曾在后台、心跳被浏览器节流）：主动让位断开
            if (!singletonLost) {
                singletonLost = true;
                pushLog('warn', '检测到另一个酒馆页面接管本会话，本页自动断开，避免重复回复');
                notify('error', '另一个酒馆页面已接管 Tavern Cat，本页连接已自动断开。请只保留一个酒馆页面（窗口/标签），并把所有页面都更新到最新版本。');
                disconnectBot();
            }
            return;
        }
        singletonLost = false;
        localStorage.setItem(SINGLETON_KEY, JSON.stringify({ id: singletonId, ts: Date.now() }));
    } catch { /* 忽略 */ }
}

function singletonAcquire() {
    try {
        const raw = localStorage.getItem(SINGLETON_KEY);
        if (raw) {
            const other = JSON.parse(raw);
            if (other && other.id !== singletonId && typeof other.ts === 'number' && Date.now() - other.ts < SINGLETON_STALE_MS) {
                return false; // 另一个酒馆页面正在活跃运行
            }
        }
        if (!singletonId) singletonId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        singletonLost = false;
        singletonBeat();
        if (singletonTimer) clearInterval(singletonTimer);
        singletonTimer = setInterval(singletonBeat, SINGLETON_HEARTBEAT_MS);
        // 页面切回前台/重新聚焦时立即刷新心跳与检查，弥补后台节流
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) singletonBeat();
        });
        window.addEventListener('focus', singletonBeat);
        return true;
    } catch {
        return true; // localStorage 不可用时放行
    }
}

function singletonRelease() {
    singletonLost = false;
    if (singletonTimer) {
        clearInterval(singletonTimer);
        singletonTimer = null;
    }
    try {
        const raw = localStorage.getItem(SINGLETON_KEY);
        if (raw) {
            const cur = JSON.parse(raw);
            if (cur && cur.id === singletonId) localStorage.removeItem(SINGLETON_KEY);
        }
    } catch { /* 忽略 */ }
}

function statusOf(now) {
    return {
        connected: bot?.isConnected ?? false,
        selfId: bot?.selfId ?? null,
        ...(now ?? {}),
    };
}

function syncStatusUi() {
    const s = { ...lastStatus, reason: lastStatus.reason };
    const connected = !!s.connected;

    // 魔法棒菜单状态点（行尾圆点）
    const dotState = connected ? 'tc-ok' : (s.reason === 'reconnecting' ? 'tc-busy' : 'tc-off');
    for (const dot of menuDots) {
        dot.className = `tc-menu-dot ${dotState}`;
    }
    // 设置弹窗（头部状态行）
    if (advancedEl) {
        const dot = advancedEl.querySelector('#ncb_status_dot');
        const label = advancedEl.querySelector('#ncb_status_text');
        if (dot && label) {
            dot.className = 'ncb-dot ' + (connected ? 'ncb-ok' : (s.reason === 'reconnecting' ? 'ncb-busy' : 'ncb-off'));
            label.textContent = connected
                ? `已连接（机器人 QQ：${s.selfId ?? '未知'}）`
                : (s.reason === 'reconnecting' ? '连接中断，正在自动重连…' : '未连接');
        }
        const c = advancedEl.querySelector('#ncb_connect');
        const d = advancedEl.querySelector('#ncb_disconnect');
        if (c) c.disabled = connected;
        if (d) d.disabled = !connected;
    }
}

function attachBot(client) {
    client.onStatusChange = (s) => {
        lastStatus = statusOf(s);
        syncStatusUi();
        pushLog(s.connected ? 'info' : 'warn',
            `连接状态：${s.connected ? `已连接（QQ ${s.selfId ?? '?'}）` : (s.reason === 'reconnecting' ? '重连中…' : '已断开')}`);
    };
    if (bridge) bridge.setBot(client);
}

function connectBot() {
    if (bot) disconnectBot();
    // 单实例互斥：同一账号只允许一个酒馆页面处理 QQ
    if (!singletonAcquire()) {
        notify('error', '检测到另一个酒馆页面正在运行 Tavern Cat：为避免重复回复与重复创建聊天，本页已停用连接。请关闭另一个酒馆页面/标签后，刷新本页再点连接。');
        pushLog('warn', '单实例互斥：检测到其他活跃页面，已拒绝本页连接');
        syncStatusUi();
        return;
    }
    const cfg = config();
    if (!cfg.wsUrl) {
        notify('error', '请先填写 NapCat WebSocket 地址');
        return;
    }
    // 底层连接日志也进面板日志（方便排查连不上/被拒绝/超时）
    const botLogger = {
        log: (...a) => pushLog('info', a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')),
        warn: (...a) => pushLog('warn', a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')),
        error: (...a) => pushLog('error', a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')),
    };
    try {
        bot = new OneBotClient({ url: cfg.wsUrl.trim(), token: cfg.token?.trim() ?? '', logger: botLogger });
    } catch (err) {
        notify('error', `创建连接失败：${err?.message ?? err}`);
        bot = null;
        return;
    }
    attachBot(bot);
    bot.connect();
    lastStatus = statusOf({ reason: 'reconnecting' });
    syncStatusUi();
    pushLog('info', `连接 ${cfg.wsUrl.trim()}…`);
}

function disconnectBot() {
    if (bot) {
        bot.close();
        bot = null;
    }
    if (bridge) bridge.setBot(null);
    singletonRelease();
    lastStatus = statusOf();
    syncStatusUi();
    pushLog('info', '已断开连接');
}

// ---------------- 酒馆本地消息 -> QQ ----------------

/** 当前打开的聊天绑定的 QQ 会话（聊天级标记），没有则为 null */
function activePeerKey() {
    return hub.chat_metadata?.qq?.peerKey ?? null;
}

// “酒馆手动回合”标记：仅当用户在酒馆手动发了一条消息后，才允许把随后生成的
// 助手回复回推给 QQ（一次手动回合只回推一条）。桥自己的回合（QQ→酒馆注入、
// ST 自动开场白等）一律不回推，杜绝开场白/回复被重复转发。
let manualTurnPeer = null;

function onUserMessageSent(messageId) {
    manualTurnPeer = null;
    if (injectingUser) return; // 桥自己注入的 QQ 消息
    const chat = getContext().chat;
    const m = chat[messageId];
    if (!m || !m.is_user || m.extra?.qq) return;
    const peerKey = activePeerKey();
    if (!peerKey || !m.mes?.trim()) return;
    bridge.forwardUserMessage(peerKey, m.mes);
    manualTurnPeer = peerKey; // 开启本手动回合的回复回推
}

function onAssistantMessageReceived(messageId) {
    const chat = getContext().chat;
    const m = chat[messageId];
    if (!m || m.is_user || m.is_system || m.extra?.qq) return;
    const peerKey = activePeerKey();
    if (!peerKey || !m.mes?.trim()) return;
    if (bridge.inTurn && bridge.turnPeerKey === peerKey) return; // 桥自动回合，已回传
    if (manualTurnPeer !== peerKey) return; // 非酒馆手动回合（ST 自动开场白/其它）不回推
    manualTurnPeer = null; // 一次手动回合只回推一条最终回复
    bridge.forwardAssistantMessage(peerKey, m.mes);
}

// ---------------- UI 公共件 ----------------

function escapeHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function populateCharSelect(sel, currentKey) {
    sel.innerHTML = '';
    const hint = document.createElement('option');
    hint.value = '';
    hint.textContent = '（不指定：新会话自动使用列表第一个角色）';
    sel.appendChild(hint);
    for (const c of hub.characters) {
        const opt = document.createElement('option');
        opt.value = String(c.avatar);
        opt.textContent = c.name;
        sel.appendChild(opt);
    }
    sel.value = currentKey ?? '';
}

function statusText(s) {
    return s.connected
        ? `已连接（机器人 QQ：${s.selfId ?? '未知'}）`
        : (s.reason === 'reconnecting' ? '连接中断，正在自动重连…' : '未连接');
}

function renderStats() {
    const el = advancedEl?.querySelector('#ncb_stats');
    if (el && bridge) {
        el.textContent = `队列：${bridge.queue.length}｜正在处理：${bridge.inTurn ? (bridge.turnPeerKey ?? '?') : '无'}`;
    }
    const flow = advancedEl?.querySelector('#ncb_flow');
    if (flow && bridge) {
        const s = bridge.stats ?? { received: 0, processed: 0, errors: 0 };
        flow.textContent = `收到 ${s.received} ｜ 处理 ${s.processed} ｜ 错误 ${s.errors}`;
    }
}

// ---------------- 设置弹窗（基础 + 进阶 合并在 settings.html 一个弹窗内，顶部标签页切换） ----------------


function refreshAdvancedPanel() {
    if (!advancedEl) return;
    const cfg = config();
    const verEl = advancedEl.querySelector('#tc_ver');
    if (verEl) verEl.textContent = `v${VERSION}`;

    advancedEl.querySelector('#ncb_wsUrl').value = cfg.wsUrl ?? '';
    advancedEl.querySelector('#ncb_token').value = cfg.token ?? '';
    advancedEl.querySelector('#ncb_autoConnect').checked = !!cfg.autoConnect;
    advancedEl.querySelector('#ncb_groupMode').value = cfg.groupMode ?? 'at_reply';
    advancedEl.querySelector('#ncb_replyQuote').checked = cfg.replyQuote !== false;
    advancedEl.querySelector('#ncb_greetNewChat').checked = cfg.greetNewChat !== false;
    advancedEl.querySelector('#ncb_ownerIds').value = cfg.ownerIdsText ?? '';
    advancedEl.querySelector('#ncb_maxChars').value = cfg.maxReplyChars || 1800;
    advancedEl.querySelector('#ncb_firstNotice').checked = !!cfg.firstNotice;
    advancedEl.querySelector('#ncb_charactersDir').value = cfg.charactersDir ?? '';
    populateCharSelect(advancedEl.querySelector('#ncb_defaultChar'), cfg.defaultCharacterKey);

    refreshSessionTable();
    renderStats();
    const logBox = advancedEl.querySelector('#ncb_log');
    if (logBox) {
        logBox.textContent = logLines.join('\n');
        logBox.scrollTop = logBox.scrollHeight;
    }
    syncStatusUi();
}

function refreshSessionTable() {
    const tbody = advancedEl?.querySelector('#ncb_sessions');
    if (!tbody) return;
    tbody.innerHTML = '';
    const cfg = config();
    const names = new Map(hub.characters.map((c) => [String(c.avatar), c.name]));
    const rows = Object.entries(cfg.mapping ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [peerKey, binding] of rows) {
        const tr = document.createElement('tr');
        const enabled = cfg.peerEnabled?.[peerKey] !== false;
        tr.innerHTML = `
            <td>${escapeHtml(peerKey)}</td>
            <td>${escapeHtml(names.get(binding.characterKey) ?? binding.characterKey)}</td>
            <td title="${escapeHtml(binding.chatName ?? '')}">${escapeHtml(String(binding.chatName ?? '').slice(0, 18))}</td>
            <td class="ncb-ops">
                <button data-act="on" class="menu_button tc-small" ${enabled ? 'disabled' : ''}>开启</button>
                <button data-act="off" class="menu_button tc-small" ${!enabled ? 'disabled' : ''}>暂停</button>
                <button data-act="bindcurrent" class="menu_button tc-small" title="把酒馆当前打开的角色聊天绑定到这个 QQ 会话（续接原对话）">绑当前</button>
                <button data-act="unbind" class="menu_button tc-small tc-danger" title="解除绑定">解绑</button>
            </td>`;
        tbody.appendChild(tr);
    }
    if (rows.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="4" class="ncb-empty">还没有绑定任何 QQ 会话：QQ 里第一次 @机器人 / 私聊 会自动创建</td>';
        tbody.appendChild(tr);
    }
}

/**
 * 把酒馆当前打开的角色聊天，改绑给指定的 QQ 会话（用于“用 QQ 续接原有聊天”）。
 * 之后的 QQ 消息都会进入这个聊天，延续已有历史。
 */
function bindCurrentChatToPeer(peerKey) {
    const ctx = getContext();
    const charId = ctx.characterId;
    if (charId === undefined || charId === null || charId === '') {
        notify('error', '请先在酒馆里打开你想要绑定的角色和聊天，再点「绑当前」');
        return;
    }
    const charIdx = Number(charId);
    const character = hub.characters[charIdx];
    const characterKey = character ? String(character.avatar) : null;
    const chatName = hub.getCurrentChatId();
    if (!characterKey || !chatName) {
        notify('error', '获取当前角色/聊天失败，请先正常打开一个聊天');
        return;
    }
    const cfg = config();
    // 若该聊天文件正被别的 QQ 会话占用，提示用户（允许覆盖，但提醒双向转发只认一个绑定）
    const conflicted = Object.entries(cfg.mapping ?? {}).find(
        ([pk, b]) => pk !== peerKey && b.characterKey === characterKey && b.chatName === chatName,
    );
    cfg.mapping[peerKey] = { characterKey, chatName };
    cfg.bindings[peerKey] = cfg.bindings[peerKey] ?? {};
    cfg.bindings[peerKey][characterKey] = chatName;
    if (cfg.peerEnabled[peerKey] === false) cfg.peerEnabled[peerKey] = true;
    hub.chat_metadata.qq = { peerKey };
    hub.saveChatConditional().then(() => persist());
    const name = character?.name ?? characterKey;
    const conflictTip = conflicted ? `（注意：该聊天之前绑在 ${conflicted[0]}，已改绑）` : '';
    toastr.success(`已绑定：${peerKey} ↔「${name}」/ ${chatName} ${conflictTip}`, APP_NAME);
    refreshSessionTable();
}

function bindAdvancedEvents(root) {
    const $ = (s) => root.querySelector(s);

    // 顶部标签页切换：基础设置 / 进阶设置（同一弹窗）
    const showTab = (name) => {
        root.querySelectorAll('.tc-tab').forEach((t) => t.classList.toggle('tc-tab-active', t.dataset.tab === name));
        const bp = root.querySelector('#tc_tab_basic');
        const ap = root.querySelector('#tc_tab_advanced');
        if (bp) bp.style.display = name === 'basic' ? '' : 'none';
        if (ap) ap.style.display = name === 'advanced' ? '' : 'none';
    };
    root.addEventListener('click', (ev) => {
        const tab = ev.target.closest('.tc-tab');
        if (tab) showTab(tab.dataset.tab);
    });
    showTab('basic');

    $('#ncb_connect')?.addEventListener('click', connectBot);
    $('#ncb_disconnect')?.addEventListener('click', disconnectBot);
    // 默认角色选择即时生效（改完即保存，避免忘点“保存设置”导致默认角色失效）
    $('#ncb_defaultChar')?.addEventListener('change', () => {
        const cfg = config();
        cfg.defaultCharacterKey = $('#ncb_defaultChar').value;
        persist();
        toastr.success('默认角色已保存', APP_NAME);
    });
    $('#ncb_save')?.addEventListener('click', () => {
        const cfg = config();
        cfg.wsUrl = $('#ncb_wsUrl').value.trim();
        cfg.token = $('#ncb_token').value.trim();
        cfg.autoConnect = $('#ncb_autoConnect').checked;
        cfg.groupMode = $('#ncb_groupMode').value;
        cfg.replyQuote = $('#ncb_replyQuote').checked;
        cfg.greetNewChat = $('#ncb_greetNewChat').checked;
        cfg.ownerIdsText = $('#ncb_ownerIds').value;
        cfg.ownerIds = parseOwnerIds(cfg.ownerIdsText);
        cfg.maxReplyChars = Math.max(100, Number($('#ncb_maxChars').value) || 1800);
        cfg.firstNotice = $('#ncb_firstNotice').checked;
        cfg.charactersDir = String($('#ncb_charactersDir').value ?? '').trim();
        cfg.defaultCharacterKey = $('#ncb_defaultChar').value;
        persist();
        toastr.success('设置已保存', APP_NAME);
    });

    $('#ncb_sessions')?.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-act]');
        if (!btn || !bridge) return;
        const tr = btn.closest('tr');
        const peerKey = tr?.querySelector('td')?.textContent;
        if (!peerKey) return;
        const act = btn.dataset.act;
        if (act === 'on') bridge.setPeerEnabled(peerKey, true);
        if (act === 'off') bridge.setPeerEnabled(peerKey, false);
        if (act === 'bindcurrent') { bindCurrentChatToPeer(peerKey); return; }
        if (act === 'unbind') bridge.unbindPeer(peerKey);
        refreshSessionTable();
    });

    // 手动绑定：把“酒馆当前打开的聊天”绑到指定 QQ 会话（无需 QQ 先发言）
    $('#ncb_bind_current')?.addEventListener('click', () => {
        const raw = String($('#ncb_bind_peer')?.value ?? '').trim();
        if (!/^(g|p):\d+$/.test(raw)) {
            notify('error', '请按格式填写：g:群号 或 p:QQ号，例如 g:123456789 / p:10001');
            return;
        }
        bindCurrentChatToPeer(raw);
        if ($('#ncb_bind_peer')) $('#ncb_bind_peer').value = '';
    });

    $('#ncb_clear_log')?.addEventListener('click', () => {
        logLines.length = 0;
        const box = $('#ncb_log');
        if (box) box.textContent = '';
    });
}

// ---------------- 设置窗口（自绘弹窗：固定 800x600，不依赖酒馆 popup 内部样式） ----------------

const VERSION = '0.8.1';
let modalOverlay = null;   // 当前打开的遮罩层（自绘弹窗）

function closeSettingsModal() {
    if (!modalOverlay) return;
    const esc = modalOverlay._escHandler;
    if (esc) document.removeEventListener('keydown', esc, true);
    modalOverlay.remove();
    modalOverlay = null;
    advancedEl = null;
}

async function openAdvancedPanel() {
    if (modalOverlay) return; // 已打开则不重复
    let html;
    try {
        html = await renderExtensionTemplateAsync(EXT_ID, 'settings', {}, false);
    } catch (err) {
        console.error(`[${APP_NAME}] 加载设置面板模板失败`, err);
        notify('error', `打开面板失败：${err?.message ?? err}`);
        return;
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const panel = wrap.querySelector('#ncb_root') ?? wrap;

    // 右上角关闭按钮
    const closeBtn = document.createElement('div');
    closeBtn.className = 'fa-solid fa-circle-xmark tc-modal-close';
    closeBtn.title = '关闭设置';
    closeBtn.addEventListener('click', closeSettingsModal);

    const overlay = document.createElement('div');
    overlay.className = 'tc-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'tc-modal';
    modal.appendChild(panel);
    modal.appendChild(closeBtn);
    overlay.appendChild(modal);
    // 点遮罩空白处关闭
    overlay.addEventListener('mousedown', (ev) => {
        if (ev.target === overlay) closeSettingsModal();
    });
    // ESC 关闭
    const escHandler = (ev) => {
        if (ev.key === 'Escape') closeSettingsModal();
    };
    overlay._escHandler = escHandler;
    document.addEventListener('keydown', escHandler, true);

    advancedEl = panel; // 供状态同步/刷新/日志查询元素
    document.body.appendChild(overlay);
    modalOverlay = overlay;

    bindAdvancedEvents(panel);
    refreshAdvancedPanel();
}

// ---------------- 魔法棒菜单（单入口：图标 + 名称 + 行尾状态点） ----------------

function makeMenuItem(label, onClick) {
    const item = document.createElement('div');
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = `<img class="tc-logo" src="${LOGO_URL}" alt="NapCat" /><span>${label}</span><span class="tc-menu-dot tc-off"></span>`;
    item.title = '连接状态：绿=已连接 / 黄=重连中 / 灰=未连接';
    item.addEventListener('click', onClick);
    return item;
}

function mountMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        setTimeout(mountMenu, 1000);
        return;
    }
    const entry = makeMenuItem(APP_NAME, () => openAdvancedPanel());
    menuDots.push(entry.querySelector('.tc-menu-dot'));
    menu.appendChild(entry);
    syncStatusUi();
}

// ---------------- 扩展入口 ----------------

export async function init() {
    // 动态加载酒馆主模块（缺失时给出可见提示，不让扩展静默消失）
    await loadTavernHub();
    if (missingHubApi.length > 0) {
        const tip = `当前酒馆版本缺少部分 API（${missingHubApi.slice(0, 4).join('、')}${missingHubApi.length > 4 ? ' 等' : ''}），建议升级 SillyTavern 1.18+；菜单与设置仍可用，对话功能可能受限。`;
        pushLog('error', tip);
        notify('error', tip);
    }
    // v0.1 旧配置（napcatBridge）迁移到新命名空间
    if (extension_settings.napcatBridge && !extension_settings[MODULE]) {
        extension_settings[MODULE] = extension_settings.napcatBridge;
        delete extension_settings.napcatBridge;
    }
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = { ...DEFAULT_CONFIG };
    } else {
        extension_settings[MODULE] = { ...DEFAULT_CONFIG, ...extension_settings[MODULE] };
    }
    const cfg = config();
    // 旧默认端口迁移：3001 -> 2333（仅当地址仍是旧默认值时才改，用户自定义地址不动）
    if (cfg.wsUrl === 'ws://127.0.0.1:3001') {
        cfg.wsUrl = 'ws://127.0.0.1:2333';
        persist();
    }
    cfg.ownerIds = parseOwnerIds(cfg.ownerIdsText);
    persist();

    host = buildHost();
    bridge = new NapcatBridge({ bot: null, host, settings: cfg, logger: console });
    bridge.onLog = (level, text) => {
        pushLog(level, text);
        if (level === 'error') notify('error', text);
    };
    bridge.onStats = () => {
        if (statsTimer) clearTimeout(statsTimer);
        statsTimer = setTimeout(renderStats, 300);
    };
    // 酒馆本地消息 -> QQ
    eventSource.on(event_types.MESSAGE_SENT, onUserMessageSent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onAssistantMessageReceived);

    mountMenu();
    // 页面关闭/隐藏时释放单实例锁，让另一个页面能接管
    window.addEventListener('pagehide', singletonRelease);

    if (cfg.autoConnect && cfg.wsUrl) {
        setTimeout(() => connectBot(), 800);
    }
    console.log(`[${APP_NAME}] 初始化完成（v0.2.0，酒馆直连 NapCat）`);
}
