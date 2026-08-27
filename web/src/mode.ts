/**
 * Which mode this process can actually run in, which is not always the one it
 * was told to run in.
 *
 * Its own module rather than a pair of helpers in index.ts, because index.ts
 * calls main() when it is imported — anything reaching in there for a function
 * starts a web server as a side effect.
 */

import type { Config, Mode } from './config.js'

/**
 * Whether the PDS live mode is pointed at is actually there.
 *
 * `_health` because it is the one endpoint a PDS answers without credentials
 * and without an opinion about who is asking. A short timeout: this runs
 * before the server listens, and a deployment should not sit dark waiting on a
 * host that is never going to answer.
 */
export async function pdsReachable(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(new URL('/xrpc/_health', url), { signal: ac.signal })
      return res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/**
 * The mode this process can actually run in, which is not always the one it
 * was told to run in.
 *
 * Live mode means observing a real network: a PDS to read and to sign against.
 * Asked for live with no PDS behind it, the app used to come up anyway — no
 * writer, so no issuance and no synthetic activity, and an index with nothing
 * in it. Every page rendered. The feed was empty. That is the state config.ts
 * opens by calling worse than refusing to start, and it is what every preview
 * environment has been in: they inherit F8130_MODE=live from production and
 * are cloned without the pds service, so the explicit setting defeats the
 * inference that would otherwise have chosen demo.
 *
 * So the setting is checked rather than believed. If the PDS is not there,
 * this runs the self-contained demonstration instead, which needs no PDS and
 * no database and has a feed.
 *
 * Production is the exception and does not fall back. A real deployment whose
 * PDS is briefly down at boot must not quietly start serving invented records
 * from its own domain; it stays live, read-only, and says so. RAILWAY_ENVIRON-
 * MENT_NAME is what distinguishes them, because it is set by the platform per
 * environment and is the one thing a preview does not inherit.
 */
export async function resolveMode(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Mode> {
  if (config.mode !== 'live') return config.mode

  const pdsUrl = env.PDS_INTERNAL_URL
  if (pdsUrl && (await pdsReachable(pdsUrl))) return 'live'

  const where = env.RAILWAY_ENVIRONMENT_NAME
  if (where === 'production') {
    console.warn(
      pdsUrl
        ? `LIVE MODE: ${pdsUrl} did not answer. Staying live and read-only — ` +
          'production does not serve invented records.'
        : 'LIVE MODE: no PDS_INTERNAL_URL. Staying live and read-only.',
    )
    return 'live'
  }

  console.warn(
    `LIVE MODE was asked for, but ${pdsUrl ?? 'no PDS'} is not reachable` +
      `${where ? ` from ${where}` : ''}. Running the self-contained ` +
      'demonstration instead, which needs neither a PDS nor a database.',
  )
  return 'demo'
}
