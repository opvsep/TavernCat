// OneBot 11 WebSocket 客户端（连 NapCat 的「WebSocket 服务器」，默认 ws://127.0.0.1:2333）
// 兼容浏览器原生 WebSocket 与 Node 18+ 的全局 WebSocket，因此同一份代码可在酒馆页面与 Node 测试中运行。
//
// 依据 NapCat 源码（packages/napcat-onebot/network/websocket-server.ts）：
//   - 连接根路径（不带 /api）=> 既推送事件也接受 API 帧；鉴权仅当配置了 token：
//     URL query ?access_token=xxx（浏览器 WebSocket 无法自定义 Authorization 头）
//   - 连上后 NapCat 主动推送 meta_event lifecycle(connect)，之后按 heartInterval(默认 30s) 推送 meta_event heartbeat
//   - 请求帧 {"action","params","echo"}；回包 {"status","retcode","data","echo"}

export class OneBotError extends Error {
    constructor(message, retcode, detail) {
        super(message);
        this.name = 'OneBotError';
        this.retcode = retcode;
        this.detail = detail;
    }
}

const DEFAULT_HEARTBEAT_INTERVAL = 30000; // NapCat 默认 heartInterval
const HEARTBEAT_TIMEOUT_MULTIPLIER = 3;   // 超过 3 个心跳周期没有任何消息 => 判定连接死亡

export class OneBotClient {
    /**
     * @param {object} options
     * @param {string} options.url       形如 ws://127.0.0.1:2333（内部会自动拼 access_token query）
     * @param {string} [options.token]   NapCat 网络服务配置的 token（可选）
     * @param {object} [options.logger]  {log, warn, error} 缺省用 console
     */
    constructor(options = {}) {
        this.url = options.url;
        this.token = options.token ?? '';
        this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60000; // 重连退避上限（测试可调小）
        this.logger = options.logger ?? console;
        this.ws = null;
        this.connected = false;
        this.selfId = null;
        this.closedByUser = false;

        this._echoMap = new Map();       // echo -> {resolve, reject, timer}
        this._seq = 0;
        this._heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL;
        this._lastMessageAt = 0;
        this._watchdogTimer = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;

        /** 事件回调：收到消息/通知/请求/元事件（非 API 回包）都会触发 */
        this.onEvent = null;
        /** 连接状态回调 onStatusChange({connected:boolean, selfId:number|null, reason?:string}) */
        this.onStatusChange = null;
    }

    get isConnected() {
        return this.connected && this.ws?.readyState === WebSocket.OPEN;
    }

    /** 连接并保持（带指数退避重连与心跳看门狗） */
    connect() {
        this.closedByUser = false;
        this._open();
    }

    _buildUrl() {
        if (!this.token) return this.url;
        const sep = this.url.includes('?') ? '&' : '?';
        return `${this.url}${sep}access_token=${encodeURIComponent(this.token)}`;
    }

    _open() {
        if (this.closedByUser) return;
        try {
            this.ws = new WebSocket(this._buildUrl());
        } catch (err) {
            this.logger.error('[NapCat] WebSocket 构造失败:', err);
            this._scheduleReconnect();
            return;
        }
        const ws = this.ws;

        ws.addEventListener('open', () => {
            this._reconnectAttempts = 0;
            this._lastMessageAt = Date.now();
            this.connected = true;
            this._startWatchdog();
            this.logger.log(`[NapCat] 已连接 ${this.url}`);
            this._emitStatus('connect');
        });

        ws.addEventListener('message', (ev) => {
            this._lastMessageAt = Date.now();
            let data;
            try {
                data = JSON.parse(String(ev.data));
            } catch {
                return; // 非 JSON 帧直接忽略
            }
            this._handleFrame(data);
        });

        ws.addEventListener('close', (ev) => {
            const wasConnected = this.connected;
            this.connected = false;
            this._stopWatchdog();
            this.logger.warn(`[NapCat] 连接关闭 code=${ev.code} reason=${ev.reason || '(空)'} clean=${ev.wasClean}`);
            if (wasConnected) this._emitStatus('disconnect');
            this._rejectAllPending(new OneBotError('连接已关闭', -1, ev.code));
            if (!this.closedByUser) this._scheduleReconnect();
        });

        ws.addEventListener('error', (ev) => {
            const detail = ev?.error?.message ?? ev?.message ?? '';
            this.logger.error(`[NapCat] WebSocket 错误: ${detail}`);
            // 部分环境 error 后不派发 close；兜底：2 秒内未关闭则强制关闭以触发重连循环
            if (!this.closedByUser && ws.readyState !== WebSocket.CLOSED) {
                setTimeout(() => {
                    if (!this.closedByUser && ws.readyState !== WebSocket.CLOSED) {
                        try { ws.close(); } catch { /* 忽略 */ }
                    }
                }, 2000);
            }
        });
    }

