// QQ 消息事件的归一化与“是否触发回复”判定（与 UI/酒馆无关的纯逻辑）
import { parseCqString, segmentsToPlainText } from './cqcode.js';

/**
 * 把一条 OneBot 消息事件归一化为桥接内部结构。
 * 非消息事件 / 机器人自己的消息 / 无法得到文本的碎片消息返回 null。
 * @param {object} ev OneBot 消息事件
 * @param {number|string} selfId 机器人自身 QQ
 * @returns {object|null} {
 *   scope:'group'|'private', peerId, peerKey, messageId, userId, senderName,
 *   text, segments, hasText, atSelf, atAll, replyId, raw
 * }
 */
export function normalizeMessageEvent(ev, selfId) {
    if (!ev || ev.post_type !== 'message') return null;
    if (ev.message_type !== 'group' && ev.message_type !== 'private') return null;

    const self = String(selfId ?? '');
    const userId = ev.user_id ?? 0;
    if (self && String(userId) === self) return null; // 自己的消息不回

    // 取段数组（messagePostFormat=array 默认）；string 格式则解析 raw_message 的 CQ 码
    let segments = ev.message;
    if (!Array.isArray(segments)) {
        segments = parseCqString(ev.raw_message ?? String(ev.message ?? ''));
    }

    const isGroup = ev.message_type === 'group';
    const sender = ev.sender ?? {};
    const senderName = String(sender.card || sender.nickname || userId || '未知').trim();

    const atSelf = segments.some((s) => s.type === 'at' && String(s.data?.qq) === self && self !== '');
    const atAll = segments.some((s) => s.type === 'at' && ['all', '0', '全体成员'].includes(String(s.data?.qq)));
    const replySeg = segments.find((s) => s.type === 'reply');
    const replyId = replySeg ? String(replySeg.data?.id ?? '') : '';

    // 纯文本：把对机器人本体的 @ 从正文里剥掉（消息里若带 @bot + 指令，能正确识别指令）
    let text = stripBotMentions(segmentsToPlainText(segments), self);
    // 至少有一个 text 段（有“话”可聊）或主动 @ 了机器人
    const hasRealText = segments.some((s) => s.type === 'text' && String(s.data?.text ?? '').trim().length > 0);

    const peerId = isGroup ? (ev.group_id ?? 0) : userId;

    return {
        scope: isGroup ? 'group' : 'private',
        peerId,
        peerKey: `${isGroup ? 'g' : 'p'}:${peerId}`,
        messageId: String(ev.message_id ?? ''),
        userId,
        senderName,
        text,
        segments,
        hasText: hasRealText,
        atSelf,
        atAll,
        replyId,
        raw: ev,
    };
}

/**
 * 从纯文本里剥掉 @机器人本体 / @全体 的提及（@ 其他成员的保留）。
 * @param {string} text
 * @param {string|number} selfId
 */
export function stripBotMentions(text, selfId) {
    const self = String(selfId ?? '');
    let out = String(text ?? '');
    if (self) {
        const escaped = self.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`@${escaped}`, 'g'), '');
    }
    out = out.replace(/@全体成员/g, '').replace(/@all/gi, '');
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * 群聊触发模式
 *   'at_reply' 默认：@机器人 / @全体 / 回复了机器人最近的消息 才触发
 *   'at_only'：只有 @ 机器人才触发
 *   'all'：群里每条可读文本都触发
 * @param {object} norm normalizeMessageEvent 的结果
 * @param {{groupMode:string, recentSentIds:Set<string>}} opts
 * @returns {{trigger:boolean, reason:string}}
 */
export function shouldTrigger(norm, opts) {
    const mode = opts.groupMode ?? 'at_reply';
    if (norm.scope === 'private') return { trigger: true, reason: 'private' };

    const replyToUs = norm.replyId !== '' && opts.recentSentIds?.has(norm.replyId);
    if (mode === 'all') {
        return norm.hasText || norm.atSelf || norm.atAll
            ? { trigger: true, reason: 'mode=all' }
            : { trigger: false, reason: 'no-text' };
    }
    if (mode === 'at_only') {
        return norm.atSelf || norm.atAll ? { trigger: true, reason: 'at' } : { trigger: false, reason: 'not-mentioned' };
    }
    // 默认 at_reply
    if (norm.atSelf || norm.atAll) return { trigger: true, reason: 'at' };
    if (replyToUs) return { trigger: true, reason: 'reply-to-us' };
    return { trigger: false, reason: 'not-mentioned' };
}
