import {
	App,
	Plugin,
	PluginSettingTab,
	SettingDefinitionItem,
	setIcon,
	setTooltip,
} from "obsidian";

const PDF_DARK_CLASS = "pdf-dark-mode";
const SELECTORS = [
	".pdfViewer",
	".pdf-sidebar-container img.thumbnailImage",
] as const;

/** CSS custom properties used by styles.css */
const CSS_VAR_INVERT = "--pdf-tdm-invert";
const CSS_VAR_HUE = "--pdf-tdm-hue";

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
	 * How strongly light PDF pages turn dark (CSS invert amount).
	 * 0 = no change, 1 = full conversion. Default 1.
	 */
	conversionAmount: number;
	/**
	 * Color correction after darkening (CSS hue-rotate degrees).
	 * 0–360. Default 180 restores natural-looking colors after a full invert.
	 */
	hueRotation: number;
	/**
	 * When true, PDF link annotation outlines (clickable regions) are shown.
	 * When false, their border/outline is suppressed.
	 */
	showLinkAnnotations: boolean;
}

const DEFAULT_SETTINGS: PdfDarkModeSettings = {
	isDark: false,
	conversionAmount: 1,
	hueRotation: 180,
	showLinkAnnotations: true,
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export default class PdfToggleDarkModePlugin extends Plugin {
	settings: PdfDarkModeSettings = { ...DEFAULT_SETTINGS };

	private statusBarEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private observer: MutationObserver | null = null;
	private applyTimer: number | null = null;
	private saveTimer: number | null = null;
	/** Prior inline values for annotation nodes we overrode with setCssProps. */
	private outlineStyleBackup = new WeakMap<HTMLElement, OutlineStyleBackup>();
	/** Live toolbar control roots we mounted (for sync + cleanup). */
	private toolbarRoots = new Set<HTMLElement>();

	async onload() {
		await this.loadSettings();

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

		// Catch late-mounted PDF.js nodes (thumbnails, pages, toolbars)
		this.observer = new MutationObserver((mutations) => {
			if (this.mutationsMayAffectPdf(mutations)) {
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
		this.setClassOnTargets(false);
		this.clearAppearanceVars();
		this.clearLinkAnnotationStyle();
		this.removeAllToolbarControls();
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
			if (
				node.matches?.(
					".pdfViewer, .pdf-sidebar-container, .thumbnailImage, .pdf-container, .workspace-leaf, .annotationLayer, .linkAnnotation, .pdf-toolbar"
				) ||
				node.querySelector?.(
					".pdfViewer, .pdf-sidebar-container img.thumbnailImage, .thumbnailImage, .annotationLayer, .linkAnnotation, .pdf-toolbar"
				)
			) {
				return true;
			}
		}
		return false;
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
		await this.saveSettings();
		this.updateUi();
		this.applyModeToDom();
		this.syncAllToolbarControls();
	}

	/** Push user-facing darkness / color settings into CSS variables. */
	applyAppearanceVars() {
		const invert = clamp(this.settings.conversionAmount, 0, 1);
		const hue = clamp(this.settings.hueRotation, 0, 360);
		// Prefer Obsidian helpers over element.style.* (review: no-static-styles-assignment)
		document.body.setCssProps({
			[CSS_VAR_INVERT]: String(invert),
			[CSS_VAR_HUE]: `${hue}deg`,
		});
	}

	private clearAppearanceVars() {
		// Clearing custom props: set empty so themes/snippets can take over again
		document.body.setCssProps({
			[CSS_VAR_INVERT]: "",
			[CSS_VAR_HUE]: "",
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
			title: "Darkness — how strongly light pages turn dark",
			min: 0,
			max: 100,
			getValue: () => Math.round(this.settings.conversionAmount * 100),
			setValue: (percent) => {
				this.settings.conversionAmount = clamp(percent / 100, 0, 1);
			},
		});

		this.createToolbarSlider(sliders, {
			key: "color",
			label: "Color",
			ariaLabel: "Color correction",
			title: "Color correction — drag until charts/photos look natural",
			min: 0,
			max: 100,
			getValue: () =>
				Math.round((this.settings.hueRotation / 360) * 100),
			setValue: (percent) => {
				this.settings.hueRotation = clamp((percent / 100) * 360, 0, 360);
			},
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
			getValue: () => number;
			setValue: (percent: number) => void;
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
				step: "1",
				"aria-label": opts.ariaLabel,
			},
		});
		input.value = String(opts.getValue());
		setTooltip(input, opts.title);

		const valueEl = group.createSpan({
			cls: "pdf-tdm-slider-value",
			text: `${opts.getValue()}%`,
		});

		const onInput = () => {
			const percent = clamp(
				Math.round(Number(input.value)),
				opts.min,
				opts.max
			);
			opts.setValue(percent);
			valueEl.setText(`${percent}%`);
			this.applyAppearanceVars();
			if (this.settings.isDark) {
				this.setClassOnTargets(true);
			}
			// Keep other open PDF toolbars in sync (live)
			this.syncAllToolbarControls(input);
			this.scheduleSaveSettings();
		};

		this.registerDomEvent(input, "input", onInput);
		this.registerDomEvent(input, "change", onInput);
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
		const darknessPct = Math.round(this.settings.conversionAmount * 100);
		const colorPct = Math.round((this.settings.hueRotation / 360) * 100);
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

	private updateUi() {
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
		return this.settings.isDark
			? "PDF appearance: Dark (click for Light)"
			: "PDF appearance: Light (click for Dark)";
	}

	async loadSettings() {
		const raw = (await this.loadData()) as Partial<PdfDarkModeSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
		this.settings.conversionAmount = clamp(
			Number(this.settings.conversionAmount),
			0,
			1
		);
		if (Number.isNaN(this.settings.conversionAmount)) {
			this.settings.conversionAmount = DEFAULT_SETTINGS.conversionAmount;
		}
		this.settings.hueRotation = clamp(
			Number(this.settings.hueRotation),
			0,
			360
		);
		if (Number.isNaN(this.settings.hueRotation)) {
			this.settings.hueRotation = DEFAULT_SETTINGS.hueRotation;
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Called from the settings tab after a control changes. */
	async onAppearanceSettingChange() {
		await this.saveSettings();
		this.applyAppearanceVars();
		this.applyLinkAnnotationStyle();
		// Dark-mode class + vars for open PDFs; always refresh outlines above
		if (this.settings.isDark) {
			this.setClassOnTargets(true);
		}
		this.syncAllToolbarControls();
	}
}

/**
 * Declarative settings (Obsidian 1.13+).
 *
 * UI sliders use friendly 0–100% values; storage stays as
 * conversionAmount (0–1) and hueRotation (0–360°) for CSS.
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
						name: "Darkness",
						desc: "How strongly light PDF pages turn dark. 100% is a full dark look; lower values keep pages lighter.",
						aliases: ["conversion amount", "invert", "dark mode strength"],
						control: {
							type: "slider",
							key: "darknessPercent",
							min: 0,
							max: 100,
							step: 1,
							defaultValue: 100,
							displayFormat: (value) => this.darknessLabel(value),
						},
					},
					{
						name: "Color correction",
						desc: "After darkening, colors (charts, photos, highlights) can look off. Drag until they look natural. 50% works well for most PDFs.",
						aliases: ["hue", "color balance", "color tone"],
						control: {
							type: "slider",
							key: "colorCorrectionPercent",
							min: 0,
							max: 100,
							step: 1,
							defaultValue: 50,
							displayFormat: (value) => this.colorLabel(value),
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
						desc: "Restore Darkness, Color correction, and Show link outlines to the recommended defaults.",
						action: () => {
							this.plugin.settings.conversionAmount =
								DEFAULT_SETTINGS.conversionAmount;
							this.plugin.settings.hueRotation =
								DEFAULT_SETTINGS.hueRotation;
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
			return Math.round(this.plugin.settings.conversionAmount * 100);
		}
		if (key === "colorCorrectionPercent") {
			return Math.round((this.plugin.settings.hueRotation / 360) * 100);
		}
		return super.getControlValue(key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "darknessPercent") {
			this.plugin.settings.conversionAmount = clamp(
				Number(value) / 100,
				0,
				1
			);
			await this.plugin.onAppearanceSettingChange();
			return;
		}
		if (key === "colorCorrectionPercent") {
			this.plugin.settings.hueRotation = clamp(
				(Number(value) / 100) * 360,
				0,
				360
			);
			await this.plugin.onAppearanceSettingChange();
			return;
		}
		await super.setControlValue(key, value);
		await this.plugin.onAppearanceSettingChange();
	}

	private darknessLabel(percent: number): string {
		if (percent === 0) return "0% — off";
		if (percent === 100) return "100% — full dark";
		return `${percent}%`;
	}

	private colorLabel(percent: number): string {
		if (percent === 50) return "50% — recommended";
		if (percent === 0) return "0% — no correction";
		if (percent === 100) return "100%";
		return `${percent}%`;
	}
}
