import { expect, test } from '@playwright/test';

/**
 * Marks the current document so a later assertion can tell a *soft* navigation (same document, new
 * payload) from a full browser load, which is the whole distinction these tests exist to check.
 */
async function markDocument(page) {
  await page.evaluate(() => {
    window.__rshonoDocumentId = Math.random().toString(36);
    return window.__rshonoDocumentId;
  });
  return page.evaluate(() => window.__rshonoDocumentId);
}

const documentId = (page) => page.evaluate(() => window.__rshonoDocumentId ?? null);

test.describe('hydration', () => {
  test('a client island hydrates and holds its own state', async ({ page }) => {
    await page.goto('/');
    const counter = page.getByRole('button', { name: /Clicked/ });

    // The server rendered "(hydrating…)"; React swapping it for "(hydrated ✓)" is the proof.
    await expect(page.getByText('(hydrated ✓)')).toBeVisible();
    await counter.click();
    await counter.click();
    await expect(counter).toHaveText(/Clicked 2 times/);
  });
});

test.describe('soft navigation', () => {
  test('a link click swaps the page without reloading the document', async ({ page }) => {
    await page.goto('/');
    const before = await markDocument(page);

    await page.getByRole('link', { name: 'Users', exact: true }).click();

    await expect(page).toHaveURL('/users');
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
    expect(await documentId(page)).toBe(before);
  });

  test('client island state outside the changed subtree survives a navigation', async ({ page }) => {
    await page.goto('/');
    const counter = page.getByRole('button', { name: /Clicked/ });
    await counter.click();
    await expect(counter).toHaveText(/Clicked 1 time/);

    await page.getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL('/docs/getting-started');
    await page.goBack();

    await expect(page).toHaveURL('/');
    // The home page is re-rendered from a fresh payload, so the counter resets — what must *not*
    // happen is a full document load, which is what the marker would catch.
    await expect(page.getByText('(hydrated ✓)')).toBeVisible();
  });

  test('a data-native link opts out and does a real browser load', async ({ page }) => {
    await page.goto('/');
    const before = await markDocument(page);

    await page.getByRole('link', { name: 'Reload home' }).click();
    await page.waitForLoadState('load');

    expect(await documentId(page)).not.toBe(before);
  });

  test('an off-site link is left to the browser', async ({ page }) => {
    await page.goto('/');
    // `exact` matters here: accessible-name matching is substring-based by default, so a loose
    // 'Hono' also matches the "rshono" logo — whose href is "/" — and picks it up first.
    const link = page.getByRole('link', { name: 'Hono', exact: true });
    await expect(link).toHaveAttribute('href', /^https:\/\/hono\.dev/);
  });
});

test.describe('navigation fetching', () => {
  // A link is one fetch at click time and nothing before it. Worth pinning: speculative prefetching
  // is the easiest thing to reintroduce by accident, and it costs bandwidth on every hover.
  test('hovering a link fetches nothing; the click fetches once', async ({ page }) => {
    await page.goto('/');

    const flightRequests = [];
    page.on('request', (request) => {
      if (request.headers()['rsc'] === '1') flightRequests.push(request.url());
    });

    const users = page.getByRole('link', { name: 'Users', exact: true });
    await users.hover();
    await page.waitForTimeout(400); // long enough for any hover-triggered fetch to have started
    expect(flightRequests, 'hover must not speculate').toHaveLength(0);

    await users.click();
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
    expect(flightRequests).toHaveLength(1);
    expect(flightRequests[0]).toContain('/users');
  });

  // React runs async transitions concurrently, so two overlapping navigations are two live fetches with no
  // ordering between them. Nothing about the slow one makes it stale on arrival except the newer one having
  // started — so without a sequence check it repaints the page the user already left, under the URL of the
  // page they asked for. A slow connection and an impatient user is the whole reproduction.
  test('a superseded navigation does not repaint after the one that replaced it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('(hydrated ✓)')).toBeVisible();

    // Holds the first navigation's payload until the second has been asked for and answered.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route('**/users', async (route) => {
      if (route.request().headers()['rsc'] !== '1') return route.fallback();
      await held;
      // The client is expected to have hung up on this by now, which is what makes `continue` throw.
      await route.continue().catch(() => {});
    });

    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page).toHaveURL('/users');

    // The old tree stays interactive through a pending transition, so the nav is still clickable.
    await page.getByRole('link', { name: 'Sign Up', exact: true }).click();
    await expect(page).toHaveURL('/signup');
    await expect(page.getByRole('heading', { name: 'Sign Up' })).toBeVisible();

    release();
    await page.waitForTimeout(400); // long enough for a stale payload to have been applied

    await expect(page).toHaveURL('/signup');
    await expect(page.getByRole('heading', { name: 'Sign Up' })).toBeVisible();
    await expect(page.getByText('Ada Lovelace')).toBeHidden();
  });
});

