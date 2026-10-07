const LOG_PREFIX = '[Pinokio:Background]'

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'PINOKIO_GET_OAUTH_REDIRECT') return false
  if (!sender.tab?.id) return false
  respond({ url: chrome.identity.getRedirectURL('pinokio') })
  return false
})

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'PINOKIO_OAUTH') return false
  if (!sender.tab?.id || typeof message.url !== 'string') return false
  void (async () => {
    const projectUrl = new URL(import.meta.env.VITE_SUPABASE_URL)
    const flowUrl = new URL(message.url)
    const isSupabase = flowUrl.origin === projectUrl.origin &&
      flowUrl.pathname === '/auth/v1/authorize' &&
      ['google', 'github'].includes(flowUrl.searchParams.get('provider') || '') &&
      flowUrl.searchParams.get('redirect_to') === chrome.identity.getRedirectURL('pinokio')
    if (!isSupabase) throw new Error('Unexpected OAuth destination.')
    const redirectUrl = await chrome.identity.launchWebAuthFlow({ url: flowUrl.href, interactive: true })
    if (!redirectUrl) throw new Error('Sign-in was cancelled.')
    const expected = new URL(chrome.identity.getRedirectURL('pinokio'))
    const actual = new URL(redirectUrl)
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
      throw new Error('Unexpected OAuth callback.')
    }
    respond({ ok: true, redirectUrl })
  })().catch(error => respond({ ok: false, error: String(error) }))
  return true
})

const mutations = new Map<string, Promise<void>>()
let teamMutation = Promise.resolve()
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'PINOKIO_SET_ACTIVE_TEAM') return false
  if (!sender.tab?.id || !sender.url) return false
  const origin = new URL(sender.url).origin
  teamMutation = teamMutation.then(async () => {
    const result = await chrome.storage.local.get('pinokio_active_teams')
    const teams = (result.pinokio_active_teams || {}) as Record<string, unknown>
    if (message.team === null) delete teams[origin]
    else if (message.team?.origin === origin && typeof message.team.id === 'string') teams[origin] = message.team
    else throw new Error('Invalid team selection')
    await chrome.storage.local.set({ pinokio_active_teams: teams })
    respond({ ok: true })
  }).catch(error => respond({ ok: false, error: String(error) }))
  return true
})
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'PINOKIO_MUTATE_COMMENT') return false
  if (!sender.tab?.id || !sender.url || typeof message.id !== 'string') return false
  const origin = new URL(sender.url).origin
  const next = (mutations.get(origin) || Promise.resolve()).then(async () => {
    const stored = await chrome.storage.local.get(origin)
    const comments = (Array.isArray(stored[origin]) ? stored[origin] : []) as Array<{ id?: string; createdAt: string }>
    const index = comments.findIndex(comment => (comment.id || comment.createdAt) === message.id)
    if (message.operation === 'delete') {
      if (index >= 0) comments.splice(index, 1)
    } else if (message.operation === 'upsert' && typeof message.comment?.comment === 'string' &&
      typeof message.comment?.selector === 'string' && new URL(message.comment.url).origin === origin) {
      if (index >= 0) comments[index] = message.comment
      else comments.push(message.comment)
    } else throw new Error('Invalid comment mutation')
    await chrome.storage.local.set({ [origin]: comments })
    respond({ ok: true })
  }).catch(error => respond({ ok: false, error: String(error) }))
  mutations.set(origin, next)
  void next.finally(() => { if (mutations.get(origin) === next) mutations.delete(origin) })
  return true
})

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['PINOKIO_GET_TAB_STATE', 'PINOKIO_SET_TAB_STATE'].includes(message?.type)) return false
  if (!sender.tab?.id || !sender.url) return false
  const key = `pinokio-tab:${sender.tab.id}`
  const origin = new URL(sender.url).origin
  void (async () => {
    if (message.type === 'PINOKIO_SET_TAB_STATE') {
      await chrome.storage.session.set({ [key]: {
        origin,
        active: message.state?.active === true,
        pendingId: typeof message.state?.pendingId === 'string' ? message.state.pendingId : undefined,
      } })
      respond({ ok: true })
    } else {
      const stored = (await chrome.storage.session.get(key))[key] as { origin?: string } | undefined
      respond(stored?.origin === origin ? stored : { active: false })
    }
  })().catch(error => { console.warn('Could not persist tab state', error); respond({ active: false }) })
  return true
})

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(`pinokio-tab:${tabId}`)
})

chrome.runtime.onInstalled.addListener(() => {
  console.info(`${LOG_PREFIX} Extension installed`)
})

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return
  }

  console.log(`${LOG_PREFIX} Extension icon clicked, tab=${tab.id} url=${tab.url}`)

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_INSPECT_MODE' })
    console.log(`${LOG_PREFIX} TOGGLE_INSPECT_MODE sent to tab=${tab.id}`)
  } catch (error) {
    console.warn(`${LOG_PREFIX} Content script not available on tab=${tab.id}`, error)
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'PINOKIO_NAVIGATE_TAB') {
    return false
  }

  console.log(`${LOG_PREFIX} PINOKIO_NAVIGATE_TAB received`, { url: message.url, tabId: sender.tab?.id })

  if (!sender.tab?.id || typeof message.url !== 'string') {
    console.warn(`${LOG_PREFIX} Invalid PINOKIO_NAVIGATE_TAB message`, { message })
    sendResponse({ ok: false })
    return false
  }

  chrome.tabs
    .update(sender.tab.id, { url: message.url })
    .then(() => {
      console.log(`${LOG_PREFIX} Tab navigated successfully`, { url: message.url })
      sendResponse({ ok: true })
    })
    .catch((error) => {
      console.warn(`${LOG_PREFIX} Tab navigation failed`, { url: message.url, error })
      sendResponse({ ok: false })
    })

  return true
})
