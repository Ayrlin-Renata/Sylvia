/**
 * sylvia-bridge — client half (mobile shell).
 *
 * Loaded through window.__ModuleLoader__ by @deepseek-ai/dsh-client-modules
 * (package.json `dsh.client` declaration) and applied once as a cordis client
 * fiber. Plain browser JS — no build step, no imports.
 *
 * Owns the MOBILE base stylesheet and behavior; the user overlay seam
 * (~/.sylvia/mobile.css, injected into the served index by the bridge's host
 * half) stays untouched and must keep winning ties, so this file re-orders
 * that tag after its own on load.
 *
 * Features (≤767px only — every rule is media-scoped, desktop is untouched):
 *   1. Frame pin: the AppFrame grid is inline-styled per viewport, which lets
 *      the expanded sidebar squeeze the chat column to ~95px on a phone. We
 *      pin the grid to `56px | 1fr | 0` and float the sidebar over the
 *      content as a drawer instead (layout's own narrowExpanded state drives
 *      it — we only change the geometry), so the center never squishes.
 *   2. Settings tabs-accordion: the settings dialog (nav rail + content,
 *      [data-shortcut-modal="settings"]) becomes menu-FIRST on mobile — rail
 *      OR content, never both — with a floating Back affordance (outside the
 *      React tree, restart-button precedent) and a full-bleed panel.
 *   3. Hamburger: a body-level fixed button calling ctx.layout.toggleSidebar()
 *      (the layout service resolves via ctx.get with a retry budget because
 *      fiber activation order is not guaranteed).
 *
 * Structural hooks used (stable, not hashed classes):
 *   [data-shell-bottom]  -> its parentElement is the AppFrame
 *   child order          -> frame element children[0] = sidebar col, [1] = center
 *   [data-sidebar-collapsed], [data-shortcut-modal="settings"]
 */
