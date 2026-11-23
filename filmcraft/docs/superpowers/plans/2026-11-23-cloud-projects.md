# Cloud Projects (Google sign-in + Drive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Cutroom web app requires Google sign-in, keeps you signed in, and stores every project, its imported clips, where you left off and your settings in the user's own Google Drive, with offline editing and safe conflict handling between devices.

**Architecture:** All sync logic is a sans-IO state machine in a new pure-Rust crate `filmcraft-cloud` (L1): it emits Drive operations and app effects and consumes their results, so it is tested natively against an in-memory `FakeDrive`. A small Rust token service (`apps/cutroom-auth`, deployed as Vercel functions) holds Google's refresh token in an encrypted `HttpOnly` cookie. `crates/ui-egui` draws the sign-in screen, projects screen, sync status and dialogs from a `CloudView` snapshot and queues `CloudRequest`s; `apps/filmcraft-web` is thin glue that runs Drive HTTP calls, OPFS storage and Drive-backed media reads.

**Tech Stack:** Rust 2024 (wasm32 + native), egui 0.37, `web-sys`/`wasm-bindgen` 0.2.129, Google OAuth 2.0 authorization-code flow with PKCE, Google Drive REST v3 (resumable uploads, `alt=media` range reads), Vercel Rust functions, OPFS, `sha2`, `aes-gcm`, `ureq` (token service only), `egui_kittest` for headless UI tests.

**Spec:** `filmcraft/docs/superpowers/specs/2026-11-23-cloud-projects-design.md` (approved). Read it before any task.

## Global Constraints

- Rules in `filmcraft/AGENTS.md` apply to every line: no `unwrap`/`expect`/`panic!`/`unreachable!`/`todo!` outside tests; no `unsafe`; every input-derived number is hostile (`checked_*`, `get()`, bounded allocations); every interactive widget registers an automation id; new crates carry `[lints] workspace = true` and the crate-root `#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]`.
- Rust only. No new handwritten JavaScript or TypeScript in the app (existing `index.html` scripts stay as they are). The existing headless-browser test harness `apps/filmcraft-web/tests/smoke.mjs` is test code and may gain assertions (Task 12).
- New dependencies must be on the licence allowlist in `AGENTS.md`; prefer versions already in `Cargo.lock` (`sha2 0.10.9`, `aes-gcm 0.10.3`, `base64 0.23.1`, `ureq 3.5.0`, `getrandom 0.3.4`).
- Google scopes exactly: `openid email profile https://www.googleapis.com/auth/drive.file`. Nothing else.
- Drive layout exactly as the spec's "What's in Drive": `Cutroom/` root; per project `<Project name>/project.fcproj`, `cutroom-project.json`, `view-state.json`, `media/<clip>`; `Cutroom/settings.json`. Find files by Drive id and `appProperties` (`cutroomRoot`, `cutroomProject`, `cutroomMedia`, `cutroomSettings`), never by name.
- Secrets: `GOOGLE_CLIENT_ID` (public), `GOOGLE_CLIENT_SECRET` and `CUTROOM_COOKIE_KEY` (base64, 32 bytes) live only in Vercel environment variables / the developer's shell. Never in the repo, logs or errors.
- Privacy: access tokens, refresh tokens, emails, project names and clip names never appear in `log::` output, error strings that reach Sentry, or URLs. Errors that cross into logs carry Drive ids and HTTP status only.
- Host mode (`?host=parent`, `data-host="page"`), the desktop app and all existing headless tests keep today's behaviour: cloud is off when `FilmcraftApp::cloud` is `None`.
- `cargo xtask ci` before every commit; failures listed as environmental in the `cutroom-release` skill are the only acceptable ones. One task id per commit, prefix `CP<n>:`.
- **Plan decision (deviation from spec, flagged to the owner):** sign-in uses a same-tab redirect, not a popup. Sign-in always starts from the sign-in screen before a project is open, and Reconnect writes the OPFS snapshot before redirecting, so nothing is lost; this removes popup-blocker and `Cross-Origin-Opener-Policy` problems entirely.

## Review Focus

1. **A clip over 4 GiB, or a clip whose local copy is gone before its upload finished** (OPFS `KEEP_MAX` is 4 GiB; a tab reload loses the `File`): the clip stays in the project, its upload pauses as "needs the original file on <device>", nothing is dropped. Test in Task 3.
2. **The tab closes mid-upload or mid-save, or Drive's resumable session expired** (Drive returns 404/410 on the session): uploads resume from the confirmed offset, an expired session restarts that clip, and a save interrupted before Drive confirmed it is retried with the version check. Tests in Tasks 3 and 4.
3. **The project changed or was deleted on another device** (version mismatch; 404 on the project file or folder): never overwrite; mismatch gives the three-choice conflict, deletion gives "This project was deleted from Drive — Save as a new project". Tests in Task 4.
4. **Access token expires or is revoked mid-session** (Drive 401): one refresh and one retry of the same op; a refused refresh moves to NeedsReconnect with every op kept queued and work saved locally. Test in Task 5.
5. **Hostile or odd data from Drive or OPFS**: corrupt/oversized `cutroom-project.json`, `view-state.json`, `settings.json` or local index; project names with `/`, `..`, emoji, 500 characters, or duplicates. Errors, never panics; names never become OPFS paths (paths use Drive ids). Tests in Tasks 1 and 5.

---

## File Structure

```
filmcraft/crates/cloud/                    NEW  filmcraft-cloud (layer 1): pure sync logic, no IO
  Cargo.toml
  src/lib.rs                               re-exports, crate lints
  src/model.rs                             ProjectManifest, MediaEntry, ViewState, LocalIndex, SettingsFile (versioned serde, bounded parse)
  src/fingerprint.rs                       Fingerprint
  src/drive.rs                             DriveOp, DriveReply, DriveError, FileId, OpId, Meta, Tag
  src/fake.rs                              FakeDrive (feature "fake" + tests)
  src/uploads.rs                           UploadQueue
  src/project_sync.rs                      ProjectSync (save, version check, conflict, open)
  src/session.rs                           CloudSession (requests → effects, offline, token state)
  src/view.rs                              CloudView, CloudRequest, SyncStatus, AccountState, ProjectRow, ConflictPrompt, ConflictChoice
  tests/it/{main,model,uploads,project_sync,session}.rs
filmcraft/apps/cutroom-auth/               NEW  token service logic + Vercel function binaries
  Cargo.toml
  src/lib.rs                               handlers as pure fns: start, callback, token, signout
  src/cookie.rs                            AES-256-GCM sealed cookies
  src/google.rs                            GoogleClient trait + ureq impl
  api/auth/{start,callback,token,signout}.rs   Vercel entry points (thin)
  tests/it/main.rs
filmcraft/crates/ui-egui/src/cloud_ui.rs   NEW  sign-in screen, projects list, conflict/recovered dialogs
filmcraft/crates/ui-egui/src/header.rs     MOD  sync status indicator in the right cluster
filmcraft/crates/ui-egui/src/lib.rs        MOD  FilmcraftApp::{cloud, cloud_requests}, capture/apply view state
filmcraft/crates/ui-egui/src/menus.rs      MOD  account.* / cloud.* UI commands
filmcraft/crates/ui-egui/src/panels/import_mode.rs  MOD  Home shows Drive projects when cloud is on
filmcraft/crates/ui-egui/tests/it/cloud_ui.rs NEW headless tests
filmcraft/apps/filmcraft-web/src/cloud/    NEW  auth.rs, drive_http.rs, store.rs, controller.rs, mod.rs
filmcraft/apps/filmcraft-web/src/fs.rs     MOD  Entry::Drive + range fetch with token
filmcraft/apps/filmcraft-web/src/lib.rs    MOD  startup gate, controller in logic()
filmcraft/xtask/src/main.rs                MOD  LAYERS += ("cloud", 1); `web --serve` routes /api/auth/* to cutroom-auth
filmcraft/docs/architecture.md, docs/web.md, docs/cloud-setup.md   MOD/NEW
cutroom-web/vercel.json, .github/workflows/cutroom.yml (repo root)  MOD  ship functions
```

