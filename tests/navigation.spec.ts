import { test, expect, chromium } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { resolve } from 'node:path';

let context: BrowserContext;
let worker: Worker;
const origin = 'http://127.0.0.1:4179';

test.beforeEach(async () => {
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
});
test.afterEach(async () => { await context?.close(); });

// CDP can inspect a closed shadow root without weakening production isolation.
async function ui<T>(page: Page, fn: (root: ShadowRoot) => T): Promise<T> {
  const cdp = await context.newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    function find(node: any): any {
      if (node.attributes?.includes('pinokio-root')) return node.shadowRoots?.[0];
      for (const child of node.children || []) { const found = find(child); if (found) return found; }
    }
    const shadow = find(root);
    if (!shadow) throw new Error('Overlay is missing');
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId });
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() { return (${fn.toString()})(this); }`,
      returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  } finally { await cdp.detach(); }
}

async function seed(mode: string) {
  await worker.evaluate(async ({ origin, mode }) => {
    const comments = ['a', 'b'].map((repo, index) => ({
      // Legacy comments use createdAt as their ID; keep them working too.
      selector: '#about', textContentFallback: { tagName: 'div', text: 'About', index: 0 },
      url: `${origin}/${mode}/${repo}`, comment: `Note ${repo.toUpperCase()}`,
      createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    }));
    await chrome.storage.local.set({ [origin]: comments });
  }, { origin, mode });
}

async function activate(page: Page) {
  await expect(page.locator('main')).toBeVisible();
  await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:4179/*' });
    await chrome.tabs.sendMessage(tabs[0].id!, { type: 'TOGGLE_INSPECT_MODE' });
  });
  await expect(page.locator('#pinokio-root')).toHaveCount(1);
}

async function select(page: Page, note: 'A' | 'B') {
  if (!await ui(page, root => (root.querySelector('.comments-island') as HTMLElement).style.display === 'block')) {
    await ui(page, root => (root.querySelector('[title="Show comments"]') as HTMLElement).click());
  }
  await expect.poll(() => ui(page, root => root.querySelectorAll('.island-comment-content').length)).toBe(2);
  if (note === 'A') await ui(page, root => (root.querySelectorAll('.island-comment-content')[0] as HTMLElement).click());
  else await ui(page, root => (root.querySelectorAll('.island-comment-content')[1] as HTMLElement).click());
  await expect.poll(() => ui(page, root => {
    const card = root.querySelector('.comment-display') as HTMLElement;
    return card.style.display === 'block' ? card.textContent : '';
  }).catch(() => ''), { timeout: 15000 }).toBe(`Note ${note}`);
}

test('repeated A/B routes survive shared headers, identical targets, live updates and root removal', async () => {
  await seed('spa');
  const page = await context.newPage();
  await page.goto(`${origin}/spa/b`);
  await activate(page);
  for (const note of ['A', 'B', 'A', 'B', 'A'] as const) {
    await select(page, note);
    await expect(page.locator('main h2')).toHaveText(`Repository ${note}`);
    await expect(page.locator('#pinokio-root')).toHaveCount(1);
    await expect.poll(() => ui(page, root => (root.querySelector('.comment-display') as HTMLElement).style.display)).toBe('block');
  }
});

test('full document navigation restores activation and pending comments even when page clears sessionStorage', async () => {
  await seed('mpa');
  const page = await context.newPage();
  await page.goto(`${origin}/mpa/b`);
  await activate(page);
  for (const note of ['A', 'B', 'A'] as const) await select(page, note);
});

test('comment and flash follow scrolling and close when the element leaves the viewport', async () => {
  await seed('spa');
  const page = await context.newPage();
  await page.goto(`${origin}/spa/a`);
  await activate(page);
  await select(page, 'A');
  await page.evaluate(() => scrollBy(0, 100));
  await expect.poll(() => ui(page, root => {
    const flash = [...root.children].find(el => (el as HTMLElement).style.border.includes('2px solid')) as HTMLElement;
    return flash ? Math.abs(flash.getBoundingClientRect().top - document.querySelector('#about')!.getBoundingClientRect().top) : 0;
  })).toBeLessThan(2);
  await page.evaluate(() => scrollTo(0, 2000));
  await expect.poll(() => ui(page, root => (root.querySelector('.comment-display') as HTMLElement).style.display)).toBe('none');
});

test('disabling the overlay prevents automatic reattachment', async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/spa/a`);
  await activate(page);
  await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:4179/*' });
    await chrome.tabs.sendMessage(tabs[0].id!, { type: 'TOGGLE_INSPECT_MODE' });
  });
  await page.locator('a').last().click();
  await expect(page.locator('main h2')).toHaveText('Repository B');
  await expect(page.locator('#pinokio-root')).toHaveCount(0);
});

test('saved tab hints reveal delayed content without guessing unrelated navbar actions', async () => {
  await seed('tabs');
  await worker.evaluate(async origin => {
    const result = await chrome.storage.local.get(origin);
    const comments = result[origin] as any[];
    comments[0].activeNavLabel = 'Details';
    await chrome.storage.local.set({ [origin]: comments });
  }, origin);
  const page = await context.newPage();
  await page.goto(`${origin}/tabs/a`);
  await activate(page);
  await select(page, 'A');
  await expect(page.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
});

test('saving and deleting a local comment persists through the service worker', async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/spa/a`);
  await activate(page);
  await ui(page, root => ([...root.querySelectorAll('button')].find(button => button.textContent === 'Edit Mode')!).click());
  await page.locator('#about').click();
  await ui(page, root => {
    (root.querySelector('textarea') as HTMLTextAreaElement).value = 'Saved from the UI';
    (root.querySelector('.btn-primary') as HTMLElement).click();
  });
  await expect.poll(() => worker.evaluate(async origin => {
    const result = await chrome.storage.local.get(origin);
    return (result[origin] as any[])?.[0]?.comment;
  }, origin)).toBe('Saved from the UI');
  await ui(page, root => (root.querySelector('[title="Show comments"]') as HTMLElement).click());
  await expect.poll(() => ui(page, root => root.querySelectorAll('.delete-btn').length)).toBe(1);
  await ui(page, root => (root.querySelector('.delete-btn') as HTMLElement).click());
  await ui(page, root => (root.querySelector('.btn-danger') as HTMLElement).click());
  await expect.poll(() => worker.evaluate(async origin => {
    const result = await chrome.storage.local.get(origin);
    return (result[origin] as any[])?.length;
  }, origin)).toBe(0);
});

test('a newer selection cancels the previous route wait', async () => {
  await seed('spa');
  const page = await context.newPage();
  await page.goto(`${origin}/spa/b`);
  await activate(page);
  await ui(page, root => (root.querySelector('[title="Show comments"]') as HTMLElement).click());
  await expect.poll(() => ui(page, root => root.querySelectorAll('.island-comment-content').length)).toBe(2);
  await ui(page, root => (root.querySelectorAll('.island-comment-content')[0] as HTMLElement).click());
  await expect(page).toHaveURL(`${origin}/spa/a`);
  await select(page, 'B');
  await expect(page.locator('main h2')).toHaveText('Repository B');
  await expect.poll(() => ui(page, root => root.querySelector('.comment-display')!.textContent)).toBe('Note B');
});
