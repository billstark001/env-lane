//! YAML is an alternate spelling of JSON data, not a second configuration model.
use super::invalid;
use crate::error::Result;
use serde_json::Value;
use yaml_serde::Value as YamlValue;

/// Decode one YAML 1.2 document without silently discarding unsupported data.
/// The YAML deserializer rejects duplicate mapping keys and additional documents.
pub fn parse_yaml(content: &str) -> Result<Value> {
    let value = yaml_serde::from_str(content).map_err(|error| invalid(error.to_string()))?;
    yaml_to_json(value)
}

fn yaml_to_json(value: YamlValue) -> Result<Value> {
    match value {
        YamlValue::Null => Ok(Value::Null),
        YamlValue::Bool(value) => Ok(Value::Bool(value)),
        YamlValue::String(value) => Ok(Value::String(value)),
        YamlValue::Number(number) => yaml_number_to_json(number),
        YamlValue::Sequence(items) => {
            let items = items.into_iter().map(yaml_to_json).collect::<Result<_>>()?;
            Ok(Value::Array(items))
        }
        YamlValue::Mapping(mapping) => {
            let mut object = serde_json::Map::new();
            for (key, value) in mapping {
                let YamlValue::String(key) = key else {
                    return Err(invalid("YAML mapping keys must be strings"));
                };
                object.insert(key, yaml_to_json(value)?);
            }
            Ok(Value::Object(object))
        }
        YamlValue::Tagged(_) => Err(invalid("YAML tags are not supported")),
    }
}

fn yaml_number_to_json(number: yaml_serde::Number) -> Result<Value> {
    // serde_json serializes NaN/infinity as null. Reject them explicitly to avoid
    // accepting a YAML file whose meaning changes when compiled to JSON.
    if number.as_f64().is_some_and(|value| !value.is_finite()) {
        return Err(invalid("YAML numbers must be finite JSON numbers"));
    }
    serde_json::to_value(number).map_err(|error| invalid(error.to_string()))
}
