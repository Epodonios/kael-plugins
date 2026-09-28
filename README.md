# kael-plugins — the official KAEL plugin registry

This repository is the **plugin registry** for [KAEL](https://github.com/Epodonios) — the
hacker-terminal system control deck. KAEL's **plugin bay** tab fetches `index.json` from this
repo (via `raw.githubusercontent.com`), lists every entry as an installable card, and on
install downloads the referenced zip, **verifies its sha256 byte-for-byte**, asks the user for
**explicit permission consent**, and only then extracts the plugin into `userData/plugins/`.

Nothing here runs inside KAEL's own build. Plugins are optional, separate, and uninstallable.

```
kael-plugins/
├── index.json                      ← the registry the app fetches
└── plugins/
    ├── unit-converter/             ← the official minimal example plugin
    │   ├── manifest.json           ← identity + declared permissions
    │   ├── main.js                 ← ES module exporting mount(container, kaelApi)
    │   ├── style.css               ← optional, theme-reactive styling
    │   └── unit-converter.zip      ← the distributable referenced by index.json
    └── creative-dev-utilities/     ← 7-in-1 creative & dev toolkit (tab strip inside the panel)
        ├── manifest.json           ← fs.dialog · fs.write · net.fetch
        ├── main.js                 ← sketchboard, flowchart, font-id, compressor, converter, code-image, pkg-size
        ├── style.css
        └── creative-dev-utilities.zip
```

## Publishing / updating a plugin

1. Put (or edit) the plugin folder under `plugins/<id>/` — `manifest.json`, the entry JS,
   optional `style.css`. The zip must have `manifest.json` at its **root**:
   ```bash
   cd plugins/unit-converter
   zip -X unit-converter.zip manifest.json main.js style.css
   ```
2. Compute the zip's sha256 and update `index.json`:
   ```bash
   sha256sum unit-converter.zip
   ```
   The `sha256` in `index.json` MUST match the zip byte-for-byte — KAEL refuses any
   mismatch with a hard security warning and wipes the download.
3. Bump the plugin's `version` (x.y.z) and commit + push to `main`.
4. Users see the update on their next Browse/Installed refresh and re-run the consent
   flow with one click.

Rules enforced by the installer (a registry entry that breaks them is hidden from the list):

- `id` — lowercase slug `^[a-z0-9][a-z0-9-]{1,47}$`, unique
- `version` / `minAppVersion` — strict `x.y.z`
- `downloadUrl` — `https://` only (plain http is accepted for `localhost` dev registries)
- `sha256` — 64 hex chars matching the zip exactly
- every `manifest.permissions` string must exist in KAEL's permission catalog — an unknown
  permission refuses the install outright

## Authoring

See **PLUGIN-AUTHORING.md** in the main KAEL repository for the full guide: the manifest
format, the `mount(container, kaelApi)` contract, the complete permission catalog with what
each one exposes, and the unit-converter walkthrough.
