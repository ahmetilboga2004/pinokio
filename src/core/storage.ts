export interface UserProfileLocal {
  id: string;
  display_name: string;
  avatar_url: string;
}

export interface ActiveTeamLocal {
  id: string;
  team_code: string;
  admin_id: string;
  origin: string;
}

export async function getLocalUserProfile(): Promise<UserProfileLocal | null> {
  const result = await chrome.storage.local.get('pinokio_user');
  return result.pinokio_user as UserProfileLocal || null;
}

export async function setLocalUserProfile(user: UserProfileLocal | null): Promise<void> {
  await chrome.storage.local.set({ pinokio_user: user });
}

export async function getActiveTeam(): Promise<ActiveTeamLocal | null> {
  const result = await chrome.storage.local.get('pinokio_active_teams');
  const teams = (result.pinokio_active_teams || {}) as Record<string, ActiveTeamLocal>;
  return teams[window.location.origin] || null;
}

export async function setActiveTeam(team: ActiveTeamLocal | null): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'PINOKIO_SET_ACTIVE_TEAM', team });
  if (!response?.ok) throw new Error('Could not save team selection.');
}
