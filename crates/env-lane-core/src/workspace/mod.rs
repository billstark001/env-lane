//! Discover workspace packages once, then resolve targets from that snapshot.
mod discovery;
mod patterns;
mod target;

pub use discovery::list_packages;
pub use target::resolve_target;

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub dir: PathBuf,
    pub relative_dir: String,
    pub aliases: Vec<String>,
    pub is_root: bool,
}
