// 核心模块单元测试（不依赖 SillyTavern，只依赖 Node 24 自带 WebSocket 与本地 fake NapCat）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeCqText, unescapeCqText, parseCqString, segmentsToPlainText, textSegments, replySegments } from '../core/cqcode.js';
import { OneBotClient, OneBotError } from '../core/onebot.js';
import { FakeNapCatServer, sleep } from './fake-napcat.mjs';

// ---------- 工具 ----------

async function withServer(options, fn) {
    const server = new FakeNapCatServer(options);
    await server.start();
    try {
        await fn(server);
    } finally {
        await server.stop();
    }
}

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(stepMs);
    }
    return predicate();
}

/** 等待客户端连上（返回是否成功） */
async function waitConnected(client, timeoutMs = 4000) {
    return waitFor(() => client.isConnected, { timeoutMs });
}

/** 从事件流中找一条事件 */
const findEvent = (seen, predicate) => seen.find(predicate);

// ---------- CQ 码 ----------

test('CQ 码：转义/反转义四字符规则', () => {
    assert.equal(escapeCqText('a&b[c]d'), 'a&amp;b&#91;c&#93;d');
    assert.equal(unescapeCqText('a&amp;b&#91;c&#93;d'), 'a&b[c]d');
    // 逗号只在 CQ 参数值中需要转，文本层保持原样
    assert.equal(unescapeCqText('&#44;'), ',');
    assert.equal(unescapeCqText('&amp;#91;'), '&#91;'); // &amp; 最后解
});

test('CQ 码：解析 CQ 字符串为段数组', () => {
    const segs = parseCqString('[CQ:at,qq=all]早[呀] [CQ:face,id=14] tail&end');
    assert.deepEqual(segs, [
        { type: 'at', data: { qq: 'all' } },
        { type: 'text', data: { text: '早[呀] ' } },
        { type: 'face', data: { id: '14' } },
        { type: 'text', data: { text: ' tail&end' } },
    ]);
});

test('CQ 码：被转义的字面 [CQ:...] 不会被误解析', () => {
    const segs = parseCqString('&#91;CQ:at,qq=all&#93;说个事');
    assert.deepEqual(segs, [{ type: 'text', data: { text: '[CQ:at,qq=all]说个事' } }]);
});

test('CQ 码：段数组渲染纯文本（@/图片/表情占位）', () => {
    const segs = [
        { type: 'at', data: { qq: '123456' } },
        { type: 'text', data: { text: ' 看这个 ' } },
        { type: 'image', data: { url: 'http://x/img.png' } },
        { type: 'text', data: { text: '!' } },
    ];
    assert.equal(segmentsToPlainText(segs), '@123456 看这个 [图片]!');
    assert.equal(segmentsToPlainText([{ type: 'at', data: { qq: 'all' } }]), '@全体成员');
});

test('发送辅助：纯文本与引用回复的段数组形态', () => {
    assert.deepEqual(textSegments('a<b>'), [{ type: 'text', data: { text: 'a<b>' } }]);
    assert.deepEqual(replySegments(42, 'ok'), [
        { type: 'reply', data: { id: '42' } },
        { type: 'text', data: { text: 'ok' } },
    ]);
});

// ---------- OneBot 客户端（对 fake NapCat 全链路） ----------

