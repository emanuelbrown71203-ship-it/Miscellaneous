# Cutroom web build

This folder is the built browser version of [`filmcraft/`](../filmcraft/) (Cutroom). It is a
static site that Vercel serves as is. Don't edit these files by hand; rebuild them instead.

## Rebuild

```sh
cd filmcraft
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
cargo xtask web
# shrink the wasm with binaryen 116 or newer (older versions reject current Rust output)
wasm-opt -O2 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals --enable-reference-types --enable-multivalue \
  target/web/dist/filmcraft_web_bg.wasm -o target/web/dist/filmcraft_web_bg.wasm
cp -r target/web/dist/. ../cutroom-web/
```

`vercel.json` caches the wasm and its glue for a long time; `index.html` loads them with a
`?v=<build hash>` query, so a new build always gets fresh files.

## Run locally

```sh
python3 -m http.server 8765 -d cutroom-web   # then open http://localhost:8765/
```
