// 桥接编排核心：QQ 会话 <-> 酒馆会话（每个 QQ 群/好友 = 酒馆里一个“角色+聊天文件”）
//
// 本文件不依赖 SillyTavern 的任何全局对象，只通过下方 TavernHost 接口与酒馆交互，
// 因此可以在 Node 里用桩宿主做端到端测试。酒馆侧的薄胶水层（index.js）负责实现 TavernHost。
//
// TavernHost 接口（由 index.js 实现）：
//   isReady() -> boolean                   角色/设置是否就绪
//   listCharacters() -> [{key, name}]      key = 角色的稳定标识（用头像文件名）
//   switchTo(characterKey, chatName|null)  切到指定角色的指定聊天；chatName=null 表示新建聊天
//        -> {chatName, created}            返回最终 chatName（聊天文件主名）
//   current() -> {characterKey, chatName, peerKey}
//   injectUserMessage(text, {senderName})  把一条消息作为“用户”写入当前聊天并落盘
//   injectAssistantMessage(text, {name})   把一条消息作为“助手”写入当前聊天并落盘（开场白用）
//   getGreeting(characterKey) -> string|null  该角色的开场白原文（未宏替换）
//   waitTurnReady(timeoutMs) -> Promise     等 ST 空闲（无生成锁、无保存中）
//   generateReply() -> Promise<{text, error, stopped}>  生成一条助手回复并落盘（text=正文）
//   notify(kind, text)                      UI 通知（'info'|'error'）
//   persist()                               设置变更后持久化
//
// 配置（settings 对象，直接由调用方持有并持久化）：
//   mapping:    { [peerKey]: {characterKey, chatName} }      每个会话当前绑定
//   bindings:   { [peerKey]: { [characterKey]: chatName } }  历史绑定（切角色可回到旧聊天）
//   peerEnabled:{ [peerKey]: boolean }                       会话级开关
//   groupMode: 'at_reply' | 'at_only' | 'all'
//   ownerIds: number[]      私聊白名单（空 = 允许所有人私聊）
//   replyQuote: boolean     群聊回引用触发消息
//   greetNewChat: boolean   新建会话时先发角色开场白
//   maxReplyChars: number   单条 QQ 消息上限（超出按换行切分）

import { normalizeMessageEvent, shouldTrigger } from './triggers.js';

export const DEFAULT_SETTINGS = {
    mapping: {},
    bindings: {},
    peerEnabled: {},
    groupMode: 'at_reply',
    ownerIds: [],
    replyQuote: true,
    greetNewChat: true,
    maxReplyChars: 1800,
    firstNotice: false, // 首次接入的【Tavern Cat】引导长文：默认关闭（接入即回复，不再额外打扰）
};

/** 把长文本切成 <=maxChars 的块。按“行”打包，保证 chunks.join('\n') === 原文（超长单行按字数硬切）。 */
export function chunkText(text, maxChars = 1800) {
    const raw = String(text ?? '').replace(/\r\n/g, '\n');
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const lines = trimmed.split('\n');
    const chunks = [];
    let cur = '';
    const flush = () => {
        if (cur !== '') { chunks.push(cur); cur = ''; }
    };
    const pushPieces = (line) => {
        // 超长单行：按字符硬切
        let rest = line;
        while (rest.length > maxChars) {
            chunks.push(rest.slice(0, maxChars));
            rest = rest.slice(maxChars);
        }
        cur = rest;
    };
    for (const line of lines) {
        if (!cur) {
            if (line.length > maxChars) pushPieces(line);
            else cur = line;
            continue;
        }
        const candidate = `${cur}\n${line}`;
        if (candidate.length <= maxChars) {
            cur = candidate;
        } else {
            flush();
            if (line.length > maxChars) pushPieces(line);
            else cur = line;
        }
    }
    flush();
    return chunks;
}

const COMMAND_NAMES = ['/指令', '/help', '/帮助', '/引导', '/历史', '/历史记录', '/新对话', '/角色列表', '/角色', '/重置', '/清空', '/解绑', '/初始化', '/状态', '/关闭', '/开启'];

