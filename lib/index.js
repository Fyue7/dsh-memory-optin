/**
 * dsh-memory-optin · Host 半
 *
 * 一句话：**读永远开，写要你点头。**
 *
 * 四个注册面：
 *   1. `ctx.systemPrompt.section` —— 把全局记忆注入每一轮（读侧，默认常开）
 *   2. `ctx.on('session/event')` —— 只给「开关打开过」的会话记账（写侧，默认关）
 *   3. `ctx.inject(['webServer'])` —— 给客户端开关用的两个 POST 路由
 *   4. `ctx.inject(['commands'])`  —— `/memory` 命令族，手感兜底
 *
 * 设计取舍：
 *   - 开关状态由本插件自己持有（按 sessionId 落盘），**不用会话投影**。
 *     投影没有写入 API，且 apply 必须同步纯函数，装不下一次鼠标点击。
 *   - 摘要走 `ctx.llm.stream`，但**不阻塞回合收尾**：`agent/turn-stopping`
 *     一发即忘，用户不会为记忆多等几秒。
 */

import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

import { createMemoryStore } from './store.js';

const name = 'memory-optin';
const inject = ['systemPrompt'];

/** 注入段的名字与排序位。放在工具/行为规则之前，让模型先读记忆再动手。 */
const SECTION = 'memory-optin/memory';
const SECTION_ORDER = 30;

/** 客户端开关用的路由前缀。 */
const ROUTE_PREFIX = '/memory-optin/api';

/** 单条记忆的字符上限，防止一条垃圾把整段撑爆。 */
const MAX_ENTRY_CHARS = 600;

/** 缓存里最多留几轮对话，避免长会话把内存吃光。 */
const MAX_BUFFER_LINES = 60;

const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	/** 注入几条最近的记忆；0 = 不注入。 */
	injectLimit: z.number().default(6).volatile(),
	/** 注入段的总字符上限。 */
	injectMaxChars: z.number().default(1200).volatile(),
	/** 摘要在哪里做：`turn` = 每轮收尾一次，`off` = 只记不摘。 */
	summarize: z.union([z.const('turn'), z.const('off')]).default('turn').volatile(),
	/** 单次摘要的输入字符上限。 */
	summarizeMaxInputChars: z.number().default(8000).volatile(),
});

/* ------------------------------------------------------------------ 小工具 */

/** 宿主 Config 字段可能是引用也可能是值，两种都容忍（照 dsh-emotion）。 */
function readConfig(config, key, fallback) {
	const raw = config?.[key];
	if (raw === undefined || raw === null) return fallback;
	if (typeof raw === 'object') {
		if (typeof raw.get === 'function') {
			try {
				const value = raw.get();
				return value === undefined || value === null ? fallback : value;
			} catch {
				return fallback;
			}
		}
		if ('value' in raw) return raw.value ?? fallback;
	}
	return raw;
}

/** 只取文本块：推理块和工具调用不进记忆。 */
function textOf(blocks) {
	if (typeof blocks === 'string') return blocks.trim();
	if (!Array.isArray(blocks)) return '';
	const parts = [];
	for (const block of blocks) {
		if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
	}
	return parts.join('\n').trim();
}

function clampText(text, max) {
	const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function writeJson(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(payload));
}

/** 读一个小的 JSON 请求体。超过 1MB 直接拒绝，防止有人拿它当上传口。 */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1024 * 1024) throw new Error('body too large');
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	if (raw === '') return {};
	return JSON.parse(raw);
}

const SUMMARY_SYSTEM = [
	'你是一个记忆整理器。把用户给你的这一段对话，压缩成值得长期记住的内容。',
	'只保留：做成了什么事、定下了什么决定、用户的偏好与习惯、还在进行中的任务。',
	'不要客套、不要评价、不要复述过程。用中文，最多三条，每条一行，以「- 」开头。',
	'如果这一段里没有任何值得长期记住的内容，只输出一个词：无。',
].join('\n');

/* ------------------------------------------------------------------ 插件本体 */

