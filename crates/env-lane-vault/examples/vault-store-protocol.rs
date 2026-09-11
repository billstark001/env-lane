//! Read-only store observations for differential testing, never a public command.
use env_lane_vault::{
    crypto,
    record::Change,
    store::{self, ReadOptions, Scope},
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::{Path, PathBuf},
};
fn main() {
    for input in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&input.unwrap()).unwrap();
        let root = Path::new(request["root"].as_str().unwrap());
        let managed: Vec<PathBuf> = request["managedFiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| root.join(file.as_str().unwrap()))
            .collect();
        let key = crypto::load_key(Path::new(request["keyFile"].as_str().unwrap())).unwrap();
        let results: Vec<_> = request["cases"].as_array().unwrap().iter().map(|case| {
            let scope = Scope { base_dir: root, invocation_cwd: root, managed_files: &managed, auto_remap_paths: case["autoRemapPaths"].as_bool().unwrap_or(true) };
            match store::read(Path::new(case["storePath"].as_str().unwrap()), &key, &scope, &ReadOptions { ignore_corrupt_records: case["ignoreCorruptRecords"].as_bool().unwrap_or(false), ..Default::default() }) {
                Err(error) => json!({"error":error.code,"message":error.message}),
                Ok(store) => {
                    let entries: Vec<_> = managed.iter().flat_map(|file| store.state.get(file).into_iter().flat_map(|records| records.values()).map(move |record| {
                        json!({"file":file,"key":record.key,"value":match &record.change { Change::Delete => "<delete>", Change::Set(value) => value.as_str() }})
                    })).collect();
                    json!({"failedRecords":store.failed_records,"parsedRecords":store.parsed_records,"rawRecords":store.raw_records,"aliasedRecords":store.aliased_records,"entries":entries})
                }
            }
        }).collect();
        println!("{}", json!(results));
    }
}
