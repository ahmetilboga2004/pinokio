import { finder } from '@medv/finder'
import { createLogger } from './logger'

export interface SelectorResult {
  selector: string
  confidence: number
}

const log = createLogger('Selector')

const STABLE_ATTRIBUTES = ['data-testid', 'data-cy', 'data-qa', 'data-id', 'data-name']

// Strategy 5: Text content extraction for SPA finding
export interface TextContentFallback {
  tagName: string;
  text: string;
  index: number;
}

// Check if an element matches a selector uniquely within document
function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function isGeneratedToken(token: string): boolean {
  // Regex to catch common auto-generated patterns (React, Emotion, Styled Components, random hashes)
  const patterns = [/^css-/, /^sc-/, /^emotion-/, /^makeStyles-/, /^tss-/, /^Mui/, /^[a-f0-9]{8,}$/, /^__/, /^_[a-zA-Z0-9_-]+$/];
  return patterns.some((pattern) => pattern.test(token));
}

// Strategy 1: Find if element has a unique stable attribute
function tryStableAttributes(element: Element): string | null {
  for (const attr of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(attr);
    if (!value) continue;
    const selector = `[${attr}="${CSS.escape(value)}"]`;
    if (isUnique(selector)) {
      return selector;
    }
  }
  return null;
}

// Strategy 2: Find if element has a unique ID or class
function tryUniqueIdOrClass(element: Element): string | null {
  if (element.id && !isGeneratedToken(element.id)) {
    const selector = `#${CSS.escape(element.id)}`;
    if (isUnique(selector)) {
      return selector;
    }
  }

  // Check individual classes for uniqueness
  if (element.classList && element.classList.length > 0) {
    for (const cls of Array.from(element.classList)) {
      if (!isGeneratedToken(cls)) {
        const selector = `.${CSS.escape(cls)}`;
        if (isUnique(selector)) {
           return selector;
        }
      }
    }
  }

  return null;
}

// Strategy 3: Use @medv/finder with very strict uniqueness configuration
function tryFinder(element: Element): string | null {
  try {
    const selector = finder(element, {
      root: document.body,
      className: (name) => !isGeneratedToken(name),
      idName: (name) => !isGeneratedToken(name),
      tagName: () => true,
      attr: (name, value) => STABLE_ATTRIBUTES.includes(name) && Boolean(value),
      seedMinLength: 1,
      optimizedMinLength: 2,
      maxNumberOfPathChecks: 1000,
      timeoutMs: 1200,
    });
    if (selector && isUnique(selector)) {
      return selector;
    }
  } catch {
    // Ignore finder errors
  }
  return null;
}

// Strategy 4: Fallback to exact hierarchical DOM path (nth-child approach)
function buildExactDomPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement && current.tagName) {
    let tag = current.tagName.toLowerCase();
    
    // Stop early if we hit a unique ID or Stable Attribute on an ancestor to keep path short
    let foundStableParent = false;
    
    if (current.id && !isGeneratedToken(current.id)) {
      const idSelector = `#${CSS.escape(current.id)}`;
      if (isUnique(idSelector)) {
        parts.unshift(idSelector);
        foundStableParent = true;
        break;
      }
    }
    
    if (!foundStableParent) {
      for (const attr of STABLE_ATTRIBUTES) {
        const value = current.getAttribute(attr);
        if (value) {
          const attrSelector = `[${attr}="${CSS.escape(value)}"]`;
          if (isUnique(attrSelector)) {
            parts.unshift(tag + attrSelector); // tag[data-testid="val"]
            foundStableParent = true;
            break;
          }
        }
      }
    }

    if (!foundStableParent && current.classList && current.classList.length > 0) {
       for (const cls of Array.from(current.classList)) {
         if (!isGeneratedToken(cls)) {
           const clsSelector = `.${CSS.escape(cls)}`;
           if (isUnique(clsSelector)) {
             parts.unshift(tag + clsSelector);
             foundStableParent = true;
             break;
           }
         }
       }
    }

    if (foundStableParent) break;

    const parentElement: Element | null = current.parentElement;
    if (!parentElement) {
      parts.unshift(tag);
      break;
    }

    const currentTagName = current.tagName;
    const siblings = Array.from(parentElement.children);
    const sameTagSiblings = siblings.filter(node => node.tagName === currentTagName);
    
    if (sameTagSiblings.length > 1) {
      const index = sameTagSiblings.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
    } else {
      parts.unshift(tag);
    }

    current = parentElement;
  }

  return parts.join(' > ');
}


export function extractTextContentFallback(element: Element): TextContentFallback | null {
  const text = element.textContent?.trim();
  if (!text || text.length > 100) return null; // Ignore empty or huge text blocks

  const tagName = element.tagName.toLowerCase();
  
  try {
    // Find all elements with this tag and text to find our index
    const elements = Array.from(document.querySelectorAll(tagName)).filter(
      el => (el as HTMLElement).textContent?.trim() === text
    );
    
    const index = elements.indexOf(element);
    if (index === -1) return null;

    return { tagName, text, index };
  } catch {
    return null;
  }
}

export function findByTextContentFallback(fallback: TextContentFallback): HTMLElement | null {
  try {
    const elements = Array.from(document.querySelectorAll(fallback.tagName)).filter(
      el => (el as HTMLElement).textContent?.trim() === fallback.text
    );
    return (elements[fallback.index] as HTMLElement) || null;
  } catch {
    return null;
  }
}

export function resolveSelector(element: Element): SelectorResult {
  const fast = tryStableAttributes(element);
  if (fast) {
    log.debug('Resolved via stable attributes', { selector: fast });
    return { selector: fast, confidence: 100 };
  }

  const idOrClass = tryUniqueIdOrClass(element);
  if (idOrClass) {
    log.debug('Resolved via ID/class', { selector: idOrClass });
    return { selector: idOrClass, confidence: 95 };
  }

  const finderSel = tryFinder(element);
  if (finderSel) {
    log.debug('Resolved via @medv/finder', { selector: finderSel });
    return { selector: finderSel, confidence: 80 };
  }

  const domPath = buildExactDomPath(element);
  log.debug('Resolved via DOM path (fallback)', { selector: domPath });
  return { selector: domPath, confidence: 50 };
}

export function buildFallbackChain(element: Element, primarySelector: string): SelectorResult[] {
  const candidates: SelectorResult[] = [];

  const addCandidate = (selector: string | null, confidence: number) => {
    if (selector && selector !== primarySelector && isUnique(selector)) {
      candidates.push({ selector, confidence });
    }
  };

  addCandidate(tryStableAttributes(element), 100);
  addCandidate(tryUniqueIdOrClass(element), 95);
  addCandidate(tryFinder(element), 80);
  
  const domPath = buildExactDomPath(element);
  if (domPath !== primarySelector) {
    candidates.push({ selector: domPath, confidence: 50 });
  }

  // Deduplicate based on exact selector string
  const map = new Map<string, SelectorResult>();
  for (const c of candidates) {
    if (!map.has(c.selector) || map.get(c.selector)!.confidence < c.confidence) {
      map.set(c.selector, c);
    }
  }

  return Array.from(map.values()).sort((a, b) => b.confidence - a.confidence);
}
