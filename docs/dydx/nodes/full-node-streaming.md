# Full Node gRPC Streaming – dYdX Documentation

> Source: https://docs.dydx.xyz/nodes/full-node-streaming
> Last updated for `v7.0.2`.

Enable full node streaming to expose a stream of orderbook updates (L3), fills, taker orders, and subaccount updates, allowing clients to maintain a full view of the orderbook and various exchange activities. Note the orderbook state can vary slightly between nodes due to dYdX's off-chain orderbook design.

> **Recommendation:** use this exclusively with your **own** node. Supporting multiple public gRPC streams with unknown client subscriptions may result in degraded performance.

## Enabling Streaming

Two protocols are supported: gRPC and WebSockets.

| CLI Flag | Type | Default | Explanation |
|----------|------|---------|-------------|
| `grpc-streaming-enabled` | bool | false | Toggle on to enable gRPC-based full node streaming. |
| `grpc-streaming-flush-interval-ms` | int | 50 | Buffer flush interval for batch emission of protocol-side updates. |
| `grpc-streaming-max-batch-size` | int | 2000 | Maximum protocol-side update buffer before dropping all connections. |
| `grpc-streaming-max-channel-buffer-size` | int | 2000 | Maximum channel size before dropping slow or erroring connections. |
| `websocket-streaming-enabled` | bool | false | Toggle on to enable WebSocket-based streaming. Must be used with `grpc-streaming-enabled`. |
| `websocket-streaming-port` | int | 9092 | Port to expose for WebSocket streaming. |
| `fns-snapshot-interval` | int | 0 | If nonzero, snapshots are sent at this block interval. Debugging only. |

## Connecting to the Stream

1. Clone `github.com/dydxprotocol/v4-chain` at the same version as your full node.
2. `make proto-gen && make proto-export-deps`. The generated protos live in `.proto-export-deps`.
3. Use `protoc` to generate stubs in any supported language.
4. Connect to the stream defined in `dydxprotocol.clob.Query` (`StreamOrderbookUpdates`).

For Python, pre-generated code is available via [`v4-proto`](https://pypi.org/project/v4-proto/). For Rust, install [`dydx-proto`](https://crates.io/crates/dydx-proto).

For WebSockets, connect to `/ws` on the configured port (default 9092). Query parameters: `clobPairIds` and `subaccountIds`.

## Maintaining Orderbook and Subaccount State

1. Subscribe to a set of CLOB pair IDs and subaccount ids.
2. Discard order messages until you receive a `StreamOrderbookUpdate` with `snapshot=true`.
3. Likewise, discard subaccount messages until you receive a `StreamSubaccountUpdate` with `snapshot=true`.
4. On `OrderPlaceV1` insert at the end of its price level. Track initial quantums + total filled.
5. On `OrderUpdateV1` update the order's total filled quantums.
6. On `ClobMatch` update the maker order fill amounts via `fill_amounts` (cumulative, not delta).
7. On `OrderRemoveV1` remove the order.
8. On `StreamSubaccountUpdate` (snapshot=false) incrementally update positions/balances.
9. `StreamTakerOrder` is informational only — state does not need to be updated.

Only `ClobMatch` messages with `execModeFinalize` are trades confirmed by consensus.

## Reference

### Exec Modes
```
0 execModeCheck
1 execModeReCheck
2 execModeSimulate
3 execModePrepareProposal
4 execModeProcessProposal
5 execModeVoteExtension
6 execModeVerifyVoteExtension
7 execModeFinalize
100 ExecModeBeginBlock
101 ExecModeEndBlock
102 ExecModePrepareCheckState
```

### Taker Order Status

| Value | Status | Notes |
|-------|--------|-------|
| 0 | Success | Matched and/or added to orderbook. |
| 1 | Undercollateralized | Failed collateralization, cancelled. |
| 2 | InternalError | Internal error, cancelled. |
| 3 | ImmediateOrCancelWouldRestOnBook | IOC that would have rested. Cancelled. |
| 4 | ReduceOnlyResized | Resized to avoid increasing position. |
| 5 | LiquidationRequiresDeleveraging | Insurance fund can't cover. |
| 6 | LiquidationExceededSubaccountMaxNotionalLiquidated | Exceeds block-max notional. |
| 7 | LiquidationExceededSubaccountMaxInsuranceLost | Exceeds insurance loss cap. |
| 8 | ViolatesIsolatedSubaccountConstraints | Cancelled. |
| 9 | PostOnlyWouldCrossMakerOrder | Post-only would cross. Cancelled. |

### grpcurl example

```
grpcurl -plaintext -d '{"clobPairId":[0,1], "subaccountIds": [{"owner": "dydx1nzuttarf5k2j0nug5yzhr6p74t9avehn9hlh8m", "number": 0}]}' \
  127.0.0.1:9090 dydxprotocol.clob.Query/StreamOrderbookUpdates
```

### Sample client
[dydxprotocol/grpc-stream-client](https://github.com/dydxprotocol/grpc-stream-client/)

## Changelog

### v7.0.2
- perp position to signed int for tracking long/short positions

### v6.0.8
- added taker order message to stream
- added subaccount update message to stream
- finalized DeliverTx updates are batched together
- WebSocket support

### v5.0.5
- per-channel goroutines so a laggy subscription can't block the full node
- Protobuf breaking change: block height and exec mode moved from `StreamOrderbookUpdatesResponse` into `StreamUpdate`
