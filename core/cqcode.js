// NapCat / OneBot 11 CQ 码与消息段工具
// 转义规则依据 NapCatQQ packages/napcat-onebot/helper/cqcode.ts：
//   文本中: & -> &amp;   [ -> &#91;   ] -> &#93;
//   CQ 参数值中额外: , -> &#44;
//   解码顺序: &#91; -> [ , &#93; -> ] , &#44; -> , , &amp; -> &

/** 把普通文本编码为可在 CQ 码参数/文本区安全出现的形态（& [ ] 转义）。 */
export function escapeCqText(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('[', '&#91;')
        .replaceAll(']', '&#93;');
}

/** 解码 CQ 实体。注意 &amp; 必须最后解，避免二次错解。 */
export function unescapeCqText(text) {
    return String(text)
        .replaceAll('&#91;', '[')
        .replaceAll('&#93;', ']')
        .replaceAll('&#44;', ',')
        .replaceAll('&amp;', '&');
}

const CQ_TAG = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\[\]]*)*)\]/g;
const CQ_PARAM = /,([a-zA-Z0-9_]+)=([^,]*)/g;

/**
 * 把 NapCat 的 raw_message（CQ 码字符串）解析为 OneBot 段数组。
 * @param {string} raw
 * @returns {Array<{type:string, data:Record<string,string>}>}
 */
export function parseCqString(raw) {
    const segments = [];
    let lastIndex = 0;
    CQ_TAG.lastIndex = 0;
    let m;
    while ((m = CQ_TAG.exec(String(raw ?? ''))) !== null) {
        const textPart = String(raw).slice(lastIndex, m.index);
        if (textPart) {
            segments.push({ type: 'text', data: { text: unescapeCqText(textPart) } });
        }
        const type = m[1];
        const data = {};
        const params = m[2] ?? '';
        CQ_PARAM.lastIndex = 0;
        let pm;
        while ((pm = CQ_PARAM.exec(params)) !== null) {
            data[pm[1]] = unescapeCqText(pm[2]);
        }
        segments.push({ type, data });
        lastIndex = m.index + m[0].length;
    }
    const tail = String(raw ?? '').slice(lastIndex);
    if (tail) {
        segments.push({ type: 'text', data: { text: unescapeCqText(tail) } });
    }
    return segments;
}

/**
 * 把消息段数组渲染成纯文本（用于展示/注入酒馆/本地去重）。
 * 规则：
 *   text   -> 原文
 *   at     -> @QQ号 或 @全体成员（qq 可能为 string 'all' 或数字）
 *   reply  -> 忽略（内容会另作处理）
 *   image/record/video/file -> [图片]/[语音]/[视频]/[文件] 占位
 *   face/mface -> [表情] 占位
 *   其余    -> [类型名] 占位
 * @param {Array<{type:string,data:Record<string,any>}>} segments
 * @returns {string}
 */
export function segmentsToPlainText(segments) {
    if (Array.isArray(segments) && segments.length === 1 && segments[0].type === 'text') {
        return String(segments[0].data.text ?? '');
    }
    const parts = [];
    for (const seg of segments || []) {
        const data = seg.data ?? {};
        switch (seg.type) {
            case 'text':
                parts.push(String(data.text ?? ''));
                break;
            case 'at': {
                const qq = String(data.qq ?? '');
                parts.push(qq === 'all' || qq === '0' ? '@全体成员' : `@${qq}`);
                break;
            }
            case 'reply':
                break; // 引用内容不进入对话正文
            case 'image':
                parts.push('[图片]');
                break;
            case 'record':
                parts.push('[语音]');
                break;
            case 'video':
                parts.push('[视频]');
                break;
            case 'file':
                parts.push('[文件]');
                break;
            case 'face':
            case 'mface':
            case 'marketface':
                parts.push('[表情]');
                break;
            case 'poke':
                parts.push('[戳一戳]');
                break;
            case 'dice':
                parts.push('[骰子]');
                break;
            default:
                parts.push(`[${seg.type}]`);
                break;
        }
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * 构建发送用的纯文本段数组（不经任何 CQ 解析，最稳）。
 * @param {string} text
 * @returns {Array<{type:'text', data:{text:string}}>}
 */
export function textSegments(text) {
    return [{ type: 'text', data: { text: String(text) } }];
}

/** 构造“引用回复某条消息”的段数组（type=reply 段 + 文本段）。 */
export function replySegments(messageId, text) {
    return [
        { type: 'reply', data: { id: String(messageId) } },
        { type: 'text', data: { text: String(text) } },
    ];
}
