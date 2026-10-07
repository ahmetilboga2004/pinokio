export interface TabState {
  active: boolean;
  pendingId?: string;
}

export async function readTabState(): Promise<TabState> {
  try {
    return await chrome.runtime.sendMessage({ type: 'PINOKIO_GET_TAB_STATE' }) || { active: false };
  } catch { return { active: false }; }
}

export async function writeTabState(state: TabState): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'PINOKIO_SET_TAB_STATE', state });
}
