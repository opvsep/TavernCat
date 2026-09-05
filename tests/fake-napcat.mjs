// 最小 OneBot 11 WebSocket 假服务器：模拟 NapCat 的「WebSocket 服务器」行为
// 仅用于本地测试（npm: ws）。
// 行为对齐 NapCat 源码结论：
//   - 连上后推送 meta_event lifecycle(connect)，之后按 heartInterval 推送 heartbeat
//   - 接收 {"action","params","echo"} 帧并回 {"status","retcode","data","echo"}
import { WebSocketServer } from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN = 1; // ws 实例不暴露静态常量，统一用数值判断

export class FakeNapCatServer {
    /** @param {{port?:number, token?:string, heartInterval?:number, selfId?:number, logger?:object|false}} [options] */
    constructor(options = {}) {
        this.token = options.token ?? '';
        this.heartInterval = options.heartInterval ?? 30000;
        this.selfId = options.selfId ?? 10001;
        this.port = options.port ?? 0; // 0 = 随机可用端口（启动后可从 server.port 读取实际值）
        this.clients = new Set();
        this.sent = [];           // 记录发送动作: {action, params, echo}
        this.nextMessageId = 1;
        this.started = false;
        this.logger = options.logger === false ? null : (options.logger ?? console);
        this._log = (...a) => { this.logger?.log?.('[FakeNapCat]', ...a); };

        this.actions = {
            send_group_msg: (params) => this._record('send_group_msg', params, { message_id: this.nextMessageId++ }),
            send_private_msg: (params) => this._record('send_private_msg', params, { message_id: this.nextMessageId++ }),
            send_msg: (params) => this._record('send_msg', params, { message_id: this.nextMessageId++ }),
            get_login_info: () => ({ user_id: this.selfId, nickname: '测试机器人' }),
            get_group_member_info: () => ({ user_id: 1, nickname: '测试昵称', card: '测试名片', role: 'member' }),
            delete_msg: () => ({}),
        };
    }

    _record(action, params, data) {
        this.sent.push({ action, params: JSON.parse(JSON.stringify(params)) });
        return data;
    }

    /** 启动监听。resolve 时拿到实际端口。 */
    async start() {
        if (this.started) return this.port;
        this.started = true;
        this.wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' });
        this.wss.on('error', (err) => this._log('wss error:', err?.message ?? err));
        await new Promise((resolve) => this.wss.once('listening', resolve));
        this.port = this.wss.address().port;
        this._log(`listening on ws://127.0.0.1:${this.port}`);

        this.wss.on('connection', (ws, req) => {
            this._log('client connected, path=', req.url);
            if (this.token) {
                const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
                const auth = query.get('access_token');
                if (auth !== this.token) {
                    this._log('rejecting client: bad token');
                    try { ws.send(JSON.stringify({ status: 'failed', retcode: 1403, message: 'authorization failed', data: null, echo: '' })); } catch { /* 忽略 */ }
                    ws.close(4001, 'authorization failed');
                    return;
                }
            }
            this.clients.add(ws);
            ws.on('message', (buf) => this._onFrame(ws, String(buf)));
            ws.on('close', (code, reason) => {
                this.clients.delete(ws);
                this._log(`client closed code=${code} reason=${reason?.toString?.() ?? ''}`);
            });
            ws.on('error', (err) => {
                this.clients.delete(ws);
                this._log('client socket error:', err?.message ?? err);
            });

            // lifecycle(connect)：10ms 后推送
            setTimeout(() => {
                try {
                    if (ws.readyState === OPEN) {
                        ws.send(JSON.stringify({
                            post_type: 'meta_event', meta_event_type: 'lifecycle',
                            sub_type: 'connect', self_id: this.selfId, time: Math.floor(Date.now() / 1000),
                        }));
                        this._log('lifecycle sent');
                    } else {
                        this._log(`skip lifecycle, readyState=${ws.readyState}`);
                    }
                } catch (err) {
                    this._log('lifecycle send error:', err?.message ?? err);
                }
            }, 10);
        });

        // 心跳广播
        this.heartTimer = setInterval(() => this.broadcast({
            post_type: 'meta_event', meta_event_type: 'heartbeat',
            status: { online: true, good: true }, interval: this.heartInterval,
            self_id: this.selfId, time: Math.floor(Date.now() / 1000),
        }), this.heartInterval);
        this.heartTimer.unref?.();
        return this.port;
    }

    _onFrame(ws, text) {
        let frame;
        try { frame = JSON.parse(text); } catch { return; }
        if (!frame || typeof frame !== 'object' || !frame.action) return;
        const handler = this.actions[frame.action];
        let result;
        if (!handler) {
            result = { status: 'failed', retcode: 1404, message: `不支持的动作 ${frame.action}`, data: null };
        } else {
            try {
                result = { status: 'ok', retcode: 0, data: handler(frame.params ?? {}), message: '' };
            } catch (err) {
                result = { status: 'failed', retcode: 1200, message: String(err?.message ?? err), data: null };
            }
        }
        result.echo = frame.echo ?? '';
        this._log(`action ${frame.action} -> ${result.status}`);
        if (ws.readyState === OPEN) ws.send(JSON.stringify(result));
    }

    /** 向所有客户端广播一个事件（模拟一条到达的 QQ 消息等）。 */
    broadcast(event) {
        const text = JSON.stringify(event);
        for (const ws of this.clients) {
            if (ws.readyState === OPEN) ws.send(text);
        }
    }

    /** 便捷：推送一条群消息事件 */
    pushGroupMessage({ groupId = 123456789, userId = 2222, nickname = '路人甲', card = '', segments, raw = '', messageId } = {}) {
        const ev = {
            post_type: 'message', message_type: 'group', sub_type: 'normal',
            message_id: messageId ?? this.nextMessageId++,
            group_id: groupId, user_id: userId,
            sender: { user_id: userId, nickname, card, role: 'member' },
            message: segments ?? [{ type: 'text', data: { text: '你好' } }],
            raw_message: raw || '',
            message_format: 'array', self_id: this.selfId, time: Math.floor(Date.now() / 1000),
        };
        this.broadcast(ev);
        return ev;
    }

    /** 便捷：推送一条私聊消息事件 */
    pushPrivateMessage({ userId = 2222, nickname = '路人甲', segments, raw = '', messageId } = {}) {
        const ev = {
            post_type: 'message', message_type: 'private', sub_type: 'friend',
            message_id: messageId ?? this.nextMessageId++,
            user_id: userId,
            sender: { user_id: userId, nickname, card: '' },
            message: segments ?? [{ type: 'text', data: { text: '你好' } }],
            raw_message: raw || '',
            message_format: 'array', self_id: this.selfId, time: Math.floor(Date.now() / 1000),
        };
        this.broadcast(ev);
        return ev;
    }

    async stop() {
        this._log('stopping...');
        clearInterval(this.heartTimer);
        for (const ws of [...this.clients]) {
            try { ws.terminate(); } catch { /* 忽略 */ }
        }
        this.clients.clear();
        if (this.wss) {
            const wss = this.wss;
            await new Promise((resolve) => {
                const timer = setTimeout(() => { this._log('wss close timeout, forcing'); resolve(); }, 2000);
                wss.close(() => { clearTimeout(timer); resolve(); });
            });
        }
        this.started = false;
        this._log('stopped');
    }
}

export { sleep };
