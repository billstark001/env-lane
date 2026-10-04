//! Lexical path resolution and workspace-root discovery.
use std::path::{Component, Path, PathBuf};

pub fn resolve_path(base: &Path, value: &Path) -> PathBuf {
    let joined = base.join(value);
    let mut result = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}
pub fn find_root(cwd: &Path) -> PathBuf {
    for dir in cwd.ancestors() {
        for marker in ["pnpm-workspace.yaml", "package.json", ".git"] {
            if dir.join(marker).is_file() || (marker == ".git" && dir.join(marker).is_dir()) {
                if marker == "package.json" {
                    for parent in dir.ancestors() {
                        if parent.join("pnpm-workspace.yaml").is_file() {
                            return parent.into();
                        }
                        // A nested repository must not inherit an unrelated
                        // workspace file from above its own Git boundary.
                        let git = parent.join(".git");
                        if git.is_dir() || git.is_file() {
                            break;
                        }
                    }
                }
                return dir.into();
            }
        }
    }
    cwd.into()
}

/// Render diagnostic and persisted paths relative to their owning project root.
pub fn relative_path(root: &Path, path: &Path) -> String {
    pathdiff::diff_paths(path, root)
        .unwrap_or_else(|| path.to_owned())
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
}
