//! The historical encrypted-line transport accepts both base64 alphabets,
//! omitted padding and ignorable formatting. Authentication applies to decoded
//! bytes; accepting another spelling never bypasses the GCM integrity check.
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use env_lane_core::error::{Error, Result};

pub(crate) fn decode_line(line: &str) -> Result<Vec<u8>> {
    let mut encoded: Vec<u8> = line
        .bytes()
        .take_while(|byte| *byte != b'=')
        .filter_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(byte),
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            _ => None,
        })
        .collect();
    // A single final sextet contains no complete byte and was ignored by the
    // original record reader. Incomplete ciphertext still fails authentication.
    if encoded.len() % 4 == 1 {
        encoded.pop();
    }
    const DECODER: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::RequireNone)
            .with_decode_allow_trailing_bits(true),
    );
    DECODER.decode(encoded).map_err(|_| {
        Error::new(
            "VAULT_INVALID_RECORD",
            "Encrypted record is not valid base64.",
        )
    })
}
