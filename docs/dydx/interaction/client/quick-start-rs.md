# Quick Start with Rust – dYdX Documentation

> Source: https://docs.dydx.xyz/interaction/client/quick-start-rs

## Install Rust and Cargo

Choose and install [Rust](https://www.rust-lang.org/tools/install) and [Cargo](https://doc.rust-lang.org/cargo/getting-started/installation.html) for your system.

## Clone the dydx client repo

```
git clone https://github.com/dydxprotocol/v4-clients.git
```

## Run an example

```
cd v4-clients/v4-client-rs
cargo run --example account_endpoint
```

## Rust Crate

The Rust client is also available through the crates.io crate `dydx`.

```
cargo add dydx
```

Or add to `Cargo.toml`:

```toml
[dependencies]
dydx = "0.2.0"
```

## Configuration File

### mainnet.toml

```toml
[node]
endpoint = "https://dydx-ops-grpc.kingnodes.com:443"
chain_id = "dydx-mainnet-1"
fee_denom = "ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5"

[indexer]
http.endpoint = "https://indexer.dydx.trade"
ws.endpoint = "wss://indexer.dydx.trade/v4/ws"

[noble]
endpoint = "http://noble-grpc.polkachu.com:21590"
chain_id = "noble-1"
fee_denom = "uusdc"
```
