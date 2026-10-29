import { HttpError, authenticate, jsonError } from '@/lib/server/auth'
import { rateLimit } from '@/lib/server/rate-limit'
import { issueRound } from '@/lib/server/runs'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const player = authenticate(req)
    await rateLimit('round', player.id)
    const body = (await req.json().catch(() => null)) as { runId?: unknown } | null
    if (!body || typeof body.runId !== 'string') throw new HttpError(400, 'runId required')
    return Response.json(await issueRound(player, body.runId))
  } catch (error) {
    return jsonError(error)
  }
}
