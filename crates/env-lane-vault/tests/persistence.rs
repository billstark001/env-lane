use env_lane_vault::{
    crypto, record,
    store::{self, persistence},
};
use std::{fs, sync::Arc, thread};

#[test]
fn concurrent_appends_preserve_every_record_and_stale_rewrites_fail_closed() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    let path = base.join("history/store.dat");
    let key = Arc::new(crypto::derive_key(b"synthetic concurrency fixture").unwrap());
    persistence::append(&path, base, &key, &[]).unwrap();
    assert!(
        !path.parent().unwrap().exists(),
        "empty append creates no directory"
    );
    thread::scope(|scope| {
        for writer in 0..4 {
            let key = Arc::clone(&key);
            let path = &path;
            scope.spawn(move || {
                for sequence in 0..8 {
                    let wire = serde_json::json!({"version":1,"f":".env","k":format!("W{writer}_{sequence}"),"t":sequence,"op":"set","v":"synthetic"});
                    let record = record::decode(&wire.to_string(), base, base, 0).unwrap();
                    persistence::append(path, base, &key, &[record]).unwrap();
                }
            });
        }
    });
    let lines = store::read_lines(&path, false).unwrap();
    assert_eq!(lines.len(), 32);
    let mut keys = std::collections::BTreeSet::new();
    for line in &lines {
        let plain = crypto::decrypt_record(&key, line).unwrap();
        keys.insert(record::decode(&plain, base, base, 0).unwrap().key);
    }
    assert_eq!(keys.len(), 32);
    let original = fs::read(&path).unwrap();
    let error = persistence::rewrite(&path, &lines[..31], &[]).unwrap_err();
    assert_eq!(error.code, "VAULT_STORE_CHANGED");
    assert_eq!(fs::read(&path).unwrap(), original);
    persistence::rewrite(&path, &lines, &lines[..2]).unwrap();
    assert_eq!(store::read_lines(&path, false).unwrap(), lines[..2]);
    persistence::rewrite(&path, &lines[..2], &[]).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"");
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn append_preserves_existing_ciphertext_bytes_and_supplies_missing_newline() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    let path = base.join("store.dat");
    let key = crypto::derive_key(b"synthetic newline fixture").unwrap();
    let record = record::decode(
        r#"{"version":1,"f":".env","k":"A","t":0,"v":"value"}"#,
        base,
        base,
        0,
    )
    .unwrap();
    for prefix in ["existing", "existing\r\n", "\u{feff}\nexisting"] {
        fs::write(&path, prefix).unwrap();
        persistence::append(&path, base, &key, std::slice::from_ref(&record)).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let expected_prefix = if prefix.ends_with('\n') {
            prefix.to_owned()
        } else {
            format!("{prefix}\n")
        };
        assert!(content.starts_with(&expected_prefix));
        assert!(content.ends_with('\n'));
        let ciphertext = content.strip_prefix(&expected_prefix).unwrap().trim_end();
        assert!(crypto::decrypt_record(&key, ciphertext).is_ok());
    }
}
