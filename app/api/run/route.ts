import { authenticate, jsonError } from '@/lib/server/auth'
import { decodeChatPayload } from '@/lib/server/crypto'
import { rateLimit } from '@/lib/server/rate-limit'
import { startRun } from '@/lib/server/runs'
import type { RunStartResponse } from '@/lib/shared/game'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const player = authenticate(req)
    await rateLimit('run', player.id)
    // start_param comes from the HMAC-verified initData, so the group id cannot be spoofed by the client.
    const chatId = decodeChatPayload(player.startParam)
    const run = await startRun(player, chatId)
    const body: RunStartResponse = {
      runId: run.runId,
      guest: player.guest,
      groupLaunch: run.chatId !== null,
      player: { name: player.name },
    }
    return Response.json(body)
  } catch (error) {
    return jsonError(error)
  }
}
