//! Configured checks and synchronization share source resolution and transforms.
mod check;
mod source;
mod sync;
mod transform;

pub use check::{CheckResult, Finding, Summary, run_check};
pub use sync::{SyncOptions, SyncResult, run_sync};
