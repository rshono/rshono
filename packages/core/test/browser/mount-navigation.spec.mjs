import { expect, test } from '@playwright/test';

for (const method of ['replace', 'push']) {
  test(`router.${method} from a mount effect navigates without loading a new document`, async ({ page }) => {
    const documents = [];
    const payloads = [];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
      if (request.headers()['rsc'] === '1') payloads.push(request.url());
    });
    // Installed before hydration: a mount-time redirect may finish before page.goto returns, so the
    // first document's identity must survive outside the window being checked at the destination.
    await page.addInitScript(() => {
      window.__rshonoDocumentId = crypto.randomUUID();
      if (!sessionStorage.getItem('mount-navigation:first-document')) {
        sessionStorage.setItem('mount-navigation:first-document', window.__rshonoDocumentId);
      }
    });

    await page.goto(`/mount-navigation?method=${method}`);
    await expect(page).toHaveURL('/users');
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();

    expect(await page.evaluate(() => window.__rshonoDocumentId)).toBe(
      await page.evaluate(() => sessionStorage.getItem('mount-navigation:first-document')),
    );
    expect(documents.map((url) => new URL(url).pathname)).toEqual(['/mount-navigation']);
    expect(payloads.map((url) => new URL(url).pathname)).toEqual(['/users']);
    expect(errors).toEqual([]);
  });
}

test('a mount-effect navigation stays pending while its payload is in flight', async ({ page }) => {
  let heldRequests = 0;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/users', async (route) => {
    if (route.request().headers()['rsc'] !== '1') return route.fallback();
    heldRequests++;
    await held;
    await route.continue();
  });

  try {
    await page.goto('/mount-navigation');
    await expect(page).toHaveURL('/users');
    await expect.poll(() => heldRequests).toBe(1);
    // The source remains mounted until the explicitly held payload is released. URL commit alone
    // does not show the destination or prove that BrowserRoot's transition runner was installed.
    await expect(page.getByText('pending: true', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeHidden();
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
});
