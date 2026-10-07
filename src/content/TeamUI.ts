import { getLocalUserProfile, setLocalUserProfile, getActiveTeam, setActiveTeam } from '../core/storage';
import {
  upsertUserProfile, createTeam,
  requestJoinTeam, getPendingRequests, respondToRequest,
  checkMyRequestStatus, getTeamMembers, getTeamById,
  signInWithProvider, signOutAuth, getAuthenticatedUser, getUserProfile, isOAuthUser, isTeamConfigured
} from '../core/supabase';
import { escapeHTML, imageURL } from './dom';

export class TeamUIManager {
  public container: HTMLElement;
  private currentTeamInterval: any;
  private disposed = false;
  private version = 0;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'team-island comments-island'; 
    this.container.style.display = 'none';
    this.container.style.width = '340px'; 
    
    // Inject specific styles for Team UI
    const style = document.createElement('style');
    style.textContent = `
      .team-island {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .t-input {
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        color: var(--text-primary);
        border-radius: 8px;
        font-size: 13px;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .t-input:focus {
        border-color: var(--primary-color);
        box-shadow: 0 0 0 2px rgba(178, 43, 45, 0.24);
      }
      .t-btn {
        width: 100%;
        padding: 10px;
        background: var(--primary-color);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s, transform 0.1s;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      .t-btn:hover {
        background: #d44846;
      }
      .t-btn:active {
        transform: scale(0.98);
      }
      .t-btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border-color);
      }
      .t-btn-secondary:hover {
        background: rgba(255, 255, 255, 0.1);
      }
      .t-btn-danger {
        background: rgba(178, 43, 45, 0.14);
        color: #e77570;
        border: 1px solid rgba(178, 43, 45, 0.35);
      }
      .t-btn-danger:hover {
        background: rgba(178, 43, 45, 0.28);
      }
      .t-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .t-code-box {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 8px 12px;
        font-family: monospace;
        font-size: 16px;
        font-weight: bold;
        letter-spacing: 2px;
        color: var(--primary-color);
      }
      .t-copy-btn {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        transition: background 0.2s, color 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .t-copy-btn:hover {
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      .t-req-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px;
        border-bottom: 1px solid var(--border-color);
        font-size: 12px;
      }
      .t-req-item:last-child {
        border-bottom: none;
      }
      .t-action-btn {
        cursor: pointer;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 4px;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
      }
      .t-action-btn.accept { color: #c7c2c0; }
      .t-action-btn.accept:hover { background: rgba(180, 174, 171, 0.16); border-color: #c7c2c0; }
      .t-action-btn.reject { color: #e77570; }
      .t-action-btn.reject:hover { background: rgba(178, 43, 45, 0.16); border-color: #e77570; }
    `;
    this.container.appendChild(style);

