import { createClient } from '@supabase/supabase-js';
import type { User } from '@supabase/supabase-js';
import { createLogger } from './logger';

const log = createLogger('Supabase');

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '';

function isSecureProjectURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
}

export const isTeamConfigured = isSecureProjectURL(SUPABASE_URL) && !!SUPABASE_ANON_KEY;
// Keep authentication in extension storage, shared across sites and isolated
// from the host page's localStorage. Local commenting needs no backend.
export const supabase = isTeamConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    detectSessionInUrl: false,
    flowType: 'pkce',
    storage: {
      async getItem(key) {
        const result = await chrome.storage.local.get(key);
        return typeof result[key] === 'string' ? result[key] : null;
      },
      async setItem(key, value) { await chrome.storage.local.set({ [key]: value }); },
      async removeItem(key) { await chrome.storage.local.remove(key); },
    },
  },
}) : null;

export interface UserProfile {
  id: string;
  display_name: string;
  avatar_url: string;
  created_at?: string;
}

export interface Team {
  id: string;
  team_code: string;
  admin_id: string;
  origin: string;
  created_at?: string;
}

export interface TeamRequest {
  id: string;
  team_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at?: string;
}

export interface CommentPayload {
  id: string;
  team_id: string;
  user_id: string;
  url: string;
  selector: string;
  comment: string;
  fallback_selectors?: string[];
  text_content_fallback?: any;
  active_nav_label?: string;
  active_nav_index?: number;
  active_nav_group_size?: number;
  active_nav_group_position?: string;
  created_at: string;
}

// ─── AUTH ───
export async function getAuthenticatedUser(): Promise<User | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user || null;
}

export type OAuthProvider = 'google' | 'github';

export function isOAuthUser(user: User | null): user is User {
  return !!user && user.is_anonymous !== true &&
    (user.app_metadata?.provider === 'google' || user.app_metadata?.provider === 'github');
}

export async function signOutAuth(): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

const oauthFlows = new Map<OAuthProvider, Promise<User>>();

export function signInWithProvider(provider: OAuthProvider): Promise<User> {
  const running = oauthFlows.get(provider);
  if (running) return running;
  const flow = startOAuthFlow(provider).finally(() => { oauthFlows.delete(provider); });
  oauthFlows.set(provider, flow);
  return flow;
}

async function startOAuthFlow(provider: OAuthProvider): Promise<User> {
  if (!supabase) throw new Error('Team features are not configured.');
  const redirectResponse = await chrome.runtime.sendMessage({ type: 'PINOKIO_GET_OAUTH_REDIRECT' });
  if (typeof redirectResponse?.url !== 'string') throw new Error('Chrome identity is unavailable.');
  const redirectTo = redirectResponse.url;
  const options = { redirectTo, skipBrowserRedirect: true };
  const { data, error } = await supabase.auth.signInWithOAuth({ provider, options });
  if (error || !data.url) throw error || new Error(`Could not start ${provider} sign-in.`);
  const response = await chrome.runtime.sendMessage({ type: 'PINOKIO_OAUTH', url: data.url });
  if (!response?.ok || typeof response.redirectUrl !== 'string') {
    throw new Error(response?.error || `${provider} sign-in was cancelled.`);
  }
  const callback = new URL(response.redirectUrl);
  if (callback.origin !== new URL(redirectTo).origin || callback.pathname !== new URL(redirectTo).pathname) {
    throw new Error(`Unexpected ${provider} sign-in redirect.`);
  }
  const authError = callback.searchParams.get('error_description') || callback.searchParams.get('error');
  if (authError) throw new Error(authError);
  const code = callback.searchParams.get('code');
  if (!code) throw new Error(`${provider} sign-in returned no authorization code.`);
  const { data: session, error: exchangeError } = await supabase.auth.exchangeCodeForSession(
    code, data.flowId ? { flowId: data.flowId } : undefined,
  );
  if (exchangeError || !isOAuthUser(session.user)) throw exchangeError || new Error('OAuth account verification failed.');
  return session.user;
}

// ─── USER PROFILE ───

