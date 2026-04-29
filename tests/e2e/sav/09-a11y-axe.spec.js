// @ts-check
// Audit axe-core sur les pages SAV publiques + admin.

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

test.describe('A11y axe-core', () => {
  test('/sav (wizard) — aucune violation critique', async ({ page }) => {
    await page.goto('/sav');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const critical = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(critical).toEqual([]);
  });

  test('/sav/feedback/SAV-AAAA-9999 — aucune violation critique', async ({ page }) => {
    await page.goto('/sav/feedback/SAV-AAAA-9999');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const critical = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(critical).toEqual([]);
  });
});
