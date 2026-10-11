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

#[test]
fn applied_changes_report_only_actual_patches_and_final_decisions() {
    use env_lane_vault::{
        push,
        restore::{Action, Decision, DecisionChoice},
    };
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(
        root.join("env-lane.config.json"),
        r#"{"vault":{"enabled":true}}"#,
    )
    .unwrap();
    fs::write(
        root.join("env-lane.vault.json"),
        r#"{"envFiles":[".env"],"trackDeletions":true}"#,
    )
    .unwrap();
    let loaded = main_config::load(root, None).unwrap();
    let config = config::load(&loaded, None).unwrap();
    let key = crypto::derive_key(b"synthetic report key").unwrap();
    fs::write(
        root.join(".env"),
        "DB_HOST=vault\nDB_PORT=42\nDB_SKIP=vault\nDB_DELETE=old\n",
    )
    .unwrap();
    push::execute(&config, &key, &push::Options::new(root)).unwrap();
    fs::write(
        root.join(".env"),
        "DB_HOST=vault\nDB_PORT=42\nDB_SKIP=vault\n",
    )
    .unwrap();
    push::execute(&config, &key, &push::Options::new(root)).unwrap();
    fs::write(
        root.join(".env"),
        "DB_HOST=local\nDB_SKIP=local\nDB_DELETE=reintroduced\nDB_LOCAL=private\n",
    )
    .unwrap();
    let plan = restore::build(&config, &key, &restore::Options::new(root)).unwrap();
    let mut options = restore::ApplyOptions::new(root);
    options.auto_approve = true;
    options.decisions = Some(
        plan.files
            .iter()
            .flat_map(|file| &file.entries)
            .filter(|entry| entry.action != Action::Identical)
            .map(|entry| Decision {
                entry_id: entry.entry_id.clone(),
                decision: if entry.key == "DB_SKIP" {
                    DecisionChoice::Skip
                } else {
                    DecisionChoice::ApplyVault
                },
            })
            .collect(),
    );
    let result = restore::apply(&config, &key, &plan, &options).unwrap();
    assert_eq!(result.changes.len(), 3);
    assert!(
        result
            .changes
            .iter()
            .any(|change| change.key == "DB_HOST" && change.action == Action::Modify)
    );
    assert!(
        result
            .changes
            .iter()
            .any(|change| change.key == "DB_PORT" && change.action == Action::Add)
    );
    assert!(
        result
            .changes
            .iter()
            .any(|change| change.key == "DB_DELETE" && change.action == Action::Delete)
    );
    assert!(
        !result
            .changes
            .iter()
            .any(|change| change.key == "DB_SKIP" || change.key == "DB_LOCAL")
    );
    let content = fs::read_to_string(root.join(".env")).unwrap();
    assert!(content.contains("DB_SKIP=local"));
    assert!(content.contains("DB_LOCAL=private"));
}
