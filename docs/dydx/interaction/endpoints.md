# Connecting to dYdX

> Source: https://docs.dydx.xyz/interaction/endpoints

## Overview

dYdX provides two networks for trading: a **mainnet** and a **testnet**. The mainnet is where real financial transactions occur, while the testnet serves as a risk-free environment for testing and experimentation. The API is identical for both networks—switching between them simply requires changing the endpoints used.

## Available Clients

### Node Client

The Node client (also known as the Validator client) is the primary interface for interacting with the dYdX network. It provides the Node API, enabling authenticated operations such as issuing trading orders through the Private API.

To set up the Node client, you need an RPC/gRPC endpoint. The Python client additionally requires HTTP and WebSocket endpoints.

```python
from dydx_v4_client.network import make_mainnet
from dydx_v4_client.node.client import NodeClient

config = make_mainnet(
    node_url="oegs.dydx.trade:443",
    rest_indexer="https://indexer.dydx.trade",
    websocket_indexer="wss://indexer.dydx.trade/v4/ws",
).node

node = await NodeClient.connect(config)
```

**Note:** With the Order Entry Gateway Service (OEGS) release, users can now connect via OEGS endpoints providing both gRPC and RPC functionality.

### Indexer Client

The Indexer is a high-availability system providing structured data and reducing computational burden on core nodes. It offers both spontaneous data retrieval via REST and continuous data feeds via WebSockets.

```python
from dydx_v4_client.network import make_mainnet
from dydx_v4_client.indexer.rest.indexer_client import IndexerClient
from dydx_v4_client.indexer.socket.websocket import IndexerSocket

config = make_mainnet(
    node_url="your-custom-grpc-node.com",
    rest_indexer="https://your-custom-rest-indexer.com",
    websocket_indexer="wss://your-custom-websocket-indexer.com"
).node

indexer = IndexerClient(config.rest_indexer)
socket = await IndexerSocket(network.websocket_indexer).connect()
```

### Composite Client (TypeScript Only)

```typescript
import { CompositeClient, Network } from '@dydxprotocol/v4-client-js';

const network = Network.mainnet();
const client = await CompositeClient.connect(network);
```

### Faucet Client

The Faucet client provides test funds for strategy testing on the testnet only.

```python
from dydx_v4_client.network import TESTNET_FAUCET
from dydx_v4_client.faucet_client import FaucetClient

faucet = FaucetClient(TESTNET_FAUCET)
```

### Noble Client

The Noble network facilitates asset transfers into and out of the dYdX network.

```python
from dydx_v4_client.indexer.rest.noble_client import NobleClient

client = NobleClient("https://rpc.testnet.noble.strange.love")
await client.connect(MNEMONIC)
```

## Endpoints

### Node Endpoints

#### Mainnet

**gRPC**

| Team       | URI                                                                                                                              | Rate Limit |
|------------|----------------------------------------------------------------------------------------------------------------------------------|------------|
| OEGS       | `grpc://oegs.dydx.trade:443`                                                                                                     | —          |
| Polkachu   | `https://dydx-dao-grpc-1.polkachu.com:443`, `…grpc-2…`, `…grpc-3…`                                                              | 300 req/m  |
| KingNodes  | `https://dydx-ops-grpc.kingnodes.com:443`                                                                                        | 250 req/m  |
| Enigma     | `https://dydx-dao-grpc.enigma-validator.com:443`                                                                                 | —          |

**Archive gRPC**

| Team       | URI                                                                                                       | Rate Limit |
|------------|-----------------------------------------------------------------------------------------------------------|------------|
| Polkachu   | `https://dydx-dao-archive-grpc-1.polkachu.com:443`                                                        | 300 req/m  |
| KingNodes  | `https://dydx-ops-archive-grpc.kingnodes.com:443`                                                         | 250 req/m  |
| Enigma     | `https://dydx-dao-grpc-archive.enigma-validator.com:1492`                                                 | —          |

