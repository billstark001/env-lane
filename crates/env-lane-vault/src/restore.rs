//! Authenticated Vault restore planning and stale-plan checked application.
use crate::{
    config::{Config, Redaction},
    crypto::{self, VaultKey},
    record::{Change, Record},
    selection,
    store::{self, ReadOptions, Scope, Store},
    sync::Context,
};
use env_lane_core::{
    document::{Patch, PatchOptions},
    error::{Error, Result},
    paths::relative_path,
    redaction, storage,
    text::trim,
};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Add,
    Modify,
    Delete,
    Identical,
    Conflict,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub current: String,
    pub vault: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub entry_id: String,
    pub file_path: PathBuf,
    pub key: String,
    pub action: Action,
    pub occurrence_count: usize,
    pub conflict: bool,
    pub vault_action: Action,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_reason: Option<String>,
    pub preview: Preview,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub file_path: PathBuf,
    pub entries: Vec<Entry>,
    pub changed: bool,
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub add: usize,
    pub modify: usize,
    pub delete: usize,
    pub identical: usize,
    pub conflict: usize,
    pub files_with_changes: usize,
}
impl Summary {
    fn add(&mut self, action: Action) {
        match action {
            Action::Add => self.add += 1,
            Action::Modify => self.modify += 1,
            Action::Delete => self.delete += 1,
            Action::Identical => self.identical += 1,
            Action::Conflict => self.conflict += 1,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub version: u8,
    pub created_at: f64,
    pub plan_digest: String,
    pub store_digest: String,
    pub store_path: PathBuf,
    pub files: Vec<File>,
    pub summary: Summary,
    pub failed_records: usize,
    pub parsed_records: usize,
    pub raw_records: usize,
    pub aliased_records: usize,
    pub unmanaged_store_files: Vec<PathBuf>,
}

pub struct Options<'a> {
    pub invocation_cwd: &'a Path,
    pub sync_dir: Option<&'a Path>,
    pub ignore_corrupt_records: bool,
    /// The JS callback adapter already owns the same cross-process lock.
    pub external_lock: bool,
}
impl<'a> Options<'a> {
    pub fn new(invocation_cwd: &'a Path) -> Self {
        Self {
            invocation_cwd,
            sync_dir: None,
            ignore_corrupt_records: false,
            external_lock: false,
        }
    }
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

fn value(record: &Record) -> Option<&str> {
    match &record.change {
        Change::Set(value) => Some(value),
        Change::Delete => None,
    }
}

fn redact_text(value: &str, config: &Config) -> String {
    if trim(value).encode_utf16().count() < 8 {
        return value.to_owned();
    }
    let Some(reveal) = config.restore.reveal else {
        return "<redacted>".into();
    };
    let start = reveal.start as usize;
    let end = reveal.end as usize;
    if start + end == 0 || value.encode_utf16().count() <= start + end {
        return "<redacted>".into();
    }
    let (prefix, suffix) = reveal_edges(value, start, end);
    format!("<redacted:{}......{}>", prefix, suffix)
}

/// Reveal lengths use JavaScript UTF-16 units, but a boundary inside a
/// surrogate pair must not reveal the whole character from a smaller budget.
fn reveal_edges(value: &str, start: usize, end: usize) -> (String, String) {
    let mut prefix = String::new();
    let mut units = 0;
    for character in value.chars() {
        if units + character.len_utf16() > start {
            break;
        }
        prefix.push(character);
        units += character.len_utf16();
    }
    let mut suffix = Vec::new();
    units = 0;
    for character in value.chars().rev() {
        if units + character.len_utf16() > end {
            break;
        }
        suffix.push(character);
        units += character.len_utf16();
    }
    (prefix, suffix.into_iter().rev().collect())
}

#[cfg(test)]
mod reveal_tests {
    use super::{current_preview, preview, reveal_edges};
    use crate::config::{Config, Redaction, Restore, Reveal};
    use std::path::PathBuf;

