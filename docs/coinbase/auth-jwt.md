# Coinbase Developer Platform — JWT Authentication

> Source: https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication
> Mirrored: 2026-05-25

## Overview

A JSON Web Token (JWT) functions as a secure authentication method for Coinbase Developer Platform API calls. These tokens merge encryption with access management to provide stronger security than traditional API key approaches.

## Key Points About JWT Generation

**Token Lifespan**: JWTs expire after 2 minutes, requiring regeneration before expiration for continued API access.

**Generation Process**: To create a JWT, you must:
1. Supply your key name and private key (preserving newlines as `\n` characters)
2. Specify the target endpoint's request path and host
3. Execute a generation script that outputs `export JWT=...`
4. Run the exported command to save your JWT as an environment variable

## Supported Algorithms

**Ed25519** (Recommended): The primary signature algorithm for new implementations, with code examples available in JavaScript, TypeScript, Python, Go, Ruby, PHP, Java, and C++.

**ECDSA** (Legacy): Supported for backward compatibility with Coinbase App SDK and Advanced Trade SDK, though Ed25519 is preferred where possible.

## Using Your JWT

Include the token as a bearer token in your API requests:

```bash
curl -L -X <HTTP_METHOD> "<API_ENDPOINT_URL>" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json"
```

## Security Considerations

The documentation emphasizes several critical practices:
- managing token expiration appropriately for your use case
- maintaining proper key formatting during import
- ensuring system clock synchronization to prevent timestamp rejection
- configuring JWT headers with correct algorithm and key ID values
- avoiding unnecessary payload data that could expose sensitive information
