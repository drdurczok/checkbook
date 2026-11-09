use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use jsonwebtoken::{
    Algorithm, DecodingKey, Validation, decode, decode_header,
    jwk::{Jwk, JwkSet},
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const GOOGLE_CERTS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: &[&str] = &["accounts.google.com", "https://accounts.google.com"];

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GoogleClaims {
    pub aud: String,
    pub email: String,
    pub email_verified: bool,
    pub exp: u64,
    pub iat: u64,
    pub iss: String,
    pub sub: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub picture: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GoogleError {
    #[error("Google login is not configured")]
    NotConfigured,
    #[error("Google credential is missing or invalid")]
    InvalidCredential,
    #[error("Google signing keys are unavailable")]
    KeysUnavailable,
}

#[derive(Debug, Clone)]
pub struct GoogleVerifier {
    client: reqwest::Client,
    audience: String,
    cache: Arc<RwLock<KeyCache>>,
}

#[derive(Debug, Clone)]
struct KeyCache {
    fetched_at: Option<Instant>,
    keys: JwkSet,
}

impl GoogleVerifier {
    pub fn new(client_id: &str) -> Result<Self, GoogleError> {
        let audience = client_id.trim();
        if audience.is_empty() {
            return Err(GoogleError::NotConfigured);
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| GoogleError::KeysUnavailable)?;
        Ok(Self {
            client,
            audience: audience.to_owned(),
            cache: Arc::new(RwLock::new(KeyCache {
                fetched_at: None,
                keys: JwkSet { keys: Vec::new() },
            })),
        })
    }

    #[cfg(test)]
    pub fn with_jwks(audience: impl Into<String>, keys: JwkSet) -> Self {
        Self {
            client: reqwest::Client::new(),
            audience: audience.into(),
            cache: Arc::new(RwLock::new(KeyCache {
                fetched_at: Some(Instant::now()),
                keys,
            })),
        }
    }

    pub async fn verify(&self, credential: &str) -> Result<GoogleClaims, GoogleError> {
        let header = decode_header(credential).map_err(|_| GoogleError::InvalidCredential)?;
        if header.alg != Algorithm::RS256 {
            return Err(GoogleError::InvalidCredential);
        }
        let kid = header.kid.ok_or(GoogleError::InvalidCredential)?;
        let key = match self.cached_key(&kid).await {
            Some(key) => key,
            None => {
                self.refresh_keys().await?;
                self.cached_key(&kid)
                    .await
                    .ok_or(GoogleError::InvalidCredential)?
            }
        };
        let decoding_key =
            DecodingKey::from_jwk(&key).map_err(|_| GoogleError::InvalidCredential)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[&self.audience]);
        validation.set_issuer(GOOGLE_ISSUERS);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "email"]);
        validation.leeway = 30;
        let token = decode::<GoogleClaims>(credential, &decoding_key, &validation)
            .map_err(|_| GoogleError::InvalidCredential)?;
        if token.claims.email.trim().is_empty()
            || token.claims.sub.trim().is_empty()
            || !token.claims.email_verified
        {
            return Err(GoogleError::InvalidCredential);
        }
        Ok(token.claims)
    }

    async fn cached_key(&self, kid: &str) -> Option<Jwk> {
        let cache = self.cache.read().await;
        let fresh = cache
            .fetched_at
            .is_some_and(|fetched| fetched.elapsed() < Duration::from_secs(3600));
        if fresh {
            cache.keys.find(kid).cloned()
        } else {
            None
        }
    }

    async fn refresh_keys(&self) -> Result<(), GoogleError> {
        let response = self
            .client
            .get(GOOGLE_CERTS_URL)
            .send()
            .await
            .map_err(|_| GoogleError::KeysUnavailable)?;
        if !response.status().is_success()
            || response.content_length().unwrap_or_default() > 256 * 1024
        {
            return Err(GoogleError::KeysUnavailable);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| GoogleError::KeysUnavailable)?;
        if bytes.len() > 256 * 1024 {
            return Err(GoogleError::KeysUnavailable);
        }
        let keys: JwkSet =
            serde_json::from_slice(&bytes).map_err(|_| GoogleError::KeysUnavailable)?;
        if keys.keys.is_empty() {
            return Err(GoogleError::KeysUnavailable);
        }
        let mut cache = self.cache.write().await;
        cache.keys = keys;
        cache.fetched_at = Some(Instant::now());
        Ok(())
    }
}
