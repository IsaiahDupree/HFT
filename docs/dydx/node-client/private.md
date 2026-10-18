# dYdX Private Node API

> Source: https://docs.dydx.xyz/node-client/private

The Private Node API enables wallet-authenticated transactions for trading, fund management, and vault operations on dYdX.

## Core Trading

### Place Order
```python
async def place_order(self, wallet: Wallet, order: Order, tx_options: Optional[TxOptions] = None)
```
Returns: transaction hash on success (200 OK).

### Cancel Order
```python
async def cancel_order(
    self,
    wallet: Wallet,
    order_id: OrderId,
    good_til_block: int = None,
    good_til_block_time: int = None,
    tx_options: Optional[TxOptions] = None,
)
```

### Batch Cancel Orders
Cancels multiple short-term orders simultaneously.
```python
async def batch_cancel_orders(
    self,
    wallet: Wallet,
    subaccount_id: SubaccountId,
    short_term_cancels: List[OrderBatch],
    good_til_block: int,
    tx_options: Optional[TxOptions] = None,
)
```

## Fund Management

- **Deposit** — USDC from address → subaccount. Params: `wallet, sender, recipient_subaccount, asset_id, quantums`.
- **Withdraw** — USDC from subaccount → address. Params: `wallet, sender_subaccount, recipient, asset_id, quantums`.
- **Transfer** — between subaccounts. Params: `wallet, sender_subaccount, recipient_subaccount, asset_id, amount`.
- **Send Token** — generic token transfer between accounts.
  ```python
  async def send_token(self, wallet, sender, recipient, quantums, denomination)
  ```

## Transaction Lifecycle

### Simulate
```python
async def simulate(self, transaction: Tx)
```
Pre-execution simulation predicting gas + resources.

### Create Transaction
```python
async def create_transaction(self, wallet: Wallet, message: Message) -> Tx
```

### Broadcast Transaction
```python
async def broadcast(self, transaction: Tx, mode=BroadcastMode.BROADCAST_MODE_SYNC)
```
Default: synchronous.

## Advanced

- **Create Market Permissionless** — establish a new market.
- **Close Position** — opposite short-term order.
- **Delegate / Undelegate / Withdraw Delegator Reward** — staking.
- **Register Affiliate** — register an affiliate relationship.

## MegaVault

- **Deposit** — USDC → vault.
  ```python
  async def deposit(self, wallet, address, subaccount_number, amount) -> Any
  ```
- **Withdraw** — USDC out of vault with minimum amount requirements.
  ```python
  async def withdraw(self, wallet, address, subaccount_number, min_amount, shares) -> Any
  ```
- **Get Owner Shares** — `async def get_owner_shares(self, address) -> QueryMegavaultOwnerSharesResponse`.
- **Get Withdrawal Info** — `async def get_withdrawal_info(self, shares) -> QueryMegavaultWithdrawalInfoResponse`.

## Response Status Codes

| Code | Meaning |
|------|---------|
| 200 | OK — returns hash or data. |
| 400 | Bad Request — malformed/invalid request. |
| 404 | Not Found — order/subaccount/transaction missing. |

## Key Concepts

- **Quantums** — smallest unit for asset amounts in transactions.
- **Subaccount ID** — identifier for fund isolation within a wallet.
- **TxOptions** — optional transaction configuration supporting authenticators.
- **Asset ID** — identifier for tradeable assets (typically USDC).
