// @ts-check
/* Test harness: pins the ethers bundle, stubs the Arc RPC and stubs an
   EIP-1193 wallet, so the whole UI can be driven headlessly without a chain. */
const fs = require('fs');
const path = require('path');

const CHAIN_ID = 5042002;
const MAINNET_CHAIN_ID = 5042;
const MAINNET_PAY = '0x' + '5a'.repeat(20);
const MAINNET_SUBS = '0x' + '5b'.repeat(20);
const MAINNET_KEEPER = '0x' + '5c'.repeat(20);
const CHAIN_ID_HEX = '0x' + CHAIN_ID.toString(16);
const ETHERS_FILE = path.resolve(__dirname, '..', 'vendor', 'ethers-6.13.2.umd.min.js');
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TX_HASH = '0x' + 'ab'.repeat(32);

/** Serve the pinned ethers bundle in place of the CDN. Because the bytes are
 *  the ones the SRI hash in index.html was computed from, a passing page load
 *  also proves that hash is correct. */
async function stubEthersCdn(page, { fail = false } = {}) {
  await page.route('https://cdnjs.cloudflare.com/**', route => {
    if (fail) return route.abort('failed');
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' },
      body: fs.readFileSync(ETHERS_FILE)
    });
  });
}

/** Canned JSON-RPC node. Handles ethers' batched (array) payloads too. */
async function stubRpc(page, overrides = {}) {
  const answer = (method, params) => {
    if (overrides[method] !== undefined) {
      return typeof overrides[method] === 'function' ? overrides[method](params) : overrides[method];
    }
    switch (method) {
      case 'eth_chainId': return CHAIN_ID_HEX;
      case 'net_version': return String(CHAIN_ID);
      case 'eth_gasPrice': return '0x3b9aca00';           // 1 gwei
      case 'eth_blockNumber': return '0x186a0';            // 100000
      case 'eth_getBalance': return '0xde0b6b3a7640000';   // 1e18
      case 'eth_getLogs': return [];
      case 'eth_getTransactionCount': return '0x7';
      case 'eth_call': return '0x';
      case 'eth_getBlockByNumber':
        return { number: '0x186a0', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32),
                 timestamp: '0x66000000', gasLimit: '0x1c9c380', gasUsed: '0x0',
                 baseFeePerGas: '0x3b9aca00', miner: ACCOUNT, transactions: [] };
      default: return null;
    }
  };
  const serve = chainId => async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    const pick = (method, params) =>
      method === 'eth_chainId' && overrides[method] === undefined ? '0x' + chainId.toString(16)
      : method === 'net_version' && overrides[method] === undefined ? String(chainId)
      : answer(method, params);
    const one = r => ({ jsonrpc: '2.0', id: r.id, result: pick(r.method, r.params) });
    const payload = Array.isArray(body) ? body.map(one) : one(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  };
  await page.route('**rpc.testnet.arc.network**', serve(CHAIN_ID));
  await page.route('**rpc.mainnet.arc.io**', serve(MAINNET_CHAIN_ID));
}

/** Serve index.html with the mainnet contract addresses filled in (or blanked),
 *  so tests describe the behaviour whatever the committed file holds today. */
async function withMainnet(page, { pay = MAINNET_PAY, subs = MAINNET_SUBS, keeper = '' } = {}) {
  await page.route('**/index.html*', async route => {
    const res = await route.fetch();
    const body = (await res.text())
      .replace(/const MAINNET_PAY\s*=\s*'[^']*';/, `const MAINNET_PAY  = '${pay}';`)
      .replace(/const MAINNET_SUBS\s*=\s*'[^']*';/, `const MAINNET_SUBS = '${subs}';`)
      .replace(/const MAINNET_KEEPER\s*=\s*'[^']*';/, `const MAINNET_KEEPER = '${keeper}';`);
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
}

/** Everything else the page reaches for: explorer, Pyth, the far-chain RPC. */
async function stubExternal(page) {
  await page.route('**testnet.arcscan.app/api/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
  await page.route('**hermes.pyth.network/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      parsed: [{ price: { price: '108500000', conf: '50000', expo: -8, publish_time: Math.floor(Date.now() / 1000) } }],
      binary: { data: ['aabbcc'] }
    }) }));
  await page.route('**ethereum-sepolia-rpc.publicnode.com**', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }) }));
  // Web fonts are cosmetic; serve them empty so the run is hermetic and the
  // console-cleanliness assertion is about the app, not the network.
  await page.route('**fonts.googleapis.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**fonts.gstatic.com/**', route =>
    route.fulfill({ status: 200, contentType: 'font/woff2', body: '' }));
}

