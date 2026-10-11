use std::{fs, process::Command};
use tempfile::TempDir;

fn run(root: &std::path::Path, arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_env-lane"))
        .arg("--cwd")
        .arg(root)
        .args(arguments)
        .output()
        .unwrap()
}
fn fixture() -> TempDir {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(
        root.join("env-lane.config.json"),
        r#"{"selector":{"builds":["default"]},"sort":{"default":{"suffixes":["default"]},"app":{"baseDir":"."}}}"#,
    )
    .unwrap();
    fs::write(
        root.join(".env.example"),
        "DB_HOST=one\nDB_PORT=two\nDB_USER=three\n",
    )
    .unwrap();
    temporary
}

#[test]
fn missing_files_require_explicit_creation_and_check_never_writes() {
    let temporary = fixture();
    let root = temporary.path();
    let result = run(root, &["sort", "app", "default", "--json"]);
    assert!(result.status.success());
    let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["missingCount"], 1);
    assert_eq!(value["results"][0]["status"], "missing");
    assert!(!root.join(".env").exists());
    assert!(!root.join(".env.default").exists());
    assert!(!root.join(".env-lane-cache").exists());
    let preview = run(root, &["sort", "app", "default", "--create", "--check"]);
    assert_eq!(preview.status.code(), Some(1));
    assert!(!root.join(".env-lane-cache").exists());
    assert!(!root.join(".env").exists());
    let written = run(root, &["sort", "app", "default", "--create"]);
    assert!(
        written.status.success(),
        "{}",
        String::from_utf8_lossy(&written.stderr)
    );
    assert!(String::from_utf8_lossy(&written.stdout).contains("DB (3)"));
    assert!(root.join(".env").exists());
    assert!(root.join(".env-lane-cache/sort-sync-state.json").exists());
    assert!(!root.join(".env.default").exists());
    let incompatible = run(root, &["sort", "app", "--create", "--no-create"]);
    assert!(!incompatible.status.success());
}

#[test]
fn check_reports_pending_conflicts_even_without_byte_drift() {
    let temporary = fixture();
    let root = temporary.path();
    fs::write(
        root.join(".env"),
        "DB_HOST=one\nDB_PORT=two\nDB_USER=three\n",
    )
    .unwrap();
    assert!(run(root, &["sort", "app", "default"]).status.success());
    fs::write(
        root.join(".env"),
        "DB_HOST=private\nDB_PORT=two\nDB_USER=three\n",
    )
    .unwrap();
    fs::write(
        root.join(".env.example"),
        "DB_HOST=new\nDB_PORT=two\nDB_USER=three\n",
    )
    .unwrap();
    let state = root.join(".env-lane-cache/sort-sync-state.json");
    let saved = fs::read(&state).unwrap();
    let bytes = fs::read(root.join(".env")).unwrap();
    let result = run(root, &["sort", "app", "default", "--json", "--check"]);
    assert_eq!(result.status.code(), Some(1));
    let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["changed"], false);
    assert_eq!(value["results"][0]["status"], "conflict");
    assert_eq!(value["results"][0]["conflicts"][0]["field"], "default");
    assert_eq!(fs::read(&state).unwrap(), saved);
    assert_eq!(fs::read(root.join(".env")).unwrap(), bytes);
}