test.describe('useNavigation', () => {
  test('router.push navigates and the hook reports the new location', async ({ page }) => {
    await page.goto('/profile/1?tab=activity');
    await expect(page.locator('[data-nav="pathname"]')).toHaveText('/profile/1');
    await expect(page.locator('[data-nav="param-id"]')).toHaveText('1');
    await expect(page.locator('[data-nav="query-tab"]')).toHaveText('activity');

    const before = await markDocument(page);
    await page.getByRole('button', { name: "push('/users')" }).click();

    await expect(page).toHaveURL('/users');
    expect(await documentId(page)).toBe(before);
  });

  test('router.refresh re-runs the server components in place', async ({ page }) => {
    await page.goto('/profile/1');
    const before = await markDocument(page);

    await page.getByRole('button', { name: 'refresh()' }).click();

    await expect(page.locator('[data-nav="pathname"]')).toHaveText('/profile/1');
    expect(await documentId(page)).toBe(before);
  });

  // A traversal is the browser's own operation, so `back()` / `forward()` only ask for it and the runtime
  // picks the entry up as a `navigate` event. Two things have to come out of that. The readout is rendered from
  // the payload's `href`, not from `location`, so it only changes if a new payload was fetched and applied —
  // and the document id only survives if that happened in place, without a browser load.
  test('router.back and router.forward traverse history as soft navigations', async ({ page }) => {
    await page.goto('/profile/1');
    await expect(page.locator('[data-nav="query-tab"]')).toHaveText('(none)');
    const before = await markDocument(page);

    await page.getByRole('button', { name: "push('?tab=activity')" }).click();
    await expect(page).toHaveURL('/profile/1?tab=activity');
    await expect(page.locator('[data-nav="query-tab"]')).toHaveText('activity');

    await page.getByRole('button', { name: 'back()' }).click();
    await expect(page).toHaveURL('/profile/1');
    await expect(page.locator('[data-nav="query-tab"]')).toHaveText('(none)');

    await page.getByRole('button', { name: 'forward()' }).click();
    await expect(page).toHaveURL('/profile/1?tab=activity');
    await expect(page.locator('[data-nav="query-tab"]')).toHaveText('activity');

    expect(await documentId(page), 'neither traversal may reload the document').toBe(before);
  });
});

