# PDF Toggle Dark Mode

Obsidian plugin that toggles a dark/light appearance for PDF viewers and sidebar thumbnails.

## Features

- **Ribbon icon** — sun (light) / moon (dark), with tooltip for the current mode
- **Status bar item** — same toggle plus `PDF: Light` / `PDF: Dark` label
- **Command** — *Toggle PDF dark/light mode* (bind a hotkey if you like)
- **Settings** — **Darkness** and **Color correction** sliders (no CSS knowledge required)
- **Persistence** — mode and appearance settings are saved across restarts
- **Late PDF opens** — classes re-apply when new PDF views mount

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

Open a PDF, then click the ribbon or status bar control (or run the command).

Under **Settings → PDF Toggle Dark Mode**:

| Setting | What it does | Default |
|--------|----------------|---------|
| **Darkness** | How strongly light pages turn dark | 100% (full) |
| **Color correction** | Makes charts/photos look natural after darkening | 50% (recommended) |

Use **Reset appearance** to restore those defaults.

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
