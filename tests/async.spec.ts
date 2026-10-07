import { test, expect } from '@playwright/test';
import { waitFor, samePage } from '../src/core/async';

test('continuous activity cannot extend the absolute deadline', async () => {
  const start = performance.now();
  const result = await waitFor(() => ({}), { timeout: 200, stableFor: 100 });
  expect(result).toBeNull();
  expect(performance.now() - start).toBeLessThan(600);
});

test('cancellation stops readiness work immediately', async () => {
  const controller = new AbortController();
  let reads = 0;
  const result = waitFor(() => { reads++; return null; }, { timeout: 10000, signal: controller.signal });
  controller.abort();
  expect(await result).toBeNull();
  const count = reads;
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(reads).toBe(count);
});

test('hash routes and search parameters identify distinct pages', () => {
  expect(samePage('https://example.com/#/a', 'https://example.com/#/b')).toBe(false);
  expect(samePage('https://example.com/?repo=a', 'https://example.com/?repo=b')).toBe(false);
  expect(samePage('https://example.com/a', 'https://example.com/a')).toBe(true);
});
