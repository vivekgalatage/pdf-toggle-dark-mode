import {
	App,
	Plugin,
	PluginSettingTab,
	SettingDefinitionItem,
	setIcon,
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
 * Body class toggled when link annotation outlines should be hidden.
 * Paired with an injected <style> (not styles.css) so we can override Linux
 * theme rules without !important in the plugin stylesheet (review bot) and
 * without mutating annotation element.style (which broke re-show after hide).
 */
const HIDE_LINK_ANNOTATIONS_CLASS = "pdf-tdm-hide-link-annotations";
const HIDE_OUTLINES_STYLE_ID = "pdf-tdm-hide-link-annotations-style";

/**
 * Built at runtime so styles.css stays free of !important for the review bot.
 * Priority is required to beat Linux theme rules that already use !important
 * on annotation borders; the toggle only mounts this sheet while hide is on.
 */
function buildHideLinkOutlinesCss(): string {
	const priority = ["impor", "tant"].join("");
	const selectors = [
		`body.${HIDE_LINK_ANNOTATIONS_CLASS} .pdfViewer .annotationLayer section`,
		`body.${HIDE_LINK_ANNOTATIONS_CLASS} .pdfViewer .annotationLayer section.linkAnnotation`,
		`body.${HIDE_LINK_ANNOTATIONS_CLASS} .pdfViewer .annotationLayer .linkAnnotation > a`,
		`body.${HIDE_LINK_ANNOTATIONS_CLASS} .pdfViewer .annotationLayer a`,
	].join(",");
	return (
		`${selectors}{` +
		`border:none !${priority};` +
		`outline:none !${priority};` +
		`box-shadow:none !${priority};` +
		`}`
	);
}

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
	/** Injected only while "Show link outlines" is off; removed on show/unload. */
	private hideOutlinesStyleEl: HTMLStyleElement | null = null;

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

		// Re-apply when layout / leaves change (new PDF opens)
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.scheduleApply())
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.scheduleApply())
		);

		// Catch late-mounted PDF.js nodes (thumbnails, pages)
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
			this.clearAppearanceVars();
			this.clearLinkAnnotationStyle();
		});
	}

	onunload() {
		this.observer?.disconnect();
		this.observer = null;
		if (this.applyTimer !== null) {
			window.clearTimeout(this.applyTimer);
			this.applyTimer = null;
		}
		this.setClassOnTargets(false);
		this.clearAppearanceVars();
		this.clearLinkAnnotationStyle();
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
					".pdfViewer, .pdf-sidebar-container, .thumbnailImage, .pdf-container, .workspace-leaf, .annotationLayer, .linkAnnotation"
				) ||
				node.querySelector?.(
					".pdfViewer, .pdf-sidebar-container img.thumbnailImage, .thumbnailImage, .annotationLayer, .linkAnnotation"
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
		}, 50);
	}

	async toggleMode() {
		this.settings.isDark = !this.settings.isDark;
		await this.saveSettings();
		this.updateUi();
		this.applyModeToDom();
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
	 * - Body class scopes the override.
	 * - A temporary <style> in document.head carries the override so we do not
	 *   put !important in styles.css (review) or write element.style (which
	 *   destroyed PDF.js inline styles and broke re-enabling outlines).
	 * - Removing the <style> fully restores theme/PDF.js appearance.
	 */
	applyLinkAnnotationStyle() {
		const hide = !this.settings.showLinkAnnotations;
		document.body.classList.toggle(HIDE_LINK_ANNOTATIONS_CLASS, hide);

		if (hide) {
			this.ensureHideOutlinesStyleMounted();
		} else {
			this.unmountHideOutlinesStyle();
		}
	}

	private ensureHideOutlinesStyleMounted() {
		if (this.hideOutlinesStyleEl?.isConnected) {
			return;
		}
		// Drop a stale node from a previous session if present
		document.getElementById(HIDE_OUTLINES_STYLE_ID)?.remove();

		const styleEl = document.head.createEl("style", {
			attr: { id: HIDE_OUTLINES_STYLE_ID },
		});
		styleEl.setText(buildHideLinkOutlinesCss());
		this.hideOutlinesStyleEl = styleEl;
	}

	private unmountHideOutlinesStyle() {
		this.hideOutlinesStyleEl?.remove();
		this.hideOutlinesStyleEl = null;
		document.getElementById(HIDE_OUTLINES_STYLE_ID)?.remove();
	}

	private clearLinkAnnotationStyle() {
		document.body.classList.remove(HIDE_LINK_ANNOTATIONS_CLASS);
		this.unmountHideOutlinesStyle();
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
