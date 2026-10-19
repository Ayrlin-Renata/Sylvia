/**
 * sylvia-bridge — client half (mobile shell).
 *
 * Loaded through window.__ModuleLoader__ by @deepseek-ai/dsh-client-modules
 * (package.json `dsh.client` declaration) and applied once as a cordis client
 * fiber. Plain browser JS — no build step, no imports.
 *
 * Owns ALL base mobile styling (the installer only seeds ~/.sylvia/mobile.css
 * as an empty USER overlay; every structural style lives here so it ships,
 * versions and maintains like the rest of the DSH client ecosystem). The
 * overlay seam keeps winning ties: this file re-appends that host-injected
 * tag after its own on load.
 *
 * Behavior, all media-scoped to <=767px (desktop untouched):
 *   - Settings tabs-accordion, presented like the app's own sidebar fold:
 *       MENU mode (default on open): the section rail is large and full-width,
 *         content hidden — pick a section.
 *       CONTENT mode: the rail CONTRACTS to a 52px icon-only strip (labels
 *         visually hidden, accessibility kept) beside the content — never both
 *         at full size. A fixed "show menu" pill (the rail's collapse/expand
 *         control, replacing any floating back button) returns to MENU mode.
 *     State resets whenever the dialog unmounts.
 *   - Generic dialog fit (the original oversized-dialog offender).
 *
 * Deliberately NOT here (user decisions after live testing): frame-grid pins,
 * sidebar drawer overrides and hamburger buttons — the built-in sidebar
 * already accordion-folds on its own below 1024px, and DSH plugins must not
 * fight native layout behavior.
 *
 * Structural hooks: [data-shortcut-modal="settings"] (settings dialog),
 * nav > div first/last children (navTitle/navList), button > span last
 * (navLabel). No hashed class names are ever targeted.
 */
window.__ModuleLoader__.load({
	id: "sylvia-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/** Services this surface needs (none: plain DOM only). */
		var inject = [];

		var BASE_ID = "sylvia-mobile-base-css";
		var OVERLAY_ID = "sylvia-mobile-css";
		var MOBILE_QUERY = "(max-width: 767px)";
		var SETTINGS_PANEL = '[role="dialog"][data-shortcut-modal="settings"]';

		var CSS = [
			/* ---- generic fit: dialogs must not exceed a phone viewport ---- */
			"@media (max-width:767px){",
			'[role="dialog"]:not([data-shortcut-modal="settings"]){max-width:100vw!important;max-height:100dvh!important;box-sizing:border-box!important;overflow:auto!important;overflow-wrap:anywhere}',
			'[role="dialog"]:not([data-shortcut-modal="settings"]) *{min-width:0;max-width:100%}',
			/* ---- settings: full-bleed shell ---- */
			'[role="dialog"][data-shortcut-modal="settings"]{width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;border-radius:0!important;box-sizing:border-box!important;display:flex!important;flex-direction:column!important;overflow:hidden!important}',
			/* ---- MENU mode (no attribute yet): rail large + full-width, content hidden ---- */
			'[role="dialog"][data-shortcut-modal="settings"]:not([data-sylvia-acc="content"]) > div:last-child{display:none}',
			'[role="dialog"][data-shortcut-modal="settings"]:not([data-sylvia-acc="content"]) > nav{flex:1 1 auto;width:100%;min-height:0;overflow:auto}',
			'[role="dialog"][data-shortcut-modal="settings"]:not([data-sylvia-acc="content"]) > nav > div:last-child > button{min-height:48px}',
			/* ---- CONTENT mode: rail contracts to a thin icon strip, content takes the rest ---- */
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav{flex:0 0 52px;width:52px;min-height:0;overflow:hidden;display:flex;flex-direction:column}',
			/* navTitle (first div inside nav) is menu-only text */
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav > div:first-child{display:none}',
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav > div:last-child{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;width:100%}',
			/* icon-only rows: labels visually hidden but kept for accessibility */
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav > div:last-child > button{width:100%!important;justify-content:center;padding-left:0;padding-right:0}',
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav > div:last-child > button > span:last-child{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}',
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > div:last-child{flex:1 1 auto;min-width:0;min-height:0;overflow:auto}',
			/* ---- the rail's show-menu control (body-level, outside the React tree) ---- */
			".sylvia-acc-expand{position:fixed;left:4px;top:calc(env(safe-area-inset-top,0px) + 6px);z-index:9000;min-width:44px;height:44px;border:none;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#1b1e27);color:var(--dsw-alias-label-primary,#e6e8ee);font-size:18px;line-height:44px;padding:0 10px;box-shadow:0 4px 14px rgba(0,0,0,.45);display:none;touch-action:manipulation;-webkit-tap-highlight-color:transparent}",
			".sylvia-acc-expand.sylvia-on{display:block}",
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

		function apply(ctx) {
			var styleTag = ensureCss();
			var disposed = false;
			var mobile = isMobile();

			/* ---- settings accordion: menu <-> thin icon rail ---- */
			var expandBtn = document.createElement("button");
			expandBtn.type = "button";
			expandBtn.className = "sylvia-acc-expand";
			expandBtn.textContent = "\u2261"; /* ≡ */
			expandBtn.setAttribute("aria-label", "Show settings menu");
			var wiredPanels = new WeakSet();

			function setExpand(on) {
				if (on && mobile) {
					if (expandBtn.parentNode === null) document.body.appendChild(expandBtn);
					expandBtn.classList.add("sylvia-on");
				} else {
					expandBtn.classList.remove("sylvia-on");
				}
			}

			function toMenu(panel) {
				if (panel !== null && panel.hasAttribute("data-sylvia-acc")) panel.removeAttribute("data-sylvia-acc");
				setExpand(false);
			}

			function toContent(panel) {
				panel.setAttribute("data-sylvia-acc", "content");
				setExpand(true);
			}

			expandBtn.addEventListener("click", function () {
				toMenu(document.querySelector(SETTINGS_PANEL));
			});

			function wirePanel(panel) {
				if (wiredPanels.has(panel)) return;
				wiredPanels.add(panel);
				panel.addEventListener("click", function (event) {
					if (disposed || !mobile) return;
					var nav = event.target && event.target.closest ? event.target.closest("nav") : null;
					if (nav === null || !panel.contains(nav)) return;
					/* A section row was tapped: contract the rail to icons (never both large). */
					toContent(panel);
				});
			}

			var bodyObserver = new MutationObserver(function () {
				if (disposed) return;
				var panel = document.querySelector(SETTINGS_PANEL);
				if (panel === null) {
					/* Dialog unmounted: next open starts in menu mode. */
					setExpand(false);
				} else {
					wirePanel(panel);
				}
			});
			bodyObserver.observe(document.body, { childList: true, subtree: true });

			/* ---- breakpoint flips ---- */
			var mq = window.matchMedia(MOBILE_QUERY);
			function onMq() {
				mobile = mq.matches;
				var panel = document.querySelector(SETTINGS_PANEL);
				setExpand(mobile && panel !== null && panel.hasAttribute("data-sylvia-acc"));
			}
			if (typeof mq.addEventListener === "function") mq.addEventListener("change", onMq);
			else if (typeof mq.addListener === "function") mq.addListener(onMq);

			return function dispose() {
				disposed = true;
				bodyObserver.disconnect();
				if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", onMq);
				else if (typeof mq.removeListener === "function") mq.removeListener(onMq);
				setExpand(false);
				if (expandBtn.parentNode !== null) expandBtn.parentNode.removeChild(expandBtn);
				if (styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag);
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
