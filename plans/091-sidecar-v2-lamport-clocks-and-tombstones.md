# Plan 091: Sidecar v2 with Lamport Clocks, Device IDs & Tombstones (CRDT Foundation)

| Field | Value |
|---|---|
| **Priority** | P1 |
| **Effort** | M (~500 lines, Rust core + WAL + JS stamping) |
| **Category** | Architecture / Multi-Device Sync |
| **Depends on** | 087, 088 |
| **Status** | TODO |

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
