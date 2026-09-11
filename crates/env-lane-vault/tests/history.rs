use env_lane_vault::{
    crypto,
    history::{self, PruneOptions},
    store::{self, ReadOptions, Scope},
};
use std::fs;

#[test]
fn history_plans_preserve_latest_ties_corrupt_lines_and_unselected_groups() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    let path = base.join("store.dat");
    let key = crypto::derive_key(b"synthetic history fixture").unwrap();
    let mut lines = Vec::new();
    for (name, time, value) in [
        ("A", 10, "old"),
        ("A", 20, "tie-old"),
        ("A", 20, "tie-new"),
        ("B", 1, "untouched"),
    ] {
        lines.push(
            crypto::encrypt_record(
                &key,
                &serde_json::json!({"version":1,"f":".env","k":name,"t":time,"v":value})
                    .to_string(),
            )
            .unwrap(),
        );
    }
    lines.push("unreadable".into());
    fs::write(&path, lines.join("\n")).unwrap();
    let scope = Scope {
        base_dir: base,
        invocation_cwd: base,
        managed_files: &[],
        auto_remap_paths: false,
    };
    let loaded = store::read(
        &path,
        &key,
        &scope,
        &ReadOptions {
            ignore_corrupt_records: true,
            ..Default::default()
        },
    )
    .unwrap();
    let options = PruneOptions {
        key: Some("A"),
        keep_recent: Some(1),
        ..Default::default()
    };
    let plan = history::prune(&path, &loaded, &options).unwrap();
    assert_eq!(plan.groups, 1);
    assert_eq!(plan.rewrite.summary().removed_records, 2);
    assert_eq!(
        store::read_lines(&path, false).unwrap(),
        lines,
        "preview must not write"
    );
    assert!(plan.rewrite.apply().unwrap());
    assert_eq!(store::read_lines(&path, false).unwrap(), lines[2..]);
    assert_eq!(
        plan.rewrite.apply().unwrap_err().code,
        "VAULT_STORE_CHANGED"
    );
    assert!(history::sanitize(&path, base, &loaded, |_, _| true).is_err());
}

#[test]
fn cutoff_preserves_newest_by_default_and_sanitize_keeps_ciphertext_verbatim() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    let path = base.join("store.dat");
    let key = crypto::derive_key(b"synthetic history cutoff").unwrap();
    let mut lines = Vec::new();
    for name in ["REMOVE", "KEEP"] {
        lines.push(
            crypto::encrypt_record(
                &key,
                &serde_json::json!({"version":1,"f":".env","k":name,"t":10,"v":"synthetic"})
                    .to_string(),
            )
            .unwrap(),
        );
    }
    fs::write(&path, lines.join("\n")).unwrap();
    let scope = Scope {
        base_dir: base,
        invocation_cwd: base,
        managed_files: &[],
        auto_remap_paths: false,
    };
    let loaded = store::read(&path, &key, &scope, &Default::default()).unwrap();
    let mut options = PruneOptions {
        older_than: Some(11.0),
        ..Default::default()
    };
    assert_eq!(
        history::prune(&path, &loaded, &options)
            .unwrap()
            .rewrite
            .summary()
            .removed_records,
        0
    );
    options.preserve_latest = false;
    assert_eq!(
        history::prune(&path, &loaded, &options)
            .unwrap()
            .rewrite
            .summary()
            .removed_records,
        2
    );
    options.older_than = Some(10.0);
    assert_eq!(
        history::prune(&path, &loaded, &options)
            .unwrap()
            .rewrite
            .summary()
            .removed_records,
        0
    );
    let plan = history::sanitize(&path, base, &loaded, |_, key| key == "REMOVE").unwrap();
    assert_eq!(plan.affected_entries, [".env:REMOVE"]);
    plan.rewrite.apply().unwrap();
    assert_eq!(store::read_lines(&path, false).unwrap(), lines[1..]);
}
