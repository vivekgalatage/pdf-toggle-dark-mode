import {
	App,
	Plugin,
	PluginSettingTab,
	SettingDefinitionItem,
	setIcon,
	setTooltip,
} from "obsidian";

const PDF_DARK_CLASS = "pdf-dark-mode";
/**
 * Targets that receive the dark-mode class (and styles.css filter).
 * - .pdfViewer: full PDF leaf + native note embeds (![[file.pdf]])
 * - thumbnail images: sidebar thumbnails
 * - .pdf-cropped-embed: PDF++ rectangular clippings
 *   (![[file.pdf#page=N&rect=...]]) — rendered as <img> inside this container
 *
 * Lightbox images are handled separately in {@link setClassOnLightboxPdfImgs}:
 * Obsidian’s media lightbox is shared for all images; we only invert imgs
 * whose src matches a PDF++ cropped embed (never generic photo lightboxes).
 */
const SELECTORS = [
	".pdfViewer",
	".pdf-sidebar-container img.thumbnailImage",
	".pdf-cropped-embed",
] as const;

/** Image inside Obsidian’s media lightbox content area. */
const LIGHTBOX_IMG_SELECTOR =
	".lightbox .media-wrapper img, .lightbox .lightbox-media img";

/**
 * Body class set on pointerdown of a dark-mode PDF++ crop, before the
 * lightbox mounts. Hides the raw lightbox img until we swap in a
 * pre-baked inverted src (or CSS-filter fallback) — avoids a light flash
 * without running CSS filter during the zoom animation.
 */
const EXPECT_PDF_LIGHTBOX_CLASS = "pdf-tdm-expect-pdf-lightbox";

/** Safety clear if the lightbox never opens after a crop click. */
const EXPECT_PDF_LIGHTBOX_TIMEOUT_MS = 1000;

/** Marks a lightbox img whose pixels were inverted via canvas (no CSS filter). */
const BAKED_ATTR = "data-pdf-tdm-baked";
/** Original (pre-bake) src so we can restore on light mode / close. */
const ORIGINAL_SRC_ATTR = "data-pdf-tdm-original-src";

/** CSS custom properties used by styles.css */
const CSS_VAR_INVERT = "--pdf-tdm-invert";
const CSS_VAR_HUE = "--pdf-tdm-hue";
const CSS_VAR_BRIGHTNESS = "--pdf-tdm-brightness";

/**
 * CSS filter brightness() multiplier bounds.
 * Below ~20% is too dark after invert; >2 blows out to white.
 * UI exposes 20–200% (stored as 0.2–2).
 */
const BRIGHTNESS_MIN = 0.2;
const BRIGHTNESS_MAX = 2;
const BRIGHTNESS_UI_MIN = 20;
const BRIGHTNESS_UI_MAX = 200;

/** All appearance percent sliders (darkness, color, brightness) use 5% steps. */
const SLIDER_STEP = 5;

/**
 * Mounted into Obsidian’s native PDF toolbar (same place PDF++ puts its
 * color palette). Structure mirrors PDF++: spacer + control group on
 * toolbarLeftEl (first child of .pdf-toolbar).
 */
const TOOLBAR_ROOT_CLS = "pdf-tdm-toolbar";
const TOOLBAR_SPACER_CLS = "pdf-toolbar-spacer pdf-tdm-spacer";
/** Main PDF toolbars only — not the find bar (also has .pdf-toolbar). */
const PDF_TOOLBAR_SELECTOR = ".pdf-toolbar:not(.pdf-findbar)";

/**
 * Body class toggled when link annotation outlines should be hidden.
 * styles.css provides a non-inline fallback; per-node overrides use setCssProps
 * (allowed) so we beat PDF.js inline borders on Linux without injecting <style>
 * and without element.style / setProperty (review rules).
 */
const HIDE_LINK_ANNOTATIONS_CLASS = "pdf-tdm-hide-link-annotations";
const LINK_OUTLINE_MARK = "data-pdf-tdm-outline-managed";

/** PDF.js / Obsidian link annotation hit targets. */
const LINK_ANNOTATION_SELECTORS = [
	".pdfViewer .annotationLayer section",
	".pdfViewer .annotationLayer section.linkAnnotation",
	".pdfViewer .annotationLayer .linkAnnotation > a",
	".pdfViewer .annotationLayer a",
] as const;

/** Inline props we set via setCssProps while outlines are hidden. */
const HIDE_OUTLINE_PROPS: Record<string, string> = {
	"border-width": "0",
	"border-style": "none",
	"border-color": "transparent",
	"outline-width": "0",
	"outline-style": "none",
	"outline-color": "transparent",
	"box-shadow": "none",
};

const HIDE_OUTLINE_PROP_KEYS = Object.keys(HIDE_OUTLINE_PROPS);

type OutlineStyleBackup = Record<string, string>;

interface PdfDarkModeSettings {
	isDark: boolean;
	/**
	 * When true, PDF dark/light mode follows Obsidian’s theme (and system
	 * appearance when Obsidian is set to adapt to system).
	 */
	adaptToTheme: boolean;
	/**
	 * How strongly light PDF pages turn dark (CSS invert amount).
	 * 0 = no change, 1 = full conversion. Default 0.9 (90%).
	 */
	conversionAmount: number;
	/**
	 * Color correction after darkening (CSS hue-rotate degrees).
	 * 0–360. Default 180 restores natural-looking colors after a full invert.
	 */
	hueRotation: number;
	/**
	 * CSS filter brightness() multiplier after invert/hue.
	 * Clamped to {@link BRIGHTNESS_MIN}–{@link BRIGHTNESS_MAX} (20%–200%).
	 * Default 1 (100% — unchanged brightness).
	 */
	brightness: number;
	/**
	 * When true, PDF link annotation outlines (clickable regions) are shown.
	 * When false, their border/outline is suppressed.
	 */
	showLinkAnnotations: boolean;
}

const DEFAULT_SETTINGS: PdfDarkModeSettings = {
	isDark: false,
	adaptToTheme: false,
	conversionAmount: 0.9,
	hueRotation: 180,
	brightness: 1,
	showLinkAnnotations: true,
};

/** Friendly defaults for labels / reset tooltips (match DEFAULT_SETTINGS). */
const DEFAULT_DARKNESS_PERCENT = 90;
const DEFAULT_COLOR_PERCENT = 50;
const DEFAULT_BRIGHTNESS_PERCENT = 100;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Round a percent UI value to the nearest {@link SLIDER_STEP}, then clamp.
 * Keeps darkness / color / brightness controls on a 5% grid.
 */
