//! Auto-update (Plan 098), via `tauri-plugin-updater` and a signed
//! `latest.json` published with each GitHub release.
//!
//! The updater needs a signing public key in `tauri.conf.json`
//! (`plugins.updater.pubkey`), and the release workflow needs the matching
//! private key as a secret (see docs/release.md). Until that is set up the
//! plugin is not registered and the checks report "not configured", so an
//! unconfigured build never fails to start.
//!
//! An update is never installed over unsaved work: `install_update` refuses
//! while the document is dirty (the frontend saves first).

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// Whether this build carries an updater public key.
pub fn configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

/// Register the updater plugin when configured (call from `setup`).
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    if !configured(app) {
        eprintln!("[inkwell] Auto-update not configured (no updater pubkey); update checks are off.");
        return;
    }
    if let Err(e) = app.plugin(tauri_plugin_updater::Builder::new().build()) {
        crate::diagnostics::append("UPDATER", &format!("could not start the updater: {e}"));
    }
}

#[derive(Debug, Serialize, Default)]
pub struct UpdateStatus {
    pub configured: bool,
    pub current: String,
    /// The newer version available, if any.
    pub available: Option<String>,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateStatus, String> {
    let mut st = UpdateStatus { current: env!("CARGO_PKG_VERSION").into(), ..Default::default() };
    if !configured(&app) {
        return Ok(st);
    }
    st.configured = true;
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(u) = updater.check().await.map_err(|e| e.to_string())? {
        st.available = Some(u.version.clone());
        st.notes = u.body.clone();
    }
    Ok(st)
}

/// Download, verify (signature) and install the update, then restart.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if !configured(&app) {
        return Err("Updates are not configured in this build.".into());
    }
    {
        let state = app.state::<crate::state::AppState>();
        if state.is_dirty.load(std::sync::atomic::Ordering::Acquire) {
            return Err("Save your changes before updating: the app restarts to install.".into());
        }
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("No update is available any more.".into());
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}
