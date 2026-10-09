/**
 * dsh-memory-optin · 持久化
 *
 * 两份数据，职责分开：
 *   - `sessions.json`：每个会话的开关（**默认关**，只有显式打开过才写进来）
 *   - `memory.jsonl`：全局记忆条目，一行一条，追加写
 *
 * 纪律（照 dsh-emotion 的 store.js）：
 *   - 读失败/损坏一律回落默认值，**不得因此让插件加载失败**；
 *   - 写盘原子（临时文件 + rename）并节流，避免每轮都打磁盘；
 *   - 这里不做任何判断逻辑，只负责存取。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const WRITE_THROTTLE_MS = 2000;
/** 启动时最多读回多少条记忆：注入只用到尾部，不必全量载入。 */
const MAX_LOAD_ENTRIES = 400;

function loadSessions(file) {
	try {
		if (!existsSync(file)) return {};
		const raw = JSON.parse(readFileSync(file, 'utf8'));
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const out = {};
		for (const [id, value] of Object.entries(raw)) {
			// 只有「开过」才值得留：默认就是关，`enabled: false` 的记录不携带信息。
			// 这条不变量同时让旧版本写下的垃圾记录在下次启动时自愈。
			if (value && typeof value === 'object' && value.enabled === true) {
				out[id] = { enabled: true, updatedAt: Number(value.updatedAt) || 0 };
			}
		}
		return out;
	} catch {
		return {};
	}
}

function loadEntries(file) {
	try {
		if (!existsSync(file)) return [];
		const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
		const out = [];
		for (const line of lines.slice(-MAX_LOAD_ENTRIES)) {
			try {
				const entry = JSON.parse(line);
				if (entry && typeof entry.text === 'string' && entry.text.trim() !== '') out.push(entry);
			} catch {
				// 单行损坏只丢这一行
			}
		}
		return out;
	} catch {
		return [];
	}
}

export function createMemoryStore(dir) {
	const sessionsFile = join(dir, 'sessions.json');
	const memoryFile = join(dir, 'memory.jsonl');

	const sessions = loadSessions(sessionsFile);
	const entries = loadEntries(memoryFile);

	let lastSessionsWrite = 0;

	function persistSessions(force = false) {
		const now = Date.now();
		if (!force && now - lastSessionsWrite < WRITE_THROTTLE_MS) return;
		lastSessionsWrite = now;
		try {
			mkdirSync(dirname(sessionsFile), { recursive: true });
			const tmp = `${sessionsFile}.tmp`;
			writeFileSync(tmp, JSON.stringify(sessions, null, 2), 'utf8');
			renameSync(tmp, sessionsFile);
		} catch {
			// 写失败不影响运行
		}
	}

	return {
		dir,
		sessionsFile,
		memoryFile,

		isEnabled(sessionId) {
			return sessions[sessionId]?.enabled === true;
		},

		/**
		 * 开关写盘。**关掉等于删除记录** —— 默认就是关，留一条 `enabled: false`
		 * 不携带任何信息，只会让文件里攒垃圾。
		 */
		setEnabled(sessionId, enabled) {
			if (!sessionId) return false;
			if (enabled === true) {
				sessions[sessionId] = { enabled: true, updatedAt: Date.now() };
			} else {
				delete sessions[sessionId];
			}
			persistSessions(true);
			return enabled === true;
		},

		enabledCount() {
			return Object.values(sessions).filter((value) => value?.enabled === true).length;
		},

		/** 开着的会话 id 列表（诊断用）。 */
		enabledIds() {
			return Object.entries(sessions)
				.filter(([, value]) => value?.enabled === true)
				.map(([id]) => id);
		},

		append(entry) {
			const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
			if (text === '') return null;
			const record = {
				at: Number(entry.at) || Date.now(),
				sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
				text,
			};
			entries.push(record);
			if (entries.length > MAX_LOAD_ENTRIES * 4) entries.splice(0, entries.length - MAX_LOAD_ENTRIES * 4);
			try {
				mkdirSync(dirname(memoryFile), { recursive: true });
				appendFileSync(memoryFile, `${JSON.stringify(record)}\n`, 'utf8');
			} catch {
				// 内存里已经有了，落盘失败下次再试
			}
			return record;
		},

		recent(limit) {
			const n = Math.max(0, Math.floor(Number(limit) || 0));
			if (n === 0) return [];
			return entries.slice(-n);
		},

		count() {
			return entries.length;
		},
	};
}
