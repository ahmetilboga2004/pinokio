/** Text and URLs from pages or other team members must never become markup. */
export function escapeHTML(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

export function imageURL(_value: unknown): string {
  // Team members control profile data; loading their URLs would let them track
  // every teammate's IP address and browsing activity.
  return 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2236%22 height=%2236%22 viewBox=%220 0 36 36%22%3E%3Crect width=%2236%22 height=%2236%22 rx=%2218%22 fill=%22%23252324%22/%3E%3Ccircle cx=%2218%22 cy=%2213%22 r=%226%22 fill=%22%23c7c2c0%22/%3E%3Cpath d=%22M6 33c1-8 6-12 12-12s11 4 12 12%22 fill=%22%23c7c2c0%22/%3E%3C/svg%3E';
}

export function visibleRect(element: HTMLElement): DOMRect | null {
  if (!element.isConnected || !element.getClientRects().length) return null;
  const style = getComputedStyle(element);
  if (style.visibility === 'hidden' || style.display === 'none') return null;
  const rect = element.getBoundingClientRect();
  let top = Math.max(0, rect.top), left = Math.max(0, rect.left);
  let bottom = Math.min(innerHeight, rect.bottom), right = Math.min(innerWidth, rect.right);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
      left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
    }
  }
  return bottom > top && right > left ? new DOMRect(left, top, right - left, bottom - top) : null;
}
