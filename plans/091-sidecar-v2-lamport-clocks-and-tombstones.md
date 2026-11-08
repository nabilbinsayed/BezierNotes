# Plan 091: Sidecar v2 with Lamport Clocks, Device IDs & Tombstones (CRDT Foundation)

| Field | Value |
|---|---|
| **Priority** | P1 |
| **Effort** | M (~500 lines, Rust core + WAL + JS stamping) |
| **Category** | Architecture / Multi-Device Sync |
| **Depends on** | 087, 088 |
| **Status** | DONE (2026-11-08; see Outcome) |

## Why

`SPEC.md` §5 calls a true multi-device merge "the one feature that makes the project worth existing". The domain makes it unusually easy: strokes are immutable and append-only, so merge = `union(objects) − union(tombstones)`, ordered by a Lamport clock. Today the sidecar can't support that:
- it stores only the *current* object set. A stroke deleted on device A is indistinguishable from a stroke device B added after A last synced;
- mutable objects (text notes, images moved by lasso, bookmarks) carry no per-object version, so concurrent edits can't be resolved;
- there is no stable device identity;
- `decode_sidecar` rejects any version byte other than `SIDECAR_VERSION`, so bumping the format must be done deliberately, with a migration path.

This plan adds the metadata. Plan 092 adds the merge.

## Evidence

- `inkwell/crates/inkwell-core/src/doc.rs:416-443`: skeleton JSON = `generation, device, sheets, viewports, bookmarks, layer_stroke_counts`; strokes via codec. No clocks, no tombstones.
- `doc.rs:447-449`: `if buf[4] != SIDECAR_VERSION { return Err(UnsupportedVersion) }`.
- `inkwell/crates/inkwell-core/src/ink.rs:151`: `Stroke.id: u128`. The IDs are already globally unique, which is good.
- `inkwell/crates/inkwell-core/src/wal.rs:42-90`: WAL entries carry no clock.

## Design

### Data model
- `DeviceId`: random u64 generated on first launch, persisted in the app config dir (not in localStorage). Include a human label ("Nabil's laptop") for the merge UI.
- `Clock { lamport: u64, device: DeviceId }`, totally ordered by `(lamport, device)`.
- `Document.clock: u64`, the max Lamport value seen. Every local mutation does `clock += 1` and stamps the object.
- Every object gains `created: Clock` and, if mutable, `modified: Clock`. Strokes are immutable: lasso transforms create a new stroke ID and tombstone the old one, which matches how the partial eraser already works (Plan 084).
- `Document.tombstones: BTreeMap<ObjectId, Clock>`, where `ObjectId` is an enum over stroke u128 / image id / text id / bookmark id / page id.
- **Pages need identity.** Give every `Sheet` a stable `page_id: u128` (generated at insert; for original PDF pages, derived deterministically from base hash + source page index, so two devices agree). Page order is a list CRDT problem; use a simple fractional index (`order_key: String`, LexoRank-style) so concurrent inserts don't collide.
- Tombstone GC: drop tombstones older than 90 days *and* older than every device's last-seen clock recorded in `Document.peers: BTreeMap<DeviceId, u64>`. Keep this conservative; tombstones are tiny.

### Format
- `SIDECAR_VERSION = 2`. Skeleton JSON adds `clock`, `peers`, `tombstones`, and per-object clocks (serde `default` so v1 decodes into v2 with all clocks = `(0, ZERO_DEVICE)`).
- Stroke clocks go in a parallel varint column in the codec payload, not in JSON, to keep size flat.
- Decoder accepts v1 and v2. Encoder always writes v2.
- Forward compatibility: also write `/Inkw_Ver 2` in the catalog. An *older* BezierNotes build that sees v2 falls back to Layer 2 (`/InkList`) reconstruction (`SidecarStatus::Corrupt` path), which is lossy but safe. Document this in `README.md` and make the release notes for this version say "files saved by this version open in older versions with reduced fidelity".

### WAL
- New WAL record kinds carry the clock. Replay restores `Document.clock = max(seen)`. Old records without clocks replay with `lamport = 0`.

### Frontend
- JS objects carry `created`/`modified` clocks round-tripped through IPC (`FrontendStroke`, `FrontendText`, `FrontendImage`), and the backend is authoritative for incrementing. Simplest approach: the backend stamps on `commit_stroke` / journal calls and returns the clock.

## Scope
- `inkwell/crates/inkwell-core/src/doc.rs`, `codec.rs`, `wal.rs`, `ink.rs` (Stroke clock field).
- `inkwell-app/src-tauri/src/state.rs` (device id), `commands.rs` (stamping, Frontend* DTOs).
- `inkwell-app/src/js/core/document.js`, `ipc.js` (carry clocks).

### Files NOT to Touch
- Layer 1/2 emission. Clocks are Layer 3 only.

## Verification
- Proptest (Plan 087): `decode(encode(doc)) == doc` for v2; `decode_v2(encode_v1(doc))` preserves every object.
- Unit: Lamport monotonic across WAL replay; deterministic `page_id` for base pages from two independent opens.
- Size budget: sidecar of a 5,000-stroke document grows ≤ 5 % vs v1.
- Smoke 150+/150+ unchanged.

## STOP Conditions
- STOP if any v1 file fails to open after this change. Add every v1 fixture from 087 to a `v1_compat` test first.

## Outcome (2026-11-08)

**Data model** (`inkwell-core/src/clock.rs`, `doc.rs`).
- `Clock { lamport, device }` is ordered by `(lamport, device)`. `DeviceId` is a `u64`, with `0` reserved for "unknown / pre-091". `ObjectId` covers stroke / image / text / bookmark / page and serialises as a prefixed string (`s:<hex>`, `t:<id>`, …) so it can key a JSON map.
- `Document` gains:
  - `clock`: the highest Lamport value seen;
  - `peers`: `DeviceId → { clock, label }`;
  - `clocks`: `ObjectId → { created, modified }`, sparse, so a missing entry means zero clocks;
  - `tombstones`: `ObjectId → { clock, unix_s }`.
