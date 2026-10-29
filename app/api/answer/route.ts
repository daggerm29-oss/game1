import { HttpError, authenticate, jsonError } from '@/lib/server/auth'
import { rateLimit } from '@/lib/server/rate-limit'
import { submitAnswer } from '@/lib/server/runs'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const player = authenticate(req)
    await rateLimit('answer', player.id)
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (
      !body ||
      typeof body.runId !== 'string' ||
      typeof body.roundId !== 'string' ||
      typeof body.token !== 'string' ||
      !Number.isInteger(body.step) ||
      !Number.isInteger(body.slot)
    ) {
      throw new HttpError(400, 'Malformed answer')
    }
    const result = await submitAnswer(player, {
      runId: body.runId,
      roundId: body.roundId,
      token: body.token,
      step: body.step as number,
      slot: body.slot as number,
    })
    return Response.json(result)
  } catch (error) {
    return jsonError(error)
  }
}