---

### Task 1: `filmcraft-cloud` crate with versioned data model and fingerprint

**Files:**
- Create: `crates/cloud/Cargo.toml`, `crates/cloud/src/{lib,model,fingerprint}.rs`, `crates/cloud/tests/it/{main,model}.rs`
- Modify: `Cargo.toml` (workspace dep `filmcraft-cloud = { path = "crates/cloud" }`), `xtask/src/main.rs` (`LAYERS`: `("cloud", 1)`), `docs/architecture.md` §1 (row: `cloud | L1 | Google Drive sync state machines, no IO`)

**Interfaces:**
- Produces (in `filmcraft_cloud::model`):
  - `pub const FORMAT_VERSION: u32 = 1;`
  - `pub const MAX_DOC_BYTES: usize = 4 << 20;` (largest manifest/view/settings/index parsed)
  - `pub struct ProjectManifest { pub version: u32, pub name: String, pub media: BTreeMap<String, MediaEntry> }` keyed by media path (`/files/<name>`)
  - `pub struct MediaEntry { pub file: Option<FileId>, pub size: u64, pub fingerprint: Fingerprint, pub state: UploadState }`, `pub enum UploadState { Pending, Uploaded, NeedsSource }`
  - `pub struct ViewState { pub version: u32, pub workspace: String, pub active_sequence: Option<String>, pub sequences: Vec<SequenceView> }`, `pub struct SequenceView { pub id: String, pub playhead_ticks: i64, pub in_ticks: Option<i64>, pub out_ticks: Option<i64>, pub zoom: f32 }`
  - `pub struct SettingsFile { pub version: u32, pub prefs: serde_json::Value }`
  - `pub struct LocalIndex { pub version: u32, pub account: Account, pub root: Option<FileId>, pub projects: Vec<LocalProject>, pub uploads: UploadQueue /* Task 3 */, pub pending_saves: Vec<PendingSave> /* Task 4 */ }`, `pub struct Account { pub sub: String, pub email: String }`, `pub struct LocalProject { pub id: ProjectId, pub folder: Option<FileId>, pub project_file: Option<FileId>, pub name: String, pub base_version: Option<u64>, pub modified_ms: i64, pub clips_local: bool }`, `pub struct ProjectId(pub String)` (Drive folder id, or `local-<uuid>` before creation)
  - `pub fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ModelError>` — refuses `> MAX_DOC_BYTES`, refuses `version > FORMAT_VERSION` with `ModelError::TooNew`
  - (Task 1 defines `LocalIndex` with only `version, account, root, projects`; Tasks 3–4 add their fields with `#[serde(default)]`.)
- Produces (in `filmcraft_cloud::fingerprint`): `pub struct Fingerprint(pub [u8; 32])` (serde as hex), `pub fn fingerprint(size: u64, head: &[u8], tail: &[u8]) -> Fingerprint` = SHA-256 of `size` (u64 LE) ‖ first ≤1 MiB ‖ last ≤1 MiB; `pub const SAMPLE: usize = 1 << 20;`
- `FileId` comes from Task 2; define it in `drive.rs` now as `pub struct FileId(pub String)` (serde transparent) so Task 1 compiles.

- [ ] **Step 1: Write the failing tests** in `crates/cloud/tests/it/model.rs`

```rust
#[test] fn manifest_round_trips_and_is_versioned() {
    let m = ProjectManifest { version: FORMAT_VERSION, name: "Trip / 2026 🎬".into(), media: BTreeMap::from([("/files/a.mp4".into(),
        MediaEntry { file: None, size: 10, fingerprint: fingerprint(10, b"abc", b"abc"), state: UploadState::Pending })]) };
    let bytes = serde_json::to_vec(&m).unwrap();
    assert_eq!(parse::<ProjectManifest>(&bytes).unwrap(), m);
}
#[test] fn newer_format_is_refused_not_misread() {
    assert!(matches!(parse::<ProjectManifest>(br#"{"version":2,"name":"x","media":{}}"#), Err(ModelError::TooNew(2))));
}
#[test] fn hostile_documents_are_errors() {
    assert!(parse::<ProjectManifest>(&vec![b' '; MAX_DOC_BYTES + 1]).is_err());
    for junk in [&b""[..], b"{", b"null", br#"{"version":1,"name":5}"#, br#"{"version":-1}"#] {
        assert!(parse::<ProjectManifest>(junk).is_err()); assert!(parse::<LocalIndex>(junk).is_err());
        assert!(parse::<ViewState>(junk).is_err()); assert!(parse::<SettingsFile>(junk).is_err());
    }
}
#[test] fn fingerprint_depends_on_size_head_and_tail() {
    let a = fingerprint(100, b"head", b"tail");
    assert_ne!(a, fingerprint(101, b"head", b"tail"));
    assert_ne!(a, fingerprint(100, b"heaD", b"tail"));
    assert_ne!(a, fingerprint(100, b"head", b"taiL"));
    assert_eq!(a, fingerprint(100, b"head", b"tail"));
}
```

- [ ] **Step 2: Run** `cargo test -p filmcraft-cloud` — Expected: FAIL (crate does not exist / items undefined).
- [ ] **Step 3: Implement** the crate and items above. `Cargo.toml` deps: `serde`, `serde_json`, `thiserror`, `sha2`; feature `fake = []`. `ModelError` (thiserror): `TooLarge(usize)`, `TooNew(u32)`, `Invalid(String)` — the `Invalid` text is serde's message, which never contains document content beyond a byte position.
- [ ] **Step 4: Run** `cargo test -p filmcraft-cloud` and `cargo xtask layers` — Expected: PASS, `layers: ok`.
- [ ] **Step 5: Commit** `CP1: filmcraft-cloud crate with versioned manifest, view state, settings and local index`

