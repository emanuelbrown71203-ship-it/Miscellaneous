# Upstream source

This folder is a copy of **FilmCraft**, an open-source, Premiere-style non-linear video editor written
in Rust. We use it as the base for our own features.

| | |
| --- | --- |
| Upstream | https://github.com/storytold/filmcraft |
| Imported commit | `892126cb72ab0c8ae5f668ed1928bf61713d142a` (2026-11-15, version 0.20.1) |
| Licence | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`, `ATTRIBUTION.md`) |

## Licence obligations

- Keep `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE` and `ATTRIBUTION.md` with the code.
- Under Apache-2.0, files we change must carry a notice saying they were changed. `NOTICE` records
  that this is a modified version; the per-file history is in git.
- **Branding:** the ArtCraft name, wordmark and logos are trademarks and not open source. Modified
  versions must remove them. We removed them (formerly `docs/brand/`) and renamed the app to Cutroom.
  FilmCraft's owl app icon is MIT OR Apache-2.0 (`assets/app-icon/LICENSE.txt`), so we may keep it.

## What we changed

- The product name in the UI, translations, web page and installer metadata is **Cutroom**. The
  bundle ID is `app.cutroom.Cutroom`.
- The ArtCraft wordmark, Discord button and ArtCraft links are removed. Help links point to this
  repository, with a plain-text credit to FilmCraft.
- Unchanged: internal crate names (`filmcraft-*`), the `window.filmcraft` web API, file formats
  (`.fcproj`, `.fcgt`) and FilmCraft's docs.

## Updating from upstream

```bash
git clone https://github.com/storytold/filmcraft /tmp/filmcraft-upstream
cd /tmp/filmcraft-upstream
git diff 892126cb72ab0c8ae5f668ed1928bf61713d142a HEAD > /tmp/upstream.patch
cd <this repo>
git apply --directory=filmcraft --3way /tmp/upstream.patch
```

After applying, update the imported commit in the table above.

## Building

```bash
cd filmcraft
cargo run --release -p filmcraft     # desktop app (Rust 1.95+)
cargo xtask web --serve 8765         # browser build, see docs/web.md
```
