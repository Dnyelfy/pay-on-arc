# Pay on Arc

**Subscriptions that collect themselves.**

A $5 monthly plan cannot survive on a chain where collecting it costs more than
it earns. On Arc a charge costs a rounding error and gas is USDC, so a
subscription can pull its own money every period with nobody clicking anything —
and a billing agent living in the page can do the pulling.

That is the product. Around it: payments with an on-chain note, pay-links,
20-way splits, recallable payments, Chainlink CCIP cross-chain messaging, and a
Pyth-fed treasury agent that rebalances USDC against EURC.

Single static page — `index.html` — plus a vendored copy of ethers and a
Playwright test suite.

## The tabs

| Tab | What it does | Mainnet | Testnet |
| --- | --- | --- | --- |
| **Subscriptions** | Approve USDC once; each period is pulled only when due. Cancel on-chain from either side. | ✓ | ✓ |
| **Billing Agent** | Collects due subscriptions unattended. Mainnet: a scheduled server agent (`keeper/`) whose key never touches a browser; the tab only watches it. Testnet: a burner-key worker in the page. | ✓ | ✓ |
| Pay & Link | A payment with a note written on-chain, or a shareable pay-link that prefills it. | ✓ | ✓ |
| Split | One transaction, equal shares to up to 20 wallets, dust returned. | ✓ | ✓ |
| Recallable | The sender can cancel inside the window; once it closes the recipient claims. | ✓ | ✓ |
| Cross-Chain | A message through the CCIP router that lands and runs code on the far chain. | — | ✓ |
| Treasury | Reads the Pyth EUR/USD feed and pays a keeper to settle drift back into band. | — | ✓ |
| Receipts | Your payments, read from the contract's own events. | ✓ | ✓ |

## Running locally

```bash
npm install          # test tooling only; the page itself has no build step
npm run serve        # http://127.0.0.1:8080
npm test             # contract tests, then UI tests
npm run test:contracts
npm run test:ui
```

Contracts compile with the `solc` pinned in `devDependencies` rather than a
binary fetched at build time, so the same compiler is used on every machine,
offline. `hardhat.config.js` overrides Hardhat's compiler-download subtask to
point at it.

## Networks

Every chain constant lives in the `NETWORKS` map at the top of the inline
script in `index.html`. Nothing else in the file hardcodes a chain ID, an RPC,
an explorer or a contract address.

| | Arc Mainnet | Arc Testnet |
| --- | --- | --- |
| Chain ID | 5042 | 5042002 |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.network` |
| Explorer | `https://explorer.arc.io` | `https://testnet.arcscan.app` |
| Payments (ArcPayV3) | `0x1C68d18F2C7A4fb694633B4815AE5E5153Dd59Da` | `0xa0185d00ECAE1263282996A4B132949b0aee47E4` |
| Subscriptions (ArcSub) | `0x72E4d6027c2984ddd42EaB8d8F00e9BD17299614` | `0x015f65293c936741588dC03ebDD1A193D62535eC` |

### Which network a visit runs on

1. `?net=mainnet` or `?net=testnet` always wins.
2. A pay-link or subscribe-link without `?net` was made before mainnet existed,
   so it opens on testnet — never on real money. New links always carry `net`.
3. The network this browser last switched to from the footer.
4. Otherwise mainnet, as long as its payments and subscriptions addresses are
   filled in; if either is blank the site falls back to testnet.

### Features that switch themselves off

A feature needs its own infrastructure on the chain. Where it is missing the
tab is hidden, not shown broken:

- **Billing agent** — on testnet it runs in the page with a burner key in
  `localStorage`. On mainnet it runs from `keeper/keeper.mjs` on a GitHub
  Actions schedule, and the tab appears once `MAINNET_KEEPER` holds the agent
  wallet's address. See `keeper/README.md`.
- **Cross-Chain** — Chainlink CCIP lists no Arc mainnet lane yet. Fill in
  `contracts.ccipRouter` and `ccip` on the mainnet profile and the tab returns.
- **Treasury** — Pyth lists no Arc mainnet contract yet. Fill in
  `contracts.treasury`, `contracts.pyth` and `pythEurUsdId` and the tab returns.

## Subscription approvals

The page never asks for an unlimited USDC allowance. The subscriber picks how
many periods to pre-approve (12 by default) and the form states the exact
amount before the wallet opens. Because every subscription to ArcSub draws on
one allowance, a new plan's periods are added on top of what is already
approved. The "Paying out" card shows how many rounds of charges the approval
still covers, with one-click extend and revoke.

