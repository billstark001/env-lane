//! Test transport for the process adapter; child stdout/stderr stay untouched.
use env_lane_core::{
    config,
    error::Result,
    resolve::{Context, Environment, Options},
    run::{self, WorkingDirectory},
    workspace,
};
use serde_json::Value;
use std::{ffi::OsString, path::Path};

fn execute(request: &Value) -> Result<i32> {
    let loaded = config::load(
        Path::new(request["cwd"].as_str().unwrap()),
        request["configFile"].as_str().map(Path::new),
    )?;
    let packages = workspace::list_packages(&loaded)?;
    let process_env: Environment = std::env::vars().collect();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &process_env,
    };
    let command: Vec<OsString> = request["command"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| OsString::from(value.as_str().unwrap()))
        .collect();
    let directory = match request["runCwd"].as_str() {
        None | Some("" | "target") => WorkingDirectory::Target,
        Some("root") => WorkingDirectory::ProjectRoot,
        Some(path) => WorkingDirectory::Path(Path::new(path)),
    };
    let prepared = run::prepare(
        &context,
        &Options {
            target: request["target"].as_str(),
            build: request["build"].as_str(),
            ..Default::default()
        },
        &command,
        directory,
        &mut Vec::new(),
    )?;
    env_lane_cli::process::execute(&prepared)
}

fn main() {
    let input = std::fs::read(std::env::args_os().nth(1).unwrap()).unwrap();
    let request: Value = serde_json::from_slice(&input).unwrap();
    match execute(&request) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{}: {}", error.code, error.message);
            std::process::exit(1);
        }
    }
}
