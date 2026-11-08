//! `beziernotes merge <a.pdf> <b.pdf> -o <out.pdf>`: merge two copies of one
//! notebook (e.g. a cloud sync conflict copy) without the app (Plan 092).

use inkwell_core::clock::{self, DeviceIdentity};
use inkwell_core::merge;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: beziernotes merge <a.pdf> <b.pdf> -o <out.pdf>";

fn parse(args: &[String]) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let mut inputs = Vec::new();
    let mut out = None;
    let mut it = args.iter();
    match it.next().map(String::as_str) {
        Some("merge") => {}
        _ => return Err(USAGE.into()),
    }
    while let Some(a) = it.next() {
        match a.as_str() {
            "-o" | "--output" => out = Some(PathBuf::from(it.next().ok_or(USAGE)?)),
            _ => inputs.push(PathBuf::from(a)),
        }
    }
    match (inputs.as_slice(), out) {
        ([a, b], Some(o)) => Ok((a.clone(), b.clone(), o)),
        _ => Err(USAGE.into()),
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let (a, b, out) = parse(args)?;
    let read = |p: &PathBuf| std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()));
    let (ba, bb) = (read(&a)?, read(&b)?);
    let host = std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")).unwrap_or_default();
    // Stamps only what a copy saved before Plan 091 left unstamped.
    let me = DeviceIdentity {
        id: clock::derive_u128(&[b"beziernotes-cli", host.as_bytes()]) as u64 | 1,
        label: format!("BezierNotes CLI on {}", if host.is_empty() { "this computer" } else { &host }),
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (bytes, report) = merge::merge_files(&ba, &bb, &me, now).map_err(|e| e.to_string())?;
    inkwell_core::wal::atomic_write(&out, &bytes).map_err(|e| format!("{}: {e}", out.display()))?;
    println!(
        "merged into {}: {} added from {}, {} removed, {} changed, {} conflict(s), {} page(s) kept because of ink",
        out.display(),
        report.added.len(),
        b.display(),
        report.removed.len(),
        report.changed.len(),
        report.conflicts.len(),
        report.pages_kept_by_ink.len()
    );
    for c in &report.conflicts {
        let won = match c.winner {
            merge::Side::Ours => "first",
            merge::Side::Theirs => "second",
        };
        println!("  conflict {}: kept the {won} file's version ({:?} vs {:?})", c.id, c.ours, c.theirs);
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("beziernotes: {e}");
            ExitCode::FAILURE
        }
    }
}