    fn preview_config() -> Config {
        Config {
            base_dir: PathBuf::from("."),
            env_files: Vec::new(),
            output_dir: PathBuf::from("."),
            output_file: "store.dat".into(),
            store_path: PathBuf::from("store.dat"),
            track_deletions: true,
            auto_remap_paths: true,
            allow_unmanaged: false,
            restore: Restore {
                redaction: Redaction::Partial,
                reveal: None,
                prompt_loop: false,
            },
            exclude: Vec::new(),
            sort: None,
            disable_unsafe_warning: true,
        }
    }

    #[test]
    fn never_exceeds_utf16_reveal_budget() {
        assert_eq!(reveal_edges("😀secret😀", 1, 1), ("".into(), "".into()));
        assert_eq!(reveal_edges("😀secret😀", 2, 2), ("😀".into(), "😀".into()));
    }

    #[test]
    fn partial_preview_redacts_url_fragment_credentials() {
        let config = preview_config();
        assert_eq!(
            preview(
                "CALLBACK_URL",
                "https://example.test/callback#access_token=synthetic-secret",
                &config,
            ),
            "https://example.test/callback#access_token=<redacted>"
        );
        assert_eq!(
            preview(
                "CALLBACK_URL",
                "https://example.test/#section?token=12345678",
                &config,
            ),
            "https://example.test/#section?token=<redacted>"
        );
        assert_eq!(
            preview(
                "CALLBACK_URL",
                "https://example.test#access_token=/synthetic-secret",
                &config,
            ),
            "https://example.test#access_token=<redacted>"
        );
        assert_eq!(
            preview(
                "CALLBACK_URL",
                "https://example.test/#section=docs",
                &config
            ),
            "https://example.test/#section=docs"
        );
    }

    #[test]
    fn preview_preserves_safe_url_structure_and_the_short_value_floor() {
        let config = preview_config();
        for (key, value, expected) in [
            (
                "API_URL",
                "https://api.example.com/v1/items",
                "https://api.example.com/v1/items",
            ),
            (
                "DATABASE_URL",
                "postgres://user:password@db.example.com:5432/moment",
                "postgres://<redacted>@db.example.com:5432/moment",
            ),
            (
                "CALLBACK_URL",
                "https://example.test/?token=1234567",
                "https://example.test/?token=1234567",
            ),
            (
                "CALLBACK_URL",
                "https://example.test/?token=12345678",
                "https://example.test/?token=<redacted>",
            ),
            (
                "RPC_URL",
                "https://rpc.provider.com/v2/secret-project-id",
                "https://rpc.provider.com/v2/<redacted>",
            ),
        ] {
            assert_eq!(preview(key, value, &config), expected);
        }
    }

