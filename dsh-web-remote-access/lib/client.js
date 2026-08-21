/**
 * @studyzy/dsh-web-remote-access/client — browser half of the remote-access
 * settings page. Registers a "远程访问" section in the settings panel that:
 *
 *   - shows the access URLs (loopback + LAN) with copy buttons,
 *   - renders a QR code of the primary URL, so scanning it on a phone opens
 *     the Web UI directly,
 *   - warns clearly when the server is bound to loopback only, because then a
 *     phone cannot reach it.
 *
 * No access token is involved: the web UI is directly accessible by design.
 * Host data comes from the `/api/remote-access/status` route registered by the
 * `settings-api` half.
 */
window.__ModuleLoader__.load({
	id: "@studyzy/dsh-web-remote-access",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		/** Stable registration id inside the settings section list. */
		const SECTION_ID = "remote-access";
		/** How long a status/action message stays visible. */
		const MESSAGE_MS = 4000;

		/** Fallback copy for insecure origins without the async clipboard API. */
		function fallbackCopy(text) {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			let ok = false;
			try { ok = document.execCommand("copy"); } catch { ok = false; }
			document.body.removeChild(ta);
			return ok;
		}

		/** Copy text to the clipboard; resolves to true on success. */
		function copyText(text) {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
			}
			return Promise.resolve(fallbackCopy(text));
		}

		/**
		 * The remote-access settings page. Fetches the host status on mount and
		 * renders the access/QR card.
		 */
		function RemoteAccessSection() {
			const [loading, setLoading] = React.useState(true);
			const [error, setError] = React.useState(null);
			const [data, setData] = React.useState(null);
			const [notice, setNotice] = React.useState(null);

			const flash = (text, kind) => {
				setNotice({ text, kind });
				window.setTimeout(() => setNotice(null), MESSAGE_MS);
			};

			const load = () => {
				setLoading(true);
				setError(null);
				fetch("/api/remote-access/status")
					.then((res) => {
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						return res.json();
					})
					.then((body) => { setData(body); setLoading(false); })
					.catch((err) => {
						setError(String(err && err.message ? err.message : err));
						setLoading(false);
					});
			};

			React.useEffect(load, []);

			const copy = (text) => {
				copyText(text).then((ok) => flash(ok ? "已复制" : "复制失败", ok ? "ok" : "error"));
			};

			const h = React.createElement;
			const st = {
				page: { display: "flex", flexDirection: "column", gap: "16px", maxWidth: "760px" },
				card: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "8px", padding: "16px" },
				title: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, margin: "0 0 4px", fontSize: "15px" },
				desc: { color: "var(--dsw-alias-label-secondary)", margin: "0 0 14px", fontSize: "13px", lineHeight: 1.6 },
				label: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", margin: "0 0 4px" },
				row: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px", flexWrap: "wrap" },
				mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-2)", padding: "7px 9px", borderRadius: "6px", wordBreak: "break-all", flex: "1 1 260px", fontSize: "13px", border: "1px solid transparent" },
				btn: { background: "var(--dsw-alias-brand-primary)", color: "#fff", border: "0", borderRadius: "6px", padding: "7px 14px", fontSize: "13px", cursor: "pointer" },
				btnGhost: { background: "transparent", color: "var(--dsw-alias-brand-primary)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", padding: "7px 14px", fontSize: "13px", cursor: "pointer" },
				qrWrap: { background: "#fff", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "8px", padding: "10px", display: "inline-flex" },
				qr: { width: "200px", height: "200px", display: "block" },
				noticeOk: { color: "var(--dsw-alias-state-success-primary)", fontSize: "13px", margin: "8px 0 0" },
				noticeErr: { color: "var(--dsw-alias-state-error-primary)", fontSize: "13px", margin: "8px 0 0" },
				warn: { color: "var(--dsw-alias-state-warn-primary)", border: "1px solid var(--dsw-alias-state-warn-primary)", borderRadius: "8px", padding: "12px 14px", fontSize: "13px", lineHeight: 1.6, margin: "0 0 4px" },
				muted: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", margin: "0 0 4px" },
			};

			const button = (label, onClick, opts) => h("button", {
				style: opts && opts.ghost ? st.btnGhost : st.btn,
				onClick,
			}, label);

			const loopbackOnly = data && (data.host === "127.0.0.1" || (data.origins && data.origins.length <= 1));

			return h("div", { style: st.page },
				loopbackOnly ? h("div", { style: st.warn },
					"⚠️ 服务当前只绑定在本机回环（127.0.0.1），手机无法访问。请先用 `dsh web --host 0.0.0.0` 重启服务，再回来扫码——重启后这里会自动显示局域网地址和二维码。") : null,
				h("div", { style: st.card },
					h("p", { style: st.title }, "远程访问"),
					h("p", { style: st.desc },
						"通过手机等设备访问本机 DeepSeek Harness：扫描下方二维码，或在手机浏览器打开访问地址，即可进入与电脑同步的同一界面（无需令牌，直接访问）。"),
					h("div", { style: st.row },
						h("div", { style: st.qrWrap },
							data && data.qr
								? h("img", { src: data.qr.svg, alt: "访问二维码", style: st.qr })
								: h("div", { style: { ...st.qr, background: "var(--dsw-alias-bg-layer-2)" } })),
						h("div", { style: { flex: 1, minWidth: "240px" } },
							h("p", { style: st.label }, "手机访问地址（扫码或输入）"),
							data && data.origins ? data.origins.map((origin) =>
								h("div", { key: origin.base, style: st.row },
									h("code", { style: st.mono }, origin.base),
									button("复制", () => copy(origin.base), { ghost: true })))
								: null,
							data && data.qr ? h("p", { style: st.muted }, "二维码内容：") : null,
							data && data.qr ? h("p", { style: { ...st.mono, flex: "none" } }, data.qr.url) : null)),
					h("div", { style: { display: "flex", gap: "24px", flexWrap: "wrap", marginTop: "6px" } },
						h("div", { style: { flex: "1 1 200px" } },
							h("p", { style: st.label }, "监听地址"),
							h("p", { style: st.mono }, data ? `${data.host}:${data.port}` : "—")),
						h("div", { style: { flex: "1 1 200px" } },
							h("p", { style: st.label }, "访问方式"),
							h("p", { style: st.muted }, data ? "直接访问（未启用令牌）" : "—"))),
					notice ? h("p", { style: notice.kind === "ok" ? st.noticeOk : st.noticeErr }, notice.text) : null,
					error ? h("p", { style: st.noticeErr }, `加载失败：${error}`) : null,
					loading ? h("p", { style: st.muted }, "加载中…") : null));
		}

		/**
		 * Register the remote-access section once the `settings.section`
		 * declaration is on the ledger. The label is a plain string (no locale
		 * dependency).
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: SECTION_ID,
				order: 110,
				label: () => "远程访问",
			}, RemoteAccessSection));
		}

		exports.RemoteAccessSection = RemoteAccessSection;
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
