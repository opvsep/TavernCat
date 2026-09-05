// 桥接编排层端到端测试：真实 OneBotClient + FakeNapCat + 桩酒馆宿主(TavernHost) + NapcatBridge
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneBotClient } from '../core/onebot.js';
import { NapcatBridge, chunkText, DEFAULT_SETTINGS, parsePeerKey } from '../core/bridge.js';
import { FakeNapCatServer, sleep } from './fake-napcat.mjs';

// ---------- 桩酒馆宿主 ----------

class StubTavern {
    constructor(options = {}) {
        this.characters = options.characters ?? [
            { key: 'av-amiya', name: '阿米娅' },
            { key: 'av-w', name: 'W' },
        ];
        this.greetings = options.greetings ?? { 'av-amiya': '你好呀，{{user}}，我是阿米娅~', 'av-w': '哼哼，我是W。' };
        this.replyText = options.replyText ?? ((lastUser) => `回复：${lastUser}`);
        this.chatCounter = 0;
        this.current = { characterKey: null, chatName: null };
        this.history = {}; // "charKey|chatName" -> [{role, name, text}]
        this.persistCount = 0;
        this.switchLog = [];
    }

    isReady() { return true; }
    listCharacters() { return this.characters; }
    current() {
        return { ...this.current, peerKey: null };
    }

    async switchTo(characterKey, chatName = null) {
        this.switchLog.push({ characterKey, chatName });
        const char = this.characters.find((c) => c.key === characterKey);
        if (!char) throw new Error(`角色不存在: ${characterKey}`);
        let created = false;
        if (!chatName) {
            this.chatCounter += 1;
            chatName = `${char.name}-聊天${this.chatCounter}`;
            this.history[`${characterKey}|${chatName}`] = [];
            created = true;
        } else if (!this.history[`${characterKey}|${chatName}`]) {
            this.history[`${characterKey}|${chatName}`] = []; // 打开已存在文件：历史由"磁盘"载入
        }
        this.current = { characterKey, chatName };
        return { chatName, created };
    }

    getGreeting(characterKey) {
        return this.greetings[characterKey] ?? null;
    }

    async getAvatarImage() {
        return null; // 测试默认无自定义头像；需要时用例内覆写
    }

    async injectUserMessage(text, meta = {}) {
        const key = `${this.current.characterKey}|${this.current.chatName}`;
        this.history[key].push({ role: 'user', name: meta.senderName ?? '我', text, extra: { qq: meta } });
    }

    async injectAssistantMessage(text) {
        const key = `${this.current.characterKey}|${this.current.chatName}`;
        this.history[key].push({ role: 'assistant', name: '角色', text, extra: {} });
    }

    async waitTurnReady() { return true; }

    async generateReply() {
        const key = `${this.current.characterKey}|${this.current.chatName}`;
        const msgs = this.history[key] ?? [];
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
        const reply = typeof this.replyText === 'function'
            ? this.replyText(lastUser?.text ?? '', this.current)
            : String(this.replyText);
        this.history[key].push({ role: 'assistant', name: '角色', text: reply, extra: {} });
        return { text: reply };
    }

    notify() { }
    persist() { this.persistCount += 1; }
}

// ---------- 组装 ----------

const silent = { log() { }, warn() { }, error() { } };

async function setup(options = {}) {
    const server = new FakeNapCatServer({ heartInterval: 60000, logger: false });
    await server.start();
    const bot = new OneBotClient({ url: `ws://127.0.0.1:${server.port}`, logger: silent });
    const tavern = new StubTavern(options.tavern);
    const settings = {
        ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
        ...(options.settings ?? {}),
        mapping: { ...(options.settings?.mapping ?? {}) },
        bindings: { ...(options.settings?.bindings ?? {}) },
        peerEnabled: { ...(options.settings?.peerEnabled ?? {}) },
    };
    const bridge = new NapcatBridge({ bot, host: tavern, settings, logger: silent });
    bot.connect();
    for (let i = 0; i < 200 && !bot.isConnected; i++) await sleep(25);
    if (!bot.isConnected) throw new Error('测试客户端未能连上假 NapCat');
    return { server, bot, tavern, bridge, settings };
}

async function teardown(ctx) {
    ctx.bot.close();
    await ctx.server.stop();
}

const waitSentCount = async (server, n, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (server.sent.length >= n) return true;
        await sleep(25);
    }
    return server.sent.length >= n;
};

// ---------- 用例 ----------

