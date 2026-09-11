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
