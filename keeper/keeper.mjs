/* Pay on Arc — billing agent (server keeper)
 *
 * Runs on a schedule (see .github/workflows/keeper.yml). Each run:
 *   1. reads every subscription in ArcSub,
 *   2. keeps the ones that are active and due,
 *   3. drops the ones that would fail anyway (allowance or balance too low), so
 *      the agent never burns gas on a charge that cannot succeed,
 *   4. collects the rest with chargeMany, in batches.
 *
 * charge() is open to anyone and only ever moves money subscriber → merchant,
 * both fixed when the subscription was created. The agent pays gas and nothing
 * else: a leaked key can lose the gas balance, never a subscriber's USDC.
 *
 * Environment:
 *   KEEPER_PRIVATE_KEY  required — the agent wallet (holds only gas USDC)
 *   ARC_RPC             optional — defaults to Arc mainnet
 *   ARCSUB_ADDRESS      optional — defaults to the mainnet ArcSub
 *   DRY_RUN=1           optional — report what would be charged, send nothing
 */
import { ethers } from 'ethers';

const RPC = process.env.ARC_RPC || 'https://rpc.mainnet.arc.io';
const ARCSUB = process.env.ARCSUB_ADDRESS || '0x72E4d6027c2984ddd42EaB8d8F00e9BD17299614';
const USDC = process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';   // ERC-20 interface, 6 decimals
const EXPECTED_CHAIN = process.env.ARC_RPC ? null : 5042n;
const DRY_RUN = process.env.DRY_RUN === '1';

const BATCH = 25;               // ids per chargeMany
const READ_CONCURRENCY = 5;
const MIN_GAS = ethers.parseUnits('0.05', 18);   // native USDC has 18 decimals

const SUB_ABI = [
  'function nextId() view returns (uint256)',
  'function chargeMany(uint256[] ids)',
  'function getSub(uint256 id) view returns (address subscriber, address merchant, uint96 amount, uint32 interval, uint40 nextChargeAt, bool active, string label)',
  'event Charged(uint256 indexed id, address indexed merchant, uint96 amount, uint40 nextCharge)',
  'event ChargeSkipped(uint256 indexed id)'
];
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const fmt6 = v => ethers.formatUnits(v, 6);

async function withRetry(fn, tries = 3){
  let last;
  for(let i = 0; i < tries; i++){
    try{ return await fn(); }
    catch(e){ last = e; await new Promise(r => setTimeout(r, 500 * (i + 1))); }
  }
  throw last;
}

async function inBatches(items, size, fn){
  const out = [];
  for(let i = 0; i < items.length; i += size){
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

async function main(){
  const key = process.env.KEEPER_PRIVATE_KEY;
  if(!key){
    log('KEEPER_PRIVATE_KEY is not set — nothing to do.');
    return;
  }
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if(EXPECTED_CHAIN && net.chainId !== EXPECTED_CHAIN){
    throw new Error(`RPC is on chain ${net.chainId}, expected Arc mainnet (${EXPECTED_CHAIN}).`);
  }
  const wallet = new ethers.Wallet(key.trim(), provider);
  const sub = new ethers.Contract(ARCSUB, SUB_ABI, wallet);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);

  const gas = await provider.getBalance(wallet.address);
  log(`agent ${wallet.address} · gas ${ethers.formatUnits(gas, 18)} USDC · chain ${net.chainId}`);
  if(gas < MIN_GAS && !DRY_RUN){
    log('Gas balance below 0.05 USDC — fund the agent wallet. Skipping this run.');
    process.exitCode = 1;
    return;
  }

  const nextId = Number(await withRetry(() => sub.nextId()));
  const ids = [];
  for(let id = 1; id < nextId; id++) ids.push(id);
  log(`${ids.length} subscription(s) on record`);

  // The contract judges "due" by block time, so the agent does too.
  const now = BigInt((await provider.getBlock('latest')).timestamp);
  const rows = await inBatches(ids, READ_CONCURRENCY, async id => {
    try{
      const s = await withRetry(() => sub.getSub(id));
      return { id, ...s.toObject() };
    }catch(e){
      log(`#${id} unreadable: ${e.shortMessage || e.message}`);
      return null;
    }
  });
  const due = rows.filter(r => r && r.active && BigInt(r.nextChargeAt) <= now);
  if(!due.length){
    log('Nothing due. Resting.');
    return;
  }

  // Would it succeed? A subscriber can only be charged if their allowance and
  // balance both cover the amount. Several subscriptions from one wallet draw
  // on the same allowance and balance, so budget them together.
  const budget = new Map();
  const chargeable = [];
  for(const r of due){
    const who = r.subscriber.toLowerCase();
    if(!budget.has(who)){
      try{
        const [allow, bal] = await Promise.all([
          withRetry(() => usdc.allowance(r.subscriber, ARCSUB)),
          withRetry(() => usdc.balanceOf(r.subscriber))
        ]);
        budget.set(who, allow < bal ? allow : bal);
      }catch(_){
        budget.set(who, null);      // unknown — let chargeMany decide
      }
    }
    const left = budget.get(who);
    const amount = BigInt(r.amount);
    if(left !== null && left < amount){
      log(`#${r.id} due but not collectable (${fmt6(left)} USDC available of ${fmt6(amount)}) — skipped`);
      continue;
    }
    if(left !== null) budget.set(who, left - amount);
    chargeable.push(r.id);
  }

  log(`${due.length} due · ${chargeable.length} collectable`);
  if(!chargeable.length || DRY_RUN){
    if(DRY_RUN) log(`DRY_RUN — would charge: ${chargeable.join(', ') || 'none'}`);
    return;
  }

  let charged = 0, skipped = 0;
  for(let i = 0; i < chargeable.length; i += BATCH){
    const batch = chargeable.slice(i, i + BATCH);
    try{
      const tx = await sub.chargeMany(batch);
      log(`chargeMany [${batch.join(', ')}] sent ${tx.hash}`);
      const rc = await tx.wait();
      for(const l of rc.logs){
        let ev = null;
        try{ ev = sub.interface.parseLog(l); }catch(_){}
        if(ev?.name === 'Charged'){ charged++; log(`  ✓ #${ev.args.id} ${fmt6(ev.args.amount)} USDC → ${ev.args.merchant}`); }
        if(ev?.name === 'ChargeSkipped'){ skipped++; log(`  ✗ #${ev.args.id} skipped by the contract`); }
      }
    }catch(e){
      log(`batch failed: ${e.shortMessage || e.message}`);
      process.exitCode = 1;
    }
  }
  log(`done · ${charged} charged · ${skipped} skipped`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