test('群聊 @机器人 触发完整回合：注入、生成、引用回传、会话持久化', async () => {
    const settings = {
        mapping: { 'g:111': { characterKey: 'av-amiya', chatName: '阿米娅-旧档' } },
        bindings: { 'g:111': { 'av-amiya': '阿米娅-旧档' } },
    };
    const ctx = await setup({ settings, tavern: { greetings: {} } });
    try {
        ctx.tavern.history['av-amiya|阿米娅-旧档'] = [{ role: 'assistant', name: '阿米娅', text: '旧开场', extra: {} }];

        ctx.server.pushGroupMessage({
            groupId: 111, userId: 222, nickname: '小明', messageId: 9001,
            segments: [{ type: 'at', data: { qq: String(ctx.server.selfId) } }, { type: 'text', data: { text: '今晚吃什么' } }],
        });

        assert.ok(await waitSentCount(ctx.server, 1), '应回传一条');
        assert.equal(ctx.server.sent.length, 1);
        const s = ctx.server.sent[0];
        assert.equal(s.action, 'send_group_msg');
        assert.equal(s.params.group_id, 111);
        // 引用触发消息（messageId=9001）
        assert.equal(s.params.message[0].type, 'reply');
        assert.equal(s.params.message[0].data.id, '9001');
        const body = s.params.message.map((m) => m.data.text ?? '').join('');
        assert.equal(body, '回复：今晚吃什么');

        // 酒馆侧历史
        const key = 'av-amiya|阿米娅-旧档';
        const hist = ctx.tavern.history[key];
        assert.equal(hist.length, 3);
        assert.equal(hist[1].role, 'user');
        assert.equal(hist[1].text, '今晚吃什么');
        assert.equal(hist[1].extra.qq.peerKey, 'g:111');
        assert.equal(hist[2].role, 'assistant');

        // 绑定持久化
        assert.deepEqual(ctx.settings.mapping['g:111'], { characterKey: 'av-amiya', chatName: '阿米娅-旧档' });
        assert.ok(ctx.tavern.persistCount > 0);
    } finally {
        await teardown(ctx);
    }
});

test('群聊未 @ 不触发（at_reply 模式）；回复机器人消息可触发', async () => {
    const ctx = await setup({
        settings: { mapping: { 'g:111': { characterKey: 'av-amiya', chatName: 'c1' } } },
        tavern: { greetings: {} },
    });
    try {
        // 1) 未 @ -> 不触发
        ctx.server.pushGroupMessage({
            groupId: 111, userId: 222, nickname: '小明', messageId: 9001,
            segments: [{ type: 'text', data: { text: '大家晚上好' } }],
        });
        await sleep(300);
        assert.equal(ctx.server.sent.length, 0, '未 @ 不应回复');

        // 2) 直接 @ -> 触发一次（用于产生 recentSent）
        ctx.server.pushGroupMessage({
            groupId: 111, userId: 222, nickname: '小明', messageId: 9002,
            segments: [{ type: 'at', data: { qq: String(ctx.server.selfId) } }, { type: 'text', data: { text: '在吗' } }],
        });
        assert.ok(await waitSentCount(ctx.server, 1));
        const sentId = ctx.server.sent[0].params.message[0].data.id; // 引用段
        assert.equal(sentId, '9002');

        // 3) 无 @ 但“回复”机器人刚发的消息（reply 段 id=机器人消息 id 需在 recentSent 里）
        //    先注入一次普通 @ 消息获取机器人自己的 message_id 记录：
        //    假服务器不会推送“自己发的消息”，这里直接把最近发送的 message_id 记入桥的 recentSent 不可行，
        //    所以改测：回复 id 指向刚收到的 9003 对应机器人回复？recentSent 记录的是 bot 发出的消息 id（服务器返回 data.message_id）。
        //    用服务器返回的 message_id：服务器把 send_group_msg 的 message_id 置为 nextMessageId（递增），
        //    我们读 ctx.server.sent 已拿不到 data，改为从第二次触发结果记录：
        //    第2步返回的机器人消息 id = ?（send 动作返回 1,2,...）这里直接查询最后记录：
        // 简化验证：回复段引用一个“机器人发过的消息 id”（用假服务器下一条 send 的返回值预置）。
        // 先查服务器 sent 计数：
        const botMsgId = ctx.server.nextMessageId; // 下一次 send_group_msg 会返回的 id（尚未发生，用于下面的回复引用不对）
        void botMsgId;
        // 改为：先让桥发一条 -> 拿返回 id 记入桥，再推送“回复该 id”的消息
        // 触发一次 @，读取服务器返回（通过改造：直接读 ctx.bot 的 recentSent 不便，这里用 push 一条引用 id=1 的消息，因为
        // 假服务器第一次 send 返回 message_id=1 且桥已把它记入 recentSent）
        ctx.server.pushGroupMessage({
            groupId: 111, userId: 333, nickname: '小红', messageId: 9003,
            segments: [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '我也觉得' } }],
        });
        assert.ok(await waitSentCount(ctx.server, 2), '回复机器人消息应触发');
        const s2 = ctx.server.sent[1];
        assert.equal(s2.params.message[0].data.id, '9003', '应引用小红的这条消息');
        assert.ok(String(s2.params.message.map((m) => m.data.text).join('')).includes('回复：我也觉得'));
    } finally {
        await teardown(ctx);
    }
});

