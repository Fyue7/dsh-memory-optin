/**
 * dsh-memory-gate · store 自检
 *
 * 跑法：node test/store.test.mjs
 * 只测纯存取逻辑，不需要宿主，不碰真数据目录。
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore } from '../lib/store.js';

const dir = mkdtempSync(join(tmpdir(), 'dsmg-'));
const checks = [];
const check = (label, ok, extra = '') => checks.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);

// 1. 默认关
let store = createMemoryStore(dir);
check('默认不进记忆', store.isEnabled('s1') === false);

// 2. 打开 -> 落盘
check('打开返回 true', store.setEnabled('s1', true) === true);
check('打开后 isEnabled', store.isEnabled('s1') === true);
const afterOn = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
check('只留 enabled: true 的记录', afterOn.s1?.enabled === true && Object.keys(afterOn).length === 1, JSON.stringify(afterOn));

// 3. 关掉 -> 记录被删除（而不是留一条 false）
store.setEnabled('s1', false);
check('关掉后 isEnabled 归 false', store.isEnabled('s1') === false);
check('关掉后记录被删掉', readFileSync(join(dir, 'sessions.json'), 'utf8').trim() === '{}');

// 4. 旧版本写下的 enabled:false 垃圾记录在下次加载时自愈
writeFileSync(
	join(dir, 'sessions.json'),
	JSON.stringify({ junk: { enabled: false, updatedAt: 1 }, keep: { enabled: true, updatedAt: 2 } }),
	'utf8',
);
store = createMemoryStore(dir);
check('垃圾记录不载入', store.isEnabled('junk') === false);
check('有效记录仍载入', store.isEnabled('keep') === true);
check('enabledCount 只数开着的', store.enabledCount() === 1);

// 5. 记忆追加与读回
check('append 返回规整后的记录', store.append({ text: '  - 今天把记忆插件写完了 ', sessionId: 's1', at: 12345 })?.text === '- 今天把记忆插件写完了');
check('count', store.count() === 1);
check('recent(1) 拿到一条', store.recent(1).length === 1);
check('recent(0) 是空', store.recent(0).length === 0);
check('空文本不入库', store.append({ text: '   ' }) === null);
check('追加是 JSONL 一行一条', readFileSync(join(dir, 'memory.jsonl'), 'utf8').trim().split('\n').length === 1);

// 6. 损坏文件不炸
writeFileSync(join(dir, 'memory.jsonl'), 'not json\n{"text":"ok"}\n', 'utf8');
store = createMemoryStore(dir);
check('坏行只丢那一行', store.count() === 1 && store.recent(1)[0].text === 'ok');

rmSync(dir, { recursive: true, force: true });

console.log(checks.join('\n'));
const failed = checks.filter((line) => line.startsWith('FAIL'));
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
