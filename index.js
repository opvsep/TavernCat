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
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
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
    wsUrl: 'ws://127.0.0.1:3001',
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
let advancedEl = null;     // 当前打开的进阶设置弹窗容器
let basicEl = null;        // 当前打开的基础设置弹窗容器
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

            if (curId !== idx) {
                // hub.selectCharacterById 在酒馆保存繁忙时会静默返回：必须校验 + 重试
                let switched = false;
                for (let attempt = 0; attempt < 5 && !switched; attempt++) {
                    try {
                        await waitUntilCondition(() => !hub.is_send_press && !is_group_generating, 10000, 100);
                    } catch { /* 继续尝试 */ }
                    await hub.selectCharacterById(idx);
                    const afterId = getContext().characterId;
                    switched = afterId !== undefined && afterId !== null && String(afterId) === String(idx);
                    if (!switched && attempt < 4) await new Promise((r) => setTimeout(r, 300));
                }
                if (!switched) throw new Error('切换角色失败（酒馆忙或正在保存），请稍后再试');
            }

            let created = false;
            if (!chatName) {
                await hub.doNewChat();
                chatName = hub.getCurrentChatId();
                if (!chatName) throw new Error('新建聊天失败');
                created = true;
            } else if (hub.getCurrentChatId() !== chatName) {
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

        getGreeting: (characterKey) => {
            const idx = findCharIndex(characterKey);
            if (idx < 0) return '';
            const c = hub.characters[idx];
            return c?.first_mes ?? c?.data?.first_mes ?? '';
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

        injectAssistantMessage: async (text) => {
            const ctx = getContext();
            const ch = hub.characters[Number(ctx.characterId)];
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

    // 魔法棒图标按钮的角标状态点
    const dotState = connected ? 'tc-ok' : (s.reason === 'reconnecting' ? 'tc-busy' : 'tc-off');
    for (const dot of menuDots) {
        dot.className = `tc-wand-dot ${dotState}`;
    }
    // 进阶面板
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
    // 基础面板
    if (basicEl) {
        const dot = basicEl.querySelector('#ncbB_status_dot');
        const label = basicEl.querySelector('#ncbB_status_text');
        if (dot && label) {
            dot.className = 'ncb-dot ' + (connected ? 'ncb-ok' : (s.reason === 'reconnecting' ? 'ncb-busy' : 'ncb-off'));
            label.textContent = connected
                ? `已连接（机器人 QQ：${s.selfId ?? '未知'}）`
                : (s.reason === 'reconnecting' ? '连接中断，正在自动重连…' : '未连接');
        }
        const c = basicEl.querySelector('#ncbB_connect');
        const d = basicEl.querySelector('#ncbB_disconnect');
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
    const cfg = config();
    if (!cfg.wsUrl) {
        notify('error', '请先填写 NapCat WebSocket 地址');
        return;
    }
    try {
        bot = new OneBotClient({ url: cfg.wsUrl.trim(), token: cfg.token?.trim() ?? '' });
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
    lastStatus = statusOf();
    syncStatusUi();
    pushLog('info', '已断开连接');
}

// ---------------- 酒馆本地消息 -> QQ ----------------

/** 当前打开的聊天绑定的 QQ 会话（聊天级标记），没有则为 null */
function activePeerKey() {
    return hub.chat_metadata?.qq?.peerKey ?? null;
}

function onUserMessageSent(messageId) {
    if (injectingUser) return; // 桥自己注入的 QQ 消息
    const chat = getContext().chat;
    const m = chat[messageId];
    if (!m || !m.is_user || m.extra?.qq) return;
    const peerKey = activePeerKey();
    if (!peerKey || !m.mes?.trim()) return;
    bridge.forwardUserMessage(peerKey, m.mes);
}

function onAssistantMessageReceived(messageId) {
    const chat = getContext().chat;
    const m = chat[messageId];
    if (!m || m.is_user || m.is_system || m.extra?.qq) return;
    const peerKey = activePeerKey();
    if (!peerKey || !m.mes?.trim()) return;
    if (bridge.inTurn && bridge.turnPeerKey === peerKey) return; // 桥自动回合，已回传
    // 该回复紧跟的上一轮若是 QQ 消息触发的，也跳过（防御重复回传）
    const prev = [...chat.slice(0, messageId)].reverse().find((x) => x && (x.is_user || x.is_system));
    if (prev?.is_user && prev.extra?.qq) return;
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
}

// ---------------- 基础设置面板（日常最常用） ----------------

const BASIC_HTML = `
<div id="tc_basic_root" class="tc-panel">
    <div class="tc-title"><img class="tc-logo" src="${LOGO_URL}" alt="NapCat" /> ${APP_NAME} · 基础设置</div>

    <div class="tc-section">
        <div class="tc-row">
            <span id="ncbB_status_dot" class="ncb-dot ncb-off"></span>
            <span id="ncbB_status_text">未连接</span>
            <button id="ncbB_connect" class="menu_button">连接</button>
            <button id="ncbB_disconnect" class="menu_button" disabled>断开</button>
        </div>
    </div>

    <div class="tc-section">
        <div class="tc-grid">
            <label>NapCat WS 地址
                <input type="text" id="ncbB_wsUrl" placeholder="ws://127.0.0.1:3001">
            </label>
            <label>Access Token（NapCat 里没设置就留空）
                <input type="password" id="ncbB_token" placeholder="可选">
            </label>
            <label>群聊回复模式
                <select id="ncbB_groupMode">
                    <option value="at_reply">@机器人 / 回复机器人才回（推荐）</option>
                    <option value="at_only">只有 @ 机器人才回</option>
                    <option value="all">群里所有消息都回</option>
                </select>
            </label>
            <label>新会话默认角色
                <select id="ncbB_defaultChar"></select>
            </label>
        </div>
        <div class="tc-row">
            <label class="ncb-inline"><input type="checkbox" id="ncbB_autoConnect"> 打开酒馆页面时自动连接</label>
        </div>
    </div>

    <div class="tc-tip">这里改动即时保存。进阶功能（会话绑定、私聊白名单、开场白、引用回复、日志等）请打开魔法棒里的「${APP_NAME} · 进阶设置」。</div>
</div>`;

function collectBasicFrom(el) {
    const cfg = config();
    cfg.wsUrl = el.querySelector('#ncbB_wsUrl').value.trim();
    cfg.token = el.querySelector('#ncbB_token').value.trim();
    cfg.autoConnect = el.querySelector('#ncbB_autoConnect').checked;
    cfg.groupMode = el.querySelector('#ncbB_groupMode').value;
    cfg.defaultCharacterKey = el.querySelector('#ncbB_defaultChar').value;
    persist();
}

function openBasicPanel() {
    const wrap = document.createElement('div');
    wrap.innerHTML = BASIC_HTML;
    basicEl = wrap.querySelector('#tc_basic_root');
    const cfg = config();

    basicEl.querySelector('#ncbB_wsUrl').value = cfg.wsUrl ?? '';
    basicEl.querySelector('#ncbB_token').value = cfg.token ?? '';
    basicEl.querySelector('#ncbB_autoConnect').checked = !!cfg.autoConnect;
    basicEl.querySelector('#ncbB_groupMode').value = cfg.groupMode ?? 'at_reply';
    populateCharSelect(basicEl.querySelector('#ncbB_defaultChar'), cfg.defaultCharacterKey);

    basicEl.querySelector('#ncbB_connect').addEventListener('click', connectBot);
    basicEl.querySelector('#ncbB_disconnect').addEventListener('click', disconnectBot);
    for (const sel of ['#ncbB_wsUrl', '#ncbB_token', '#ncbB_autoConnect', '#ncbB_groupMode', '#ncbB_defaultChar']) {
        basicEl.querySelector(sel).addEventListener('change', () => {
            collectBasicFrom(basicEl);
            toastr.success('已保存', APP_NAME);
        });
    }

    syncStatusUi();
    callGenericPopup(basicEl, POPUP_TYPE.TEXT, '', { okButton: '关闭', wide: true }).finally(() => {
        basicEl = null;
    });
}

// ---------------- 进阶设置面板 ----------------

function refreshAdvancedPanel() {
    if (!advancedEl) return;
    const cfg = config();

    advancedEl.querySelector('#ncb_wsUrl').value = cfg.wsUrl ?? '';
    advancedEl.querySelector('#ncb_token').value = cfg.token ?? '';
    advancedEl.querySelector('#ncb_autoConnect').checked = !!cfg.autoConnect;
    advancedEl.querySelector('#ncb_groupMode').value = cfg.groupMode ?? 'at_reply';
    advancedEl.querySelector('#ncb_replyQuote').checked = cfg.replyQuote !== false;
    advancedEl.querySelector('#ncb_greetNewChat').checked = cfg.greetNewChat !== false;
    advancedEl.querySelector('#ncb_ownerIds').value = cfg.ownerIdsText ?? '';
    advancedEl.querySelector('#ncb_maxChars').value = cfg.maxReplyChars || 1800;
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
                <button data-act="on" class="menu_button ncb-small" ${enabled ? 'disabled' : ''}>开启</button>
                <button data-act="off" class="menu_button ncb-small" ${!enabled ? 'disabled' : ''}>暂停</button>
                <button data-act="unbind" class="menu_button ncb-small ncb-danger">解绑</button>
            </td>`;
        tbody.appendChild(tr);
    }
    if (rows.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="4" class="ncb-empty">还没有绑定任何 QQ 会话：QQ 里第一次 @机器人 / 私聊 会自动创建</td>';
        tbody.appendChild(tr);
    }
}

function bindAdvancedEvents(root) {
    const $ = (s) => root.querySelector(s);

    $('#ncb_connect')?.addEventListener('click', connectBot);
    $('#ncb_disconnect')?.addEventListener('click', disconnectBot);
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
        if (act === 'unbind') bridge.unbindPeer(peerKey);
        refreshSessionTable();
    });

    $('#ncb_clear_log')?.addEventListener('click', () => {
        logLines.length = 0;
        const box = $('#ncb_log');
        if (box) box.textContent = '';
    });
}

async function openAdvancedPanel() {
    try {
        const html = await renderExtensionTemplateAsync(EXT_ID, 'settings', {}, false);
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        advancedEl = wrap.querySelector('#ncb_root');
        if (!advancedEl) advancedEl = wrap;
        bindAdvancedEvents(advancedEl);
        refreshAdvancedPanel();
        await callGenericPopup(advancedEl, POPUP_TYPE.TEXT, '', { okButton: '关闭', wide: true, allowHorizontalScroll: true });
    } catch (err) {
        console.error(`[${APP_NAME}] 打开进阶设置失败`, err);
        notify('error', `打开面板失败：${err?.message ?? err}`);
    } finally {
        advancedEl = null;
    }
}

// ---------------- 魔法棒菜单（与内置扩展一致的图标按钮 + 右下角状态点） ----------------

const WAND_CONTAINER_ID = 'tavern_cat_wand_container';

function makeWandButton({ html, title, onClick }) {
    const btn = document.createElement('div');
    btn.className = 'tc-wand-btn';
    btn.title = title;
    btn.innerHTML = html;
    btn.addEventListener('click', onClick);
    return btn;
}

function mountMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        setTimeout(mountMenu, 1000);
        return;
    }
    let container = document.getElementById(WAND_CONTAINER_ID);
    if (!container) {
        container = document.createElement('div');
        container.id = WAND_CONTAINER_ID;
        container.className = 'extension_container';
        menu.appendChild(container);
    } else {
        container.innerHTML = ''; // 幂等：重复挂载时先清空
    }
    const basic = makeWandButton({
        html: `<img class="tc-wand-logo" src="${LOGO_URL}" alt="" /><span class="tc-wand-dot tc-off"></span>`,
        title: `${APP_NAME} · 基础设置（连接 / 常用配置）`,
        onClick: () => openBasicPanel(),
    });
    const adv = makeWandButton({
        html: `<div class="fa-solid fa-sliders extensionsMenuExtensionButton"></div><span class="tc-wand-dot tc-off"></span>`,
        title: `${APP_NAME} · 进阶设置（会话绑定 / 白名单 / 日志）`,
        onClick: () => openAdvancedPanel(),
    });
    menuDots.push(basic.querySelector('.tc-wand-dot'), adv.querySelector('.tc-wand-dot'));
    container.appendChild(basic);
    container.appendChild(adv);
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

    if (cfg.autoConnect && cfg.wsUrl) {
        setTimeout(() => connectBot(), 800);
    }
    console.log(`[${APP_NAME}] 初始化完成（v0.2.0，酒馆直连 NapCat）`);
}