test.describe('server actions', () => {
  test('a client-initiated action mutates and re-renders the server component', async ({ page }) => {
    await page.goto('/users');
    const email = `grace-${Date.now()}@example.com`;

    await page.getByPlaceholder('Grace Hopper').fill('Grace Hopper');
    await page.getByPlaceholder('grace@example.com').fill(email);
    await page.getByRole('button', { name: 'Add user' }).click();

    // The list is a server component: it can only show the new row if the action's fresh payload
    // was applied to the live tree.
    await expect(page.getByText(email)).toBeVisible();
  });

  test('an action answered with something that is not a payload reports the status, not a parser error', async ({ page }) => {
    await page.goto('/users');

    // Stands in for every response the action path can get that is not a flight payload: a `bodyLimit()`
    // 413, a proxy's error page, a 502 mid-deploy. Handed to the flight parser they all surface as
    // "Connection closed.", with the status nowhere in sight.
    await page.route('**/users', async (route, request) => {
      if (request.method() !== 'POST') return route.continue();
      await route.fulfill({ status: 413, contentType: 'text/plain', body: 'Payload Too Large' });
    });

    await page.getByPlaceholder('Grace Hopper').fill('Grace Hopper');
    await page.getByPlaceholder('grace@example.com').fill('grace@example.com');
    await page.getByRole('button', { name: 'Add user' }).click();

    const notice = page.locator('.notice.error');
    await expect(notice).toContainText('413');
    await expect(notice).toContainText('Payload Too Large');
    await expect(notice).not.toContainText('Connection closed');
    // The page is still the page: a failed action must not take the tree down with it.
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
  });

  test('a rejected action surfaces its message instead of tearing down the page', async ({ page }) => {
    await page.goto('/users');

    await page.getByPlaceholder('Grace Hopper').fill('');
    await page.getByPlaceholder('grace@example.com').fill('not-an-email');
    await page.getByRole('button', { name: 'Add user' }).click();

    await expect(page.locator('.notice.error')).toBeVisible();
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
  });
});

test.describe('boundaries', () => {
  test('a failing section renders its fallback while the rest of the page stays up', async ({ page }) => {
    await page.goto('/boundary?fail=1');
    // SSR streams the *loading* fallback; the error fallback is what the boundary swaps in once the
    // payload carrying the failure is applied — so this asserts the client half of the mechanism.
    await expect(page.locator('[data-section="error"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AsyncBoundary' })).toBeVisible();
    await expect(page.locator('[data-rshono-fatal]')).toHaveCount(0, { timeout: 1000 });
  });

  test('the happy path resolves the suspended section', async ({ page }) => {
    await page.goto('/boundary');
    await expect(page.locator('[data-section="ok"]')).toBeVisible();
  });
});

test.describe('scroll and focus on navigation', () => {
  // Scroll is the browser's, through `intercept({ scroll: 'after-transition' })` — but only because the
  // intercept handler resolves at React's commit rather than when the fetch lands. Resolve it early and the
  // browser scrolls a document that has not been replaced yet, which is what these two pin down.
  test('a new navigation starts at the top', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 400 });
    await page.goto('/users');

    await page.evaluate(() => window.scrollTo(0, 300));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);

    await page.getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL('/docs/getting-started');
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: 'a pushed page must not inherit the last one’s offset' }).toBe(0);
  });

  // The other half, and the one the framework used to get wrong: going back has to land where you left.
  // Under the old runtime the offset was restored on `popstate`, before the payload for the entry had even
  // been asked for — against the outgoing page, and then overwritten by the incoming one.
  test('going back restores the offset the page was left at', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 400 });
    await page.goto('/users');

    await page.evaluate(() => window.scrollTo(0, 300));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);

    await page.getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL('/docs/getting-started');
    await page.goBack();

    await expect(page).toHaveURL('/users');
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: 'a traversal must come back to where it left' }).toBeGreaterThan(100);
  });

  // `focusReset: 'after-transition'`, which the hand-rolled router had no equivalent of: without it focus
  // stays on the link that was clicked, the next Tab resumes from the page the user has left, and a screen
  // reader is never told anything happened. The browser only does it once the handler resolves.
  test('a navigation moves focus to the new document', async ({ page }) => {
    await page.goto('/');

    const users = page.getByRole('link', { name: 'Users', exact: true });
    await users.focus();
    await users.click();

    await expect(page).toHaveURL('/users');
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName ?? null), { message: 'focus must not stay on the link that was clicked' })
      .toBe('BODY');
  });

  // A replace is a change of address for the page you are on, not a move to a new one, so both resets are
  // switched off for it — a filter or a tab that rewrites the URL must not throw the reader back to the top.
  test('a replace leaves the scroll offset alone', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 400 });
    await page.goto('/profile/1');

    // Scrolled by Playwright rather than by hand: it brings the button into view before clicking either
    // way, so the offset to compare against is the one that leaves behind.
    const button = page.getByRole('button', { name: "replace('?tab=activity')" });
    await button.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    expect(before, 'the fixture page must be tall enough to scroll').toBeGreaterThan(0);

    await button.click();
    await expect(page).toHaveURL('/profile/1?tab=activity');
    await expect(page.locator('[data-nav="query-tab"]')).toHaveText('activity');
    expect(await page.evaluate(() => window.scrollY), 'a replace must not scroll').toBe(before);
  });
});