function apply(ctx, config) {
	const home = memoryHome();
	const store = createMemoryStore(home ?? '.');

	/** sessionId -> 本轮攒下的对话行。 */
	const buffers = new Map();
	/** sessionId -> 最近一次真实请求用的 provider/model，摘要走同一条路。 */
	const routes = new Map();

	/**
	 * 诊断计数。存在的理由：这些字段是"链路走到哪一步"的唯一证据，
	 * 一旦捕获或摘要静默失败，光看文件是看不出断在哪里的。
	 */
	const diagnostics = {
		events: 0,
		userMessages: 0,
		assistantMessages: 0,
		turnStopping: 0,
		summarizeAttempts: 0,
		summarizeFailures: 0,
		lastSummaryAt: 0,
		lastError: '',
	};
	/** 见过的会话 id（诊断用：用来比对"开着的 id"和"真实的 id"）。 */
	const seenSessionIds = new Set();

	const conf = (key, fallback) => readConfig(config, key, fallback);

	function log(stage, data) {
		try {
			ctx.logger?.info?.(`[memory-optin] ${stage} ${data === undefined ? '' : JSON.stringify(data)}`);
		} catch {
			// 日志失败不值得影响功能
		}
	}

	function push(sessionId, line) {
		let buffer = buffers.get(sessionId);
		if (!buffer) {
			buffer = [];
			buffers.set(sessionId, buffer);
		}
		buffer.push(line);
		if (buffer.length > MAX_BUFFER_LINES) buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
	}

	/* --- 1. 读侧：全局记忆注入每一轮 --- */

	/**
	 * 摘要本身已经是「每行以 - 开头」的形状，这里只补齐缺的，不再套一层，
	 * 否则注入出去会变成 `- - …`。
	 */
	function bulletize(text) {
		return String(text)
			.split('\n')
			.map((part) => part.trim())
			.filter((line) => line !== '')
			.map((line) => (line.startsWith('-') ? line : `- ${line}`))
			.join('\n');
	}

	function renderMemory() {
		if (!conf('enabled', true)) return '';
		const limit = Math.max(0, Math.floor(Number(conf('injectLimit', 6)) || 0));
		if (limit === 0) return '';
		const recent = store.recent(limit);
		if (recent.length === 0) return '';
		const maxChars = Math.max(200, Math.floor(Number(conf('injectMaxChars', 1200)) || 1200));
		const lines = [];
		let used = 0;
		for (const entry of recent) {
			const line = bulletize(clampText(entry.text, MAX_ENTRY_CHARS));
			if (used + line.length + 1 > maxChars) break;
			lines.push(line);
			used += line.length + 1;
		}
		if (lines.length === 0) return '';
		return [
			'## 长期记忆',
			'以下内容来自此前被你判断为值得长期记住的对话。按需参考，不要主动复述。',
			...lines,
		].join('\n');
	}

	ctx.systemPrompt.section({
		name: SECTION,
		order: SECTION_ORDER,
		text: () => renderMemory(),
	});

	/* --- 2. 写侧：只给开过开关的会话记账 --- */

	ctx.on('session/event', (session, event) => {
		const sessionId = session?.id;
		if (!sessionId) return;
		diagnostics.events++;
		seenSessionIds.add(String(sessionId));
		if (!store.isEnabled(sessionId)) return;

		if (event?.type === 'user/message') {
			// source.kind === 'user' 才是人打的；注入的上下文（AGENTS.md 之类）不算。
			if (event.data?.source?.kind !== 'user') return;
			const text = textOf(event.data?.content);
			if (text) {
				push(sessionId, `用户：${clampText(text, 4000)}`);
				diagnostics.userMessages++;
			}
			return;
		}

		if (event?.type === 'assistant/message') {
			const text = textOf(event.data?.message?.content);
			if (text) {
				push(sessionId, `助手：${clampText(text, 4000)}`);
				diagnostics.assistantMessages++;
			}
			return;
		}

		// 主触发挂在 `session/event` 上，因为它是本插件里**唯一有硬证据**的通道
		// （openviking 靠它攒了几千条待写）；`agent/turn-stopping` 只当兜底，
		// 两个都会调 flushTurn，第二次进来时缓冲已经空了，天然幂等。
		if (event?.type === 'turn/end') flushTurn(sessionId);
	});

	/* --- 记住本会话真实用过的 provider/model，摘要复用同一条路 --- */

	ctx.on('agent/request', async ({ agent }, next) => {
		const call = await next();
		const sessionId = agent?.session?.id;
		if (sessionId && call?.provider && call?.model) {
			routes.set(sessionId, { provider: call.provider, model: call.model });
		}
		return call;
	});

	function routeFor(sessionId) {
		const seen = sessionId ? routes.get(sessionId) : undefined;
		if (seen?.provider && seen?.model) return seen;
		try {
			const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
			const provider = selection?.provider ?? selection?.providerId;
			const model = selection?.model ?? selection?.modelId;
			if (provider && model) return { provider, model };
		} catch {
			// 拿不到默认模型就放弃这次摘要，不影响别的
		}
		return undefined;
	}

	async function summarize(sessionId, transcript) {
		// llm 不是本插件的硬依赖：拿不到就跳过摘要，别把回合收尾带崩
		let llm;
		try {
			llm = ctx.get('llm');
		} catch (error) {
			diagnostics.summarizeFailures++;
			diagnostics.lastError = `llm unreachable: ${String(error?.message ?? error)}`;
			return '';
		}
		if (!llm || typeof llm.stream !== 'function') {
			diagnostics.summarizeFailures++;
			diagnostics.lastError = 'llm service missing or has no stream()';
			return '';
		}
		const route = routeFor(sessionId);
		if (!route) {
			diagnostics.summarizeFailures++;
			diagnostics.lastError = 'no provider/model route for this session';
			return '';
		}
		let text = '';
		try {
			const stream = llm.stream({
				provider: route.provider,
				model: route.model,
				system: SUMMARY_SYSTEM,
				messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
				maxTokens: 300,
			});
			for await (const chunk of stream) {
				if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
					text += chunk.text;
					continue;
				}
				if (chunk?.type === 'finish') {
					const kind = chunk.reason?.kind;
					if (kind === 'error' || kind === 'aborted') return '';
				}
			}
		} catch (error) {
			log('summarize-failed', { error: String(error?.message ?? error) });
			diagnostics.summarizeFailures++;
			diagnostics.lastError = String(error?.message ?? error);
			return '';
		}
		const clean = text.trim();
		if (clean === '' || clean === '无') return '';
		// 模型偶尔会包一层代码块或多余前后缀，剥掉
		return clean.replace(/^```[a-z]*\n?|```$/g, '').trim();
	}

	/**
	 * 收尾一个回合：把攒下的对话交出去做摘要。
	 *
	 * 故意**不 await** —— 触发点在串行事件上，等一次模型调用会把每一轮都拖慢
	 * 好几秒。这里一发即忘，失败了只记日志。缓冲取走即删，所以重复触发幂等。
	 */
	function flushTurn(sessionId) {
		const lines = buffers.get(sessionId);
		if (!lines || lines.length === 0) return;
		buffers.delete(sessionId);
		if (!store.isEnabled(sessionId)) return;
		if (conf('summarize', 'turn') === 'off') return;

		const maxInput = Math.max(500, Math.floor(Number(conf('summarizeMaxInputChars', 8000)) || 8000));
		const transcript = lines.join('\n').slice(-maxInput);
		diagnostics.summarizeAttempts++;

		void (async () => {
			const summary = await summarize(sessionId, transcript);
			if (!summary) return;
			store.append({ text: summary, sessionId, at: Date.now() });
			diagnostics.lastSummaryAt = Date.now();
			log('remembered', { sessionId, chars: summary.length });
		})();
	}

	/** 兜底触发：主通道是 `session/event` 的 `turn/end`。 */
	ctx.on('agent/turn-stopping', ({ agent }) => {
		diagnostics.turnStopping++;
		const sessionId = agent?.session?.id;
		if (sessionId) flushTurn(sessionId);
	});

	ctx.on('session/disposed', (session) => {
		if (session?.id) buffers.delete(session.id);
	});

	/* --- 3. 客户端开关的 HTTP 路由 --- */

	ctx.inject(['webServer'], (webCtx) => {
		const handler = async (req, res) => {
			try {
				if (req.method !== 'POST') {
					writeJson(res, 405, { ok: false, error: 'method not allowed' });
					return;
				}
				const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
				const action = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : '';
				const body = await readJsonBody(req);
				const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';

				if (action === 'state') {
					if (!sessionId) {
						writeJson(res, 400, { ok: false, error: 'sessionId required' });
						return;
					}
					writeJson(res, 200, { ok: true, value: viewOf(sessionId) });
					return;
				}

				if (action === 'set') {
					if (!sessionId) {
						writeJson(res, 400, { ok: false, error: 'sessionId required' });
						return;
					}
					const enabled = store.setEnabled(sessionId, body.enabled === true);
					if (!enabled) buffers.delete(sessionId);
					log('toggled', { sessionId, enabled });
					writeJson(res, 200, { ok: true, value: viewOf(sessionId) });
					return;
				}

				if (action === 'debug') {
					// 诊断口：链路断在哪一步，看这里。
					// `build` 同时是"宿主有没有重新加载过模块"的探针。
					writeJson(res, 200, {
						ok: true,
						value: {
							build: 'diag-1',
							enabledIds: store.enabledIds(),
							seenSessionIds: [...seenSessionIds].slice(-10),
							buffers: [...buffers.entries()].map(([id, lines]) => ({ id, lines: lines.length })),
							routes: [...routes.entries()].map(([id, route]) => ({ id, ...route })),
							diagnostics,
							entries: store.count(),
							dir: store.dir,
						},
					});
					return;
				}

				writeJson(res, 404, { ok: false, error: `unknown action "${action}"` });
			} catch (error) {
				writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
			}
		};

		ctx.effect(
			() => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
			'dsh-memory-optin: /memory-optin/api routes',
		);
	});

	function viewOf(sessionId) {
		return {
			enabled: store.isEnabled(sessionId),
			entries: store.count(),
			file: store.memoryFile,
		};
	}

	/* --- 4. `/memory` 命令族 --- */

	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.commands.register({
			name: 'memory',
			description: '本对话的全局记忆开关与查看（on|off|status|list）',
			input: { hint: '[on|off|status|list]' },
			handler: (invocation) => handleMemory(invocation),
		});
	});

	function handleMemory(invocation) {
		if (!conf('enabled', true)) {
			return { kind: 'error', text: '记忆插件已在配置里关闭。' };
		}
		const sessionId = invocation?.agent?.session?.id ?? '';
		const arg = String(invocation?.rawInput ?? '').trim().toLowerCase();

		if (arg === 'on' || arg === 'off') {
			if (!sessionId) return { kind: 'error', text: '拿不到会话 id，无法切换。' };
			const enabled = store.setEnabled(sessionId, arg === 'on');
			if (!enabled) buffers.delete(sessionId);
			return {
				kind: 'success',
				text: enabled
					? '这个对话已接入全局记忆：从这一轮开始，值得长期记住的内容会被写进去。'
					: '这个对话已脱离全局记忆：已经写进去的不会被删，之后的不会再记。',
			};
		}

		if (arg === 'list') {
			const recent = store.recent(10);
			if (recent.length === 0) return { kind: 'success', text: '全局记忆还是空的。' };
			return {
				kind: 'success',
				text: recent
					.map((entry) => `- ${new Date(entry.at).toLocaleString()}｜${clampText(entry.text, 200)}`)
					.join('\n'),
			};
		}

		// 默认当 status
		const enabled = sessionId ? store.isEnabled(sessionId) : false;
		return {
			kind: 'success',
			text: [
				`本对话：${enabled ? '已接入全局记忆' : '不进全局记忆'}`,
				`全局记忆：${store.count()} 条（开着的会话 ${store.enabledCount()} 个）`,
				`存储：${store.memoryFile}`,
				`注入：每轮最近 ${conf('injectLimit', 6)} 条，上限 ${conf('injectMaxChars', 1200)} 字`,
				`摘要：${conf('summarize', 'turn') === 'off' ? '关闭（只记不摘）' : '每轮收尾一次'}`,
				'',
				'用法：/memory on|off|status|list',
			].join('\n'),
		};
	}

	log('ready', { dir: store.dir, entries: store.count() });
}

function memoryHome() {
	try {
		return dshHomePath('dsh-memory-optin');
	} catch {
		return undefined;
	}
}

export { Config, apply, inject, name };
