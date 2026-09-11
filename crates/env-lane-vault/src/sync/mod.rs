//! Local synchronization baselines contain keyed fingerprints, never env values.
//! Loading is read-only; callers save only after their accepted writes succeed.
mod persistence;
use crate::{
    crypto::{self, SyncKey, VaultKey},
    record::{Change, Record},
};
use env_lane_core::{
    error::{Error, Result},
    paths::relative_path,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Set,
    Delete,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub file_path: String,
    pub key: String,
    pub op: Operation,
    pub value_fingerprint: String,
    pub vault_timestamp: f64,
    pub synced_at: f64,
}

pub struct Context {
    state_path: PathBuf,
    entries: IndexMap<String, Entry>,
    initial_entries: IndexMap<String, Entry>,
    sync_key: SyncKey,
    pub migrated_from_version_0: bool,
}

impl Context {
    pub fn load(directory: &Path, key: &VaultKey) -> Result<Self> {
        let state_path = directory.join("vault-sync-state.json");
        let loaded = persistence::read(&state_path)?;
        Ok(Self {
            state_path,
            initial_entries: loaded.entries.clone(),
            entries: loaded.entries,
            sync_key: crypto::derive_sync_key(key),
            migrated_from_version_0: loaded.legacy,
        })
    }

    pub fn entries(&self) -> &IndexMap<String, Entry> {
        &self.entries
    }

    pub fn fingerprint(&self, value: Option<&str>) -> String {
        fingerprint(&self.sync_key, value)
    }

    /// The caller supplies time once per operation, so all accepted entries share
    /// a coherent timestamp and deterministic tests need no global clock override.
    pub fn update(&mut self, base_dir: &Path, record: &Record, synced_at: f64) -> Result<()> {
        if !synced_at.is_finite()
            || synced_at < 0.0
            || !record.timestamp.is_finite()
            || record.timestamp < 0.0
        {
            return Err(Error::new(
                "VAULT_INVALID_SYNC_STATE",
                "Sync timestamps must be finite non-negative numbers.",
            ));
        }
        let value = match &record.change {
            Change::Set(value) => Some(value.as_str()),
            Change::Delete => None,
        };
        self.entries.insert(
            entry_id(base_dir, &record.file, &record.key),
            Entry {
                file_path: relative_path(base_dir, &record.file),
                key: record.key.clone(),
                op: if value.is_some() {
                    Operation::Set
                } else {
                    Operation::Delete
                },
                value_fingerprint: self.fingerprint(value),
                vault_timestamp: record.timestamp,
                synced_at,
            },
        );
        Ok(())
    }

    pub fn retain(&mut self, mut keep: impl FnMut(&Entry) -> bool) {
        self.entries.retain(|_, entry| keep(entry));
    }

    /// A baseline permits a one-sided change. With no baseline, differing values
    /// need a decision because neither side can be identified as the newer edit.
    pub fn conflict(
        &self,
        base_dir: &Path,
        file: &Path,
        key: &str,
        local: Option<&str>,
        vault: Option<&str>,
    ) -> Option<Conflict> {
        let local = self.fingerprint(local);
        let vault = self.fingerprint(vault);
        if local == vault {
            return None;
        }
        match self.entries.get(&entry_id(base_dir, file, key)) {
            None => Some(Conflict::Unbased),
            Some(entry) if local != entry.value_fingerprint && vault != entry.value_fingerprint => {
                Some(Conflict::BothChanged)
            }
            Some(_) => None,
        }
    }

    pub fn save(&self) -> Result<()> {
        persistence::save(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Conflict {
    Unbased,
    BothChanged,
}
impl Conflict {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Unbased => "local and vault differ without a sync baseline",
            Self::BothChanged => "local and vault both changed since the last sync",
        }
    }
}

fn entry_id(base: &Path, file: &Path, key: &str) -> String {
    crypto::stable_hash(format!("{}\0{key}", relative_path(base, file)).as_bytes())
}

fn fingerprint(key: &SyncKey, value: Option<&str>) -> String {
    // Field order and omission of v for deletes are part of the persisted HMAC
    // protocol. An empty set value is distinct from a missing/deleted value.
    #[derive(Serialize)]
    struct Input<'a> {
        op: Operation,
        #[serde(skip_serializing_if = "Option::is_none")]
        v: Option<&'a str>,
    }
    let bytes = zeroize::Zeroizing::new(
        serde_json::to_vec(&Input {
            op: if value.is_some() {
                Operation::Set
            } else {
                Operation::Delete
            },
            v: value,
        })
        .expect("string fingerprint input"),
    );
    crypto::keyed_digest(key, &bytes)
}