- `Sheet` gains `page_id: u128` and `order_key: String` (fractional base-62 keys; `key_between`, `keys_between` bisects so bulk keys stay short).
- Base PDF pages get `sha256("base-page", base_fingerprint, index)` at open. `base_fingerprint` is the SHA-256 of `writable_base`, so two devices opening the same file agree.
- `duplicate_sheet` clears the copy's id and key, so the copy becomes a new page.
- Tombstone GC: a tombstone is dropped only when it is older than 90 days **and** at or below every peer's clock.

**Where clocks are assigned (a deliberate deviation).** The plan had the frontend carry clocks through IPC and the WAL record them. Instead, `Document::restamp(me, now)` runs once per save in `save_blocking`, right after the frontend payload is applied and under `save_lock`:
- It diffs every object's content hash against the baseline taken at load (`decode_sidecar` seals it) or at the last stamp.
- Each appeared object gets `created`, each changed object gets `modified`, and each vanished object gets a tombstone, all with fresh ticks from this device. A re-added object (an undone delete) loses its tombstone.

Edits between saves never leave this device; they live only in the journal. So stamping them at save time can't be told apart from stamping them as they happen. As a result, JS, IPC and the WAL format are unchanged, and journals written before 091 still replay.
- **Lamport monotonicity across a crash.** The sidecar persists `clock`. Replay applies the journal, and the next save ticks above the persisted value (tested).
- **Hashes are taken at the codec's resolution** (1/50 pt, 10-bit pressure, 0.1 ms; positions at 1/100 pt), because the save path rebuilds the document from the frontend's JSON copy every time. An app test (`save_stamps_only_what_the_frontend_changed`) checks two things. Sending the frontend's unchanged copy back stamps nothing. Moving one stroke stamps exactly that stroke. A proptest also checks that `ink::simplify`, which re-runs on every save, is idempotent: if it weren't, every save would stamp every stroke.

**Strokes are not immutable in practice.** The lasso moves strokes in place under the same id. So strokes get a `modified` clock too, rather than "lasso = new id + tombstone". Changing the lasso to re-id strokes would have touched undo, selection and the WAL for no benefit to the merge.

**Format: schema 2 inside container v1, not `SIDECAR_VERSION = 2`.** The plan bumped the container byte and accepted that older builds would fall back to Layer 2. They don't: no `/InkList` reconstruction exists. An older build would have opened the file with **no** ink in its model, and its next save would have dropped every stroke. Instead:
- The skeleton gains fields: `schema: 2`, `clock`, `peers`, `clocks` (non-stroke objects), `tombstones`, `stroke_clock_devices`, and per-sheet `page_id` / `order_key`. Older readers ignore unknown JSON fields.
- Stroke clocks go in an `IWCK` column after the codec payload, which older decoders never read past. The column holds a device-table index plus a varint Lamport value per clock, with `modified` stored as a delta.
- `/Inkw_Ver` stays 1.

This was verified against the real pre-091 build (`HEAD` in a scratch worktree): it reads a schema-2 file with all 6 sheets, 12 strokes, the text and the bookmark. When it saves, it drops the clocks; the next save here stamps those objects afresh. README notes this.

**Verification.**
- **v1 compatibility (the STOP condition).** Pre-091 fixtures were written by the pre-091 code before any change: `inkwell/fixtures/v1/notes_v1.{iwdc,pdf}` (5 base pages + 1 inserted, a reorder, 12 strokes, image, Bengali text, bookmark, template) and `xref_stream_v1.pdf`. Each decodes with every object. `notes_v1.pdf` also re-saves as schema 2 and round-trips with clocks.
- **New `tests/sync_meta.rs` (19 tests).** It covers:
  - round trip;
  - no-change restamp is a no-op;
  - exact stamping of add / edit / delete / in-place move;
  - undo-delete revives;
  - a reorder re-keys one page only (LIS) and leaves its strokes' clocks alone;
  - duplicate and inserted pages get unique ids;
  - deterministic base page ids;
  - tombstone GC;
  - WAL replay monotonicity;
  - the pre-091 reader's view;
  - key-insertion and round-trip proptests;
  - `simplify` idempotence.
- **Size budget.** 5,000 strokes stamped by three devices: +2.09 % vs the pre-091 encoding (budget 5 %).
- **Totals.**
  - Rust workspace 140/140; clippy clean on both workspaces; strict conformance + render diff pass.
  - Golden snapshots regenerated: only the sidecar bytes and hash changed.
  - App crate 20/20 (new: device identity, save stamping).
  - Smoke 164/164; boundaries clean; torture 60/60.

**Device identity** (`src-tauri/src/device.rs`). This is a random id plus the host name as its label, created on first launch in the app config dir (`device.json`, written with `atomic_write`). If that fails, the app logs a warning and uses a per-launch id.

**Not done / limits.**
- **No merge yet.** Plan 092 compares clocks; nothing reads them yet.
- **Peer label.** The label is the bare host name; the merge UI (092) may want "user on host" or a user-editable name.
- **Bookmarks.** Bookmarks hash `page` as an index, so a page reorder that shifts a bookmark's page index stamps it as modified. That is harmless for union merge; 092 can switch bookmarks to page ids if it matters.
- **Lib docs.** `inkwell-core`'s crate docs still say a stripped sidecar falls back to `/InkList` reconstruction; that path doesn't exist (pre-existing).
- **Not run in the desktop app.** It needs a real save on a real device to see `device.json` created.
