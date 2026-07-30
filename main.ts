import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
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
}

const DEFAULT_SETTINGS: PdfDarkModeSettings = {
	isDark: false,
	conversionAmount: 1,
	hueRotation: 180,
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
					".pdfViewer, .pdf-sidebar-container, .thumbnailImage, .pdf-container, .workspace-leaf"
				) ||
				node.querySelector?.(
					".pdfViewer, .pdf-sidebar-container img.thumbnailImage, .thumbnailImage"
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
		document.body.style.setProperty(CSS_VAR_INVERT, String(invert));
		document.body.style.setProperty(CSS_VAR_HUE, `${hue}deg`);
	}

	private clearAppearanceVars() {
		document.body.style.removeProperty(CSS_VAR_INVERT);
		document.body.style.removeProperty(CSS_VAR_HUE);
	}

	private applyModeToDom() {
		this.applyAppearanceVars();
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Called from the settings tab after a control changes. */
	async onAppearanceSettingChange() {
		await this.saveSettings();
		this.applyAppearanceVars();
		// Re-toggle class path so late elements also pick up vars
		if (this.settings.isDark) {
			this.applyModeToDom();
		}
	}
}

class PdfDarkModeSettingTab extends PluginSettingTab {
	plugin: PdfToggleDarkModePlugin;

	constructor(app: App, plugin: PdfToggleDarkModePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "PDF Toggle Dark Mode" });

		containerEl.createEl("p", {
			text: "These options only affect how PDFs look when dark mode is on. They do not change the rest of Obsidian.",
			cls: "setting-item-description",
		});

		// --- Darkness (conversionAmount → invert) ---
		const darknessPercent = Math.round(
			this.plugin.settings.conversionAmount * 100
		);

		new Setting(containerEl)
			.setName("Darkness")
			.setDesc(
				"How strongly light PDF pages turn dark. 100% is a full dark look; lower values keep pages lighter."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 100, 1)
					.setValue(darknessPercent)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.conversionAmount = value / 100;
						void this.plugin.onAppearanceSettingChange();
						this.updateDarknessReadout(value);
					})
			)
			.then((setting) => {
				this.darknessReadout = setting.controlEl.createSpan({
					cls: "pdf-tdm-setting-readout",
					text: this.darknessLabel(darknessPercent),
				});
			});

		// --- Color correction (hueRotation → hue-rotate) ---
		// Map 0–360° to a 0–100% “natural colors” friendly control.
		// 50% ≈ 180° — the usual sweet spot after full darkening.
		const colorPercent = Math.round(
			(this.plugin.settings.hueRotation / 360) * 100
		);

		new Setting(containerEl)
			.setName("Color correction")
			.setDesc(
				"After darkening, colors (charts, photos, highlights) can look off. Drag until they look natural. 50% works well for most PDFs."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 100, 1)
					.setValue(colorPercent)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.hueRotation = (value / 100) * 360;
						void this.plugin.onAppearanceSettingChange();
						this.updateColorReadout(value);
					})
			)
			.then((setting) => {
				this.colorReadout = setting.controlEl.createSpan({
					cls: "pdf-tdm-setting-readout",
					text: this.colorLabel(colorPercent),
				});
			});

		new Setting(containerEl)
			.setName("Reset appearance")
			.setDesc("Restore Darkness and Color correction to the recommended defaults.")
			.addButton((btn) =>
				btn.setButtonText("Reset to defaults").onClick(() => {
					this.plugin.settings.conversionAmount =
						DEFAULT_SETTINGS.conversionAmount;
					this.plugin.settings.hueRotation = DEFAULT_SETTINGS.hueRotation;
					void this.plugin.onAppearanceSettingChange();
					this.display();
				})
			);
	}

	private darknessReadout: HTMLElement | null = null;
	private colorReadout: HTMLElement | null = null;

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

	private updateDarknessReadout(percent: number) {
		if (this.darknessReadout) {
			this.darknessReadout.setText(this.darknessLabel(percent));
		}
	}

	private updateColorReadout(percent: number) {
		if (this.colorReadout) {
			this.colorReadout.setText(this.colorLabel(percent));
		}
	}
}
