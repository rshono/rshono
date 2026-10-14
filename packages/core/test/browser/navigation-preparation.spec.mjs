import { expect, test } from '@playwright/test';

async function startNativeNavigation(page, method, href) {
  await page.evaluate(
    ({ method, href }) => {
      window.__preparationResult = { state: 'waiting' };
      const result = navigation.navigate(href, { history: method });
      void result.committed.catch(() => {});
      void result.finished.then(
        () => {
          window.__preparationResult = { state: 'resolved', kind: 'rendered', url: location.href };
        },
        (error) => {
          window.__preparationResult = { state: 'rejected', name: error.name };
        },
      );
    },
    { method, href },
  );
}
async function navigationResult(page) {
  return page.evaluate(() => window.__preparationResult);
}

for (const method of ['push', 'replace']) {
  test(`precommit ${method} holds the URL and reports pending before the root arrives`, async ({ page }) => {
    await page.goto('/profile/1');
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requestSeen;
    const seen = new Promise((resolve) => {
      requestSeen = resolve;
    });
    let requests = 0;
    await page.route('**/profile/1?tab=activity', async (route) => {
      if (route.request().headers()['rsc'] !== '1') return route.fallback();
      requests++;
      requestSeen();
      await held;
      await route.continue();
    });
    try {
      await startNativeNavigation(page, method, '?tab=activity');
      await seen;
      await expect(page.locator('[data-nav="pending"]')).toHaveText('yes');
      expect(new URL(page.url()).search).toBe('');
      expect(await navigationResult(page).then((result) => result.state)).toBe('waiting');
    } finally {
      release?.();
    }
    await expect.poll(() => navigationResult(page).then((result) => result.state)).toBe('resolved');
    await expect(page.locator('[data-nav="query-tab"]')).toHaveText('activity');
    await expect(page.locator('[data-nav="pending"]')).toHaveText('no');
    expect(requests).toBe(1);
  });
}

test('a failed precommit lands on the server’s answer as a document load', async ({ page }) => {
  await page.goto('/profile/1');
  const documents = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      const url = new URL(request.url());
      documents.push(url.pathname + url.search);
    }
  });
  await page.route('**/profile/1?tab=activity', (route) => {
    if (route.request().headers()['rsc'] === '1') {
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><h1>Document fallback</h1></body></html>',
    });
  });

  await startNativeNavigation(page, 'push', '?tab=activity');

  // The payload cannot commit in place, so the runtime asks the browser for the destination document: the
  // failure reaches the visitor as the server's answer instead of a silent no-op.
  await expect(page.getByRole('heading', { name: 'Document fallback' })).toBeVisible();
  expect(documents).toEqual(['/profile/1?tab=activity']);
});

test('without precommit support the URL commits before the payload, as before', async ({ page }) => {
  // The runtime feature-detects the interface; removing it is the only way to drive the fallback path.
  await page.addInitScript(() => {
    delete window.NavigationPrecommitController;
  });
  await page.goto('/profile/1');
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let requestSeen;
  const seen = new Promise((resolve) => (requestSeen = resolve));
  await page.route('**/profile/1?tab=activity', async (route) => {
    if (route.request().headers()['rsc'] !== '1') return route.fallback();
    requestSeen();
    await held;
    await route.continue();
  });
  try {
    await startNativeNavigation(page, 'push', '?tab=activity');
    await seen;
    // No precommit handler: the browser commits the URL as it always did, and the previous tree stays on
    // screen until the payload arrives.
    await expect(page).toHaveURL('/profile/1?tab=activity');
    await expect(page.locator('[data-nav="pending"]')).toHaveText('yes');
  } finally {
    release?.();
  }
  await expect(page.locator('[data-nav="query-tab"]')).toHaveText('activity');
  await expect(page.locator('[data-nav="pending"]')).toHaveText('no');
});

test('precommit commits the shell without waiting for the streamed child', async ({ page }) => {
  await page.goto('/profile/1');
  await startNativeNavigation(page, 'push', '/anchor-stream#depth-target');
  await expect.poll(() => navigationResult(page).then((result) => result.state)).toBe('resolved');
  await expect(page).toHaveURL('/anchor-stream#depth-target');
  await expect(page.locator('[data-anchor-loading]')).toBeVisible();
  await expect(page.locator('#depth-target')).toHaveCount(0);
  await expect(page.locator('#depth-target')).toBeVisible();
});

