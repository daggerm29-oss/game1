import 'server-only'
import { Redis } from '@upstash/redis'

let client: Redis | null = null

export function redis() {
  if (!client) {
    const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
    if (!url || !token) throw new Error('Upstash Redis credentials are missing (KV_REST_API_URL / KV_REST_API_TOKEN)')
    client = new Redis({ url, token })
  }
  return client
}
