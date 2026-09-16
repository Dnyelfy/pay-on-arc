// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted, goTab } = require('./harness');

test.describe('pay-links', () => {
  test('builds a link with a normalized amount and copies it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);
    await goTab(page, 'pay');

    await page.fill('#payTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#payAmt', '2,50');
    await page.fill('#payNote', 'coffee');
    await page.click('button:has-text("Create pay-link")');
    await expect(page.locator('#payStatus')).toHaveText(/copied/i);

    const link = await page.evaluate(() => navigator.clipboard.readText());
    const u = new URL(link);
    expect(u.searchParams.get('to')).toBe('0x2222222222222222222222222222222222222222');
    expect(u.searchParams.get('amt')).toBe('2.50');   // comma normalized before sharing
    expect(u.searchParams.get('note')).toBe('coffee');
    expect(u.searchParams.get('net')).toBe('testnet');  // a link never changes networks when opened
  });

  test('refuses to build a link without a valid amount', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);
    await goTab(page, 'pay');
    await page.fill('#payTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#payAmt', '0');
    await page.click('button:has-text("Create pay-link")');
    await expect(page.locator('#payStatus')).toHaveText(/above zero/i);
  });

  test('an incoming link renders a payment request', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html?to=0x2222222222222222222222222222222222222222&amt=3.25&note=dinner');
    await waitBooted(page);

    await expect(page.locator('#incomingCard')).toBeVisible();
    await expect(page.locator('#incomingReceipt')).toContainText('3.25 USDC');
    await expect(page.locator('#incomingReceipt')).toContainText('dinner');
    await expect(page.locator('#incomingReceipt')).toContainText('Arc Testnet');
  });

  test('an incoming link with a junk amount is ignored', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html?to=0x2222222222222222222222222222222222222222&amt=-9');
    await waitBooted(page);
    await expect(page.locator('#incomingCard')).toBeHidden();
  });
});
