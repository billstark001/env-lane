//! Exclusive-create lock files interoperable with existing Node Vault writers.
mod process;
use env_lane_core::error::{Error, Result};
use same_file::Handle;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    pid: i64,
    created_at: f64,
    token: String,
}

pub struct Options {
    pub timeout: Duration,
    pub stale_after: Duration,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(5),
            stale_after: Duration::from_secs(30),
        }
    }
}

/// Releasing a guard only removes its own token and file identity. Replacing the
/// lock while an operation is running cannot make this guard delete a new owner.
pub struct Lock {
    path: PathBuf,
    token: String,
    handle: Option<File>,
    identity: Handle,
}

pub fn acquire(target: &Path, options: &Options) -> Result<Lock> {
    let mut name = target.as_os_str().to_owned();
    name.push(".lock");
    let path = PathBuf::from(name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let started = Instant::now();
    loop {
        match create(&path) {
            Ok(lock) => return Ok(lock),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                remove_stale(&path, options.stale_after);
                if started.elapsed() >= options.timeout {
                    return Err(Error::new(
                        "VAULT_LOCK_TIMEOUT",
                        format!("Timed out waiting for Vault lock: {}", path.display()),
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(io_error(error)),
        }
    }
}

fn create(path: &Path) -> std::io::Result<Lock> {
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|error| std::io::Error::other(error.to_string()))?;
    let token = hex::encode(random);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(path)?;
    let identity = Handle::from_file(handle.try_clone()?)?;
    let metadata = Metadata {
        pid: i64::from(std::process::id()),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64,
        token: token.clone(),
    };
    let payload = serde_json::to_vec(&metadata).expect("finite lock metadata");
    if let Err(error) = handle
        .write_all(&payload)
        .and_then(|()| handle.write_all(b"\n"))
    {
        drop(handle);
        remove_owned(path, &identity);
        return Err(error);
    }
    Ok(Lock {
        path: path.to_owned(),
        token,
        handle: Some(handle),
        identity,
    })
}

pub fn remove_stale(path: &Path, stale_after: Duration) {
    let Ok(before) = fs::metadata(path) else {
        return;
    };
    let Ok(modified) = before.modified() else {
        return;
    };
    if SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default()
        <= stale_after
    {
        return;
    }
    let Ok(identity) = Handle::from_path(path) else {
        return;
    };
    if let Some(metadata) = read_metadata(path)
        && !process::is_dead(metadata.pid)
    {
        return;
    }
    // Recheck after inspecting metadata and PID: another owner may have replaced
    // or touched the lock while those potentially slow operations ran.
    let unchanged_time = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        == Some(modified);
    if unchanged_time {
        remove_owned(path, &identity);
    }
}

fn read_metadata(path: &Path) -> Option<Metadata> {
    let metadata: Metadata = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (metadata.created_at.is_finite() && !metadata.token.is_empty()).then_some(metadata)
}
fn remove_owned(path: &Path, identity: &Handle) {
    if Handle::from_path(path).is_ok_and(|current| current == *identity) {
        let _ = fs::remove_file(path);
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        drop(self.handle.take());
        if read_metadata(&self.path).is_some_and(|metadata| metadata.token == self.token) {
            remove_owned(&self.path, &self.identity);
        }
    }
}
fn io_error(error: std::io::Error) -> Error {
    Error::new("VAULT_LOCK_FAILED", error.to_string())
}