---

### Task 2: Sans-IO Drive protocol and `FakeDrive`

**Files:**
- Create: `crates/cloud/src/drive.rs` (complete), `crates/cloud/src/fake.rs`
- Test: `crates/cloud/tests/it/main.rs` (fake drive behaviour tests in a `fake_drive` module)

**Interfaces:**
- Produces (`filmcraft_cloud::drive`):
  - `pub struct OpId(pub u64)`, `pub struct Meta { pub id: FileId, pub name: String, pub version: u64, pub modified_ms: i64, pub size: u64 }`, `pub enum Tag { Root, Project, Media, Settings, None }` (maps to `appProperties`)
  - `pub enum DriveOp { FindRoot, CreateRoot, ListProjects { root: FileId }, CreateFolder { parent: FileId, name: String, tag: Tag }, GetMeta { file: FileId }, Download { file: FileId }, Find { parent: FileId, tag: Tag }, CreateFile { parent: FileId, name: String, tag: Tag, mime: String, bytes: Vec<u8> }, UpdateFile { file: FileId, bytes: Vec<u8> }, StartUpload { parent: FileId, name: String, size: u64, mime: String }, UploadChunk { session: String, media: String, offset: u64, len: u64, total: u64 }, QueryUpload { session: String, total: u64 }, Rename { file: FileId, name: String }, Trash { file: FileId } }` — `UploadChunk.media` is the media path; the executor reads `len` bytes at `offset` from its local copy.
  - `pub enum DriveReply { Found(Option<Meta>), Created(Meta), Projects(Vec<Meta>), Meta(Meta), Bytes(Vec<u8>), Session(String), Progress { confirmed: u64 }, Uploaded(Meta), Done }`
  - `pub enum DriveError { Offline, Unauthorized, QuotaFull, NotFound, SessionGone, SourceMissing, RateLimited, Http(u16), Malformed }` with `fn retryable(&self) -> bool` (`Offline | RateLimited | Http(500..=599)`)
  - `pub const UPLOAD_CHUNK: u64 = 8 << 20;` (multiple of 256 KiB, as Drive requires)
- Produces (`filmcraft_cloud::fake`, behind `cfg(any(test, feature = "fake"))`): `pub struct FakeDrive`, `impl FakeDrive { pub fn new() -> Self; pub fn run(&mut self, op: &DriveOp, local: &dyn Fn(&str, u64, u64) -> Option<Vec<u8>>) -> Result<DriveReply, DriveError>; pub fn set_offline(&mut self, on: bool); pub fn set_quota(&mut self, bytes: u64); pub fn expire_sessions(&mut self); pub fn bump_version(&mut self, file: &FileId); pub fn delete(&mut self, file: &FileId); pub fn file_bytes(&self, file: &FileId) -> Option<&[u8]>; pub fn find_by_name(&self, parent: &FileId, name: &str) -> Option<Meta>; pub fn fail_next(&mut self, e: DriveError); }`. Versions increase by 1 on every write, like Drive's `version`.

- [ ] **Step 1: Write failing tests** for the fake: create root → create project folder → `CreateFile` then `UpdateFile` bumps `version` 1→2; `StartUpload`+`UploadChunk`s assemble exactly the local bytes and reply `Uploaded(meta.size == total)`; `set_quota(5)` makes a 10-byte upload fail `QuotaFull`; `expire_sessions()` makes the next `UploadChunk` fail `SessionGone`; `set_offline(true)` fails every op with `Offline`; `UploadChunk` whose `local` callback returns `None` fails `SourceMissing`.
- [ ] **Step 2: Run** `cargo test -p filmcraft-cloud fake_drive` — Expected: FAIL.
- [ ] **Step 3: Implement** `drive.rs` and `fake.rs` (in-memory tree of `Meta` + bytes; upload sessions keyed by a counter string).
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** `CP2: Drive operation protocol and in-memory FakeDrive`

---

### Task 3: `UploadQueue` (resumable, deduplicated, persisted)

**Files:**
- Create: `crates/cloud/src/uploads.rs`; Test: `crates/cloud/tests/it/uploads.rs`
- Modify: `crates/cloud/src/model.rs` (`LocalIndex.uploads: UploadQueue`, `#[serde(default)]`)

**Interfaces:**
- Consumes: Task 2 `DriveOp::{StartUpload, UploadChunk, QueryUpload}`, `DriveReply`, `DriveError`, `UPLOAD_CHUNK`; Task 1 `Fingerprint`, `ProjectId`.
- Produces: `pub struct UploadQueue` (serde; persisted inside `LocalIndex`); `pub const MAX_ACTIVE: usize = 2;` `pub const BACKOFF_START_S: f64 = 2.0; pub const BACKOFF_MAX_S: f64 = 60.0;`
  - `pub fn enqueue(&mut self, project: &ProjectId, media: &str, size: u64, fp: Fingerprint, parent: FileId)` — a fingerprint already uploaded or queued for the same project is not uploaded twice
  - `pub fn poll(&mut self, now: f64, online: bool, next_id: &mut u64) -> Vec<(OpId, DriveOp)>`
  - `pub fn complete(&mut self, id: OpId, r: Result<DriveReply, DriveError>, now: f64) -> Vec<UploadEvent>`
  - `pub enum UploadEvent { Uploaded { project: ProjectId, media: String, file: Meta }, QuotaFull, NeedsSource { project: ProjectId, media: String }, Unauthorized(OpId) }`
  - `pub fn resume_source(&mut self, project: &ProjectId, media: &str)` (the original file is available again)
  - `pub fn progress(&self) -> UploadProgress { pub clips_left: usize, pub bytes_done: u64, pub bytes_total: u64 }`

- [ ] **Step 1: Write failing tests** (drive the queue against `FakeDrive` with a helper `pump(queue, drive, local, now)` that runs every polled op and feeds results back):

```rust
#[test] fn uploads_a_clip_in_chunks_and_reports_it() { /* 20 MiB local clip → 3 UploadChunk ops; Uploaded event; drive bytes == local */ }
#[test] fn same_fingerprint_twice_uploads_once() { /* two enqueues, one StartUpload */ }
#[test] fn at_most_two_clips_upload_at_once() { /* 5 clips enqueued → polled StartUploads ≤ MAX_ACTIVE */ }
#[test] fn reload_mid_upload_resumes_from_confirmed_offset() {
    // run one chunk, serialize the queue (serde_json), deserialize into a new queue,
    // first op polled is QueryUpload; after it, the next UploadChunk.offset == UPLOAD_CHUNK
}
#[test] fn expired_session_restarts_that_clip() { /* drive.expire_sessions() → SessionGone → next poll StartUpload, final bytes correct */ }
#[test] fn missing_source_pauses_without_dropping_the_clip() {
    // local callback returns None → NeedsSource event; progress().clips_left == 1; resume_source → completes
}
#[test] fn quota_full_pauses_all_uploads_and_retries_after_backoff() { /* QuotaFull event; no ops before now+BACKOFF_START_S */ }
#[test] fn offline_polls_nothing_and_resumes_when_online() {}
#[test] fn unauthorized_is_reported_once_and_the_op_is_retried_not_lost() {}
```

