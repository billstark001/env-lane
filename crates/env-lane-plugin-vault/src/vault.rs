//! Native Vault command dispatch; each operation lives with its own policy.
mod encrypt;
mod history;
mod options;
mod plan;
mod restore;

use crate::arguments::VaultOperation;
use env_lane_cli::{arguments::Common, output::Output};
use env_lane_core::{error::Result, resolve::Context};

pub fn execute(
    operation: &VaultOperation,
    common: &Common,
    context: &Context<'_>,
    output: &Output,
) -> Result<i32> {
    output.require_text_or_json("Vault commands do not support --format dotenv.")?;
    match operation {
        VaultOperation::Encrypt { .. } => encrypt::execute(operation, context, output),
        VaultOperation::Plan { .. }
        | VaultOperation::Decrypt { .. }
        | VaultOperation::Apply { .. } => restore::execute(operation, common, context, output),
        VaultOperation::Sanitize { .. } | VaultOperation::Prune { .. } => {
            history::execute(operation, common, context, output)
        }
    }
}