export class NapcatBridge {
    /**
     * @param {object} deps
     * @param {import('./onebot.js').OneBotClient} deps.bot
     * @param {object} deps.host    TavernHost
     * @param {object} deps.settings 配置对象（调用方持久化）
     * @param {object} [deps.logger]
     */
    constructor({ bot, host, settings, logger } = {}) {
        this.bot = bot;
        this.host = host;
        this.settings = settings;
        this.logger = logger ?? console;

        this.queue = [];          // 待处理 QQ 消息
        this.draining = false;
        this.inTurn = false;      // 正在跑一次“注入+生成+回传”回合（用于酒馆→QQ 转发判定）
        this.turnPeerKey = null;
        this.recentSent = new Map(); // peerKey -> [{id, time}]
        this.onLog = null;        // (level, text) 供 UI 展示
        this.onStats = null;      // ({queue, busy, inTurn, turnPeerKey, stats})
        this.stats = { received: 0, processed: 0, errors: 0 }; // 消息流计数（供 UI 判断“有没有实例在执行”）
        this.seenMessages = new Map(); // "peerKey:messageId" -> ts（近期已处理消息去重）
        this._seenTtlMs = 10 * 60 * 1000;
        this._seenCap = 300;
        this._recentCap = 300;
        this._recentTtlMs = 30 * 60 * 1000;

        // 消息事件入口（挂给 bot.onEvent）
        if (bot) this.setBot(bot);
    }

    /** 更换底层连接（连接/断开/改地址时用），并重挂事件入口 */
    setBot(bot) {
        this.bot = bot;
        if (bot) bot.onEvent = (ev) => this.onOneBotEvent(ev);
    }

    // ---------- 日志 ----------
    _log(level, text) {
        this.logger[level === 'error' ? 'error' : 'log']?.(`[TavernCat] ${text}`);
        if (this.onLog) {
            try { this.onLog(level, text); } catch { /* 忽略 */ }
        }
    }

    // ---------- 公共查询 ----------
    isPeerEnabled(peerKey) {
        return this.settings.peerEnabled[peerKey] !== false;
    }

    setPeerEnabled(peerKey, enabled) {
        this.settings.peerEnabled[peerKey] = enabled;
        this.host.persist();
    }

    unbindPeer(peerKey) {
        delete this.settings.mapping[peerKey];
        delete this.settings.bindings[peerKey];
        this.host.persist();
    }

    getBinding(peerKey) {
        return this.settings.mapping[peerKey] ?? null;
    }

    // ---------- 事件入口 ----------
    onOneBotEvent(ev) {
        if (ev.post_type === 'message') {
            this.stats.received += 1;
            this._emitStats();
        }
        if (ev.post_type !== 'message') return;
        const selfId = this.bot.selfId;
        const norm = normalizeMessageEvent(ev, selfId ?? ev.self_id);
        if (!norm) return;

        // 消息去重：同一 (会话, message_id) 在 10 分钟内只处理一次（防重复推送/事件重发）
        if (norm.messageId) {
            const seenKey = `${norm.peerKey}:${norm.messageId}`;
            const now = Date.now();
            const old = this.seenMessages.get(seenKey);
            if (old && now - old < this._seenTtlMs) {
                this._log('info', `忽略重复消息 ${seenKey}（已处理过）`);
                return;
            }
            this.seenMessages.set(seenKey, now);
            while (this.seenMessages.size > this._seenCap) {
                const oldest = this.seenMessages.keys().next().value;
                this.seenMessages.delete(oldest);
            }
        }

        if (norm.scope === 'private') {
            const owners = (this.settings.ownerIds ?? []).map((x) => String(x));
            if (owners.length > 0 && !owners.includes(String(norm.userId))) {
                this._log('info', `忽略非白名单私聊 ${norm.userId}`);
                return;
            }
        }
        // 会话级开关：关闭时只放行 /开启（群内还需 @ 到机器人，防止被群友随意开启）
        const isEnableCmd = norm.text.trim().startsWith('/开启');
        if (!this.isPeerEnabled(norm.peerKey)) {
            if (!isEnableCmd) {
                this._log('info', `会话 ${norm.peerKey} 已关闭，忽略`);
                return;
            }
            if (norm.scope === 'group' && !norm.atSelf && !norm.atAll) {
                this._log('info', `群会话 ${norm.peerKey} 已关闭且未 @ 机器人，忽略 /开启`);
                return;
            }
        }

        this.queue.push(norm);
        this._log('info', `入队 ${norm.peerKey} ${norm.senderName}: ${norm.text.slice(0, 60)}`);
        this._emitStats();
        void this.drain();
    }