## Dependencies

`ethers` 6.13.2 is loaded from cdnjs with a Subresource Integrity hash and
`crossorigin="anonymous"`, falling back to the same-origin copy in `vendor/`
if the CDN is unreachable or the hash does not match. Deploy `vendor/`
alongside `index.html`.

To bump the version: replace `vendor/ethers-<v>.umd.min.js`, update both the
CDN URL and the `integrity` attribute, and recompute the hash with

```bash
echo -n "sha384-$(openssl dgst -sha384 -binary vendor/ethers-<v>.umd.min.js | openssl base64 -A)"
```

The test suite serves the vendored bytes in place of the CDN, so a stale
`integrity` attribute fails `tests/smoke.spec.js` rather than production.

## Contracts

`contracts/ArcPayV3.sol` and `contracts/ArcSub.sol` are the payments and
subscription contracts, deployed at the `pay` and `subs` addresses in each
network profile. `contracts/TreasuryAgent.sol` is the testnet treasury.

### ArcPayV3

V2's recallable window ran backwards: the recipient could claim at once and the
sender could only take the money back after the window. V3 puts each party on
the side the name promises — inside the window only the sender can cancel,
after it only the recipient can claim. A payment untouched for 30 days past the
window can be reclaimed by the sender, so a recipient that can never receive
does not lock funds forever.

`splitPay()` no longer reverts the whole batch when one recipient refuses its
share. The refused share goes back to the sender together with the rounding
dust (`ShareReturned`), and that refund must succeed, so nothing is stranded in
the contract.

**Sound**

- `claim()` and `recall()` set `status` before the external call, so a
  re-entering recipient hits the `status == 0` guard.
- No owner, no pause, no upgrade path — nothing to trust.
- The window is bounded to 60s–30 days.

**Still worth knowing**

- `sentBy()` / `receivedBy()` return unbounded arrays. Fine today; for a very
  active address these views will eventually outgrow a node's response limits.
- Not audited.

### Review notes on ArcSub

**Sound**

- Allowance-pull, never custody: the contract holds no funds at any point, so
  there is nothing in it to drain.
- `charge()` advances `nextCharge` *before* calling `transferFrom`, so a
  re-entering token cannot double-charge — the `block.timestamp >= nextCharge`
  guard is already false. The token address is `immutable`, so it cannot be
  swapped for a malicious one.
- Missed periods do not pile up into a debt: if several intervals elapsed,
  the next charge is scheduled one interval from now, not from the backlog.
- Only `msg.sender` can subscribe themselves, so an open USDC approval to this
  contract can only ever be pulled by subscriptions the approver created.
  Unlimited approval is bounded in practice by that.
- The amount is fixed at creation with no setter, so a merchant cannot raise
  the price on an existing subscriber. Either party can cancel.

**Worth changing**

- `chargeMany()` does not let one failing subscriber block the batch, and
  emits `ChargeSkipped(id)` for every due charge it could not collect. The
  testnet deployment predates that event.
- `transferFrom` is called through a plain `IERC20` and its `bool` is checked.
  Circle's USDC returns one, so this is correct here; a `SafeERC20`-style
  wrapper would survive a token that returns nothing.
- `listBySubscriber()` / `listByMerchant()` return unbounded arrays, same
  ageing problem as ArcPayV3's indexes.
- `label` is arbitrary caller-controlled text, and the contract cannot
  sanitise it. Any frontend must escape it — this is exactly the stored-XSS
  path that was fixed in the agent terminal.

### Review notes on TreasuryAgent

This is the only contract of the three that actually holds funds, so it carries
the most risk.

**Sound**

- The confidence guard is real risk management, not decoration: a Pyth
  confidence interval wider than `maxConfBps` defers the rebalance instead of
  trading through a stressed market. `getPriceNoOlderThan` bounds staleness,
  and the exponent is range-checked before being used as a divisor.
- The keeper is paid from the treasury in the same transaction, so there is no
  IOU and no settlement risk.
- Only `usdc` and `eurc` can be deposited; all three token addresses and the
  feed id are `immutable`.

**Worth changing**

- **`deposit()` is open to anyone; `withdraw()` is `onlyOwner`.** There is no
  path that returns a third party's deposit. Anyone but the owner who funds
  this treasury has made an irreversible transfer. This is the most serious
  finding, and the UI now says so in plain words next to the Fund buttons and
  asks for confirmation before a non-owner deposits.
