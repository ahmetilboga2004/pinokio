/** Mutations are serialized by the service worker across all tabs. */
export async function mutateLocalComment(operation: 'upsert' | 'delete', id: string, comment?: unknown): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'PINOKIO_MUTATE_COMMENT', operation, id, comment });
  if (!response?.ok) throw new Error(response?.error || 'Could not save local comments.');
}
