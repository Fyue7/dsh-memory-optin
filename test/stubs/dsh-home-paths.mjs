/**
 * `@deepseek-ai/dsh-home-paths` 的测试桩件：
 * 把插件状态写到临时目录，避免自检污染真实 $DSH_HOME。
 *
 * 目录由测试通过 DSMO_TEST_HOME 指定；没设就退回系统临时目录下的固定名字。
 */

import os from 'node:os';
import path from 'node:path';

export function dshHomePath(...segments) {
	const base = process.env.DSMO_TEST_HOME || path.join(os.tmpdir(), 'dsh-memory-optin-test-home');
	return path.join(base, ...segments);
}

export default { dshHomePath };