function snapPercent(
	value: number,
	min: number,
	max: number,
	step: number = SLIDER_STEP
): number {
	if (Number.isNaN(value)) {
		return min;
	}
	const clamped = clamp(value, min, max);
	const snapped = Math.round(clamped / step) * step;
	return clamp(snapped, min, max);
}

/** Clamp + coerce brightness; floor 20% (too dark below), cap 200%. */
function clampBrightness(value: number): number {
	if (Number.isNaN(value)) {
		return DEFAULT_SETTINGS.brightness;
	}
	return clamp(value, BRIGHTNESS_MIN, BRIGHTNESS_MAX);
}

function brightnessToPercent(brightness: number): number {
	return snapPercent(
		Math.round(clampBrightness(brightness) * 100),
		BRIGHTNESS_UI_MIN,
		BRIGHTNESS_UI_MAX
	);
}

function percentToBrightness(percent: number): number {
	return clampBrightness(
		snapPercent(percent, BRIGHTNESS_UI_MIN, BRIGHTNESS_UI_MAX) / 100
	);
}

function darknessToPercent(conversionAmount: number): number {
	return snapPercent(Math.round(conversionAmount * 100), 0, 100);
}

function percentToDarkness(percent: number): number {
	return snapPercent(percent, 0, 100) / 100;
}

function colorToPercent(hueRotation: number): number {
	return snapPercent(Math.round((hueRotation / 360) * 100), 0, 100);
}

function percentToColor(percent: number): number {
	return (snapPercent(percent, 0, 100) / 100) * 360;
}

export default class PdfToggleDarkModePlugin extends Plugin {
	settings: PdfDarkModeSettings = { ...DEFAULT_SETTINGS };

	private statusBarEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private observer: MutationObserver | null = null;
	private applyTimer: number | null = null;
	private saveTimer: number | null = null;
	private themeSyncTimer: number | null = null;
	/** Clears {@link EXPECT_PDF_LIGHTBOX_CLASS} if lightbox never mounts. */
	private expectLightboxTimer: number | null = null;
	/**
	 * Crop img src from the last dark-mode PDF++ crop pointerdown.
	 * Used to match the lightbox without rescanning every embed on each mutation.
	 */
	private pendingCropSrc: string | null = null;
	/**
	 * Canvas-baked inverted data URL for {@link pendingCropSrc}.
	 * Lightbox animates these pixels without a live CSS filter (smooth zoom).
	 */
	private pendingBakedSrc: string | null = null;
	/**
	 * Cache: `${src}|invert|hue|brightness` → baked data URL.
	 * Invalidated when appearance settings change.
	 */
	private bakeCache = new Map<string, string>();
	/** Prior inline values for annotation nodes we overrode with setCssProps. */
	private outlineStyleBackup = new WeakMap<HTMLElement, OutlineStyleBackup>();
	/** Live toolbar control roots we mounted (for sync + cleanup). */
	private toolbarRoots = new Set<HTMLElement>();