    async drain() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.length > 0) {
                if (!this.bot?.isConnected) {
                    // 断线期间先压住，等重连后再处理
                    this._log('warn', 'NapCat 未连接，暂停处理队列');
                    break;
                }
                const norm = this.queue.shift();
                try {
                    await this._processOne(norm);
                } catch (err) {
                    this.stats.errors += 1;
                    this._log('error', `处理 ${norm.peerKey} 消息失败: ${err?.message ?? err}`);
                }
                this._emitStats();
            }
        } finally {
            this.draining = false;
            if (this.queue.length > 0 && this.bot?.isConnected) void this.drain();
        }
    }

    // ---------- 单条消息 ----------
    async _processOne(norm) {
        this.stats.processed += 1;
        const triggered = shouldTrigger(norm, {
            groupMode: this.settings.groupMode,
            recentSentIds: this._recentIds(norm.peerKey),
        });
        if (!triggered.trigger) {
            this._log('info', `群 ${norm.peerId} 未触发（${triggered.reason}），跳过`);
            return;
        }

        const text = norm.text.trim();
        // 指令优先（群里也只有触发时才会到这里）
        if (text.startsWith('/')) {
            await this._runCommand(norm, text);
            return;
        }

        await this._runTurn(norm, text);
    }

    /** 新角色/新会话建立后：先发角色头像（如搜得到），再立刻把开场白注入聊天并发给 QQ */
    async _sendNewChatGreeting(norm, characterKey) {
        // 幂等：同一个聊天文件只发一次开场白（防止重复接入/重复事件导致双份）
        const curBinding = this.settings.mapping?.[norm.peerKey];
        const chatName = curBinding?.chatName;
        const greetKey = chatName ? `${characterKey}|${chatName}` : null;
        if (greetKey && this.settings.greeted?.[greetKey]) {
            this._log('info', `聊天 ${chatName} 已发过开场白，跳过重复发送`);
            return;
        }

        // 0) 头像：host 侧已按“本地目录+文件存在”判定，没有/搜不到时返回 null 不发
        try {
            const avatar = await this.host.getAvatarImage?.(characterKey);
            if (avatar?.file) {
                const data = await this.bot.sendImage(norm.peerId, avatar.file, norm.scope);
                if (data?.message_id) this._rememberSent(norm.peerKey, data.message_id);
                this._log('info', `头像已发送 message_id=${data?.message_id ?? '?'}`);
            } else {
                this._log('info', '头像未发送（host 返回空）');
            }
        } catch (err) {
            this._log('warn', `角色头像发送失败（跳过，不影响开场白）: ${err?.message ?? err}`);
        }

        if (this.settings.greetNewChat === false) {
            this._log('info', `已关闭“新会话开场白”，跳过 ${characterKey}`);
            return;
        }
        try {
            const rawGreeting = this.host.getGreeting?.(characterKey) ?? '';
            if (!String(rawGreeting).trim()) {
                this._log('info', `角色 ${this._charName(characterKey)} 没有开场白，跳过`);
                return;
            }
            const greeting = String(rawGreeting)
                .replaceAll('{{char}}', this._charName(characterKey))
                .replaceAll('{{user}}', norm.senderName);
            // 若酒馆 ST 已自动放置过开场白（空聊天机制），不再重复注入，只回传 QQ
            const alreadyAutoGreeted = await this.host.hasExistingGreeting?.();
            if (alreadyAutoGreeted) {
                this._log('info', '酒馆已自动放置开场白（ST 空聊天机制），跳过重复注入');
            } else {
                await this.host.injectAssistantMessage(greeting);
            }
            await this._sendToPeer(norm, greeting, { quote: false });
            this._log('info', `开场白发送流程完成 greetKey=${greetKey ?? '(无)'}`);
            // 标记该聊天已发过开场白
            if (greetKey) {
                this.settings.greeted = this.settings.greeted ?? {};
                this.settings.greeted[greetKey] = 1;
                this.host.persist();
            }
        } catch (err) {
            this._log('warn', `开场白发送失败: ${err?.message ?? err}`);
        }
    }

    /** 一次完整回合：定位/创建会话 -> 注入用户消息 -> 生成 -> 回传 */
    async _runTurn(norm, text) {
        const peerKey = norm.peerKey;
        const hadBinding = !!this.settings.mapping[peerKey];
        let binding = this.settings.mapping[peerKey] ?? null;
        this._log('info', `[trace] 回合开始 ${peerKey} messageId=${norm.messageId} hadBinding=${hadBinding}`);

        // 1) 没有绑定 -> 用默认角色新建（先等酒馆角色列表就绪，避免页面刚开时的误判）
        if (!binding) {
            await this.host.waitForCharacters?.();
            const chars = this.host.listCharacters?.() ?? [];
            let defaultKey = this.settings.defaultCharacterKey ?? chars[0]?.key;
            // 默认角色已失效（角色卡被删/改名）时回退到第一个可用角色，避免“废了”
            if (defaultKey && !chars.some((c) => c.key === defaultKey)) {
                this._log('warn', `默认角色 ${defaultKey} 已不存在，回退到「${chars[0]?.name ?? '无'}」`);
                defaultKey = chars[0]?.key ?? null;
            }
            if (!defaultKey) {
                this._log('error', `会话 ${peerKey} 无绑定且没有可用角色`);
                await this._safeReply(norm, '暂时无法自动接入。想要立刻开启对话，请使用 /新对话 指令。');
                return;
            }
            binding = { characterKey: defaultKey, chatName: null };
        }

        // 2) 确保酒馆里该会话的聊天被激活（必要时新建）
        await this.host.waitForCharacters?.();
        const chars = this.host.listCharacters?.() ?? [];
        const charExists = chars.some((c) => c.key === binding.characterKey);
        if (!charExists) {
            this._log('error', `角色 ${binding.characterKey} 不存在，请重新绑定`);
            await this._safeReply(norm, '当前绑定的角色已不存在。想要立刻开启对话，请使用 /新对话 指令。');
            return;
        }

        let switched;
        try {
            switched = await this.host.switchTo(binding.characterKey, binding.chatName ?? null, peerKey);
        } catch (err) {
            this._log('error', `切换会话失败: ${err?.message ?? err}`);
            const msg = String(err?.message ?? err);
            if (msg.includes('已不存在')) {
                // 绑定的聊天文件被删：清除绑定，让会话回到可重新接入的状态
                delete this.settings.mapping[peerKey];
                if (this.settings.bindings?.[peerKey]) delete this.settings.bindings[peerKey];
                this.host.persist();
                await this._safeReply(norm, '原聊天文件已被删除：本会话已重置。\n重新发送一条消息即可按默认角色开启新对话（或先发 /角色列表 /历史 选择）。');
            } else {
                await this._safeReply(norm, `接入失败：${msg.slice(0, 100)}\n请稍后再发一次；或发 /引导 查看当前状态。`);
            }
            return;
        }
        const chatName = switched.chatName;
        binding = { characterKey: binding.characterKey, chatName };
        this.settings.mapping[peerKey] = binding;
        this.settings.bindings[peerKey] = this.settings.bindings[peerKey] ?? {};
        this.settings.bindings[peerKey][binding.characterKey] = chatName;
        this.host.persist();

        // 3) 新建会话 -> 立刻把角色开场白发出来（注入聊天 + 回传 QQ）
        if (switched.created) {
            await this._sendNewChatGreeting(norm, binding.characterKey);
        }

        // 4) 注入 QQ 消息（打 QQ 来源标记，防止回推死循环）
        this.inTurn = true;
        this.turnPeerKey = peerKey;
        this._emitStats();
        try {
            await this.host.waitTurnReady?.(60000);
            await this.host.injectUserMessage(text, { senderName: norm.senderName, userId: norm.userId, peerKey });
            const result = await this.host.generateReply();
            if (result.error) {
                this._log('error', `生成失败: ${result.error}`);
                return;
            }
            const reply = (result.text ?? '').trim();
            if (!reply) {
                this._log('warn', '生成结果为空，不回传');
                return;
            }
            await this._sendToPeer(norm, reply, { quote: this.settings.replyQuote !== false && norm.scope === 'group' });
        } finally {
            this.inTurn = false;
            this.turnPeerKey = null;
            this._emitStats();
        }
        this._log('info', `[trace] 回合结束 ${peerKey}`);

        // 5) 首次自动建立绑定：在 QQ 里发一条接入引导（不发酒馆弹窗）
        if (!hadBinding && this.settings.mapping[peerKey] && this.settings.firstNotice !== false) {
            try {
                const notice = this.buildFirstNotice(norm, this.settings.mapping[peerKey]);
                const data = await this.bot.sendText(norm.peerId, notice, norm.scope);
                if (data?.message_id) this._rememberSent(norm.peerKey, data.message_id);
            } catch (err) {
                this._log('warn', `首次接入引导发送失败: ${err?.message ?? err}`);
            }
        }
    }

    /** 首次接入引导文案（QQ 会话第一次接入时发给对方） */
    buildFirstNotice(norm, binding) {
        const charName = this._charName(binding.characterKey);
        const chatName = binding.chatName || '新对话';
        return [
            `【Tavern Cat】本会话已接入酒馆角色「${charName}」（${chatName}）。`,
            `· 发送 /指令 可查看全部可用指令（换角色 / 重置 / 解绑 / 暂停等）`,
            `· 想接着酒馆里已有的聊天继续：在酒馆扩展「进阶设置 → QQ 会话绑定」中把本会话绑到那个聊天；`,
            `· 常用：/角色列表、/状态、/关闭`,
        ].join('\n');
    }

    /** 兜底回复：任何处理失败都要让 QQ 侧知道发生了什么（不允许静默无响应） */
    async _safeReply(norm, text) {
        try {
            const data = await this.bot.sendText(norm.peerId, String(text), norm.scope);
            if (data?.message_id) this._rememberSent(norm.peerKey, data.message_id);
        } catch (err) {
            this._log('error', `兜底回复发送失败: ${err?.message ?? err}`);
        }
    }

    // ---------- 发送回传（含引用/分块/记录 message_id） ----------
    async _sendToPeer(norm, text, { quote = false } = {}) {
        const chunks = chunkText(text, this.settings.maxReplyChars || 1800);
        if (chunks.length === 0) return;
        for (let i = 0; i < chunks.length; i++) {
            let data;
            // 引用的是“触发这条回复的 QQ 消息”本身（norm.messageId），便于在群里对齐上下文
            if (i === 0 && quote && norm.messageId) {
                data = await this.bot.sendReplyText(norm.messageId, norm.peerId, chunks[i], norm.scope);
            } else {
                data = await this.bot.sendText(norm.peerId, chunks[i], norm.scope);
            }
            if (data?.message_id) this._rememberSent(norm.peerKey, data.message_id);
            this._log('info', `回传 ${norm.scope} ${norm.peerId} 第${i + 1}/${chunks.length}块 message_id=${data?.message_id ?? '?'}：${chunks[i].slice(0, 24)}`);
        }
    }

    _rememberSent(peerKey, messageId) {
        let list = this.recentSent.get(peerKey);
        if (!list) {
            list = [];
            this.recentSent.set(peerKey, list);
        }
        list.push({ id: String(messageId), time: Date.now() });
        while (list.length > this._recentCap) list.shift();
        const cutoff = Date.now() - this._recentTtlMs;
        while (list.length && list[0].time < cutoff) list.shift();
    }

    _recentIds(peerKey) {
        const list = this.recentSent.get(peerKey) ?? [];
        return new Set(list.map((x) => x.id));
    }

    _charName(characterKey) {
        return this.host.listCharacters?.().find((c) => c.key === characterKey)?.name ?? characterKey;
    }

    /** 该会话的历史聊天列表（当前绑定置顶，去重） */
    _historyItems(peerKey) {
        const items = [];
        const seen = new Set();
        const cur = this.settings.mapping?.[peerKey];
        const hist = this.settings.bindings?.[peerKey] ?? {};
        const push = (characterKey, chatName) => {
            if (!chatName || seen.has(chatName)) return;
            seen.add(chatName);
            items.push({ characterKey, chatName });
        };
        if (cur?.chatName) push(cur.characterKey, cur.chatName);
        for (const [characterKey, chatName] of Object.entries(hist)) push(characterKey, chatName);
        return items;
    }

    /** 白名单判定：未配置白名单（空）时不限制；配置后仅白名单成员 */
    _isWhitelisted(userId) {
        const owners = this.settings.ownerIds ?? [];
        if (owners.length === 0) return true;
        return owners.map((x) => String(x)).includes(String(userId));
    }

    // ---------- 指令 ----------
    async _runCommand(norm, text) {
        const parts = text.split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const args = parts.slice(1).join(' ');
        const chars = this.host.listCharacters?.() ?? [];
        let reply = '';

        switch (cmd) {
            case '/help':
            case '/帮助':
            case '/指令':
                reply = [
                    '【Tavern Cat】可用指令：',
                    '/指令 - 显示本指令列表',
                    '/引导 - 查看当前接入状态与指引',
                    '/历史 - 列出并选择整个程序的聊天记录（仅白名单管理员）',
                    '/新对话 - 直接开一个全新对话',
                    '/角色列表 - 查看可选角色',
                    '/角色 <名称或序号> - 切换本会话角色（新角色会立即发开场白）',
                    '/重置 - 清空本会话上下文并重新开场',
                    '/解绑 - 解除绑定，回到“未接入”初始状态',
                    '/状态 - 查看本会话绑定',
                    '/关闭 / /开启 - 暂停 / 恢复本会话',
                ].join('\n');
                break;
            case '/引导': {
                const b = this.settings.mapping[norm.peerKey];
                if (b) {
                    reply = `【Tavern Cat】本会话当前绑定：角色「${this._charName(b.characterKey)}」/ 聊天 ${b.chatName ?? '(未建)'}\n· 换角色：发 /角色 <名称>；\n· 看历史聊天：/历史（仅白名单）；\n· 全部指令：/指令`;
                } else {
                    const chars = this.host.listCharacters?.() ?? [];
                    const defKey = this.settings.defaultCharacterKey && chars.some((c) => c.key === this.settings.defaultCharacterKey)
                        ? this.settings.defaultCharacterKey
                        : (chars[0]?.key ?? null);
                    reply = defKey
                        ? `本会话还没有绑定聊天。直接发任意消息，将自动按默认角色「${this._charName(defKey)}」开新对话接入。\n· /指令 查看全部指令`
                        : '本会话还没有绑定聊天，且酒馆里暂无可用角色。请先在酒馆添加角色卡，再发任意消息即可接入。\n· /指令 查看全部指令';
                }
                break;
            }
            case '/角色列表': {
                if (chars.length === 0) {
                    reply = '当前没有任何可用角色，请先在酒馆添加角色卡。';
                } else {
                    reply = ['可选角色：', ...chars.map((c, i) => `${i + 1}. ${c.name}`)].join('\n');
                }
                break;
            }
            case '/角色': {
                if (!args) {
                    reply = '用法：/角色 <名称或序号>，可用 /角色列表 查看';
                    break;
                }
                const num = Number(args);
                const target = Number.isInteger(num) && num >= 1 && num <= chars.length
                    ? chars[num - 1]
                    : chars.find((c) => c.name === args || c.key === args);
                if (!target) {
                    reply = `没有找到角色「${args}」，可用 /角色列表 查看`;
                    break;
                }
                const peerKey = norm.peerKey;
                const oldBinding = this.settings.mapping[peerKey];
                // 优先回到这个角色在本会话用过的旧聊天
                const oldChat = this.settings.bindings[peerKey]?.[target.key] ?? null;
                const binding = { characterKey: target.key, chatName: oldChat };
                try {
                    const switched = await this.host.switchTo(target.key, oldChat, peerKey);
                    binding.chatName = switched.chatName;
                    this.settings.mapping[peerKey] = binding;
                    this.settings.bindings[peerKey] = this.settings.bindings[peerKey] ?? {};
                    this.settings.bindings[peerKey][target.key] = binding.chatName;
                    this.host.persist();
                    if (switched.created) {
                        await this._sendNewChatGreeting(norm, target.key); // 新对话：立刻放开场白
                    }
                    const note = oldBinding?.characterKey === target.key ? '' : `（${switched.created ? '新对话' : '继续旧对话'}）`;
                    reply = `已切换到角色「${target.name}」${note}`;
                } catch (err) {
                    const msg = String(err?.message ?? err);
                    reply = msg.includes('已不存在')
                        ? `切换失败：该聊天文件已不存在。可用 /历史 重新选择，或发 /新对话 开新对话。`
                        : `切换失败：${msg}。请稍后再试。`;
                }
                break;
            }
            case '/重置':
            case '/清空':
            case '/新对话': {
                const peerKey = norm.peerKey;
                let binding = this.settings.mapping[peerKey] ?? null;
                // 未绑定时也允许：自动按默认角色接入并开新对话（不再说“尚未绑定”拒绝）
                if (!binding) {
                    await this.host.waitForCharacters?.();
                    const chars = this.host.listCharacters?.() ?? [];
                    const defKey = this.settings.defaultCharacterKey && chars.some((c) => c.key === this.settings.defaultCharacterKey)
                        ? this.settings.defaultCharacterKey
                        : chars[0]?.key;
                    if (!defKey) {
                        reply = '酒馆里还没有可用的角色卡，暂时无法开新对话。请先在酒馆添加角色卡后再试。';
                        break;
                    }
                    binding = { characterKey: defKey, chatName: null };
                }
                const wasUnbound = !this.settings.mapping[peerKey];
                try {
                    const switched = await this.host.switchTo(binding.characterKey, null, peerKey); // 新建
                    binding.chatName = switched.chatName;
                    this.settings.mapping[peerKey] = binding;
                    this.settings.bindings[peerKey] = this.settings.bindings[peerKey] ?? {};
                    this.settings.bindings[peerKey][binding.characterKey] = switched.chatName;
                    this.host.persist();
                    if (switched.created) {
                        await this._sendNewChatGreeting(norm, binding.characterKey); // 新对话：立刻放开场白
                    }
                    reply = wasUnbound
                        ? `已开新对话，并自动按默认角色「${this._charName(binding.characterKey)}」接入。`
                        : '已开新对话，上下文已清空。';
                } catch (err) {
                    const msg = String(err?.message ?? err);
                    reply = msg.includes('已不存在')
                        ? '重置失败：原聊天文件已不存在。已按默认角色重新准备，请再发 /新对话 或直接发消息。'
                        : `重置失败：${msg}`;
                }
                break;
            }
            case '/解绑':
            case '/初始化': {
                const peerKey = norm.peerKey;
                if (!this.settings.mapping[peerKey] && !this.settings.bindings[peerKey]) {
                    reply = '本会话本来就没有绑定，无需解绑。';
                    break;
                }
                this.unbindPeer(peerKey);                 // 删除 mapping + bindings
                delete this.settings.peerEnabled[peerKey]; // 开关复位为默认开启
                this.host.persist();
                reply = '本会话已解绑，恢复为“未接入”初始状态：再发任意消息会按默认角色重新接入（并重新收到接入引导）。\n提示：若想绑定到酒馆里指定的已有聊天，可在酒馆扩展「进阶设置 → QQ 会话绑定」中设置。';
                break;
            }
            case '/历史':
            case '/历史记录': {
                const peerKey = norm.peerKey;
                // 严格白名单：必须配置并命中白名单，否则一律拒绝
                const owners = this.settings.ownerIds ?? [];
                if (owners.length === 0) {
                    reply = '未配置白名单：/历史 需要管理员权限。请先在扩展「进阶设置 → 私聊白名单」里添加你的 QQ 后再使用。';
                    break;
                }
                if (!owners.map((x) => String(x)).includes(String(norm.userId))) {
                    reply = '无权使用该指令：/历史 仅限白名单用户调用。';
                    break;
                }
                const items = await this.host.fetchChatHistory?.(40);
                if (items === null) {
                    reply = '读取程序聊天记录失败，请查看扩展日志。';
                    break;
                }
                const current = this.settings.mapping?.[peerKey]?.chatName;
                if (!args) {
                    if (items.length === 0) {
                        reply = '程序里还没有任何聊天记录（先在酒馆里和角色聊几句吧）。';
                        break;
                    }
                    const lines = items.map((it, i) => {
                        const mark = it.chatName === current ? '（当前）' : '';
                        const prev = it.preview ? ` —— ${it.preview}` : '';
                        return `${i + 1}. ${this._charName(it.characterKey)} · ${it.chatName}${mark}${prev}`;
                    });
                    reply = ['【Tavern Cat】程序聊天记录（最近优先）：', ...lines, '', '回复 /历史 <编号> 把本会话切换到对应聊天（如 /历史 1）'].join('\n');
                } else {
                    const n = Number(args);
                    const target = Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : null;
                    if (!target) {
                        reply = `编号无效（1-${items.length}）。先发 /历史 查看列表。`;
                        break;
                    }
                    try {
                        const switched = await this.host.switchTo(target.characterKey, target.chatName, peerKey);
                        const chatName = switched.chatName;
                        this.settings.mapping[peerKey] = { characterKey: target.characterKey, chatName };
                        this.settings.bindings[peerKey] = this.settings.bindings[peerKey] ?? {};
                        this.settings.bindings[peerKey][target.characterKey] = chatName;
                        this.host.persist();
                        reply = `已切换到聊天「${this._charName(target.characterKey)}」/ ${chatName}（原对话继续）`;
                    } catch (err) {
                        const msg = String(err?.message ?? err);
                        reply = msg.includes('已不存在')
                            ? '切换失败：该聊天文件已不存在。可用 /历史 重新选择，或发 /新对话 开新对话。'
                            : `切换失败：${msg}（请稍后再试）`;
                    }
                }
                break;
            }
            case '/状态': {
                const peerKey = norm.peerKey;
                const binding = this.settings.mapping[peerKey];
                const enabled = this.isPeerEnabled(peerKey) ? '开启' : '关闭';
                reply = binding
                    ? `本会话：角色「${this._charName(binding.characterKey)}」 / 聊天 ${binding.chatName ?? '(未创建)'}\n状态：${enabled}`
                    : `本会话尚未绑定聊天（状态：${enabled}）。\n直接发任意消息即按默认角色接入；也可 /历史 选择已有聊天。`;
                break;
            }
            case '/关闭':
                this.setPeerEnabled(norm.peerKey, false);
                reply = '本会话已暂停（酒馆桥不再回复）。用 /开启 恢复。';
                break;
            case '/开启':
                this.setPeerEnabled(norm.peerKey, true);
                reply = '本会话已恢复。';
                break;
            default:
                return; // 非桥指令：放给 LLM（比如用户和角色扮演中提及 /）
        }

        if (reply) {
            try {
                await this._sendToPeer(norm, reply, { quote: norm.scope === 'group' });
            } catch (err) {
                this._log('error', `指令回传失败: ${err?.message ?? err}`);
            }
        }
    }

    // ---------- 酒馆 -> QQ 方向 ----------
    /**
     * 用户在酒馆手动发的消息（无 QQ 来源标记且当前聊天绑定某 QQ 会话）：
     * 转发给对应 QQ 会话。返回 true 表示已转发。
     */
    async forwardUserMessage(peerKey, text) {
        if (!this.bot?.isConnected) return false;
        if (!this.isPeerEnabled(peerKey)) return false;
        const target = parsePeerKey(peerKey);
        if (!target) return false;
        try {
            const data = await this.bot.sendText(target.peerId, String(text).trim(), target.scope);
            if (data?.message_id) this._rememberSent(peerKey, data.message_id);
            this._log('info', `酒馆 -> ${peerKey}: ${String(text).slice(0, 40)}`);
            return true;
        } catch (err) {
            this._log('error', `酒馆转发失败 ${peerKey}: ${err?.message ?? err}`);
            return false;
        }
    }

    /**
     * 酒馆侧助手新回复的回推：仅在“这轮不是桥自动回合”时使用（由胶水层判断来源），
     * 避免把桥自己生成的回复二次回传。
     */
    async forwardAssistantMessage(peerKey, text) {
        if (this.inTurn && this.turnPeerKey === peerKey) return false;
        return this.forwardUserMessage(peerKey, text);
    }

    _emitStats() {
        if (this.onStats) {
            try {
                this.onStats({
                    queue: this.queue.length,
                    draining: this.draining,
                    inTurn: this.inTurn,
                    turnPeerKey: this.turnPeerKey,
                    stats: this.stats,
                });
            } catch { /* 忽略 */ }
        }
    }
}

/** 'g:123' / 'p:456' -> {scope, peerId}；解析失败返回 null */
export function parsePeerKey(peerKey) {
    const m = /^(g|p):(\d+)$/.exec(String(peerKey ?? ''));
    if (!m) return null;
    return { scope: m[1] === 'g' ? 'group' : 'private', peerId: Number(m[2]) };
}

export { COMMAND_NAMES };
