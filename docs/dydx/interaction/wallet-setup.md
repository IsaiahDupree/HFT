# Wallet Setup – dYdX Documentation

> Source: https://docs.dydx.xyz/interaction/wallet-setup

To manage accounts and issue orders requiring signatures, users need a Wallet initialized with their mnemonic.

## Getting the Mnemonic

A mnemonic is a set of 24 words to back up and access your account. Users can retrieve it from the dYdX Frontend by logging in and accessing "Export secret phrase" through their address in the upper right corner.

**Security Warning:** Handle your **mnemonic** in a secure manner. **Do not share** it with other parties. Never commit it to public version control — access to it grants full account and fund access.

## Read the Mnemonic

```python
mnemonic = open('mnemonic.txt').read().strip()
```

## Create the Wallet

```python
from dydx_v4_client.key_pair import KeyPair
from dydx_v4_client.wallet import Wallet

address = Wallet(KeyPair.from_mnemonic(mnemonic), 0, 0).address()

wallet = await Wallet.from_mnemonic(node, mnemonic, address)
```

## Instantiate a Subaccount

Unnecessary for Python clients — the wallet instance already contains required information; the subaccount is defined using an integer when creating orders. By default, Python and TypeScript client wallets derive the account indexed at 0.
