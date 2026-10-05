//! Supported declarative syntaxes become one JSON-shaped configuration model.
use super::invalid;
use crate::error::Result;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::fmt;
use yaml_serde::Value as YamlValue;

/// JSON, JSONC, and JSON5 share one decoder and the same configuration schema.
pub fn parse_json5(content: &str) -> Result<Value> {
    json5::from_str::<FiniteJson>(content)
        .map(|value| value.0)
        .map_err(|error| invalid(error.to_string()))
}

struct FiniteJson(Value);

impl<'de> Deserialize<'de> for FiniteJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        deserializer.deserialize_any(FiniteJsonVisitor)
    }
}

struct FiniteJsonVisitor;

impl<'de> Visitor<'de> for FiniteJsonVisitor {
    type Value = FiniteJson;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("finite JSON data")
    }

    fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
        Ok(FiniteJson(Value::Null))
    }

    fn visit_none<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
        self.visit_unit()
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Self::Value, E> {
        Ok(FiniteJson(Value::Bool(value)))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Self::Value, E> {
        Ok(FiniteJson(Value::Number(value.into())))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Self::Value, E> {
        Ok(FiniteJson(Value::Number(value.into())))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Self::Value, E> {
        serde_json::Number::from_f64(value)
            .map(|number| FiniteJson(Value::Number(number)))
            .ok_or_else(|| E::custom("JSON5 numbers must be finite JSON numbers"))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
        Ok(FiniteJson(Value::String(value.to_owned())))
    }

    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Self::Value, E> {
        Ok(FiniteJson(Value::String(value)))
    }

    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut sequence: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<FiniteJson>()? {
            values.push(value.0);
        }
        Ok(FiniteJson(Value::Array(values)))
    }

    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut values = serde_json::Map::new();
        while let Some((key, value)) = map.next_entry::<String, FiniteJson>()? {
            if values.insert(key.clone(), value.0).is_some() {
                return Err(de::Error::custom(format!("duplicate JSON5 key: {key}")));
            }
        }
        Ok(FiniteJson(Value::Object(values)))
    }
}

/// TOML values enter the same JSON-shaped schema as the other native formats.
pub fn parse_toml(content: &str) -> Result<Value> {
    let table: toml::Table = toml::from_str(content).map_err(|error| invalid(error.to_string()))?;
    toml_to_json(toml::Value::Table(table))
}

fn toml_to_json(value: toml::Value) -> Result<Value> {
    match value {
        toml::Value::String(value) => Ok(Value::String(value)),
        toml::Value::Integer(value) => Ok(Value::Number(value.into())),
        toml::Value::Float(value) => serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| invalid("TOML numbers must be finite JSON numbers")),
        toml::Value::Boolean(value) => Ok(Value::Bool(value)),
        toml::Value::Datetime(value) => Ok(Value::String(value.to_string())),
        toml::Value::Array(values) => Ok(Value::Array(
            values
                .into_iter()
                .map(toml_to_json)
                .collect::<Result<_>>()?,
        )),
        toml::Value::Table(table) => {
            let mut object = serde_json::Map::new();
            for (key, value) in table {
                object.insert(key, toml_to_json(value)?);
            }
            Ok(Value::Object(object))
        }
    }
}

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
