import { resolveSelector, buildFallbackChain, extractTextContentFallback, findByTextContentFallback } from '../core/selectorResolver';
import type { TextContentFallback } from '../core/selectorResolver';
import { createLogger } from '../core/logger';
import { TeamUIManager } from './TeamUI';
import { getActiveTeam, getLocalUserProfile } from '../core/storage';
import { insertTeamComment, deleteTeamComment, getTeamComments } from '../core/supabase';
import { waitFor, samePage } from '../core/async';
import { escapeHTML, imageURL, visibleRect } from './dom';
import { writeTabState } from '../core/tabState';
import { mutateLocalComment } from '../core/localComments';

const log = createLogger('Overlay');

interface CommentData {
  id?: string;
  selector: string;
  fallbackSelectors?: string[];
  textContentFallback?: TextContentFallback | null;
  url: string;
  comment: string;
  createdAt: string;
  activeNavLabel?: string;
  activeNavIndex?: number;
  activeNavGroupSize?: number;
  activeNavGroupPosition?: NavGroupPosition;
  user?: any;
  userId?: string;
}


type NavGroupPosition = 'top' | 'bottom' | 'left' | 'right' | 'middle';

interface NavContext {
  label: string;
  index: number;
  groupSize: number;
  groupPosition: NavGroupPosition;
  score: number;
}

class PinokioOverlay {
  private container: HTMLElement;
  private shadow: ShadowRoot;
  
  private isEditMode: boolean = false;
  
  private marginDiv!: HTMLElement;
  private borderDiv!: HTMLElement;
  private paddingDiv!: HTMLElement;
  private contentDiv!: HTMLElement;
  private noteDiv!: HTMLElement;
  
  private commentInputPopup!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private saveBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;

  
  private lastTarget: HTMLElement | null = null;
  private lastMouseX: number = -1;
  private lastMouseY: number = -1;
  private currentActiveElementForComment: HTMLElement | null = null;
  
  private comments: CommentData[] = [];
  private currentUrl: string = '';
  
  // Display popup for viewing comments from the island
  private commentDisplayPopup!: HTMLElement;

  // Edit mode state
  private editingComment: CommentData | null = null;

  // Shift parent selection
  private shiftHeldTarget: HTMLElement | null = null;
  private shiftDepth: number = 0;



  // Toolbar button references for programmatic state updates
  private commentsToggleBtn!: HTMLButtonElement;
  private teamToggleBtn!: HTMLButtonElement;
  private readBtn!: HTMLButtonElement;
  private editModeBtn!: HTMLButtonElement;

  private teamUI!: TeamUIManager;
  private commentsPoll?: ReturnType<typeof setInterval>;

  private boundOnMouseMove = this.onMouseMove.bind(this);
  private boundOnScroll = this.onScroll.bind(this);
  private boundOnMouseAction = this.onMouseAction.bind(this);
  private boundOnClick = this.onClick.bind(this);
  private boundOnMouseLeave = this.onMouseLeave.bind(this);
  private boundOnKeyDown = this.onKeyDown.bind(this);
  private boundOnKeyUp = this.onKeyUp.bind(this);
  private boundOnResize = this.onResize.bind(this);

  private navigationInProgress = false;
  private navigation = new AbortController();
  private lifetime = new AbortController();
  private disposed = false;
  private urlTimer?: ReturnType<typeof setInterval>;
  private loadVersion = 0;
  private renderVersion = 0;
  private saving = false;
  private displayTarget: HTMLElement | null = null;
  private displayedComment: CommentData | null = null;
  private displayFrame = 0;
  private flashCleanup?: () => void;
  private statusDiv!: HTMLElement;
  private subscribedTeam: string | null = null;
  private rootObserver?: MutationObserver;

