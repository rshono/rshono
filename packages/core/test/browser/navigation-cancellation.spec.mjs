import { expect, test } from '@playwright/test';

test('a prevented browser navigation cancels an unapplied fetch and clears pending', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (input instanceof Request && new URL(input.url).pathname === '/users' && input.headers.get('rsc') === '1') {
        window.__auditHeldFetch = true;
        window.__auditFetchCount = (window.__auditFetchCount ?? 0) + 1;
        return new Promise((_resolve, reject) => {
          const cancel = () => {
            window.__auditFetchAborted = true;
            reject(input.signal.reason);
          };
          if (input.signal.aborted) cancel();
          else input.signal.addEventListener('abort', cancel, { once: true });
        });
      }
      return original(input, init);
    };
  });
  await page.goto('/profile/1');
  await expect(page.locator('[data-nav="pending"]')).toHaveText('no');
  await page.evaluate(() => {
    const result = navigation.navigate('/users');
    void Promise.allSettled([result.committed, result.finished]);
  });
  await expect.poll(() => page.evaluate(() => window.__auditHeldFetch)).toBe(true);
  await expect(page.locator('[data-nav="pending"]')).toHaveText('yes');
  await page.evaluate(async () => {
    navigation.addEventListener('navigate', (event) => event.preventDefault(), { once: true });
    const result = navigation.navigate('#cancelled');
    await Promise.allSettled([result.committed, result.finished]);
  });
  await expect.poll(() => page.evaluate(() => window.__auditFetchAborted)).toBe(true);
  expect(await page.evaluate(() => window.__auditFetchCount)).toBe(1);
  await expect(page.locator('[data-nav="pending"]')).toHaveText('no');
  await expect(page.getByRole('heading', { name: /Ada Lovelace/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Back during an unapplied Docs request keeps the home island hydrated', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (input instanceof Request && new URL(input.url).pathname === '/docs/getting-started' && input.headers.get('rsc') === '1') {
        window.__auditDocsRequested = true;
        return new Promise((_resolve, reject) => {
          const cancel = () => {
            window.__auditDocsAborted = true;
            reject(input.signal.reason);
          };
          if (input.signal.aborted) cancel();
          else input.signal.addEventListener('abort', cancel, { once: true });
        });
      }
      return original(input, init);
    };
  });
  await page.goto('/');
  await expect(page.getByText('(hydrated ✓)')).toBeVisible();
  const marker = await page.evaluate(() => (window.__auditDocument = crypto.randomUUID()));
  // A prepared push does not commit a history entry while it waits, so Back has somewhere to land only if
  // the home page is the entry before the one the Docs navigation starts from.
  await page.getByRole('link', { name: '/users', exact: true }).click();
  await expect(page).toHaveURL('/users');
  await page.evaluate(() => {
    const result = navigation.navigate('/docs/getting-started');
    void Promise.allSettled([result.committed, result.finished]);
  });
  await expect.poll(() => page.evaluate(() => window.__auditDocsRequested)).toBe(true);
  // The URL stays on the page being left until the held payload arrives; the Back below supersedes it.
  await expect(page).toHaveURL('/users');
  await page.goBack();
  await expect(page).toHaveURL('/');
  await expect.poll(() => page.evaluate(() => window.__auditDocsAborted)).toBe(true);
  await expect(page.getByText('(hydrated ✓)')).toBeVisible();
  expect(await page.evaluate(() => window.__auditDocument)).toBe(marker);
  expect(errors).toEqual([]);
});
