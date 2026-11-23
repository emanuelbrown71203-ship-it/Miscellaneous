---
name: cutroom-release
description: Build, verify and ship Cutroom (the rebranded FilmCraft video editor in filmcraft/). Use when changing filmcraft/ code that will be released, rebuilding or redeploying the web app at cutroom-six-mu.vercel.app, producing desktop installers, renaming anything user-visible, or checking Cutroom crash reports in Sentry.
---

# Releasing Cutroom

Cutroom is FilmCraft (Rust, MIT OR Apache-2.0) rebranded. Source: `filmcraft/`. Provenance and
licence obligations: `filmcraft/UPSTREAM.md`. Contributor rules: `filmcraft/AGENTS.md` (never
panic, exact `Tick` time, every action is a command, clean-room code and assets).

## Where things run

| What | Where |
|---|---|
| Live web app | https://cutroom-six-mu.vercel.app (Vercel team `zay-9e82`, project `cutroom`, `prj_n9k42RaFeUOX2VyPdyXTvHBJhkEq`) |
| CI | `.github/workflows/cutroom.yml`: web build (+ Vercel deploy when the `VERCEL_TOKEN` secret exists) and desktop installers for Windows, macOS, Linux as run artifacts |
| Crash reports | Sentry `therealzay2k/cutroom` (Sentry connector) |
| Cloud environment | "Miscellaneous": its setup script installs the wasm target, wasm-bindgen 0.2.129, binaryen 123 (`wasm-opt`) and libasound2-dev |

## Build

```sh
cd filmcraft
export CARGO_TARGET_DIR=<scratchpad>/target   # keep build output out of the repo; reuse it across builds
cargo xtask web                               # → $CARGO_TARGET_DIR/web/dist, already wasm-opt'ed (~41 MB)
cargo build --release -p filmcraft            # desktop
```

- `wasm-opt` must be binaryen **116 or newer**. Ubuntu's apt binaryen (108) rejects current Rust
  output, and `cargo xtask web` calls whatever `wasm-opt` is on PATH.
- `wasm-bindgen` must be exactly the version in `Cargo.lock` (0.2.129).

## Verify before shipping

Run the full gate: `cargo xtask ci` (fmt, clippy -D warnings, all tests, layers, assets, wasm). On
this container some tests fail for reasons outside your change: the EXR and APV ffmpeg-oracle tests
(the system ffmpeg is too old), `phone_vfr_clip_extract_gain_title_to_h264_mp4`,
`with_the_toggle_off_a_sequence_edits_in_as_its_clips_with_their_transitions`, and the timing test
`program_monitor_plays_on_while_a_value_is_dragged` under load. Before calling a failure "known",
run the same test on an unmodified upstream checkout. Only failures that happen there too are known.

Then exercise the web build in headless Chromium (Playwright,
`--enable-unsafe-swiftshader --use-angle=swiftshader`), served with `python3 -m http.server`:

- `window.filmcraftLoad.readyMs` is set and the title is "Cutroom".
- Run `window.filmcraft.execute('file.exportMedia', {path, format, range: 'custom', startSeconds, endSeconds})`
  for each format you touched; the file arrives as a download. Check it with `ffprobe`.
- Spot-checking only what you changed is not enough. A rename once broke DPX export, and only the
  full test suite caught it.

## Deploy the web app

Preferred: push to the branch. CI builds the site and deploys it with `vercel@65.11.0` if the repo
secret `VERCEL_TOKEN` is set.

Without the secret: copy `dist/` into `cutroom-web/` (keep `README.md` and `vercel.json`), commit,
push, then call Vercel `create_deployment` with `project: prj_n9k42RaFeUOX2VyPdyXTvHBJhkEq`,
`target: "production"` and a `gitSource` of `{type: github, org: emanuelbrown71203-ship-it, repo: Miscellaneous, ref, sha}`.
Always deploy to **production**: preview URLs sit behind Vercel's login. The Vercel connector's
`upload_file` cannot carry the 41 MB wasm.

Confirm the deploy: `curl https://cutroom-six-mu.vercel.app/` and check that its `const build = "<hash>"`
matches `dist/index.html`.

## Traps already hit

- **Browser threads.** craft-video's `threads` feature must stay off for wasm32. It is enabled per
  crate under `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`. With it on, H.264 export
  in the browser fails with "cannot build the 1-thread pool".
- **Renames.** A product-name change also hits fixed-length binary fields. The DPX creator field
  `hd[160..169]` was sized for "FilmCraft" and panicked on "Cutroom". Grep for `b"<name>"`,
  `.as_bytes()` and fixed slice ranges near the name, then run the whole test suite.
- **Upstream credit.** A bulk rename must not touch the attribution ("Based on FilmCraft by the
  ArtCraft team" in About and Help, "FilmCraft contributors" in `.attribution` files and NOTICE).
  `links::tests::urls_are_project_links` guards the Help link. The brand licence forbids presenting
  Cutroom as an ArtCraft product, and the ArtCraft marks must stay removed.
- **Sentry SDK 11** ignores `sendDefaultPii`. Privacy is set by `dataCollection` in
  `apps/filmcraft-web/web/index.html`, and its defaults collect IP addresses, cookies and query
  strings. Before shipping a change to reporting, intercept the envelopes and check for
  `"infer_ip":"never"`, no `{{auto}}`, and no file names or paths.
- **Deletes.** `rm -rf $VAR/*` is refused by a safety check. Use literal paths or `"${VAR:?}"/*`.

## Sentry

Panics arrive as "Rust panic: panicked at <file>:<line>:<col>: …", grouped by that location. Use
the Sentry connector: `search_issues` on project `cutroom`, then `get_sentry_resource` for details.
Resolve test events you send (`?sentrytest`) so they don't mix with real crashes.
