> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Liquidity Rewards

> Earn rewards for providing liquidity on Polymarket

By posting resting limit orders, liquidity providers (makers) are automatically eligible for Polymarket's incentive program. Rewards are distributed directly to maker addresses daily at midnight UTC.

The program is designed to:

* Catalyze liquidity across all markets
* Encourage liquidity throughout a market's entire lifecycle
* Motivate passive, balanced quoting tight to a market's midpoint
* Encourage trading activity
* Discourage blatantly exploitative behaviors

<Info>
  This program is heavily inspired by [dYdX's liquidity provider
  rewards](https://www.dydx.foundation/blog/liquidity-provider-rewards). The
  methodology is essentially a copy of dYdX's approach with adjustments for
  binary contract markets — distinct books, no staking mechanic, a modified
  order utility-relative depth function, and reward amounts isolated per market.
</Info>

***

<Note>
  The minimum reward payout is **\$1**; amounts below this will not be paid.
</Note>

<Tip>
  Both `min_incentive_size` and `max_incentive_spread` can be fetched alongside
  full market objects via the CLOB API and [Markets
  API](/market-data/fetching-markets). Reward allocations for an epoch can also
  be fetched via the Markets API.
</Tip>

***

## Methodology

Liquidity providers are rewarded based on a formula that rewards participation in markets, boosts two-sided depth (single-sided orders still score), and tighter spread vs the size-cutoff-adjusted midpoint. Each market configures a max spread and min size cutoff within which orders are considered. The average of rewards earned is determined by the relative share of each participant's Q<sub>n</sub> in market m.

### Variables

| Variable       | Description                                                      |
| -------------- | ---------------------------------------------------------------- |
| S              | Order position scoring function                                  |
| v              | Max spread from midpoint (in cents)                              |
| s              | Spread from size-cutoff-adjusted midpoint                        |
| b              | In-game multiplier                                               |
| m              | Market                                                           |
| m'             | Market complement (i.e. NO if m = YES)                           |
| n              | Trader index                                                     |
| u              | Sample index                                                     |
| c              | Scaling factor (currently 3.0 on all markets)                    |
| Q<sub>ne</sub> | Point total for book one for a sample                            |
| Q<sub>no</sub> | Point total for book two for a sample                            |
| Spread%        | Distance from midpoint (bps or relative) for order n in market m |
| BidSize        | Share-denominated quantity of bid                                |
| AskSize        | Share-denominated quantity of ask                                |

***

## Equations

### 1. Order Scoring Function

Quadratic scoring rule for an order based on position between the adjusted midpoint and the minimum qualifying spread:

$S(v,s)= (\frac{v-s}{v})^2 \cdot b$

### 2. First Market Side Score

$Q_{one}= S(v,Spread_{m_1}) \cdot BidSize_{m_1} + S(v,Spread_{m_2}) \cdot BidSize_{m_2} + \dots $
$ + S(v, Spread_{m^\prime_1}) \cdot AskSize_{m^\prime_1} + S(v, Spread_{m^\prime_2}) \cdot AskSize_{m^\prime_2}$

### 3. Second Market Side Score

$Q_{two}= S(v,Spread_{m_1}) \cdot AskSize_{m_1} + S(v,Spread_{m_2}) \cdot AskSize_{m_2} + \dots $
$ + S(v, Spread_{m^\prime_1}) \cdot BidSize_{m^\prime_1} + S(v, Spread_{m^\prime_2}) \cdot BidSize_{m^\prime_2}$

### 4. Minimum Score

Boosts two-sided liquidity by taking the minimum of Q<sub>ne</sub> and Q<sub>no</sub>, while still rewarding single-sided liquidity at a reduced rate (divided by c).

**If midpoint is in range \[0.10, 0.90]** — single-sided liquidity can score:

$Q_{\min} = \max(\min({Q_{one}, Q_{two}}), \max(Q_{one}/c, Q_{two}/c))$

**If midpoint is in range \[0, 0.10) or (0.90, 1.0]** — liquidity must be double-sided to score:

$Q_{\min} = \min({Q_{one}, Q_{two}})$

### 5. Normalized Score

Q<sub>min</sub> of a market maker divided by the sum of all Q<sub>min</sub> across market makers in a given sample:

$Q_{normal} = \frac{Q_{min}}{\sum_{n=1}^{N}{(Q_{min})_n}}$

### 6. Epoch Score

Sum of all Q<sub>normal</sub> for a trader across all samples in an epoch:

$Q_{epoch} = \sum_{u=1}^{10,080}{(Q_{normal})_u}$

### 7. Final Score

Normalizes Q<sub>epoch</sub> by dividing by the sum of all market makers' Q<sub>epoch</sub> in a given epoch. This value is multiplied by the rewards available for the market to get a trader's reward:

$Q_{final}=\frac{Q_{epoch}}{\sum_{n=1}^{N}{(Q_{epoch})_n}}$

***

## Worked Example

Assume an adjusted market midpoint of 0.50 and a max spread config of 3 cents for both m and m'.

### Step 2 - First Side Score

A trader has the following open orders:

* 100Q bid on m @ 0.49 (spread = 1 cent)
* 200Q bid on m @ 0.48 (spread = 2 cents)
* 100Q ask on m' @ 0.51 (spread = 1 cent)

$$
Q_{ne} = \left( \frac{(3-1)}{3} \right)^2 \cdot 100 + \left( \frac{(3-2)}{3} \right)^2 \cdot 200 + \left( \frac{(3-1)}{3} \right)^2 \cdot 100
$$

Q<sub>ne</sub> is calculated every minute using random sampling.

### Step 3 - Second Side Score

The same trader also has:

* 100Q bid on m @ 0.485 (spread = 1.5 cents)
* 100Q bid on m' @ 0.48 (spread = 2 cents)
* 200Q ask on m' @ 0.505 (spread = 0.5 cents)

$$
Q_{no} = \left( \frac{(3-1.5)}{3} \right)^2 \cdot 100 + \left( \frac{(3-2)}{3} \right)^2 \cdot 100 + \left( \frac{(3-.5)}{3} \right)^2 \cdot 200
$$

Q<sub>no</sub> is calculated every minute using random sampling.

### Steps 4-7

4. Take the minimum of Q<sub>ne</sub> and Q<sub>no</sub> (with single-sided adjustment if midpoint is in \[0.10, 0.90])
5. Normalize against all other market makers in the sample
6. Sum across all 10,080 samples in the epoch
7. Normalize again to get final reward share

***

## April 2026 — Liquidity Incentive Program

Polymarket is distributing over **\$5M** in liquidity incentives for April 2026 across sports and esports markets. The reward pool is split into **Pre** (pre-game) and **Live** (in-play) periods per game. Rewards are distributed pro-rata across all eligible markets within each game.

<Note>
  This covers April 2026 sports markets. Additional categories will be added soon.
</Note>

### Soccer — Top 5 Leagues + UEFA

Every game in these leagues has liquidity rewards split across pre-game and live periods.

| League                  | Pre \$/Game | Live \$/Game | Total \$/Game |
| ----------------------- | ----------- | ------------ | ------------- |
| English Premier League  | \$2,800     | \$7,200      | \$10,000      |
| La Liga                 | \$900       | \$2,400      | \$3,300       |
| Serie A                 | \$900       | \$2,400      | \$3,300       |
| Bundesliga              | \$850       | \$2,150      | \$3,000       |
| Ligue 1                 | \$600       | \$1,500      | \$2,100       |
| Champions League (QFs)  | \$6,750     | \$17,250     | \$24,000      |
| Europa League (QFs)     | \$1,350     | \$3,400      | \$4,750       |
| Conference League (QFs) | \$400       | \$1,100      | \$1,500       |

### Soccer — Americas

| League                     | Pre \$/Game | Live \$/Game | Total \$/Game |
| -------------------------- | ----------- | ------------ | ------------- |
| MLS                        | \$450       | \$1,200      | \$1,650       |
| Liga MX                    | \$450       | \$1,200      | \$1,650       |
| Copa Libertadores (Groups) | \$750       | \$1,900      | \$2,650       |
| Copa Sudamericana (Groups) | \$225       | \$575        | \$800         |
| Argentine Primera Division | \$150       | \$400        | \$550         |
| Brasileirao Serie A        | \$150       | \$400        | \$550         |
| Colombian Primera A        | \$100       | \$200        | \$300         |
| Chilean Primera Division   | \$75        | \$175        | \$250         |
| Peruvian Primera Division  | \$75        | \$175        | \$250         |
| Bolivian Primera           | \$25        | \$50         | \$75          |
| Brasileirao Serie B        | \$25        | \$50         | \$75          |

### Soccer — Other Europe

| League                   | Pre \$/Game | Live \$/Game | Total \$/Game |
| ------------------------ | ----------- | ------------ | ------------- |
| Turkish Super Lig        | \$550       | \$1,450      | \$2,000       |
| Eredivisie               | \$250       | \$650        | \$900         |
| Liga Portugal            | \$200       | \$550        | \$750         |
| EFL Championship         | \$150       | \$350        | \$500         |
| Russian Premier League   | \$100       | \$275        | \$375         |
| Danish Superliga         | \$75        | \$150        | \$225         |
| Czech First League       | \$25        | \$75         | \$100         |
| Romanian Liga I          | \$25        | \$75         | \$100         |
| Ukrainian Premier League | \$25        | \$75         | \$100         |

### Soccer — Asia / Middle East / Africa

| League                  | Pre \$/Game | Live \$/Game | Total \$/Game |
| ----------------------- | ----------- | ------------ | ------------- |
| Saudi Pro League        | \$450       | \$1,200      | \$1,650       |
| J1 League (Japan)       | \$300       | \$800        | \$1,100       |
| K League 1 (Korea)      | \$200       | \$550        | \$750         |
| Chinese Super League    | \$100       | \$250        | \$350         |
| A-League (Australia)    | \$100       | \$250        | \$350         |
| Indian Super League     | \$75        | \$175        | \$250         |
| J2 League (Japan)       | \$25        | \$75         | \$100         |
| Egyptian Premier League | \$25        | \$75         | \$100         |
| Moroccan League         | \$25        | \$75         | \$100         |
| Norwegian Eliteserien   | \$25        | \$75         | \$100         |

### Soccer — Domestic Cups

| League                        | Pre \$/Game | Live \$/Game | Total \$/Game |
| ----------------------------- | ----------- | ------------ | ------------- |
| FA Cup (Semi-Finals)          | \$850       | \$2,000      | \$2,850       |
| DFB-Pokal (Semi-Finals)       | \$450       | \$950        | \$1,400       |
| Coppa Italia (Semi-Finals)    | \$450       | \$950        | \$1,400       |
| Coupe de France (Semi-Finals) | \$275       | \$675        | \$950         |

### Esports — CS2

| Tier                                | Pre \$/Game | Live \$/Game | Total \$/Game |
| ----------------------------------- | ----------- | ------------ | ------------- |
| A Tier (ESL Pro League, BLAST)      | \$1,550     | \$3,950      | \$5,500       |
| B Tier (RMRs, Large Regional)       | \$1,550     | \$3,950      | \$5,500       |
| C Tier (Small Regional, Qualifiers) | \$150       | \$350        | \$500         |

### Esports — League of Legends

| Tier                            | Pre \$/Game | Live \$/Game | Total \$/Game |
| ------------------------------- | ----------- | ------------ | ------------- |
| A Tier (LCK, LPL, LEC Playoffs) | \$1,550     | \$3,950      | \$5,500       |
| B Tier (LCS, Other Regional)    | \$1,550     | \$3,950      | \$5,500       |
| C Tier (ERLs, National Leagues) | \$150       | \$350        | \$500         |

### Esports — Dota 2

| Tier                       | Pre \$/Game | Live \$/Game | Total \$/Game |
| -------------------------- | ----------- | ------------ | ------------- |
| A/B Tier (DPC, Qualifiers) | \$1,000     | \$2,500      | \$3,500       |
| C Tier (Regional)          | \$150       | \$350        | \$500         |

### Esports — Valorant

| Tier                  | Pre \$/Game | Live \$/Game | Total \$/Game |
| --------------------- | ----------- | ------------ | ------------- |
| A/B Tier (VCT Stages) | \$1,000     | \$2,500      | \$3,500       |
| C Tier (Regional)     | \$150       | \$350        | \$500         |

### Esports — Other Titles

| Game                      | Pre \$/Game | Live \$/Game | Total \$/Game |
| ------------------------- | ----------- | ------------ | ------------- |
| Call of Duty (CDL)        | \$50        | \$100        | \$150         |
| Rocket League (RLCS)      | \$50        | \$100        | \$150         |
| Mobile Legends: Bang Bang | \$50        | \$100        | \$150         |
| Honor of Kings            | \$50        | \$100        | \$150         |

### Basketball

| League                                | Pre \$/Game | Live \$/Game | Total \$/Game |
| ------------------------------------- | ----------- | ------------ | ------------- |
| NBA (Reg Season + Play-In + Playoffs) | \$2,150     | \$5,550      | \$7,700       |
| EuroLeague (Playoffs)                 | \$150       | \$350        | \$500         |
| ACB Spain                             | \$75        | \$200        | \$275         |
| Lega Basket Serie A (Italy)           | \$75        | \$200        | \$275         |
| Basketball Champions League           | \$75        | \$200        | \$275         |
| CBA (China)                           | \$50        | \$150        | \$200         |
| LNB Pro A (France)                    | \$50        | \$150        | \$200         |
| KBL (Korea)                           | \$25        | \$50         | \$75          |
| NBL (Australia)                       | \$25        | \$50         | \$75          |
| B.League (Japan)                      | \$25        | \$50         | \$75          |
| BBL (Germany)                         | \$25        | \$50         | \$75          |
| ABA League                            | \$25        | \$50         | \$75          |
| BSL (Turkey)                          | \$25        | \$50         | \$75          |
| Greek A1                              | \$25        | \$50         | \$75          |
| LNB Argentina                         | \$0         | \$25         | \$25          |
| VTB United League                     | \$0         | \$25         | \$25          |

### Baseball

| League      | Pre \$/Game | Live \$/Game | Total \$/Game |
| ----------- | ----------- | ------------ | ------------- |
| MLB         | \$465       | \$1,185      | \$1,650       |
| KBO (Korea) | \$75        | \$225        | \$300         |

### Hockey

| League                      | Pre \$/Game | Live \$/Game | Total \$/Game |
| --------------------------- | ----------- | ------------ | ------------- |
| NHL (Reg Season + Playoffs) | \$400       | \$1,100      | \$1,500       |
| KHL (Playoffs)              | \$75        | \$200        | \$275         |
| SHL (Playoffs)              | \$25        | \$150        | \$175         |
| AHL                         | \$0         | \$25         | \$25          |
| Czech Extraliga (Playoffs)  | \$0         | \$25         | \$25          |
| DEL Germany (Playoffs)      | \$0         | \$25         | \$25          |

### Tennis

| Tour     | Pre \$/Game | Live \$/Game | Total \$/Game |
| -------- | ----------- | ------------ | ------------- |
| ATP Tour | \$450       | \$1,000      | \$1,450       |
| WTA Tour | \$300       | \$750        | \$1,050       |

### UFC / MMA

| Event Type    | Pre \$/Game | Live \$/Game | Total \$/Game |
| ------------- | ----------- | ------------ | ------------- |
| UFC Main Card | \$1,200     | \$3,050      | \$4,250       |
| UFC Prelims   | \$250       | \$700        | \$950         |

### Cricket

| League                       | Pre \$/Game | Live \$/Game | Total \$/Game |
| ---------------------------- | ----------- | ------------ | ------------- |
| IPL (Indian Premier League)  | \$1,250     | \$3,250      | \$4,500       |
| ICC ODI Internationals       | \$0         | \$50         | \$50          |
| ICC T20 Internationals       | \$0         | \$50         | \$50          |
| Other Cricket Internationals | \$0         | \$25         | \$25          |
| Test Cricket                 | \$0         | \$25         | \$25          |

### Rugby

| League                       | Pre \$/Game | Live \$/Game | Total \$/Game |
| ---------------------------- | ----------- | ------------ | ------------- |
| Top 14 (France)              | \$75        | \$175        | \$250         |
| Premiership Rugby (England)  | \$75        | \$175        | \$250         |
| Super Rugby Pacific          | \$75        | \$175        | \$250         |
| United Rugby Championship    | \$50        | \$125        | \$175         |
| European Champions Cup (QFs) | \$100       | \$300        | \$400         |

### Other

| Event            | Pre \$/Game | Live \$/Game | Total \$/Game |
| ---------------- | ----------- | ------------ | ------------- |
| WTT Table Tennis | \$0         | \$25         | \$25          |
| Chess            | \$25        | \$75         | \$100         |
| PLL Lacrosse     | \$25        | \$75         | \$100         |

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Trading" icon="chart-line" href="/market-makers/trading">
    Order entry and quoting best practices
  </Card>

  <Card title="Maker Rebates" icon="receipt" href="/market-makers/maker-rebates">
    Earn USDC rebates on eligible crypto and sports markets
  </Card>
</CardGroup>