test('群聊模式 all：每条消息都回；at_only：仅 @ 回', async () => {
    let ctx = await setup({
        settings: {
            groupMode: 'all',
            mapping: { 'g:111': { characterKey: 'av-amiya', chatName: 'c1' } },
        },
        tavern: { greetings: {} },
    });
    try {
        ctx.server.pushGroupMessage({ groupId: 111, userId: 222, nickname: '小明', messageId: 9101, segments: [{ type: 'text', data: { text: '随便聊聊' } }] });
        assert.ok(await waitSentCount(ctx.server, 1), 'all 模式应回复任意消息');
    } finally {
        await teardown(ctx);
    }

    ctx = await setup({
        settings: {
            groupMode: 'at_only',
            mapping: { 'g:111': { characterKey: 'av-amiya', chatName: 'c1' } },
        },
        tavern: { greetings: {} },
    });
    try {
        ctx.server.pushGroupMessage({ groupId: 111, userId: 222, nickname: '小明', messageId: 9102, segments: [{ type: 'text', data: { text: '聊' } }] });
        await sleep(300);
        assert.equal(ctx.server.sent.length, 0, 'at_only 下未 @ 不回');
        ctx.server.pushGroupMessage({
            groupId: 111, userId: 222, nickname: '小明', messageId: 9103,
            segments: [{ type: 'at', data: { qq: String(ctx.server.selfId) } }, { type: 'text', data: { text: '聊' } }],
        });
        assert.ok(await waitSentCount(ctx.server, 1), 'at_only 下 @ 回');
    } finally {
        await teardown(ctx);
    }
});

test('新会话自动绑定默认角色并放开场白；首次接入发引导消息；/角色 切换绑定；/状态 查询', async () => {
    const ctx = await setup({
        settings: { defaultCharacterKey: 'av-amiya', ownerIds: [] },
        tavern: { greetings: { 'av-amiya': '你好呀，{{user}}，我是阿米娅~', 'av-w': '哼哼，我是W。' } },
    });
    try {
        // 私聊新用户（无绑定）-> 自动建会话 + 开场白 + 回复 + 接入引导（共 4 条? 不：开场白+回复+引导 = 3 条）
        ctx.server.pushPrivateMessage({ userId: 555, nickname: '新朋友', messageId: 9201, segments: [{ type: 'text', data: { text: '你是谁' } }] });
        assert.ok(await waitSentCount(ctx.server, 3), '应发开场白+回复+接入引导共三条');
        assert.equal(ctx.server.sent[0].action, 'send_private_msg');
        assert.equal(ctx.server.sent[0].params.message[0].data.text, '你好呀，新朋友，我是阿米娅~');
        assert.equal(ctx.server.sent[1].params.message[0].data.text, '回复：你是谁');
        const notice = ctx.server.sent[2].params.message.map((m) => m.data.text ?? '').join('');
        assert.match(notice, /Tavern Cat/, '第三条应为接入引导消息');
        assert.match(notice, /阿米娅/, '引导消息应带角色名');
        assert.match(notice, /\/指令/, '引导消息应提示使用 /指令');

        // 绑定表
        const bind = ctx.settings.mapping['p:555'];
        assert.ok(bind, '应有绑定');
        assert.equal(bind.characterKey, 'av-amiya');
        assert.ok(bind.chatName);

        // 群里发指令切换角色（需 @ 触发）：新对话应立刻发该角色的开场白
        ctx.server.pushGroupMessage({
            groupId: 999, userId: 555, nickname: '新朋友', messageId: 9202,
            segments: [{ type: 'at', data: { qq: String(ctx.server.selfId) } }, { type: 'text', data: { text: '/角色 2' } }],
        });
        assert.ok(await waitSentCount(ctx.server, 5), '切角色应发 开场白+切换确认 两条');
        const wGreeting = ctx.server.sent[3].params.message.map((m) => m.data.text ?? '').join('');
        assert.equal(wGreeting, '哼哼，我是W。', '新角色开场白应立刻发到 QQ');
        const cmdReply = ctx.server.sent[4];
        const cmdText = cmdReply.params.message.map((m) => m.data.text ?? '').join('');
        assert.match(cmdText, /W/);
        assert.equal(ctx.settings.mapping['g:999'].characterKey, 'av-w');
        assert.equal(ctx.settings.mapping['g:999'].chatName, ctx.tavern.current.chatName, '应绑定到新建的 W 聊天');
        assert.equal(ctx.tavern.history[`av-w|${ctx.tavern.current.chatName}`].length, 1, '开场白应写入新聊天历史');

        // /状态
        ctx.server.pushPrivateMessage({ userId: 555, nickname: '新朋友', messageId: 9203, segments: [{ type: 'text', data: { text: '/状态' } }] });
        assert.ok(await waitSentCount(ctx.server, 6));
        const st = ctx.server.sent[5].params.message.map((m) => m.data.text ?? '').join('');
        assert.match(st, /阿米娅/);
    } finally {
        await teardown(ctx);
    }
});

