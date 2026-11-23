# Cutroom: sign in with Google, projects and footage in Google Drive

Status: approved by the owner · 2026-11-23

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
   you are signed in (exceptions: host mode, automated tests; see Constraints). Once signed in you
   **stay signed in** across visits and long editing sessions, like Gmail, with no hourly
   interruptions (owner's decision).
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
6. **Work offline** (owner's decision). On a device you have signed in on before, Cutroom also opens
   with no internet: "Continue offline as you@gmail.com" lists the projects already on this device and
   you edit them as normal. Everything syncs when the connection is back, with the conflict rules
   below if the same project changed elsewhere meanwhile.
7. **Honest status.** The header shows a small sync status (Saved to Drive / Saving… / Uploading 2
   clips, 41% / Offline, changes kept on this device / Drive is full) and clips still uploading are
   marked in the Project panel.

## Non-goals (this round)

- **The desktop app.** It keeps saving to files as today. Signing in on desktop is a later round; the
  storage design below is meant to serve it unchanged.
- **Our own accounts or storage.** No database and nothing that bills monthly. The only server-side
  piece is a tiny sign-in token service on Vercel's free tier (below), which stores nothing.
- **Sharing or real-time collaboration.** One person, their own Drive. Two devices editing the same
  project at the same moment is handled as a conflict (below), not merged.
- **Exports in Drive.** Rendered videos still download as today. (Easy follow-up.)
- **Other sign-in providers or other clouds** (Apple, email, Dropbox, OneDrive).
- **Public launch or marketing.** The Google consent screen is published "In production" only so
  sign-ins last longer than Google's 7-day limit for Testing apps (allowed without a Google review for
  these non-sensitive scopes). Anyone with the link could then sign in, but each person only ever
  reaches their own Drive; the app is not advertised. (*Builder's call*, flagged to the owner.)

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
  `web-sys` (`fetch`, `window.open`, `BroadcastChannel`, `location`). The token service is Rust too
  (a Vercel Rust function).
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
- **No secrets in the repo.** The OAuth client ID is public by design and goes in build config. The
  client secret and the cookie-encryption key live only in Vercel's environment variables, which the
  owner sets once. The owner creates the Google Cloud project (we provide steps).
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
| **A** | **Google sign-in; the user's Google Drive stores projects and footage** | No storage server or bill; uses the user's Drive space (15 GB free), uploads take time | **Chosen by the owner**, plus a tiny token service so sign-in lasts (owner's decision, below) |
| B | Our own accounts and storage (e.g. Supabase) | Any login type and full control, but we run and pay for servers and video storage | Rejected: cost and upkeep for a one-person tool |
| C | Sync projects through Drive; footage via Google's "Drive for desktop" app | Cheapest, but the browser can't see that synced folder, so clips are re-picked on every device | Rejected: defeats the goal |

## The design (approach A)

### Sign-in (stay signed in: owner's decision)

Browsers only allow a sign-in popup straight after a click, and a browser-only Google sign-in gets no
long-lived token, so without any server Cutroom would have to ask again about every hour. The owner
chose to stay signed in instead, which takes one small server-side piece:

- **Token service:** two or three Rust functions on the same Vercel project (`/api/auth/callback`,
  `/api/auth/token`, `/api/auth/signout`). It runs Google's authorization-code flow with PKCE and the
  client secret, and keeps Google's **refresh token in an encrypted, `HttpOnly`, `Secure`,
  `SameSite=Strict` cookie** on the app's own domain. It stores nothing itself: no database, no logs of
  tokens or emails.
- **Signing in:** "Sign in with Google" (a click, so the popup is allowed) opens Google's consent page
  in a popup; Google redirects to `/api/auth/callback`, which sets the cookie and tells the app it is
  done (over `BroadcastChannel`, since the local dev server's `Cross-Origin-Opener-Policy` cuts the
  popup's link to its opener; *builder's call*). A redirect in the same tab is the fallback when
  popups are blocked.
- **Using Drive:** the app asks `/api/auth/token` for a short-lived access token whenever it has none
  or it is near expiry; the service uses the cookie's refresh token. The access token lives only in
  memory. Uploads, playback from Drive and saves never wait for a click.
- **Next visit:** the cookie is still there, so the app goes straight to your projects. Remembered on
  the device for offline use: the account's id and email (in OPFS), nothing secret.
- **Sign out:** the service revokes the token with Google and clears the cookie; the app forgets the
  account and removes that account's local OPFS copies (after warning if anything has not synced yet).
- **Reconnect** is still the fallback if Google refuses a refresh (password changed, access removed in
  Google's settings): "Reconnect to Google Drive", while edits keep being saved on the device.

### What's in Drive

```
My Drive/
  Cutroom/                         ← created on first sign-in
    <Project name>/                ← one folder per project
      project.fcproj               ← the project (the same format as a saved file)
      cutroom-project.json         ← manifest (below)
      view-state.json              ← where you left off (below)
      media/
        clip one.mp4
        interview.mov …
    settings.json                  ← preferences, shortcuts, workspaces (one per account)
```

- **Manifest** (`cutroom-project.json`): format version; the project's display name; for each media
  path the project uses (`/files/<name>`), the Drive file id, size, a content hash (for dedupe and
  verifying uploads), and upload state (`uploaded` / `pending`). A device opening the project uses it
  to put a Drive-backed entry at every path the project references, so the project opens unchanged.
- Folder and file names are what the user sees in Drive; Cutroom finds things by Drive file id and an
  `appProperties` tag (`cutroomProject`, `cutroomMedia`), so renaming or moving the folder in Drive
  doesn't break it.
- **Where you left off** (open sequences, playhead per sequence, in/out, zoom, workspace) is kept in
  its own small `view-state.json`, not in `project.fcproj`. *Builder's call:* scrubbing or zooming is
  not an edit, so it never marks the project unsaved and never causes a conflict; `view-state.json`
  is written a few seconds after the view stops changing and on closing, last write wins, no version
  check. Opening a project applies it after the project loads.
- **Settings** go to `Cutroom/settings.json` on change and load at sign-in. *Builder's call:* a
  visible file rather than Drive's hidden app-data folder, which would need an extra permission
  (`drive.appdata`) on the consent screen. Note the web app saves no settings at all today
  (`Session::prefs_path` is `None` on web), so this is new storage, not a move.

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
- **Bringing in existing work** (*builder's call*): File › Open of a `.fcproj` from the computer (a
  downloaded copy, or one from the desktop app) creates a new Drive project from it; clips it can find
  are uploaded, missing ones show offline with Relink as usual. At the first sign-in on a browser that
  has an unsaved OPFS recovery snapshot, Cutroom offers once to keep it as a new Drive project;
  otherwise the old global OPFS layout is cleared. The projects screen has **Open the demo project**,
  which opens it as today without creating anything in Drive (it has no media files) until you save
  it, which makes it a Drive project like any other.

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

### Working offline (owner's decision)

- **What's on the device:** per account, OPFS holds a small local index of projects (Drive ids,
  names, last-synced versions), each opened project's `project.fcproj`, manifest and view state, and
  the clips already kept on the device. This replaces today's single global recovery slot for
  signed-in use.
- **Starting offline:** when the network or the token service can't be reached, and this device has a
  remembered account, the sign-in screen offers **Continue offline as you@gmail.com**. The projects
  screen then lists projects on this device; ones whose clips aren't all local are marked (they open,
  with those clips offline). New Project works offline too and is created in Drive later.
- **Editing offline:** saves go to OPFS and are queued, imports are queued for upload, the header says
  "Offline — changes are kept on this device".
- **Back online:** the queue runs in order: new projects are created, project saves go through the
  normal version check (so a project also changed on another device meanwhile gets the three-choice
  conflict dialog, never a silent overwrite), then clip uploads.
- Offline mode is about convenience, not security: anyone using that browser profile can open its
  local copies, as with any local file. Sign out removes them.

### Errors you can act on

| Situation | What you see | What happens to your work |
|---|---|---|
| Offline (mid-session or at start) | "Offline — changes are kept on this device" | Saved on the device; syncs when back online |
| Google refused a token refresh | "Reconnect to Google Drive" button | Same as offline until reconnected |
| Token service unreachable but internet is up | Treated as offline, with "Retry" | Same as offline |
| Drive full | "Google Drive is full — uploads paused" with a link to Drive storage | Project still saves (it's small); clips wait |
| Clip deleted in Drive | That clip shows offline; Relink offered | Project unaffected |
| Popup blocked | Falls back to signing in in the same tab | — |
| Conflict | The three-choice dialog above | Nothing overwritten without asking |

### What the owner does once (we'll provide exact steps)

1. Create a Google Cloud project, enable the Google Drive API.
2. Set up the OAuth consent screen: External; app name Cutroom; scopes `openid`, `email`, `profile`,
   `drive.file`; then **Publish app** ("In production"). No Google review is needed for these scopes.
3. Create an OAuth client ID of type Web application with origins `https://cutroom-six-mu.vercel.app`
   and `http://localhost:8080`, and redirect URIs `https://cutroom-six-mu.vercel.app/api/auth/callback`
   and `http://localhost:8080/api/auth/callback`.
4. Give us the client ID (public). Put the client secret, and a cookie-encryption key we generate,
   into the Vercel project's environment variables yourself (we never see or commit them).

## Left to the builder

- Crate boundaries and names for the sync core; the exact manifest and local-index schemas (keep
  them versioned).
- How the token service is built and deployed on Vercel (Rust runtime, how `vercel.json` routes
  `/api/auth/*`, how local development runs it), and how the static web build and the functions ship
  together, without changing the shared CI workflows (repo rule: CI changes are their own task).
- Save interval, upload chunk size and concurrency, background-download order.
- How the projects screen looks within the existing Home/Import mode style.
- How Drive-backed entries plug into `fs.rs` (a new `Entry` kind is the obvious route).
- Whether recovery's existing OPFS media copies are reused as the upload source (preferred) or a
  separate store is kept.
- Testing approach beyond the native fake of Drive (e.g. a headless-browser run against a stub Drive
  served locally); real-Google checks are manual, with the owner's account.
