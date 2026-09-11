//! Test-only history planner transport.
use env_lane_vault::{
    crypto,
    history::{self, PruneOptions},
    store::{self, ReadOptions, Scope},
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::Path,
};
fn main() {
    for input in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&input.unwrap()).unwrap();
        let base = Path::new(request["base"].as_str().unwrap());
        let key = crypto::load_key(Path::new(request["keyFile"].as_str().unwrap())).unwrap();
        let observations: Vec<_> = request["cases"].as_array().unwrap().iter().map(|case| {
            let path = Path::new(case["path"].as_str().unwrap());
            let loaded = store::read(path, &key, &Scope { base_dir: base, invocation_cwd: base, managed_files: &[], auto_remap_paths: false }, &ReadOptions { ignore_corrupt_records: true, ..Default::default() }).unwrap();
            let plan = history::prune(path, &loaded, &PruneOptions { key: case["key"].as_str(), keep_recent: case["keepRecent"].as_u64().map(|count| count as usize), ..Default::default() }).unwrap();
            let applied = case["apply"].as_bool().unwrap_or(false) && plan.rewrite.apply().unwrap();
            let summary = plan.rewrite.summary();
            json!({"storeDigest":summary.store_digest,"rawRecords":loaded.raw_records,"parsedRecords":loaded.parsed_records,"failedRecords":loaded.failed_records,"aliasedRecords":loaded.aliased_records,"groups":plan.groups,"removedRecords":summary.removed_records,"keptRecords":summary.kept_records,"applied":applied,"lines":store::read_lines(path, false).unwrap()})
        }).collect();
        println!("{}", json!(observations));
    }
}
