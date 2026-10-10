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

// Two routes whose serialized client trees have the same shape reconcile into the same `Suspense`
// boundary, so a transition that suspends on the incoming route's data keeps the outgoing route's
// revealed children instead of showing the incoming `loading` fallback. `AsyncBoundary` is keyed by
// pathname so a navigation mounts the incoming route's boundary, and a freshly mounted boundary shows
// its fallback while its child streams.
test('a soft navigation shows the incoming AsyncBoundary fallback rather than the outgoing content', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/streamed-boundary-a');
  await expect(page.locator('html')).toHaveAttribute('data-streamed-boundary-hydrated', 'true');
  await expect(page.locator('[data-streamed-content="a"]')).toBeVisible();

  await page.getByRole('link', { name: 'next' }).click();
  await expect(page).toHaveURL('/streamed-boundary-b');
  await expect(page.locator('[data-streamed-loading="b"]')).toBeVisible();
  await expect(page.locator('[data-streamed-content="a"]')).toBeHidden();
  await expect(page.locator('[data-streamed-content="b"]')).toBeVisible();
  await expect(page.locator('[data-streamed-loading="b"]')).toBeHidden();

  expect(errors).toEqual([]);
});

// Navigating away while the incoming page's `AsyncBoundary` is still streaming used to abort the payload
// React was suspended on: the abort rejected the pending flight chunk, the boundary rendered it as a failure,
// and a caught abort could unwind the root into React's minified #310 ("Rendered more hooks…"). The fetch is
// now left alone until a payload commits, so the rejection has no tree to land in.
test('navigating away from a loading AsyncBoundary surfaces no abort', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/streamed-boundary-a');
  await expect(page.locator('html')).toHaveAttribute('data-streamed-boundary-hydrated', 'true');
  await expect(page.locator('[data-streamed-content="a"]')).toBeVisible();

  // Into B, and back out while B's section is still pending. The fallback proves B's shell committed and its
  // boundary is mounted — the state React is holding the streamed chunk against — before the second click.
  await page.getByRole('link', { name: 'next' }).click();
  await expect(page).toHaveURL('/streamed-boundary-b');
  await expect(page.locator('[data-streamed-loading="b"]')).toBeVisible();
  await page.getByRole('link', { name: 'next' }).click();

  await expect(page).toHaveURL('/streamed-boundary-a');
  await expect(page.locator('[data-streamed-content="a"]')).toBeVisible();
  await expect(page.locator('[data-streamed-error="b"]')).toBeHidden();

  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((text) => /abort/i.test(text))).toEqual([]);
});

// A newer navigation supersedes this one before its shell lands. Its payload has not reached React either, so
// the fetch is stopped as the replacement starts rather than at the replacement's commit — otherwise two
// five-second server renders would run for one screen.
test('a newer navigation stops a superseded payload fetch before its replacement commits', async ({ page }) => {
  await page.goto('/slow-shell-source');
  await expect(page.locator('html')).toHaveAttribute('data-slow-shell-source-hydrated', 'true');

  const isSlowPayload = (request) => request.headers()['rsc'] === '1' && new URL(request.url()).pathname === '/slow-shell';
  const first = page.waitForRequest(isSlowPayload);
  // Bounded well below the 5 s shell: without the early stop the superseded fetch survives until the second
  // navigation commits, and this times out instead of passing once the payload eventually lands.
  const firstFailed = page.waitForEvent('requestfailed', { predicate: isSlowPayload, timeout: 4000 });
  await page.getByRole('link', { name: 'slow' }).click();
  await first;

  // The URL has committed but the shell has not, so a navigation to another URL of the same slow page
  // supersedes the first while its payload is still unapplied.
  await page.getByRole('link', { name: 'again' }).click();

  expect((await firstFailed).failure()?.errorText).toContain('ERR_ABORTED');
});

// The tests above leave the fetch running when React is reading its stream. A payload that never reached
// React has no reader, so it has to stop the moment the navigation is cancelled — even when nothing replaces
// it. A same-page anchor does that without the runtime intercepting anything: the browser cancels the
// in-flight navigation, and no later commit will ever run to abort the fetch. Without the early stop, the
// slow server render runs to completion unseen.
test('a fragment navigation cancels a payload fetch whose payload never reached React', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/slow-shell-source');
  await expect(page.locator('html')).toHaveAttribute('data-slow-shell-source-hydrated', 'true');

  const isSlowPayload = (request) => request.headers()['rsc'] === '1' && new URL(request.url()).pathname === '/slow-shell';
  const started = page.waitForRequest(isSlowPayload);
  // Armed before the cancel, and bounded well below the 5 s shell: without the abort this times out instead
  // of passing once the payload eventually lands.
  const failed = page.waitForEvent('requestfailed', { predicate: isSlowPayload, timeout: 4000 });
  await page.getByRole('link', { name: 'slow' }).click();
  await started;

  // The fetch is on the wire and React has not been handed its payload, so the same-page anchor cancels the
  // navigation before the slow shell can arrive.
  await page.getByRole('link', { name: 'anchor' }).click();
  await expect(page).toHaveURL(/#anchor$/);

  expect((await failed).failure()?.errorText).toContain('ERR_ABORTED');
  await expect(page.locator('[data-slow-shell]')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