test('OneBot：连上收到 lifecycle，动作有回包，消息事件能收到', async () => {
    await withServer({ heartInterval: 60000 }, async (server) => {
        const seen = [];
        const client = new OneBotClient({ url: `ws://127.0.0.1:${server.port}` });
        client.onEvent = (ev) => seen.push(ev);
        client.connect();
        try {
            // 1. lifecycle/connect
            assert.ok(await waitFor(() => findEvent(seen, (e) => e.post_type === 'meta_event' && e.meta_event_type === 'lifecycle')), '应收到 lifecycle/connect');

            // 2. 注入一条群消息（显式 messageId=9001，避免占用计数）
            server.pushGroupMessage({
                groupId: 111, userId: 222, nickname: '小明', messageId: 9001,
                segments: [{ type: 'at', data: { qq: String(server.selfId) } }, { type: 'text', data: { text: '你好呀' } }],
            });
            assert.ok(await waitFor(() => findEvent(seen, (e) => e.message_id === 9001)), '应收到注入的群消息事件');
            const got = findEvent(seen, (e) => e.message_id === 9001);
            assert.equal(got.message_type, 'group');
            assert.equal(got.group_id, 111);
            assert.equal(got.self_id, server.selfId, '事件应带机器人自身 self_id');

            // 3. send_group_msg（回包 message_id 应为 1：计数未被事件占用）
            const data = await client.sendText(111, 'hello <world>', 'group');
            assert.equal(data.message_id, 1);
            assert.equal(server.sent.length, 1);
            assert.equal(server.sent[0].action, 'send_group_msg');
            assert.deepEqual(server.sent[0].params, {
                group_id: 111,
                message: [{ type: 'text', data: { text: 'hello <world>' } }],
            });

            // 4. get_login_info 自检
            const info = await client.getLoginInfo();
            assert.equal(info.user_id, server.selfId);
        } finally {
            client.close();
        }
    });
});

test('OneBot：token 校验走 access_token query（浏览器无法自定义请求头）', async () => {
    await withServer({ token: 's3cret' }, async (server) => {
        const client = new OneBotClient({ url: `ws://127.0.0.1:${server.port}`, token: 's3cret' });
        client.connect();
        try {
            assert.ok(await waitConnected(client), '带正确 token 应能连上');
            // 不带 token 的客户端应被拒绝（close 后不再重连）
            const bad = new OneBotClient({ url: `ws://127.0.0.1:${server.port}` });
            bad.connect();
            await sleep(300);
            assert.equal(bad.isConnected, false);
            bad.close();
        } finally {
            client.close();
        }
    });
});

test('OneBot：错误动作返回 retcode!=0 时按失败处理', async () => {
    await withServer({}, async (server) => {
        const client = new OneBotClient({ url: `ws://127.0.0.1:${server.port}` });
        client.connect();
        try {
            assert.ok(await waitConnected(client));
            await assert.rejects(() => client.sendAction('no_such_action', {}), (err) => {
                assert.ok(err instanceof OneBotError);
                assert.notEqual(err.retcode, 0);
                return true;
            });
        } finally {
            client.close();
        }
    });
});

test('OneBot：发送失败会 reject（模拟假服务器的抛错动作）', async () => {
    await withServer({}, async (server) => {
        server.actions.send_group_msg = () => { throw new Error('群不存在'); };
        const client = new OneBotClient({ url: `ws://127.0.0.1:${server.port}` });
        client.connect();
        try {
            assert.ok(await waitConnected(client));
            await assert.rejects(() => client.sendText(999, 'hi', 'group'), /群不存在/);
        } finally {
            client.close();
        }
    });
});

test('OneBot：断线后自动重连（先停服再重启同端口）', async () => {
    const server = new FakeNapCatServer({ heartInterval: 60000 });
    await server.start();
    const port = server.port;
    const client = new OneBotClient({ url: `ws://127.0.0.1:${port}`, maxReconnectDelayMs: 200 });
    const statuses = [];
    client.onStatusChange = (s) => statuses.push(s.reason);
    client.connect();
    try {
        assert.ok(await waitConnected(client), '初次连接应成功');

        // 关服 -> 断开
        await server.stop();
        assert.ok(await waitFor(() => !client.isConnected, { timeoutMs: 4000 }), '停服后应断开');
        assert.ok(statuses.includes('disconnect'));

        // 同端口重启 -> 自动重连（退避上限 200ms）
        const server2 = new FakeNapCatServer({ port, heartInterval: 60000 });
        await server2.start();
        try {
            assert.ok(await waitConnected(client, 6000), 'NapCat 重启后应自动重连');
            assert.ok(statuses.includes('reconnecting'));
        } finally {
            await server2.stop();
        }
    } finally {
        client.close();
    }
});