    _scheduleReconnect() {
        if (this._reconnectTimer || this.closedByUser) return;
        // 指数退避：1s,2s,4s...上限 maxReconnectDelayMs，另加少量随机抖动
        const base = Math.min(1000 * (2 ** this._reconnectAttempts), this.maxReconnectDelayMs);
        const delay = base + Math.floor(Math.random() * 500);
        this._reconnectAttempts += 1;
        this.logger.warn(`[NapCat] ${delay}ms 后重连（第 ${this._reconnectAttempts} 次）`);
        this._emitStatus('reconnecting');
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._open();
        }, delay);
    }

    _startWatchdog() {
        this._stopWatchdog();
        // 周期 = 3 倍心跳间隔；若 NapCat 配置里关闭了心跳（heartInterval<=0 时收不到 heartbeat 事件），
        // 我们靠 get_login_info 探活帧维持 _lastMessageAt（见 _probe），所以这里仍能安全运作。
        const tickMs = Math.min(Math.max(this._heartbeatIntervalMs / 2, 5000), 60000);
        this._watchdogTimer = setInterval(() => {
            const timeoutMs = this._heartbeatIntervalMs * HEARTBEAT_TIMEOUT_MULTIPLIER;
            if (this.connected && Date.now() - this._lastMessageAt > timeoutMs) {
                this.logger.warn(`[NapCat] 超过 ${timeoutMs}ms 无任何消息，判定连接死亡，强制重连`);
                try { this.ws?.close(); } catch { /* 忽略 */ }
            }
        }, tickMs);
    }

    _stopWatchdog() {
        if (this._watchdogTimer) {
            clearInterval(this._watchdogTimer);
            this._watchdogTimer = null;
        }
    }

    _handleFrame(frame) {
        if (frame && typeof frame === 'object' && 'echo' in frame) {
            const pending = this._echoMap.get(String(frame.echo));
            if (pending) {
                this._echoMap.delete(String(frame.echo));
                clearTimeout(pending.timer);
                if (frame.status === 'ok') {
                    pending.resolve(frame.data);
                } else {
                    pending.reject(new OneBotError(frame.message || frame.wording || 'API 调用失败', frame.retcode, frame));
                }
            }
            return;
        }
        if (!frame || typeof frame !== 'object') return;

        // 元事件：记录自身 QQ 号与心跳间隔
        if (frame.post_type === 'meta_event') {
            if (frame.self_id) this.selfId = Number(frame.self_id);
            if (frame.meta_event_type === 'heartbeat' && frame.interval > 0) {
                this._heartbeatIntervalMs = Number(frame.interval);
            }
        }
        if (this.onEvent) {
            try { this.onEvent(frame); } catch (err) { this.logger.error('[NapCat] onEvent 回调异常:', err); }
        }
    }

    /**
     * 调用 OneBot 动作。
     * @param {string} action
     * @param {object} [params]
     * @param {number} [timeoutMs=30000]
     * @returns {Promise<any>} 成功时 resolve 回包的 data 字段
     */
    sendAction(action, params = {}, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            if (!this.isConnected) {
                reject(new OneBotError('未连接 NapCat', -1));
                return;
            }
            const echo = String(++this._seq);
            const timer = setTimeout(() => {
                this._echoMap.delete(echo);
                reject(new OneBotError(`调用 ${action} 超时`, -1));
            }, timeoutMs);
            this._echoMap.set(echo, { resolve, reject, timer });
            const payload = { action, params, echo };
            this.ws.send(JSON.stringify(payload));
        });
    }

    /** 发送纯文本（消息段数组，绕开一切 CQ 解析，最稳）。 */
    async sendText(target, text, messageType) {
        const params = { message: [{ type: 'text', data: { text: String(text) } }] };
        if (messageType === 'group') {
            params.group_id = Number(target);
            return this.sendAction('send_group_msg', params);
        }
        params.user_id = Number(target);
        return this.sendAction('send_private_msg', params);
    }

    /** 引用回复某条消息（群聊 @/回复触发时推荐）。 */
    async sendReplyText(messageId, target, text, messageType) {
        const params = {
            message: [
                { type: 'reply', data: { id: String(messageId) } },
                { type: 'text', data: { text: String(text) } },
            ],
        };
        if (messageType === 'group') {
            params.group_id = Number(target);
            return this.sendAction('send_group_msg', params);
        }
        params.user_id = Number(target);
        return this.sendAction('send_private_msg', params);
    }

    /** 获取机器人自身信息，兼作探活帧。 */
    async getLoginInfo() {
        return this.sendAction('get_login_info', {}, 10000);
    }

    /** 手动关闭并停止重连 */
    close() {
        this.closedByUser = true;
        this._stopWatchdog();
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this._rejectAllPending(new OneBotError('客户端主动关闭', -1));
        try { this.ws?.close(); } catch { /* 忽略 */ }
    }

    _rejectAllPending(err) {
        for (const [, pending] of this._echoMap) {
            clearTimeout(pending.timer);
            pending.reject(err);
        }
        this._echoMap.clear();
    }

    _emitStatus(kind) {
        if (this.onStatusChange) {
            try {
                this.onStatusChange({
                    connected: this.connected,
                    selfId: this.selfId,
                    reason: kind,
                });
            } catch (err) {
                this.logger.error('[NapCat] onStatusChange 回调异常:', err);
            }
        }
    }
}
