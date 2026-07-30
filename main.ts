import { Plugin, setIcon } from "obsidian";

const PDF_DARK_CLASS = "pdf-dark-mode";
const SELECTORS = [
	".pdfViewer",
	".pdf-sidebar-container img.thumbnailImage",
] as const;

interface PdfDarkModeSettings {
	isDark: boolean;
}

const DEFAULT_SETTINGS: PdfDarkModeSettings = {
	isDark: false,
};

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

		this.updateUi();
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
			if (!(node instanceof HTMLElement)) {
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

	private applyModeToDom() {
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
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<PdfDarkModeSettings> | null
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