test('私聊白名单：非白名单忽略，白名单回复', async () => {
    const ctx = await setup({
        settings: {
            ownerIds: [10086],
            mapping: { 'p:10086': { characterKey: 'av-amiya', chatName: 'c1' } },
        },
        tavern: { greetings: {} },
    });
    try {
        ctx.server.pushPrivateMessage({ userId: 777, nickname: '陌生人', messageId: 9301, segments: [{ type: 'text', data: { text: '在吗' } }] });
        await sleep(300);
        assert.equal(ctx.server.sent.length, 0, '非白名单私聊不应回复');

        ctx.server.pushPrivateMessage({ userId: 10086, nickname: '主人', messageId: 9302, segments: [{ type: 'text', data: { text: '在吗' } }] });
        assert.ok(await waitSentCount(ctx.server, 1), '白名单私聊应回复');
    } finally {
        await teardown(ctx);
    }
});

test('/关闭 停用会话；开启恢复', async () => {
    const ctx = await setup({
        settings: { mapping: { 'p:1': { characterKey: 'av-amiya', chatName: 'c1' } } },
        tavern: { greetings: {} },
    });
    try {
        // 关闭
        ctx.server.pushPrivateMessage({ userId: 1, nickname: '主人', messageId: 9401, segments: [{ type: 'text', data: { text: '/关闭' } }] });
        assert.ok(await waitSentCount(ctx.server, 1));
        assert.equal(ctx.settings.peerEnabled['p:1'], false);
        // 停用后不再回复
        ctx.server.pushPrivateMessage({ userId: 1, nickname: '主人', messageId: 9402, segments: [{ type: 'text', data: { text: '喂喂' } }] });
        await sleep(300);
        assert.equal(ctx.server.sent.length, 1, '停用后不应回复');
        // 恢复
        ctx.server.pushPrivateMessage({ userId: 1, nickname: '主人', messageId: 9403, segments: [{ type: 'text', data: { text: '/开启' } }] });
        assert.ok(await waitSentCount(ctx.server, 2));
        ctx.server.pushPrivateMessage({ userId: 1, nickname: '主人', messageId: 9404, segments: [{ type: 'text', data: { text: '在吗' } }] });
        assert.ok(await waitSentCount(ctx.server, 3), '恢复后应回复');
    } finally {
        await teardown(ctx);
    }
});