- [ ] **Step 2: Run** `cargo test -p filmcraft-cloud uploads` — Expected: FAIL.
- [ ] **Step 3: Implement** per-clip state `Queued → Starting → Sending { session, confirmed } → Done`, plus `Paused(NeedsSource)` and a queue-wide `backoff_until`. Backoff doubles from `BACKOFF_START_S` to `BACKOFF_MAX_S` on retryable errors and resets on success. Ops in flight are not persisted as in flight: after deserialize, a `Sending` clip starts with `QueryUpload`.
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** `CP3: resumable, deduplicated upload queue`

---

### Task 4: `ProjectSync` (open, save with version check, conflicts, deletion)

**Files:**
- Create: `crates/cloud/src/project_sync.rs`; Test: `crates/cloud/tests/it/project_sync.rs`
- Modify: `crates/cloud/src/model.rs` (`PendingSave { project: ProjectId, revision: u64 }`, `LocalIndex.pending_saves`)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `pub struct ProjectSync` (one per open project), `pub fn open(project: LocalProject) -> Self`
  - `pub fn load(&mut self, next_id: &mut u64) -> Vec<(OpId, DriveOp)>` (Download project file, manifest, view state)
  - `pub fn save(&mut self, revision: u64, project: Vec<u8>, manifest: &ProjectManifest)` (queues; a newer save replaces an unsent older one)
  - `pub fn save_view(&mut self, view: &ViewState)` (no version check, last write wins)
  - `pub fn poll(&mut self, now: f64, online: bool, next_id: &mut u64) -> Vec<(OpId, DriveOp)>` — a save is `GetMeta { project_file }` then, only if `meta.version == base_version`, `UpdateFile`; manifest written after the project file succeeds
  - `pub fn complete(&mut self, id: OpId, r: Result<DriveReply, DriveError>, now: f64) -> Vec<SyncEvent>`
  - `pub enum SyncEvent { Loaded { project: Vec<u8>, manifest: ProjectManifest, view: Option<ViewState> }, Saved { revision: u64 }, Conflict { remote_modified_ms: i64 }, Deleted, Copied(LocalProject), Unauthorized(OpId), Failed(DriveError) }`
  - `pub fn resolve(&mut self, choice: ConflictChoice)` — `KeepMine` (re-base on the remote version and save), `UseTheirs` (emit `load` ops), `SaveCopy` (creates a new project folder named `"<name> (copy)"` and saves there; returns the new `LocalProject` through `SyncEvent::Copied(LocalProject)`)
  - `pub fn local(&self) -> &LocalProject`

- [ ] **Step 1: Write failing tests:**

```rust
#[test] fn save_updates_drive_and_base_version() {}
#[test] fn stale_version_gives_conflict_and_writes_nothing() {
    // drive.bump_version(project_file) → save → events contain Conflict; drive bytes unchanged
}
#[test] fn keep_mine_overwrites_after_conflict() {}
#[test] fn use_theirs_reloads_remote_bytes() {}
#[test] fn save_copy_creates_new_project_and_leaves_remote_untouched() {}
#[test] fn deleted_project_reports_deleted_not_failed() { /* drive.delete(folder) → GetMeta NotFound → Deleted */ }
#[test] fn view_state_save_never_conflicts() { /* bump_version on view file → save_view still writes */ }
#[test] fn offline_save_is_kept_and_sent_once_online() {}
#[test] fn newer_save_replaces_unsent_older_one() { /* save(r1), save(r2) while offline → one UpdateFile with r2's bytes */ }
```

- [ ] **Step 2: Run** `cargo test -p filmcraft-cloud project_sync` — Expected: FAIL.
- [ ] **Step 3: Implement.** A save interrupted before `UpdateFile` succeeded stays queued (and in `LocalIndex.pending_saves` when the session persists it, Task 5).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `CP4: project open/save with version check and conflict resolution`

---

### Task 5: `CloudSession` and the UI contract (`CloudView`, `CloudRequest`)

**Files:**
- Create: `crates/cloud/src/{session,view}.rs`; Test: `crates/cloud/tests/it/session.rs`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces (`filmcraft_cloud::view`, all `Clone + Debug + PartialEq + Serialize + Deserialize`):
  - `pub enum AccountState { SignedOut { offline_as: Option<String> }, Online { email: String }, Offline { email: String }, NeedsReconnect { email: String } }` (`offline_as`: email of a remembered account when the network/token service is unreachable)
  - `pub enum SyncStatus { Idle, Saved, Saving, Uploading { clips: usize, percent: u8 }, Offline, Reconnect, DriveFull, NeedsOriginal { clips: usize }, Error(String) }`
  - `pub struct ProjectRow { pub id: ProjectId, pub name: String, pub modified_ms: i64, pub on_device: bool, pub clips_on_device: bool }`
  - `pub struct ConflictPrompt { pub project: String, pub remote_modified_ms: i64 }`, `pub enum ConflictChoice { KeepMine, UseTheirs, SaveCopy }`
  - `pub struct CloudView { pub account: AccountState, pub projects: Vec<ProjectRow>, pub open: Option<ProjectId>, pub status: SyncStatus, pub conflict: Option<ConflictPrompt>, pub deleted_remotely: bool, pub recovered: Option<String>, pub loading: bool }`
  - `pub enum CloudRequest { SignIn, ContinueOffline, SignOut, Reconnect, Retry, NewProject { name: String }, OpenProject { id: ProjectId }, OpenDemo, RenameProject { id: ProjectId, name: String }, DeleteProject { id: ProjectId }, Resolve(ConflictChoice), SaveAsNewProject, KeepRecovered(bool), ImportProjectFile { name: String, bytes: Vec<u8> } }`
- Produces (`filmcraft_cloud::session`):
  - `pub enum TokenState { Valid { sub: String, email: String }, SignedOut, Unreachable, Refused }`
  - `pub enum Effect { Drive(OpId, DriveOp), LoadProject { project: Vec<u8>, manifest: ProjectManifest, view: Option<ViewState> }, OpenDemo, PersistIndex(Vec<u8>), WriteLocalProject { id: ProjectId, project: Vec<u8> }, ForgetAccount { sub: String }, Navigate(String), RefreshToken, KeepMediaLocal { media: String, file: FileId, size: u64 }, ApplySettings(serde_json::Value), Status(String) }` — `Navigate` targets are exactly `/api/auth/start` and `/api/auth/signout` (the shell does a same-tab `location.assign`)
  - `pub struct CloudSession`; `pub fn new(index: Option<LocalIndex>) -> Self`; `pub fn token(&mut self, t: TokenState, now: f64)`; `pub fn request(&mut self, r: CloudRequest, now: f64)`; `pub fn project_dirty(&mut self, revision: u64, project: Vec<u8>, now: f64)`; `pub fn media_imported(&mut self, media: &str, size: u64, fp: Fingerprint)`; `pub fn view_changed(&mut self, v: ViewState, now: f64)`; `pub fn settings_changed(&mut self, prefs: serde_json::Value, now: f64)`; `pub fn complete(&mut self, id: OpId, r: Result<DriveReply, DriveError>, now: f64)`; `pub fn poll(&mut self, now: f64) -> Vec<Effect>`; `pub fn view(&self) -> CloudView`
  - Timing constants: `pub const SAVE_DEBOUNCE_S: f64 = 3.0; pub const VIEW_DEBOUNCE_S: f64 = 3.0; pub const SETTINGS_DEBOUNCE_S: f64 = 3.0;`