**RPC**

| Team       | URI                                                                                                       | Rate Limit |
|------------|-----------------------------------------------------------------------------------------------------------|------------|
| OEGS       | `https://oegs.dydx.trade:443`                                                                             | —          |
| Polkachu   | `https://dydx-dao-rpc.polkachu.com:443`                                                                   | 300 req/m  |
| KingNodes  | `https://dydx-ops-rpc.kingnodes.com:443`                                                                  | 250 req/m  |
| Enigma     | `https://dydx-dao-rpc.enigma-validator.com:443`                                                           | —          |

**Archive RPC**

| Team       | URI                                                                                                       | Rate Limit |
|------------|-----------------------------------------------------------------------------------------------------------|------------|
| Polkachu   | `https://dydx-dao-archive-rpc.polkachu.com:443`                                                           | 300 req/m  |
| KingNodes  | `https://dydx-ops-archive-rpc.kingnodes.com:443`                                                          | 250 req/m  |
| Enigma     | `https://dydx-dao-rpc-archive.enigma-validator.com:443`                                                   | —          |

**REST**

| Team       | URI                                                                                                       | Rate Limit |
|------------|-----------------------------------------------------------------------------------------------------------|------------|
| Polkachu   | `https://dydx-dao-api.polkachu.com:443`                                                                   | 300 req/m  |
| KingNodes  | `https://dydx-ops-rest.kingnodes.com:443`                                                                 | 250 req/m  |
| Enigma     | `https://dydx-dao-lcd.enigma-validator.com:443`                                                           | —          |

**Archive REST**

| Team       | URI                                                                                                       | Rate Limit |
|------------|-----------------------------------------------------------------------------------------------------------|------------|
| Polkachu   | `https://dydx-dao-archive-api.polkachu.com:443`                                                           | 300 req/m  |
| KingNodes  | `https://dydx-ops-archive-rest.kingnodes.com:443`                                                         | 250 req/m  |
| Enigma     | `https://dydx-dao-lcd-archive.enigma-validator.com:443`                                                   | —          |

#### Testnet

**gRPC** — OEGS `oegs-testnet.dydx.exchange:443`, KingNodes `test-dydx-grpc.kingnodes.com:443 (TLS)`, Polkachu `dydx-testnet-grpc.polkachu.com:23890 (plaintext)`.

**RPC** — OEGS `https://oegs-testnet.dydx.exchange:443`, Enigma `https://dydx-rpc-testnet.enigma-validator.com`, KingNodes `https://test-dydx-rpc.kingnodes.com`, Polkachu `https://dydx-testnet-rpc.polkachu.com`.

**REST** — Enigma `https://dydx-lcd-testnet.enigma-validator.com`, KingNodes `https://test-dydx-rest.kingnodes.com`, Polkachu `https://dydx-testnet-api.polkachu.com`.

### Indexer Endpoints

#### Mainnet

| Type | URI                                |
|------|------------------------------------|
| HTTP | `https://indexer.dydx.trade/v4`    |
| WS   | `wss://indexer.dydx.trade/v4/ws`   |

#### Testnet

| Type | URI                                                  |
|------|------------------------------------------------------|
| HTTP | `https://indexer.v4testnet.dydx.exchange`            |
| WS   | `wss://indexer.v4testnet.dydx.exchange/v4/ws`        |

### Faucet Endpoints

Testnet: `https://faucet.v4testnet.dydx.exchange`

### Noble Endpoints

Mainnet: Polkachu `http://noble-grpc.polkachu.com:21590 (plaintext)`.
Testnet: Polkachu `noble-testnet-grpc.polkachu.com:21590 (plaintext)`.

## Additional Notes

In Cosmos blockchains (dYdX, Noble, etc.), inter-blockchain communications rely on IBC relayers to facilitate bridging between networks. These relayers may not always be active, particularly on testnet networks.
