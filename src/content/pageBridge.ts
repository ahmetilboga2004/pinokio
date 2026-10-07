import { createLogger } from '../core/logger';

const log = createLogger('PageBridge');

declare global {
  interface Window {
    __pinokioNavigationBridge?: boolean
  }
}

function sameUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left, window.location.href)
    const b = new URL(right, window.location.href)
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && a.hash === b.hash
  } catch {
    return false
  }
}

function navigate(url: string) {
  const target = new URL(url, window.location.href)
  const current = new URL(window.location.href)
  if (!['http:', 'https:'].includes(target.protocol)) return

  if (target.origin !== current.origin) {
    log.warn('Cross-origin navigation blocked in pageBridge', { target: target.origin, current: current.origin })
    return
  }

  if (
    target.pathname === current.pathname &&
    target.search === current.search &&
    target.hash !== current.hash &&
    target.hash
  ) {
    log.info('Same page hash change', { hash: target.hash })
    window.location.hash = target.hash
    return
  }

  const link = Array.from(document.querySelectorAll('a[href]')).find((anchor) =>
    sameUrl((anchor as HTMLAnchorElement).href, target.href) &&
    !anchor.hasAttribute('download') &&
    (!anchor.getAttribute('target') || anchor.getAttribute('target') === '_self'),
  ) as HTMLAnchorElement | undefined

  if (link) {
    log.info('Found matching link, clicking', { href: link.href, text: link.textContent?.trim() })
    link.click()
    return
  }

  log.info('No matching link found, using synthetic link click', { url })
  const syntheticLink = document.createElement('a')
  syntheticLink.href = target.href
  syntheticLink.setAttribute('data-pinokio-synthetic', 'true')
  syntheticLink.style.position = 'fixed'
  syntheticLink.style.top = '-9999px'
  syntheticLink.style.left = '-9999px'
  syntheticLink.style.opacity = '0'
  syntheticLink.tabIndex = -1
  syntheticLink.setAttribute('aria-hidden', 'true')
   ;(document.body || document.documentElement).appendChild(syntheticLink)
  syntheticLink.click()
  setTimeout(() => {
    try { syntheticLink.remove() } catch {}
  }, 500)
}

if (!window.__pinokioNavigationBridge) {
  window.__pinokioNavigationBridge = true
  log.info('PageBridge initialized')
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    if (event.data?.type !== 'PINOKIO_NAVIGATE') return
    if (typeof event.data.url !== 'string') return
    log.info('Received PINOKIO_NAVIGATE message', { url: event.data.url })
    try { navigate(event.data.url) } catch (error) { log.warn('Navigation failed', error) }
  })
}

export {}
