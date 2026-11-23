# Cutroom: sign in with Google, projects and footage in Google Drive

Status: draft for approval · 2026-11-23

## Intent

The owner edits on more than one device and wants to pick a project up on their laptop exactly where
they left it, footage included. Today the web app saves a project as a downloaded `.fcproj`,
auto-saves only into that one browser (OPFS), and a project merely points at clips that stay on the
device they were imported on. Nothing follows the user to another device.

So: Cutroom asks you to sign in with Google before you use it. Your Google account is the account and
your own Google Drive is the storage. Every project, every clip imported into it, and where you left
off live in a "Cutroom" folder in that Drive. Sign in on any other device and the same projects are
there, ready to edit.

## Goals

1. **Sign-in gate.** The web app opens on a "Sign in with Google" screen. Nothing else is usable until
   you are signed in (exceptions: host mode, automated tests; see Constraints).
2. **Projects in Drive.** A projects screen lists the projects in your Drive's Cutroom folder (newest
   first). New Project creates one there; opening one loads it from there.
3. **Footage in Drive.** Every clip imported into a project is uploaded to that project's folder in the
   background while you keep editing. On another device the clips play straight from Drive; nothing
   needs relinking.
4. **Where you left off.** Opening a project on any device restores the open sequences, playhead,
   in/out points, zoom and workspace as they were when it was last saved, and your settings
   (preferences, shortcuts, workspaces) follow your account.
5. **Saving is automatic.** While a project has unsaved changes it is saved to Drive every few seconds
   (as the OPFS auto-save does today); File › Save saves now. You never lose work because a tab closed:
   the existing OPFS recovery keeps working underneath.
6. **Honest status.** The header shows a small sync status (Saved to Drive / Saving… / Uploading 2
   clips, 41% / Offline, changes kept on this device / Drive is full) and clips still uploading are
   marked in the Project panel.

## Non-goals (this round)

- **The desktop app.** It keeps saving to files as today. Signing in on desktop is a later round; the
  storage design below is meant to serve it unchanged.
- **Our own servers, accounts or storage.** No backend, no database, nothing that bills monthly.
- **Sharing or real-time collaboration.** One person, their own Drive. Two devices editing the same
  project at the same moment is handled as a conflict (below), not merged.
- **Exports in Drive.** Rendered videos still download as today. (Easy follow-up.)
- **Other sign-in providers or other clouds** (Apple, email, Dropbox, OneDrive).
- **Public launch.** For now the app stays in Google's "Testing" mode: the owner plus up to 100 people
  they name can sign in.

## Anti-goals (would be a failure even if it "works")

- Cutroom can read files in your Drive that it didn't create or that you didn't open with it.
- Work is lost: a save silently overwrites newer changes from another device, an upload failure
  drops a clip from the project, or a dropped connection discards edits.
- Editing stalls or the tab freezes while clips upload, or a multi-gigabyte clip is pulled whole into
  memory.
- An access token, an email address, a file name or a path ends up in logs, crash reports (Sentry) or
  URLs that are shared.
- A Drive error (offline, quota full, token expired, file deleted in Drive) crashes the app instead of
  showing a message you can act on.

## Constraints

- **Rust only.** The app is Rust compiled to wasm; no handwritten JavaScript beyond what `index.html`
  already has (repo rule, `filmcraft/AGENTS.md`). Sign-in and Drive calls are made from Rust through
  `web-sys` (`fetch`, `window.open`, `postMessage`, `location`).
- **Never crash** (`AGENTS.md` §0): every network, auth and Drive failure is a `Result`, shown in the
  status bar or a dialog. No `unwrap`/`expect`/`panic`.
- **Every interactive widget has an automation id**, and the new actions are commands
  (`account.signIn`, `account.signOut`, `cloud.openProject`, `cloud.newProject`, …) so the agent API
  (`window.filmcraft`), the control channel and tests can drive them.