export async function upsertUserProfile(user: UserProfile): Promise<UserProfile | null> {
  if (!supabase) return null;
  const { data: existing, error: readError } = await supabase.from('users').select('id').eq('id', user.id).maybeSingle();
  if (readError) return null;
  const query = existing
    ? supabase.from('users').update({ display_name: user.display_name, avatar_url: user.avatar_url }).eq('id', user.id)
    : supabase.from('users').insert({ id: user.id, display_name: user.display_name, avatar_url: user.avatar_url });
  const { data, error } = await query.select().single();

  if (error) {
    log.error('Error upserting user profile', error);
    return null;
  }
  return data;
}

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) return null;
  return data;
}

// ─── TEAM MANAGEMENT ───

export async function createTeam(adminId: string, origin: string): Promise<Team | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('teams')
    .insert({
      admin_id: adminId,
      origin: origin
    })
    .select()
    .single();

  if (error) {
    log.error('Error creating team', error);
    return null;
  }

  // Admin is automatically a member
  const { error: memberError } = await supabase.from('team_members').insert({
    team_id: data.id,
    user_id: adminId
  });
  if (memberError) { log.error('Could not add team admin', memberError); return null; }

  return data;
}

export async function getTeamMembers(teamId: string): Promise<any[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('team_members')
    .select('user_id, users(display_name, avatar_url)')
    .eq('team_id', teamId);

  if (error) {
    log.error('Error fetching team members', error);
    return [];
  }
  return data;
}

export async function getTeamById(teamId: string): Promise<Team | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('teams').select('*').eq('id', teamId).maybeSingle();
  return error ? null : data;
}

export async function requestJoinTeam(code: string, origin: string): Promise<{ team: Team; status: TeamRequest['status'] } | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('pinokio_request_join', { p_code: code, p_origin: origin });
  if (error) {
    log.error('Error requesting to join team', error);
    return null;
  }
  return data as { team: Team; status: TeamRequest['status'] } | null;
}

export async function getPendingRequests(teamId: string): Promise<any[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('team_requests')
    .select('*, users(display_name, avatar_url)')
    .eq('team_id', teamId)
    .eq('status', 'pending');

  if (error) return [];
  return data;
}

export async function respondToRequest(requestId: string, status: 'approved' | 'rejected'): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('pinokio_decide_request', { p_request_id: requestId, p_status: status });
  return !error && data === true;
}

export async function checkMyRequestStatus(teamId: string, userId: string): Promise<'pending' | 'approved' | 'rejected' | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('team_requests')
    .select('status')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .single();

  if (error) return null;
  return data.status;
}

// ─── COMMENTS SYNC ───

export async function getTeamComments(teamId: string, urlOrigin: string): Promise<any[]> {
  if (!supabase) throw new Error('Team features are not configured.');
  // We fetch comment + user info, filtered by urlOrigin
  const { data, error } = await supabase
    .from('comments')
    .select('*, users(display_name, avatar_url)')
    .eq('team_id', teamId)
    .gte('url', urlOrigin)
    .lt('url', `${urlOrigin}\uffff`);

  if (error) {
    log.error('Error fetching team comments', error);
    throw error;
  }
  return data.filter(comment => {
    try { return !urlOrigin || new URL(comment.url).origin === urlOrigin; } catch { return false; }
  });
}

export async function insertTeamComment(comment: CommentPayload, currentUserId: string): Promise<boolean> {
  if (!supabase) return false;
  const { data: existing } = await supabase.from('comments').select('user_id, team_id').eq('id', comment.id).maybeSingle();
  
  if (existing && (existing.user_id !== currentUserId || existing.team_id !== comment.team_id)) {
    log.error('Unauthorized update attempt');
    return false;
  }
  if (!existing && comment.user_id !== currentUserId) {
    log.error('Unauthorized insert attempt');
    return false;
  }

  const { id, team_id, user_id, created_at, ...editable } = comment;
  const { error } = existing
    ? await supabase.from('comments').update(editable).eq('id', id)
    : await supabase.from('comments').insert(comment);
  
  if (error) {
    log.error('Error inserting team comment', error);
    return false;
  }
  return true;
}

export async function deleteTeamComment(commentId: string, currentUserId: string, teamAdminId: string): Promise<boolean> {
  if (!supabase) return false;
  const { data: comment } = await supabase.from('comments').select('user_id').eq('id', commentId).maybeSingle();
  if (!comment) return false;

  if (comment.user_id !== currentUserId && currentUserId !== teamAdminId) {
    log.error('Unauthorized delete attempt');
    return false;
  }

  const { error } = await supabase
    .from('comments')
    .delete()
    .eq('id', commentId);
    
  return !error;
}
