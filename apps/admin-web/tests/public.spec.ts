import { test, expect } from '@playwright/test';

test.describe('preserved public journeys', () => {
  const pages = ['/', '/team.html', '/event-walkathon.html', '/event-plantation-drive.html', '/event-blood-donation.html', '/event-cleanliness-drive.html', '/event-nukkad-natak.html', '/event-sports-cricket.html', '/event-sports-football.html', '/calendar.html', '/archives.html'];

  for (const page of pages) {
    test(`loads ${page} without a document error`, async ({ page: browserPage }) => {
      const response = await browserPage.goto(page, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBeLessThan(400);
      await expect(browserPage.locator('body')).toBeVisible();
    });
  }
});

test('management app exposes the sign-in form', async ({ page }) => {
  await page.goto(`${process.env.MANAGE_TEST_URL || 'http://localhost:5173'}/manage/login`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByLabel('Institutional email')).toBeVisible();
});