/**
 * Install a fake EIP-1193 wallet before any page script runs.
 * @param {object} opts
 *  - chainId:        hex chain the wallet reports (default: Arc)
 *  - switchBehavior: 'ok' | 'reject' | 'unknown-chain'
 */
async function installWallet(page, opts = {}) {
  await page.addInitScript(({ account, chainId, switchBehavior, txHash, defaultChain }) => {
    const calls = [];
    window.__walletCalls = calls;
    let current = chainId || defaultChain;
    const listeners = {};

    window.__setChain = hex => { current = hex; (listeners.chainChanged || []).forEach(f => f(hex)); };

    window.ethereum = {
      isMetaMask: true,
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeListener() {},
      async request({ method, params }) {
        calls.push({ method, params });
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts': return [account];
          case 'eth_chainId': return current;
          case 'net_version': return String(parseInt(current, 16));
          case 'wallet_switchEthereumChain':
            if (switchBehavior === 'reject') { const e = new Error('User rejected'); e.code = 4001; throw e; }
            if (switchBehavior === 'unknown-chain') { const e = new Error('Unrecognized chain'); e.code = 4902; throw e; }
            current = params[0].chainId;
            return null;
          case 'wallet_addEthereumChain': current = params[0].chainId; return null;
          case 'wallet_revokePermissions': return null;
          case 'eth_getBalance': return '0xde0b6b3a7640000';
          case 'eth_getTransactionCount': return '0x0';
          case 'eth_estimateGas': return '0x186a0';
          case 'eth_gasPrice': return '0x3b9aca00';
          case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
          case 'eth_blockNumber': return '0x186a0';
          case 'eth_call': return '0x';
          case 'eth_sendTransaction':
            window.__lastTx = (params && params[0]) || {};
            return txHash;
          case 'eth_getTransactionByHash': {
            // A mined legacy transaction, complete with a signature — ethers
            // re-polls forever if any required field is missing.
            const t = window.__lastTx || {};
            return { hash: txHash, type: '0x0', blockHash: '0x' + '11'.repeat(32),
                     blockNumber: '0x186a0', transactionIndex: '0x0',
                     from: account, to: t.to || account, gas: t.gas || '0x186a0',
                     gasPrice: '0x3b9aca00', nonce: '0x0', value: t.value || '0x0',
                     input: t.data || '0x', chainId: current,
                     v: '0x1b', r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) };
          }
          case 'eth_getTransactionReceipt':
            return { transactionHash: txHash, blockNumber: '0x186a0', blockHash: '0x' + '11'.repeat(32),
                     status: '0x1', from: account, to: (window.__lastTx || {}).to || account, gasUsed: '0x5208',
                     cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [],
                     logsBloom: '0x' + '00'.repeat(256), type: '0x2', contractAddress: null,
                     transactionIndex: '0x0' };
          case 'eth_getBlockByNumber':
            return { number: '0x186a0', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32),
                     timestamp: '0x66000000', gasLimit: '0x1c9c380', gasUsed: '0x0',
                     baseFeePerGas: '0x3b9aca00', miner: account, transactions: [] };
          default: return null;
        }
      }
    };
  }, { account: ACCOUNT, chainId: opts.chainId, switchBehavior: opts.switchBehavior || 'ok',
       txHash: TX_HASH, defaultChain: CHAIN_ID_HEX });
}

/** Full default setup: pinned ethers, stubbed chain + services, fake wallet. */
async function setup(page, opts = {}) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await stubEthersCdn(page, { fail: opts.cdnFails });
  await stubRpc(page, opts.rpc);
  await stubExternal(page);
  if (!opts.noWallet) await installWallet(page, opts);
  // Pin the network the suite was written against, so filling in the mainnet
  // addresses later does not silently move every test onto mainnet.
  // Pass { network: null } to exercise the page's own choice.
  if (opts.network !== null) {
    await page.addInitScript(k => { try { localStorage.setItem('payonarc.network', k); } catch (_) {} },
                             opts.network || 'arc-testnet');
  }
  return errors;
}

/** Wait until boot() has run: the network badge is the last thing it fills in. */
async function waitBooted(page) {
  await page.waitForFunction(
    () => document.getElementById('netPill') &&
          document.getElementById('netPill').textContent !== '—',
    null, { timeout: 15000 });
}

/** Select a feature tab by name (subs, agent, pay, split, recall, bridge, treasury, history). */
async function goTab(page, name) {
  await page.click('#tab-' + name);
  await page.waitForSelector('#sec-' + name + '.active');
}

module.exports = { setup, installWallet, stubEthersCdn, stubRpc, stubExternal, waitBooted, goTab, withMainnet,
                   CHAIN_ID, CHAIN_ID_HEX, MAINNET_CHAIN_ID, MAINNET_PAY, MAINNET_SUBS, MAINNET_KEEPER, ACCOUNT, TX_HASH };