- [ ] **Step 1: Write failing tests** (a harness runs `poll()` effects: `Drive` ops through `FakeDrive`, others recorded):

```rust
#[test] fn signed_out_shows_sign_in_and_sign_in_navigates() { /* view().account == SignedOut{offline_as:None}; request(SignIn) → Effect::Navigate("/api/auth/start") */ }
#[test] fn first_sign_in_creates_root_once() { /* token(Valid) → FindRoot → CreateRoot; second session with the same drive finds it */ }
#[test] fn projects_list_newest_first() {}
#[test] fn new_project_creates_folder_media_and_files() { /* NewProject{name:"a/../b 🎬"} → Drive names keep the text; no Effect path contains it */ }
#[test] fn unreachable_with_remembered_account_offers_offline() { /* new(Some(index)); token(Unreachable) → SignedOut{offline_as:Some(email)}; ContinueOffline → Offline{email}, projects from index */ }
#[test] fn offline_edits_sync_when_back_online() { /* Offline → project_dirty → no Drive ops; token(Valid) → save goes up with version check */ }
#[test] fn offline_new_project_is_created_in_drive_later() {}
#[test] fn unauthorized_refreshes_once_then_retries_the_same_op() { /* fail_next(Unauthorized) → Effect::RefreshToken; token(Valid) → op re-sent, succeeds */ }
#[test] fn refused_refresh_needs_reconnect_and_keeps_everything_queued() {}
#[test] fn conflict_surfaces_in_view_and_resolves() {}
#[test] fn import_project_file_becomes_a_drive_project() {}
#[test] fn open_demo_creates_nothing_until_saved() {}
#[test] fn sign_out_forgets_account_and_navigates() { /* Effect::ForgetAccount{sub} then Navigate("/api/auth/signout") */ }
#[test] fn corrupt_index_starts_signed_out_without_panicking() { /* new(None) after parse error path */ }
#[test] fn status_reports_uploads_quota_and_needs_original() {}
```

- [ ] **Step 2: Run** `cargo test -p filmcraft-cloud session` — Expected: FAIL.
- [ ] **Step 3: Implement** `CloudSession` owning `LocalIndex`, one optional `ProjectSync`, the `UploadQueue`, a debounced settings writer (`Cutroom/settings.json`, tag `Settings`, created on first change) and the op-id counter; emit `PersistIndex` whenever the index changes. On a fresh `Valid` token after `SignedOut`, download `settings.json` and emit `ApplySettings`. `Uploaded` events update the open project's manifest and queue a manifest save. After `Loaded`, emit `KeepMediaLocal` for every uploaded clip not on the device.
- [ ] **Step 4: Run** `cargo test -p filmcraft-cloud` — Expected: PASS (all tasks so far).
- [ ] **Step 5: Commit** `CP5: CloudSession tying sign-in, projects, saves, uploads and offline together`

---

### Task 6: Token service logic (`apps/cutroom-auth`)

**Files:**
- Create: `apps/cutroom-auth/Cargo.toml`, `src/{lib,cookie,google}.rs`, `tests/it/main.rs`
- Modify: `xtask/src/main.rs` (`LAYERS`: `("cutroom-auth", 6)`)

