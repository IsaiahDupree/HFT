> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Builder Program

> Build applications that route orders through Polymarket

A **builder** is a person, group, or organization that routes orders from users to Polymarket. If you've created a platform that allows users to trade on Polymarket through your system, this program is for you.

## Program Benefits

<CardGroup cols={2}>
  <Card title="Gasless Transactions" icon="gas-pump">
    All onchain operations are gas-free through our relayer
  </Card>

  <Card title="Order Attribution" icon="tag">
    Get credit for orders and compete for grants on the Builder Leaderboard
  </Card>
</CardGroup>

### What You Get

| Benefit             | Description                                                                     |
| ------------------- | ------------------------------------------------------------------------------- |
| **Relayer Access**  | Gas-free wallet deployment, approvals, order execution and CTF operations       |
| **Volume Tracking** | All orders attributed to your builder profile                                   |
| **Leaderboard**     | Public visibility on [builders.polymarket.com](https://builders.polymarket.com) |
| **Support**         | Telegram channel and engineering support (Verified+)                            |

<Warning>
  EOA wallets do not have relayer access. Users trading directly from an EOA pay
  their own gas fees.
</Warning>

## How It Works

<Steps>
  <Step title="User Places Order">
    User places an order through your application.
  </Step>

  <Step title="Attach Builder Code">
    Your app adds your `builderCode` to the order struct.
  </Step>

  <Step title="Submit to CLOB">
    Order is submitted to Polymarket's CLOB — the builder code is serialized
    onchain as part of the signed order.
  </Step>

  <Step title="Trade Execution">
    Polymarket matches the order and covers gas fees for onchain operations.
  </Step>

  <Step title="Volume Attribution">
    Volume is credited to your builder account for every matched trade where
    your code is attached.
  </Step>
</Steps>

## Getting Started

<Steps>
  <Step title="Create Builder Profile">
    Go to
    [polymarket.com/settings?tab=builder](https://polymarket.com/settings?tab=builder)
    and copy your builder code.
  </Step>

  <Step title="Attach Your Builder Code">
    Pass `builderCode` on every order you submit — see [Order
    Attribution](/trading/orders/attribution).
  </Step>

  <Step title="Enable Gasless Transactions">
    Use the Relayer Client for gas-free wallet deployment and onchain
    operations.
  </Step>

  <Step title="Track Performance">
    Monitor your volume on the [Builder
    Leaderboard](https://builders.polymarket.com).
  </Step>
</Steps>

## SDKs and Libraries

<CardGroup cols={2}>
  <Card title="CLOB Client (TypeScript)" icon="github" href="https://github.com/Polymarket/clob-client-v2">
    Place orders with builder attribution
  </Card>

  <Card title="CLOB Client (Python)" icon="github" href="https://github.com/Polymarket/py-clob-client-v2">
    Place orders with builder attribution
  </Card>

  <Card title="Relayer Client (TypeScript)" icon="github" href="https://github.com/Polymarket/builder-relayer-client">
    Gasless onchain transactions
  </Card>

  <Card title="Relayer Client (Python)" icon="github" href="https://github.com/Polymarket/py-builder-relayer-client">
    Gasless onchain transactions
  </Card>

  <Card title="CLOB Client (Rust)" icon="github" href="https://github.com/Polymarket/rs-clob-client-v2">
    Place orders with builder attribution
  </Card>
</CardGroup>

## Examples

These open-source demo applications show how to integrate Polymarket's CLOB Client and Builder Relayer Client for gasless trading with builder order attribution.

<CardGroup cols={3}>
  <Card title="Authentication" icon="user-check">
    Multiple wallet providers
  </Card>

  <Card title="Gasless Trading" icon="gas-pump">
    Deposit wallet support for new API users
  </Card>

  <Card title="Full Integration" icon="puzzle-piece">
    Orders, positions, CTF ops
  </Card>
</CardGroup>

### Deposit Wallet Integrations

New API users should use deposit wallets. Use the Builder Relayer Client to
deploy deposit wallets and execute signed wallet batches, then place CLOB
orders with `POLY_1271`.

See the [Deposit Wallet Guide](/trading/deposit-wallets) for TypeScript,
Python, Rust, and direct API integration details.

### Existing Safe Wallet Examples

Existing Safe integrations can continue using Gnosis Safe wallets:

<CardGroup cols={2}>
  <Card title="wagmi + Safe" icon="wallet" href="https://github.com/Polymarket/wagmi-safe-builder-example">
    MetaMask, Phantom, Rabby, and other browser wallets
  </Card>

  <Card title="Privy + Safe" icon="shield-check" href="https://github.com/Polymarket/privy-safe-builder-example">
    Privy embedded wallets
  </Card>

  <Card title="Magic Link + Safe" icon="wand-magic-sparkles" href="https://github.com/Polymarket/magic-safe-builder-example">
    Magic Link email/social authentication
  </Card>

  <Card title="Turnkey + Safe" icon="key" href="https://github.com/Polymarket/turnkey-safe-builder-example">
    Turnkey embedded wallets
  </Card>
</CardGroup>

### Existing Proxy Wallet Examples

For existing Magic Link users from Polymarket.com:

<CardGroup cols={1}>
  <Card title="Magic Link + Proxy" icon="wand-magic-sparkles" href="https://github.com/Polymarket/magic-proxy-builder-example">
    Auto-deploying proxy wallets for Polymarket.com Magic users
  </Card>
</CardGroup>

### What Each Demo Covers

<Tabs>
  <Tab title="Authentication">
    <ul>
      <li>User sign-in via wallet provider</li>
      <li>User API credential derivation (L2 auth)</li>
      <li>Builder config with remote signing</li>
      <li>Signature types for Deposit Wallet, Safe, and Proxy wallets</li>
    </ul>
  </Tab>

  <Tab title="Wallet Operations">
    <ul>
      <li>Deposit wallet deployment via Relayer</li>
      <li>Batch token approvals (pUSD + outcome tokens)</li>
      <li>CTF operations (split, merge, redeem)</li>
      <li>Transaction monitoring</li>
    </ul>
  </Tab>

  <Tab title="Trading">
    <ul>
      <li>CLOB client initialization</li>
      <li>Order placement with builder attribution</li>
      <li>Position and order management</li>
      <li>Market discovery via Gamma API</li>
    </ul>
  </Tab>
</Tabs>

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Get API Keys" icon="key" href="/builders/api-keys">
    Create and manage your Builder API credentials.
  </Card>

  <Card title="Understand Tiers" icon="layer-group" href="/builders/tiers">
    Learn about rate limits and how to upgrade.
  </Card>

  <Card title="Attribute Orders" icon="tag" href="/trading/orders/attribution">
    Configure your client to credit trades to your account.
  </Card>

  <Card title="Gasless Guide" icon="gas-pump" href="/trading/gasless">
    Set up gasless transactions for your users.
  </Card>
</CardGroup>
