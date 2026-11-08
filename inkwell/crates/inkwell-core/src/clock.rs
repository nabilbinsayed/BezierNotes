//! Sync metadata (Plan 091): Lamport clocks, device identity, tombstones and
//! fractional page order keys. The foundation for multi-device merge (092).
//!
//! The model is a state-based CRDT over immutable-identity objects: a merge is
//! `union(objects) − union(tombstones)`, with concurrent edits to one object
//! resolved by the larger `Clock`. Nothing here merges yet; it records enough
//! that a later merge can tell "deleted over there" from "added over here".
//!
//! Clocks are assigned at the persistence boundary, not per edit:
//! `Document::restamp` diffs the document against what was last loaded or
//! saved and ticks the clock for every object that appeared, changed or
//! vanished. Edits between saves never leave this device (they live in the
//! journal), so stamping them at save time is indistinguishable from stamping
//! them as they happened, and the frontend and IPC stay clock-free.

use serde::{Deserialize, Serialize};
use std::fmt;

/// A random per-installation id. `0` is reserved for "unknown": everything
/// read from a file written before Plan 091 carries it.
pub type DeviceId = u64;
pub const ZERO_DEVICE: DeviceId = 0;

/// Lamport timestamp, totally ordered by `(lamport, device)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize)]
pub struct Clock {
    pub lamport: u64,
    pub device: DeviceId,
}

impl Clock {
    pub const ZERO: Clock = Clock { lamport: 0, device: ZERO_DEVICE };
    pub fn is_zero(&self) -> bool {
        *self == Clock::ZERO
    }
}

/// The local installation, as the app knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub id: DeviceId,
    /// Shown in the merge UI ("Nabil's laptop").
    pub label: String,
}

/// What this document knows about a device that has written to it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Peer {
    /// The highest Lamport value this device has stamped into the document.
    pub clock: u64,
    #[serde(default)]
    pub label: String,
}

/// Identity of any object a merge must reconcile. Serialised as a short
/// prefixed string so it can key a JSON map.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ObjectId {
    Stroke(u128),
    Image(String),
    Text(String),
    Bookmark(String),
    Page(u128),
    Shape(String),
}

impl fmt::Display for ObjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ObjectId::Stroke(id) => write!(f, "s:{id:032x}"),
            ObjectId::Image(id) => write!(f, "i:{id}"),
            ObjectId::Text(id) => write!(f, "t:{id}"),
            ObjectId::Bookmark(id) => write!(f, "b:{id}"),
            ObjectId::Page(id) => write!(f, "p:{id:032x}"),
            ObjectId::Shape(id) => write!(f, "h:{id}"),
        }
    }
}

impl std::str::FromStr for ObjectId {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let (tag, rest) = s.split_once(':').ok_or_else(|| format!("bad object id {s:?}"))?;
        let hex = |r: &str| u128::from_str_radix(r, 16).map_err(|e| format!("bad object id {s:?}: {e}"));
        Ok(match tag {
            "s" => ObjectId::Stroke(hex(rest)?),
            "i" => ObjectId::Image(rest.to_string()),
            "t" => ObjectId::Text(rest.to_string()),
            "b" => ObjectId::Bookmark(rest.to_string()),
            "p" => ObjectId::Page(hex(rest)?),
            "h" => ObjectId::Shape(rest.to_string()),
            _ => return Err(format!("bad object id {s:?}")),
        })
    }
}

impl Serialize for ObjectId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ObjectId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// Per-object clocks. An object with no entry has both clocks `Clock::ZERO`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ObjClock {
    #[serde(rename = "c")]
    pub created: Clock,
    #[serde(rename = "m")]
    pub modified: Clock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tombstone {
    pub clock: Clock,
    /// Wall-clock seconds at deletion; only used for garbage collection.
    pub unix_s: u64,
}

/// Tombstones younger than this are never collected.
pub const TOMBSTONE_MIN_AGE_S: u64 = 90 * 24 * 3600;