**Interfaces:**
- Produces (`cutroom_auth`):
  - `pub struct Config { pub client_id: String, pub client_secret: String, pub cookie_key: [u8; 32], pub origin: String }` — `pub fn from_env() -> Result<Config, AuthError>` reading `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CUTROOM_COOKIE_KEY`, `CUTROOM_ORIGIN`
  - `pub struct Req { pub method: String, pub path: String, pub query: Vec<(String, String)>, pub headers: Vec<(String, String)> }`, `pub struct Resp { pub status: u16, pub headers: Vec<(String, String)>, pub body: Vec<u8> }`
  - `pub trait GoogleClient { fn exchange_code(&self, code: &str, verifier: &str, redirect_uri: &str) -> Result<Tokens, AuthError>; fn refresh(&self, refresh_token: &str) -> Result<Tokens, AuthError>; fn revoke(&self, token: &str) -> Result<(), AuthError>; }`, `pub struct Tokens { pub access_token: String, pub expires_in: u64, pub refresh_token: Option<String>, pub id_token: Option<String> }`, `pub struct UreqGoogle` (real impl, `https://oauth2.googleapis.com/token`, `https://oauth2.googleapis.com/revoke`)
  - `pub fn handle(cfg: &Config, google: &dyn GoogleClient, req: &Req) -> Resp` routing:
    - `GET /api/auth/start` → 302 to `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`, `client_id`, `redirect_uri=<origin>/api/auth/callback`, `scope` (exact Global Constraints string), `access_type=offline`, `prompt=consent select_account`, `code_challenge` (S256), `state`; sets sealed cookie `__Host-cutroom_oauth` = `{state, verifier}` (`Max-Age=600`)
    - `GET /api/auth/callback?code&state` → state must match the oauth cookie; exchange; read `sub`/`email` from the ID token payload (base64url JSON; signature not needed, it came straight from Google's token endpoint over TLS); set `__Host-cutroom_rt` sealed `{refresh_token, sub, email}` (`Max-Age=34560000`); clear oauth cookie; 302 to `/`. Any failure → 302 to `/?signin=failed`.
    - `POST /api/auth/token` (requires header `X-Cutroom: 1`) → 200 `{"access_token","expires_in","sub","email"}`; no/invalid cookie → 401 `{"error":"signed_out"}` and clears the cookie; Google `invalid_grant` → 401 `{"error":"refused"}` and clears the cookie
    - `POST /api/auth/signout` (requires `X-Cutroom: 1`) → revoke (ignore failure), clear cookie, 204
    - all cookies `Path=/; Secure; HttpOnly; SameSite=Lax` for `__Host-cutroom_oauth` (it must survive Google's redirect back) and `SameSite=Strict` for `__Host-cutroom_rt`; responses `Cache-Control: no-store`
  - `cookie::seal(key: &[u8; 32], plain: &[u8]) -> String` / `cookie::open(key: &[u8; 32], sealed: &str) -> Option<Vec<u8>>` — AES-256-GCM, random 96-bit nonce, base64url(nonce ‖ ciphertext)

- [ ] **Step 1: Write failing tests** with a `FakeGoogle` (records calls, returns canned tokens):

```rust
#[test] fn start_redirects_to_google_with_pkce_and_exact_scopes() { /* Location host accounts.google.com; scope == "openid email profile https://www.googleapis.com/auth/drive.file"; code_challenge_method=S256 */ }
#[test] fn callback_with_wrong_state_sets_no_session() {}
#[test] fn callback_sets_refresh_cookie_and_redirects_home() {}
#[test] fn token_without_custom_header_is_403() {}
#[test] fn token_returns_access_token_from_cookie() {}
#[test] fn invalid_grant_clears_cookie_and_says_refused() {}
#[test] fn tampered_or_foreign_cookie_is_signed_out() { /* flip a byte; cookie sealed with another key */ }
#[test] fn responses_never_contain_the_refresh_token_or_secret() { /* body/headers of every route scanned for the canned refresh token and client secret, except the sealed Set-Cookie */ }
#[test] fn hostile_requests_are_400_not_panics() { /* huge query, non-UTF-8-ish values, missing params, unknown path → 404 */ }
```

- [ ] **Step 2: Run** `cargo test -p cutroom-auth` — Expected: FAIL.
- [ ] **Step 3: Implement.** Deps: `aes-gcm`, `sha2`, `base64`, `getrandom`, `serde`, `serde_json`, `ureq` (rustls), `thiserror`, `url`. `AuthError` never formats tokens or secrets.
- [ ] **Step 4: Run** `cargo test -p cutroom-auth` and `cargo xtask layers` — Expected: PASS.
- [ ] **Step 5: Commit** `CP6: token service logic with sealed refresh-token cookie`

---

### Task 7: Ship the token service (Vercel functions + local dev routes)

**Files:**
- Create: `apps/cutroom-auth/api/auth/{start,callback,token,signout}.rs` (each: build `Req` from the Vercel request, `cutroom_auth::handle(&Config::from_env()?, &UreqGoogle, &req)`, map `Resp` back; on `Config` error return 500 with `{"error":"not_configured"}`)
- Modify: `cutroom-web/vercel.json` (functions runtime + `/api/auth/*` routes), `.github/workflows/cutroom.yml` (repo root: copy the function sources into the deployed folder), `xtask/src/main.rs` (`web --serve`: requests under `/api/auth/` go to `cutroom_auth::handle` with `Config::from_env()` and `CUTROOM_ORIGIN=http://localhost:<port>`)

**Interfaces:**
- Consumes: Task 6 `handle`, `Config`, `UreqGoogle`, `Req`, `Resp`.
- Produces: live endpoints `https://cutroom-six-mu.vercel.app/api/auth/{start,callback,token,signout}` and the same on `cargo xtask web --serve 8080`.

- [ ] **Step 1: Check the runtime.** Look up the current Vercel community Rust runtime (`vercel-rust` on npm, crate `vercel_runtime`), confirm its licence is on the allowlist, and pin exact versions in `vercel.json` and `Cargo.toml`. If it cannot build on the `cutroom` project, stop and report to the owner before trying any other language.
- [ ] **Step 2: Write the failing check:** `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Cutroom: 1' http://localhost:8080/api/auth/token` while `cargo xtask web --serve 8080` runs with the env vars set to dummy values — Expected now: `404`.
- [ ] **Step 3: Implement** the xtask routing and the four function entry points; wire `vercel.json` and the workflow.
- [ ] **Step 4: Verify locally:** the curl above prints `401`; `curl -sI http://localhost:8080/api/auth/start` shows `302` and a `Location: https://accounts.google.com/...`.
- [ ] **Step 5: Deploy** (push; CI deploys per the `cutroom-release` skill) and verify: `curl -s -X POST -H 'X-Cutroom: 1' https://cutroom-six-mu.vercel.app/api/auth/token` prints `{"error":"not_configured"}` until the owner sets the env vars, then `{"error":"signed_out"}`. The app itself is unchanged and still loads (title "Cutroom").
- [ ] **Step 6: Commit** `CP7: deploy the token service as Vercel functions and serve it locally`

---

### Task 8: UI — sign-in screen, projects list, sync status, dialogs, commands

**Files:**
- Create: `crates/ui-egui/src/cloud_ui.rs`; Test: `crates/ui-egui/tests/it/cloud_ui.rs` (+ `mod cloud_ui;` in `tests/it/main.rs`)
- Modify: `crates/ui-egui/Cargo.toml` (dep `filmcraft-cloud`), `src/lib.rs` (fields + calls), `src/header.rs` (status), `src/menus.rs` (commands), `src/panels/import_mode.rs` (Drive projects instead of Recent when cloud is on)

**Interfaces:**
- Consumes: Task 5 `CloudView`, `CloudRequest`, `AccountState`, `SyncStatus`, `ConflictChoice`.
- Produces on `FilmcraftApp`: `pub cloud: Option<filmcraft_cloud::view::CloudView>` (default `None` = today's behaviour), `pub cloud_requests: Vec<filmcraft_cloud::view::CloudRequest>` (drained by the host each frame).
- Commands (in `UI_COMMANDS`, empty menu path unless noted; each pushes the matching `CloudRequest`): `account.signIn`, `account.continueOffline`, `account.reconnect`, `account.signOut` (menu `["File"]`, label "Sign Out"), `cloud.newProject` {name}, `cloud.openProject` {id}, `cloud.openDemo`, `cloud.renameProject` {id, name}, `cloud.deleteProject` {id}, `cloud.resolveConflict` {choice: "keepMine"|"useTheirs"|"saveCopy"}, `cloud.saveAsNewProject`, `cloud.keepRecovered` {keep: bool}, `cloud.retry`. All return an error when `app.cloud` is `None`.
- Automation ids: `cloud.signIn`, `cloud.continueOffline`, `cloud.newProject`, `cloud.openDemo`, `cloud.project.<index>` (row), `cloud.project.<index>.rename`, `cloud.project.<index>.delete`, `cloud.conflict.keepMine|useTheirs|saveCopy`, `cloud.recovered.keep|discard`, `cloud.deleted.saveAsNew`, `header.syncStatus`, `header.reconnect`.
- Copy (exact, through `tl!`): "Sign in with Google", "Continue offline as {email}", "Your projects", "New Project", "Open the demo project", "On this device", "Saved to Drive", "Saving…", "Uploading {clips} clips, {percent}%", "Offline — changes are kept on this device", "Reconnect to Google Drive", "Google Drive is full — uploads paused", "{clips} clips need the original file", "This project changed on another device", "Keep mine", "Use the other device's", "Save mine as a copy", "This project was deleted from Drive", "Save as a new project", "Keep the unsaved work found in this browser as a new project?".

- [ ] **Step 1: Write failing headless tests** (Driver pattern of `tests/it/header_layout_ui.rs`; set `app.cloud = Some(view)` directly):

```rust
#[test] fn signed_out_shows_only_the_sign_in_screen() { /* ids: cloud.signIn present; no "menu.File", no "header.mode.edit" */ }
#[test] fn sign_in_click_queues_request() { /* ui.click cloud.signIn → app.cloud_requests == [CloudRequest::SignIn] */ }
#[test] fn offline_offer_shows_email_and_queues_continue_offline() {}
#[test] fn projects_list_rows_open_projects() { /* 3 rows, newest first; click cloud.project.1 → OpenProject{id of row 1} */ }
#[test] fn conflict_dialog_offers_three_choices() {}
#[test] fn status_shows_in_header_without_overlapping_at_800() { /* status Uploading; reuse header overlap assertion incl. header.syncStatus at 800 px */ }
#[test] fn commands_without_cloud_are_errors_and_ui_is_unchanged() { /* cloud None → "account.signIn" errors; header ids identical to before */ }
#[test] fn every_cloud_widget_has_an_automation_id() { /* each id listed above appears in its screen state */ }
```

- [ ] **Step 2: Run** `cargo test -p filmcraft-ui-egui --test it cloud_ui` — Expected: FAIL.
- [ ] **Step 3: Implement.** Sign-in screen covers the whole window when `account` is `SignedOut`; when signed in (Online/Offline/NeedsReconnect) the app is normal and Home (`Mode::Import`) lists `CloudView.projects` with New Project and Open the demo project. The header status sits left of the quick actions and takes part in the layout from the header fix (it reduces `right_end`), so the existing `header_layout_ui` tests keep passing.
- [ ] **Step 4: Run** `cargo test -p filmcraft-ui-egui --test it` — Expected: PASS (including `header_layout_ui`).
- [ ] **Step 5: Commit** `CP8: sign-in screen, Drive projects list, sync status and dialogs`

---

### Task 9: UI — capture and apply "where you left off"

**Files:**
- Modify: `crates/ui-egui/src/lib.rs`; Test: `crates/ui-egui/tests/it/cloud_ui.rs`

**Interfaces:**
- Produces: `impl FilmcraftApp { pub fn capture_view_state(&self) -> filmcraft_cloud::model::ViewState; pub fn apply_view_state(&mut self, v: &filmcraft_cloud::model::ViewState); }` — fields per Task 1 `ViewState`; unknown sequence ids are skipped; ticks clamped to the sequence's range; `zoom` clamped to the timeline's allowed range.

- [ ] **Step 1: Write failing test** `view_state_round_trips_through_a_fresh_app`: open the demo, move the playhead to 2 s, set in/out, zoom, switch workspace; capture; build a fresh app on the same project; apply; assert playhead, in/out, zoom, workspace and active sequence match. Plus `hostile_view_state_is_clamped_not_panicking` (playhead `i64::MAX`, zoom `NaN`, unknown sequence id).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** by reading and writing the existing UI state (timeline views, sequence tabs, workspace).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `CP9: capture and apply where you left off`

---

### Task 10: Web — token client and Drive HTTP executor

**Files:**
- Create: `apps/filmcraft-web/src/cloud/{mod,auth,drive_http}.rs`
- Modify: `apps/filmcraft-web/Cargo.toml` (dep `filmcraft-cloud`; `web-sys` features `Headers`, `Request`, `RequestInit`, `Response`, `RequestCredentials`), `src/lib.rs` (`pub mod cloud;`)

**Interfaces:**
- Consumes: Task 5 `TokenState`; Task 2 `DriveOp`, `DriveReply`, `DriveError`; Task 7 endpoints.
- Produces:
  - `cloud::auth::TokenClient` with `pub fn new() -> Self; pub fn access_token(&self) -> Option<String>; pub fn refresh(&self, done: impl FnOnce(TokenState) + 'static)` — `POST /api/auth/token`, `credentials: same-origin`, header `X-Cutroom: 1`; maps 200 → `Valid`, 401 `signed_out` → `SignedOut`, 401 `refused` → `Refused`, network failure or 5xx → `Unreachable`; refreshes automatically 5 minutes before `expires_in`.
  - `cloud::drive_http::execute(op: DriveOp, token: String, read_local: Rc<dyn Fn(&str, u64, u64) -> Option<web_sys::Blob>>, done: impl FnOnce(Result<DriveReply, DriveError>) + 'static)` — maps each `DriveOp` to Drive v3 REST (`files.list` with `q` on `appProperties` and `trashed=false`, `fields=files(id,name,version,modifiedTime,size)`; multipart `files.create`; `files.update` media upload; resumable `uploadType=resumable` with `Content-Range`; 308 → `Progress`; `files.get?alt=media`; `files.update {trashed:true}`); HTTP → `DriveError`: 401 `Unauthorized`, 403 with reason `storageQuotaExceeded` `QuotaFull`, 403/429 rate reasons `RateLimited`, 404 `NotFound` (on an upload session: `SessionGone`), 410 `SessionGone`, fetch rejection `Offline`, unparseable body `Malformed`. Upload chunks are sent as `Blob.slice` straight from the local copy (never copied into wasm memory).
- Pure, natively tested piece: `cloud::drive_http::classify(status: u16, body: &[u8], is_upload_session: bool) -> Option<DriveError>` in `src/cloud/drive_classify.rs`, tested from `tests/it/drive_classify.rs` with `#[path]` like `recovery_policy`.

- [ ] **Step 1: Write failing native tests** for `classify`: 401→Unauthorized; 403 `{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}`→QuotaFull; 403 `userRateLimitExceeded`→RateLimited; 429→RateLimited; 404 upload session→SessionGone, 404 otherwise→NotFound; 410→SessionGone; 503→Http(503); 200/308→None; garbage body with 403→Http(403).
- [ ] **Step 2: Run** `cargo test -p filmcraft-web --test it drive_classify` — Expected: FAIL.
- [ ] **Step 3: Implement** `classify`, `TokenClient`, `execute`.
- [ ] **Step 4: Run** the native tests (PASS) and `cargo xtask wasm` (`wasm: ok`).
- [ ] **Step 5: Commit** `CP10: web token client and Drive REST executor`

---

### Task 11: Web — per-account OPFS store and Drive-backed media

**Files:**
- Create: `apps/filmcraft-web/src/cloud/store.rs`
- Modify: `apps/filmcraft-web/src/fs.rs` (new `Entry::Drive { id: u32, size: u64 }` served by the chunk cache; `pub fn register_drive(path: &str, file: FileId, size: u64)`; a chunk source that fetches `bytes=a-b` from `drive/v3/files/<id>?alt=media` with the current token, and falls back to a local OPFS copy once it exists), `src/recovery.rs` (media copies go to the account's store when signed in)
- Test: `apps/filmcraft-web/tests/it/store_paths.rs` (pure path helpers via `#[path]`)

**Interfaces:**
- Produces (`cloud::store`): OPFS layout `accounts/<sub>/index.json`, `accounts/<sub>/projects/<project-id>/project.fcproj`, `accounts/<sub>/media/<fingerprint-hex>`; `pub fn index_path(sub: &str) -> Option<String>`, `pub fn project_path(sub: &str, id: &ProjectId) -> Option<String>`, `pub fn media_path(sub: &str, fp: &Fingerprint) -> Option<String>` (return `None` unless `sub`/`id` match `^[A-Za-z0-9_-]{1,128}$`); `pub async fn load_index(sub) -> Option<LocalIndex>`; `pub fn remembered_account() -> Option<Account>` (last signed-in, `accounts/last.json`); `pub async fn forget(sub)`; `pub fn keep_media_local(sub, fp, file: FileId, size, token)` (background copy Drive → OPFS, 8 MiB ranges, skipped with a status note when `navigator.storage.estimate()` reports too little room).

- [ ] **Step 1: Write failing native tests:** `store_paths` rejects `sub`/ids containing `/`, `..`, `%`, spaces, empty, 129 chars; accepts real Drive ids; `media_path` uses the fingerprint hex, never a clip name.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** store and `Entry::Drive` (reuse `request()` with a source enum `Blob | Drive`; failed Drive fetches with 401 trigger a token refresh and a retry, other failures mark the chunk failed so the reader reports an error instead of hanging).
- [ ] **Step 4: Run** native tests (PASS) and `cargo xtask wasm`.
- [ ] **Step 5: Commit** `CP11: per-account OPFS store and Drive-backed media reads`

---

### Task 12: Web — wire it together (startup gate, controller, settings, imports)

**Files:**
- Create: `apps/filmcraft-web/src/cloud/controller.rs`
- Modify: `apps/filmcraft-web/src/lib.rs` (startup + `logic()`), `src/import.rs` (imports report to the controller), `docs/web.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `cloud::controller::Controller` with `pub fn new(index: Option<LocalIndex>) -> Self; pub fn tick(&mut self, app: &mut FilmcraftApp, ctx: &egui::Context)` — each frame: drains `app.cloud_requests` into `CloudSession::request`; reports `project_dirty` (when `session.revision != saved_revision`, debounced by the session), `view_changed` (`app.capture_view_state()` when it differs), `settings_changed` (prefs JSON when it differs); runs `poll()` effects (`Drive` via `drive_http::execute`, `LoadProject` → write bytes with `fs::put` at `/cloud/<project-id>.fcproj`, `register_drive` for every uploaded media path not local, `file.open`, `apply_view_state`; `Navigate` → `location.assign` after the OPFS snapshot is written; `ApplySettings` → set prefs then `app.apply_prefs(ctx)`; `PersistIndex` → OPFS); sets `app.cloud = Some(session.view())`; marks `session.saved_revision` when a `Saved` status arrives for the current revision.
- Startup rules in `start()`: host mode or `?nologin` → no controller (today's behaviour, demo opens). Otherwise: no demo project, no global recovery; `Controller::new(store::load_index(remembered.sub))`, `TokenClient::refresh` → `CloudSession::token`. `?signin=failed` → status "Sign-in didn't finish. Try again." A dirty legacy `recovery/snapshot.fcproj` sets `CloudView.recovered`. Imports: after `register_blob`, compute the fingerprint from `Blob.slice` head/tail (1 MiB each) and call `media_imported`. A `.fcproj` opened or dropped while cloud is on goes to `CloudRequest::ImportProjectFile` instead of `file.open`.

- [ ] **Step 1: Write the failing end-to-end check** by adding assertions to `apps/filmcraft-web/tests/smoke.mjs`, through the agent API only: with `?nologin` the demo still opens and `window.filmcraftLoad.readyMs` is set (unchanged behaviour); without it, `window.filmcraft.execute('ui.elements', {prefix: 'cloud.signIn'})` returns one element and no `menu.File`. Run: `node apps/filmcraft-web/tests/smoke.mjs` against `cargo xtask web --serve 8080`. Expected now: the second assertion FAILS.
- [ ] **Step 2: Implement** `Controller` and the startup rules.
- [ ] **Step 3: Run** the smoke test — Expected: PASS; `cargo xtask ci` — Expected: only the environmental failures.
- [ ] **Step 4: Commit** `CP12: web app sign-in gate and Drive sync controller`

---

### Task 13: Owner setup guide, deploy, and real-account verification

**Files:**
- Create: `docs/cloud-setup.md` (the spec's four owner steps, click by click, plus how to generate `CUTROOM_COOKIE_KEY`: `openssl rand -base64 32`, and where to paste each value in Vercel → Project `cutroom` → Settings → Environment Variables, Production)
- Modify: `apps/filmcraft-web/web/index.html` only if the client id must be injected at build time (prefer reading it from `/api/auth/start`, so no client id is needed in the page at all)

- [ ] **Step 1: Write the guide** and send it to the owner; wait until they confirm the Google project, consent screen (published), client id and the three Vercel variables exist.
- [ ] **Step 2: Deploy** (push; CI) and confirm `curl -s -X POST -H 'X-Cutroom: 1' https://cutroom-six-mu.vercel.app/api/auth/token` prints `{"error":"signed_out"}`.
- [ ] **Step 3: Verify with the owner's account** (manual, owner present), each item checked off in the PR description:
  1. Sign in on device A → "Cutroom" folder appears in Drive.
  2. New Project, import a ~200 MB clip, edit, close the tab mid-upload, reopen → upload resumes and finishes; Drive shows `media/<clip>`.
  3. Device B (laptop): sign in → project listed → opens with the clip playing → playhead/workspace as left on A.
  4. Edit on B, then edit on A without reloading → A's save shows the conflict dialog; each of the three choices does what it says.
  5. B offline (Wi-Fi off), reload → "Continue offline as …" → edit → Wi-Fi on → changes reach Drive.
  6. Sign out on B → back to the sign-in screen; B's local copies gone.
  7. Sentry: no new events containing an email, token, project or clip name (check with the Sentry connector).
- [ ] **Step 4: Commit** `CP13: cloud setup guide` and report results to the owner.

---

## Self-review notes

- Spec coverage: gate (T8, T12), stay signed in (T6, T7, T10), projects in Drive (T4, T5, T8), footage upload/resume/dedupe (T3, T12), playback from Drive + kept on device (T11), where you left off (T9, T5), settings (T5, T12), offline (T5, T11, T12), conflicts and deletion (T4, T8), existing work / demo / recovered snapshot (T5, T8, T12), sign out (T5, T6, T11), errors table (T3–T5, T8, T10), privacy (Global Constraints, T6 test, T13 check), owner setup (T13), host mode and tests unchanged (T8, T12).
- Deviation from the spec, to show the owner: same-tab sign-in instead of a popup (Global Constraints).
