import { defineConfig, loadEnv } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json' with { type: 'json' }

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  for (const name of Object.keys(env)) {
    if (/(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|TOKEN)/i.test(name)) {
      throw new Error(`Do not put private credentials in ${name}; VITE_ values are embedded in the extension.`)
    }
  }
  const publishable = env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (env.VITE_SUPABASE_URL) {
    const url = new URL(env.VITE_SUPABASE_URL)
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
      throw new Error('VITE_SUPABASE_URL must use HTTPS outside local development.')
    }
  }
  if (publishable && !publishable.startsWith('sb_publishable_')) {
    throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key.')
  }
  const legacy = env.VITE_SUPABASE_ANON_KEY
  if (legacy) {
    try {
      const payload = JSON.parse(Buffer.from(legacy.split('.')[1], 'base64url').toString('utf8'))
      if (payload.role !== 'anon') throw new Error('Wrong role')
    } catch {
      throw new Error('VITE_SUPABASE_ANON_KEY must be a legacy anon JWT, never a service-role key.')
    }
  }
  return { plugins: [crx({ manifest })] }
})
