//! Versioned Vault cryptography. Algorithm parameters and byte layout are durable
//! data contracts; they must not change when dependencies or API bindings change.
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, Tag, aead::AeadInPlace};
use base64::{Engine, engine::general_purpose::STANDARD};
use env_lane_core::error::{Error, Result};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use scrypt::{Params, scrypt};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use zeroize::Zeroizing;

const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const KDF_SALT: &[u8] = b"env-store-v1-kdf-salt";

/// Key material is intentionally neither serializable nor printable.
pub struct VaultKey(Zeroizing<[u8; 32]>);
pub struct SyncKey(Zeroizing<[u8; 32]>);

pub fn load_key(path: &Path) -> Result<VaultKey> {
    let material = Zeroizing::new(fs::read(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::new(
                "VAULT_KEY_NOT_FOUND",
                format!("Key file does not exist: {}", path.display()),
            )
        } else {
            Error::new(
                "VAULT_KEY_READ_FAILED",
                format!("Cannot read key file {}: {error}", path.display()),
            )
        }
    })?);
    if material.is_empty() {
        return Err(Error::new(
            "VAULT_KEY_EMPTY",
            format!("Key file is empty: {}", path.display()),
        ));
    }
    derive_key(&material)
}

pub fn derive_key(material: &[u8]) -> Result<VaultKey> {
    if material.is_empty() {
        return Err(Error::new("VAULT_KEY_EMPTY", "Key material is empty."));
    }
    let mut key = Zeroizing::new([0; 32]);
    // log2(N)=14, r=8, p=1, dkLen=32: exactly the schema-v0/v1 Node writer.
    let parameters = Params::new(14, 8, 1, 32).expect("fixed scrypt parameters");
    scrypt(material, KDF_SALT, &parameters, key.as_mut())
        .map_err(|_| Error::new("VAULT_KEY_DERIVATION_FAILED", "Cannot derive vault key."))?;
    Ok(VaultKey(key))
}

pub fn derive_sync_key(key: &VaultKey) -> SyncKey {
    let mut derived = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(b"env-lane-vault-sync-state-v1"), key.0.as_ref())
        .expand(b"value-fingerprint", derived.as_mut())
        .expect("fixed HKDF output size");
    SyncKey(derived)
}

pub fn stable_hash(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}
pub fn keyed_digest(key: &SyncKey, value: &[u8]) -> String {
    hmac_digest(key.0.as_ref(), value)
}

/// Restore entry identities use the Vault key; baseline fingerprints use the
/// derived SyncKey. Keeping distinct entry points prevents mixing these domains.
pub fn vault_digest(key: &VaultKey, value: &[u8]) -> String {
    hmac_digest(key.0.as_ref(), value)
}

fn hmac_digest(key: &[u8], value: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC key size");
    mac.update(value);
    hex::encode(mac.finalize().into_bytes())
}

pub fn encrypt_record(key: &VaultKey, plaintext: &str) -> Result<String> {
    let mut nonce = [0; IV_BYTES];
    getrandom::fill(&mut nonce).map_err(|_| {
        Error::new(
            "VAULT_RANDOM_FAILED",
            "Cannot obtain a random record nonce.",
        )
    })?;
    encrypt_with_nonce(key, plaintext.as_bytes(), &nonce)
}

// Nonce injection is private: only deterministic protocol tests should supply it.
fn encrypt_with_nonce(key: &VaultKey, plaintext: &[u8], nonce: &[u8; IV_BYTES]) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key.0.as_ref()).expect("AES-256 key size");
    let mut ciphertext = Zeroizing::new(plaintext.to_vec());
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(nonce), b"", &mut ciphertext)
        .map_err(|_| Error::new("VAULT_ENCRYPT_FAILED", "Cannot encrypt vault record."))?;
    let mut payload = Vec::with_capacity(IV_BYTES + TAG_BYTES + ciphertext.len());
    payload.extend_from_slice(nonce);
    payload.extend_from_slice(&tag);
    payload.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(payload))
}

