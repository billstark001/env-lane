//! Recover output defaults before the argument parser reports an error.
use crate::{arguments::Common, output::Output};
use env_lane_core::{
    config::{self, OutputFormat},
    paths::resolve_path,
};
use std::{ffi::OsString, path::PathBuf};

pub fn output(arguments: &[OsString]) -> Output {
    let common = read(arguments);
    let mut output = Output {
        format: if common.json || common.format.as_deref() == Some("json") {
            OutputFormat::Json
        } else {
            OutputFormat::Text
        },
        prefix: !common.no_prefix,
    };
    if let Ok(current) = std::env::current_dir() {
        let cwd = common
            .cwd
            .as_ref()
            .map_or(current.clone(), |path| resolve_path(&current, path));
        if let Ok(loaded) = config::load(&cwd, common.config.as_deref()) {
            output.prefix &= loaded.config.output.prefix;
            if !common.json && common.format.is_none() {
                output.format = loaded.config.output.format;
            }
        }
    }
    output
}

fn read(arguments: &[OsString]) -> Common {
    let mut common = Common::default();
    let mut index = 1;
    while index < arguments.len() {
        let argument = arguments[index].to_string_lossy();
        if argument == "--" {
            break;
        }
        let (flag, inline) = argument
            .split_once('=')
            .map_or((argument.as_ref(), None), |(flag, value)| {
                (flag, Some(value))
            });
        if matches!(flag, "--json" | "--no-prefix") {
            if flag == "--json" {
                common.json = true;
            } else {
                common.no_prefix = true;
            }
        } else if matches!(
            flag,
            "-c" | "--config" | "--cwd" | "--format" | "-b" | "--build" | "--run-cwd"
        ) {
            let value = if let Some(value) = inline {
                Some(OsString::from(value))
            } else {
                index += 1;
                arguments.get(index).cloned()
            };
            if let Some(value) = value {
                match flag {
                    "-c" | "--config" if common.config.is_none() => {
                        common.config = Some(PathBuf::from(value))
                    }
                    "--cwd" if common.cwd.is_none() => common.cwd = Some(PathBuf::from(value)),
                    "--format" if common.format.is_none() => {
                        common.format = value.into_string().ok()
                    }
                    _ => {}
                }
            }
        } else if argument.starts_with("-c") && argument.len() > 2 && common.config.is_none() {
            common.config = Some(PathBuf::from(&argument[2..]));
        }
        index += 1;
    }
    common
}
