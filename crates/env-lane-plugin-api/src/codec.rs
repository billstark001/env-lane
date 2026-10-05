//! Swappable wire boundary: JSON-RPC 2.0 objects in length-prefixed frames.
use serde::{Serialize, de::DeserializeOwned};
use std::io::{self, Read, Write};

pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub trait Codec {
    fn read<T: DeserializeOwned>(&self, reader: &mut impl Read) -> io::Result<T>;
    fn write<T: Serialize>(&self, writer: &mut impl Write, value: &T) -> io::Result<()>;
}

pub struct JsonRpcCodec;

impl Codec for JsonRpcCodec {
    fn read<T: DeserializeOwned>(&self, reader: &mut impl Read) -> io::Result<T> {
        let mut size = [0; 4];
        reader.read_exact(&mut size)?;
        let size = u32::from_le_bytes(size) as usize;
        if size > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "plugin frame too large",
            ));
        }
        let mut bytes = vec![0; size];
        reader.read_exact(&mut bytes)?;
        serde_json::from_slice(&bytes).map_err(io::Error::other)
    }

    fn write<T: Serialize>(&self, writer: &mut impl Write, value: &T) -> io::Result<()> {
        let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
        if bytes.len() > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "plugin frame too large",
            ));
        }
        writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
        writer.write_all(&bytes)?;
        writer.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::{Codec, JsonRpcCodec};
    #[test]
    fn framed_json_preserves_embedded_newlines() {
        let codec = JsonRpcCodec;
        let mut frame = Vec::new();
        codec.write(&mut frame, &"a\nb").unwrap();
        let decoded: String = codec.read(&mut frame.as_slice()).unwrap();
        assert_eq!(decoded, "a\nb");
    }
}
