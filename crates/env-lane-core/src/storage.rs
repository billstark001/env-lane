//! Shared filesystem boundary for document writes. Planning stays pure; callers
//! invoke this module only after validation and any required decisions succeed.
use crate::{
    document::{Document, Patch, PatchOptions, PatchResult, patch},
    error::{Error, Result},
};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub struct LoadedDocument {
    pub exists: bool,
    pub content: String,
    pub parsed: Document,
}

pub fn load_document(path: &Path) -> Result<LoadedDocument> {
    let exists = path.exists();
    let content = if exists {
        read_text(path)?
    } else {
        String::new()
    };
    let parsed = Document::parse(&content);
    Ok(LoadedDocument {
        exists,
        content,
        parsed,
    })
}

/// Match the frozen UTF-8 replacement policy for dotenv text, including invalid
/// byte sequences; configuration decoding has a separate, strict contract.
pub fn read_text(path: &Path) -> Result<String> {
    let bytes = fs::read(path).map_err(|error| file_error(path, error))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn patch_file(path: &Path, patches: &[Patch], options: &PatchOptions) -> Result<PatchResult> {
    let document = load_document(path)?;
    let result = patch(&document.content, patches, options)?;
    if result.changed {
        write_atomically(path, &result.content)?;
    }
    Ok(result)
}

/// Avoid creating directories or empty files for an unchanged write. This is
/// also why preview callers must compute a plan without calling this function.
pub fn write_if_changed(path: &Path, content: &str) -> Result<bool> {
    let current = if path.exists() {
        read_text(path)?
    } else {
        String::new()
    };
    if current == content {
        return Ok(false);
    }
    write_atomically(path, content)?;
    Ok(true)
}

/// Follow a destination symlink before replacement so its identity survives.
/// A temporary file in the same directory keeps rename on one filesystem.
/// NamedTempFile removes its temporary path on write, flush or persist failure.
pub fn write_atomically(path: &Path, content: &str) -> Result<()> {
    let destination = write_destination(path).map_err(|error| file_error(path, error))?;
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|error| file_error(parent, error))?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".env-lane-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| file_error(parent, error))?;
    match fs::metadata(&destination) {
        Ok(metadata) => {
            let permissions = destination_permissions(&metadata);
            temporary
                .as_file()
                .set_permissions(permissions)
                .map_err(|error| file_error(path, error))?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(file_error(path, error)),
    }
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| file_error(path, error))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| file_error(path, error))?;
    temporary
        .persist(&destination)
        .map_err(|error| file_error(path, error.error))?;
    Ok(())
}

fn write_destination(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(path),
        Ok(_) => Ok(path.to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path.to_owned()),
        Err(error) => Err(error),
    }
}

fn file_error(path: &Path, error: io::Error) -> Error {
    let mut failure = Error::new("ENV_LANE_ERROR", format!("{}: {error}", path.display()));
    failure.details = Some(serde_json::json!({"path":path,"ioKind":format!("{:?}",error.kind())}));
    failure
}

fn destination_permissions(metadata: &fs::Metadata) -> fs::Permissions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Content replacement preserves rwx permissions, not executable privilege
        // bits such as setuid/setgid. This matches the established writer.
        fs::Permissions::from_mode(metadata.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        metadata.permissions()
    }
}