pub fn decrypt_record(key: &VaultKey, encoded: &str) -> Result<Zeroizing<String>> {
    let payload = crate::encoding::decode_line(encoded)?;
    if payload.len() <= IV_BYTES + TAG_BYTES {
        return Err(Error::new(
            "VAULT_INVALID_RECORD",
            "Encrypted record is too short.",
        ));
    }
    let cipher = Aes256Gcm::new_from_slice(key.0.as_ref()).expect("AES-256 key size");
    let nonce = Nonce::from_slice(&payload[..IV_BYTES]);
    let tag = Tag::from_slice(&payload[IV_BYTES..IV_BYTES + TAG_BYTES]);
    let mut plaintext = Zeroizing::new(payload[IV_BYTES + TAG_BYTES..].to_vec());
    cipher
        .decrypt_in_place_detached(nonce, b"", &mut plaintext, tag)
        .map_err(|_| {
            Error::new(
                "VAULT_AUTHENTICATION_FAILED",
                "Cannot authenticate vault record.",
            )
        })?;
    Ok(Zeroizing::new(
        String::from_utf8_lossy(&plaintext).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../compat/fixtures/vault/schema-v0-v1.json"
        ))
        .unwrap()
    }

    #[test]
    fn frozen_kdf_fingerprints_and_both_record_versions_match_exact_bytes() {
        let fixture = fixture();
        let key = derive_key(fixture["keyMaterialUtf8"].as_str().unwrap().as_bytes()).unwrap();
        assert_eq!(hex::encode(key.0.as_ref()), fixture["derivedKeyHex"]);
        let sync_key = derive_sync_key(&key);
        assert_eq!(
            hex::encode(sync_key.0.as_ref()),
            fixture["derivedSyncKeyHex"]
        );
        assert_eq!(
            keyed_digest(
                &sync_key,
                fixture["fingerprintInput"].as_str().unwrap().as_bytes()
            ),
            fixture["fingerprintHex"]
        );
        for record in fixture["records"].as_array().unwrap() {
            let plaintext = record["plaintext"].as_str().unwrap();
            let encrypted = record["ciphertext"].as_str().unwrap();
            assert_eq!(decrypt_record(&key, encrypted).unwrap().as_str(), plaintext);
            let nonce: [u8; IV_BYTES] = hex::decode(record["ivHex"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            assert_eq!(
                encrypt_with_nonce(&key, plaintext.as_bytes(), &nonce).unwrap(),
                encrypted
            );
        }
    }

    #[test]
    fn authentication_rejects_modified_nonce_tag_payload_and_wrong_key() {
        let fixture = fixture();
        let key = derive_key(fixture["keyMaterialUtf8"].as_str().unwrap().as_bytes()).unwrap();
        let encrypted = fixture["records"][1]["ciphertext"].as_str().unwrap();
        let wrong_key = derive_key(b"different synthetic material").unwrap();
        assert!(decrypt_record(&wrong_key, encrypted).is_err());
        let payload = STANDARD.decode(encrypted).unwrap();
        for index in [0, IV_BYTES, IV_BYTES + TAG_BYTES, payload.len() - 1] {
            let mut modified = payload.clone();
            modified[index] ^= 1;
            assert!(decrypt_record(&key, &STANDARD.encode(modified)).is_err());
        }
        for length in [0, 1, IV_BYTES, IV_BYTES + TAG_BYTES, payload.len() - 1] {
            assert!(decrypt_record(&key, &STANDARD.encode(&payload[..length])).is_err());
        }
        let first = encrypt_record(&key, "synthetic record").unwrap();
        let second = encrypt_record(&key, "synthetic record").unwrap();
        assert_ne!(first, second);
        assert_eq!(
            decrypt_record(&key, &first).unwrap().as_str(),
            "synthetic record"
        );
    }
}
