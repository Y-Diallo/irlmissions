import "server-only"
import { OAuth2Client } from "google-auth-library"
import type { GoogleIdTokenPayload } from "@/shared/processor-schedule"

const client = new OAuth2Client()

export async function verifyGoogleIdToken(
  token: string,
  audience: string
): Promise<GoogleIdTokenPayload | null> {
  const ticket = await client.verifyIdToken({ idToken: token, audience })
  return ticket.getPayload() ?? null
}
