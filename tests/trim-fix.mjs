// v3 完整：从 v0.5.0 index.js 删除“首次接入弹窗”全部代码（保留其它函数）
import fs from 'node:fs';
const p = 'D:/project/TavernCat/index.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

// 1) 整段删除：段注释 -> bindAdvancedEvents 之前
const a = s.indexOf('// ---------------- 首次接入引导');
const b = s.indexOf('function bindAdvancedEvents', a);
if (a < 0 || b < 0) throw new Error(`段标记缺失 a=${a} b=${b}`);
s = s.slice(0, a) + s.slice(b);

// 2) init() 的 onBindingCreated 赋值块
const reOnBind = /    \/\/ 首次接入引导：某个 QQ 会话第一次自动创建绑定后，弹出“接着哪个已有聊天”的选择\n    bridge\.onBindingCreated = \(peerKey, binding\) => \{\n([\s\S]*?)\n    \};\n\n/;
if (!reOnBind.test(s)) throw new Error('onBindingCreated 块未找到');
s = s.replace(reOnBind, '');

// 3) HUB_KEYS 移除 getRequestHeaders
s = s.replace("    'getRequestHeaders',\n", '');

// 4) 残留兜底检查
for (const k of ['firstBindOverlay', 'showFirstBindDialog', 'fetchRecentChats', 'bindExistingChat', 'renderFirstBindList', 'closeFirstBindDialog']) {
    if (s.includes(k)) {
        const lineNo = s.slice(0, s.indexOf(k)).split('\n').length;
        throw new Error(`残留引用 ${k} at line ${lineNo}`);
    }
}
fs.writeFileSync(p, s, 'utf8');
console.log('clean ok, bytes:', s.length);