/// Serde helper: `u128` as a 32-digit hex string (JSON numbers can't hold it).
pub mod hex_u128 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&format_args!("{v:032x}"))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        let s = String::deserialize(d)?;
        u128::from_str_radix(&s, 16).map_err(serde::de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Content hashing (change detection for `restamp`)
// ---------------------------------------------------------------------------

/// FNV-1a over 64-bit words. Not cryptographic: it only has to notice that an
/// object this device holds changed between two saves.
pub(crate) struct Fnv(u64);

impl Fnv {
    pub fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    pub fn word(&mut self, w: u64) -> &mut Self {
        self.0 ^= w;
        self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        self
    }
    /// `v` rounded to `1/scale`, so values that differ only by float noise
    /// hash alike.
    pub fn q(&mut self, v: f64, scale: f64) -> &mut Self {
        self.word((v * scale).round() as i64 as u64)
    }
    pub fn bytes(&mut self, b: &[u8]) -> &mut Self {
        self.word(b.len() as u64);
        for c in b.chunks(8) {
            let mut w = [0u8; 8];
            w[..c.len()].copy_from_slice(c);
            self.word(u64::from_le_bytes(w));
        }
        self
    }
    pub fn finish(&self) -> u64 {
        self.0
    }
}

/// A stable id derived from `parts`: used for base PDF pages (so two devices
/// opening the same file agree) and for pages created here (unique per
/// device and clock tick).
pub fn derive_u128(parts: &[&[u8]]) -> u128 {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p);
    }
    let out = h.finalize();
    let id = u128::from_be_bytes(out[..16].try_into().expect("16 bytes"));
    // 0 means "unassigned"; astronomically unlikely, but never hand it out.
    id.max(1)
}

// ---------------------------------------------------------------------------
// Fractional order keys (page order as a list CRDT)
// ---------------------------------------------------------------------------
//
// Keys are strings over a 62-symbol alphabet, compared byte-wise, never empty
// and never ending in the lowest digit, so there is always room between two
// keys. Concurrent inserts at the same spot can produce equal keys; a merge
// breaks the tie by page id.

const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit_value(c: u8) -> Option<u8> {
    DIGITS.iter().position(|&d| d == c).map(|p| p as u8)
}

/// Whether `k` is a well-formed order key.
pub fn is_valid_key(k: &str) -> bool {
    !k.is_empty() && k.bytes().all(|c| digit_value(c).is_some()) && !k.ends_with('0')
}

fn mid_digits(a: &[u8], b: Option<&[u8]>) -> Vec<u8> {
    if let Some(b) = b {
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(0) == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(mid_digits(a.get(n..).unwrap_or(&[]), Some(&b[n..])));
            return out;
        }
    }
    let da = a.first().copied().unwrap_or(0);
    let db = b.map(|b| b[0]).unwrap_or(62);
    if db - da > 1 {
        vec![(da + db) / 2]
    } else if let Some(b) = b.filter(|b| b.len() > 1) {
        vec![b[0]]
    } else {
        let mut out = vec![da];
        out.extend(mid_digits(a.get(1..).unwrap_or(&[]), None));
        out
    }
}

/// A key strictly between `lo` and `hi` (`None` = unbounded on that side).
/// Requires `lo < hi` when both are given.
pub fn key_between(lo: Option<&str>, hi: Option<&str>) -> String {
    let to_digits = |s: &str| s.bytes().map(|c| digit_value(c).expect("valid order key")).collect::<Vec<_>>();
    let a = lo.map(to_digits).unwrap_or_default();
    let b = hi.map(to_digits);
    debug_assert!(b.as_ref().is_none_or(|b| a < *b), "key_between needs lo < hi");
    mid_digits(&a, b.as_deref()).into_iter().map(|d| DIGITS[d as usize] as char).collect()
}

/// `n` increasing keys strictly between `lo` and `hi`, by bisection so their
/// length grows with log(n) rather than n.
pub fn keys_between(lo: Option<&str>, hi: Option<&str>, n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    let mid = key_between(lo, hi);
    let left = (n - 1) / 2;
    let mut out = keys_between(lo, Some(&mid), left);
    out.push(mid.clone());
    out.extend(keys_between(Some(&mid), hi, n - 1 - left));
    out
}

/// Indices of a longest strictly increasing subsequence of `keys`
/// (`None` entries never take part). Keeping these and re-keying the rest
/// turns a reorder into one changed key instead of many.
pub fn longest_increasing<T: Ord>(keys: &[Option<T>]) -> Vec<usize> {
    // patience sorting with predecessor links, O(n log n)
    let mut tails: Vec<usize> = Vec::new();
    let mut prev: Vec<Option<usize>> = vec![None; keys.len()];
    for (i, k) in keys.iter().enumerate() {
        let Some(k) = k else { continue };
        let pos = tails.partition_point(|&t| keys[t].as_ref().expect("tails hold keyed slots") < k);
        if pos > 0 {
            prev[i] = Some(tails[pos - 1]);
        }
        if pos == tails.len() {
            tails.push(i);
        } else {
            tails[pos] = i;
        }
    }
    let mut out = Vec::with_capacity(tails.len());
    let mut cur = tails.last().copied();
    while let Some(i) = cur {
        out.push(i);
        cur = prev[i];
    }
    out.reverse();
    out
}