    #[test]
    fn full_none_and_reveal_modes_keep_their_explicit_boundaries() {
        let mut config = preview_config();
        config.restore.redaction = Redaction::Full;
        assert_eq!(preview("TOKEN", "1234567", &config), "1234567");
        assert_eq!(preview("TOKEN", "12345678", &config), "<redacted>");
        assert_eq!(
            current_preview("TOKEN", &["1234567".into(), "12345678".into()], &config),
            "[\"1234567\",\"<redacted>\"]"
        );
        config.restore.reveal = Some(Reveal { start: 1, end: 1 });
        assert_eq!(preview("TOKEN", "😀secret😀", &config), "<redacted:......>");
        config.restore.reveal = Some(Reveal { start: 2, end: 2 });
        assert_eq!(
            preview("TOKEN", "😀secret😀", &config),
            "<redacted:😀......😀>"
        );
        config.restore.redaction = Redaction::None;
        assert_eq!(preview("TOKEN", "secret-value", &config), "secret-value");
    }
}

fn preview(key: &str, value: &str, config: &Config) -> String {
    match config.restore.redaction {
        Redaction::Full => redact_text(value, config),
        Redaction::None => value.to_owned(),
        Redaction::Partial => partial_preview(key, value, config),
    }
}

fn decoded(value: &str, query: bool) -> String {
    let value = if query {
        value.replace('+', " ")
    } else {
        value.to_owned()
    };
    percent_decode_str(&value).decode_utf8_lossy().into_owned()
}

fn opaque(value: &str) -> bool {
    if trim(value).encode_utf16().count() < 8 {
        return false;
    }
    let options = redaction::Options {
        min_entropy_length: 16,
        entropy_threshold: 3.5,
        min_character_classes: 2,
        ..Default::default()
    };
    redaction::is_secret_key(value, &options)
        || redaction::is_secret_value(value, &options)
        || redaction::is_high_entropy(value, &options)
}

fn credential_query_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    let key = key.as_str();
    matches!(
        key,
        "token"
            | "_token"
            | "access_token"
            | "accesstoken"
            | "id_token"
            | "idtoken"
            | "refresh_token"
            | "refreshtoken"
            | "api_key"
            | "apikey"
            | "key"
            | "secret"
            | "password"
            | "passwd"
            | "pwd"
            | "signature"
            | "sig"
            | "client_secret"
    )
}

fn redact_url_parameters(value: &str, marker: char, config: &Config) -> String {
    let Some(start) = value.find(marker) else {
        return value.to_owned();
    };
    // A '?' inside a fragment is part of the fragment, not the URL query.
    if marker == '?' && value.find('#').is_some_and(|fragment| fragment < start) {
        return value.to_owned();
    }
    let end = if marker == '?' {
        value[start..]
            .find('#')
            .map_or(value.len(), |offset| start + offset)
    } else {
        value.len()
    };
    let parameters = value[start + 1..end]
        .split('&')
        .map(|part| {
            let (raw_key, raw_value) = part.split_once('=').unwrap_or((part, ""));
            let decoded_value = decoded(raw_value, marker == '?');
            let decoded_key = decoded(raw_key, marker == '?');
            let key = decoded_key.rsplit('?').next().unwrap_or(&decoded_key);
            if trim(&decoded_value).encode_utf16().count() < 8
                || (!credential_query_key(key) && !opaque(&decoded_value))
            {
                part.to_owned()
            } else {
                format!("{raw_key}={}", redact_text(raw_value, config))
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{}{}{}", &value[..start + 1], parameters, &value[end..])
}

fn partial_preview(key: &str, value: &str, config: &Config) -> String {
    let Ok(parsed) = url::Url::parse(value) else {
        return if redaction::is_secret_key(key, &redaction::Options::default()) || opaque(value) {
            redact_text(value, config)
        } else {
            value.to_owned()
        };
    };
    let mut value = value.to_owned();
    if !parsed.username().is_empty()
        || parsed
            .password()
            .is_some_and(|password| !password.is_empty())
    {
        if let Some(scheme_end) = value.find("://") {
            let start = scheme_end + 3;
            let end = value[start..]
                .find(['/', '?', '#'])
                .map_or(value.len(), |offset| start + offset);
            if let Some(at) = value[start..end].rfind('@') {
                let at = start + at;
                let credentials = &value[start..at];
                if trim(&decoded(credentials, false)).encode_utf16().count() >= 8 {
                    value = format!(
                        "{}{}{}",
                        &value[..start],
                        redact_text(credentials, config),
                        &value[at..]
                    );
                }
            } else {
                return redact_text(&value, config);
            }
        } else {
            return redact_text(&value, config);
        }
    }
    value = redact_url_parameters(&value, '?', config);
    if let Some(scheme_end) = value.find("://") {
        let start = scheme_end + 3;
        let authority_end = value[start..]
            .find(['?', '#'])
            .map_or(value.len(), |offset| start + offset);
        if let Some(offset) = value[start..authority_end].find('/') {
            let path_start = start + offset;
            let path_end = value[path_start..]
                .find(['?', '#'])
                .map_or(value.len(), |offset| path_start + offset);
            let path = value[path_start..path_end]
                .split('/')
                .map(|segment| {
                    if segment.is_empty() || !opaque(&decoded(segment, false)) {
                        segment.to_owned()
                    } else {
                        redact_text(segment, config)
                    }
                })
                .collect::<Vec<_>>()
                .join("/");
            value = format!("{}{}{}", &value[..path_start], path, &value[path_end..]);
        }
    }
    redact_url_parameters(&value, '#', config)
}

fn current_preview(key: &str, values: &[String], config: &Config) -> String {
    if values.is_empty() {
        return "<missing>".into();
    }
    if matches!(config.restore.redaction, Redaction::Full)
        && config.restore.reveal.is_none()
        && values
            .iter()
            .all(|value| trim(value).encode_utf16().count() >= 8)
    {
        return "<redacted>".into();
    }
    let values: Vec<_> = values
        .iter()
        .map(|value| preview(key, value, config))
        .collect();
    if values.len() == 1 {
        values[0].clone()
    } else {
        serde_json::to_string(&values).unwrap()
    }
}

fn read_state(
    config: &Config,
    key: &VaultKey,
    options: &Options<'_>,
) -> Result<(Store, Option<Context>)> {
    let exclusions = selection::Exclusions::new(config)?;
    let mut sync = options
        .sync_dir
        .map(|dir| Context::load(dir, key))
        .transpose()?;
    if let Some(context) = &mut sync {
        let mut failure = None;
        context.retain(|entry| {
            let file = config.base_dir.join(&entry.file_path);
            match exclusions.excluded(&file, &entry.key) {
                Ok(excluded) => !excluded,
                Err(error) => {
                    failure = Some(error);
                    true
                }
            }
        });
        if let Some(error) = failure {
            return Err(error);
        }
    }
    let store = store::read(
        &config.store_path,
        key,
        &Scope {
            base_dir: &config.base_dir,
            invocation_cwd: options.invocation_cwd,
            managed_files: &config.env_files,
            auto_remap_paths: config.auto_remap_paths,
        },
        &ReadOptions {
            allow_missing: false,
            ignore_corrupt_records: options.ignore_corrupt_records,
        },
    )?;
    exclusions.assert_clean(&store)?;
    Ok((store, sync))
}

fn from_state(
    config: &Config,
    key: &VaultKey,
    store: &Store,
    sync: Option<&Context>,
) -> Result<Plan> {
    let mut managed: HashSet<PathBuf> = config.env_files.iter().cloned().collect();
    let unmanaged: Vec<_> = store
        .state
        .keys()
        .filter(|file| !managed.contains(*file))
        .cloned()
        .collect();
    let mut targets = config.env_files.clone();
    if config.allow_unmanaged {
        for file in &unmanaged {
            if managed.insert(file.clone()) {
                targets.push(file.clone());
            }
        }
    }
    let exclusions = selection::Exclusions::new(config)?;
    let mut files = Vec::new();
    let mut summary = Summary::default();
    for file_path in targets {
        let document = storage::load_document(&file_path)?.parsed;
        let mut entries = Vec::new();
        for record in store
            .state
            .get(&file_path)
            .into_iter()
            .flat_map(|state| state.values())
        {
            if exclusions.excluded(&file_path, &record.key)? {
                continue;
            }
            let current: Vec<_> = document
                .occurrences_map
                .get(&record.key)
                .into_iter()
                .flat_map(|items| items.iter().map(|item| item.effective_value.clone()))
                .collect();
            let vault_action = match value(record) {
                None if current.is_empty() => Action::Identical,
                None => Action::Delete,
                Some(_) if current.is_empty() => Action::Add,
                Some(vault) if current.iter().all(|item| item == vault) => Action::Identical,
                Some(_) => Action::Modify,
            };
            let conflict = if vault_action == Action::Identical {
                None
            } else {
                sync.and_then(|context| {
                    context.conflict(
                        &config.base_dir,
                        &file_path,
                        &record.key,
                        document
                            .current_map
                            .get(&record.key)
                            .map(|item| item.effective_value.as_str()),
                        value(record),
                    )
                })
            };
            let action = if conflict.is_some() {
                Action::Conflict
            } else {
                vault_action
            };
            summary.add(action);
            let mut fingerprint_input = serde_json::Map::new();
            fingerprint_input.insert(
                "op".into(),
                serde_json::Value::from(if value(record).is_some() {
                    "set"
                } else {
                    "delete"
                }),
            );
            if let Some(value) = value(record) {
                fingerprint_input.insert("v".into(), serde_json::Value::from(value));
            }
            let record_fingerprint = crypto::vault_digest(
                key,
                serde_json::to_string(&fingerprint_input)
                    .unwrap()
                    .as_bytes(),
            );
            let current_fingerprint =
                crypto::vault_digest(key, serde_json::to_string(&current).unwrap().as_bytes());
            let timestamp = if record.timestamp.fract() == 0.0
                && record.timestamp >= 0.0
                && record.timestamp <= u64::MAX as f64
            {
                serde_json::Value::from(record.timestamp as u64)
            } else {
                serde_json::Value::from(record.timestamp)
            };
            let identity = serde_json::json!({
                "filePath": relative_path(&config.base_dir, &file_path),
                "key": record.key,
                "action": action,
                "vaultAction": vault_action,
                "timestamp": timestamp,
                "record": record_fingerprint,
                "local": current_fingerprint,
            });
            let entry_id =
                crypto::vault_digest(key, serde_json::to_string(&identity).unwrap().as_bytes());
            entries.push(Entry {
                entry_id,
                file_path: file_path.clone(),
                key: record.key.clone(),
                action,
                occurrence_count: current.len(),
                conflict: conflict.is_some(),
                vault_action,
                conflict_reason: conflict.map(|reason| reason.reason().to_owned()),
                preview: Preview {
                    current: current_preview(&record.key, &current, config),
                    vault: value(record).map_or_else(
                        || "<delete>".into(),
                        |value| preview(&record.key, value, config),
                    ),
                },
            });
        }
        entries.sort_by(|left, right| left.key.cmp(&right.key));
        let changed = entries
            .iter()
            .any(|entry| entry.action != Action::Identical);
        if changed {
            summary.files_with_changes += 1;
        }
        files.push(File {
            file_path,
            entries,
            changed,
        });
    }
    let store_digest = crypto::stable_hash(
        store
            .records
            .iter()
            .map(|line| line.encrypted_line.as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .as_bytes(),
    );
    let file_ids: Vec<Vec<&str>> = files
        .iter()
        .map(|file| {
            file.entries
                .iter()
                .map(|entry| entry.entry_id.as_str())
                .collect()
        })
        .collect();
    let digest_input = serde_json::json!({"storeDigest":store_digest,"files":file_ids,"unmanagedStoreFiles":unmanaged});
    let plan_digest = crypto::vault_digest(
        key,
        serde_json::to_string(&digest_input).unwrap().as_bytes(),
    );
    Ok(Plan {
        version: 1,
        created_at: now(),
        plan_digest,
        store_digest,
        store_path: config.store_path.clone(),
        files,
        summary,
        failed_records: store.failed_records,
        parsed_records: store.parsed_records,
        raw_records: store.raw_records,
        aliased_records: store.aliased_records,
        unmanaged_store_files: unmanaged,
    })
}

pub fn build(config: &Config, key: &VaultKey, options: &Options<'_>) -> Result<Plan> {
    // A missing store has no writer snapshot to coordinate with. Read it
    // directly so a preview does not create the absent output directory just
    // to place an operation lock before returning STORE_NOT_FOUND.
    if !config.store_path.exists() {
        let (store, sync) = read_state(config, key, options)?;
        return from_state(config, key, &store, sync.as_ref());
    }
    let _guard = if options.external_lock {
        None
    } else {
        Some(store::persistence::operation_lock(&config.store_path)?)
    };
    let (store, sync) = read_state(config, key, options)?;
    from_state(config, key, &store, sync.as_ref())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionChoice {
    ApplyVault,
    KeepLocal,
    Skip,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub entry_id: String,
    pub decision: DecisionChoice,
}

pub struct ApplyOptions<'a> {
    pub read: Options<'a>,
    pub auto_approve: bool,
    pub approve_deletes: Option<bool>,
    pub decisions: Option<Vec<Decision>>,
    pub conflict_strategy: crate::push::ConflictStrategy,
    pub external_lock: bool,
}
impl<'a> ApplyOptions<'a> {
    pub fn new(invocation_cwd: &'a Path) -> Self {
        Self {
            read: Options::new(invocation_cwd),
            auto_approve: false,
            approve_deletes: None,
            decisions: None,
            conflict_strategy: crate::push::ConflictStrategy::Abort,
            external_lock: false,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub file_path: PathBuf,
    pub keys: usize,
    pub changed: bool,
    pub entries: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    #[serde(flatten)]
    pub plan: Plan,
    pub applied: bool,
    pub files_written: usize,
    pub results: Vec<FileResult>,
    pub decisions: Vec<Decision>,
    pub applied_entries: usize,
    pub skipped_entries: usize,
    pub conflicts_kept_local: usize,
    pub conflicts_took_vault: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_state_path: Option<PathBuf>,
    pub sync_state_migrated_from_version_0: bool,
}

pub fn apply(
    config: &Config,
    key: &VaultKey,
    submitted: &Plan,
    options: &ApplyOptions<'_>,
) -> Result<ApplyResult> {
    let _guard = if options.external_lock {
        None
    } else {
        Some(store::persistence::operation_lock(&config.store_path)?)
    };
    let (store, mut sync) = read_state(config, key, &options.read)?;
    let plan = from_state(config, key, &store, sync.as_ref())?;
    let submitted_ids: Vec<_> = submitted
        .files
        .iter()
        .flat_map(|file| file.entries.iter().map(|entry| &entry.entry_id))
        .collect();
    let current_ids: Vec<_> = plan
        .files
        .iter()
        .flat_map(|file| file.entries.iter().map(|entry| &entry.entry_id))
        .collect();
    let unique_submitted: HashSet<&str> = submitted_ids.iter().map(|id| id.as_str()).collect();
    let unique_current: HashSet<&str> = current_ids.iter().map(|id| id.as_str()).collect();
    if submitted.version != 1
        || submitted.store_path != plan.store_path
        || submitted.plan_digest != plan.plan_digest
        || unique_submitted.len() != submitted_ids.len()
        || unique_current.len() != current_ids.len()
        || unique_submitted != unique_current
    {
        return Err(Error::new(
            "VAULT_PLAN_STALE",
            "The Vault plan is stale or belongs to different inputs. Generate a new plan before applying.",
        ));
    }
    let decisions_by_id: Option<HashMap<&str, &Decision>> =
        options.decisions.as_ref().map(|decisions| {
            decisions
                .iter()
                .map(|decision| (decision.entry_id.as_str(), decision))
                .collect()
        });
    if let (Some(decisions), Some(by_id)) = (&options.decisions, &decisions_by_id) {
        if by_id.len() != decisions.len() {
            return Err(Error::new(
                "VAULT_INVALID_DECISION",
                "Decision entryIds must be unique.",
            ));
        }
        if by_id.keys().any(|id| !unique_current.contains(*id)) {
            return Err(Error::new(
                "VAULT_UNKNOWN_ENTRY_ID",
                "Decision references an entry that is not in the current plan.",
            ));
        }
    }
    let mut resolved = Vec::new();
    let mut selected = HashSet::new();
    for entry in plan.files.iter().flat_map(|file| &file.entries) {
        if entry.action == Action::Identical {
            continue;
        }
        let decision = if let Some(by_id) = &decisions_by_id {
            by_id.get(entry.entry_id.as_str())
                .ok_or_else(|| Error::new("VAULT_MISSING_DECISIONS", "Explicit decisions must cover every non-identical entry in the current plan."))?.decision.clone()
        } else if entry.action == Action::Delete && options.approve_deletes == Some(false) {
            DecisionChoice::Skip
        } else if entry.action == Action::Conflict {
            match options.conflict_strategy {
                crate::push::ConflictStrategy::KeepLocal => DecisionChoice::KeepLocal,
                crate::push::ConflictStrategy::TakeVault => DecisionChoice::ApplyVault,
                crate::push::ConflictStrategy::Abort => {
                    return Err(Error::new(
                        "VAULT_CONFLICT_DECISION_REQUIRED",
                        "Vault conflict resolution requires a decision map, resolveConflict callback, or an explicit non-interactive strategy.",
                    ));
                }
            }
        } else {
            DecisionChoice::ApplyVault
        };
        if matches!(decision, DecisionChoice::ApplyVault) {
            selected.insert(entry.entry_id.clone());
        }
        resolved.push(Decision {
            entry_id: entry.entry_id.clone(),
            decision,
        });
    }
    if !selected.is_empty() && !options.auto_approve {
        return Err(Error::new(
            "VAULT_CONFIRMATION_REQUIRED",
            "Applying the Vault plan requires explicit approval.",
        ));
    }
    let mut results = Vec::new();
    let mut files_written = 0;
    for file in &plan.files {
        let mut patches = Vec::new();
        for entry in &file.entries {
            if !selected.contains(&entry.entry_id) {
                continue;
            }
            let Some(record) = store
                .state
                .get(&file.file_path)
                .and_then(|records| records.get(&entry.key))
            else {
                continue;
            };
            patches.push(match &record.change {
                Change::Set(value) => Patch::Set {
                    key: entry.key.clone(),
                    value: value.to_string(),
                },
                Change::Delete => Patch::Delete {
                    key: entry.key.clone(),
                },
            });
        }
        patches.sort_by(|left, right| {
            let left = match left {
                Patch::Set { key, .. } | Patch::Delete { key } => key,
            };
            let right = match right {
                Patch::Set { key, .. } | Patch::Delete { key } => key,
            };
            left.cmp(right)
        });
        let changed = if patches.is_empty() {
            false
        } else {
            storage::patch_file(&file.file_path, &patches, &PatchOptions::default())?.changed
        };
        if changed {
            files_written += 1;
        }
        results.push(FileResult {
            file_path: file.file_path.clone(),
            keys: file
                .entries
                .iter()
                .filter(|entry| entry.action != Action::Delete)
                .count(),
            changed,
            entries: file.entries.clone(),
        });
    }
    if let Some(context) = &mut sync {
        for file in &plan.files {
            for entry in &file.entries {
                if (entry.action == Action::Identical || selected.contains(&entry.entry_id))
                    && let Some(record) = store
                        .state
                        .get(&file.file_path)
                        .and_then(|records| records.get(&entry.key))
                {
                    context.update(&config.base_dir, record, now())?;
                }
            }
        }
        context.save()?;
    }
    let conflict_ids: HashSet<_> = plan
        .files
        .iter()
        .flat_map(|file| &file.entries)
        .filter(|entry| entry.action == Action::Conflict)
        .map(|entry| entry.entry_id.as_str())
        .collect();
    let conflicts_kept_local = resolved
        .iter()
        .filter(|decision| {
            matches!(decision.decision, DecisionChoice::KeepLocal)
                && conflict_ids.contains(decision.entry_id.as_str())
        })
        .count();
    let conflicts_took_vault = resolved
        .iter()
        .filter(|decision| {
            matches!(decision.decision, DecisionChoice::ApplyVault)
                && conflict_ids.contains(decision.entry_id.as_str())
        })
        .count();
    let applied_entries = selected.len();
    let skipped_entries = resolved.len() - applied_entries;
    Ok(ApplyResult {
        plan,
        applied: files_written > 0,
        files_written,
        results,
        decisions: resolved,
        applied_entries,
        skipped_entries,
        conflicts_kept_local,
        conflicts_took_vault,
        sync_state_path: options
            .read
            .sync_dir
            .map(|path| path.join("vault-sync-state.json")),
        sync_state_migrated_from_version_0: sync
            .as_ref()
            .is_some_and(|context| context.migrated_from_version_0),
    })
}