test('native navigation finishes only after a prepared payload commits', async ({ page }) => {
  await page.goto('/navigation-async-boundary');
  await expect(page.locator('html')).toHaveAttribute('data-navigation-repro-hydrated', 'true');
  await page.evaluate(() => {
    // The testbed button creates the client resource before calling router.push; capture its native result.
    window.__nativeSuccess = 'waiting';
    navigation.addEventListener('navigatesuccess', () => (window.__nativeSuccess = 'fired'), { once: true });
    const navigate = navigation.navigate.bind(navigation);
    navigation.navigate = (...args) => {
      const result = navigate(...args);
      window.__nativeFinished = 'waiting';
      void result.finished.then(
        () => (window.__nativeFinished = 'resolved'),
        () => (window.__nativeFinished = 'rejected'),
      );
      return result;
    };
  });

  await page.getByRole('button', { name: 'Navigate', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-activity-render-attempted', 'true');
  await expect(page.getByText('pending: true', { exact: true })).toBeVisible();
  await expect(page.getByText('Initial content', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__nativeFinished)).toBe('waiting');
  expect(await page.evaluate(() => window.__nativeSuccess)).toBe('waiting');

  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByText('Activity content', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__nativeFinished)).toBe('resolved');
  await expect.poll(() => page.evaluate(() => window.__nativeSuccess)).toBe('fired');
});

test('automatic preparation marks the router pending while an additional browser gate is held', async ({ page }) => {
  await page.goto('/profile/1');
  await expect(page.locator('[data-nav="pending"]')).toHaveText('no');
  const probe = await page.evaluate(async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const enteredGate = new Promise((resolve) => {
      entered = resolve;
    });
    const listener = (event) => {
      event.intercept({
        precommitHandler: async () => {
          entered();
          await gate;
        },
      });
    };
    navigation.addEventListener('navigate', listener, { once: true });
    const result = navigation.navigate('?tab=activity');
    await enteredGate;
    // The browser may start the two precommit handlers on different frames.
    const pending = () => document.querySelector('[data-nav="pending"]')?.textContent;
    const deadline = performance.now() + 2000;
    while (pending() !== 'yes' && performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
    }
    const held = { url: location.search, pending: document.querySelector('[data-nav="pending"]')?.textContent };
    release();
    await result.finished;
    return held;
  });
  expect(probe).toEqual({ url: '', pending: 'yes' });
  await expect(page.locator('[data-nav="query-tab"]')).toHaveText('activity');
});

test('precommit resolves a same-origin payload redirect into one history entry', async ({ page }) => {
  await page.goto('/profile/1');
  await page.route('**/audit-redirect', (route) => {
    if (route.request().headers()['rsc'] !== '1') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'text/x-component',
      body: `0:${JSON.stringify({ root: null, redirect: '/users' })}\n`,
    });
  });
  const before = await page.evaluate(() => history.length);

  await startNativeNavigation(page, 'push', '/audit-redirect');

  await expect.poll(() => navigationResult(page).then((result) => result.state)).toBe('resolved');
  await expect(page).toHaveURL('/users');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  // The stub URL never became an entry: the push added exactly one, and it is the redirect's target.
  expect(await page.evaluate(() => history.length)).toBe(before + 1);

  // Back returns to the page that started the navigation, not to a URL that redirects again.
  await page.goBack();
  await expect(page).toHaveURL('/profile/1');
  await expect(page.getByRole('heading', { name: /Ada Lovelace/ })).toBeVisible();
});

test('a cross-origin payload redirect becomes a real document load', async ({ page }) => {
  await page.goto('/profile/1');
  await page.route('**/audit-external', (route) => {
    if (route.request().headers()['rsc'] !== '1') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'text/x-component',
      body: `0:${JSON.stringify({ root: null, redirect: 'https://example.com/elsewhere' })}\n`,
    });
  });
  await page.route('https://example.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><h1>Elsewhere</h1></body></html>',
    }),
  );

  await startNativeNavigation(page, 'push', '/audit-external');

  // `controller.redirect` cannot leave the origin, so the browser performs the redirect as a real load; the
  // navigation ends on the target rather than aborting in place.
  await expect(page.getByRole('heading', { name: 'Elsewhere' })).toBeVisible();
  expect(new URL(page.url()).origin).toBe('https://example.com');
});

for (const target of ['javascript:alert(1)', 'data:text/html,unsafe']) {
  test(`precommit refuses a ${target.split(':')[0]}: redirect without leaving the page`, async ({ page }) => {
    await page.goto('/profile/1');
    await page.route('**/audit-unsafe', (route) => {
      if (route.request().headers()['rsc'] !== '1') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'text/x-component',
        body: `0:${JSON.stringify({ root: null, redirect: target })}\n`,
      });
    });

    await startNativeNavigation(page, 'push', '/audit-unsafe');

    // The fallback document navigation is refused by the browser, so the navigation fails where it is.
    await expect.poll(() => navigationResult(page).then((result) => result.state)).toBe('rejected');
    await expect(page).toHaveURL('/profile/1');
    await expect(page.locator('[data-nav="pending"]')).toHaveText('no');
    await expect(page.getByRole('heading', { name: /Ada Lovelace/ })).toBeVisible();
  });
}

test('a same-origin redirect loop falls back to a real document load', async ({ page }) => {
  await page.goto('/profile/1');
  await page.route('**/audit-loop', (route) => {
    if (route.request().headers()['rsc'] !== '1') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'text/x-component',
      body: `0:${JSON.stringify({ root: null, redirect: '/audit-loop' })}\n`,
    });
  });

  await startNativeNavigation(page, 'push', '/audit-loop');

  // The loop cannot commit, so the browser loads the URL for real and the app's notFound page answers.
  await expect(page).toHaveURL('/audit-loop');
  await expect(page.getByRole('heading', { name: '404 — nothing here' })).toBeVisible();
});
