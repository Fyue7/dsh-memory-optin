/**
 * dsh-memory-optin · 注入面自检
 *
 * 跑法：node --import ./test/stub-loader.mjs test/injection.test.mjs
 *
 * 目的：在**重启宿主之前**证明两件事 ——
 *   1. 插件能被加载，apply 不抛错；
 *   2. 记忆注册的是 `systemPrompt.context`（请求尾部），不是 `systemPrompt.section`（请求头部）。
 *
 * 第 2 条是这次修的核心：section 落在请求头部，写一条记忆就会把工具 schema 和整段
 * 对话历史一起作废（实测那一次请求命中率 0.4%）；context 挂在请求尾部，头部逐字不变。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsmo-inject-'));
process.env.DSMO_TEST_HOME = home;

const checks = [];
const check = (label, ok, extra = '') => checks.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);

/** 造一个只记录注册动作的假 ctx。 */
function makeCtx() {
	const record = { contexts: [], sections: [], events: [], injects: [], logs: [] };
	const ctx = {
		logger: { info: (line) => record.logs.push(line) },
		on: (name) => record.events.push(name),
		effect: () => {},
		get: () => undefined,
		// 桩件故意不调用回调：命令/路由不是本测试的目标，也不该在无宿主时执行
		inject: (deps) => record.injects.push(deps.join(',')),
		systemPrompt: {
			context: (entry) => record.contexts.push(entry),
			section: (entry) => record.sections.push(entry),
		},
	};
	return { ctx, record };
}

function seed(dir, entries) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'memory.jsonl'), entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
}

const storeDir = join(home, 'dsh-memory-optin');
seed(storeDir, [
	{ at: 1000, sessionId: 's-a', text: '- 用户喜欢中文注释' },
	{ at: 2000, sessionId: 's-b', text: '- 项目路径在 E:\\agent，模板写作 {{name}} 这种形式' },
	{ at: 3000, sessionId: 's-c', text: '- 第三条记忆' },
]);

const { apply } = await import('../lib/index.js');

/* --- 1. 注册面：必须是 context，不能是 section --- */
const { ctx, record } = makeCtx();
apply(ctx, {});

check('注册了 systemPrompt.context', record.contexts.length === 1, `contexts=${record.contexts.length}`);
check('没有注册 systemPrompt.section', record.sections.length === 0, `sections=${record.sections.length}`);

const entry = record.contexts[0];
check('段名保持 memory-optin/memory', entry?.name === 'memory-optin/memory', String(entry?.name));
check('order = 131', entry?.order === 131, String(entry?.order));
check('order 排在情绪状态(130)之后', entry?.order > 130, `131 > 130`);
check('text 是函数（每步现算）', typeof entry?.text === 'function');

/* --- 2. 渲染内容 --- */
const text = entry.text();
check('含记忆块标题', text.includes('## 长期记忆'));
check('含最近一条记忆', text.includes('第三条记忆'));
check('默认注入上限 6 条，这里只有 3 条', text.split('\n').filter((l) => l.startsWith('- ')).length === 3);

/* --- 3. {{…}} 必须消毒：否则宿主插值会抛错、会话直接不可用 --- */
check('不含裸的 {{', !text.includes('{{'), text.includes('{{') ? '找到 {{ 残留' : '');
check('不含裸的 }}', !text.includes('}}'));
check('原文的 {{name}} 被拆开保留', text.includes('{ {name} }'));

/* --- 4. injectLimit 生效 --- */
const limited = makeCtx();
apply(limited.ctx, { injectLimit: 1 });
const limitedText = limited.record.contexts[0].text();
check('injectLimit=1 只注入最后一条', limitedText.includes('第三条记忆') && !limitedText.includes('用户喜欢中文注释'));

/* --- 5. enabled: false 时彻底不注入 --- */
const off = makeCtx();
apply(off.ctx, { enabled: false });
check('enabled=false 渲染为空', off.record.contexts[0].text() === '');

/* --- 6. 空记忆库 --- */
const emptyHome = mkdtempSync(join(tmpdir(), 'dsmo-empty-'));
const prevHome = process.env.DSMO_TEST_HOME;
process.env.DSMO_TEST_HOME = emptyHome;
const emptyStore = await import('../lib/index.js');
const empty = makeCtx();
emptyStore.apply(empty.ctx, {});
check('空记忆库渲染为空（空段会被宿主丢弃）', empty.record.contexts[0].text() === '');
process.env.DSMO_TEST_HOME = prevHome;

/* --- 7. 其余注册面没被这次改动带崩 --- */
check('仍然监听 session/event（写侧记账）', record.events.includes('session/event'));
check('仍然监听 agent/turn-stopping（兜底触发）', record.events.includes('agent/turn-stopping'));
check('仍然监听 agent/request（记路由）', record.events.includes('agent/request'));
check('仍然注入 commands', record.injects.includes('commands'));
check('仍然注入 webServer', record.injects.includes('webServer'));

rmSync(home, { recursive: true, force: true });
rmSync(emptyHome, { recursive: true, force: true });

console.log(checks.join('\n'));
const failed = checks.filter((line) => line.startsWith('FAIL'));
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
