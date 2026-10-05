//! Shared redaction vocabulary. Detection order is defined in the parent module.
use regex::Regex;
use std::sync::LazyLock;

pub(super) static SAFE_KEY_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        compile(r#"^public_key$"#),
        compile(r#"^(?:[a-z0-9]+_)*public_(?:key|cert(?:ificate)?)$"#),
        compile(r#"^public_cert(?:ificate)?$"#),
        compile(r#"^certificate$"#),
        compile(r#"^cert$"#),
        compile(r#"^fingerprint$"#),
        compile(r#"^token_count$"#),
        compile(r#"^tokens_count$"#),
        compile(r#"^max_tokens$"#),
        compile(r#"^key_(?:id|name|type|version)$"#),
        compile(r#"^(?:id|name|type|version)_key$"#),
        compile(r#"^(?:[a-z0-9]+_)*providers?$"#),
        compile(r#"^(?:(?:next_public|vite)_)?supabase_(?:publishable|anon)_key$"#),
        compile(r#"^(?:supabase_)?publishable_key$"#),
        compile(r#"^(?:eth(?:ereum)?|wallet|account|contract)_(?:public_)?address$"#),
    ]
});
pub(super) const SENSITIVE_KEY_TOKENS: &[&str] = &[
    "secret",
    "private",
    "password",
    "passwd",
    "pwd",
    "passphrase",
    "pass",
    "token",
    "bearer",
    "credential",
    "credentials",
    "auth",
    "authorization",
    "cookie",
    "session",
    "jwt",
    "dsn",
    "mnemonic",
];
pub(super) static SAFE_VALUE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        compile(r#"^sb_publishable_[A-Za-z0-9_-]{20,}$"#),
        compile(r#"^0x[0-9a-fA-F]{40}$"#),
    ]
});
pub(super) static SECRET_VALUE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        compile(r#"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"#),
        compile(r#"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b"#),
        compile(r#"\bgithub_pat_[A-Za-z0-9_]{20,}\b"#),
        compile(r#"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"#),
        compile(r#"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b"#),
        compile(r#"\bsk-ant-[A-Za-z0-9_-]{20,}\b"#),
        compile(r#"\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b"#),
        compile(r#"\bsk-[A-Za-z0-9]{20,}\b"#),
        compile(r#"\bsb_secret_[A-Za-z0-9_-]{20,}\b"#),
        compile(r#"\bsbp_[A-Za-z0-9]{20,}\b"#),
        compile(r#"\b(?:cfk|cfut|cfat)_[A-Za-z0-9_-]{40,}\b"#),
        compile(r#"\bgsk_[A-Za-z0-9]{20,}\b"#),
        compile(r#"\bhf_[A-Za-z0-9]{20,}\b"#),
        compile(r#"\bnpm_[A-Za-z0-9]{20,}\b"#),
        compile(r#"\bAIza[0-9A-Za-z_-]{35}\b"#),
        compile(r#"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"#),
        compile(r#"(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b"#),
    ]
});
pub(super) static SENSITIVE_KEY_PHRASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?i)(?:^|_)(?:api_key|access_key|secret_key|private_key|client_secret|client_token|access_token|refresh_token|id_token|auth_token|csrf_token|database_url|db_url|redis_url|redis_uri|rpc_url|mongo_url|mongodb_url|mongo_uri|mongodb_uri|postgres_url|postgresql_url|connection_string|signing_secret|webhook_secret|webhook_url|seed_phrase|recovery_phrase)(?:$|_)"#,
    )
});
pub(super) static COMPACT_SENSITIVE_KEY_RE: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?i)(?:apikey|accesskey|secretkey|privatekey|clientsecret|clienttoken|accesstoken|refreshtoken|idtoken|authtoken|csrftoken|databaseurl|dburl|redisurl|redisuri|rpcurl|mongourl|mongodburl|mongouri|mongodburi|postgresurl|postgresqlurl|connectionstring|signingsecret|webhooksecret|webhookurl|pgpassword|seedphrase|recoveryphrase)"#,
    )
});
pub(super) static JWT_RE: LazyLock<Regex> =
    LazyLock::new(|| compile(r#"^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$"#));
pub(super) static PASETO_RE: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"^v[1-4]\.(?:local|public)\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)?$"#)
});
pub(super) static CREDENTIAL_QUERY_KEY_RE: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?i)^(?:_?token|access_?token|id_?token|refresh_?token|api_?key|key|secret|password|passwd|pwd|signature|sig|client_secret)$"#,
    )
});
pub(super) static INLINE_KV_RE: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?:^|[\s,{])["']?([A-Za-z][A-Za-z0-9_.-]{1,80})["']?\s*[:=]\s*["']?([^"',}\]\s;]{8,})["']?"#,
    )
});

/// Credential prefixes use ASCII word boundaries; non-Latin surrounding text
/// must not hide them. Whitespace follows the same data contract as dotenv text.
pub(super) fn compile(pattern: &str) -> Regex {
    const SPACE: &str = r"[\x09-\x0d\x20\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
    let pattern = pattern.replace(r"\b", r"(?-u:\b)").replace(r"\s", SPACE);
    Regex::new(&pattern).expect("redaction expression")
}
