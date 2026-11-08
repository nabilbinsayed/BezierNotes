//! This installation's identity for sync metadata (Plan 091): a random id
//! created on first launch and kept in the app config dir, never in the
//! webview's localStorage (which a "clear site data" would reset, turning one
//! device into two).

use inkwell_core::clock::{self, DeviceIdentity};
use std::path::Path;

const FILE_NAME: &str = "device.json";

#[derive(serde::Serialize, serde::Deserialize)]
struct Stored {
    /// Hex, so the 64-bit value survives any JSON reader.
    id: String,
    label: String,
}

/// A fresh random identity. Not persisted: `load_or_create` does that.
pub fn generate() -> DeviceIdentity {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let local = 0u8;
    let id = clock::derive_u128(&[
        b"device",
        &now.to_le_bytes(),
        &std::process::id().to_le_bytes(),
        &(&local as *const u8 as usize).to_le_bytes(),
        default_label().as_bytes(),
    ]) as u64;
    DeviceIdentity { id: id.max(1), label: default_label() }
}

fn default_label() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty());
    host.unwrap_or_else(|| "This device".to_string())
}

/// The identity stored in `dir`, creating (and storing) one on first use.
pub fn load_or_create(dir: &Path) -> Result<DeviceIdentity, String> {
    let path = dir.join(FILE_NAME);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let s: Stored = serde_json::from_slice(&bytes).map_err(|e| format!("{path:?}: {e}"))?;
            let id = u64::from_str_radix(&s.id, 16).map_err(|e| format!("{path:?}: bad id: {e}"))?;
            if id == clock::ZERO_DEVICE {
                return Err(format!("{path:?}: device id 0 is reserved"));
            }
            Ok(DeviceIdentity { id, label: s.label })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let me = generate();
            std::fs::create_dir_all(dir).map_err(|e| format!("{dir:?}: {e}"))?;
            let body = serde_json::to_vec_pretty(&Stored { id: format!("{:016x}", me.id), label: me.label.clone() })
                .expect("serialisable");
            inkwell_core::wal::atomic_write(&path, &body).map_err(|e| format!("{path:?}: {e}"))?;
            Ok(me)
        }
        Err(e) => Err(format!("{path:?}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_created_once_and_then_reused() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_create(dir.path()).unwrap();
        let b = load_or_create(dir.path()).unwrap();
        assert_eq!(a, b);
        assert_ne!(a.id, clock::ZERO_DEVICE);
        assert_ne!(generate().id, generate().id);
    }
}