- **The keeper has no `minOut` / `maxIn` bound.** `rebalance()` decides the
  trade size from drift at the price of the update the keeper just submitted;
  the keeper cannot cap what gets pulled from their wallet, and a price move
  between simulation and execution changes the amounts. A `maxIn`/`minOut`
  parameter would close this. The frontend mitigates it by approving a bounded
  amount rather than `MaxUint256`, but that is a workaround, not a fix.
- **The excess-fee refund happens before the token transfers.** `rebalance()`
  calls `msg.sender` to refund, then reads the price and executes. A keeper
  contract can re-enter there. No profitable path is obvious — the inner call
  rebalances and the outer then finds drift inside the band — but refunding
  last, or a `nonReentrant` guard, removes the question entirely.
- `_sellUsdc` / `_sellEurc` clamp the payout to the treasury balance without
  reducing what the keeper supplies, so in the clamped case the keeper is
  silently underpaid. Reachable only at extreme parameters, but it should
  revert rather than shortchange.
- The owner can withdraw everything at any time, and can move `targetUsdcBps`,
  `maxPriceAge` and the bonus with no timelock. Worth stating wherever the
  agent is described as autonomous.
- `receive()` accepts native currency but nothing can send it back out — any
  plain transfer to this contract is stuck permanently.

**Used by the frontend**

`sentBy()` and `receivedBy()` are the authoritative list of a user's recallable
payments, so the Recallable tab reads them directly rather than scanning logs.
Notes live only in `RecallableCreated`, so they are fetched best-effort and a
missing log costs a note rather than the whole row.

## Tests

`tests/` drives the real page in headless Chromium against a stubbed Arc RPC
and a stubbed EIP-1193 wallet — no chain, no funds, no network.

| File | Covers |
| --- | --- |
| `smoke.spec.js` | Boot, SRI, CDN fallback, tabs, config-driven markup, label/input association |
| `validation.spec.js` | Amount parsing (incl. comma decimals) and every form's rejection paths |
| `paylink.spec.js` | Pay-link generation and consumption |
| `security.spec.js` | Escaping of chain- and URL-sourced strings, script pinning |
| `chain-guard.spec.js` | Wrong-network refusal, chain add, disconnect cleanup |
| `config.spec.js` | Unconfigured-network refusal, testnet fallback |
| `approval.spec.js` | The approval amount is shown before signing and the wallet is asked for a capped amount |
| `mainnet.spec.js` | Mainnet landing, hidden features, network-tagged links, legacy links opening on testnet, footer switch, read-only server agent |
| `navigation.spec.js` | Landing pitch, tab folding, deep links, keyboard tablist, live pricing |

### Contract tests

`test/` runs the contracts on a local EVM — **63 tests**. They exist to prove
what the review claims, in both directions: the guards that hold, and the
findings that are real.

| File | Notable cases |
| --- | --- |
| `ArcPayV3.t.js` | The recipient cannot claim inside the window and the sender cannot cancel after it. A payment abandoned for 30 days returns to the sender, unless the recipient acts first. A recipient re-entering `claim()` takes exactly what it is owed. **A refusing recipient no longer sinks a split**, and a sender that refuses its own refund makes the split revert rather than strand funds. |
| `ArcSub.t.js` | A token that re-enters `charge()` cannot double-charge. Ten missed periods charge once, not ten. **`chargeMany()` charges what it can and reports each skipped id with `ChargeSkipped`**. Only `msg.sender` can subscribe themselves, which is what bounds an unlimited approval. |
| `TreasuryAgent.t.js` | The confidence guard defers instead of trading, and nothing moves. Rebalancing pays the keeper a bonus and lands the mix inside the band. **Anyone can deposit but only the owner can withdraw**, asserted with a stranger's money. **`rebalance()` has no `maxIn`**, asserted by showing the same call pulls ten times as much from a treasury ten times larger. Native currency sent in cannot come out. |

Findings are marked `FINDING:` in the test files. They assert current
behaviour, so if a contract is ever fixed and redeployed, the matching test
fails and points at what changed.

If Playwright cannot download its own browser, point it at an existing one:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm test
```

### Screenshots

`tests/shot.js` renders the page against the same stubs and writes PNGs:

```bash
node tests/static-server.js &
node tests/shot.js ./shots
```
