import { expect, test } from '@playwright/test';

test('navigation retains revealed Suspense content and pending until the destination is ready', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/navigation-suspense');
  await expect(page.locator('html')).toHaveAttribute('data-navigation-repro-hydrated', 'true');
  await expect(page.getByText('Initial content', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.__rshonoDocumentId = 'navigation-suspense';
  });

  const received = page.waitForResponse(
    (response) => response.request().headers()['rsc'] === '1' && response.url().endsWith('/navigation-suspense?tab=activity'),
  );
  await page.getByRole('button', { name: 'Navigate', exact: true }).click();
  await expect(page).toHaveURL('/navigation-suspense?tab=activity');
  expect(await (await received).finished()).toBeNull();

  // Wait for the destination to actually attempt rendering the unresolved resource. The response
  // finishing alone does not prove React processed it, and a fixed delay could miss a slow render.
  await expect(page.locator('html')).toHaveAttribute('data-activity-render-attempted', 'true');
  await expect(page.getByText('Initial content', { exact: true })).toBeVisible();
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden();
  await expect(page.getByText('pending: true', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByText('Activity content', { exact: true })).toBeVisible();
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden();
  await expect(page.getByText('pending: false', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__rshonoDocumentId)).toBe('navigation-suspense');
  expect(errors).toEqual([]);
});
