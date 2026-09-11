use env_lane_vault::{
    crypto, record,
    sync::{Conflict, Context},
};
use std::fs;

#[test]
fn baselines_distinguish_deletes_and_empty_values_and_detect_three_way_conflicts() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    let sync_dir = base.join("sync");
    let key = crypto::derive_key(b"synthetic sync baseline").unwrap();
    let mut context = Context::load(&sync_dir, &key).unwrap();
    assert!(!sync_dir.exists(), "loading absent state must be read-only");
    assert_ne!(context.fingerprint(None), context.fingerprint(Some("")));
    let file = base.join(".env");
    assert_eq!(
        context.conflict(base, &file, "A", Some("local"), Some("vault")),
        Some(Conflict::Unbased)
    );
    assert_eq!(context.conflict(base, &file, "A", None, None), None);
    let record = record::decode(
        r#"{"version":1,"f":".env","k":"A","t":100,"v":"initial"}"#,
        base,
        base,
        0,
    )
    .unwrap();
    context.update(base, &record, 200.0).unwrap();
    assert_eq!(
        context.conflict(base, &file, "A", Some("local"), Some("initial")),
        None
    );
    assert_eq!(
        context.conflict(base, &file, "A", Some("initial"), Some("vault")),
        None
    );
    assert_eq!(
        context.conflict(base, &file, "A", Some("local"), Some("vault")),
        Some(Conflict::BothChanged)
    );
    assert_eq!(
        context.conflict(base, &file, "A", None, Some("vault")),
        Some(Conflict::BothChanged)
    );
    context.save().unwrap();
    let loaded = Context::load(&sync_dir, &key).unwrap();
    assert_eq!(loaded.entries().len(), 1);
    assert_eq!(
        loaded.conflict(base, &file, "A", Some("local"), Some("vault")),
        Some(Conflict::BothChanged)
    );
    let text = fs::read_to_string(sync_dir.join("vault-sync-state.json")).unwrap();
    assert!(!text.contains("initial"));
}

#[test]
fn independently_loaded_contexts_merge_changes_and_scrub_only_their_initial_entries() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    let key = crypto::derive_key(b"synthetic merge baseline").unwrap();
    let mut first = Context::load(base, &key).unwrap();
    let mut second = Context::load(base, &key).unwrap();
    for (context, name) in [(&mut first, "A"), (&mut second, "B")] {
        let raw = serde_json::json!({"version":1,"f":".env","k":name,"t":100,"v":"synthetic"});
        context
            .update(
                base,
                &record::decode(&raw.to_string(), base, base, 0).unwrap(),
                200.0,
            )
            .unwrap();
    }
    first.save().unwrap();
    second.save().unwrap();
    assert_eq!(Context::load(base, &key).unwrap().entries().len(), 2);
    first.retain(|_| false);
    first.save().unwrap();
    let reloaded = Context::load(base, &key).unwrap();
    // A was created in this context and absent from its initial snapshot. A later
    // caller must load fresh state before requesting deletion of persisted A.
    assert_eq!(reloaded.entries().len(), 2);
    let mut scrub = reloaded;
    scrub.retain(|entry| entry.key != "A");
    scrub.save().unwrap();
    assert_eq!(
        Context::load(base, &key)
            .unwrap()
            .entries()
            .values()
            .next()
            .unwrap()
            .key,
        "B"
    );
}

#[test]
fn obsolete_hash_state_is_discarded_and_unexpected_format_changes_are_rejected() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    let path = base.join("vault-sync-state.json");
    let key = crypto::derive_key(b"synthetic migration baseline").unwrap();
    fs::write(
        &path,
        r#"{"version":0,"entries":{"old":{"valueHash":"unkeyed"}}}"#,
    )
    .unwrap();
    let migrated = Context::load(base, &key).unwrap();
    assert!(migrated.migrated_from_version_0);
    assert!(migrated.entries().is_empty());
    migrated.save().unwrap();
    let current = Context::load(base, &key).unwrap();
    assert!(!current.migrated_from_version_0);
    fs::write(&path, r#"{"version":2,"entries":{}}"#).unwrap();
    assert_eq!(current.save().unwrap_err().code, "VAULT_SYNC_STATE_CHANGED");
    assert!(fs::read_to_string(&path).unwrap().contains("\"version\":2"));
}