  constructor() {
    log.info('Initializing PinokioOverlay...');

    this.container = document.createElement('div');
    this.container.id = 'pinokio-root';
    this.container.lang = 'en';
    this.container.style.position = 'fixed';
    this.container.style.top = '0';
    this.container.style.left = '0';
    this.container.style.width = '100vw';
    this.container.style.height = '100vh';
    this.container.style.pointerEvents = 'none';
    this.container.style.zIndex = '2147483647';
    
    this.shadow = this.container.attachShadow({ mode: 'closed' });
    this.currentUrl = this.getCurrentFullUrl();

    this.injectStyles();
    this.createBoxElements();
    this.createUIElements();
    
    if (document.documentElement) {
      document.documentElement.appendChild(this.container);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.appendChild(this.container);
      });
    }

    this.bindEvents();
    this.loadComments();
    this.watchUrlChanges();
    sessionStorage.setItem('pinokio_overlay_active', 'true');
    void writeTabState({ active: true, pendingId: sessionStorage.getItem('pinokio_scroll_to') || undefined });
    log.info('PinokioOverlay initialized successfully');
  }

  private getStorageKey(): string {
    return window.location.origin;
  }

  private getCurrentFullUrl(): string {
    return window.location.origin + window.location.pathname + window.location.search + window.location.hash;
  }

  private watchUrlChanges(): void {
    const checkUrl = () => {
      this.ensureMounted();
      const newUrl = this.getCurrentFullUrl();
      if (newUrl !== this.currentUrl) {
        const oldUrl = this.currentUrl;
        this.currentUrl = newUrl;
        log.info('URL changed (poll)', { from: oldUrl, to: newUrl });
        this.onUrlChanged();
      }
    };

    // History calls in the page's MAIN world are not observable by patching
    // history in the isolated extension world. Poll only the URL, not the DOM.
    const options = { signal: this.lifetime.signal };
    window.addEventListener('popstate', checkUrl, options);
    window.addEventListener('hashchange', checkUrl, options);
    window.addEventListener('pageshow', checkUrl, options);
    this.urlTimer = setInterval(checkUrl, 200);
    // Turbo/PJAX and DOM morphing can remove extension nodes without loading
    // a new document. Reattach the same instance instead of losing its state.
    this.rootObserver = new MutationObserver(() => this.ensureMounted());
    this.rootObserver.observe(document.documentElement, { childList: true });
    chrome.storage.onChanged.addListener(this.onStorageChanged);
  }

  private ensureMounted(): void {
    if (!this.disposed && !this.container.isConnected && document.documentElement) {
      // Cached DOM snapshots may contain a cloned host without its shadow root.
      document.querySelectorAll('#pinokio-root').forEach(node => {
        if (node !== this.container) node.remove();
      });
      document.documentElement.appendChild(this.container);
    }
  }

  private onUrlChanged(): void {
    log.info('onUrlChanged fired');
    
    this.hideCommentDisplay();
    this.flashCleanup?.();
    
    // Close edit mode on navigate to prevent popups from getting stuck
    if (this.isEditMode) {
      this.isEditMode = false;
      this.hideBoxModel();
      this.closeCommentInput();
      this.readBtn.classList.add('active');
      this.editModeBtn.classList.remove('active');
    }

    if (this.navigationInProgress) {
      log.debug('Navigation in progress, skipping auto-scroll');
      return;
    }
    this.checkPendingScroll();
    if (this.commentsIsland.style.display === 'block') this.renderCommentsIsland();
  }

  private onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || this.disposed) return;
    if (changes[this.getStorageKey()] || changes.pinokio_active_teams || changes.pinokio_user) {
      void this.loadComments();
    }
  };

  private checkPendingScroll() {
    if (this.disposed || this.navigationInProgress) return;
    const pendingId = sessionStorage.getItem('pinokio_scroll_to');
    if (!pendingId) return;

    log.info('Found pending scroll target', { createdAt: pendingId });

    const comment = this.comments.find(c => (c.id || c.createdAt) === pendingId || c.createdAt === pendingId);
    if (!comment) {
      sessionStorage.removeItem('pinokio_scroll_to');
      this.showStatus('The saved comment is no longer available.');
      return;
    }

    log.info('Found pending comment, waiting for element...', { comment: comment.comment });
    void this.navigateToComment(comment);
  }

  private verifyElementText(el: HTMLElement, c: CommentData): boolean {
    if (!c.textContentFallback) return true;
    const elText = el.textContent?.trim() || '';
    const matches = elText === c.textContentFallback.text;
    if (!matches) {
      log.debug('Element text mismatch — likely wrong element on current tab', {
        expected: c.textContentFallback.text.slice(0, 40),
        actual: elText.slice(0, 40),
        selector: c.selector,
      });
    }
    return matches;
  }

  private findElementForComment(c: CommentData, skipVisibility = false): HTMLElement | null {
    const isVisible = (element: HTMLElement) => {
      if (skipVisibility) return true;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return element.isConnected && rect.width > 0 && rect.height > 0 &&
        style.visibility !== 'hidden' && style.display !== 'none';
    };

    try {
      const el = document.querySelector(c.selector) as HTMLElement;
      if (el && isVisible(el) && this.verifyElementText(el, c)) {
        log.debug('Element found with primary selector', { selector: c.selector });
        return el;
      }
    } catch (e) {
      log.warn('Primary selector failed', { selector: c.selector, error: e });
    }

    if (c.fallbackSelectors) {
      for (const fallback of c.fallbackSelectors) {
        try {
          const fallbackEl = document.querySelector(fallback) as HTMLElement;
          if (fallbackEl && isVisible(fallbackEl) && this.verifyElementText(fallbackEl, c)) {
            log.debug('Element found with fallback selector', { selector: fallback });
            return fallbackEl;
          }
        } catch (e) {
          log.warn('Fallback selector failed', { selector: fallback, error: e });
        }
      }
    }

    if (c.textContentFallback) {
      const fallbackEl = findByTextContentFallback(c.textContentFallback);
      if (fallbackEl && isVisible(fallbackEl as HTMLElement)) {
        log.debug('Element found with text content fallback', { text: c.textContentFallback.text });
        return fallbackEl as HTMLElement;
      }
    }
    
    log.debug('Element not found or not visible yet for comment', { selector: c.selector, url: c.url });
    return null;
  }

  private async waitForScrollToFinish(el: HTMLElement, signal = this.navigation.signal): Promise<void> {
    await waitFor(() => {
      if (!el.isConnected) return null;
      const rect = el.getBoundingClientRect();
      return `${Math.round(rect.top)},${Math.round(rect.left)}`;
    }, { timeout: 1800, stableFor: 180, signal });
  }

  private async scrollToComment(c: CommentData, signal = this.navigation.signal): Promise<boolean> {
    try {
      if (signal.aborted || this.disposed || !this.isCommentForCurrentPage(c)) return false;
      const el = this.findElementForComment(c);
      if (!el) {
        log.debug('scrollToComment: element not found on current view, will try navigation strategies', c.selector);
        return false;
      }

      log.info('Scrolling to element...', { selector: c.selector, comment: c.comment });

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      
      await this.waitForScrollToFinish(el, signal);
      if (signal.aborted || this.disposed || !el.isConnected || !this.isCommentForCurrentPage(c)) return false;
      // Consume the route change before displaying, so the URL poll cannot
      // immediately hide a successfully restored comment.
      this.currentUrl = this.getCurrentFullUrl();
      this.ensureMounted();

      // Give a brief visual flash so the user sees the element
      this.flashElement(el);
      
      // Show the comment text under the element
      this.showCommentDisplay(c, el);
      
      sessionStorage.removeItem('pinokio_scroll_to');
      sessionStorage.removeItem('pinokio_scroll_reload');
      await writeTabState({ active: true });
      this.showStatus('');
      log.info('Scroll to comment completed successfully');
      return true;
    } catch (e) {
      log.error('scrollToComment failed', { selector: c.selector, error: e });
      return false;
    }
  }

  private flashElement(el: HTMLElement): void {
    this.flashCleanup?.();
    const flash = document.createElement('div');
    flash.style.position = 'fixed';
    flash.style.boxSizing = 'border-box';
    flash.style.backgroundColor = 'rgba(178, 43, 45, 0.24)';
    flash.style.border = '2px solid rgba(178, 43, 45, 0.85)';
    flash.style.borderRadius = '4px';
    flash.style.zIndex = '999999';
    flash.style.pointerEvents = 'none';
    flash.style.transition = 'opacity 1s ease-out';
    this.shadow.appendChild(flash);

    // Track the target while the flash is visible, even if the user scrolls immediately.
    let frame = 0;
    const followElement = () => {
      if (!flash.isConnected || !el.isConnected) {
        flash.remove();
        return;
      }
      const rect = visibleRect(el);
      if (!rect) { flash.style.visibility = 'hidden'; frame = requestAnimationFrame(followElement); return; }
      flash.style.visibility = 'visible';
      flash.style.top = rect.top + 'px';
      flash.style.left = rect.left + 'px';
      flash.style.width = rect.width + 'px';
      flash.style.height = rect.height + 'px';
      flash.style.visibility = rect.bottom <= 0 || rect.top >= window.innerHeight ||
        rect.right <= 0 || rect.left >= window.innerWidth ? 'hidden' : 'visible';
      frame = requestAnimationFrame(followElement);
    };
    followElement();
    const fade = setTimeout(() => flash.style.opacity = '0', 500);
    const remove = setTimeout(() => cleanup(), 1500);
    const cleanup = () => {
      clearTimeout(fade); clearTimeout(remove); cancelAnimationFrame(frame); flash.remove();
      if (this.flashCleanup === cleanup) this.flashCleanup = undefined;
    };
    this.flashCleanup = cleanup;
  }

  private requestBrowserNavigation(targetUrl: string): void {
    log.info('Requesting browser navigation', { targetUrl });
    try {
      window.location.assign(targetUrl);
    } catch (err) {
      log.warn('window.location.assign failed, trying background script', { error: err });
      chrome.runtime.sendMessage({ type: 'PINOKIO_NAVIGATE_TAB', url: targetUrl });
    }
  }

  private getNavigationLabel(el: HTMLElement): string {
    const labelSources = [
      el.textContent?.trim(),
      el.getAttribute('aria-label')?.trim(),
      el.getAttribute('title')?.trim(),
      el.getAttribute('data-label')?.trim(),
      el.getAttribute('data-tab')?.trim(),
      el.getAttribute('data-value')?.trim(),
      el.getAttribute('data-testid')?.trim(),
    ];

    return labelSources.find(label => !!label) || '';
  }

  private normalizeNavLabel(label: string): string {
    return label.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private isVisibleNavigationCandidate(el: HTMLElement): boolean {
    if (this.container.contains(el)) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
  }

  private colorDistance(a: string, b: string): number {
    const parseColor = (color: string): number[] | null => {
      const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };

    const ca = parseColor(a);
    const cb = parseColor(b);
    if (!ca || !cb) return 0;

    return Math.sqrt(
      Math.pow(ca[0] - cb[0], 2) +
      Math.pow(ca[1] - cb[1], 2) +
      Math.pow(ca[2] - cb[2], 2)
    );
  }

  private getCandidateVisualColor(el: HTMLElement): string {
    const isMeaningfulColor = (color: string): boolean =>
      !!color &&
      color !== 'none' &&
      color !== 'transparent' &&
      color !== 'currentcolor' &&
      color !== 'rgba(0, 0, 0, 0)';

    const visualNodes = Array.from(el.querySelectorAll('svg, path, [fill], [stroke]')) as Array<HTMLElement | SVGElement>;
    for (const node of visualNodes) {
      const style = window.getComputedStyle(node);
      const color = [style.fill, style.stroke, style.color].find(isMeaningfulColor);
      if (color) return color;
    }

    const style = window.getComputedStyle(el);
    return [style.color, style.fill, style.stroke].find(isMeaningfulColor) || '';
  }

  private hasActiveDataAttribute(el: HTMLElement): boolean {
    const activeAttrs = ['data-active', 'data-selected', 'data-current'];
    if (activeAttrs.some(attr => el.getAttribute(attr) === 'true' || el.getAttribute(attr) === 'active')) {
      return true;
    }

    const dataState = el.getAttribute('data-state') || el.getAttribute('data-status');
    return dataState === 'active' || dataState === 'selected' || dataState === 'current';
  }

  private scoreActiveNavCandidate(el: HTMLElement, siblings: HTMLElement[]): number {
    const style = window.getComputedStyle(el);
    const classes = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : '';
    const opacity = Number(style.opacity) || 0;
    const fontWeight = Number.parseInt(style.fontWeight, 10) || (style.fontWeight === 'bold' ? 700 : 400);
    const color = this.getCandidateVisualColor(el);

    let score = 0;

    if (el.getAttribute('aria-selected') === 'true') score += 100;
    if (el.getAttribute('aria-current')) score += 100;
    if (el.getAttribute('aria-pressed') === 'true') score += 60;
    if (this.hasActiveDataAttribute(el)) score += 100;
    if (/\b(active|selected|current|tab-active|nav-active|active-tab)\b/.test(classes)) score += 80;
    if (classes.includes('text-primary')) score += 80;
    if (classes.includes('text-white/20') || classes.includes('text-white\\/20')) score -= 20;

    const tabindex = el.getAttribute('tabindex');
    const siblingsHaveRovingTabIndex = siblings.some(s => s.getAttribute('tabindex') === '-1');
    if (tabindex === '0' && siblingsHaveRovingTabIndex) score += 30;

    const siblingOpacities = siblings.map(s => Number(window.getComputedStyle(s).opacity) || 0);
    const maxOpacity = Math.max(...siblingOpacities);
    const minOpacity = Math.min(...siblingOpacities);
    if (maxOpacity - minOpacity >= 0.15 && opacity === maxOpacity) score += 30;

    const siblingWeights = siblings.map(s => Number.parseInt(window.getComputedStyle(s).fontWeight, 10) || 400);
    const maxWeight = Math.max(...siblingWeights);
    const minWeight = Math.min(...siblingWeights);
    if (maxWeight - minWeight >= 100 && fontWeight === maxWeight) score += 25;

    const siblingColors = siblings.map(s => this.getCandidateVisualColor(s)).filter(Boolean);
    if (color && siblingColors.length >= 2) {
      const distances = siblingColors.filter(c => c !== color).map(c => this.colorDistance(color, c));
      if (distances.some(distance => distance >= 35)) score += 20;
    }

    const background = style.backgroundColor;
    if (background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') score += 15;

    const borderWidth = Math.max(
      Number.parseFloat(style.borderBottomWidth || '0'),
      Number.parseFloat(style.borderTopWidth || '0'),
      Number.parseFloat(style.borderLeftWidth || '0'),
      Number.parseFloat(style.borderRightWidth || '0')
    );
    if (borderWidth >= 2) score += 15;

    return score;
  }

  private getNavGroupPosition(group: HTMLElement[]): NavGroupPosition {
    const rects = group.map(el => el.getBoundingClientRect());
    const top = Math.min(...rects.map(rect => rect.top));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    const left = Math.min(...rects.map(rect => rect.left));
    const right = Math.max(...rects.map(rect => rect.right));

    if (top <= window.innerHeight * 0.2) return 'top';
    if (bottom >= window.innerHeight * 0.8) return 'bottom';
    if (left <= window.innerWidth * 0.2) return 'left';
    if (right >= window.innerWidth * 0.8) return 'right';
    return 'middle';
  }

  private getNavigationGroups(candidates = this.findNavigationCandidates()): HTMLElement[][] {
    const groups = new Map<Element, HTMLElement[]>();

    for (const candidate of candidates) {
      const group = candidate.closest('[role="tablist"], nav') ||
        candidate.parentElement ||
        document.body;
      const siblings = groups.get(group) || [];
      siblings.push(candidate);
      groups.set(group, siblings);
    }

    return Array.from(groups.values())
      .map(siblings => siblings.filter(el => this.isVisibleNavigationCandidate(el)))
      .filter(siblings => siblings.length >= 2);
  }

  private detectActiveNavContext(): NavContext | null {
    const groups = this.getNavigationGroups();
    let best: NavContext | null = null;

    for (const siblings of groups) {
      for (const el of siblings) {
        const score = this.scoreActiveNavCandidate(el, siblings);
        const context = {
          label: this.getNavigationLabel(el),
          index: siblings.indexOf(el),
          groupSize: siblings.length,
          groupPosition: this.getNavGroupPosition(siblings),
          score,
        };

        if (!best || context.score > best.score) best = context;
      }
    }

    if (!best || best.score < 20) return null;

    log.debug('Active nav context detected', best);
    return best;
  }

  private findNavigationCandidates(): HTMLElement[] {
    const candidates = new Set<HTMLElement>();

    document.querySelectorAll('[role="tab"]').forEach(el => candidates.add(el as HTMLElement));

    document.querySelectorAll('nav').forEach(nav => {
      nav.querySelectorAll('button, a, [role="button"], [tabindex]').forEach(el => candidates.add(el as HTMLElement));
    });

    document.querySelectorAll('div, section, aside, footer, header').forEach(container => {
      const style = window.getComputedStyle(container);
      if (style.position === 'fixed' || style.position === 'sticky') {
        const children = container.querySelectorAll('button, [role="button"], [tabindex]');
        if (children.length >= 2) {
          children.forEach(el => candidates.add(el as HTMLElement));
        }
      }
    });

    document.querySelectorAll('[role="tablist"] button, [role="tablist"] [role="tab"]').forEach(el => {
      candidates.add(el as HTMLElement);
    });

    const result = Array.from(candidates).filter(el => this.isVisibleNavigationCandidate(el));

    log.debug('Navigation candidates found', { count: result.length, labels: result.map(e => this.getNavigationLabel(e).slice(0, 30)) });
    return result;
  }

  private async clickNavByLabel(label: string): Promise<boolean> {
    const signal = this.navigation.signal;
    if (signal.aborted) return false;
    const candidates = this.findNavigationCandidates();
    const target = this.normalizeNavLabel(label);
    const matches = candidates
      .map(el => {
        const candidateLabel = this.normalizeNavLabel(this.getNavigationLabel(el));
        let score = 0;
        if (candidateLabel === target) score = 4;
        else if (candidateLabel && target.includes(candidateLabel)) score = 3;
        else if (candidateLabel && candidateLabel.includes(target)) score = 2;
        return { el, candidateLabel, score };
      })
      .filter(match => match.score > 0)
      .sort((a, b) => b.score - a.score);

    const match = matches[0]?.el;

    if (!match) {
      log.debug('clickNavByLabel: no matching nav element found', { label, availableLabels: candidates.map(e => this.getNavigationLabel(e)) });
      return false;
    }

    log.info('clickNavByLabel: clicking matched nav element', { label, text: this.getNavigationLabel(match) });
    match.click();
    await waitFor(() => true, { stableFor: 250, timeout: 300, signal });
    return !signal.aborted;
  }

  private async clickNavByIndex(index: number, groupSize?: number, groupPosition?: NavGroupPosition): Promise<boolean> {
    const signal = this.navigation.signal;
    if (signal.aborted) return false;
    if (!Number.isInteger(index) || index < 0) return false;

    const groups = this.getNavigationGroups();
    const matchingGroups = groups.filter(group =>
      (group.length === groupSize || groupSize === undefined) &&
      (this.getNavGroupPosition(group) === groupPosition || groupPosition === undefined)
    );

    for (const group of matchingGroups) {
      const match = group[index];
      if (!match) continue;

      log.info('clickNavByIndex: clicking matched nav element', {
        index,
        groupSize: group.length,
        groupPosition: this.getNavGroupPosition(group),
        label: this.getNavigationLabel(match),
      });
      match.click();
      await waitFor(() => true, { stableFor: 250, timeout: 300, signal });
      return !signal.aborted;
    }

    log.debug('clickNavByIndex: no matching nav element found', {
      index,
      groupSize,
      groupPosition,
      availableGroups: groups.map(group => ({ size: group.length, position: this.getNavGroupPosition(group) })),
    });
    return false;
  }

  private rememberActiveNavContext(c: CommentData, context: NavContext | null): void {
    if (!context) return;

    const changed =
      c.activeNavLabel !== (context.label || undefined) ||
      c.activeNavIndex !== context.index ||
      c.activeNavGroupSize !== context.groupSize ||
      c.activeNavGroupPosition !== context.groupPosition;

    if (!changed) return;

    c.activeNavLabel = context.label || undefined;
    c.activeNavIndex = context.index;
    c.activeNavGroupSize = context.groupSize;
    c.activeNavGroupPosition = context.groupPosition;

    const existing = this.comments.find(comment => comment.createdAt === c.createdAt);
    if (existing) {
      existing.activeNavLabel = c.activeNavLabel;
      existing.activeNavIndex = c.activeNavIndex;
      existing.activeNavGroupSize = c.activeNavGroupSize;
      existing.activeNavGroupPosition = c.activeNavGroupPosition;
    }

    void getActiveTeam().then(team => {
      if (team || this.disposed) return;
      return mutateLocalComment('upsert', c.id || c.createdAt, c);
    }).then(() => {
      log.debug('Updated comment nav hint', {
        createdAt: c.createdAt,
        activeNavLabel: c.activeNavLabel,
        activeNavIndex: c.activeNavIndex,
        activeNavGroupSize: c.activeNavGroupSize,
        activeNavGroupPosition: c.activeNavGroupPosition,
      });
    }).catch(error => log.warn('Could not save navigation hint', error));
  }

  private async tryTabNavigationToElement(c: CommentData): Promise<boolean> {
    const signal = this.navigation.signal;
    // Saved hints are tried first. Fallback probing is limited to explicit tabs;
    // generic navbar buttons may log out, submit forms, or leave the page.
    const candidates = this.findNavigationCandidates().filter(el =>
      el.matches('[role="tab"], [role="tablist"] button, [data-tab]') &&
      !el.matches(':disabled, [aria-disabled="true"]')
    ).slice(0, 16);
    if (candidates.length === 0) {
      log.info('No navigation candidates found for tab navigation');
      return false;
    }

    log.info('Starting tab navigation probe', { candidateCount: candidates.length });

    const currentActiveLabel = this.detectActiveNavLabel();
    const orderedCandidates = candidates
      .map((candidate, index) => {
        const label = this.getNavigationLabel(candidate);
        const isCurrentActive = !!currentActiveLabel && this.normalizeNavLabel(label) === this.normalizeNavLabel(currentActiveLabel);
        return { candidate, index, isCurrentActive };
      })
      .sort((a, b) => {
        if (a.isCurrentActive !== b.isCurrentActive) return a.isCurrentActive ? 1 : -1;
        return a.index - b.index;
      })
      .map(item => item.candidate);

    for (const candidate of orderedCandidates) {
      if (signal.aborted || this.disposed) return false;
      const label = this.getNavigationLabel(candidate).slice(0, 40);
      log.debug('Clicking navigation candidate', { label, tag: candidate.tagName });

      candidate.click();

      const el = await waitFor(() => this.isCommentForCurrentPage(c) && this.findElementForComment(c),
        { timeout: 700, stableFor: 150, signal });
      if (el) {
        log.info('Element found after clicking navigation candidate', { label });
        this.rememberActiveNavContext(c, this.detectActiveNavContext());
        return true;
      }
    }

    log.info('Tab navigation exhausted, element not found through any candidate');
    return false;
  }

  private async navigateToComment(c: CommentData): Promise<void> {
    this.navigation.abort();
    const controller = this.navigation = new AbortController();
    const signal = controller.signal;
    this.navigationInProgress = true;
    this.hideCommentDisplay();
    this.flashCleanup?.();
    this.isEditMode = false;
    this.hideBoxModel();
    this.closeCommentInput();
    this.readBtn.classList.add('active');
    this.editModeBtn.classList.remove('active');
    this.showStatus('Finding comment…');
    const deadline = setTimeout(() => controller.abort(), 25000);
    const changingRoute = !this.isCommentForCurrentPage(c);
    const oldTarget = changingRoute ? this.findElementForComment(c) : null;
    const contentRoot = document.querySelector('main, [role="main"]') || document.body;
    const oldContent = changingRoute ? contentRoot?.textContent : null;
    const ready = (timeout: number) => waitFor(() => {
      if (!this.isCommentForCurrentPage(c)) return null;
      const target = this.findElementForComment(c);
      // Routers may update the URL before replacing the view. An identical
      // selector and "About" label on two repos do not prove readiness.
      if (changingRoute && target === oldTarget && contentRoot?.isConnected && contentRoot.textContent === oldContent) return null;
      return target;
    }, { timeout, stableFor: 200, signal });
    try {
      const target = new URL(c.url, location.href);
      if (!['http:', 'https:'].includes(target.protocol) || target.origin !== location.origin) {
        throw new Error('This comment belongs to another site. Open that site to view it.');
      }
      sessionStorage.setItem('pinokio_scroll_to', c.id || c.createdAt);
      await writeTabState({ active: true, pendingId: c.id || c.createdAt });
      if (signal.aborted) return;
      if (changingRoute) {
        window.postMessage({ type: 'PINOKIO_NAVIGATE', url: target.href }, location.origin);
        // Wait for the actual target, not a title/header change or global DOM silence.
        const element = await ready(8000);
        if (element && !c.activeNavLabel && c.activeNavIndex === undefined && await this.scrollToComment(c, signal)) return;
        if (signal.aborted) return;
        if (!this.isCommentForCurrentPage(c)) {
          sessionStorage.setItem('pinokio_scroll_reload', 'true');
          this.requestBrowserNavigation(target.href);
          return;
        }
      }
      // Restore saved tab state before trusting a generic selector on another tab.
      if (c.activeNavLabel) {
        const active = this.detectActiveNavLabel();
        if (this.normalizeNavLabel(active) !== this.normalizeNavLabel(c.activeNavLabel)) {
          await this.clickNavByLabel(c.activeNavLabel);
        }
      } else if (c.activeNavIndex !== undefined) {
        await this.clickNavByIndex(c.activeNavIndex, c.activeNavGroupSize, c.activeNavGroupPosition);
      }
      if (signal.aborted) return;
      if (await ready(3500) && await this.scrollToComment(c, signal)) return;
      if (signal.aborted) return;
      if (await this.tryTabNavigationToElement(c) && await this.scrollToComment(c, signal)) return;
      if (signal.aborted) return;
      if (await ready(3000) && await this.scrollToComment(c, signal)) return;
      if (changingRoute && !sessionStorage.getItem('pinokio_scroll_reload') && !signal.aborted) {
        sessionStorage.setItem('pinokio_scroll_reload', 'true');
        this.requestBrowserNavigation(target.href);
        return;
      }
      throw new Error('The element could not be found. It may have moved, been removed, or require opening a section.');
    } catch (error) {
      if (!signal.aborted) {
        this.showStatus(error instanceof Error ? error.message : 'Could not open this comment.');
        sessionStorage.removeItem('pinokio_scroll_to');
        sessionStorage.removeItem('pinokio_scroll_reload');
        void writeTabState({ active: true });
      }
    } finally {
      clearTimeout(deadline);
      if (this.navigation === controller) {
        this.navigationInProgress = false;
        if (signal.aborted && !this.disposed) {
          this.showStatus('Navigation stopped. Select the comment to try again.');
          sessionStorage.removeItem('pinokio_scroll_to');
          void writeTabState({ active: true });
        }
      }
    }
  }

  private injectStyles() {
    const style = document.createElement('style');
    style.textContent = `

      :host {
        --primary-color: #b22b2d;
        --bg-primary: #141314;
        --bg-secondary: #252324;
        --border-color: #4b4545;
        --text-primary: #f3eeee;
        --text-secondary: #b4aead;
        font-family: 'Inter', system-ui, sans-serif;
        color: var(--text-primary);
        color-scheme: dark;
      }
      *, *::before, *::after { box-sizing: border-box; }
      button:focus-visible, [role="button"]:focus-visible { outline: 2px solid #e77570; outline-offset: 3px; }
      button:disabled { opacity: 0.55; cursor: wait; }
      .status-message { max-width: min(360px, calc(100vw - 24px)); padding: 10px 12px; margin-bottom: 8px; background: #252324; color: #f3eeee; border: 1px solid #4b4545; border-radius: 8px; font-size: 12px; pointer-events: auto; }

      .box {
        position: fixed;
        box-sizing: border-box;
        pointer-events: none;
        transition: none;
        z-index: 1000;
      }
      .tag-note {
        position: fixed;
         background: #141314;
        color: #fff;
        padding: 4px 8px;
        border-radius: 4px;
        font-family: 'Inter', system-ui, sans-serif;
        font-size: 11px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        pointer-events: none;
        z-index: 1001;
        display: none;
        white-space: nowrap;
         border: 1px solid #4b4545;
      }
       .tag-note .tag { color: #e77570; font-weight: bold; }
       .tag-note .class { color: #c7c2c0; }
       .tag-note .id { color: #d44846; }
       .tag-note .dims { color: #b4aead; margin-left: 6px; }

      .toolbar-container {
        position: fixed;
        bottom: 24px;
        right: 24px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        z-index: 2147483646;
        pointer-events: none;
        width: max-content;
      }
      .comments-island {
        position: absolute;
         background: rgba(20, 19, 20, 0.97);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        padding: 0;
        width: 360px;
        max-width: calc(100vw - 24px);
        max-height: min(500px, calc(100vh - 100px));
        overflow-y: auto;
        box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05);
        pointer-events: auto;
        display: none;
        font-family: 'Inter', system-ui, sans-serif;
        color: #fff;
      }
      .comments-island::-webkit-scrollbar {
        width: 4px;
      }
      .comments-island::-webkit-scrollbar-track {
        background: transparent;
      }
      .comments-island::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.12);
        border-radius: 4px;
      }
      .comments-island-header {
        font-weight: 600;
        font-size: 13px;
        padding: 14px 16px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.7);
        letter-spacing: 0.3px;
        text-transform: uppercase;
        position: sticky;
        top: 0;
         background: rgba(20, 19, 20, 0.97);
        backdrop-filter: blur(16px);
        z-index: 1;
      }
      .island-comment-item {
        padding: 10px 16px;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        font-size: 13px;
        line-height: 1.5;
        cursor: pointer;
        transition: background 0.15s ease;
        display: flex;
        align-items: flex-start;
        gap: 10px;
        position: relative;
      }
      .island-comment-item:hover {
        background: rgba(255,255,255,0.04);
      }
      .island-comment-item:last-child {
        border-bottom: none;
      }
      .island-comment-content {
        flex: 1;
        min-width: 0;
      }
      .island-comment-author {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .island-comment-avatar {
        width: 24px;
        height: 24px;
        border-radius: 50%;
         background: #b22b2d;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 600;
      }
      .island-comment-name {
        font-size: 12px;
        font-weight: 600;
        color: rgba(255,255,255,0.95);
      }
      .island-comment-text {
        color: rgba(255,255,255,0.9);
        word-break: break-word;
      }
      .island-comment-date {
        font-size: 10px;
        color: rgba(255,255,255,0.3);
        margin-top: 4px;
      }
      .island-comment-url {
        font-size: 10px;
         color: #e77570;
        margin-top: 2px;
        word-break: break-all;
        opacity: 0.7;
      }
      .island-comment-actions {
        display: flex;
        gap: 2px;
        flex-shrink: 0;
        align-items: center;
        margin-top: 2px;
      }
      .island-action-btn {
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
        color: rgba(255,255,255,0.25);
        width: 26px;
        height: 26px;
      }
      .island-action-btn:hover {
        background: rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.9);
      }
      .island-action-btn.delete-btn:hover {
         background: rgba(178, 43, 45, 0.2);
         color: #e77570;
      }
      .island-action-btn svg {
        width: 14px;
        height: 14px;
      }

      .toggle-wrapper {
         background: rgba(20, 19, 20, 0.95);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        padding: 6px;
        display: flex;
        gap: 4px;
        pointer-events: auto;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
        font-family: 'Inter', system-ui, sans-serif;
      }
      .drag-handle {
        cursor: move;
        padding: 4px 6px;
        color: rgba(255,255,255,0.2);
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        transition: color 0.15s ease;
      }
      .drag-handle:hover {
        color: rgba(255,255,255,0.5);
      }
      .toggle-btn {
        background: transparent;
        border: none;
        color: rgba(255,255,255,0.4);
        padding: 7px 14px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        transition: all 0.2s ease;
        letter-spacing: 0.2px;
        white-space: nowrap;
      }
      .toggle-btn:hover {
        color: rgba(255,255,255,0.7);
        background: rgba(255,255,255,0.05);
      }
      .toggle-btn.active {
         background: #b22b2d;
        color: #fff;
         box-shadow: 0 2px 8px rgba(178,43,45,0.35);
      }
      
      .comment-popup {
        position: fixed;
         background: rgba(20, 19, 20, 0.97);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px;
        padding: 14px;
        width: 300px;
        max-width: calc(100vw - 20px);
        max-height: calc(100vh - 20px);
        overflow: auto;
        z-index: 10000;
        pointer-events: auto;
        box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05);
        display: none;
        font-family: 'Inter', system-ui, sans-serif;
        animation: popupIn 0.15s ease-out;
      }
      @keyframes popupIn {
        from { opacity: 0; transform: scale(0.95) translateY(4px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .comment-popup textarea {
        width: 100%;
        height: 80px;
        background: rgba(0,0,0,0.4);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        color: #fff;
        padding: 10px 12px;
        font-family: 'Inter', system-ui, sans-serif;
        font-size: 13px;
        resize: none;
        box-sizing: border-box;
        transition: border-color 0.2s ease;
        line-height: 1.5;
      }
      .comment-popup textarea::placeholder {
        color: rgba(255,255,255,0.25);
      }
      .comment-popup textarea:focus {
        outline: none;
         border-color: #b22b2d;
         box-shadow: 0 0 0 3px rgba(178,43,45,0.2);
      }
      .comment-popup-hint {
        font-size: 10px;
        color: rgba(255,255,255,0.25);
        margin-top: 6px;
        text-align: right;
      }
      .comment-popup-hint kbd {
        background: rgba(255,255,255,0.08);
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 10px;
        font-family: inherit;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .comment-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 10px;
      }
      .btn {
        padding: 7px 16px;
        border-radius: 8px;
        border: none;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
        font-family: 'Inter', system-ui, sans-serif;
        letter-spacing: 0.2px;
      }
      .btn:hover { transform: translateY(-1px); }
      .btn:active { transform: translateY(0); }
      .btn-primary { 
         background: #b22b2d;
        color: white; 
         box-shadow: 0 2px 8px rgba(178,43,45,0.3);
      }
      .btn-primary:hover {
         background: #d44846;
         box-shadow: 0 4px 12px rgba(178,43,45,0.4);
      }
      .btn-secondary { 
        background: rgba(255,255,255,0.06); 
        color: rgba(255,255,255,0.6);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .btn-secondary:hover {
        background: rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.8);
      }

      /* Comment Display Popup (Read Mode) */
      .comment-display {
        position: fixed;
         background: rgba(20, 19, 20, 0.95);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(255,255,255,0.15);
         border-left: 3px solid #b22b2d;
        border-radius: 6px;
        padding: 10px 14px;
        max-width: 250px;
        max-height: calc(100vh - 20px);
        overflow: auto;
        pointer-events: auto;
        color: rgba(255,255,255,0.9);
        z-index: 999999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        font-family: 'Inter', system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        word-wrap: break-word;
        transition: opacity 0.2s ease, transform 0.2s ease;
        display: none;
      }

      /* Delete confirmation tooltip */
      .delete-confirm {
        position: fixed;
         background: rgba(20, 19, 20, 0.97);
        backdrop-filter: blur(12px);
         border: 1px solid rgba(178, 43, 45, 0.4);
        border-radius: 10px;
        padding: 12px 16px;
        z-index: 2147483647;
        pointer-events: auto;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        font-family: 'Inter', system-ui, sans-serif;
        font-size: 12px;
        color: rgba(255,255,255,0.8);
        animation: popupIn 0.12s ease-out;
      }
      .delete-confirm-text {
        margin-bottom: 10px;
        font-weight: 500;
      }
      .delete-confirm-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      .btn-danger {
        padding: 5px 14px;
        border-radius: 6px;
        border: none;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
         background: #b22b2d;
        color: white;
        transition: all 0.15s ease;
        font-family: 'Inter', system-ui, sans-serif;
      }
      .btn-danger:hover {
         background: #d44846;
      }
      .btn-cancel-sm {
        padding: 5px 14px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.1);
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        background: transparent;
        color: rgba(255,255,255,0.5);
        transition: all 0.15s ease;
        font-family: 'Inter', system-ui, sans-serif;
      }
      .btn-cancel-sm:hover {
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.8);
      }
    `;
    this.shadow.appendChild(style);
  }

  private createBoxElements() {
    const createBox = (color: string) => {
      const div = document.createElement('div');
      div.className = 'box';
      div.style.borderStyle = 'solid';
      div.style.borderColor = color;
      this.shadow.appendChild(div);
      return div;
    };
    
     this.marginDiv = createBox('rgba(95, 87, 87, 0.65)');
     this.borderDiv = createBox('rgba(178, 43, 45, 0.78)');
     this.paddingDiv = createBox('rgba(211, 102, 96, 0.55)');
    
    this.contentDiv = document.createElement('div');
    this.contentDiv.className = 'box';
     this.contentDiv.style.backgroundColor = 'rgba(178, 43, 45, 0.32)';
    this.shadow.appendChild(this.contentDiv);

    this.noteDiv = document.createElement('div');
    this.noteDiv.className = 'tag-note';
    this.shadow.appendChild(this.noteDiv);
  }

  private toolbarContainer!: HTMLElement;
  private commentsIsland!: HTMLElement;

  private createUIElements() {
    this.toolbarContainer = document.createElement('div');
    this.toolbarContainer.className = 'toolbar-container';
    this.statusDiv = document.createElement('div');
    this.statusDiv.className = 'status-message';
    this.statusDiv.setAttribute('role', 'status');
    this.statusDiv.hidden = true;
    this.toolbarContainer.appendChild(this.statusDiv);
    
    this.commentsIsland = document.createElement('div');
    this.commentsIsland.className = 'comments-island';
    this.toolbarContainer.appendChild(this.commentsIsland);

    const toggleWrapper = document.createElement('div');
    toggleWrapper.className = 'toggle-wrapper';
    
    const dragHandle = document.createElement('div');
    dragHandle.className = 'drag-handle';
    dragHandle.innerHTML = '⋮⋮';
     dragHandle.title = 'Drag toolbar';
    toggleWrapper.appendChild(dragHandle);

    this.readBtn = document.createElement('button');
    this.readBtn.className = 'toggle-btn active';
    this.readBtn.innerText = 'Browse';
    
    this.editModeBtn = document.createElement('button');
    this.editModeBtn.className = 'toggle-btn';
    this.editModeBtn.innerText = 'Edit Mode';
    
    this.commentsToggleBtn = document.createElement('button');
    this.commentsToggleBtn.className = 'toggle-btn';
    this.commentsToggleBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
     this.commentsToggleBtn.title = 'Show comments';
    
    this.teamToggleBtn = document.createElement('button');
    this.teamToggleBtn.className = 'toggle-btn';
    this.teamToggleBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>';
     this.teamToggleBtn.title = 'Team mode';

    this.teamUI = new TeamUIManager();
    this.teamUI.onTeamChanged = () => { void this.loadComments(); };
    this.toolbarContainer.appendChild(this.teamUI.container);

    this.readBtn.onclick = () => {
      this.isEditMode = false;
      this.readBtn.classList.add('active');
      this.editModeBtn.classList.remove('active');
      this.hideBoxModel();
      this.closeCommentInput();
      log.debug('Switched to Read Mode');
    };
    
    this.editModeBtn.onclick = () => {
      this.navigation.abort();
      this.hideCommentDisplay();
      this.flashCleanup?.();
      this.isEditMode = true;
      this.editModeBtn.classList.add('active');
      this.readBtn.classList.remove('active');
      log.debug('Switched to Edit Mode');
    };

    this.commentsToggleBtn.onclick = () => {
      if (this.commentsIsland.style.display === 'block') {
        this.closeIsland();
      } else {
        this.closeIsland(); // Ensure any other open islands are closed first
        this.renderCommentsIsland();
        this.commentsIsland.style.display = 'block';
        this.commentsToggleBtn.classList.add('active');

        const rect = toggleWrapper.getBoundingClientRect();
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        
        const spaceRight = window.innerWidth - rect.right;
        
        if (spaceRight < 300) {
          this.commentsIsland.style.right = '0';
          this.commentsIsland.style.left = 'auto';
        } else {
          this.commentsIsland.style.left = '0';
          this.commentsIsland.style.right = 'auto';
        }
        
        if (spaceAbove > 320 || spaceAbove > spaceBelow) {
           this.commentsIsland.style.bottom = '100%';
           this.commentsIsland.style.marginBottom = '12px';
           this.commentsIsland.style.top = 'auto';
           this.commentsIsland.style.marginTop = '0';
        } else {
           this.commentsIsland.style.top = '100%';
           this.commentsIsland.style.marginTop = '12px';
           this.commentsIsland.style.bottom = 'auto';
           this.commentsIsland.style.marginBottom = '0';
        }
      }
    };
    
    this.teamToggleBtn.onclick = () => {
      if (this.teamUI.container.style.display === 'block') {
        this.teamUI.container.style.display = 'none';
        this.teamUI.stopPolling();
        this.teamToggleBtn.classList.remove('active');
      } else {
        this.closeIsland();
        this.teamUI.render();
        this.teamUI.container.style.display = 'block';
        this.teamToggleBtn.classList.add('active');

        const rect = toggleWrapper.getBoundingClientRect();
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceRight = window.innerWidth - rect.right;
        
        if (spaceRight < 300) {
          this.teamUI.container.style.right = '0';
          this.teamUI.container.style.left = 'auto';
        } else {
          this.teamUI.container.style.left = '0';
          this.teamUI.container.style.right = 'auto';
        }
        
        if (spaceAbove > 320 || spaceAbove > spaceBelow) {
           this.teamUI.container.style.bottom = '100%';
           this.teamUI.container.style.marginBottom = '12px';
           this.teamUI.container.style.top = 'auto';
           this.teamUI.container.style.marginTop = '0';
        } else {
           this.teamUI.container.style.top = '100%';
           this.teamUI.container.style.marginTop = '12px';
           this.teamUI.container.style.bottom = 'auto';
           this.teamUI.container.style.marginBottom = '0';
        }
      }
    };
    
    toggleWrapper.appendChild(this.teamToggleBtn);
    toggleWrapper.appendChild(this.readBtn);
    toggleWrapper.appendChild(this.editModeBtn);
    toggleWrapper.appendChild(this.commentsToggleBtn);
    this.toolbarContainer.appendChild(toggleWrapper);
    
    this.shadow.appendChild(this.toolbarContainer);
    this.setupDragging(dragHandle, this.toolbarContainer);

    this.commentInputPopup = document.createElement('div');
    this.commentInputPopup.className = 'comment-popup';
    
    this.textarea = document.createElement('textarea');
    this.textarea.placeholder = 'Write a comment on this element...';
    
    const hint = document.createElement('div');
    hint.className = 'comment-popup-hint';
     hint.innerHTML = '<kbd>Ctrl+Enter</kbd> save · <kbd>Esc</kbd> cancel';

    const actions = document.createElement('div');
    actions.className = 'comment-actions';
    
    this.cancelBtn = document.createElement('button');
    this.cancelBtn.className = 'btn btn-secondary';
    this.cancelBtn.innerText = 'Cancel';
    this.cancelBtn.onclick = () => {
      this.closeCommentInput();
    };
    
    this.saveBtn = document.createElement('button');
    this.saveBtn.className = 'btn btn-primary';
    this.saveBtn.innerText = 'Save';
    this.saveBtn.onclick = () => this.saveComment();

    actions.appendChild(this.cancelBtn);
    actions.appendChild(this.saveBtn);
    
    this.commentInputPopup.appendChild(this.textarea);
    this.commentInputPopup.appendChild(hint);
    this.commentInputPopup.appendChild(actions);
    
    this.commentInputPopup.addEventListener('click', (e) => e.stopPropagation());
    this.commentInputPopup.addEventListener('mousedown', (e) => e.stopPropagation());
    this.commentInputPopup.addEventListener('keydown', (e) => e.stopPropagation());
    this.commentInputPopup.addEventListener('keyup', (e) => e.stopPropagation());
    this.commentInputPopup.addEventListener('keypress', (e) => e.stopPropagation());
    
    this.commentDisplayPopup = document.createElement('div');
    this.commentDisplayPopup.className = 'comment-display';
    this.shadow.appendChild(this.commentDisplayPopup);
    
    this.shadow.appendChild(this.commentInputPopup);
    this.commentsToggleBtn.setAttribute('aria-label', 'Show comments');
    this.teamToggleBtn.setAttribute('aria-label', 'Team mode');
    this.textarea.setAttribute('aria-label', 'Comment');
  }

  private showStatus(message: string): void {
    if (this.disposed) return;
    this.statusDiv.textContent = message;
    this.statusDiv.hidden = !message;
  }

  /** Close island and sync toggle button state */
  private closeIsland(): void {
    this.commentsIsland.style.display = 'none';
    this.commentsToggleBtn.classList.remove('active');
    if (this.teamUI && this.teamUI.container) {
      this.teamUI.stopPolling();
      this.teamUI.container.style.display = 'none';
      this.teamToggleBtn.classList.remove('active');
    }
  }

  private closeCommentInput(): void {
    if (this.saving) return;
    this.commentInputPopup.style.display = 'none';
    this.currentActiveElementForComment = null;
    this.editingComment = null;
    this.saveBtn.innerText = 'Save';
  }

  private setupDragging(dragHandle: HTMLElement, target: HTMLElement) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;
      
      const rect = target.getBoundingClientRect();
      if (newLeft < 0) newLeft = 0;
      if (newTop < 0) newTop = 0;
      if (newLeft + rect.width > window.innerWidth) newLeft = window.innerWidth - rect.width;
      if (newTop + rect.height > window.innerHeight) newTop = window.innerHeight - rect.height;
      
      target.style.left = newLeft + 'px';
      target.style.top = newTop + 'px';
      target.style.right = 'auto';
      target.style.bottom = 'auto';
    };

    const onMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
    };

    dragHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = target.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      
      target.style.right = 'auto';
      target.style.bottom = 'auto';
      target.style.left = initialLeft + 'px';
      target.style.top = initialTop + 'px';
      
      document.addEventListener('mousemove', onMouseMove, { signal: this.lifetime.signal });
      document.addEventListener('mouseup', onMouseUp, { signal: this.lifetime.signal });
      
      e.stopPropagation();
      e.preventDefault();
    });
  }

  private bindEvents() {
    const interrupt = (event: Event) => {
      if (this.navigationInProgress && !event.composedPath().includes(this.container)) this.navigation.abort();
    };
    window.addEventListener('wheel', interrupt, { capture: true, passive: true, signal: this.lifetime.signal });
    window.addEventListener('touchstart', interrupt, { capture: true, passive: true, signal: this.lifetime.signal });
    window.addEventListener('mousemove', this.boundOnMouseMove, { capture: true, passive: true });
    window.addEventListener('scroll', this.boundOnScroll, { capture: true, passive: true });
    window.addEventListener('mousedown', this.boundOnMouseAction, { capture: true });
    window.addEventListener('mouseup', this.boundOnMouseAction, { capture: true });
    window.addEventListener('click', this.boundOnClick, { capture: true });
    document.addEventListener('mouseleave', this.boundOnMouseLeave);
    window.addEventListener('keydown', this.boundOnKeyDown, { capture: true });
    window.addEventListener('keyup', this.boundOnKeyUp, { capture: true });
    window.addEventListener('resize', this.boundOnResize);
  }

  private onMouseLeave() {
    
    if (this.isEditMode && this.commentInputPopup.style.display === 'none') {
       this.hideBoxModel();
    }
    this.lastTarget = null;
  }

  public destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.navigation.abort();
    this.lifetime.abort();
    clearInterval(this.urlTimer);
    this.rootObserver?.disconnect();
    chrome.storage.onChanged.removeListener(this.onStorageChanged);
    clearInterval(this.commentsPoll);
    this.teamUI.destroy();
    this.hideCommentDisplay();
    this.flashCleanup?.();
    sessionStorage.removeItem('pinokio_scroll_to');
    sessionStorage.removeItem('pinokio_scroll_reload');
    log.info('Destroying PinokioOverlay');
    sessionStorage.removeItem('pinokio_overlay_active');
    window.removeEventListener('mousemove', this.boundOnMouseMove, { capture: true } as EventListenerOptions);
    window.removeEventListener('scroll', this.boundOnScroll, { capture: true } as EventListenerOptions);
    window.removeEventListener('mousedown', this.boundOnMouseAction, { capture: true } as EventListenerOptions);
    window.removeEventListener('mouseup', this.boundOnMouseAction, { capture: true } as EventListenerOptions);
    window.removeEventListener('click', this.boundOnClick, { capture: true } as EventListenerOptions);
    document.removeEventListener('mouseleave', this.boundOnMouseLeave);
    window.removeEventListener('keydown', this.boundOnKeyDown, { capture: true } as EventListenerOptions);
    window.removeEventListener('keyup', this.boundOnKeyUp, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', this.boundOnResize);
    
    if (this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  }

  private async loadComments() {
    const version = ++this.loadVersion;
    try {
    const team = await getActiveTeam();
    if (this.disposed || version !== this.loadVersion) return;
    if ((team?.id || null) !== this.subscribedTeam) {
      clearInterval(this.commentsPoll);
      this.subscribedTeam = team?.id || null;
      this.comments = [];
      if (team) this.commentsPoll = setInterval(() => {
        if (!this.disposed && document.visibilityState === 'visible') void this.loadComments();
      }, 5000);
    }
    if (team) {
      const sbComments = await getTeamComments(team.id, window.location.origin);
      if (this.disposed || version !== this.loadVersion) return;
      this.comments = sbComments.map(c => ({
        id: c.id,
        selector: c.selector,
        url: c.url,
        comment: c.comment,
        createdAt: c.created_at,
        fallbackSelectors: c.fallback_selectors,
        textContentFallback: c.text_content_fallback,
        activeNavLabel: c.active_nav_label,
        activeNavIndex: c.active_nav_index,
        activeNavGroupSize: c.active_nav_group_size,
        activeNavGroupPosition: c.active_nav_group_position,
        user: c.users,
        userId: c.user_id
      }));
    } else {
      const key = this.getStorageKey();
      const result = await chrome.storage.local.get(key);
      if (this.disposed || version !== this.loadVersion) return;
      this.comments = Array.isArray(result[key]) ? result[key] as CommentData[] : [];
    }
    if (this.commentsIsland.style.display === 'block') this.renderCommentsIsland();
    this.checkPendingScroll();
    } catch (error) {
      if (!this.disposed && version === this.loadVersion) this.showStatus('Could not load comments. Check your connection and team access.');
      log.error('Could not load comments', error);
    }
  }

  // ─── COMMENT DELETION ─────────────────────────────────────────────────────

  private async deleteComment(c: CommentData): Promise<void> {
    try {
    const team = await getActiveTeam();
    const user = await getLocalUserProfile();
    if (team) {
      if (!user || !await deleteTeamComment(c.id || c.createdAt, user.id, team.admin_id)) {
        throw new Error('Could not delete the comment.');
      }
    } else {
      await mutateLocalComment('delete', c.id || c.createdAt);
    }
    this.hideCommentDisplay();
    await this.loadComments();
    } catch (error) { this.showStatus('Could not delete the comment. Check your connection and permissions.'); log.error('Delete failed', error); }
  }

  // ─── KEYBOARD HANDLERS ────────────────────────────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    // Ctrl+Enter / Cmd+Enter to save comment
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (this.commentInputPopup.style.display === 'block') {
        e.preventDefault();
        e.stopPropagation();
        this.saveComment();
        return;
      }
    }
    
    // Escape key handling
    if (e.key === 'Escape') {
      const hasUI = this.isEditMode || this.navigationInProgress ||
        this.commentInputPopup.style.display === 'block' || this.displayTarget ||
        this.commentsIsland.style.display === 'block' || this.teamUI.container.style.display === 'block';
      if (!hasUI) return;
      e.preventDefault();
      e.stopPropagation();
      this.navigation.abort();
      this.hideCommentDisplay();
      this.flashCleanup?.();
      
      // First: close comment input popup if open
      if (this.commentInputPopup.style.display === 'block') {
        this.closeCommentInput();
        return;
      }
      // Third: close comments island if open
      if (this.commentsIsland.style.display === 'block' || this.teamUI.container.style.display === 'block') {
        this.closeIsland();
        return;
      }
      
      // Fourth: if in edit mode, switch to browse and hide overlay
      if (this.isEditMode) {
        this.isEditMode = false;
        this.hideBoxModel();
        this.readBtn.classList.add('active');
        this.editModeBtn.classList.remove('active');
        return;
      }
      
      return;
    }
    
    // Shift key for parent element selection
    if (e.key === 'Shift' && this.isEditMode && this.commentInputPopup.style.display !== 'block') {
      if (this.lastTarget) {
        if (!this.shiftHeldTarget || this.shiftHeldTarget !== this.lastTarget) {
          this.shiftHeldTarget = this.lastTarget;
          this.shiftDepth = 0;
        }
        
        this.shiftDepth++;
        let current: HTMLElement | null = this.shiftHeldTarget;
        
        for (let i = 0; i < this.shiftDepth; i++) {
          if (current?.parentElement && current.parentElement !== document.body && current.parentElement !== document.documentElement) {
            current = current.parentElement;
          } else {
            break;
          }
        }
        
        if (current && current !== document.body && current !== document.documentElement) {
          this.lastTarget = current;
          this.showBoxModel();
          this.updateBoxModel(current);
        }
      }
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') {
      this.shiftHeldTarget = null;
      this.shiftDepth = 0;
    }
  }

  // ─── RESIZE HANDLER ───────────────────────────────────────────────────────

  private onResize(): void {
    this.updateCommentInputPosition();
    this.updateCommentDisplayPosition();
    
    // Update edit-mode box model overlay
    if (this.lastTarget && this.marginDiv.style.display !== 'none') {
      this.updateBoxModel(this.lastTarget);
    }
  }

  // ─── COMMENTS ISLAND ──────────────────────────────────────────────────────

  private async renderCommentsIsland() {
    const version = ++this.renderVersion;
     this.commentsIsland.innerHTML = '<div class="comments-island-header">Comments</div>';

    const currentUser = await getLocalUserProfile();
    const activeTeam = await getActiveTeam();
    if (this.disposed || version !== this.renderVersion) return;

    if (this.comments.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = 'rgba(255,255,255,0.3)';
      empty.style.fontSize = '12px';
      empty.style.padding = '20px 16px';
      empty.style.textAlign = 'center';
       empty.innerText = 'No comments yet.';
      this.commentsIsland.appendChild(empty);
      return;
    }

    const currentPath = window.location.pathname + window.location.search + window.location.hash;
    
    this.comments.forEach(c => {
      const item = document.createElement('div');
      item.className = 'island-comment-item';
      
      const content = document.createElement('div');
      content.className = 'island-comment-content';
      
       let avatarHtml = '<div class="island-comment-avatar">You</div>';
       let nameStr = 'You';
      if (c.user) {
        avatarHtml = `<img referrerpolicy="no-referrer" src="${imageURL(c.user.avatar_url)}" alt="" width="24" height="24" style="border-radius:50%; object-fit:cover;">`;
        nameStr = escapeHTML(c.user.display_name);
      }
      
      const author = document.createElement('div');
      author.className = 'island-comment-author';
      author.innerHTML = `${avatarHtml}<div class="island-comment-name" style="font-size:12px; font-weight:600; margin-left:8px;">${nameStr}</div>`;
      author.style.display = 'flex';
      author.style.alignItems = 'center';
      author.style.marginBottom = '4px';
      
      const text = document.createElement('div');
      text.className = 'island-comment-text';
      text.innerText = c.comment;
      
      const date = document.createElement('div');
      date.className = 'island-comment-date';
      date.innerText = new Date(c.createdAt).toLocaleString('en-US');

      let cPath = '';
      try {
        const cUrl = new URL(c.url);
        cPath = cUrl.pathname + cUrl.search + cUrl.hash;
      } catch {
        cPath = c.url;
      }

      content.appendChild(author);
      content.appendChild(text);

      if (cPath !== currentPath) {
        const urlBadge = document.createElement('div');
        urlBadge.className = 'island-comment-url';
        urlBadge.innerText = cPath;
        content.appendChild(urlBadge);
      }

      content.appendChild(date);
      
      let canEdit = false;
      let canDelete = false;

      if (currentUser && activeTeam) {
        if (c.userId === currentUser.id) {
          canEdit = true;
          canDelete = true;
        } else if (activeTeam.admin_id === currentUser.id) {
          canDelete = true; // Admin can delete, but not edit
        }
      } else if (!activeTeam) {
        // Local mode, they own all their local comments
        canEdit = true;
        canDelete = true;
      }

      if (canEdit || canDelete) {
        const actions = document.createElement('div');
        actions.className = 'island-comment-actions';
        
        if (canEdit) {
          const editBtn = document.createElement('button');
          editBtn.className = 'island-action-btn';
           editBtn.title = 'Edit';
          editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.startEditFromIsland(c);
          });
          actions.appendChild(editBtn);
        }
        
        if (canDelete) {
          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'island-action-btn delete-btn';
           deleteBtn.title = 'Delete';
          deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
          deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.showDeleteConfirmation(c, deleteBtn);
          });
          actions.appendChild(deleteBtn);
        }
        
        item.appendChild(content);
        item.appendChild(actions);
      } else {
        item.appendChild(content);
      }
      
      // Click on the content area navigates to the comment (shows selector + comment locked)
      content.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.navigateToComment(c);
      });
      content.tabIndex = 0;
      content.setAttribute('role', 'button');
      content.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); void this.navigateToComment(c);
        }
      });

      this.commentsIsland.appendChild(item);
    });
  }

  private showDeleteConfirmation(c: CommentData, anchor: HTMLElement): void {
    // Remove any existing confirmation
    const existing = this.shadow.querySelector('.delete-confirm');
    if (existing) existing.remove();
    
    const confirm = document.createElement('div');
    confirm.className = 'delete-confirm';
    
    const text = document.createElement('div');
    text.className = 'delete-confirm-text';
     text.innerText = 'Are you sure you want to delete this comment?';
    
    const actions = document.createElement('div');
    actions.className = 'delete-confirm-actions';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel-sm';
     cancelBtn.innerText = 'Cancel';
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      confirm.remove();
    };
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-danger';
     deleteBtn.innerText = 'Delete';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      confirm.remove();
      this.deleteComment(c);
    };
    
    actions.appendChild(cancelBtn);
    actions.appendChild(deleteBtn);
    
    confirm.appendChild(text);
    confirm.appendChild(actions);
    
    // Position near the anchor
    const rect = anchor.getBoundingClientRect();
    confirm.style.top = (rect.bottom + 4) + 'px';
    confirm.style.right = (window.innerWidth - rect.right) + 'px';
    
    confirm.addEventListener('click', (e) => e.stopPropagation());
    
    this.shadow.appendChild(confirm);
    
    // Auto-close after 5 seconds
    setTimeout(() => {
      if (confirm.parentNode) confirm.remove();
    }, 5000);
  }

  private async startEditFromIsland(c: CommentData): Promise<void> {
    this.closeIsland();
    const operation = this.navigateToComment(c);
    const controller = this.navigation;
    await operation;
    if (this.disposed || this.navigation !== controller || controller.signal.aborted || !this.displayTarget) return;
    const el = this.displayTarget;
    this.hideCommentDisplay();
    this.isEditMode = true;
    this.editModeBtn.classList.add('active');
    this.readBtn.classList.remove('active');
    this.currentActiveElementForComment = el;
    this.editingComment = c;
    this.lastTarget = el;
    this.showBoxModel();
    this.updateBoxModel(el);
    this.textarea.value = c.comment;
    this.saveBtn.innerText = 'Update';
    this.openCommentInput(el);
  }

  private detectActiveNavLabel(): string {
    const context = this.detectActiveNavContext();
    if (context?.label) return context.label;

    log.debug('Active nav label could not be detected', { context });
    return '';
  }


  private async saveComment() {
    if (this.saving || !this.currentActiveElementForComment?.isConnected) return;
    const text = this.textarea.value.trim();
    if (!text) return;
    this.saving = true;
    this.saveBtn.disabled = true;
    this.cancelBtn.disabled = true;
    const editing = this.editingComment;
    try {
      const primary = resolveSelector(this.currentActiveElementForComment);
      const fallbacks = buildFallbackChain(this.currentActiveElementForComment, primary.selector);
      const textContentFallback = extractTextContentFallback(this.currentActiveElementForComment);
      const url = this.getCurrentFullUrl();

      log.info('Saving comment', { selector: primary.selector, confidence: primary.confidence, url });

      const activeNavContext = this.detectActiveNavContext();
      const activeNavLabel = activeNavContext?.label || this.detectActiveNavLabel();
      const user = await getLocalUserProfile();
      const team = await getActiveTeam();
      if (team && (!user || (editing && editing.userId !== user.id))) throw new Error('You can only edit your own team comments.');
      const savedComment: CommentData = {
          id: editing?.id || editing?.createdAt || crypto.randomUUID(),
          selector: primary.selector,
          fallbackSelectors: fallbacks.map(f => f.selector),
          textContentFallback,
          url,
          comment: text,
          createdAt: editing?.createdAt || new Date().toISOString(),
          activeNavLabel: activeNavLabel || undefined,
          activeNavIndex: activeNavContext?.index,
          activeNavGroupSize: activeNavContext?.groupSize,
          activeNavGroupPosition: activeNavContext?.groupPosition,
          userId: user?.id,
          user: user ? { display_name: user.display_name, avatar_url: user.avatar_url } : undefined,
      };
        if (team && user) {
           const saved = await insertTeamComment({
              id: savedComment.id!,
              team_id: team.id,
              user_id: user.id,
              url: savedComment.url,
              selector: savedComment.selector,
              comment: savedComment.comment,
              fallback_selectors: savedComment.fallbackSelectors,
              text_content_fallback: savedComment.textContentFallback,
              active_nav_label: savedComment.activeNavLabel,
              active_nav_index: savedComment.activeNavIndex,
              active_nav_group_size: savedComment.activeNavGroupSize,
              active_nav_group_position: savedComment.activeNavGroupPosition,
              created_at: savedComment.createdAt
            }, user.id);
           if (!saved) throw new Error('Could not sync the comment. Your draft is still open; check your connection and try again.');
        } else {
          await mutateLocalComment('upsert', savedComment.id!, savedComment);
        }
      if (!this.disposed) {
        this.saving = false;
        this.closeCommentInput();
        this.hideBoxModel();
        this.isEditMode = false;
        this.readBtn.classList.add('active');
        this.editModeBtn.classList.remove('active');
        this.showStatus('');
        await this.loadComments();
      }
    } catch (err) {
      log.error('Could not save comment', { error: err });
      this.showStatus(err instanceof Error ? err.message : 'Could not save the comment. Your draft has been kept.');
    } finally {
      this.saving = false;
      this.saveBtn.disabled = false;
      this.cancelBtn.disabled = false;
    }
  }

  private isCommentForCurrentPage(c: CommentData): boolean {
    return samePage(c.url, this.getCurrentFullUrl());
  }

  private getCommentForElement(el: HTMLElement): CommentData | undefined {
    for (const c of this.comments) {
      if (!this.isCommentForCurrentPage(c)) continue;
      
      try {
        if (el.matches && el.matches(c.selector)) return c;
        if (c.fallbackSelectors) {
          for (const fallback of c.fallbackSelectors) {
            try {
               if (el.matches && el.matches(fallback)) return c;
            } catch(e) {}
          }
        }
        if (c.textContentFallback) {
           if (el.tagName.toLowerCase() === c.textContentFallback.tagName && el.textContent?.trim() === c.textContentFallback.text) {
              const matchedFallback = findByTextContentFallback(c.textContentFallback);
              if (matchedFallback === el) return c;
           }
        }
      } catch (e) {}
    }
    return undefined;
  }

  private onMouseAction(e: MouseEvent) {
    if (e.target === this.container || (e.composedPath && e.composedPath().includes(this.container))) return;
    if (this.isEditMode) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private onClick(e: MouseEvent) {
    if (e.target === this.container || (e.composedPath && e.composedPath().includes(this.container))) {
      return;
    }

    // Close display popup on any outside click
    if (this.commentDisplayPopup && this.commentDisplayPopup.style.display === 'block') {
      this.hideCommentDisplay();
    }

    // In browse mode, just ignore clicks unless they are on our UI
    if (!this.isEditMode) {
      return;
    }

    if (this.isEditMode) {
      e.preventDefault();
      e.stopPropagation();

      if (this.commentInputPopup.style.display === 'block') {
        this.closeCommentInput();
        return;
      }

      const target = (e.shiftKey && this.lastTarget) || document.elementFromPoint(e.clientX, e.clientY) as HTMLElement;
      if (!target || target === document.documentElement || target === document.body) return;

      this.currentActiveElementForComment = target;
      this.editingComment = null;
      
      // Check if element has existing comment, pre-fill for editing
      const existing = this.getCommentForElement(target);
      if (existing && (!existing.userId || !this.subscribedTeam)) {
        this.editingComment = existing;
        this.textarea.value = existing.comment;
        this.saveBtn.innerText = 'Update';
      } else {
        this.textarea.value = '';
        this.saveBtn.innerText = 'Save';
      }
      
      this.openCommentInput(target);
    }
  }

  private openCommentInput(el: HTMLElement) {
    this.currentActiveElementForComment = el;
    this.commentInputPopup.style.display = 'block';
    this.updateCommentInputPosition();
    this.textarea.focus({ preventScroll: true });
  }

  private showCommentDisplay(c: CommentData, el: HTMLElement) {
    if (!this.commentDisplayPopup) return;
    this.hideCommentDisplay();
    this.displayTarget = el;
    this.displayedComment = c;
    if (c.user) {
      this.commentDisplayPopup.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <img referrerpolicy="no-referrer" src="${imageURL(c.user.avatar_url)}" alt="" width="20" height="20" style="border-radius:50%; object-fit:cover;">
          <span style="font-weight:600; font-size:12px;">${escapeHTML(c.user.display_name)}</span>
        </div>
        <div style="font-size:14px; white-space:pre-wrap;">${escapeHTML(c.comment)}</div>
      `;
    } else {
      this.commentDisplayPopup.innerText = c.comment;
    }
    this.commentDisplayPopup.style.display = 'block';
    this.updateCommentDisplayPosition();
    const track = () => {
      if (!this.displayTarget || this.disposed) return;
      this.updateCommentDisplayPosition();
      if (this.displayTarget) this.displayFrame = requestAnimationFrame(track);
    };
    this.displayFrame = requestAnimationFrame(track);
  }

  private hideCommentDisplay() {
    cancelAnimationFrame(this.displayFrame);
    this.displayTarget = null;
    this.displayedComment = null;
    if (this.commentDisplayPopup) this.commentDisplayPopup.style.display = 'none';
  }

  private updateCommentDisplayPosition() {
    if (!this.commentDisplayPopup || !this.displayTarget) return;
    
    let el = this.displayTarget;
    if (!el.isConnected) {
      const replacement = this.displayedComment && this.isCommentForCurrentPage(this.displayedComment) &&
        this.findElementForComment(this.displayedComment);
      if (!replacement) { this.hideCommentDisplay(); return; }
      el = this.displayTarget = replacement;
    }
    const rect = visibleRect(el);

    // The card belongs to the element; never pin it to a viewport edge after
    // the target has scrolled out of view in either direction.
    if (!rect) {
      this.hideCommentDisplay();
      return;
    }
    
    // Position below the element
    let left = rect.left;
    let top = rect.bottom + 8;
    
    // Adjust if goes off screen
    const width = this.commentDisplayPopup.offsetWidth;
    const height = this.commentDisplayPopup.offsetHeight;
    
    if (left + width > window.innerWidth) left = window.innerWidth - width - 10;
    if (top + height > window.innerHeight) top = rect.top - height - 8;
    
    if (left < 0) left = 10;
    if (top < 0) top = 10;
    
    this.commentDisplayPopup.style.left = left + 'px';
    this.commentDisplayPopup.style.top = top + 'px';
  }

  private updateCommentInputPosition() {
    if (this.commentInputPopup.style.display !== 'block' || !this.currentActiveElementForComment) return;
    
    const el = this.currentActiveElementForComment;
    const rect = el.getBoundingClientRect();
    
    const popupWidth = this.commentInputPopup.offsetWidth;
    const popupHeight = this.commentInputPopup.offsetHeight;
    
    let left = 0;
    let top = 0;

    const spaceRight = window.innerWidth - rect.right;
    const spaceLeft = rect.left;
    const spaceBottom = window.innerHeight - rect.bottom;
    const spaceTop = rect.top;

    if (spaceRight >= popupWidth) {
      left = rect.right;
      top = rect.top;
    } else if (spaceLeft >= popupWidth) {
      left = rect.left - popupWidth;
      top = rect.top;
    } else if (spaceBottom >= popupHeight) {
      left = rect.left;
      top = rect.bottom;
    } else if (spaceTop >= popupHeight) {
      left = rect.left;
      top = rect.top - popupHeight;
    } else {
      left = (window.innerWidth - popupWidth) / 2;
      top = (window.innerHeight - popupHeight) / 2;
    }

    left = Math.max(0, Math.min(left, window.innerWidth - popupWidth));
    top = Math.max(0, Math.min(top, window.innerHeight - popupHeight));

    this.commentInputPopup.style.top = top + 'px';
    this.commentInputPopup.style.left = left + 'px';
  }

  private hideBoxModel() {
    this.marginDiv.style.display = 'none';
    this.borderDiv.style.display = 'none';
    this.paddingDiv.style.display = 'none';
    this.contentDiv.style.display = 'none';
    this.noteDiv.style.display = 'none';
  }

  private showBoxModel() {
    this.marginDiv.style.display = 'block';
    this.borderDiv.style.display = 'block';
    this.paddingDiv.style.display = 'block';
    this.contentDiv.style.display = 'block';
    this.noteDiv.style.display = 'block';
  }

  private handleHover(clientX: number, clientY: number, checkContainerPath?: boolean, eventPath?: EventTarget[]) {


    if (checkContainerPath && eventPath) {
      if (eventPath.includes(this.container)) {
         this.hideBoxModel();
         this.lastTarget = null;
         return;
      }
    }

    // ─── BROWSE MODE: no selectors on hover, ever ───
    if (!this.isEditMode) {
      this.hideBoxModel();
      return;
    }

    // ─── EDIT MODE below ───

    if (this.commentInputPopup.style.display === 'block') {
       if (this.lastTarget) this.updateBoxModel(this.lastTarget);
       return;
    }

    const target = document.elementFromPoint(clientX, clientY) as HTMLElement;
    
    if (!target || target === document.documentElement || target === document.body || this.container.contains(target)) {
       this.hideBoxModel();
       this.lastTarget = null;
       return;
    }

    if (target === this.lastTarget) {
       this.updateBoxModel(target);
       return;
    }

    this.lastTarget = target;
    // Reset shift depth when hovering a new element
    this.shiftHeldTarget = null;
    this.shiftDepth = 0;

    this.showBoxModel();
    this.updateBoxModel(target);
  }

  private onMouseMove(e: MouseEvent) {
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.handleHover(e.clientX, e.clientY, true, e.composedPath());
  }

  private onScroll() {
    this.updateCommentInputPosition();
    this.updateCommentDisplayPosition();

    if (this.lastMouseX < 0 || this.lastMouseY < 0) return;
    this.handleHover(this.lastMouseX, this.lastMouseY, false);
  }



  private updateBoxModel(el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    const mTop = parseFloat(style.marginTop) || 0;
    const mRight = parseFloat(style.marginRight) || 0;
    const mBottom = parseFloat(style.marginBottom) || 0;
    const mLeft = parseFloat(style.marginLeft) || 0;

    const bTop = parseFloat(style.borderTopWidth) || 0;
    const bRight = parseFloat(style.borderRightWidth) || 0;
    const bBottom = parseFloat(style.borderBottomWidth) || 0;
    const bLeft = parseFloat(style.borderLeftWidth) || 0;

    const pTop = parseFloat(style.paddingTop) || 0;
    const pRight = parseFloat(style.paddingRight) || 0;
    const pBottom = parseFloat(style.paddingBottom) || 0;
    const pLeft = parseFloat(style.paddingLeft) || 0;

    this.marginDiv.style.top = (rect.top - mTop) + 'px';
    this.marginDiv.style.left = (rect.left - mLeft) + 'px';
    this.marginDiv.style.width = (rect.width + mLeft + mRight) + 'px';
    this.marginDiv.style.height = (rect.height + mTop + mBottom) + 'px';
    this.marginDiv.style.borderWidth = `${mTop}px ${mRight}px ${mBottom}px ${mLeft}px`;

    this.borderDiv.style.top = rect.top + 'px';
    this.borderDiv.style.left = rect.left + 'px';
    this.borderDiv.style.width = rect.width + 'px';
    this.borderDiv.style.height = rect.height + 'px';
    this.borderDiv.style.borderWidth = `${bTop}px ${bRight}px ${bBottom}px ${bLeft}px`;

    this.paddingDiv.style.top = (rect.top + bTop) + 'px';
    this.paddingDiv.style.left = (rect.left + bLeft) + 'px';
    this.paddingDiv.style.width = (rect.width - bLeft - bRight) + 'px';
    this.paddingDiv.style.height = (rect.height - bTop - bBottom) + 'px';
    this.paddingDiv.style.borderWidth = `${pTop}px ${pRight}px ${pBottom}px ${pLeft}px`;

    this.contentDiv.style.top = (rect.top + bTop + pTop) + 'px';
    this.contentDiv.style.left = (rect.left + bLeft + pLeft) + 'px';
    this.contentDiv.style.width = Math.max(0, rect.width - bLeft - bRight - pLeft - pRight) + 'px';
    this.contentDiv.style.height = Math.max(0, rect.height - bTop - bBottom - pTop - pBottom) + 'px';

    let tag = el.tagName.toLowerCase();
    let idStr = el.id ? `<span class="id">#${escapeHTML(el.id)}</span>` : '';
    let classStr = el.className && typeof el.className === 'string' ? `<span class="class">.${escapeHTML(el.className.trim().split(/\s+/).join('.'))}</span>` : '';
    const elWidth = Math.round(rect.width * 100) / 100;
    const elHeight = Math.round(rect.height * 100) / 100;

    this.noteDiv.innerHTML = `<span class="tag">${tag}</span>${idStr}${classStr} <span class="dims">${elWidth} \u00d7 ${elHeight}</span>`;
    
    let noteTop = rect.top - mTop - 28;
    if (noteTop < 0) noteTop = rect.top - mTop + 8; 
    
    this.noteDiv.style.top = noteTop + 'px';
    this.noteDiv.style.left = (rect.left - mLeft) + 'px';
  }
}

export default PinokioOverlay;
