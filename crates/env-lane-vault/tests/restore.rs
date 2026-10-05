use env_lane_core::config as main_config;
use env_lane_vault::{config, crypto, restore};
use std::fs;

#[test]
fn missing_store_preview_does_not_create_its_output_directory() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(
        root.join("env-lane.config.json"),
        r#"{"vault":{"enabled":true}}"#,
    )
    .unwrap();
    fs::write(root.join("env-lane.vault.json"), r#"{"envFiles":[".env"]}"#).unwrap();
    let main = main_config::load(root, None).unwrap();
    let config = config::load(&main, None).unwrap();
    let key = crypto::derive_key(b"synthetic preview key").unwrap();

    assert_eq!(
        restore::build(&config, &key, &restore::Options::new(root))
            .err()
            .unwrap()
            .code,
        "VAULT_STORE_NOT_FOUND"
    );
    assert!(!config.output_dir.exists());
}
