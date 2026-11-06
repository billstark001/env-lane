use env_lane_vault::lock::{self, Options};
use std::{
    fs::{self, FileTimes},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};

fn age(path: &std::path::Path) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(60)))
        .unwrap();
}

#[test]
fn lock_serializes_updates_and_releases_on_unwind() {
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("store.dat");
    fs::write(&target, "0").unwrap();
    let active = Arc::new(AtomicUsize::new(0));
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let target = &target;
            let active = Arc::clone(&active);
            scope.spawn(move || {
                for _ in 0..10 {
                    let _lock = lock::acquire(target, &Options::default()).unwrap();
                    assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                    let count: usize = fs::read_to_string(target).unwrap().parse().unwrap();
                    fs::write(target, (count + 1).to_string()).unwrap();
                    assert_eq!(active.fetch_sub(1, Ordering::SeqCst), 1);
                }
            });
        }
    });
    assert_eq!(fs::read_to_string(&target).unwrap(), "40");
    let result = std::panic::catch_unwind(|| {
        let _lock = lock::acquire(&target, &Options::default()).unwrap();
        panic!("synthetic operation failure");
    });
    assert!(result.is_err());
    assert!(!target.with_extension("dat.lock").exists());
}

#[cfg(windows)]
#[test]
fn lock_retries_while_previous_file_is_pending_deletion() {
    use std::{os::windows::fs::OpenOptionsExt, time::Instant};

    const DELETE: u32 = 0x0001_0000;
    const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
    const ERROR_ACCESS_DENIED: i32 = 5;

    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("store");
    let path = temporary.path().join("store.lock");
    let keeper = fs::File::create(&path).unwrap();
    let deleting = fs::OpenOptions::new()
        .access_mode(DELETE)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
        .open(&path)
        .unwrap();
    // Closing the deleting handle marks the file, but the keeper holds it open.
    drop(deleting);
    let pending = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap_err();
    assert_eq!(pending.raw_os_error(), Some(ERROR_ACCESS_DENIED));

    let timeout = Duration::from_millis(100);
    let started = Instant::now();
    let error = lock::acquire(
        &target,
        &Options {
            timeout,
            ..Options::default()
        },
    )
    .err()
    .expect("the name is still pending deletion");
    assert_eq!(error.code, "VAULT_LOCK_FAILED");
    assert!(
        started.elapsed() >= timeout,
        "acquisition should retry until its deadline"
    );

    std::thread::scope(|scope| {
        scope.spawn(move || {
            std::thread::sleep(timeout);
            drop(keeper);
        });
        let _lock = lock::acquire(&target, &Options::default()).unwrap();
    });
    assert!(!path.exists());
}

#[test]
fn stale_live_owner_is_retained_and_guard_cannot_remove_replacement() {
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("store");
    let path = temporary.path().join("store.lock");
    let first = lock::acquire(&target, &Options::default()).unwrap();
    age(&path);
    lock::remove_stale(&path, Duration::from_secs(30));
    assert!(path.exists());
    let error = lock::acquire(
        &target,
        &Options {
            timeout: Duration::from_millis(30),
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    assert_eq!(error.code, "VAULT_LOCK_TIMEOUT");
    fs::remove_file(&path).unwrap();
    let replacement = lock::acquire(&target, &Options::default()).unwrap();
    let content = fs::read(&path).unwrap();
    drop(first);
    assert_eq!(fs::read(&path).unwrap(), content);
    drop(replacement);
    assert!(!path.exists());
}

#[test]
fn stale_dead_owner_and_malformed_lock_are_recoverable() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("store.lock");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    for contents in [
        serde_json::json!({"pid":pid,"createdAt":0,"token":"synthetic-old-token"}).to_string(),
        serde_json::json!({"pid":-1,"createdAt":0,"token":"invalid-pid"}).to_string(),
        "malformed metadata".into(),
    ] {
        fs::write(&path, contents).unwrap();
        age(&path);
        lock::remove_stale(&path, Duration::from_secs(30));
        assert!(!path.exists());
    }
}
