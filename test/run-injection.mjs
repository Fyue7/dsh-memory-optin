/**
 * 注入面自检的入口：先把桩件解析钩子注册好，再跑测试。
 *
 * 跑法：node test/run-injection.mjs
 *
 * 为什么需要这一层：`--import` 只是执行一个模块，不会把它的 `resolve` 导出注册成钩子；
 * 注册必须显式调 `module.register()`。
 */

import { register } from 'node:module';

register('./stub-loader.mjs', import.meta.url);
await import('./injection.test.mjs');
