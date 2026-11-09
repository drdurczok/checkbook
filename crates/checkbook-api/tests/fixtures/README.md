# Public authentication test key

`private_rsa_key_pkcs8.pem` is an intentionally public RSA signing fixture used
only by the `#[cfg(test)]` module in `src/cloudflare.rs`. Its matching public JWK
is embedded in that test module. Tests sign synthetic Cloudflare Access assertions;
the production verifier does not load this key.

Never use this key for authentication, TLS, signing production tokens, or any
other real-world security purpose. It is not a deployment secret. A review of
its introduction and current references supports test-only use, but does not
establish how it was originally generated or prove it was never reused elsewhere.
The repository owner must confirm no external reuse before publication. If it
was reused, replace the real-world key and treat it as exposed; deleting a public
fixture does not undo exposure.