test('酒馆 -> QQ 转发：forwardUserMessage 发纯文本；桥回合内 forwardAssistant 被拦截', async () => {
    const ctx = await setup({ settings: {}, tavern: { greetings: {} } });
    try {
        // 手动转发
        const ok = await ctx.bridge.forwardUserMessage('g:111', '大家好，我是酒馆里的角色');
        assert.equal(ok, true);
        assert.equal(ctx.server.sent.length, 1);
        assert.equal(ctx.server.sent[0].action, 'send_group_msg');
        assert.equal(ctx.server.sent[0].params.message[0].data.text, '大家好，我是酒馆里的角色');

        // 桥回合内：拦截助手回推
        ctx.bridge.inTurn = true;
        ctx.bridge.turnPeerKey = 'g:111';
        const blocked = await ctx.bridge.forwardAssistantMessage('g:111', '别回传');
        assert.equal(blocked, false);
        assert.equal(ctx.server.sent.length, 1);

        // 非回合：允许
        ctx.bridge.inTurn = false;
        const ok2 = await ctx.bridge.forwardAssistantMessage('g:111', '手动生成的回复');
        assert.equal(ok2, true);
        assert.equal(ctx.server.sent.length, 2);
    } finally {
        await teardown(ctx);
    }
});

test('长回复按换行分块，保持顺序', async () => {
    const ctx = await setup({
        settings: { maxReplyChars: 50, mapping: { 'g:111': { characterKey: 'av-amiya', chatName: 'c1' } } },
        tavern: { greetings: {} },
    });
    try {
        // 8 段、每段 18 字：50 字上限下每块约装 2 段 -> 至少 4 块
        const longReply = Array.from({ length: 8 }, (_, i) => `第${i + 1}段${'字'.repeat(15)}`).join('\n');
        ctx.tavern.replyText = () => longReply;
        ctx.server.pushGroupMessage({
            groupId: 111, userId: 222, nickname: '小明', messageId: 9501,
            segments: [{ type: 'at', data: { qq: String(ctx.server.selfId) } }, { type: 'text', data: { text: '来段长的' } }],
        });
        assert.ok(await waitSentCount(ctx.server, 4, 6000), '应分块发送');
        const texts = ctx.server.sent.map((s) => s.params.message.map((m) => m.data.text ?? '').join(''));
        assert.ok(texts.length >= 4, '至少 4 块');
        assert.ok(texts.every((t) => t.length > 0 && t.length <= 50), '每块不超上限');
        // 每个 QQ 气泡自带换行语义：以 '\n' 连接可无损还原原文
        assert.equal(texts.join('\n'), longReply, '内容完整且顺序一致');
        assert.match(texts[0], /^第1段/);
        assert.match(texts[texts.length - 1], /第8段/);
    } finally {
        await teardown(ctx);
    }
});

test('无可用角色时不得沉默：向 QQ 回复原因说明', async () => {
    const ctx = await setup({
        settings: { defaultCharacterKey: '' },
        tavern: { characters: [], greetings: {} },
    });
    try {
        ctx.server.pushPrivateMessage({ userId: 666, nickname: '路人', messageId: 9601, segments: [{ type: 'text', data: { text: '你好' } }] });
        assert.ok(await waitSentCount(ctx.server, 1), '应回复一条说明');
        const t = ctx.server.sent[0].params.message.map((m) => m.data.text ?? '').join('');
        assert.match(t, /Tavern Cat/, '说明消息带 Tavern Cat 前缀');
        assert.match(t, /角色卡/, '说明应提示缺少角色卡');
        assert.match(t, /\/指令/, '说明应引导使用 /指令');
    } finally {
        await teardown(ctx);
    }
});

test('/引导 指令可手动触发接入引导（未绑定场景）', async () => {
    const ctx = await setup({ settings: {}, tavern: { greetings: {} } });
    try {
        ctx.server.pushPrivateMessage({ userId: 777, nickname: '主人', messageId: 9602, segments: [{ type: 'text', data: { text: '/引导' } }] });
        assert.ok(await waitSentCount(ctx.server, 1), '/引导 应回复');
        const t = ctx.server.sent[0].params.message.map((m) => m.data.text ?? '').join('');
        assert.match(t, /Tavern Cat/);
        assert.match(t, /还没有绑定/);
    } finally {
        await teardown(ctx);
    }
});

