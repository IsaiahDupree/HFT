> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Contracts

> All Polymarket smart contract addresses, audits, and security resources

All Polymarket contracts are deployed on **Polygon mainnet** (Chain ID: 137). This is the single source of truth for all contract addresses used across the platform.

***

## Core Trading Contracts

| Contract                 | Address                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| CTF Exchange             | [`0xE111180000d2663C0091e4f400237545B87B996B`](https://polygonscan.com/address/0xE111180000d2663C0091e4f400237545B87B996B) |
| Neg Risk CTF Exchange    | [`0xe2222d279d744050d28e00520010520000310F59`](https://polygonscan.com/address/0xe2222d279d744050d28e00520010520000310F59) |
| Neg Risk Adapter         | [`0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`](https://polygonscan.com/address/0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296) |
| Conditional Tokens (CTF) | [`0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`](https://polygonscan.com/address/0x4D97DCd97eC945f40cF65F87097ACe5EA0476045) |

***

## Collateral Contracts

| Contract                       | Address                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| pUSD — CollateralToken (proxy) | [`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`](https://polygonscan.com/address/0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB) |
| pUSD — CollateralToken (impl)  | [`0x6bBCef9f7ef3B6C592c99e0f206a0DE94Ad0925f`](https://polygonscan.com/address/0x6bBCef9f7ef3B6C592c99e0f206a0DE94Ad0925f) |
| CollateralOnramp               | [`0x93070a847efEf7F70739046A929D47a521F5B8ee`](https://polygonscan.com/address/0x93070a847efEf7F70739046A929D47a521F5B8ee) |
| CollateralOfframp              | [`0x2957922Eb93258b93368531d39fAcCA3B4dC5854`](https://polygonscan.com/address/0x2957922Eb93258b93368531d39fAcCA3B4dC5854) |
| PermissionedRamp               | [`0xebC2459Ec962869ca4c0bd1E06368272732BCb08`](https://polygonscan.com/address/0xebC2459Ec962869ca4c0bd1E06368272732BCb08) |
| CtfCollateralAdapter           | [`0xAdA100Db00Ca00073811820692005400218FcE1f`](https://polygonscan.com/address/0xAdA100Db00Ca00073811820692005400218FcE1f) |
| NegRiskCtfCollateralAdapter    | [`0xadA2005600Dec949baf300f4C6120000bDB6eAab`](https://polygonscan.com/address/0xadA2005600Dec949baf300f4C6120000bDB6eAab) |

***

## Wallet Factory Contracts

| Contract                 | Address                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Deposit Wallet Factory   | [`0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`](https://polygonscan.com/address/0x00000000000Fb5C9ADea0298D729A0CB3823Cc07) |
| Gnosis Safe Factory      | [`0xaacfeea03eb1561c4e67d661e40682bd20e3541b`](https://polygonscan.com/address/0xaacfeea03eb1561c4e67d661e40682bd20e3541b) |
| Polymarket Proxy Factory | [`0xaB45c5A4B0c941a2F231C04C3f49182e1A254052`](https://polygonscan.com/address/0xaB45c5A4B0c941a2F231C04C3f49182e1A254052) |

***

## Resolution Contracts

| Contract              | Address                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| UMA Adapter           | [`0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74`](https://polygonscan.com/address/0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74) |
| UMA Optimistic Oracle | [`0xCB1822859cEF82Cd2Eb4E6276C7916e692995130`](https://polygonscan.com/address/0xCB1822859cEF82Cd2Eb4E6276C7916e692995130) |

***

## Security

### Audits

CTF Exchange V2 has been audited by two independent firms:

| Auditor    | Report                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quantstamp | [CTF Exchange V2 — Quantstamp — March 2026](https://github.com/Polymarket/ctf-exchange-v2/blob/main/audits/CTF%20Exchange%20V2%20-%20Quantstamp%20-%20March%202026.pdf) |
| Cantina    | [CTF Exchange V2 — Cantina — March 2026](https://github.com/Polymarket/ctf-exchange-v2/blob/main/audits/CTF%20Exchange%20V2%20-%20Cantina%20-%20March%202026.pdf)       |

### Bug Bounty

Security vulnerabilities can be reported through the [Cantina bug bounty program](https://cantina.xyz/bounties/ff945ca2-2a6e-4b83-b1b6-7a0cd3b94bea).

***

## Source Code

<CardGroup cols={1}>
  <Card title="CTF Exchange V2" icon="github" href="https://github.com/Polymarket/ctf-exchange-v2">
    Order matching and settlement contracts
  </Card>
</CardGroup>
