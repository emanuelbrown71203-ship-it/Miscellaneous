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
- Under Apache-2.0, files we change must carry a notice saying they were changed.
- **Branding:** the FilmCraft/ArtCraft names, owl icon and logos are trademarks, not open source
  (`docs/brand/LICENSE-brand.txt`). Modified versions must remove them before they are distributed.
  Rebrand the app before you ship or publish a changed build.

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