- **Layering** (`docs/architecture.md`, `cargo xtask layers`): the sync logic that has no browser or
  egui dependency (the project manifest, the upload queue's state machine, conflict rules) goes in a
  crate below the UI and is tested natively against an in-memory fake of Drive. Only the HTTP/OAuth
  glue lives in `apps/filmcraft-web`.
- **Narrowest Google permissions:** `openid email profile` and `https://www.googleapis.com/auth/drive.file`
  (Cutroom sees only files it created or that the user opened with it). `drive.file` is a
  non-sensitive scope, so no Google security review is needed while in Testing mode.
- **No secrets in the repo.** The OAuth client ID is public by design and goes in build config; there
  is no client secret (see Sign-in). The owner creates the Google Cloud project (we provide steps).
- **Privacy in crash reports:** Sentry stays as configured (`dataCollection`, no IPs, no file names);
  the new code must not put tokens, emails or Drive file names into errors that reach Sentry.
- **Host mode is untouched:** with `?host=parent` / `data-host="page"` the embedding page provides
  storage, so there is no sign-in gate and no Drive sync.
- **Tests:** the existing headless UI tests open the demo project without signing in. A test-only
  switch (a `FilmcraftApp` setting the web shell never sets from user input, plus `?nologin` for local
  development) skips the gate. The gate is about reaching your projects, not security: the data
  lives in the user's own Drive and the browser can't be trusted anyway.

## Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| **A** | **Google sign-in; the user's Google Drive stores projects and footage** | No server or bill; uses the user's Drive space (15 GB free), uploads take time | **Chosen by the owner** |
| B | Our own accounts and storage (e.g. Supabase) | Any login type and full control, but we run and pay for servers and video storage | Rejected: cost and upkeep for a one-person tool |
| C | Sync projects through Drive; footage via Google's "Drive for desktop" app | Cheapest, but the browser can't see that synced folder, so clips are re-picked on every device | Rejected: defeats the goal |

## The design (approach A)

### Sign-in

- Google OAuth 2.0 for a browser app with no backend: the **token flow** (`response_type=token`),
  run in a **popup** opened from Rust (`window.open` to `accounts.google.com/o/oauth2/v2/auth`) whose
  redirect URI is the app's own page with `?oauth=callback`. In that mode the wasm reads the token
  from the URL fragment, `postMessage`s it to the opener (same origin only), and closes the popup.
  No JavaScript library, no client secret.
- The access token lives in memory only (never in `localStorage`, logs or URLs that persist). It
  lasts about an hour; before it expires Cutroom renews it with a popup using `prompt=none` (no
  click needed when you are still signed in to Google). If renewal can't happen silently (popup
  blocked, signed out of Google), the header shows "Reconnect to Google Drive" and edits keep
  being saved locally (OPFS) until you click it; then they go up.
- Remembered between visits: only that you signed in and with which Google account (the account's
  id and email, in OPFS), so the next visit goes straight to "Continue as you@gmail.com".
- Sign out: forgets the token and the remembered account, revokes the token with Google, and
  returns to the sign-in screen. Local OPFS copies for that account are removed.

### What's in Drive

```
My Drive/
  Cutroom/                         ← created on first sign-in
    <Project name>/                ← one folder per project
      project.fcproj               ← the project (the same format as a saved file)
      cutroom-project.json         ← manifest (below)
      media/
        clip one.mp4
        interview.mov …
  (appDataFolder, hidden)          ← settings.json: preferences, shortcuts, workspaces
```

- **Manifest** (`cutroom-project.json`): format version; the project's display name; for each media
  path the project uses (`/files/<name>`), the Drive file id, size, a content hash (for dedupe and
  verifying uploads), and upload state (`uploaded` / `pending`). A device opening the project uses it
  to put a Drive-backed entry at every path the project references, so the project opens unchanged.
- Folder and file names are what the user sees in Drive; Cutroom finds things by Drive file id and an
  `appProperties` tag (`cutroomProject`, `cutroomMedia`), so renaming or moving the folder in Drive
  doesn't break it.
- "Where you left off" travels in `project.fcproj` (the project format already carries open sequences
  and the like; anything the builder finds missing — playhead per sequence, zoom, workspace — is added
  to it, versioned so older Cutroom builds still open it). Settings go to `appDataFolder/settings.json`
  on change and load at sign-in.

### Opening and saving

