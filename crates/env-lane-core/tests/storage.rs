use env_lane_core::{
    document::{Patch, PatchOptions},
    storage::{patch_file, write_atomically, write_if_changed},
};
use std::fs;
use tempfile::TempDir;

#[test]
fn unchanged_empty_write_does_not_create_parent_directories() {
    let temporary = TempDir::new().unwrap();
    let destination = temporary.path().join("absent/nested/.env");
    assert!(!write_if_changed(&destination, "").unwrap());
    assert!(!temporary.path().join("absent").exists());
}

#[test]
fn formatting_failure_leaves_original_bytes_and_no_temporary_file() {
    let temporary = TempDir::new().unwrap();
    let destination = temporary.path().join(".env");
    fs::write(&destination, "A=original\n").unwrap();
    let patches = [
        Patch::Set {
            key: "A".into(),
            value: "updated".into(),
        },
        Patch::Set {
            key: "B".into(),
            value: "all ' \" ` # quotes".into(),
        },
    ];
    assert!(patch_file(&destination, &patches, &PatchOptions::default()).is_err());
    assert_eq!(fs::read_to_string(destination).unwrap(), "A=original\n");
    assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 1);
}

#[test]
fn failed_replacement_cleans_up_temporary_file() {
    let temporary = TempDir::new().unwrap();
    let destination = temporary.path().join("directory");
    fs::create_dir(&destination).unwrap();
    assert!(write_atomically(&destination, "value").is_err());
    assert!(destination.is_dir());
    assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn replacements_preserve_symlinks_and_modes_and_new_files_are_private() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let temporary = TempDir::new().unwrap();
    let destination = temporary.path().join("real.env");
    let link = temporary.path().join("linked.env");
    write_atomically(&destination, "A=one").unwrap();
    assert_eq!(
        fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).unwrap();
    symlink(&destination, &link).unwrap();
    write_atomically(&link, "A=two").unwrap();
    assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
    assert_eq!(fs::read_to_string(&destination).unwrap(), "A=two");
    assert_eq!(
        fs::metadata(destination).unwrap().permissions().mode() & 0o777,
        0o640
    );
}
