//! Plan 087 crash-torture helper, driven by `scripts/torture_save.sh`.
//!
//!   save_loop <base.pdf> <target.pdf>   save forever, one more stroke each time
//!   save_loop --check <target.pdf>      exit 0 if target opens with intact ink
//!   save_loop --sweep <target.pdf>      remove orphaned temps (Plan 090), print count
//!
//! The saver uses the same path as the app (`PdfFile` + `wal::atomic_write`),
//! so `kill -9` at a random moment must never leave an unopenable file.

use inkwell_core::doc::Document;
use inkwell_core::ink::{Brush, IdGen, StrokeBuilder, ToolKind};
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};
use inkwell_core::wal::atomic_write;
use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag, target] if flag == "--check" => check(Path::new(target)),
        [flag, target] if flag == "--sweep" => {
            println!("{}", inkwell_core::wal::sweep_orphan_temps(Path::new(target), std::time::Duration::ZERO));
            ExitCode::SUCCESS
        }
        [base, target] => save_forever(Path::new(base), Path::new(target)),
        _ => {
            eprintln!("usage: save_loop <base.pdf> <target.pdf> | --check <target.pdf>");
            ExitCode::from(2)
        }
    }
}

fn save_forever(base: &Path, target: &Path) -> ExitCode {
    let base = std::fs::read(base).expect("read base");
    let pages = PdfFile::open(base.clone()).expect("classic base").page_count();
    let mut d = Document::for_pdf(pages);
    let mut ids = IdGen::seeded(0x7071);
    let mut i = 0u64;
    loop {
        let mut b = StrokeBuilder::new(ids.next_id(), ToolKind::Pen, [0.0, 0.0, 0.0], Brush::default(), false);
        for k in 0..400 {
            let t = k as f64 / 399.0;
            b.push(60.0 + t * 400.0, 80.0 + (i % 60) as f64 * 11.0 + 5.0 * (t * 30.0).sin(), 0.6, k as f64);
        }
        d.push_stroke(0, b.finish(0.0));
        d.generation = i + 1;
        let mut f = PdfFile::open(base.clone()).expect("open");
        f.write_document(&d, pdf::DEFAULT_GROUP).expect("write");
        atomic_write(target, &f.finish()).expect("atomic_write");
        i += 1;
    }
}

fn check(target: &Path) -> ExitCode {
    let bytes = match std::fs::read(target) {
        Ok(b) => b,
        Err(e) => {
            println!("UNREADABLE {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = PdfFile::open(bytes.clone()) {
        println!("UNOPENABLE {e}");
        return ExitCode::FAILURE;
    }
    match pdf::read_sidecar(&bytes) {
        Ok(SidecarStatus::Ok(d)) => println!("OK generation={} strokes={}", d.generation, d.stroke_count()),
        // Killed before the first save completed: the untouched base is fine.
        Ok(SidecarStatus::Absent) => println!("OK untouched"),
        Ok(SidecarStatus::Stale(_)) => {
            println!("STALE");
            return ExitCode::FAILURE;
        }
        Ok(SidecarStatus::Corrupt(e)) => {
            println!("CORRUPT {e}");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            println!("SIDECAR-ERR {e}");
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}
