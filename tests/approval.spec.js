// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted, goTab } = require('./harness');

const SUBS = '0x015f65293c936741588dC03ebDD1A193D62535eC';

test.describe('subscription approvals', () => {
  test('the form says how much will be approved before the wallet asks', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);
    await goTab(page, 'subs');
    await page.fill('#subAmt', '10');
    await expect(page.locator('#subApproval')).toContainText('120 USDC');
    await page.selectOption('#subPeriods', '3');
    await expect(page.locator('#subApproval')).toContainText('30 USDC');
  });

  test('the wallet is asked for a capped amount, never an unlimited one', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);
    await goTab(page, 'subs');
    await page.click('#connBtn');
    await expect(page.locator('#connBtn')).toContainText('0x1111');

    await page.fill('#subTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#subAmt', '10');
    await page.selectOption('#subPeriods', '12');
    await page.click('button:has-text("Subscribe — first period charged now")');

    await expect.poll(() => page.evaluate(() =>
      window.__walletCalls.filter(c => c.method === 'eth_sendTransaction').length), { timeout: 20000 })
      .toBeGreaterThan(0);
    const approve = await page.evaluate(() =>
      window.__walletCalls.find(c => c.method === 'eth_sendTransaction').params[0]);

    const iface = new (require('ethers').Interface)(['function approve(address,uint256)']);
    const [spender, amount] = iface.decodeFunctionData('approve', approve.data);
    expect(spender.toLowerCase()).toBe(SUBS.toLowerCase());
    expect(amount).toBe(120000000n);                          // 12 × 10 USDC, 6 decimals
  });
});
