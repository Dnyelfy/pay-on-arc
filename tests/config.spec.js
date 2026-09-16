// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted, withMainnet } = require('./harness');

test.describe('network configuration', () => {
  test('an unconfigured mainnet, asked for explicitly, refuses to run and names what is missing', async ({ page }) => {
    await setup(page);
    await withMainnet(page, { pay: '', subs: '' });
    await page.goto('/index.html?net=mainnet');

    const banner = page.locator('body > div').first();
    await expect(banner).toContainText('Configuration incomplete', { timeout: 15000 });
    await expect(banner).toContainText('contracts.pay');
    await expect(banner).toContainText('contracts.subs');

    // Nothing may have been wired up.
    await expect(page.locator('#netPill')).toHaveText('—');
  });

  test('an unconfigured build will not send a payment', async ({ page }) => {
    await setup(page);
    await withMainnet(page, { pay: '', subs: '' });
    await page.goto('/index.html?net=mainnet');
    await expect(page.locator('body > div').first()).toContainText('Configuration incomplete');

    await page.evaluate(() => document.getElementById('sec-pay').classList.add('active'));
    await page.fill('#payTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#payAmt', '1');
    await page.click('button:has-text("Send payment")');
    await expect(page.locator('#payStatus')).toHaveText(/Still loading/i);

    const sent = await page.evaluate(() =>
      window.__walletCalls.filter(c => c.method === 'eth_sendTransaction').length);
    expect(sent).toBe(0);
  });

  test('with mainnet not yet deployed, a plain visit keeps running on testnet', async ({ page }) => {
    await setup(page, { network: null });
    await withMainnet(page, { pay: '', subs: '' });
    await page.goto('/index.html');
    await waitBooted(page);
    await expect(page.locator('#netPill')).toHaveText('Arc Testnet');
    await expect(page.locator('#netSwitch')).toBeEmpty();   // nowhere to switch to yet
  });

  test('the network profile is the only source of chain constants', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html?net=testnet');
    await waitBooted(page);
    expect(await page.evaluate(() => window.configProblems())).toEqual([]);
  });

  test('the billing agent is available on testnet', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html?net=testnet');
    await waitBooted(page);
    await page.click('button:has-text("Billing Agent")');
    await expect(page.locator('#kpState')).toHaveText('agent offline');
    await expect(page.locator('button:has-text("Start agent")')).toBeEnabled();
  });
});
