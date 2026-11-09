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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Audience {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AccessClaims {
    pub aud: Audience,
    pub email: String,
    pub exp: u64,
    pub iat: u64,
    pub iss: String,
    pub sub: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CloudflareError {
    #[error("Cloudflare Access is not configured")]
    NotConfigured,
    #[error("Cloudflare team domain is invalid")]
    InvalidTeamDomain,
    #[error("Cloudflare Access assertion is missing or invalid")]
    InvalidAssertion,
    #[error("Cloudflare Access signing keys are unavailable")]
    KeysUnavailable,
}

#[derive(Debug, Clone)]
pub struct CloudflareVerifier {
    client: reqwest::Client,
    issuer: String,
    audience: String,
    certs_url: String,
    cache: Arc<RwLock<KeyCache>>,
}

#[derive(Debug, Clone)]
struct KeyCache {
    fetched_at: Option<Instant>,
    keys: JwkSet,
}

impl CloudflareVerifier {
    pub fn new(team_domain: &str, audience: &str) -> Result<Self, CloudflareError> {
        let host = normalized_team_host(team_domain)?;
        if audience.trim().is_empty() {
            return Err(CloudflareError::NotConfigured);
        }
        let issuer = format!("https://{host}");
        let certs_url = format!("{issuer}/cdn-cgi/access/certs");
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| CloudflareError::KeysUnavailable)?;
        Ok(Self {
            client,
            issuer,
            audience: audience.trim().to_owned(),
            certs_url,
            cache: Arc::new(RwLock::new(KeyCache {
                fetched_at: None,
                keys: JwkSet { keys: Vec::new() },
            })),
        })
    }

    #[cfg(test)]
    pub fn with_jwks(issuer: impl Into<String>, audience: impl Into<String>, keys: JwkSet) -> Self {
        Self {
            client: reqwest::Client::new(),
            issuer: issuer.into(),
            audience: audience.into(),
            certs_url: "http://127.0.0.1/unused".to_owned(),
            cache: Arc::new(RwLock::new(KeyCache {
                fetched_at: Some(Instant::now()),
                keys,
            })),
        }
    }

    #[cfg(test)]
    async fn replace_jwks(&self, keys: JwkSet) {
        let mut cache = self.cache.write().await;
        cache.keys = keys;
        cache.fetched_at = Some(Instant::now());
    }

    pub async fn verify(&self, assertion: &str) -> Result<AccessClaims, CloudflareError> {
        let header = decode_header(assertion).map_err(|_| CloudflareError::InvalidAssertion)?;
        if header.alg != Algorithm::RS256 {
            return Err(CloudflareError::InvalidAssertion);
        }
        let kid = header.kid.ok_or(CloudflareError::InvalidAssertion)?;
        let key = match self.cached_key(&kid).await {
            Some(key) => key,
            None => {
                self.refresh_keys().await?;
                self.cached_key(&kid)
                    .await
                    .ok_or(CloudflareError::InvalidAssertion)?
            }
        };
        let decoding_key =
            DecodingKey::from_jwk(&key).map_err(|_| CloudflareError::InvalidAssertion)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[&self.audience]);
        validation.set_issuer(&[&self.issuer]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "email"]);
        validation.leeway = 30;
        let token = decode::<AccessClaims>(assertion, &decoding_key, &validation)
            .map_err(|_| CloudflareError::InvalidAssertion)?;
        if token.claims.email.trim().is_empty() || token.claims.sub.trim().is_empty() {
            return Err(CloudflareError::InvalidAssertion);
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

    async fn refresh_keys(&self) -> Result<(), CloudflareError> {
        let response = self
            .client
            .get(&self.certs_url)
            .send()
            .await
            .map_err(|_| CloudflareError::KeysUnavailable)?;
        if !response.status().is_success() {
            return Err(CloudflareError::KeysUnavailable);
        }
        let content_length = response.content_length().unwrap_or_default();
        if content_length > 256 * 1024 {
            return Err(CloudflareError::KeysUnavailable);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| CloudflareError::KeysUnavailable)?;
        if bytes.len() > 256 * 1024 {
            return Err(CloudflareError::KeysUnavailable);
        }
        let keys: JwkSet =
            serde_json::from_slice(&bytes).map_err(|_| CloudflareError::KeysUnavailable)?;
        if keys.keys.is_empty() {
            return Err(CloudflareError::KeysUnavailable);
        }
        let mut cache = self.cache.write().await;
        cache.keys = keys;
        cache.fetched_at = Some(Instant::now());
        Ok(())
    }
}

fn normalized_team_host(value: &str) -> Result<String, CloudflareError> {
    let trimmed = value
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains(':')
        || !trimmed.ends_with(".cloudflareaccess.com")
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err(CloudflareError::InvalidTeamDomain);
    }
    Ok(trimmed.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use jsonwebtoken::{
        Algorithm, EncodingKey, Header, encode,
        jwk::{Jwk, JwkSet},
    };
    use serde_json::json;

    use super::{
        AccessClaims, Audience, CloudflareError, CloudflareVerifier, normalized_team_host,
    };

    const PRIVATE_KEY: &[u8] = include_bytes!("../tests/fixtures/private_rsa_key_pkcs8.pem");

    fn jwk(kid: &str) -> Result<Jwk, serde_json::Error> {
        serde_json::from_value(json!({
            "kty": "RSA",
            "n": "yRE6rHuNR0QbHO3H3Kt2pOKGVhQqGZXInOduQNxXzuKlvQTLUTv4l4sggh5_CYYi_cvI-SXVT9kPWSKXxJXBXd_4LkvcPuUakBoAkfh-eiFVMh2VrUyWyj3MFl0HTVF9KwRXLAcwkREiS3npThHRyIxuy0ZMeZfxVL5arMhw1SRELB8HoGfG_AtH89BIE9jDBHZ9dLelK9a184zAf8LwoPLxvJb3Il5nncqPcSfKDDodMFBIMc4lQzDKL5gvmiXLXB1AGLm8KBjfE8s3L5xqi-yUod-j8MtvIj812dkS4QMiRVN_by2h3ZY8LYVGrqZXZTcgn2ujn8uKjXLZVD5TdQ",
            "e": "AQAB",
            "kid": kid,
            "alg": "RS256",
            "use": "sig"
        }))
    }

    fn token(
        kid: &str,
        issuer: &str,
        audience: &str,
        expires_at: u64,
    ) -> Result<String, jsonwebtoken::errors::Error> {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(kid.to_owned());
        encode(
            &header,
            &AccessClaims {
                aud: Audience::One(audience.to_owned()),
                email: "owner@example.com".to_owned(),
                exp: expires_at,
                iat: chrono::Utc::now().timestamp().unsigned_abs(),
                iss: issuer.to_owned(),
                sub: "subject".to_owned(),
                name: "Owner".to_owned(),
            },
            &EncodingKey::from_rsa_pem(PRIVATE_KEY)?,
        )
    }

    #[test]
    fn team_domain_is_restricted_to_cloudflare_access_hosts() {
        assert_eq!(
            normalized_team_host("https://example.cloudflareaccess.com/"),
            Ok("example.cloudflareaccess.com".to_owned())
        );
        assert_eq!(
            normalized_team_host("https://example.invalid/certs"),
            Err(CloudflareError::InvalidTeamDomain)
        );
    }

    #[tokio::test]
    async fn verifies_signature_issuer_audience_expiry_and_rotated_keys() -> anyhow::Result<()> {
        let issuer = "https://example.cloudflareaccess.com";
        let audience = "access-audience";
        let verifier = CloudflareVerifier::with_jwks(
            issuer,
            audience,
            JwkSet {
                keys: vec![jwk("old")?],
            },
        );
        let future =
            u64::try_from((chrono::Utc::now() + chrono::Duration::minutes(5)).timestamp())?;
        assert!(
            verifier
                .verify(&token("old", issuer, audience, future)?)
                .await
                .is_ok()
        );
        assert!(matches!(
            verifier
                .verify(&token("old", "https://evil.invalid", audience, future)?)
                .await,
            Err(CloudflareError::InvalidAssertion)
        ));
        assert!(matches!(
            verifier
                .verify(&token("old", issuer, "wrong-audience", future)?)
                .await,
            Err(CloudflareError::InvalidAssertion)
        ));
        let expired =
            u64::try_from((chrono::Utc::now() - chrono::Duration::minutes(2)).timestamp())?;
        assert!(matches!(
            verifier
                .verify(&token("old", issuer, audience, expired)?)
                .await,
            Err(CloudflareError::InvalidAssertion)
        ));
        verifier
            .replace_jwks(JwkSet {
                keys: vec![jwk("new")?],
            })
            .await;
        assert!(
            verifier
                .verify(&token("new", issuer, audience, future)?)
                .await
                .is_ok()
        );
        Ok(())
    }

    #[tokio::test]
    async fn reports_jwks_unavailable_for_an_unknown_key_when_refresh_fails() -> anyhow::Result<()>
    {
        let verifier = CloudflareVerifier::with_jwks(
            "https://example.cloudflareaccess.com",
            "audience",
            JwkSet {
                keys: vec![jwk("known")?],
            },
        );
        let future =
            u64::try_from((chrono::Utc::now() + chrono::Duration::minutes(5)).timestamp())?;
        assert!(matches!(
            verifier
                .verify(&token(
                    "unknown",
                    "https://example.cloudflareaccess.com",
                    "audience",
                    future,
                )?)
                .await,
            Err(CloudflareError::KeysUnavailable)
        ));
        Ok(())
    }
}