- **Projects screen** (replaces the web app's start on the demo project; extends Home's Recent list):
  your Drive projects newest first with last-edited time, New Project, Open, and Rename/Delete (Delete
  moves the folder to Drive's trash). Opening shows progress while the project file loads.
- **Saving:** dirty projects are written to Drive every few seconds and on File › Save; a save sends
  `project.fcproj` and the manifest. The OPFS snapshot keeps being written first, so a closed tab or a
  lost connection never loses work; on the next start a newer local snapshot than Drive's is offered
  back ("Recovered unsaved changes").
- **Conflicts** (the same project edited on two devices): every save checks that Drive's copy is the
  version this device last loaded or saved (Drive's `version`/`modifiedTime`). If not, nothing is
  overwritten; you choose **Keep mine** (save over it), **Use the other device's** (reload), or **Save
  mine as a copy**. While a project is open, Cutroom checks Drive for a newer version when the window
  regains focus and offers to load it.
- File › Save As / Export Project still offers a downloaded `.fcproj` copy ("Download a copy").

### Footage

- **Import → upload:** importing works exactly as today (the clip is usable at once from the local
  file). The clip is also copied into OPFS (as recovery already does) and queued for upload to
  `media/`. Uploads use Drive's **resumable upload** protocol, a few MiB at a time streamed from the
  OPFS/`File` blob, one or two clips at a time, never reading a whole clip into wasm memory. The
  resumable session URI and progress are kept in OPFS, so closing the tab and coming back resumes
  where it stopped.
- The same clip imported twice (same hash) is uploaded once.
- **Playing from Drive on another device:** the project's media paths are registered as Drive-backed
  entries. The existing chunked reader (`BlobReader`: 1 MiB range reads, LRU cache, async fetch that
  marks reads pending and repaints when bytes arrive) gets a second source that fetches byte ranges
  from `drive/v3/files/<id>?alt=media` with the token. So clips play and scrub straight away from
  Drive, a little slower the first time.
- **Kept on this device:** after a project opens, its clips also download in the background into OPFS
  (largest-first is fine), so editing becomes as smooth as local files; the Drive range reader is the
  fallback until a clip is fully local. If the browser's storage quota is too small, it keeps streaming
  instead and says so.
- **Clip not uploaded yet from the other device:** it shows as "Still uploading from another device"
  (offline media) and fills in when the upload finishes (picked up on the next refresh/focus check).

### Errors you can act on

| Situation | What you see | What happens to your work |
|---|---|---|
| Offline | "Offline — changes are kept on this device" | OPFS snapshot; syncs when back online |
| Token expired, silent renew failed | "Reconnect to Google Drive" button | Same as offline until reconnected |
| Drive full | "Google Drive is full — uploads paused" with a link to Drive storage | Project still saves (it's small); clips wait |
| Clip deleted in Drive | That clip shows offline; Relink offered | Project unaffected |
| Popup blocked | "Allow pop-ups for this site to sign in" | — |
| Conflict | The three-choice dialog above | Nothing overwritten without asking |

### What the owner does once (we'll provide exact steps)

1. Create a Google Cloud project, enable the Google Drive API.
2. Set up the OAuth consent screen (External, Testing; app name Cutroom; add their own Google account
   as a test user; scopes `openid`, `email`, `profile`, `drive.file`).
3. Create an OAuth client ID of type Web application with origin `https://cutroom-six-mu.vercel.app`
   (and `http://localhost:8080` for testing) and redirect URI `https://cutroom-six-mu.vercel.app/?oauth=callback`.
4. Give us the client ID (it is public, not a secret).

## Left to the builder

- Crate boundaries and names for the sync core; the exact manifest schema (keep it versioned).
- Save interval, upload chunk size and concurrency, background-download order.
- How the projects screen looks within the existing Home/Import mode style.
- How Drive-backed entries plug into `fs.rs` (a new `Entry` kind is the obvious route).
- Whether recovery's existing OPFS media copies are reused as the upload source (preferred) or a
  separate store is kept.
- Testing approach beyond the native fake of Drive (e.g. a headless-browser run against a stub Drive
  served locally); real-Google checks are manual, with the owner's account.
