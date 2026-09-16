// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted, goTab, withMainnet, MAINNET_PAY, MAINNET_CHAIN_ID } = require('./harness');

const MAINNET_HEX = '0x' + MAINNET_CHAIN_ID.toString(16);

test.describe('Arc mainnet', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page, { chainId: MAINNET_HEX, network: null });
    await withMainnet(page);
  });

  test('once deployed, a plain visit lands on mainnet', async ({ page }) => {
    await page.goto('/index.html');
    await waitBooted(page);
    await expect(page.locator('#netPill')).toHaveText('Arc Mainnet');
    await expect(page.locator('#netPill')).not.toHaveClass(/testnet/);
    expect(await page.locator('#cLink').getAttribute('href'))
      .toBe(`https://explorer.arc.io/address/${MAINNET_PAY}`);
  });

  test('only features with live infrastructure are offered', async ({ page }) => {
    await page.goto('/index.html');
    await waitBooted(page);
    // The in-browser agent holds a private key; CCIP and Pyth have no Arc mainnet deployment yet.
    for (const t of ['agent', 'bridge', 'treasury']) {
      await expect(page.locator('#tab-' + t)).toBeHidden();
      await expect(page.locator('#sec-' + t)).toBeHidden();
    }
    await expect(page.locator('.tab-btn:visible')).toHaveCount(5);
    await expect(page.locator('button:has-text("Meet the billing agent")')).toBeHidden();
    await expect(page.locator('#subIntervalRow button[data-sec="300"]')).toBeHidden();
  });

  test('a deep link to a missing feature falls back to the landing tab', async ({ page }) => {
    await page.goto('/index.html#treasury');
    await waitBooted(page);
    await expect(page.locator('#sec-subs')).toHaveClass(/active/);
  });

  test('keyboard navigation skips hidden tabs', async ({ page }) => {
    await page.goto('/index.html');
    await waitBooted(page);
    await page.locator('#tab-subs').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#sec-pay')).toHaveClass(/active/);
    await page.keyboard.press('End');
    await expect(page.locator('#sec-history')).toHaveClass(/active/);
  });

  test('the wallet is asked for Arc mainnet', async ({ page }) => {
    await setup(page, { chainId: '0x4cef52', network: null });   // wallet sitting on testnet
    await withMainnet(page);
    await page.goto('/index.html');
    await waitBooted(page);
    await page.click('#connBtn');
    await expect(page.locator('#connBtn')).toContainText('0x1111');
    const sw = await page.evaluate(() => window.__walletCalls.find(c => c.method === 'wallet_switchEthereumChain'));
    expect(sw.params[0].chainId).toBe(MAINNET_HEX);
  });

  test('pay-links made on mainnet say so', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/index.html');
    await waitBooted(page);
    await goTab(page, 'pay');
    await page.fill('#payTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#payAmt', '5');
    await page.click('button:has-text("Create pay-link")');
    const u = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    expect(u.searchParams.get('net')).toBe('mainnet');
  });

  test('a mainnet link opens on mainnet', async ({ page }) => {
    await page.goto('/index.html?net=mainnet&to=0x2222222222222222222222222222222222222222&amt=5');
    await waitBooted(page);
    await expect(page.locator('#incomingReceipt')).toContainText('Arc Mainnet');
  });

  test('an old link without a network opens on testnet, never on real money', async ({ page }) => {
    await page.goto('/index.html?to=0x2222222222222222222222222222222222222222&amt=5');
    await waitBooted(page);
    await expect(page.locator('#netPill')).toHaveText('Arc Testnet');
    await expect(page.locator('#incomingReceipt')).toContainText('Arc Testnet');
  });

  test('the footer switches networks and remembers the choice', async ({ page }) => {
    await page.goto('/index.html');
    await waitBooted(page);
    await page.click('#netSwitch a');
    await page.waitForURL(/net=testnet/);
    await waitBooted(page);
    await expect(page.locator('#netPill')).toHaveText('Arc Testnet');
    await page.goto('/index.html');
    await waitBooted(page);
    await expect(page.locator('#netPill')).toHaveText('Arc Testnet');
  });
});
