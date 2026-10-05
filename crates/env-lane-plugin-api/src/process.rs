//! Local process transport. Standard streams remain available for CLI interaction.
use crate::{
    Capability, Handler, Hello, Manifest, PROTOCOL_VERSION, PluginError, Request, Response,
    codec::{Codec, JsonRpcCodec},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, value::RawValue};
use std::{
    io,
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const ADDRESS_ENV: &str = "ENV_LANE_PLUGIN_ADDRESS";
const TOKEN_ENV: &str = "ENV_LANE_PLUGIN_TOKEN";

fn fault(code: &str, message: impl Into<String>) -> PluginError {
    PluginError {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}

pub struct Session {
    child: Child,
    stream: TcpStream,
    codec: JsonRpcCodec,
    next_id: u64,
    capabilities: Vec<Capability>,
}

struct StartingChild(Option<Child>);
impl Drop for StartingChild {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Session {
    pub fn start(manifest: &Manifest) -> Result<Self, PluginError> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        let token = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let child = Command::new(&manifest.executable)
            .args(&manifest.arguments)
            .env(ADDRESS_ENV, listener.local_addr().unwrap().to_string())
            .env(TOKEN_ENV, &token)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| fault("PLUGIN_START_FAILED", error.to_string()))?;
        let mut child = StartingChild(Some(child));
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, address)) if address.ip().is_loopback() => break stream,
                Ok(_) => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if child
                        .0
                        .as_mut()
                        .unwrap()
                        .try_wait()
                        .ok()
                        .flatten()
                        .is_some()
                        || Instant::now() >= deadline
                    {
                        return Err(fault(
                            "PLUGIN_START_FAILED",
                            "Plugin did not connect to its host.",
                        ));
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => return Err(fault("PLUGIN_TRANSPORT_FAILED", error.to_string())),
            }
        };
        stream
            .set_nonblocking(false)
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        let codec = JsonRpcCodec;
        let hello: Hello = codec
            .read(&mut stream)
            .map_err(|error| fault("PLUGIN_HANDSHAKE_FAILED", error.to_string()))?;
        if hello.token != token
            || hello.protocol != PROTOCOL_VERSION
            || hello.plugin_id != manifest.id
            || hello.capabilities != manifest.capabilities
        {
            return Err(fault(
                "PLUGIN_HANDSHAKE_FAILED",
                "Plugin identity, version, or capabilities did not match the manifest.",
            ));
        }
        stream
            .set_read_timeout(None)
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        Ok(Self {
            child: child.0.take().unwrap(),
            stream,
            codec,
            next_id: 1,
            capabilities: hello.capabilities,
        })
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, PluginError> {
        self.call_typed(method, &params)
    }

    /// Encode the concrete request once and decode directly into its result type.
    pub fn call_typed<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &P,
    ) -> Result<R, PluginError> {
        if !self.allows(method) {
            return Err(fault(
                "PLUGIN_CAPABILITY_DENIED",
                format!("Plugin does not declare {method}."),
            ));
        }
        let id = self.next_id;
        self.next_id += 1;
        self.codec
            .write(
                &mut self.stream,
                &TypedRequest {
                    jsonrpc: "2.0",
                    id,
                    method,
                    params,
                },
            )
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        let response: TypedResponse = self
            .codec
            .read(&mut self.stream)
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        if response.jsonrpc != "2.0"
            || response.id != id
            || response.result.is_some() == response.error.is_some()
        {
            return Err(fault("PLUGIN_PROTOCOL_ERROR", "Invalid plugin response."));
        }
        match (response.result, response.error) {
            (Some(result), None) => serde_json::from_str(result.get())
                .map_err(|error| fault("PLUGIN_PROTOCOL_ERROR", error.to_string())),
            (None, Some(error)) => Err(error),
            _ => unreachable!(),
        }
    }

    fn allows(&self, method: &str) -> bool {
        match method {
            "command.invoke" => self
                .capabilities
                .iter()
                .any(|capability| matches!(capability, Capability::Command { .. })),
            "native.invoke" => self
                .capabilities
                .iter()
                .any(|capability| matches!(capability, Capability::NativeApi { .. })),
            "document.filter" => self.capabilities.contains(&Capability::DocumentFilter),
            "env.source" => self.capabilities.contains(&Capability::EnvSource),
            "env.generate" => self.capabilities.contains(&Capability::EnvGenerate),
            "file.plan" => self.capabilities.contains(&Capability::FilePlan),
            _ => false,
        }
    }

    pub fn finish(mut self) -> Result<(), PluginError> {
        self.codec
            .write(
                &mut self.stream,
                &Request {
                    jsonrpc: "2.0".into(),
                    id: self.next_id,
                    method: "plugin.shutdown".into(),
                    params: Value::Null,
                },
            )
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        let response: TypedResponse = self
            .codec
            .read(&mut self.stream)
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        if response.jsonrpc != "2.0"
            || response.id != self.next_id
            || response.error.is_some()
            || response.result.is_none()
        {
            return Err(fault("PLUGIN_PROTOCOL_ERROR", "Plugin shutdown failed."));
        }
        let status = self
            .child
            .wait()
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        if !status.success() {
            return Err(fault(
                "PLUGIN_PROCESS_FAILED",
                format!("Plugin exited with {status}."),
            ));
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct TypedRequest<'a, P> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    params: &'a P,
}

#[derive(serde::Deserialize)]
struct TypedResponse {
    jsonrpc: String,
    id: u64,
    #[serde(default, deserialize_with = "present_raw_result")]
    result: Option<Box<RawValue>>,
    error: Option<PluginError>,
}

fn present_raw_result<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Box<RawValue>>, D::Error> {
    Box::<RawValue>::deserialize(deserializer).map(Some)
}

#[derive(serde::Deserialize)]
struct RawRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    params: Box<RawValue>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

pub fn serve(manifest: &Manifest, handler: &mut impl Handler) -> Result<(), PluginError> {
    let address = std::env::var(ADDRESS_ENV)
        .map_err(|error| fault("PLUGIN_HANDSHAKE_FAILED", error.to_string()))?;
    let token = std::env::var(TOKEN_ENV)
        .map_err(|error| fault("PLUGIN_HANDSHAKE_FAILED", error.to_string()))?;
    let mut stream = TcpStream::connect(address)
        .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
    let codec = JsonRpcCodec;
    codec
        .write(
            &mut stream,
            &Hello {
                token,
                protocol: PROTOCOL_VERSION,
                plugin_id: manifest.id.clone(),
                capabilities: manifest.capabilities.clone(),
            },
        )
        .map_err(|error| fault("PLUGIN_HANDSHAKE_FAILED", error.to_string()))?;
    loop {
        let request: RawRequest = codec
            .read(&mut stream)
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        if request.jsonrpc != "2.0" {
            return Err(fault("PLUGIN_PROTOCOL_ERROR", "Expected JSON-RPC 2.0."));
        }
        let shutdown = request.method == "plugin.shutdown";
        let result = if shutdown {
            Ok(Value::Null)
        } else {
            handler.invoke(&request.method, &request.params)
        };
        let (result, error) = match result {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        };
        codec
            .write(
                &mut stream,
                &Response {
                    jsonrpc: "2.0".into(),
                    id: request.id,
                    result,
                    error,
                },
            )
            .map_err(|error| fault("PLUGIN_TRANSPORT_FAILED", error.to_string()))?;
        if shutdown {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TypedResponse;

    #[test]
    fn null_result_is_present() {
        let response: TypedResponse =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"result":null}"#).unwrap();
        assert_eq!(response.result.unwrap().get(), "null");
    }
}
