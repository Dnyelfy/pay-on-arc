// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted } = require('./harness');

test.describe('page boot', () => {
  test('loads, boots, and reports the active network', async ({ page }) => {
    const errors = await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);

    await expect(page.locator('#netPill')).toHaveText('Arc Testnet');
    await expect(page.locator('#footNet')).toHaveText('Arc Testnet');
    expect(errors, 'console must be clean on load').toEqual([]);
  });

  test('the pinned CDN bundle satisfies the SRI hash in index.html', async ({ page }) => {
    // stubEthersCdn serves the exact bytes the integrity attribute was built
    // from; if the hash in the HTML ever drifts, the browser blocks the script
    // and boot never completes.
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);
    expect(await page.evaluate(() => typeof window.ethers)).toBe('object');
  });

  test('falls back to the vendored bundle when the CDN is unreachable', async ({ page }) => {
    await setup(page, { cdnFails: true });
    await page.goto('/index.html');
    await waitBooted(page);
    expect(await page.evaluate(() => typeof window.ethers)).toBe('object');
    await expect(page.locator('#netPill')).toHaveText('Arc Testnet');
  });

  test('config-driven markup is filled in from the network profile', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);

    await expect(page.locator('#ccReceiver')).toHaveValue('0x8D77a145a238Aa36f2b20027b353cF1E981B569F');
    await expect(page.locator('#ccLaneSrc')).toHaveText('Arc Testnet');
    await expect(page.locator('#ccLane')).toHaveText('Ethereum Sepolia');
    expect(await page.locator('#cLink').getAttribute('href'))
      .toBe('https://testnet.arcscan.app/address/0xa0185d00ECAE1263282996A4B132949b0aee47E4');
    expect(await page.locator('#tAgentLink').getAttribute('href'))
      .toContain('0xC99f4c415C7d9e2bafDC04C43500131fDb43eA53');
  });

  test('every tab reveals exactly one section', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);

    const tabs = page.locator('.tab-btn');
    const count = await tabs.count();
    expect(count).toBe(8);
    for (let i = 0; i < count; i++) {
      await tabs.nth(i).click();
      await expect(page.locator('.section.active')).toHaveCount(1);
      await expect(page.locator('.tab-btn.active')).toHaveCount(1);
    }
  });

  test('the gas pill picks up the live gas price', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);
    await expect(page.locator('#gasPill')).toHaveText('⛽ 1.00 gwei');
  });

  test('every labelled input is programmatically associated with its label', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);

    const orphans = await page.evaluate(() =>
      [...document.querySelectorAll('label')]
        .filter(l => !l.htmlFor && !l.id && !l.querySelector('input,textarea,select'))
        .map(l => l.textContent.trim()));
    expect(orphans).toEqual([]);
  });
});
