# Billing agent

`keeper.mjs` collects due subscriptions on Arc mainnet. GitHub Actions runs it
every few minutes (`.github/workflows/keeper.yml`); nothing else is needed.

## Setup, once

1. Create a **new** wallet just for the agent. Never reuse a wallet that holds
   anything else.
2. Send it 1–2 USDC on Arc mainnet for gas.
3. GitHub → repository → Settings → Secrets and variables → Actions →
   New repository secret
   - Name: `KEEPER_PRIVATE_KEY`
   - Value: the agent wallet's private key
4. Put the agent wallet's **address** (not the key) in `MAINNET_KEEPER` at the
   top of `index.html`. The Billing Agent tab then shows it live.
5. Actions tab → "Billing agent" → Run workflow, to try it right away.

The key can only spend the agent's own gas. `charge()` moves money from the
subscriber to the merchant fixed at subscription time and nowhere else.

## Running it by hand

```bash
cd keeper
npm ci
KEEPER_PRIVATE_KEY=0x… DRY_RUN=1 node keeper.mjs   # report only
KEEPER_PRIVATE_KEY=0x… node keeper.mjs             # collect
```

GitHub runs scheduled workflows on a best-effort basis: a 5-minute schedule can
be delayed under load, and GitHub pauses schedules in a repository with no
activity for 60 days.
