use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Client;
use reqwest::multipart::{Form, Part};
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
    base_url: Arc<RwLock<Option<String>>>,
    api_protocol: Arc<RwLock<Option<String>>>,
    custom_model_id: Arc<RwLock<Option<String>>>,
}

impl GoogleProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            base_url: Arc::new(RwLock::new(None)),
            api_protocol: Arc::new(RwLock::new(None)),
            custom_model_id: Arc::new(RwLock::new(None)),
        }
    }

    fn bare_model(model: &str) -> &str {
        model.split_once('/').map(|(_, m)| m).unwrap_or(model)
    }

    fn is_uniapi_base_url(base_url: &str) -> bool {
        base_url.to_ascii_lowercase().contains("uniapi.io")
    }

    fn normalize_uniapi_image_model_id(model_id: &str) -> String {
        match model_id.trim().to_ascii_lowercase().as_str() {
            "gemini-2.5-flash-image" | "google/nano-banana" | "nano-banana" => {
                "google/nano-banana".to_string()
            }
            "gemini-3.1-flash-image-preview" | "google/nano-banana-2" | "nano-banana-2" => {
                "google/nano-banana-2".to_string()
            }
            "gemini-3-pro-image-preview" | "google/nano-banana-pro" | "nano-banana-pro" => {
                "google/nano-banana-pro".to_string()
            }
            _ => model_id.trim().to_string(),
        }
    }

    fn resolve_openai_compat_model_id(
        bare_model: &str,
        base_url: &str,
        custom_model_id: Option<&str>,
    ) -> String {
        let is_uniapi = Self::is_uniapi_base_url(base_url);
        let resolved = custom_model_id
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| {
                if is_uniapi {
                    match bare_model {
                        "gemini-2.0-flash" => "google/nano-banana-2".to_string(),
                        "imagen-3" => "google/nano-banana-pro".to_string(),
                        other => other.to_string(),
                    }
                } else {
                    match bare_model {
                        "gemini-2.0-flash" => "gemini-2.0-flash-preview-image-generation".to_string(),
                        "imagen-3" => "imagen-3.0-generate-002".to_string(),
                        other => other.to_string(),
                    }
                }
            });

        if is_uniapi {
            Self::normalize_uniapi_image_model_id(&resolved)
        } else {
            resolved
        }
    }

    fn validate_openai_compat_model_id(bare_model: &str, model_id: &str) -> Result<(), AIError> {
        let normalized = model_id.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Err(AIError::InvalidRequest(
                "Google OpenAI 兼容模式的自定义模型 ID 不能为空".to_string(),
            ));
        }

        let looks_image_capable = normalized.contains("image")
            || normalized.contains("imagen")
            || normalized.contains("nano-banana");
        let requires_image_generation_model = bare_model == "gemini-2.0-flash" || bare_model == "imagen-3";
        if requires_image_generation_model && !looks_image_capable {
            return Err(AIError::InvalidRequest(format!(
                "当前选择的是 Google 图片生成模型，但自定义模型 ID `{}` 看起来不是图片生成模型。请改用支持图片生成的模型 ID，例如 `gemini-2.0-flash-preview-image-generation` 或 `google/nano-banana-2`。",
                model_id
            )));
        }

        Ok(())
    }

    fn aspect_ratio_to_size(ratio: &str) -> &'static str {
        match ratio {
            "9:16" => "1024x1792",
            "16:9" => "1792x1024",
            "3:4" => "768x1024",
            "4:3" => "1024x768",
            _ => "1024x1024",
        }
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

    fn source_to_image_bytes(source: &str, fallback_index: usize) -> Option<(String, Vec<u8>, String)> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return None;
        }

        if let Some((meta, payload)) = trimmed.split_once(',') {
            if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
                let mime = meta
                    .trim_start_matches("data:")
                    .trim_end_matches(";base64")
                    .to_string();
                if let Ok(bytes) = STANDARD.decode(payload) {
                    return Some((mime, bytes, format!("reference_{}.png", fallback_index + 1)));
                }
            }
        }

        let likely_base64 = trimmed.len() > 256
            && trimmed
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=');
        if likely_base64 {
            if let Ok(bytes) = STANDARD.decode(trimmed) {
                return Some((
                    "image/png".to_string(),
                    bytes,
                    format!("reference_{}.png", fallback_index + 1),
                ));
            }
        }

        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return None;
        }

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
                .unwrap_or("image/png")
                .to_string();
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
                .unwrap_or_else(|| format!("reference_{}.png", fallback_index + 1));
            return Some((mime, bytes, file_name));
        }

        None
    }

    fn parse_openai_compat_image_response(resp_body: &Value) -> Result<String, AIError> {
        if let Some(b64) = resp_body.pointer("/data/0/b64_json").and_then(|v| v.as_str()) {
            return Ok(format!("data:image/png;base64,{}", b64));
        }

        if let Some(url) = resp_body.pointer("/data/0/url").and_then(|v| v.as_str()) {
            return Ok(url.to_string());
        }

        Err(AIError::Provider(format!(
            "No image found in OpenAI-compat response: {}",
            resp_body
        )))
    }

    fn is_channel_not_implemented_error(status: reqwest::StatusCode, error_text: &str) -> bool {
        if status != reqwest::StatusCode::SERVICE_UNAVAILABLE {
            return false;
        }

        let lowered = error_text.to_ascii_lowercase();
        lowered.contains("channel not implemented") || lowered.contains("\"channel_error\"")
    }

    fn build_reference_data_urls(refs: &[String]) -> Vec<String> {
        refs.iter()
            .enumerate()
            .filter_map(|(index, source)| {
                Self::source_to_image_bytes(source, index).map(|(mime, bytes, _)| {
                    format!("data:{};base64,{}", mime, STANDARD.encode(bytes))
                })
            })
            .collect()
    }

    async fn request_openai_compat_generations(
        &self,
        endpoint: &str,
        api_key: &str,
        model_id: &str,
        prompt: &str,
        size: &str,
        refs: &[String],
    ) -> Result<Value, AIError> {
        let mut body = serde_json::json!({
            "model": model_id,
            "prompt": prompt,
            "n": 1,
            "size": size,
        });

        if !refs.is_empty() {
            let reference_data_urls = Self::build_reference_data_urls(refs);
            if !reference_data_urls.is_empty() {
                body["image_urls"] = json!(reference_data_urls);
            }
        }

        let response = self
            .client
            .post(endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "OpenAI-compat API request failed {}: {}",
                status, error_text
            )));
        }

        Ok(response.json::<serde_json::Value>().await?)
    }

    async fn normalize_openai_compat_image_output(&self, resp_body: &Value) -> Result<String, AIError> {
        let parsed = Self::parse_openai_compat_image_response(resp_body)?;
        if parsed.starts_with("http://") || parsed.starts_with("https://") {
            let img_response = self.client.get(&parsed).send().await?;
            let content_type = img_response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/png")
                .to_string();
            let mime = content_type
                .split(';')
                .next()
                .unwrap_or("image/png")
                .trim()
                .to_string();
            let bytes = img_response.bytes().await?;
            let b64 = STANDARD.encode(&bytes);
            return Ok(format!("data:{};base64,{}", mime, b64));
        }

        Ok(parsed)
    }

    async fn generate_with_openai_compat(
        &self,
        request: &GenerateRequest,
        api_key: &str,
        base_url: &str,
        custom_model_id: Option<&str>,
    ) -> Result<String, AIError> {
        let bare = Self::bare_model(&request.model);
        // Resolve custom/default model id and normalize known Uni API aliases.
        let model_id = Self::resolve_openai_compat_model_id(bare, base_url, custom_model_id);
        Self::validate_openai_compat_model_id(bare, &model_id)?;
        let size = Self::aspect_ratio_to_size(&request.aspect_ratio);
        let base = base_url.trim_end_matches('/');
        let base = base.strip_suffix("/v1").unwrap_or(base);
        let refs: Vec<String> = request
            .reference_images
            .as_ref()
            .map(|images| {
                images
                    .iter()
                    .filter(|value| !value.trim().is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let use_edits = !refs.is_empty();
        let endpoint = if use_edits {
            format!("{}/v1/images/edits", base)
        } else {
            format!("{}/v1/images/generations", base)
        };
        let generations_endpoint = format!("{}/v1/images/generations", base);

        info!(
            "[Google OpenAI-compat] endpoint={}, model={}, size={}, refs={}",
            endpoint,
            model_id,
            size,
            refs.len()
        );

        let response = if use_edits {
            let mut form = Form::new()
                .text("model", model_id.clone())
                .text("prompt", request.prompt.clone())
                .text("n", "1".to_string())
                .text("size", size.to_string());
            let mut attached_count = 0usize;

            for (index, source) in refs.iter().enumerate() {
                if let Some((mime, bytes, file_name)) = Self::source_to_image_bytes(source, index) {
                    let part = Part::bytes(bytes)
                        .file_name(file_name)
                        .mime_str(&mime)
                        .map_err(|e| AIError::Provider(format!("Invalid image mime type `{}`: {}", mime, e)))?;
                    form = form.part("image", part);
                    attached_count += 1;
                }
            }

            if attached_count == 0 {
                return Err(AIError::InvalidRequest(
                    "已传入参考图，但未能解析为有效图片内容，请检查图片来源。".to_string(),
                ));
            }

            let response = self.client
                .post(&endpoint)
                .header("Authorization", format!("Bearer {}", api_key))
                .multipart(form)
                .send()
                .await?;

            if !response.status().is_success() {
                let status = response.status();
                let error_text = response.text().await.unwrap_or_default();
                if Self::is_channel_not_implemented_error(status, &error_text) {
                    info!(
                        "[Google OpenAI-compat] edits channel unavailable, fallback to generations with reference payload"
                    );
                    let fallback_body = self
                        .request_openai_compat_generations(
                            &generations_endpoint,
                            api_key,
                            &model_id,
                            &request.prompt,
                            size,
                            &refs,
                        )
                        .await?;
                    return self.normalize_openai_compat_image_output(&fallback_body).await;
                }

                return Err(AIError::Provider(format!(
                    "OpenAI-compat API request failed {}: {}",
                    status, error_text
                )));
            }

            response
        } else {
            let resp_body = self
                .request_openai_compat_generations(
                    &endpoint,
                    api_key,
                    &model_id,
                    &request.prompt,
                    size,
                    &refs,
                )
                .await?;
            return self.normalize_openai_compat_image_output(&resp_body).await;
        };

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "OpenAI-compat API request failed {}: {}",
                status, error_text
            )));
        }

        let resp_body = response.json::<serde_json::Value>().await?;

        self.normalize_openai_compat_image_output(&resp_body).await
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

        let resp_text = response.text().await?;
        let resp_body: Value = serde_json::from_str(&resp_text).map_err(|e| {
            AIError::Provider(format!(
                "Gemini Flash response is not valid JSON ({}): {}",
                e,
                &resp_text[..resp_text.len().min(500)]
            ))
        })?;

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

        let resp_text = response.text().await?;
        let resp_body: Value = serde_json::from_str(&resp_text).map_err(|e| {
            AIError::Provider(format!(
                "Imagen 3 response is not valid JSON ({}): {}",
                e,
                &resp_text[..resp_text.len().min(500)]
            ))
        })?;

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

    async fn set_base_url(&self, base_url: String) -> Result<(), AIError> {
        let mut url = self.base_url.write().await;
        let trimmed = base_url.trim().to_string();
        *url = if trimmed.is_empty() { None } else { Some(trimmed) };
        Ok(())
    }

    async fn set_api_protocol(&self, protocol: String) -> Result<(), AIError> {
        let mut proto = self.api_protocol.write().await;
        let trimmed = protocol.trim().to_string();
        *proto = if trimmed.is_empty() { None } else { Some(trimmed) };
        Ok(())
    }

    async fn set_custom_model_id(&self, model_id: String) -> Result<(), AIError> {
        let mut mid = self.custom_model_id.write().await;
        let trimmed = model_id.trim().to_string();
        *mid = if trimmed.is_empty() { None } else { Some(trimmed) };
        Ok(())
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let key = self.api_key.read().await;
        let api_key = key
            .as_ref()
            .ok_or_else(|| AIError::InvalidRequest("Google AI API key not set".to_string()))?;

        let api_protocol = self.api_protocol.read().await;
        let base_url = self.base_url.read().await;
        let custom_model_id = self.custom_model_id.read().await;

        // Explicit protocol: openai-compatible → use proxy; otherwise official API
        if api_protocol.as_deref() == Some("openai-compatible") {
            let url = base_url.as_deref().ok_or_else(|| {
                AIError::InvalidRequest(
                    "使用 OpenAI 兼容模式时，请在设置中填写 Base URL（代理地址）".to_string(),
                )
            })?;
            return self.generate_with_openai_compat(&request, api_key, url, custom_model_id.as_deref()).await;
        }

        match Self::bare_model(&request.model) {
            "gemini-2.0-flash" => self.generate_with_gemini_flash(&request, api_key).await,
            "imagen-3" => self.generate_with_imagen3(&request, api_key).await,
            other => Err(AIError::ModelNotSupported(other.to_string())),
        }
    }
}