    // Mute keyboard events so they don't bubble up to the host page
    const stopPropagation = (e: Event) => e.stopPropagation();
    this.container.addEventListener('keydown', stopPropagation);
    this.container.addEventListener('keyup', stopPropagation);
    this.container.addEventListener('keypress', stopPropagation);
  }

  public async render() {
    this.stopPolling();
    const version = ++this.version;
    // Keep style element
    const styleEl = this.container.querySelector('style');
    this.container.innerHTML = '';
    if (styleEl) this.container.appendChild(styleEl);
    
    // Header
    const header = document.createElement('div');
    header.className = 'island-header';
    header.style.padding = '12px 16px';
    header.style.borderBottom = '1px solid var(--border-color)';
    header.style.background = 'rgba(255, 255, 255, 0.02)';
    header.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
        <h3 style="margin:0; font-size:14px; font-weight:600;">Team Network</h3>
      </div>
    `;
    this.container.appendChild(header);

    const content = document.createElement('div');
    content.className = 'island-content';
    content.style.padding = '16px';
    content.style.display = 'flex';
    content.style.flexDirection = 'column';

    let user = await getLocalUserProfile();
    if (this.disposed || version !== this.version) return;
    if (!isTeamConfigured) {
      content.textContent = 'Team features are not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then rebuild. Local comments are available without a team.';
      this.container.appendChild(content);
      return;
    }
    const authUser = await getAuthenticatedUser();
    if (this.disposed || version !== this.version) return;
    if (!isOAuthUser(authUser)) {
      await setLocalUserProfile(null);
      await setActiveTeam(null);
      if (this.disposed || version !== this.version) return;
      this.renderSignIn(content);
    } else {
      if (user?.id !== authUser.id) {
        const displayName = String(authUser.user_metadata?.full_name || authUser.user_metadata?.name || 'New teammate').trim().slice(0, 80);
        user = await getUserProfile(authUser.id) ||
          await upsertUserProfile({ id: authUser.id, display_name: displayName, avatar_url: '' });
        if (this.disposed || version !== this.version) return;
        if (user) await setLocalUserProfile(user);
      }
      if (!user) {
        this.renderSignIn(content);
        this.container.appendChild(content);
        return;
      }
      const storedTeam = await getActiveTeam();
      if (this.disposed || version !== this.version) return;
      const activeTeam = storedTeam ? await getTeamById(storedTeam.id) : null;
      if (this.disposed || version !== this.version) return;
      if (storedTeam && !activeTeam) await setActiveTeam(null);
      else if (activeTeam && activeTeam.team_code !== storedTeam?.team_code) await setActiveTeam(activeTeam);
      if (!activeTeam) {
        this.renderTeamJoinCreate(content, user);
      } else {
        this.renderActiveTeam(content, user, activeTeam);
      }
    }

    this.container.appendChild(content);
  }

  private renderSignIn(container: HTMLElement) {
    container.innerHTML = `
      <div style="text-align:center; margin-bottom:16px; font-size:13px; color:var(--text-secondary); line-height:1.4;">
        Sign in to use team features.
      </div>
      <button id="teamui-google-signin" class="t-btn" style="margin-bottom:8px;">Continue with Google</button>
      <button id="teamui-github-signin" class="t-btn">Continue with GitHub</button>
    `;
    const bindSignIn = (buttonId: string, provider: 'google' | 'github') => {
      const button = container.querySelector(`#${buttonId}`) as HTMLButtonElement | null;
      const label = `Continue with ${provider === 'google' ? 'Google' : 'GitHub'}`;
      button?.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = `Opening ${provider === 'google' ? 'Google' : 'GitHub'}...`;
        try {
          const authUser = await signInWithProvider(provider);
          const existing = await getUserProfile(authUser.id);
          const displayName = String(authUser.user_metadata?.full_name || authUser.user_metadata?.name || 'New teammate').trim().slice(0, 80);
          const profile = existing || await upsertUserProfile({ id: authUser.id, display_name: displayName, avatar_url: '' });
          if (!profile) throw new Error('Could not create your profile.');
          await setLocalUserProfile(profile);
          await setActiveTeam(null);
          await this.render();
        } catch (error) {
          alert(error instanceof Error ? error.message : 'Sign-in failed.');
          button.disabled = false;
          button.textContent = label;
        }
      });
    };
    bindSignIn('teamui-google-signin', 'google');
    bindSignIn('teamui-github-signin', 'github');
  }

  private async signOut() {
    try {
      await signOutAuth();
      await setActiveTeam(null);
      await setLocalUserProfile(null);
      await this.render();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not sign out.');
    }
  }

  private renderTeamJoinCreate(container: HTMLElement, user: any) {
    container.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <img referrerpolicy="no-referrer" src="${imageURL(user.avatar_url)}" alt="" width="36" height="36" style="border-radius:50%; object-fit:cover; border:2px solid var(--border-color);">
          <div>
            <div style="font-weight:600; font-size:14px;">${escapeHTML(user.display_name)}</div>
             <div style="font-size:11px; color:var(--text-secondary);">Working independently</div>
          </div>
        </div>
         <button id="teamui-logout" title="Sign out" style="background:none; border:none; color:var(--text-secondary); cursor:pointer; padding:4px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
        </button>
      </div>

      <div class="t-card">
         <div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--text-primary);">Join a team</div>
         <div style="font-size:11px; color:var(--text-secondary); margin-bottom:10px; line-height:1.4;">Enter your teammate's invite code to join their team.</div>
        <div style="display:flex; gap:8px;">
           <input type="text" id="teamui-code" placeholder="20-character invite code" maxlength="20" class="t-input" style="text-transform:uppercase; font-family:monospace; font-weight:bold; letter-spacing:1px;">
           <button id="teamui-join-btn" class="t-btn t-btn-secondary" style="width:auto; padding:0 16px;">Join</button>
        </div>
        <div id="teamui-join-status" style="font-size:11px; color:var(--primary-color); margin-top:8px; font-weight:500; text-align:center;"></div>
      </div>

       <div style="text-align:center; margin:8px 0; font-size:11px; color:var(--text-secondary); font-weight:600; text-transform:uppercase;">OR</div>

      <div class="t-card" style="margin-bottom:0;">
         <div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--text-primary);">Create a team</div>
         <div style="font-size:11px; color:var(--text-secondary); margin-bottom:10px; line-height:1.4;">Generate an invite code and share it with your teammates.</div>
        <button id="teamui-create-btn" class="t-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
           Create team
        </button>
      </div>
    `;

    container.querySelector('#teamui-logout')?.addEventListener('click', () => void this.signOut());

    container.querySelector('#teamui-create-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
       btn.innerHTML = 'Creating...';
      btn.disabled = true;
      const team = await createTeam(user.id, window.location.origin);
      if (team) {
        await setActiveTeam(team);
        this.render();
        window.location.reload();
      } else {
         alert('Could not create team.');
         btn.innerHTML = 'Create team';
        btn.disabled = false;
      }
    });

    container.querySelector('#teamui-join-btn')?.addEventListener('click', async () => {
      this.stopPolling();
      const code = (container.querySelector('#teamui-code') as HTMLInputElement).value.toUpperCase().trim();
      if (!code) return;
      const statusDiv = container.querySelector('#teamui-join-status') as HTMLElement;
      statusDiv.style.color = 'var(--text-secondary)';
       statusDiv.innerText = 'Looking for team...';
      
      const req = await requestJoinTeam(code, window.location.origin);
      if (!req) {
         statusDiv.style.color = '#e77570';
         statusDiv.innerText = 'No team with this code was found for this site.';
        return;
      }
      
      statusDiv.style.color = 'var(--primary-color)';
       statusDiv.innerText = 'Join request sent. Waiting for approval...';
      
      const team = req.team;
      if (req) {
        if (req.status === 'approved') {
          await setActiveTeam(team);
          window.location.reload();
        } else if (req.status === 'rejected') {
           statusDiv.style.color = '#e77570';
           statusDiv.innerText = 'Your request was declined by the team admin.';
        } else {
          // Poll for approval
          this.poll(async () => {
            const status = await checkMyRequestStatus(team.id, user.id);
            if (status === 'approved') {
              this.stopPolling();
              await setActiveTeam(team);
              window.location.reload();
            } else if (status === 'rejected') {
              this.stopPolling();
               statusDiv.style.color = '#e77570';
               statusDiv.innerText = 'Your request was declined by the team admin.';
            }
          });
        }
      } else {
        statusDiv.style.color = '#e77570';
        statusDiv.innerText = 'Could not send the request. Check your connection and try again.';
      }
    });
  }

  private renderActiveTeam(container: HTMLElement, user: any, activeTeam: any) {
    if (this.currentTeamInterval) clearInterval(this.currentTeamInterval);

    const isAdmin = activeTeam.admin_id === user.id;

    container.innerHTML = `
      <div class="t-card">
         <div style="font-size:11px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Team code</div>
         <div class="t-code-box" style="overflow-wrap:anywhere; letter-spacing:1px; font-size:13px;">
          <span id="teamui-code-text">${escapeHTML(activeTeam.team_code)}</span>
           <button id="teamui-copy-btn" class="t-copy-btn" title="Copy code">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
        </div>
         <div id="teamui-copy-hint" style="font-size:10px; color:#c7c2c0; text-align:right; margin-top:4px; opacity:0; transition:opacity 0.2s;">Copied!</div>
      </div>
      
      ${isAdmin ? `
        <div class="t-card" style="padding:0; overflow:hidden;">
          <div style="padding:10px 12px; background:var(--bg-primary); font-size:12px; font-weight:600; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
             Join requests
             <span style="font-size:10px; font-weight:normal; background:rgba(178,43,45,0.18); color:var(--primary-color); padding:2px 6px; border-radius:10px;" id="teamui-req-count">0</span>
          </div>
          <div id="teamui-requests-list" style="max-height:150px; overflow-y:auto; background:var(--bg-secondary);">
             <div style="padding:16px; text-align:center; font-size:11px; color:var(--text-secondary);">Loading...</div>
          </div>
        </div>
      ` : `
        <div class="t-card" style="display:flex; align-items:center; gap:10px;">
           <div style="width:8px; height:8px; border-radius:50%; background:#b22b2d; box-shadow:0 0 8px #b22b2d;"></div>
           <div style="font-size:12px; color:var(--text-primary);">Team sync is active.</div>
        </div>
      `}
      
      <div class="t-card" style="padding:0; overflow:hidden;">
        <div style="padding:10px 12px; background:var(--bg-primary); font-size:12px; font-weight:600; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
           Team members
           <span style="font-size:10px; font-weight:normal; background:rgba(180,174,171,0.16); color:#c7c2c0; padding:2px 6px; border-radius:10px;" id="teamui-members-count">0</span>
        </div>
        <div id="teamui-members-list" style="max-height:150px; overflow-y:auto; background:var(--bg-secondary);">
           <div style="padding:16px; text-align:center; font-size:11px; color:var(--text-secondary);">Loading...</div>
        </div>
      </div>
      
      <button id="teamui-leave-btn" class="t-btn t-btn-danger" style="margin-top:auto;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
         Leave team
      </button>
      <button id="teamui-signout-btn" class="t-btn t-btn-secondary" style="margin-top:8px;">Sign out of Google</button>
    `;

    // Copy Code Logic
    container.querySelector('#teamui-copy-btn')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(activeTeam.team_code);
        const hint = container.querySelector('#teamui-copy-hint') as HTMLElement;
        hint.style.opacity = '1';
        setTimeout(() => hint.style.opacity = '0', 2000);
      } catch (err) {
         console.error('Could not copy team code', err);
      }
    });

    container.querySelector('#teamui-leave-btn')?.addEventListener('click', async () => {
       if(confirm('Are you sure you want to leave this team?')) {
        await setActiveTeam(null);
        window.location.reload();
      }
    });
    container.querySelector('#teamui-signout-btn')?.addEventListener('click', () => void this.signOut());

    this.loadMembers(activeTeam.id, container.querySelector('#teamui-members-list') as HTMLElement, container.querySelector('#teamui-members-count') as HTMLElement);

    if (isAdmin) {
      this.loadRequests(activeTeam.id, container.querySelector('#teamui-requests-list') as HTMLElement, container.querySelector('#teamui-req-count') as HTMLElement);
    }
    
    this.poll(async () => {
      await this.loadMembers(activeTeam.id, container.querySelector('#teamui-members-list') as HTMLElement, container.querySelector('#teamui-members-count') as HTMLElement);
      if (isAdmin) {
        await this.loadRequests(activeTeam.id, container.querySelector('#teamui-requests-list') as HTMLElement, container.querySelector('#teamui-req-count') as HTMLElement);
      }
    });
  }

  private async loadRequests(teamId: string, listContainer: HTMLElement, countBadge: HTMLElement) {
    if (!listContainer) return;
    const requests = await getPendingRequests(teamId);
    if (this.disposed || !listContainer.isConnected) return;
    
    if (countBadge) {
      countBadge.innerText = requests.length.toString();
    }

    if (requests.length === 0) {
       listContainer.innerHTML = '<div style="font-size:11px; color:var(--text-secondary); text-align:center; padding:16px;">No pending requests.</div>';
      return;
    }

    listContainer.innerHTML = requests.map(req => `
      <div class="t-req-item">
        <div style="display:flex; align-items:center; gap:8px;">
          <img referrerpolicy="no-referrer" src="${imageURL(req.users?.avatar_url)}" alt="" width="24" height="24" style="border-radius:50%; object-fit:cover;">
          <span style="font-weight:500;">${escapeHTML(req.users?.display_name || 'Unknown')}</span>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="t-action-btn accept" data-id="${escapeHTML(req.id)}" data-uid="${escapeHTML(req.user_id)}" title="Accept">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </button>
          <button class="t-action-btn reject" data-id="${escapeHTML(req.id)}" data-uid="${escapeHTML(req.user_id)}" title="Reject">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>
    `).join('');

    listContainer.querySelectorAll('.accept').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        target.innerHTML = '...';
        await respondToRequest(target.dataset.id!, 'approved');
        this.loadRequests(teamId, listContainer, countBadge);
      });
    });

    listContainer.querySelectorAll('.reject').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        target.innerHTML = '...';
        await respondToRequest(target.dataset.id!, 'rejected');
        this.loadRequests(teamId, listContainer, countBadge);
      });
    });
  }

  private async loadMembers(teamId: string, listContainer: HTMLElement, countBadge: HTMLElement) {
    if (!listContainer) return;
    const members = await getTeamMembers(teamId);
    if (this.disposed || !listContainer.isConnected) return;
    
    if (countBadge) {
      countBadge.innerText = members.length.toString();
    }

    if (members.length === 0) {
       listContainer.innerHTML = '<div style="font-size:11px; color:var(--text-secondary); text-align:center; padding:16px;">No members found.</div>';
      return;
    }

    listContainer.innerHTML = members.map((m: any) => `
      <div class="t-req-item">
        <div style="display:flex; align-items:center; gap:8px;">
          <div style="position:relative;">
            <img referrerpolicy="no-referrer" src="${imageURL(m.users?.avatar_url)}" alt="" width="24" height="24" style="border-radius:50%; object-fit:cover;">
          </div>
          <span style="font-weight:500;">${escapeHTML(m.users?.display_name || 'Unknown')}</span>
        </div>
      </div>
    `).join('');
  }

  public destroy() {
    this.disposed = true;
    this.stopPolling();
    this.container.remove();
  }

  public stopPolling() {
    clearTimeout(this.currentTeamInterval);
    this.currentTeamInterval = undefined;
  }

  private poll(task: () => Promise<void>) {
    this.stopPolling();
    const version = this.version;
    const tick = async () => {
      if (this.disposed || version !== this.version || this.container.style.display === 'none') return;
      try { await task(); } catch (error) { console.error('Team refresh failed', error); }
      if (!this.disposed && version === this.version && this.container.style.display !== 'none' && this.currentTeamInterval !== undefined) {
        this.currentTeamInterval = setTimeout(tick, 3000);
      }
    };
    this.currentTeamInterval = setTimeout(tick, 3000);
  }
}