	async onload() {
		await this.loadSettings();

		// Match Obsidian theme before first paint of PDF controls when enabled
		if (this.settings.adaptToTheme) {
			this.settings.isDark = this.isAppThemeDark();
		}

		this.ribbonEl = this.addRibbonIcon(
			this.iconName(),
			this.ribbonTooltip(),
			() => {
				void this.toggleMode();
			}
		);
		this.ribbonEl.addClass("pdf-toggle-dark-mode-ribbon");

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("mod-clickable", "pdf-toggle-dark-mode-status");
		this.statusBarEl.setAttr("role", "button");
		this.statusBarEl.setAttr("tabindex", "0");
		this.registerDomEvent(this.statusBarEl, "click", () => {
			void this.toggleMode();
		});
		this.registerDomEvent(this.statusBarEl, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				void this.toggleMode();
			}
		});

		this.addCommand({
			id: "toggle-pdf-dark-mode",
			name: "Toggle PDF dark/light mode",
			callback: () => {
				void this.toggleMode();
			},
		});

		this.addSettingTab(new PdfDarkModeSettingTab(this.app, this));

		this.updateUi();
		this.applyAppearanceVars();
		this.applyLinkAnnotationStyle();
		this.applyModeToDom();
		this.injectToolbarControls();

		// Re-apply when layout / leaves change (new PDF opens)
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.scheduleApply())
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.scheduleApply())
		);

		// Obsidian theme / base color scheme changes (incl. “adapt to system”)
		this.registerEvent(
			this.app.workspace.on("css-change", () => this.scheduleThemeSync())
		);

		// System appearance: fires when OS light/dark flips (Obsidian may lag a tick)
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onSystemScheme = () => this.scheduleThemeSync();
		media.addEventListener("change", onSystemScheme);
		this.register(() => media.removeEventListener("change", onSystemScheme));

		// Before lightbox mounts: mark body so CSS can invert on first paint
		this.registerDomEvent(
			document,
			"pointerdown",
			(e: PointerEvent) => {
				this.onPossiblePdfCropLightboxGesture(e);
			},
			{ capture: true }
		);

		// Catch late-mounted PDF.js nodes (thumbnails, pages, toolbars)
		// and lightbox open/close (immediate path — no debounce flash).
		// Lightbox is handled alone so we do not schedule a full PDF rescan
		// (toolbar inject + querySelectorAll) on every lightbox DOM tick.
		this.observer = new MutationObserver((mutations) => {
			if (this.mutationsIncludeLightbox(mutations)) {
				this.applyLightboxDarkModeImmediate();
			} else if (this.mutationsMayAffectPdf(mutations)) {
				this.scheduleApply();
			}
		});
		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
		});
		this.register(() => {
			this.observer?.disconnect();
			this.observer = null;
			if (this.applyTimer !== null) {
				window.clearTimeout(this.applyTimer);
				this.applyTimer = null;
			}
			if (this.saveTimer !== null) {
				window.clearTimeout(this.saveTimer);
				this.saveTimer = null;
			}
			if (this.themeSyncTimer !== null) {
				window.clearTimeout(this.themeSyncTimer);
				this.themeSyncTimer = null;
			}
			this.clearExpectPdfLightbox();
			this.clearBakeState();
			this.clearAppearanceVars();
			this.clearLinkAnnotationStyle();
			this.removeAllToolbarControls();
		});
	}

	onunload() {
		this.observer?.disconnect();
		this.observer = null;
		if (this.applyTimer !== null) {
			window.clearTimeout(this.applyTimer);
			this.applyTimer = null;
		}
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.themeSyncTimer !== null) {
			window.clearTimeout(this.themeSyncTimer);
			this.themeSyncTimer = null;
		}
		this.clearExpectPdfLightbox();
		this.clearBakeState();
		this.setClassOnTargets(false);
		this.clearAppearanceVars();
		this.clearLinkAnnotationStyle();
		this.removeAllToolbarControls();
	}

	/** Whether Obsidian’s current UI theme is dark (`theme-dark` on body). */
	isAppThemeDark(): boolean {
		return document.body.classList.contains("theme-dark");
	}

	/**
	 * Debounce theme-driven mode sync so css-change + system media query
	 * can settle after Obsidian applies `theme-dark` / `theme-light`.
	 */
	private scheduleThemeSync() {
		if (!this.settings.adaptToTheme) {
			return;
		}
		if (this.themeSyncTimer !== null) {
			window.clearTimeout(this.themeSyncTimer);
		}
		this.themeSyncTimer = window.setTimeout(() => {
			this.themeSyncTimer = null;
			void this.syncModeFromTheme();
		}, 50);
	}

	/**
	 * When Adapt to theme is on, set PDF dark/light from Obsidian’s theme.
	 * No-op when the setting is off.
	 */
	async syncModeFromTheme() {
		if (!this.settings.adaptToTheme) {
			return;
		}
		const isDark = this.isAppThemeDark();
		if (this.settings.isDark === isDark) {
			// Still refresh DOM in case targets mounted while theme was settling
			this.applyModeToDom();
			this.syncAllToolbarControls();
			return;
		}
		this.settings.isDark = isDark;
		await this.saveSettings();
		this.updateUi();
		this.applyModeToDom();
		this.syncAllToolbarControls();
	}

	/**
	 * Only rescan when added/removed nodes might include PDF viewer pieces.
	 * Avoids applying on every trivial DOM change in the vault UI.
	 */
	private mutationsMayAffectPdf(mutations: MutationRecord[]): boolean {
		for (const mutation of mutations) {
			if (this.nodesMayIncludePdf(mutation.addedNodes)) {
				return true;
			}
			if (this.nodesMayIncludePdf(mutation.removedNodes)) {
				return true;
			}
		}
		return false;
	}

	private nodesMayIncludePdf(nodes: NodeList): boolean {
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			// Cross-window safe (pop-out windows); avoid raw `instanceof`
			if (!node.instanceOf(HTMLElement)) {
				continue;
			}
			// Note: .lightbox is intentionally excluded — handled by
			// mutationsIncludeLightbox → applyLightboxDarkModeImmediate only.
			if (
				node.matches?.(
					".pdfViewer, .pdf-sidebar-container, .thumbnailImage, .pdf-container, .workspace-leaf, .annotationLayer, .linkAnnotation, .pdf-toolbar, .pdf-cropped-embed, .internal-embed"
				) ||
				node.querySelector?.(
					".pdfViewer, .pdf-sidebar-container img.thumbnailImage, .thumbnailImage, .annotationLayer, .linkAnnotation, .pdf-toolbar, .pdf-cropped-embed"
				)
			) {
				return true;
			}
		}
		return false;
	}

	/** True when a mutation batch adds/removes lightbox UI. */
	private mutationsIncludeLightbox(mutations: MutationRecord[]): boolean {
		for (const mutation of mutations) {
			if (
				this.nodesMatchLightbox(mutation.addedNodes) ||
				this.nodesMatchLightbox(mutation.removedNodes)
			) {
				return true;
			}
		}
		return false;
	}

	private nodesMatchLightbox(nodes: NodeList): boolean {
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			if (!node.instanceOf(HTMLElement)) {
				continue;
			}
			if (
				node.matches?.(".lightbox, .lightbox-media, .media-wrapper") ||
				node.querySelector?.(
					".lightbox, .lightbox-media, .media-wrapper"
				) ||
				// Img may be inserted alone under an existing lightbox shell
				(node.instanceOf(HTMLImageElement) &&
					Boolean(node.closest?.(".lightbox")))
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * pointerdown on a PDF++ crop while dark mode is on → expect a lightbox.
	 * Pre-bake inverted pixels from the already-loaded crop img so the popup
	 * can animate without a live CSS filter (filter+transform is janky).
	 */
	private onPossiblePdfCropLightboxGesture(e: PointerEvent) {
		if (!this.settings.isDark) {
			return;
		}
		// e.target is EventTarget; Node.instanceOf is the cross-window check
		const target = e.target as Node | null;
		if (!target || !target.instanceOf(HTMLElement)) {
			return;
		}
		const crop = target.closest(".pdf-cropped-embed");
		if (!crop) {
			return;
		}
		const cropImg = crop.querySelector("img");
		if (!cropImg || !cropImg.instanceOf(HTMLImageElement)) {
			return;
		}
		const src = cropImg.getAttribute("src");
		if (!src) {
			return;
		}
		this.pendingCropSrc = src;
		this.pendingBakedSrc = this.getBakedInvertedSrc(cropImg, src);
		this.beginExpectPdfLightbox();
	}

	private beginExpectPdfLightbox() {
		document.body.classList.add(EXPECT_PDF_LIGHTBOX_CLASS);
		if (this.expectLightboxTimer !== null) {
			window.clearTimeout(this.expectLightboxTimer);
		}
		this.expectLightboxTimer = window.setTimeout(() => {
			this.expectLightboxTimer = null;
			this.clearExpectPdfLightbox();
			this.pendingCropSrc = null;
			this.pendingBakedSrc = null;
		}, EXPECT_PDF_LIGHTBOX_TIMEOUT_MS);
	}

	private clearExpectPdfLightbox() {
		document.body.classList.remove(EXPECT_PDF_LIGHTBOX_CLASS);
		if (this.expectLightboxTimer !== null) {
			window.clearTimeout(this.expectLightboxTimer);
			this.expectLightboxTimer = null;
		}
	}

	private clearBakeState() {
		this.pendingCropSrc = null;
		this.pendingBakedSrc = null;
		this.bakeCache.clear();
	}

	/** Drop cached bakes when invert/hue/brightness change. */
	private invalidateBakeCache() {
		this.bakeCache.clear();
		this.pendingBakedSrc = null;
	}

	/**
	 * Sync lightbox invert immediately (no scheduleApply debounce).
	 * Prefers canvas-baked src (smooth); CSS filter is fallback only.
	 */
	private applyLightboxDarkModeImmediate() {
		this.setClassOnLightboxPdfImgs(this.settings.isDark);

		const lightboxOpen = Boolean(document.querySelector(".lightbox"));
		if (!lightboxOpen) {
			// Closed — drop expect / pending so photo lightboxes stay clean
			this.clearExpectPdfLightbox();
			this.pendingCropSrc = null;
			this.pendingBakedSrc = null;
			return;
		}

		// Keep expect (raw img hidden) until the media img is ready.
		const lbImg = document.querySelector(LIGHTBOX_IMG_SELECTOR);
		if (!this.settings.isDark) {
			this.clearExpectPdfLightbox();
			return;
		}
		if (
			lbImg &&
			lbImg.instanceOf(HTMLElement) &&
			(lbImg.hasAttribute(BAKED_ATTR) ||
				lbImg.classList.contains(PDF_DARK_CLASS))
		) {
			this.clearExpectPdfLightbox();
		}
	}

	/** Debounce DOM scans triggered by layout/mutation noise. */
	private scheduleApply() {
		if (this.applyTimer !== null) {
			window.clearTimeout(this.applyTimer);
		}
		this.applyTimer = window.setTimeout(() => {
			this.applyTimer = null;
			this.applyModeToDom();
			this.injectToolbarControls();
		}, 50);
	}

	async toggleMode() {
		this.settings.isDark = !this.settings.isDark;
		// Manual choice is sticky until the next theme change when adapt is on
		await this.saveSettings();
		this.updateUi();
		this.applyModeToDom();
		this.syncAllToolbarControls();
	}

	/** Push user-facing darkness / color / brightness settings into CSS variables. */
	applyAppearanceVars() {
		const invert = clamp(this.settings.conversionAmount, 0, 1);
		const hue = clamp(this.settings.hueRotation, 0, 360);
		const brightness = clampBrightness(this.settings.brightness);
		// Prefer Obsidian helpers over element.style.* (review: no-static-styles-assignment)
		document.body.setCssProps({
			[CSS_VAR_INVERT]: String(invert),
			[CSS_VAR_HUE]: `${hue}deg`,
			[CSS_VAR_BRIGHTNESS]: String(brightness),
		});
	}

	private clearAppearanceVars() {
		// Clearing custom props: set empty so themes/snippets can take over again
		document.body.setCssProps({
			[CSS_VAR_INVERT]: "",
			[CSS_VAR_HUE]: "",
			[CSS_VAR_BRIGHTNESS]: "",
		});
	}

	/**
	 * Show/hide PDF link annotation outlines.
	 *
	 * 1) Body class + styles.css (themes / cascade).
	 * 2) setCssProps on annotation nodes so PDF.js inline borders (common on
	 *    Linux) are overridden — with a backup so re-enabling restores them.
	 *
	 * Avoids: injected <style>, element.style.setProperty, styles.css priority hacks.
	 */
	applyLinkAnnotationStyle() {
		const hide = !this.settings.showLinkAnnotations;
		document.body.classList.toggle(HIDE_LINK_ANNOTATIONS_CLASS, hide);

		if (hide) {
			this.hideLinkAnnotationOutlines();
		} else {
			this.restoreLinkAnnotationOutlines();
		}
	}

	private clearLinkAnnotationStyle() {
		document.body.classList.remove(HIDE_LINK_ANNOTATIONS_CLASS);
		this.restoreLinkAnnotationOutlines();
	}

	private hideLinkAnnotationOutlines() {
		for (const selector of LINK_ANNOTATION_SELECTORS) {
			document.querySelectorAll(selector).forEach((node) => {
				if (!node.instanceOf(HTMLElement)) {
					return;
				}
				if (!node.hasAttribute(LINK_OUTLINE_MARK)) {
					const backup: OutlineStyleBackup = {};
					for (const prop of HIDE_OUTLINE_PROP_KEYS) {
						// Read-only: capture existing inline values before we override
						backup[prop] = node.style.getPropertyValue(prop);
					}
					this.outlineStyleBackup.set(node, backup);
					node.setAttribute(LINK_OUTLINE_MARK, "1");
				}
				node.setCssProps(HIDE_OUTLINE_PROPS);
			});
		}
	}

	private restoreLinkAnnotationOutlines() {
		document.querySelectorAll(`[${LINK_OUTLINE_MARK}]`).forEach((node) => {
			if (!node.instanceOf(HTMLElement)) {
				return;
			}
			const backup = this.outlineStyleBackup.get(node);
			if (backup) {
				node.setCssProps(backup);
				this.outlineStyleBackup.delete(node);
			} else {
				const clear: OutlineStyleBackup = {};
				for (const prop of HIDE_OUTLINE_PROP_KEYS) {
					clear[prop] = "";
				}
				node.setCssProps(clear);
			}
			node.removeAttribute(LINK_OUTLINE_MARK);
		});
	}

	private applyModeToDom() {
		this.applyAppearanceVars();
		this.applyLinkAnnotationStyle();
		this.setClassOnTargets(this.settings.isDark);
	}

	private setClassOnTargets(isDark: boolean) {
		for (const selector of SELECTORS) {
			document.querySelectorAll(selector).forEach((el) => {
				el.classList.toggle(PDF_DARK_CLASS, isDark);
			});
		}
		// Lightbox is generic media UI — invert only when the img is a PDF crop
		this.setClassOnLightboxPdfImgs(isDark);
	}

	/**
	 * Invert lightbox images that came from a PDF++ crop only.
	 *
	 * Preferred path: replace src with a canvas-baked inverted data URL
	 * (no CSS filter → zoom animation stays cheap). Fallback: .pdf-dark-mode
	 * CSS filter when bake is unavailable.
	 *
	 * Matching: pending crop src from pointerdown, else original-src attr,
	 * else scan open crop embeds (rare: toggle dark while lightbox already open).
	 */
	private setClassOnLightboxPdfImgs(isDark: boolean) {
		const lightboxImgs = document.querySelectorAll(LIGHTBOX_IMG_SELECTOR);
		if (lightboxImgs.length === 0) {
			return;
		}

		// Only build the embed-src set when we cannot match via pending click
		let cropSrcs: Set<string> | null = null;
		const srcIsPdfCrop = (originalSrc: string | null): boolean => {
			if (!originalSrc) {
				return false;
			}
			if (this.pendingCropSrc && originalSrc === this.pendingCropSrc) {
				return true;
			}
			if (!cropSrcs) {
				cropSrcs = this.collectPdfCropEmbedSrcs();
			}
			return cropSrcs.has(originalSrc);
		};

		lightboxImgs.forEach((node) => {
			if (!node.instanceOf(HTMLImageElement)) {
				return;
			}
			const currentSrc = node.getAttribute("src");
			const originalSrc =
				node.getAttribute(ORIGINAL_SRC_ATTR) || currentSrc;
			const fromPdfCrop = srcIsPdfCrop(originalSrc);

			if (!isDark || !fromPdfCrop) {
				this.restoreLightboxImgIfBaked(node);
				node.classList.remove(PDF_DARK_CLASS);
				return;
			}

			// Already baked: keep if cache still matches current appearance;
			// otherwise restore original pixels and re-bake below.
			if (node.hasAttribute(BAKED_ATTR) && originalSrc) {
				const expected = this.bakeCache.get(
					this.bakeCacheKey(originalSrc)
				);
				if (expected && node.getAttribute("src") === expected) {
					node.classList.remove(PDF_DARK_CLASS);
					return;
				}
				this.restoreLightboxImgIfBaked(node);
			}

			// Prefer pre-baked src from pointerdown (same original)
			let baked: string | null = null;
			if (
				this.pendingBakedSrc &&
				originalSrc &&
				originalSrc === this.pendingCropSrc
			) {
				baked = this.pendingBakedSrc;
			} else if (originalSrc) {
				baked =
					this.bakeCache.get(this.bakeCacheKey(originalSrc)) ?? null;
			}
			// Bake from the (restored) lightbox bitmap
			if (!baked) {
				baked = this.getBakedInvertedSrc(
					node,
					originalSrc || currentSrc || ""
				);
			}

			if (baked && originalSrc) {
				node.setAttribute(ORIGINAL_SRC_ATTR, originalSrc);
				node.setAttribute(BAKED_ATTR, "1");
				// Avoid re-setting the same src (decode / layout churn)
				if (node.getAttribute("src") !== baked) {
					node.setAttribute("src", baked);
				}
				node.classList.remove(PDF_DARK_CLASS);
				return;
			}

			// Fallback: live CSS filter (can jank during zoom; rare)
			node.classList.add(PDF_DARK_CLASS);
		});
	}

	private restoreLightboxImgIfBaked(img: HTMLImageElement) {
		const original = img.getAttribute(ORIGINAL_SRC_ATTR);
		if (!original) {
			img.removeAttribute(BAKED_ATTR);
			return;
		}
		if (img.getAttribute("src") !== original) {
			img.setAttribute("src", original);
		}
		img.removeAttribute(ORIGINAL_SRC_ATTR);
		img.removeAttribute(BAKED_ATTR);
	}

	/**
	 * Return a data URL with invert/hue/brightness baked in.
	 * Uses the in-memory crop/lightbox bitmap (already decoded) — one-shot cost
	 * on click, then the lightbox animates plain pixels.
	 */
	private getBakedInvertedSrc(
		source: HTMLImageElement,
		src: string
	): string | null {
		if (!src) {
			return null;
		}
		const key = this.bakeCacheKey(src);
		const cached = this.bakeCache.get(key);
		if (cached) {
			return cached;
		}
		const baked = this.bakeInvertedDataUrl(source);
		if (baked) {
			this.bakeCache.set(key, baked);
		}
		return baked;
	}

	private bakeCacheKey(src: string): string {
		const invert = clamp(this.settings.conversionAmount, 0, 1);
		const hue = clamp(this.settings.hueRotation, 0, 360);
		const brightness = clampBrightness(this.settings.brightness);
		// src is usually a data URL of the crop — unique per clip
		return `${invert}|${hue}|${brightness}|${src}`;
	}

	private bakeInvertedDataUrl(source: HTMLImageElement): string | null {
		try {
			const w = source.naturalWidth || source.width;
			const h = source.naturalHeight || source.height;
			if (!w || !h) {
				return null;
			}
			// Detached canvas (global createEl — no parent, not appended to DOM)
			const canvas = createEl("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				return null;
			}
			const invert = clamp(this.settings.conversionAmount, 0, 1);
			const hue = clamp(this.settings.hueRotation, 0, 360);
			const brightness = clampBrightness(this.settings.brightness);
			ctx.filter = `invert(${invert}) hue-rotate(${hue}deg) brightness(${brightness})`;
			ctx.drawImage(source, 0, 0, w, h);
			// PNG keeps sharp text from PDF crops; crop regions stay modest size
			return canvas.toDataURL("image/png");
		} catch {
			// Tainted canvas / detached image / etc.
			return null;
		}
	}

	/** Unique img src values currently rendered inside PDF++ crop embeds. */
	private collectPdfCropEmbedSrcs(): Set<string> {
		const srcs = new Set<string>();
		document
			.querySelectorAll(".pdf-cropped-embed img")
			.forEach((node) => {
				if (!node.instanceOf(HTMLImageElement)) {
					return;
				}
				const src = node.getAttribute("src");
				if (src) {
					srcs.add(src);
				}
			});
		return srcs;
	}

	/**
	 * Inject dark/light toggle + appearance sliders into each native PDF
	 * toolbar (PDF++-style: spacer + control group on the left section).
	 */
	injectToolbarControls() {
		// Drop references to nodes that were removed from the document
		for (const root of Array.from(this.toolbarRoots)) {
			if (!root.isConnected) {
				this.toolbarRoots.delete(root);
			}
		}

		document.querySelectorAll(PDF_TOOLBAR_SELECTOR).forEach((toolbar) => {
			// Cross-window safe (pop-out PDF windows)
			if (!toolbar.instanceOf(HTMLElement)) {
				return;
			}
			if (toolbar.querySelector(`.${TOOLBAR_ROOT_CLS}`)) {
				return;
			}
			// PDFToolbar.toolbarLeftEl is the first child (no dedicated class).
			const first = toolbar.firstElementChild;
			const left =
				first && first.instanceOf(HTMLElement) ? first : toolbar;
			this.mountToolbarControls(left);
		});

		this.syncAllToolbarControls();
	}

	private mountToolbarControls(parent: HTMLElement) {
		parent.createDiv({ cls: TOOLBAR_SPACER_CLS });
		const root = parent.createDiv({ cls: TOOLBAR_ROOT_CLS });
		this.toolbarRoots.add(root);

		// Toggle button (sun / moon) — same pattern as other PDF toolbar icons
		const toggleBtn = root.createDiv({
			cls: "clickable-icon pdf-tdm-toggle",
			attr: { role: "button", tabindex: "0" },
		});
		setIcon(toggleBtn, this.iconName());
		setTooltip(toggleBtn, this.ribbonTooltip());
		// Prefer registerDomEvent (auto-cleaned on unload) over addEventListener
		this.registerDomEvent(toggleBtn, "click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.toggleMode();
		});
		this.registerDomEvent(toggleBtn, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				void this.toggleMode();
			}
		});

		// Compact sliders (shown when dark mode is on)
		const sliders = root.createDiv({ cls: "pdf-tdm-sliders" });

		this.createToolbarSlider(sliders, {
			key: "darkness",
			label: "Dark",
			ariaLabel: "Darkness",
			title: "Darkness — how strongly light pages turn dark (5% steps)",
			min: 0,
			max: 100,
			defaultPercent: DEFAULT_DARKNESS_PERCENT,
			getValue: () => darknessToPercent(this.settings.conversionAmount),
			setValue: (percent) => {
				this.settings.conversionAmount = percentToDarkness(percent);
			},
			onReset: () => this.resetDarknessToDefault(),
		});

		this.createToolbarSlider(sliders, {
			key: "color",
			label: "Color",
			ariaLabel: "Color correction",
			title: "Color correction — drag until charts/photos look natural (5% steps)",
			min: 0,
			max: 100,
			defaultPercent: DEFAULT_COLOR_PERCENT,
			getValue: () => colorToPercent(this.settings.hueRotation),
			setValue: (percent) => {
				this.settings.hueRotation = percentToColor(percent);
			},
			onReset: () => this.resetColorToDefault(),
		});

		this.createToolbarSlider(sliders, {
			key: "brightness",
			label: "Bright",
			ariaLabel: "Brightness",
			title: "Brightness — 20% min, 200% max (5% steps)",
			min: BRIGHTNESS_UI_MIN,
			max: BRIGHTNESS_UI_MAX,
			defaultPercent: DEFAULT_BRIGHTNESS_PERCENT,
			getValue: () => brightnessToPercent(this.settings.brightness),
			setValue: (percent) => {
				this.settings.brightness = percentToBrightness(percent);
			},
			onReset: () => this.resetBrightnessToDefault(),
		});
	}

	private createToolbarSlider(
		parent: HTMLElement,
		opts: {
			key: string;
			label: string;
			ariaLabel: string;
			title: string;
			min: number;
			max: number;
			defaultPercent: number;
			getValue: () => number;
			setValue: (percent: number) => void;
			onReset: () => void | Promise<void>;
		}
	) {
		const group = parent.createDiv({
			cls: `pdf-tdm-slider-group pdf-tdm-slider-${opts.key}`,
		});
		group.createSpan({
			cls: "pdf-tdm-slider-label",
			text: opts.label,
		});

		const input = group.createEl("input", {
			cls: `slider pdf-tdm-slider pdf-tdm-slider-input-${opts.key}`,
			attr: {
				type: "range",
				min: String(opts.min),
				max: String(opts.max),
				step: String(SLIDER_STEP),
				"aria-label": opts.ariaLabel,
			},
		});
		input.value = String(opts.getValue());
		setTooltip(input, opts.title);

		const valueEl = group.createSpan({
			cls: "pdf-tdm-slider-value",
			text: `${opts.getValue()}%`,
		});

		const resetBtn = group.createDiv({
			cls: "clickable-icon pdf-tdm-slider-reset",
			attr: {
				role: "button",
				tabindex: "0",
				"aria-label": `Reset ${opts.ariaLabel} to ${opts.defaultPercent}%`,
			},
		});
		setIcon(resetBtn, "rotate-ccw");
		setTooltip(
			resetBtn,
			`Reset ${opts.ariaLabel} to default (${opts.defaultPercent}%)`
		);

		const applyPercent = (percent: number) => {
			const snapped = snapPercent(percent, opts.min, opts.max);
			input.value = String(snapped);
			opts.setValue(snapped);
			valueEl.setText(`${snapped}%`);
			// Slider changes invert/hue/brightness → drop stale baked lightboxes
			this.invalidateBakeCache();
			this.applyAppearanceVars();
			if (this.settings.isDark) {
				this.setClassOnTargets(true);
			}
			this.syncAllToolbarControls(input);
		};

		const onInput = () => {
			applyPercent(Math.round(Number(input.value)));
			this.scheduleSaveSettings();
		};

		const doReset = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			void opts.onReset();
		};

		this.registerDomEvent(input, "input", onInput);
		this.registerDomEvent(input, "change", onInput);
		this.registerDomEvent(resetBtn, "click", doReset);
		this.registerDomEvent(resetBtn, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				doReset(e);
			}
		});
	}

	/** Debounced persist so slider drags don’t thrash disk. */
	private scheduleSaveSettings() {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveSettings();
		}, 200);
	}

	/**
	 * Refresh icons, slider values, and visibility on every mounted toolbar.
	 * @param exceptInput while dragging, skip this input and skip icon/tooltip
	 *        rewrites (only mirror values to other open PDF toolbars)
	 */
	syncAllToolbarControls(exceptInput?: HTMLInputElement) {
		const isDark = this.settings.isDark;
		const darknessPct = darknessToPercent(this.settings.conversionAmount);
		const colorPct = colorToPercent(this.settings.hueRotation);
		const brightnessPct = brightnessToPercent(this.settings.brightness);
		const icon = this.iconName();
		const tooltip = this.ribbonTooltip();
		const fullChrome = !exceptInput;

		for (const root of this.toolbarRoots) {
			if (!root.isConnected) {
				continue;
			}

			if (fullChrome) {
				const toggleBtn =
					root.querySelector<HTMLElement>(".pdf-tdm-toggle");
				if (toggleBtn) {
					setIcon(toggleBtn, icon);
					setTooltip(toggleBtn, tooltip);
					toggleBtn.toggleClass("is-active", isDark);
				}

				const sliders =
					root.querySelector<HTMLElement>(".pdf-tdm-sliders");
				if (sliders) {
					sliders.toggleClass("is-visible", isDark);
					sliders.setAttr(
						"aria-hidden",
						isDark ? "false" : "true"
					);
				}
			}

			const darknessInput = root.querySelector<HTMLInputElement>(
				".pdf-tdm-slider-input-darkness"
			);
			const darknessVal = root.querySelector<HTMLElement>(
				".pdf-tdm-slider-darkness .pdf-tdm-slider-value"
			);
			if (darknessInput && darknessInput !== exceptInput) {
				darknessInput.value = String(darknessPct);
			}
			if (darknessVal) {
				darknessVal.setText(`${darknessPct}%`);
			}

			const colorInput = root.querySelector<HTMLInputElement>(
				".pdf-tdm-slider-input-color"
			);
			const colorVal = root.querySelector<HTMLElement>(
				".pdf-tdm-slider-color .pdf-tdm-slider-value"
			);
			if (colorInput && colorInput !== exceptInput) {
				colorInput.value = String(colorPct);
			}
			if (colorVal) {
				colorVal.setText(`${colorPct}%`);
			}

			const brightnessInput = root.querySelector<HTMLInputElement>(
				".pdf-tdm-slider-input-brightness"
			);
			const brightnessVal = root.querySelector<HTMLElement>(
				".pdf-tdm-slider-brightness .pdf-tdm-slider-value"
			);
			if (brightnessInput && brightnessInput !== exceptInput) {
				brightnessInput.value = String(brightnessPct);
			}
			if (brightnessVal) {
				brightnessVal.setText(`${brightnessPct}%`);
			}
		}
	}

	private removeAllToolbarControls() {
		for (const root of Array.from(this.toolbarRoots)) {
			const prev = root.previousElementSibling;
			if (
				prev &&
				prev.instanceOf(HTMLElement) &&
				prev.classList.contains("pdf-tdm-spacer")
			) {
				prev.remove();
			}
			root.remove();
		}
		this.toolbarRoots.clear();
		// Orphaned controls after hot-reload / partial cleanup
		document
			.querySelectorAll(`.${TOOLBAR_ROOT_CLS}, .pdf-tdm-spacer`)
			.forEach((el) => el.remove());
	}

	/** Refresh ribbon, status bar, and toolbar chrome for the current mode. */
	updateUi() {
		const label = this.modeLabel();
		const icon = this.iconName();
		const tooltip = this.ribbonTooltip();

		if (this.ribbonEl) {
			setIcon(this.ribbonEl, icon);
			this.ribbonEl.setAttr("aria-label", tooltip);
			this.ribbonEl.setAttr("title", tooltip);
		}

		if (this.statusBarEl) {
			this.statusBarEl.empty();
			const iconSpan = this.statusBarEl.createSpan({
				cls: "pdf-toggle-dark-mode-status-icon",
			});
			setIcon(iconSpan, icon);
			this.statusBarEl.createSpan({
				text: ` PDF: ${label}`,
				cls: "pdf-toggle-dark-mode-status-text",
			});
			this.statusBarEl.setAttr("aria-label", tooltip);
			this.statusBarEl.setAttr("title", tooltip);
		}

		this.syncAllToolbarControls();
	}

	private modeLabel(): string {
		return this.settings.isDark ? "Dark" : "Light";
	}

	/** Lucide icon names available in Obsidian */
	private iconName(): string {
		return this.settings.isDark ? "moon" : "sun";
	}

	private ribbonTooltip(): string {
		const adapt = this.settings.adaptToTheme
			? " · adapting to theme"
			: "";
		return this.settings.isDark
			? `PDF appearance: Dark (click for Light)${adapt}`
			: `PDF appearance: Light (click for Dark)${adapt}`;
	}

	async loadSettings() {
		const raw = (await this.loadData()) as Partial<PdfDarkModeSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
		// Snap to 5% grid (and clamp) so legacy 1% saves land on valid steps
		this.settings.conversionAmount = percentToDarkness(
			darknessToPercent(Number(this.settings.conversionAmount))
		);
		if (Number.isNaN(Number(raw?.conversionAmount))) {
			this.settings.conversionAmount = DEFAULT_SETTINGS.conversionAmount;
		}
		this.settings.hueRotation = percentToColor(
			colorToPercent(Number(this.settings.hueRotation))
		);
		if (Number.isNaN(Number(raw?.hueRotation))) {
			this.settings.hueRotation = DEFAULT_SETTINGS.hueRotation;
		}
		// Clamp hard: <20% too dark after invert; >200% blown-out white; 5% steps
		this.settings.brightness = percentToBrightness(
			brightnessToPercent(Number(this.settings.brightness))
		);
		// Upgrade: older data.json may omit brightness
		if (raw && typeof raw.brightness !== "number") {
			this.settings.brightness = DEFAULT_SETTINGS.brightness;
		}
		this.settings.showLinkAnnotations = Boolean(
			this.settings.showLinkAnnotations
		);
		// Upgrade: older data.json may omit this field → Object.assign already
		// applied DEFAULT_SETTINGS, but force a real boolean if missing.
		if (raw && typeof raw.showLinkAnnotations !== "boolean") {
			this.settings.showLinkAnnotations =
				DEFAULT_SETTINGS.showLinkAnnotations;
		}
		this.settings.adaptToTheme = Boolean(this.settings.adaptToTheme);
		if (raw && typeof raw.adaptToTheme !== "boolean") {
			this.settings.adaptToTheme = DEFAULT_SETTINGS.adaptToTheme;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Called from the settings tab after a control changes. */
	async onAppearanceSettingChange() {
		await this.saveSettings();
		// Appearance affects canvas-baked lightbox pixels
		this.invalidateBakeCache();
		this.applyAppearanceVars();
		this.applyLinkAnnotationStyle();
		// Dark-mode class + vars for open PDFs; always refresh outlines above
		if (this.settings.isDark) {
			this.setClassOnTargets(true);
		} else {
			// Restore any baked lightbox imgs when leaving dark appearance
			this.setClassOnLightboxPdfImgs(false);
		}
		this.syncAllToolbarControls();
	}

	/** Restore Darkness slider only. */
	async resetDarknessToDefault() {
		this.settings.conversionAmount = DEFAULT_SETTINGS.conversionAmount;
		await this.onAppearanceSettingChange();
	}

	/** Restore Color correction slider only. */
	async resetColorToDefault() {
		this.settings.hueRotation = DEFAULT_SETTINGS.hueRotation;
		await this.onAppearanceSettingChange();
	}

	/** Restore Brightness slider only. */
	async resetBrightnessToDefault() {
		this.settings.brightness = DEFAULT_SETTINGS.brightness;
		await this.onAppearanceSettingChange();
	}
}

/**
 * Declarative settings (Obsidian 1.13+).
 *
 * UI sliders use friendly percent values; storage stays as
 * conversionAmount (0–1), hueRotation (0–360°), and brightness (0.2–2) for CSS.
 */
class PdfDarkModeSettingTab extends PluginSettingTab {
	plugin: PdfToggleDarkModePlugin;

	constructor(app: App, plugin: PdfToggleDarkModePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "PDF appearance",
				items: [
					{
						name: "About",
						desc: "These options only affect how PDFs look when dark mode is on. They do not change the rest of Obsidian.",
					},
					{
						name: "Adapt to theme",
						desc: "When on, PDF dark/light mode follows Obsidian’s appearance. If Obsidian uses “Adapt to system”, system-wide light/dark changes are followed too. You can still toggle manually; the next theme change will re-sync.",
						aliases: [
							"follow theme",
							"system theme",
							"match theme",
							"auto dark",
							"adapt to system",
						],
						control: {
							type: "toggle",
							key: "adaptToTheme",
							defaultValue: false,
						},
					},
					{
						name: "Darkness",
						desc: "How strongly light PDF pages turn dark. 90% is the default; 100% is a full dark look; lower values keep pages lighter. Adjusts in 5% steps.",
						aliases: ["conversion amount", "invert", "dark mode strength"],
						control: {
							type: "slider",
							key: "darknessPercent",
							min: 0,
							max: 100,
							step: SLIDER_STEP,
							defaultValue: DEFAULT_DARKNESS_PERCENT,
							displayFormat: (value) => this.darknessLabel(value),
						},
					},
					{
						name: "Reset darkness",
						desc: `Restore Darkness to the default (${DEFAULT_DARKNESS_PERCENT}%).`,
						aliases: ["reset dark", "default darkness"],
						action: () => {
							void this.plugin.resetDarknessToDefault().then(() => {
								this.update();
							});
						},
					},
					{
						name: "Color correction",
						desc: "After darkening, colors (charts, photos, highlights) can look off. Drag until they look natural. 50% works well for most PDFs. Adjusts in 5% steps.",
						aliases: ["hue", "color balance", "color tone"],
						control: {
							type: "slider",
							key: "colorCorrectionPercent",
							min: 0,
							max: 100,
							step: SLIDER_STEP,
							defaultValue: DEFAULT_COLOR_PERCENT,
							displayFormat: (value) => this.colorLabel(value),
						},
					},
					{
						name: "Reset color correction",
						desc: `Restore Color correction to the default (${DEFAULT_COLOR_PERCENT}%).`,
						aliases: ["reset color", "default color", "reset hue"],
						action: () => {
							void this.plugin.resetColorToDefault().then(() => {
								this.update();
							});
						},
					},
					{
						name: "Brightness",
						desc: "Overall brightness after darkening (CSS brightness). Range is 20–200% in 5% steps (below 20% is too dark; above 200% washes out).",
						aliases: [
							"bright",
							"luminance",
							"light level",
							"filter brightness",
						],
						control: {
							type: "slider",
							key: "brightnessPercent",
							min: BRIGHTNESS_UI_MIN,
							max: BRIGHTNESS_UI_MAX,
							step: SLIDER_STEP,
							defaultValue: DEFAULT_BRIGHTNESS_PERCENT,
							displayFormat: (value) => this.brightnessLabel(value),
						},
					},
					{
						name: "Reset brightness",
						desc: `Restore Brightness to the default (${DEFAULT_BRIGHTNESS_PERCENT}%).`,
						aliases: ["reset bright", "default brightness"],
						action: () => {
							void this.plugin
								.resetBrightnessToDefault()
								.then(() => {
									this.update();
								});
						},
					},
					{
						name: "Show link outlines",
						desc: "Show the outline boxes around clickable links in PDFs. Turn off to hide those borders while keeping links clickable.",
						aliases: [
							"link annotations",
							"annotation layer",
							"link boxes",
							"link borders",
						],
						control: {
							type: "toggle",
							key: "showLinkAnnotations",
							defaultValue: true,
						},
					},
					{
						name: "Reset appearance",
						desc: "Restore Darkness, Color correction, Brightness, and Show link outlines to the recommended defaults.",
						action: () => {
							this.plugin.settings.conversionAmount =
								DEFAULT_SETTINGS.conversionAmount;
							this.plugin.settings.hueRotation =
								DEFAULT_SETTINGS.hueRotation;
							this.plugin.settings.brightness =
								DEFAULT_SETTINGS.brightness;
							this.plugin.settings.showLinkAnnotations =
								DEFAULT_SETTINGS.showLinkAnnotations;
							void this.plugin.onAppearanceSettingChange().then(() => {
								this.update();
							});
						},
					},
				],
			},
		];
	}

	/**
	 * Map friendly slider keys ↔ internal CSS-oriented settings.
	 */
	getControlValue(key: string): unknown {
		if (key === "darknessPercent") {
			return darknessToPercent(this.plugin.settings.conversionAmount);
		}
		if (key === "colorCorrectionPercent") {
			return colorToPercent(this.plugin.settings.hueRotation);
		}
		if (key === "brightnessPercent") {
			return brightnessToPercent(this.plugin.settings.brightness);
		}
		return super.getControlValue(key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "darknessPercent") {
			this.plugin.settings.conversionAmount = percentToDarkness(
				Number(value)
			);
			await this.plugin.onAppearanceSettingChange();
			return;
		}
		if (key === "colorCorrectionPercent") {
			this.plugin.settings.hueRotation = percentToColor(Number(value));
			await this.plugin.onAppearanceSettingChange();
			return;
		}
		if (key === "brightnessPercent") {
			this.plugin.settings.brightness = percentToBrightness(Number(value));
			await this.plugin.onAppearanceSettingChange();
			return;
		}
		if (key === "adaptToTheme") {
			this.plugin.settings.adaptToTheme = Boolean(value);
			await this.plugin.saveSettings();
			if (this.plugin.settings.adaptToTheme) {
				await this.plugin.syncModeFromTheme();
			}
			this.plugin.updateUi();
			return;
		}
		await super.setControlValue(key, value);
		await this.plugin.onAppearanceSettingChange();
	}

	private darknessLabel(percent: number): string {
		if (percent === 0) return "0% — off";
		if (percent === DEFAULT_DARKNESS_PERCENT) {
			return `${DEFAULT_DARKNESS_PERCENT}% — default`;
		}
		if (percent === 100) return "100% — full dark";
		return `${percent}%`;
	}

	private colorLabel(percent: number): string {
		if (percent === DEFAULT_COLOR_PERCENT) {
			return `${DEFAULT_COLOR_PERCENT}% — recommended`;
		}
		if (percent === 0) return "0% — no correction";
		if (percent === 100) return "100%";
		return `${percent}%`;
	}

	private brightnessLabel(percent: number): string {
		if (percent === DEFAULT_BRIGHTNESS_PERCENT) {
			return `${DEFAULT_BRIGHTNESS_PERCENT}% — default`;
		}
		if (percent <= BRIGHTNESS_UI_MIN) return "20% — minimum";
		if (percent >= BRIGHTNESS_UI_MAX) return "200% — maximum";
		return `${percent}%`;
	}
}