window.__ModuleLoader__.load({
	id: "sylvia-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/** Services this surface needs (none resolved statically: layout is ctx.get'd with retries). */
		var inject = [];

		var BASE_ID = "sylvia-mobile-base-css";
		var OVERLAY_ID = "sylvia-mobile-css";
		var MOBILE_QUERY = "(max-width: 767px)";
		var SETTINGS_PANEL = '[role="dialog"][data-shortcut-modal="settings"]';
		var LAYOUT_POLL_MS = 250;
		var LAYOUT_POLL_MAX = 120; /* 30s: activation-order insurance, not a hang */

		var CSS = [
			/* ---- 1. frame pin + sidebar drawer + center min-width ---- */
			"@media (max-width:767px){",
			/* Pin the inline grid: rail 56px, center takes the rest, no rightbar push. */
			'[data-sylvia-frame]{grid-template-columns:56px minmax(0,1fr) minmax(0px,0px)!important}',
			/* Sidebar floats over the content as a drawer in both states. */
			'[data-sylvia-frame] > [data-sylvia-side]{position:absolute;left:0;top:0;bottom:0;width:264px;max-width:78vw;z-index:60;transition:transform .18s ease;box-shadow:0 8px 28px rgba(0,0,0,.4)}',
			'[data-sylvia-frame][data-sidebar-collapsed] > [data-sylvia-side]{transform:translateX(-101%);pointer-events:none;box-shadow:none}',
			/* The center column never drops below a readable width (we scroll instead of squishing). */
			'[data-sylvia-frame] > [data-sylvia-center]{min-width:300px}',
			/* ---- 2. settings: full-bleed panel + tabs-accordion ---- */
			'[role="dialog"][data-shortcut-modal="settings"]{width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;border-radius:0!important;box-sizing:border-box!important;display:flex!important;flex-direction:column!important}',
			'[role="dialog"][data-shortcut-modal="settings"] > nav{flex:1 1 auto;min-height:0;overflow:auto}',
			'[role="dialog"][data-shortcut-modal="settings"] > div:last-child{flex:1 1 auto;min-width:0;min-height:0;overflow:auto}',
			/* Default (no attribute): menu-first — rail visible, content hidden. */
			'[role="dialog"][data-shortcut-modal="settings"]:not([data-sylvia-acc="content"]) > div:last-child{display:none}',
			/* Content mode: rail hidden, content fills. */
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav{display:none}',
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > div:last-child{display:block}',
			/* ---- floating affordances (body-level, outside React) ---- */
			".sylvia-hamburger{position:fixed;top:calc(env(safe-area-inset-top,0px) + 10px);right:10px;width:42px;height:42px;z-index:700;border:none;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#1b1e27);color:var(--dsw-alias-label-primary,#e6e8ee);font-size:20px;line-height:42px;padding:0;box-shadow:0 2px 10px rgba(0,0,0,.4);display:none;touch-action:manipulation;-webkit-tap-highlight-color:transparent}",
			".sylvia-hamburger.sylvia-on{display:block}",
			".sylvia-acc-back{position:fixed;left:10px;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);z-index:9000;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#1b1e27);color:var(--dsw-alias-label-primary,#e6e8ee);font-size:14px;padding:10px 16px;box-shadow:0 4px 16px rgba(0,0,0,.45);display:none;touch-action:manipulation;-webkit-tap-highlight-color:transparent}",
			".sylvia-acc-back.sylvia-on{display:block}",
			"}"
		].join("");

		function ensureCss() {
			var style = document.getElementById(BASE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = BASE_ID;
				style.textContent = CSS;
				document.head.appendChild(style);
			}
			/* The host's user overlay was injected into <head> before any plugin
			 * ran; move it after this base tag so user edits keep winning ties. */
			var overlay = document.getElementById(OVERLAY_ID);
			if (overlay !== null && overlay.parentNode !== null) overlay.parentNode.appendChild(overlay);
			return style;
		}

		function isMobile() {
			return window.matchMedia(MOBILE_QUERY).matches;
		}

		/** Tag the AppFrame + its sidebar/center columns with stable hooks. */
		function tagFrame() {
			var bottom = document.querySelector("[data-shell-bottom]");
			var frame = bottom === null ? null : bottom.parentElement;
			if (frame === null || frame.hasAttribute("data-sylvia-frame")) return;
			var children = [];
			for (var i = 0; i < frame.children.length; i++) {
				if (frame.children[i].hasAttribute("data-shell-bottom")) break;
				children.push(frame.children[i]);
			}
			/* AppFrame child order (React renders DocumentTitle as null): sidebar, center, rightbar. */
			if (children.length < 2) return;
			frame.setAttribute("data-sylvia-frame", "");
			children[0].setAttribute("data-sylvia-side", "");
			children[1].setAttribute("data-sylvia-center", "");
		}

		function apply(ctx) {
			var styleTag = ensureCss();
			tagFrame();

			var disposed = false;
			var mobile = isMobile();

			/* ---- settings accordion state ---- */
			var accState = "nav"; /* panel freshly mounted = menu-first */
			var backBtn = document.createElement("button");
			backBtn.type = "button";
			backBtn.className = "sylvia-acc-back";
			backBtn.textContent = "‹ " + "Back";
			backBtn.setAttribute("aria-label", "Back to settings menu");
			var wiredPanels = new WeakSet();

			function setBack(on) {
				if (on && mobile) {
					if (backBtn.parentNode === null) document.body.appendChild(backBtn);
					backBtn.classList.add("sylvia-on");
				} else {
					backBtn.classList.remove("sylvia-on");
				}
			}

			function resetAcc(panel) {
				accState = "nav";
				if (panel !== null && panel.hasAttribute("data-sylvia-acc")) panel.removeAttribute("data-sylvia-acc");
				setBack(false);
			}

			function wirePanel(panel) {
				if (wiredPanels.has(panel)) return;
				wiredPanels.add(panel);
				panel.addEventListener("click", function (event) {
					if (disposed || !mobile) return;
					var nav = event.target && event.target.closest ? event.target.closest("nav") : null;
					if (nav === null || !panel.contains(nav)) return;
					/* A rail cell was tapped: show content only (never both). */
					accState = "content";
					panel.setAttribute("data-sylvia-acc", "content");
					setBack(true);
				});
			}

			backBtn.addEventListener("click", function () {
				var panel = document.querySelector(SETTINGS_PANEL);
				resetAcc(panel);
			});

			var bodyObserver = new MutationObserver(function () {
				if (disposed) return;
				tagFrame();
				var panel = document.querySelector(SETTINGS_PANEL);
				if (panel === null) {
					resetAcc(null);
				} else {
					wirePanel(panel);
				}
			});
			bodyObserver.observe(document.body, { childList: true, subtree: true });

			/* ---- hamburger -> ctx.layout.toggleSidebar() ---- */
			var hamburger = document.createElement("button");
			hamburger.type = "button";
			hamburger.className = "sylvia-hamburger";
			hamburger.textContent = "\u2630"; /* ☰ */
			hamburger.setAttribute("aria-label", "Toggle sidebar");
			var layout = null;
			var weOpened = false;

			function setHamburger(on) {
				if (on && mobile) {
					if (hamburger.parentNode === null) document.body.appendChild(hamburger);
					hamburger.classList.add("sylvia-on");
				} else {
					hamburger.classList.remove("sylvia-on");
				}
			}

			hamburger.addEventListener("click", function () {
				if (layout === null || !mobile) return;
				var frame = document.querySelector("[data-sylvia-frame]");
				weOpened = frame !== null && frame.hasAttribute("data-sidebar-collapsed");
				layout.toggleSidebar();
			});

			/* Outside-tap closes the drawer — but only when WE opened it, so the
			 * app's own triggers and rail cells are never fought over. */
			document.addEventListener("click", function (event) {
				if (disposed || !mobile || !weOpened) return;
				var frame = document.querySelector("[data-sylvia-frame]");
				if (frame === null || frame.hasAttribute("data-sidebar-collapsed")) {
					weOpened = false;
					return;
				}
				var t = event.target;
				if (!t || !t.closest) return;
				if (t.closest("[data-sylvia-side]") !== null) return;
				if (t.closest(".sylvia-hamburger") !== null) return;
				if (t.closest("[role=dialog]") !== null) return;
				if (layout !== null) layout.toggleSidebar();
				weOpened = false;
			});

			/* Layout service resolution with a retry budget (activation order is
			 * not guaranteed across fibers; ctx.get returns undefined until the
			 * provider registers). */
			var polls = 0;
			var layoutTimer = setInterval(function () {
				if (disposed) return;
				var service = null;
				try {
					service = typeof ctx.get === "function" ? ctx.get("layout") : null;
				} catch (error) {
					service = null;
				}
				if (service !== null && service !== void 0 && typeof service.toggleSidebar === "function") {
					layout = service;
					clearInterval(layoutTimer);
				} else if (++polls >= LAYOUT_POLL_MAX) {
					clearInterval(layoutTimer);
				}
			}, LAYOUT_POLL_MS);

			/* ---- breakpoint flips ---- */
			var mq = window.matchMedia(MOBILE_QUERY);
			function onMq() {
				mobile = mq.matches;
				setHamburger(mobile && layout !== null);
				if (!mobile) {
					resetAcc(document.querySelector(SETTINGS_PANEL));
					weOpened = false;
				}
			}
			if (typeof mq.addEventListener === "function") mq.addEventListener("change", onMq);
			else if (typeof mq.addListener === "function") mq.addListener(onMq);
			setHamburger(mobile && layout !== null);

			/* Layout arrives after the first matchMedia paint — refresh the button. */
			var layoutWatch = setInterval(function () {
				if (disposed) return;
				if (layout !== null) {
					setHamburger(true);
					clearInterval(layoutWatch);
				}
			}, 500);

			return function dispose() {
				disposed = true;
				clearInterval(layoutTimer);
				clearInterval(layoutWatch);
				bodyObserver.disconnect();
				if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", onMq);
				else if (typeof mq.removeListener === "function") mq.removeListener(onMq);
				setBack(false);
				setHamburger(false);
				if (backBtn.parentNode !== null) backBtn.parentNode.removeChild(backBtn);
				if (hamburger.parentNode !== null) hamburger.parentNode.removeChild(hamburger);
				if (styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag);
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