test.describe('fragment links', () => {
  /** How far the top of `#id` sits from the top of the viewport. ~0 means the jump landed on it. */
  const headingOffset = (page, id) => page.evaluate((anchor) => document.getElementById(anchor)?.getBoundingClientRect().top ?? null, id);

  test('a same-page anchor is left to the browser — no payload fetch, no reload', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 400 });
    await page.goto('/docs/getting-started');
    const id = await markDocument(page);

    const payloadRequests = [];
    page.on('request', (request) => {
      if (request.headers()['rsc'] === '1') payloadRequests.push(request.url());
    });

    await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Dev server' }).click();

    await expect(page).toHaveURL('/docs/getting-started#dev-server');
    await expect.poll(() => headingOffset(page, 'dev-server')).toBeLessThan(2);
    expect(await documentId(page), 'the document should not have reloaded').toBe(id);
    expect(payloadRequests, 'a same-page anchor needs nothing from the server').toEqual([]);
  });

  // The other kind: the heading is in a page that has not been fetched yet, so landing on it means the
  // scroll waiting for the payload to commit rather than firing when the fetch resolves. Both halves are
  // asserted — the jump, and that getting there was still a soft navigation.
  test('a cross-page anchor soft-navigates and lands on the heading', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 400 });
    await page.goto('/docs/getting-started');
    const id = await markDocument(page);

    await page.getByRole('link', { name: 'Deployment: Targets' }).click();

    await expect(page).toHaveURL('/docs/deployment#targets');
    await expect(page.locator('#targets')).toBeVisible();
    await expect.poll(() => headingOffset(page, 'targets'), { message: 'the cross-page jump must land on the heading' }).toBeLessThan(2);
    expect(await documentId(page), 'it should still be a soft navigation').toBe(id);
  });

  // A fragment that names nothing gets what a browser gives it: the top of the new page, not the offset
  // the outgoing one happened to be scrolled to.
  test('a cross-page anchor with no such heading lands at the top', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 400 });
    await page.goto('/docs/getting-started');

    await page.evaluate(() => window.scrollTo(0, 300));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await page.evaluate(() => document.querySelector('a[href="/docs/deployment#targets"]').setAttribute('href', '/docs/deployment#no-such-heading'));

    await page.getByRole('link', { name: 'Deployment: Targets' }).click();

    await expect(page).toHaveURL('/docs/deployment#no-such-heading');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('back out of an anchor does not re-fetch the page', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 400 });
    await page.goto('/docs/getting-started');

    await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Routes' }).click();
    await expect(page).toHaveURL('/docs/getting-started#routes');

    const payloadRequests = [];
    page.on('request', (request) => {
      if (request.headers()['rsc'] === '1') payloadRequests.push(request.url());
    });

    await page.goBack();
    await expect(page).toHaveURL('/docs/getting-started');
    expect(payloadRequests, 'the document did not change, so nothing needed re-rendering').toEqual([]);
  });
});

