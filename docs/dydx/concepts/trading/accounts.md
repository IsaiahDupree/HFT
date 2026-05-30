# Accounts and Subaccounts – dYdX Documentation

> Source: https://docs.dydx.xyz/concepts/trading/accounts

## Main Account

A main account connects to a public-private keypair and represents a trader's on-chain identity.

- Known publicly and associated with an address.
- Stores tokens and assets transferred to/from the blockchain, including gas fees and collateral.
- Transaction gas fees are drawn from the main account.
- Cannot be used directly for trading.
- Multiple independent main accounts can derive from a single mnemonic phrase.

## Subaccounts

Subaccounts enable fund isolation and risk management within a primary account and serve as the actual trading vehicles.

- Each main account supports up to 128,001 subaccounts.
- Identification uses a combination of `(main account address, integer)`.
- Subaccounts generate automatically upon receiving deposits to a valid ID.
- Only the associated main account can execute transactions on behalf of its subaccounts.
- Subaccounts do not require gas (no gas is used for trading).
- USDC collateral is required to initiate trading activity.
