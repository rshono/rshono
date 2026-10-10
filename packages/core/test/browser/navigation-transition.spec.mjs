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

// The #52 case above suspends on a promise a client component created, which is already resolved by the
// time the destination renders. A streamed server component is the other half: its flight chunk lands
// *after* the payload's shell, so a soft navigation suspends the transition on a `ReactPromise` that only
// resolves mid-stream. If that ping is lost, the transition never retries and the destination URL commits
// with the previous tree (or the skeleton) left on screen.
test('a soft navigation to a streamed AsyncBoundary page commits when its child resolves', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/streamed-boundary-a');
  // A click before hydration would be a full browser load, which exercises nothing here.
  await expect(page.locator('html')).toHaveAttribute('data-streamed-boundary-hydrated', 'true');
  await expect(page.locator('[data-streamed-content="a"]')).toBeVisible();

  // The link alternates A→B→A→B→A, soft each way. Every destination resolves its `AsyncBoundary` child
  // only after the shell has been streamed, so every navigation exercises the suspended-transition retry.
  for (const label of ['b', 'a', 'b', 'a']) {
    await page.getByRole('link', { name: 'next' }).click();
    await expect(page).toHaveURL(`/streamed-boundary-${label}`);
    await expect(page.locator(`[data-streamed-content="${label}"]`)).toBeVisible();
  }

  expect(errors).toEqual([]);
});
