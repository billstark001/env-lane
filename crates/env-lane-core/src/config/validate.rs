//! Semantic constraints that cannot be expressed by field types alone.
use super::{Config, KeyRef, Rule, SortTarget, Sync, ValueSource, invalid};
use crate::error::Result;
use serde_json::Value;

impl Config {
    /// Apply defaults and validate the same schema regardless of source format.
    pub fn from_value(raw: Value) -> Result<Self> {
        let config: Self =
            serde_json::from_value(raw.clone()).map_err(|error| invalid(error.to_string()))?;
        config.validate_selector_and_files()?;

        // The resolved default is empty to mean "infer from cwd". An explicitly
        // supplied target must be nonempty, so presence matters before defaults.
        if raw.pointer("/workspace/defaultTarget").is_some() {
            require_nonempty(&config.workspace.default_target, "workspace.defaultTarget")?;
        }
        if let Some(targets) = &config.sort {
            for target in targets.values() {
                validate_sort_target(target)?;
            }
        }
        if let Some(checks) = &config.checks {
            for check in checks.values() {
                for source in check.sources.values() {
                    validate_source(source)?;
                }
                for rule in &check.rules {
                    validate_rule(rule)?;
                }
            }
        }
        if let Some(syncs) = &config.sync {
            for sync in syncs.values() {
                validate_sync(sync)?;
            }
        }
        Ok(config)
    }

    fn validate_selector_and_files(&self) -> Result<()> {
        for (value, field) in [
            (&self.selector.env_key, "selector.envKey"),
            (&self.selector.default_build, "selector.defaultBuild"),
            (&self.dotenv.local_build_name, "dotenv.localBuildName"),
            (&self.dotenv.local_override_file, "dotenv.localOverrideFile"),
            (&self.vault.config_file, "vault.configFile"),
        ] {
            require_nonempty(value, field)?;
        }
        for (values, field) in [
            (&self.selector.builds, "selector.builds"),
            (&self.workspace.package_globs, "workspace.packageGlobs"),
            (&self.dotenv.order, "dotenv.order"),
        ] {
            for value in values {
                require_nonempty(value, field)?;
            }
        }
        for target in self.workspace.aliases.values() {
            require_nonempty(target, "workspace.aliases")?;
        }
        Ok(())
    }
}

fn require_nonempty(value: &str, field: &str) -> Result<()> {
    if value.is_empty() {
        return Err(invalid(format!("{field} must not be empty")));
    }
    Ok(())
}

fn validate_source(source: &ValueSource) -> Result<()> {
    if source.target.is_some() == source.file.is_some() {
        return Err(invalid("source must include target or file, but not both"));
    }
    if let Some(target) = &source.target {
        require_nonempty(target, "source.target")?;
    }
    if let Some(file) = &source.file {
        require_nonempty(file, "source.file")?;
    }
    Ok(())
}

fn validate_sort_target(target: &SortTarget) -> Result<()> {
    for file in [&target.file, &target.template].into_iter().flatten() {
        require_nonempty(file, "sort path")?;
    }
    if target
        .base_dir
        .as_ref()
        .is_some_and(|path| path.as_os_str().is_empty())
    {
        return Err(invalid("sort baseDir must not be empty"));
    }
    if let Some(files) = &target.files {
        for file in files.values() {
            require_nonempty(file, "sort file")?;
        }
    }
    Ok(())
}

fn validate_key_ref(reference: &KeyRef) -> Result<()> {
    require_nonempty(&reference.source, "source")?;
    require_nonempty(&reference.key, "key")
}

fn validate_rule(rule: &Rule) -> Result<()> {
    let options = match rule {
        Rule::Required {
            source,
            key,
            options,
        } => {
            require_nonempty(source, "source")?;
            require_nonempty(key, "key")?;
            options
        }
        Rule::RequiredAny {
            source,
            keys,
            options,
        } => {
            require_nonempty(source, "source")?;
            if keys.is_empty() {
                return Err(invalid("requiredAny.keys must not be empty"));
            }
            for key in keys {
                require_nonempty(key, "key")?;
            }
            options
        }
        Rule::Equals {
            left,
            right,
            options,
            ..
        } => {
            validate_key_ref(left)?;
            validate_key_ref(right)?;
            options
        }
    };
    if let Some(label) = &options.label {
        require_nonempty(label, "label")?;
    }
    Ok(())
}

fn validate_sync(sync: &Sync) -> Result<()> {
    validate_source(&sync.from)?;
    validate_source(&sync.to.source)?;
    if let Some(variant) = &sync.to.variant {
        require_nonempty(variant, "variant")?;
    }
    if sync.mappings.is_empty() {
        return Err(invalid("sync mappings must not be empty"));
    }
    for mapping in &sync.mappings {
        require_nonempty(&mapping.from, "mapping.from")?;
        require_nonempty(&mapping.to, "mapping.to")?;
    }
    Ok(())
}
