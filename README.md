# PDF Toggle Dark Mode

Obsidian plugin that toggles a dark/light appearance for PDF viewers and sidebar thumbnails.

## Features

- **PDF toolbar controls** — dark/light toggle plus **Darkness**, **Color correction**, and **Brightness** sliders, mounted on the native PDF toolbar (same idea as PDF++’s color palette)
- **Ribbon icon** — sun (light) / moon (dark), with tooltip for the current mode
- **Status bar item** — same toggle plus `PDF: Light` / `PDF: Dark` label
- **Command** — *Toggle PDF dark/light mode* (bind a hotkey if you like)
- **Settings** — same appearance options (also available from Settings → PDF Toggle Dark Mode)
- **Persistence** — mode and appearance settings are saved across restarts
- **Late PDF opens** — classes and toolbar controls re-apply when new PDF views mount

## Install (manual / development)

1. Build:

   ```bash
   npm install
   npm run build
   ```

2. Copy or symlink this folder into:

   ```text
   <vault>/.obsidian/plugins/pdf-toggle-dark-mode/
   ```

   Required files for Obsidian: `main.js`, `manifest.json`, `styles.css`.

3. Enable **PDF Toggle Dark Mode** under Settings → Community plugins.

## Usage

Open a PDF. On the PDF viewer toolbar you’ll see:

1. **Sun / moon button** — toggle light ↔ dark for PDFs  
2. **Dark** slider — darkness (only while dark mode is on)  
3. **Color** slider — color correction (only while dark mode is on)  
4. **Bright** slider — brightness (only while dark mode is on; 20–200%)

You can also use the ribbon icon, status bar item, or the *Toggle PDF dark/light mode* command.

Under **Settings → PDF Toggle Dark Mode** (requires Obsidian **1.13.0+**):

| Setting | What it does | Default |
|--------|----------------|---------|
| **Darkness** | How strongly light pages turn dark | 90% |
| **Color correction** | Makes charts/photos look natural after darkening | 50% (recommended) |
| **Brightness** | CSS `brightness()` after darkening (min 20%, max 200%) | 100% |
| **Show link outlines** | Show/hide the outline boxes around clickable PDF links | On |

Each slider has its own **Reset** control (toolbar: small rotate icon; Settings: *Reset darkness* / *Reset color correction* / *Reset brightness*). **Reset appearance** restores all three plus link outlines. Settings are searchable from Obsidian’s global settings search. Toolbar sliders and Settings stay in sync.

## Develop

```bash
npm run dev    # watch rebuild
npm run build  # production main.js
```

## Releases and Obsidian Community Plugins

**A repo alone is not enough** for the official Community plugins browser.

Obsidian installs plugins by downloading **assets from a GitHub Release**:

| Asset | Required |
|--------|----------|
| `main.js` | yes |
| `manifest.json` | yes |
| `styles.css` | yes (this plugin has styles) |

- **Community store** → needs a published GitHub Release with those files.
- **Just a public repo** → fine for source / PRs; users cannot install via Browse unless a Release exists.
- **BRAT / manual install** → can use the repo or a local copy without the store.

### Automated release (this repo)

1. Bump versions so they match (example `1.0.1`):
   - `package.json` → `"version"`
   - `manifest.json` → `"version"`
   - (optional) `npm version patch` runs `version-bump.mjs` for `manifest.json` + `versions.json`
2. Commit and push `main`.
3. Trigger a release in either way:

   **A. Tag push**

   ```bash
   git tag 1.0.1
   git push origin 1.0.1
   ```

   **B. On-demand (Actions UI)**

   GitHub → **Actions** → **Release Obsidian plugin** → **Run workflow**

   - Leave **version** empty to use `manifest.json`, or type e.g. `1.0.1` (must match the manifest).
   - **draft** is on by default; uncheck to publish the Release immediately.

4. The workflow builds the plugin and creates a GitHub Release with `main.js`, `manifest.json`, and `styles.css` (draft unless you opted out on a manual run). Manual runs also create the git tag from the current commit if it does not exist yet.
5. If it is a draft: **GitHub → Releases** → review → **Publish release**.

Only after a published Release can Obsidian (and the community directory, once your plugin is listed) pick up the version.

## License

MIT
