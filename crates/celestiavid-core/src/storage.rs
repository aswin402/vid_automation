use crate::error::{AppError, AppResult};
use crate::media::ffmpeg_bin::normalize_platform_path;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

/// Prefix used when an asset references an existing local file on disk (zero-copy desktop import)
/// rather than a managed copy inside `storage_dir`.
pub const EXTERNAL_FILE_PREFIX: &str = "file://";

#[derive(Debug, Clone)]
pub struct StorageService {
    pub base_dir: PathBuf,
    secret_key: Vec<u8>,
    default_ttl_secs: u64,
}

impl StorageService {
    pub fn new(base_dir: impl Into<PathBuf>, secret_key: impl Into<Vec<u8>>, default_ttl_secs: u64) -> Self {
        let dir = base_dir.into();
        let _ = fs::create_dir_all(&dir);
        let canon = dir.canonicalize().map(normalize_platform_path).unwrap_or(dir);
        Self {
            base_dir: canon,
            secret_key: secret_key.into(),
            default_ttl_secs,
        }
    }

    pub fn sanitize_filename(filename: &str) -> String {
        let base = Path::new(filename)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("asset.bin");
        let cleaned: String = base
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
            .collect();
        let trimmed = cleaned.trim_matches('_');
        if trimmed.is_empty() {
            "asset.bin".to_string()
        } else {
            trimmed.chars().take(120).collect()
        }
    }

    pub fn generate_storage_key(&self, project_id: &str, kind: &str, filename: &str) -> String {
        let safe_name = Self::sanitize_filename(filename);
        let short_id = &Uuid::new_v4().simple().to_string()[..12];
        format!("projects/{project_id}/{kind}/{short_id}_{safe_name}")
    }

    pub fn make_external_file_key(local_path: &Path) -> AppResult<String> {
        let canonical = local_path
            .canonicalize()
            .map(normalize_platform_path)
            .map_err(|_| {
                AppError::validation(
                    "NOT_FOUND",
                    "Selected local file does not exist or cannot be read.",
                )
            })?;
        Ok(format!("{EXTERNAL_FILE_PREFIX}{}", canonical.display()))
    }

    pub fn is_external_key(storage_key: &str) -> bool {
        storage_key.starts_with(EXTERNAL_FILE_PREFIX)
    }

    pub fn resolve_path(&self, storage_key: &str) -> AppResult<PathBuf> {
        if let Some(raw_path) = storage_key.strip_prefix(EXTERNAL_FILE_PREFIX) {
            return Ok(PathBuf::from(raw_path));
        }

        if storage_key.contains("..") || storage_key.starts_with('/') || storage_key.starts_with('\\') {
            return Err(AppError::forbidden("Invalid storage key path traversal rejected."));
        }
        Ok(self.base_dir.join(storage_key))
    }

    /// Deletes managed files inside `base_dir`, while never deleting a user's external source file!
    pub fn delete_key(&self, storage_key: &str) {
        if Self::is_external_key(storage_key) {
            return;
        }
        if let Ok(path) = self.resolve_path(storage_key) {
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
    }

    pub fn create_signed_token(&self, resource_id: &str, action: &str, ttl_secs: Option<u64>) -> (String, u64) {
        let ttl = ttl_secs.unwrap_or(self.default_ttl_secs);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let exp = now + ttl;
        let payload = format!("{resource_id}:{action}:{exp}");
        let mut mac = HmacSha256::new_from_slice(&self.secret_key).expect("HMAC accepts any key size");
        mac.update(payload.as_bytes());
        let sig = hex::encode(mac.finalize().into_bytes());
        (format!("{exp}.{sig}"), ttl)
    }

    pub fn verify_signed_token(&self, resource_id: &str, action: &str, token: &str) -> bool {
        let Some((exp_str, sig_hex)) = token.split_once('.') else {
            return false;
        };
        let Ok(exp) = exp_str.parse::<u64>() else {
            return false;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if now > exp {
            return false;
        }
        let payload = format!("{resource_id}:{action}:{exp}");
        let Ok(sig_bytes) = hex::decode(sig_hex) else {
            return false;
        };
        let mut mac = HmacSha256::new_from_slice(&self.secret_key).expect("HMAC accepts any key size");
        mac.update(payload.as_bytes());
        mac.verify_slice(&sig_bytes).is_ok()
    }

    pub fn compute_sha256_prefix(file_path: &Path) -> Option<String> {
        // Hash up to first 8 MB + file size so importing multi-GB 4K local files takes <5ms!
        let mut file = fs::File::open(file_path).ok()?;
        let len = file.metadata().ok()?.len();
        let mut hasher = Sha256::new();
        hasher.update(len.to_le_bytes());
        let mut buf = [0u8; 65536];
        let mut remaining = 8 * 1024 * 1024usize;
        while remaining > 0 {
            let to_read = buf.len().min(remaining);
            let n = file.read(&mut buf[..to_read]).ok()?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            remaining -= n;
        }
        Some(hex::encode(hasher.finalize()))
    }
}
