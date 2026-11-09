//! Local crash log and diagnostics (Plan 098). Nothing leaves the machine:
//! panics and frontend errors are appended to a rotating log in the per-user
//! state directory, and "Copy diagnostic info" gives the user text to paste
//! into a bug report themselves.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const LOG_NAME: &str = "beziernotes.log";
/// Rotate at this size, keeping this many files in all (5 × 1 MB).
const MAX_BYTES: u64 = 1024 * 1024;
const KEEP: usize = 5;
/// Frontend errors logged per session, so an error in a render loop can't
/// fill the disk between rotations.
const FRONTEND_BUDGET: usize = 200;

static WRITE: Mutex<()> = Mutex::new(());
static FRONTEND_LOGGED: AtomicUsize = AtomicUsize::new(0);

/// `$XDG_STATE_HOME/beziernotes/logs` (Linux), `%LOCALAPPDATA%\BezierNotes\logs`
/// (Windows), `~/Library/Logs/BezierNotes` (macOS).
pub fn log_dir() -> PathBuf {
    if cfg!(windows) {
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        return base.join("BezierNotes").join("logs");
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    if cfg!(target_os = "macos") {
        return home.join("Library").join("Logs").join("BezierNotes");
    }
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".local").join("state"))
        .join("beziernotes")
        .join("logs")
}

fn rotate(dir: &Path) {
    let cur = dir.join(LOG_NAME);
    if std::fs::metadata(&cur).map(|m| m.len() < MAX_BYTES).unwrap_or(true) {
        return;
    }
    for i in (1..KEEP).rev() {
        let from = if i == 1 { cur.clone() } else { dir.join(format!("{LOG_NAME}.{}", i - 1)) };
        let _ = std::fs::rename(&from, dir.join(format!("{LOG_NAME}.{i}")));
    }
}

/// Append one entry. Logging must never take the app down, so failures are
/// reported on stderr and otherwise ignored.
pub fn append_in(dir: &Path, kind: &str, message: &str) {
    let _g = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("[inkwell/log] cannot create {dir:?}: {e}");
        return;
    }
    rotate(dir);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let line = format!("{secs} {} {kind}: {}\n", env!("CARGO_PKG_VERSION"), message.trim_end());
    match std::fs::OpenOptions::new().create(true).append(true).open(dir.join(LOG_NAME)) {
        Ok(mut f) => {
            let _ = f.write_all(line.as_bytes());
        }
        Err(e) => eprintln!("[inkwell/log] cannot write {LOG_NAME}: {e}"),
    }
}

pub fn append(kind: &str, message: &str) {
    append_in(&log_dir(), kind, message);
}

/// Log panics (with a backtrace) before the default hook reports them.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        append("PANIC", &format!("{what} at {at}\n{}", std::backtrace::Backtrace::force_capture()));
        previous(info);
    }));
}

#[tauri::command]
pub fn log_frontend_error(message: String, source: Option<String>) -> Result<(), String> {
    if FRONTEND_LOGGED.fetch_add(1, Ordering::Relaxed) >= FRONTEND_BUDGET {
        return Ok(());
    }
    let msg: String = message.chars().take(8000).collect();
    append("JS", &format!("{msg}{}", source.map(|s| format!(" ({s})")).unwrap_or_default()));
    Ok(())
}

#[tauri::command]
pub fn open_logs_folder() -> Result<String, String> {
    let dir = log_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{dir:?}: {e}"))?;
    let opener = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(&dir).spawn().map_err(|e| format!("Could not open {dir:?}: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Text for a bug report: versions, platform, PDFium and where the logs are.
#[tauri::command]
pub fn diagnostic_info(state: tauri::State<'_, crate::state::AppState>) -> String {
    let pdfium = if state.pdfium.lock().map(|p| p.is_some()).unwrap_or(false) { "loaded" } else { "NOT loaded" };
    format!(
        "BezierNotes {}\nOS: {} {}\nPDFium: {pdfium}\nLogs: {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        log_dir().display(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_rotates_and_keeps_five_files() {
        let dir = tempfile::tempdir().unwrap();
        let big = "x".repeat(300 * 1024);
        for i in 0..30 {
            append_in(dir.path(), "TEST", &format!("{i} {big}"));
        }
        let mut names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names.len(), KEEP, "{names:?}");
        for e in std::fs::read_dir(dir.path()).unwrap() {
            assert!(e.unwrap().metadata().unwrap().len() <= MAX_BYTES + 400 * 1024);
        }
        let newest = std::fs::read_to_string(dir.path().join(LOG_NAME)).unwrap();
        assert!(newest.contains(" TEST: 29 "));
    }
}
