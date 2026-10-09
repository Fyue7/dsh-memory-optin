/**
 * dsh-memory-gate · 客户端半（输入框工具行里的记忆开关）
 *
 * 形态照已在跑的 dsh-emotion：`window.__ModuleLoader__.load` + 裸 ESM、
 * 无构建步骤、只注册槽位。
 *
 * 两条纪律：
 *   1. 顶层除了 loader 调用不干别的——客户端加载失败会拖垮整个界面；
 *   2. 宿主路由拿不到时**降级成不可点**，绝不抛出去。
 *
 * 数据走宿主自己的两个 POST 路由，不碰会话投影（开关不是纯事件折叠得出来的）。
 */

window.__ModuleLoader__.load({
	id: 'dsh-memory-gate',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require('react');

		var SLOT = 'conversation.input.left';
		var API = '/memory-gate/api';

		var css = [
			'.dsmg-root{min-height:28px;display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:0;border-radius:6px;background:0 0;cursor:pointer;font-size:12px;line-height:18px;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
			'.dsmg-root:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dsmg-root[data-on="1"]{color:var(--dsw-alias-label-primary)}',
			'.dsmg-root[data-busy="1"],.dsmg-root[data-dead="1"]{opacity:.55;cursor:default}',
			'.dsmg-icon{font-size:13px;line-height:1}',
			'.dsmg-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.35}',
			'.dsmg-root[data-on="1"] .dsmg-dot{opacity:1}',
		].join('\n');

		try {
			if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-memory-gate/styles"]') === null) {
				var tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-memory-gate';
				tag.dataset.pluginCss = 'dsh-memory-gate/styles';
				tag.textContent = css;
				document.head.appendChild(tag);
			}
		} catch (_) {}

		function post(action, body) {
			return fetch(API + '/' + action, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body || {}),
			}).then(function (response) {
				return response.ok ? response.json() : null;
			});
		}

		function pickSessionId(props) {
			if (!props) return '';
			if (typeof props.sessionId === 'string' && props.sessionId) return props.sessionId;
			if (props.session && typeof props.session.id === 'string') return props.session.id;
			if (typeof props.activeSessionId === 'string' && props.activeSessionId) return props.activeSessionId;
			return '';
		}

		function Gate(props) {
			var useState = react.useState;
			var useEffect = react.useEffect;
			// hooks 拿不到就退回一个静态指示，绝不因为版本差异炸掉整个工具行
			if (typeof useState !== 'function' || typeof useEffect !== 'function') {
				return react.createElement('span', { className: 'dsmg-root', 'data-dead': '1' }, '记忆');
			}

			var sessionId = pickSessionId(props);
			var statePair = useState(null); // null = 还没问到 | {enabled, entries}
			var view = statePair[0];
			var setView = statePair[1];
			var busyPair = useState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];
			var deadPair = useState(false);
			var dead = deadPair[0];
			var setDead = deadPair[1];

			useEffect(
				function () {
					if (!sessionId) {
						setView(null);
						return undefined;
					}
					var alive = true;
					post('state', { sessionId: sessionId })
						.then(function (payload) {
							if (!alive) return;
							if (payload && payload.ok) {
								setView(payload.value);
								setDead(false);
							} else {
								setDead(true);
							}
						})
						.catch(function () {
							if (alive) setDead(true);
						});
					return function () {
						alive = false;
					};
				},
				[sessionId],
			);

			function toggle() {
				if (!sessionId || busy || dead) return;
				var next = !(view && view.enabled);
				setBusy(true);
				post('set', { sessionId: sessionId, enabled: next })
					.then(function (payload) {
						if (payload && payload.ok) setView(payload.value);
						else setDead(true);
					})
					.catch(function () {
						setDead(true);
					})
					.then(function () {
						setBusy(false);
					});
			}

			var on = Boolean(view && view.enabled);
			var label = on ? '记忆·开' : '记忆';
			var tooltip = dead
				? '记忆开关：宿主路由不可用（插件可能没装好）'
				: !sessionId
					? '记忆开关：还没有会话'
					: on
						? '这个对话会写进全局记忆。点一下关掉。\n已积累 ' + (view && view.entries ? view.entries : 0) + ' 条'
						: '这个对话不进全局记忆。点一下开始记录。';

			return react.createElement(
				'button',
				{
					type: 'button',
					className: 'dsmg-root',
					'data-on': on ? '1' : '0',
					'data-busy': busy ? '1' : '0',
					'data-dead': dead ? '1' : '0',
					title: tooltip,
					'aria-label': tooltip,
					'aria-pressed': on ? 'true' : 'false',
					onClick: toggle,
				},
				react.createElement('span', { className: 'dsmg-icon', key: 'icon' }, on ? '🧠' : '💤'),
				react.createElement('span', { key: 'label' }, label),
				react.createElement('span', { className: 'dsmg-dot', key: 'dot' }),
			);
		}

		var inject = ['slots'];

		function apply(ctx) {
			if (!ctx || !ctx.slots) return;
			try {
				ctx.slots.inject(SLOT, function () {
					return ctx.slots.register({ name: SLOT, id: 'memory-gate', order: 40 }, Gate);
				});
			} catch (error) {
				try {
					window.__dshMemoryGateError = String((error && error.message) || error);
				} catch (_) {}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