test.describe('no blank screens', () => {
  test('a broken bootstrap payload paints the fatal overlay instead of a dead page', async ({ page }) => {
    // Corrupt the inlined flight payload so the client runtime cannot start. Without the overlay
    // this is a silent unhandled rejection and the page just sits there, half-rendered.
    await page.route('**/crash', async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      // `response.text()` has already decoded the body, so the original encoding and length headers
      // would now be describing something that no longer exists — drop them rather than blank them.
      const headers = { ...response.headers() };
      delete headers['content-encoding'];
      delete headers['content-length'];
      await route.fulfill({
        status: response.status(),
        headers,
        contentType: 'text/html; charset=utf-8',
        body: html.replaceAll('self.__FLIGHT_DATA||=[]).push("', 'self.__FLIGHT_DATA||=[]).push("!corrupted!'),
      });
    });

    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto('/crash');

    const overlay = page.locator('[data-rshono-fatal]');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Something went wrong');
    await expect(overlay.getByRole('button', { name: 'Reload page' })).toBeVisible();
    // Production must not put the stack on screen — that is the dev-only branch.
    await expect(overlay).not.toContainText('Component stack:');
    expect(consoleErrors.join('\n')).toContain('the client runtime failed to start');
  });
});

/*
 * The digest path, which nothing in this file used to touch in either direction.
 *
 * A `redirect()` or `notFound()` raised from a boundary that resolves after the page shell has been sent
 * cannot be a 3xx or a 404 — the response is committed as `200 text/html`. The framework's answer is to let
 * React write the signal into the payload as an error row and act on it here, which is code that only ever
 * runs in a browser. `/late-signal` signals 50ms in, long past shell-ready, so both cases are deterministic.
 *
 * Both recoveries are full document loads, and both were being swallowed by the framework's own router: a
 * `navigate` event fires for `location.reload()` and `location.assign()` like any other navigation, and
 * `listenNavigation` intercepts a reload on purpose — that is `router.refresh()`. Intercepted, the escape
 * hatch became a payload fetch rendering into the React root that had just been torn down. So each test
 * below asserts the *destination is on screen*, not merely that the address bar moved: the address bar moved
 * while this was broken.
 */
test.describe('late control signals', () => {
  test('a late redirect() lands on the target page, not just its URL', async ({ page }) => {
    await page.goto('/late-signal');

    await expect(page).toHaveURL('/login');
    // The URL commits before an intercepted handler runs, so it moves whether or not anything rendered.
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
    await expect(page.locator('[data-section="loading"]')).toHaveCount(0, 'the page it left must be gone');
  });

  /*
   * `notFound()` has nowhere to navigate to, so the only recovery is asking for the page again — which works
   * where the lateness was incidental and loops forever where it is structural, because the second response
   * is byte-identical to the first. This page is the structural case, so the reload is spent once and then
   * the client says what happened instead of spinning the tab until the visitor leaves.
   */
  test('a late notFound() reloads once and then paints, instead of looping', async ({ page }) => {
    // Counted as requests rather than `load` events: the reload is triggered from hydration, which can
    // outrun the first document's `load`, and a missed event would read as a reload that never happened.
    let documents = 0;
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documents++;
    });

    await page.goto('/late-signal?signal=notfound');

    const overlay = page.locator('[data-rshono-fatal]');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Page not found');
    // Production must not explain the framework's internals on screen — that is the dev-only branch.
    await expect(overlay).not.toContainText('notFound() was raised');
    // No reload button, unlike the fatal overlay: the reload is spent, and offering it invites the loop by hand.
    await expect(overlay.getByRole('button', { name: 'Reload page' })).toHaveCount(0);

    // The recovery was *spent*, not skipped: the page was asked for twice, and the key that bounds it is
    // what made the second answer terminal rather than a third request.
    expect(documents).toBe(2);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('rshono:late-not-found:')))).toEqual([
      'rshono:late-not-found:/late-signal?signal=notfound',
    ]);

    // And it stays stopped: same document 1.5s later, with the panel still on it.
    const settled = await markDocument(page);
    await page.waitForTimeout(1500);
    expect(await documentId(page)).toBe(settled);
    expect(documents).toBe(2);
    await expect(overlay).toBeVisible();
  });
});
