// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted, goTab } = require('./harness');

test.beforeEach(async ({ page }) => {
  await setup(page);
});

test.describe('navigation and the landing pitch', () => {
  test('the hero greets a first visit and folds away once a tab is chosen', async ({ page }) => {
    // The hero sits above the tabs, so leaving it up would put a full screen of
    // marketing on top of every feature panel.
    await page.goto('/index.html');
    await waitBooted(page);
    await expect(page.locator('.hero')).toBeVisible();

    await goTab(page, 'agent');
    await expect(page.locator('.hero')).toBeHidden();

    await page.click('.logo');
    await expect(page.locator('.hero')).toBeVisible();
  });

  test('subscriptions is the landing tab', async ({ page }) => {
    await page.goto('/index.html');
    await waitBooted(page);
    await expect(page.locator('#sec-subs')).toHaveClass(/active/);
    await expect(page.locator('#tab-subs')).toHaveAttribute('aria-selected', 'true');
  });

  test('a deep link opens its tab and skips the pitch', async ({ page }) => {
    await page.goto('/index.html#treasury');
    await waitBooted(page);
    await expect(page.locator('#sec-treasury')).toHaveClass(/active/);
    await expect(page.locator('.hero')).toBeHidden();
  });

  test('an unknown hash falls back to the landing tab', async ({ page }) => {
    await page.goto('/index.html#nonsense');
    await waitBooted(page);
    await expect(page.locator('#sec-subs')).toHaveClass(/active/);
  });

  test('selecting a tab records it in the URL', async ({ page }) => {
    await page.goto('/index.html');
    await waitBooted(page);
    await goTab(page, 'bridge');
    expect(new URL(page.url()).hash).toBe('#bridge');
  });

  test('the tablist is navigable by keyboard', async ({ page }) => {
    await page.goto('/index.html');
    await waitBooted(page);

    await page.locator('#tab-subs').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#sec-agent')).toHaveClass(/active/);

    await page.keyboard.press('End');
    await expect(page.locator('#sec-history')).toHaveClass(/active/);

    await page.keyboard.press('Home');
    await expect(page.locator('#sec-subs')).toHaveClass(/active/);
  });

  test('exactly one tab is reachable by Tab key (roving tabindex)', async ({ page }) => {
    await page.goto('/index.html');
    await waitBooted(page);
    const reachable = await page.evaluate(() =>
      [...document.querySelectorAll('.tab-btn')].filter(b => b.tabIndex === 0).length);
    expect(reachable).toBe(1);
  });

  test('a pay-link overrides the landing tab', async ({ page }) => {
    await page.goto('/index.html?to=0x2222222222222222222222222222222222222222&amt=1');
    await waitBooted(page);
    await expect(page.locator('#sec-pay')).toHaveClass(/active/);
    await expect(page.locator('#incomingCard')).toBeVisible();
  });

  test('the hero prices a charge from the live gas price', async ({ page }) => {
    // Mock gas is 1 gwei; a charge is ~80k gas on an 18-decimal native token,
    // so a charge is 0.00008 and a year of monthly billing is 0.00096.
    await page.goto('/index.html');
    await waitBooted(page);
    await expect(page.locator('#econCost')).toHaveText('<$0.0001');
    await expect(page.locator('#econYear')).toHaveText('$0.00096');
  });

  test('the merchant stat row stays hidden until there is something to show', async ({ page }) => {
    await page.goto('/index.html');
    await waitBooted(page);
    await expect(page.locator('#subStats')).toBeHidden();
  });

  test('addresses can be copied', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/index.html');
    await waitBooted(page);
    await goTab(page, 'agent');
    await page.evaluate(() => { document.getElementById('kpAddr').textContent = '0xabc'; });
    await page.click('#kpAddr + .copy');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('0xabc');
  });
});
