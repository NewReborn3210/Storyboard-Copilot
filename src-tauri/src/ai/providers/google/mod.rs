use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Client;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{AIProvider, GenerateRequest};

const GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";
const GEMINI_FLASH_MODEL: &str = "gemini-2.0-flash-preview-image-generation";
const IMAGEN_3_MODEL: &str = "imagen-3.0-generate-002";

const SUPPORTED_MODELS: &[&str] = &[
    "gemini-2.0-flash",
    "google/gemini-2.0-flash",
    "imagen-3",
    "google/imagen-3",
];

pub struct GoogleProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl GoogleProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
        }
    }

    fn bare_model(model: &str) -> &str {
        model.split_once('/').map(|(_, m)| m).unwrap_or(model)
    }

    fn normalize_imagen3_aspect_ratio(ratio: &str) -> String {
        match ratio {
            "1:1" | "3:4" | "4:3" | "9:16" | "16:9" => ratio.to_string(),
            _ => "1:1".to_string(),
        }
    }

    fn decode_file_url_path(value: &str) -> String {
        let raw = value.trim_start_matches("file://");
        let decoded = urlencoding::decode(raw)
            .map(|r| r.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        // Handle Windows paths like /C:/... → C:/...
        if decoded.starts_with('/') && decoded.len() > 2 && decoded.as_bytes().get(2) == Some(&b':') {
            decoded[1..].to_string()
        } else {
            decoded
        }
    }

    /// Extract (mimeType, base64Data) from a reference image source.
    fn source_to_inline_data(source: &str) -> Option<(String, String)> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return None;
        }

        // data: URL  →  data:image/jpeg;base64,<payload>
        if let Some((meta, payload)) = trimmed.split_once(',') {
            if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
                let mime = meta
                    .trim_start_matches("data:")
                    .trim_end_matches(";base64")
                    .to_string();
                return Some((mime, payload.to_string()));
            }
        }

        // Raw base64 string (no data: prefix)
        let likely_base64 = trimmed.len() > 256
            && trimmed
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=');
        if likely_base64 {
            return Some(("image/png".to_string(), trimmed.to_string()));
        }

        // HTTP/HTTPS URLs – not supported as inline data, skip
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return None;
        }

        // File path or file:// URL
        let path = if trimmed.starts_with("file://") {
            PathBuf::from(Self::decode_file_url_path(trimmed))
        } else {
            PathBuf::from(trimmed)
        };
        if let Ok(bytes) = std::fs::read(&path) {
            let mime = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| match ext.to_lowercase().as_str() {
                    "jpg" | "jpeg" => "image/jpeg",
                    "png" => "image/png",
                    "webp" => "image/webp",
                    "gif" => "image/gif",
                    _ => "image/png",
                })
                .unwrap_or("image/png");
            return Some((mime.to_string(), STANDARD.encode(bytes)));
        }

        None
    }

    async fn generate_with_gemini_flash(
        &self,
        request: &GenerateRequest,
        api_key: &str,
    ) -> Result<String, AIError> {
        let endpoint = format!(
            "{}/v1beta/models/{}:generateContent",
            GEMINI_BASE_URL, GEMINI_FLASH_MODEL
        );

        let mut parts = vec![json!({"text": request.prompt})];

        // Attach up to 1 reference image as inlineData
        if let Some(ref_images) = &request.reference_images {
            for source in ref_images.iter().take(1) {
                if let Some((mime, data)) = Self::source_to_inline_data(source) {
                    parts.push(json!({
                        "inlineData": {
                            "mimeType": mime,
                            "data": data
                        }
                    }));
                }
            }
        }

        let body = json!({
            "contents": [{"parts": parts}],
            "generationConfig": {
                "responseModalities": ["IMAGE", "TEXT"]
            }
        });

        info!(
            "[Google Gemini Flash] endpoint={}, parts_count={}",
            endpoint,
            parts.len()
        );

        let response = self
            .client
            .post(&endpoint)
            .header("x-goog-api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "Gemini Flash API request failed {}: {}",
                status, error_text
            )));
        }

        let resp_body = response.json::<Value>().await?;

        // Extract first image part from candidates[0].content.parts
        let (mime, data) = resp_body
            .pointer("/candidates/0/content/parts")
            .and_then(|parts| parts.as_array())
            .and_then(|parts| {
                parts.iter().find_map(|part| {
                    let mime = part.pointer("/inlineData/mimeType")?.as_str()?;
                    let data = part.pointer("/inlineData/data")?.as_str()?;
                    Some((mime.to_string(), data.to_string()))
                })
            })
            .ok_or_else(|| {
                AIError::Provider(format!(
                    "No image found in Gemini Flash response: {}",
                    resp_body
                ))
            })?;

        Ok(format!("data:{};base64,{}", mime, data))
    }

    async fn generate_with_imagen3(
        &self,
        request: &GenerateRequest,
        api_key: &str,
    ) -> Result<String, AIError> {
        let endpoint = format!(
            "{}/v1beta/models/{}:predict",
            GEMINI_BASE_URL, IMAGEN_3_MODEL
        );

        let aspect_ratio = Self::normalize_imagen3_aspect_ratio(&request.aspect_ratio);

        let body = json!({
            "instances": [{"prompt": request.prompt}],
            "parameters": {
                "sampleCount": 1,
                "aspectRatio": aspect_ratio,
                "safetyFilterLevel": "block_some",
                "personGeneration": "allow_adult"
            }
        });

        info!(
            "[Google Imagen 3] endpoint={}, aspect_ratio={}",
            endpoint, aspect_ratio
        );

        let response = self
            .client
            .post(&endpoint)
            .header("x-goog-api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "Imagen 3 API request failed {}: {}",
                status, error_text
            )));
        }

        let resp_body = response.json::<Value>().await?;

        let b64 = resp_body
            .pointer("/predictions/0/bytesBase64Encoded")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AIError::Provider(format!(
                    "No image found in Imagen 3 response: {}",
                    resp_body
                ))
            })?;

        let mime = resp_body
            .pointer("/predictions/0/mimeType")
            .and_then(|v| v.as_str())
            .unwrap_or("image/png");

        Ok(format!("data:{};base64,{}", mime, b64))
    }
}

impl Default for GoogleProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for GoogleProvider {
    fn name(&self) -> &str {
        "google"
    }

    fn supports_model(&self, model: &str) -> bool {
        let bare = Self::bare_model(model);
        SUPPORTED_MODELS
            .iter()
            .any(|supported| *supported == model || *supported == bare)
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "google/gemini-2.0-flash".to_string(),
            "google/imagen-3".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let key = self.api_key.read().await;
        let api_key = key
            .as_ref()
            .ok_or_else(|| AIError::InvalidRequest("Google AI API key not set".to_string()))?;

        match Self::bare_model(&request.model) {
            "gemini-2.0-flash" => self.generate_with_gemini_flash(&request, api_key).await,
            "imagen-3" => self.generate_with_imagen3(&request, api_key).await,
            other => Err(AIError::ModelNotSupported(other.to_string())),
        }
    }
}
