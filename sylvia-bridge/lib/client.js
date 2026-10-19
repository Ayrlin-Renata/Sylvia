/**
 * sylvia-bridge — client half (mobile shell + style warden).
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
 *   - Settings tabs-accordion, presented like a real sidebar INSIDE the
 *     settings view (no floating pills over content):
 *       MENU mode (default on open): the section rail is large/full-width
 *         with names — pick a section.
 *       CONTENT mode: the rail CONTRACTS to a 52px icon-only strip beside
 *         the content (labels visually hidden, accessibility kept) — never
 *         both at full size.
 *       The rail's TOP icon (a fixed control seated on the rail itself,
 *       glyph » / «) expands the full menu or collapses it back to icons.
 *     State resets whenever the dialog unmounts.
 *   - Generic dialog fit (the original oversized-dialog offender).
 *   - STYLE WARDEN: core plugin module styles (e.g. the layout's AppFrame /
 *     MobileFrame css) are injected as <style data-plugin-css> tags at module
 *     eval and are removed by client-modules' HMR bookkeeping
 *     (removeOwnedStyles) whenever an entry is invalidated — and a cached
 *     factory does not re-inject them, leaving the mobile shell unstyled
 *     (sidebar stacked below content, top-bar buttons unstyled and inert).
 *     We snapshot every tagged style at apply-time and restore any that
 *     disappear (unless the owner re-injected a fresh one).
 *
 * Deliberately NOT here (user decisions after live testing): frame-grid pins,
 * sidebar drawer overrides and hamburger buttons — the stock AppFrame owns the
 * main page (its sidebar auto-collapses to an icon rail below 1024px), and the
 * fork's MobileFrame shell was retired (2026-10-19): all mobile UI concerns
 * now live in this plugin, never in forked layout code.
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
		var WARDEN_DELAY_MS = 150;

		var CSS = [
			/* ---- generic fit: dialogs must not exceed a phone viewport ---- */
			"@media (max-width:767px){",
			'[role="dialog"]:not([data-shortcut-modal="settings"]){max-width:100vw!important;max-height:100dvh!important;box-sizing:border-box!important;overflow:auto!important;overflow-wrap:anywhere}',
			'[role="dialog"]:not([data-shortcut-modal="settings"]) *{min-width:0;max-width:100%}',
			/* ---- settings: full-bleed shell, rail | content side by side ---- */
			'[role="dialog"][data-shortcut-modal="settings"]{width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;border-radius:0!important;box-sizing:border-box!important;display:flex!important;flex-direction:row!important;overflow:hidden!important}',
			/* ---- MENU mode (no attribute): rail large + full-width, content hidden ---- */
			'[role="dialog"][data-shortcut-modal="settings"]:not([data-sylvia-acc="content"]) > div:last-child{display:none}',
			'[role="dialog"][data-shortcut-modal="settings"]:not([data-sylvia-acc="content"]) > nav{flex:1 1 auto;width:100%;min-height:0;overflow:auto}',
			'[role="dialog"][data-shortcut-modal="settings"]:not([data-sylvia-acc="content"]) > nav > div:last-child > button{min-height:48px}',
			/* clear the top-rail toggle so the heading is not covered */
			'[role="dialog"][data-shortcut-modal="settings"]:not([data-sylvia-acc="content"]) > nav > div:first-child{padding-left:56px}',
			/* ---- CONTENT mode: rail contracts to a 52px icon strip ---- */
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav{flex:0 0 52px;width:52px;min-height:0;overflow:hidden;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.25))}',
			/* navTitle (first div inside nav) is menu-only text */
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav > div:first-child{display:none}',
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav > div:last-child{flex:1 1 auto;min-height:0;padding-top:52px;overflow-y:auto;overflow-x:hidden;width:100%}',
			/* icon-only rows: labels visually hidden but kept for accessibility */
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav > div:last-child > button{width:100%!important;justify-content:center;padding-left:0;padding-right:0}',
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > nav > div:last-child > button > span:last-child{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}',
			'[role="dialog"][data-shortcut-modal="settings"][data-sylvia-acc="content"] > div:last-child{flex:1 1 auto;min-width:0;min-height:0;overflow:auto}',
			/* ---- the rail's TOP toggle (seated on the rail itself, both modes) ---- */
			".sylvia-acc-expand{position:fixed;left:0;top:0;z-index:9000;width:52px;height:48px;border:none;border-radius:0 10px 10px 0;background:var(--dsw-alias-bg-layer-2,#1b1e27);color:var(--dsw-alias-label-primary,#e6e8ee);font-size:18px;line-height:48px;padding:0;box-shadow:2px 2px 10px rgba(0,0,0,.35);display:none;touch-action:manipulation;-webkit-tap-highlight-color:transparent}",
			".sylvia-acc-expand.sylvia-on{display:block}",
			"}"
		].join("");

		function overlayTag() {
			return document.getElementById(OVERLAY_ID);
		}

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
			var overlay = overlayTag();
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

			/* ================= style warden (core module styles) ============= */
			/* Snapshot every plugin-owned module style; restore any that vanish
			 * unless the owner already re-injected a fresh tag. */
			var warden = new Map(); // data-plugin-css key -> {plugin, css}
			function snapshotStyles() {
				var tags = document.querySelectorAll("style[data-plugin-css]");
				for (var i = 0; i < tags.length; i++) {
					var el = tags[i];
					warden.set(el.getAttribute("data-plugin-css"), {
						plugin: el.getAttribute("data-plugin"),
						css: el.textContent
					});
				}
			}
			function restoreStyle(key) {
				if (disposed) return;
				if (document.querySelector("style[data-plugin-css=" + JSON.stringify(key) + "]") !== null) return; // re-injected
				var rec = warden.get(key);
				if (rec === undefined) return;
				var tag = document.createElement("style");
				if (rec.plugin !== null) tag.setAttribute("data-plugin", rec.plugin);
				tag.setAttribute("data-plugin-css", key);
				tag.textContent = rec.css;
				document.head.appendChild(tag);
				/* restored after the overlay — keep the user's overlay last */
				var overlay = overlayTag();
				if (overlay !== null && overlay.parentNode !== null) overlay.parentNode.appendChild(overlay);
			}
			function scheduleRestore(key) {
				setTimeout(function () { restoreStyle(key); }, WARDEN_DELAY_MS);
			}
			snapshotStyles();
			var headObserver = new MutationObserver(function (records) {
				if (disposed) return;
				for (var r = 0; r < records.length; r++) {
					var removed = records[r].removedNodes;
					for (var i = 0; i < removed.length; i++) {
						var node = removed[i];
						if (node.nodeType === 1 && node.nodeName === "STYLE" && node.hasAttribute("data-plugin-css")) {
							scheduleRestore(node.getAttribute("data-plugin-css"));
						}
					}
				}
			});
			headObserver.observe(document.head, { childList: true });
			/* Late reconciles catch removals that slipped past the observer window
			 * (and pick up styles injected after apply-time). */
			var wardenTimers = [3000, 12000].map(function (delay) {
				return setTimeout(function () {
					if (disposed) return;
					snapshotStyles();
					warden.forEach(function (_rec, key) { scheduleRestore(key); });
				}, delay);
			});

			/* ================= settings accordion =========================== */
			var expandBtn = document.createElement("button");
			expandBtn.type = "button";
			expandBtn.className = "sylvia-acc-expand";
			expandBtn.setAttribute("aria-label", "Expand or collapse the settings menu");
			var wiredPanels = new WeakSet();

			function updateToggle(panel) {
				var on = mobile && panel !== null;
				if (!on) {
					expandBtn.classList.remove("sylvia-on");
					return;
				}
				/* collapsed (icons beside content) → » expands the names;
				 * expanded (full menu) → « collapses back to icons. */
				expandBtn.textContent = panel.hasAttribute("data-sylvia-acc") ? "\u00bb" : "\u00ab";
				if (expandBtn.parentNode === null) document.body.appendChild(expandBtn);
				expandBtn.classList.add("sylvia-on");
			}

			function toMenu(panel) {
				if (panel !== null && panel.hasAttribute("data-sylvia-acc")) panel.removeAttribute("data-sylvia-acc");
				updateToggle(panel);
			}

			function toContent(panel) {
				panel.setAttribute("data-sylvia-acc", "content");
				updateToggle(panel);
			}

			expandBtn.addEventListener("click", function () {
				var panel = document.querySelector(SETTINGS_PANEL);
				if (panel === null || !mobile) return;
				if (panel.hasAttribute("data-sylvia-acc")) toMenu(panel);
				else toContent(panel);
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
					updateToggle(null); /* dialog unmounted: next open starts in menu mode */
				} else {
					wirePanel(panel);
					updateToggle(panel);
				}
			});
			bodyObserver.observe(document.body, { childList: true, subtree: true });

			/* ---- breakpoint flips ---- */
			var mq = window.matchMedia(MOBILE_QUERY);
			function onMq() {
				mobile = mq.matches;
				updateToggle(document.querySelector(SETTINGS_PANEL));
			}
			if (typeof mq.addEventListener === "function") mq.addEventListener("change", onMq);
			else if (typeof mq.addListener === "function") mq.addListener(onMq);

			return function dispose() {
				disposed = true;
				headObserver.disconnect();
				bodyObserver.disconnect();
				wardenTimers.forEach(clearTimeout);
				if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", onMq);
				else if (typeof mq.removeListener === "function") mq.removeListener(onMq);
				updateToggle(null);
				if (expandBtn.parentNode !== null) expandBtn.parentNode.removeChild(expandBtn);
				if (styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag);
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
