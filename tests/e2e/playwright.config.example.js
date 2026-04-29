// Exemple à copier en `app/playwright.config.js` après installation de
// @playwright/test. Adapter les chemins selon votre structure.
//
// const { defineConfig, devices } = require('@playwright/test');
//
// module.exports = defineConfig({
//   testDir: '../tests/e2e/sav',
//   timeout: 30_000,
//   fullyParallel: false, // séquentiel : on partage la même base de données
//   reporter: [['list'], ['html', { open: 'never' }]],
//   use: {
//     baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
//     trace: 'retain-on-failure',
//     screenshot: 'only-on-failure',
//     video: 'retain-on-failure',
//   },
//   projects: [
//     { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
//     { name: 'tablet',  use: { ...devices['iPad Pro'] } },
//     { name: 'mobile',  use: { ...devices['iPhone 14 Pro'] } },
//   ],
// });