test('/指令 展示全部指令；/解绑 恢复初始状态并支持重新接入', async () => {
    const ctx = await setup({
        settings: { defaultCharacterKey: 'av-amiya', ownerIds: [] },
        tavern: { greetings: { 'av-amiya': '你好呀，{{user}}，我是阿米娅~' } },
    });
    try {
        // 首次接入：开场白+回复+引导 = 3 条
        ctx.server.pushPrivateMessage({ userId: 888, nickname: '新客', messageId: 9701, segments: [{ type: 'text', data: { text: '在吗' } }] });
        assert.ok(await waitSentCount(ctx.server, 3), '首聊应发 3 条');
        const notice = ctx.server.sent[2].params.message.map((m) => m.data.text ?? '').join('');
        assert.match(notice, /\/指令/, '首次引导应提示 /指令');

        // /指令 全列表
        ctx.server.pushPrivateMessage({ userId: 888, nickname: '新客', messageId: 9702, segments: [{ type: 'text', data: { text: '/指令' } }] });
        assert.ok(await waitSentCount(ctx.server, 4), '/指令 应回复');
        const help = ctx.server.sent[3].params.message.map((m) => m.data.text ?? '').join('');
        for (const cmd of ['/指令', '/引导', '/角色', '/重置', '/解绑', '/状态', '/关闭', '/开启']) {
            assert.ok(help.includes(cmd), `指令列表应包含 ${cmd}`);
        }

        // /解绑：回到初始状态
        ctx.server.pushPrivateMessage({ userId: 888, nickname: '新客', messageId: 9703, segments: [{ type: 'text', data: { text: '/解绑' } }] });
        assert.ok(await waitSentCount(ctx.server, 5), '/解绑 应回复');
        const unbind = ctx.server.sent[4].params.message.map((m) => m.data.text ?? '').join('');
        assert.match(unbind, /已解绑/);
        assert.equal(ctx.settings.mapping['p:888'], undefined, '解绑后 mapping 应删除');

        // 再次发言 -> 重新按首次接入处理
        ctx.server.pushPrivateMessage({ userId: 888, nickname: '新客', messageId: 9704, segments: [{ type: 'text', data: { text: '再聊聊' } }] });
        assert.ok(await waitSentCount(ctx.server, 8), '解绑后再次发言应重新接入（3 条）');
        assert.ok(ctx.settings.mapping['p:888'], '重新接入后 mapping 重建');
        const notice2 = ctx.server.sent[7].params.message.map((m) => m.data.text ?? '').join('');
        assert.match(notice2, /\/指令/, '重新接入仍发带 /指令 的引导');
    } finally {
        await teardown(ctx);
    }
});

test('角色无自定义头像（默认头像）：新接入时不发图片，只发开场白', async () => {
    const ctx = await setup({
        settings: { defaultCharacterKey: 'av-amiya', ownerIds: [] },
        tavern: { greetings: { 'av-amiya': '你好呀，我是阿米娅~' } },
    });
    try {
        ctx.server.pushPrivateMessage({ userId: 901, nickname: 'A', messageId: 9801, segments: [{ type: 'text', data: { text: '嗨' } }] });
        assert.ok(await waitSentCount(ctx.server, 3), '应发 开场白+回复+引导');
        assert.notEqual(ctx.server.sent[0].params.message[0].type, 'image', '无自定义头像不应发图片');
    } finally {
        await teardown(ctx);
    }
});

test('角色有自定义头像：新接入时先发头像图片，再发开场白', async () => {
    const ctx = await setup({
        settings: { defaultCharacterKey: 'av-amiya', ownerIds: [] },
        tavern: { greetings: { 'av-amiya': '你好呀，我是阿米娅~' } },
    });
    ctx.tavern.getAvatarImage = async () => ({ file: 'base64://aW1nZGF0YQ==' });
    try {
        ctx.server.pushPrivateMessage({ userId: 902, nickname: 'B', messageId: 9802, segments: [{ type: 'text', data: { text: '嗨' } }] });
        assert.ok(await waitSentCount(ctx.server, 4), '有头像时应发 图+开场白+回复+引导 共 4 条');
        assert.equal(ctx.server.sent[0].params.message[0].type, 'image', '第一条应是图片');
        assert.equal(ctx.server.sent[0].params.message[0].data.file, 'base64://aW1nZGF0YQ==', '图片数据直传（base64://）');
        const g = ctx.server.sent[1].params.message.map((m) => m.data.text ?? '').join('');
        assert.equal(g, '你好呀，我是阿米娅~', '图片之后紧跟开场白');
    } finally {
        await teardown(ctx);
    }
});

test('工具函数：chunkText 与 parsePeerKey', () => {
    assert.deepEqual(chunkText('', 10), []);
    const c = chunkText('a'.repeat(10) + '\n' + 'b'.repeat(10), 10);
    assert.equal(c.length, 2);
    assert.deepEqual(parsePeerKey('g:123'), { scope: 'group', peerId: 123 });
    assert.deepEqual(parsePeerKey('p:456'), { scope: 'private', peerId: 456 });
    assert.equal(parsePeerKey('x:1'), null);
});
