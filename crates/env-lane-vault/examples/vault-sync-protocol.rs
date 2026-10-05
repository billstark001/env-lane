//! Test-only baseline and conflict transport; production callers use typed APIs.
use env_lane_vault::{crypto, sync::Context};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead},
    path::{Path, PathBuf},
};
fn main() {
    let mut keys: HashMap<PathBuf, crypto::VaultKey> = HashMap::new();
    for input in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&input.unwrap()).unwrap();
        let key_file = Path::new(request["keyFile"].as_str().unwrap());
        if !keys.contains_key(key_file) {
            keys.insert(key_file.to_path_buf(), crypto::load_key(key_file).unwrap());
        }
        let key = keys.get(key_file).unwrap();
        let base = Path::new(request["base"].as_str().unwrap());
        let context = Context::load(Path::new(request["syncDir"].as_str().unwrap()), key).unwrap();
        let local = request["local"].as_str();
        let vault = request["vault"].as_str();
        println!(
            "{}",
            json!({
                "fingerprint": context.fingerprint(local),
                "reason": context.conflict(base, &base.join(".env"), "A", local, vault).map(|conflict| conflict.reason()),
            })
        );
    }
}
