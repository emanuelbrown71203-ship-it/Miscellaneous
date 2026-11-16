# Cutroom

**A professional non-linear video editor: editing, color and sound, written in pure Rust.**

Cutroom runs natively on macOS, Windows and Linux, and in the browser through WebAssembly. It uses
familiar panels, workspaces, tools and keyboard shortcuts, with its own H.264, HEVC, ProRes and AAC
codecs, a GPU compositor that works in linear light, and exact integer frame timing.

Cutroom is a modified version of [FilmCraft](https://github.com/storytold/filmcraft) by the ArtCraft
team, used under its MIT OR Apache-2.0 licence. It is not affiliated with or endorsed by the ArtCraft
team. See [UPSTREAM.md](UPSTREAM.md) for what we imported and how to pull in upstream updates.

## What it does

- **Edit:** bins, Source and Program monitors, a multi-track timeline, ripple, roll, slip and slide
  trims, multicam, nested sequences, markers and subclips.
- **Color:** basic correction, creative looks, curves, color wheels, HSL secondaries, vignettes and
  video scopes, all graded in 32-bit linear light.
- **Effects and motion:** keyframed transform, opacity, time remapping, transitions, masks, keying
  and stylize effects.
- **Audio:** a track mixer, clip and track effects, loudness meters and ducking.
- **Titles and captions:** a text and shape engine, graphics templates, and caption tracks with
  SRT/VTT/SCC import and export.
- **Export:** H.264, HEVC, ProRes and more, plus interchange with XML, EDL, AAF and OTIO.
- **Automation:** every action is a command you can drive from the CLI, a JSON control channel
  or MCP.

## Run it

You need Rust 1.95 or newer.

```sh
cargo run --release -p filmcraft                    # desktop app, opens with a demo project
cargo run --release -p filmcraft-cli -- commands    # list every engine command
```

### In the browser

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
cargo xtask web --serve 8765                        # then open http://127.0.0.1:8765/
```

The output in `target/web/dist` is a static site with no server code, and your media stays on your
machine. Use Chrome or Edge for WebGPU; other browsers fall back to WebGL2. See
[docs/web.md](docs/web.md) for details and [packaging/web/README.md](packaging/web/README.md) for
hosting.

## Docs

The engineering docs in [`docs/`](docs/) come from FilmCraft and still use its name in places:
[architecture](docs/architecture.md), [testing](docs/testing.md),
[project files](docs/project-files.md), [control protocol](docs/control-protocol.md) and
[web build](docs/web.md). The rules every change must follow are in [AGENTS.md](AGENTS.md).

Internal crate names (`filmcraft-*`), the `window.filmcraft` web API and the `.fcproj` project
format keep their upstream names. This keeps your project files compatible and upstream merges
simple.

## Licence

MIT OR Apache-2.0 ([LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE)). Copyright notices
and the modification notice are in [NOTICE](NOTICE). Third-party assets are listed in
[ATTRIBUTION.md](ATTRIBUTION.md).
