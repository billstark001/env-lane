use env_lane_core::config as main_config;
use env_lane_vault::config;
use std::{fs, path::Path};

#[test]
fn native_formats_preserve_origin_and_reject_invalid_reveal() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    let main = main_config::load(root, None).unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    for (name, content) in [
        (
            "vault.json",
            "\u{feff}{\"envFiles\":[\"../.env\",\"../.env\"]}",
        ),
        ("vault.yaml", "envFiles: [../.env, ../.env]\n"),
    ] {
        fs::write(root.join("nested").join(name), content).unwrap();
        let loaded = config::load(&main, Some(&Path::new("nested").join(name))).unwrap();
        assert_eq!(loaded.base_dir, root.join("nested"));
        assert_eq!(loaded.env_files, [root.join(".env")]);
        assert_eq!(
            loaded.store_path,
            root.join("nested/.env-lane-vault/store.dat")
        );
    }
    for raw in [
        r#"{"envFiles":[],"restore":{"reveal":true}}"#,
        r#"{"envFiles":[],"restore":{"reveal":{"start":65}}}"#,
        r#"{"envFiles":[],"restore":{"reveal":{"end":-1}}}"#,
        r#"{"envFiles":[],"restore":{"reveal":{"start":1.5}}}"#,
        r#"{"envFiles":[""]}"#,
        r#"{"envFiles":[],"sort":null}"#,
        r#"{"envFiles":[],"disableUnsafeWarning":null}"#,
        r#"{"envFiles":[],"sort":{"app":{"file":"a","template":"b","files":null}}}"#,
        r#"{"envFiles":[],"exclude":[{"files":[],"keys":["A"]}]}"#,
    ] {
        fs::write(root.join("invalid.json"), raw).unwrap();
        assert_eq!(
            config::load(&main, Some(Path::new("invalid.json")))
                .err()
                .unwrap()
                .code,
            "VAULT_INVALID_CONFIG"
        );
    }
}

#[test]
fn extensionless_vault_config_prefers_native_json_over_executable_source() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(
        root.join("env-lane.vault.ts"),
        "throw new Error('must not run')",
    )
    .unwrap();
    fs::write(root.join("env-lane.vault.json"), r#"{"envFiles":[".env"]}"#).unwrap();

    let main = main_config::load(root, None).unwrap();
    let loaded = config::load(&main, None).unwrap();
    assert_eq!(loaded.env_files, [root.join(".env")]);
}

#[cfg(unix)]
#[test]
fn store_symlink_cannot_alias_a_managed_env_file() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join(".env"), "A=keep\n").unwrap();
    fs::write(root.join("vault.json"), r#"{"envFiles":[".env"]}"#).unwrap();
    fs::create_dir(root.join(".env-lane-vault")).unwrap();
    symlink("../.env", root.join(".env-lane-vault/store.dat")).unwrap();

    let main = main_config::load(root, None).unwrap();
    let error = config::load(&main, Some(Path::new("vault.json")))
        .err()
        .unwrap();
    assert_eq!(error.code, "VAULT_STORE_OVERLAP");
    assert_eq!(fs::read_to_string(root.join(".env")).unwrap(), "A=keep\n");
}

#[cfg(unix)]
#[test]
fn managed_env_symlink_aliases_are_rejected() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join(".env"), "A=keep\n").unwrap();
    symlink(".env", root.join("alias.env")).unwrap();
    fs::write(
        root.join("vault.json"),
        r#"{"envFiles":[".env","alias.env"]}"#,
    )
    .unwrap();

    let main = main_config::load(root, None).unwrap();
    let error = config::load(&main, Some(Path::new("vault.json")))
        .err()
        .unwrap();
    assert_eq!(error.code, "VAULT_INVALID_CONFIG");
}

#[cfg(unix)]
#[test]
fn dangling_env_symlink_cannot_become_the_store_after_creation() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join("vault.json"), r#"{"envFiles":[".env"]}"#).unwrap();
    symlink(".env-lane-vault/store.dat", root.join(".env")).unwrap();

    let main = main_config::load(root, None).unwrap();
    let error = config::load(&main, Some(Path::new("vault.json")))
        .err()
        .unwrap();
    assert_eq!(error.code, "VAULT_STORE_OVERLAP");
    assert!(!root.join(".env-lane-vault").exists());
}
