/**
 * Runtime configuration, resolved from the environment with defaults chosen so
 * that a service deployed with *no* variables at all still comes up correct.
 *
 * That property is not a nicety. Recreating a Railway service silently drops
 * every variable it had, and the first time that happened here the app booted
 * green, served every page, and failed every verification — because it was
 * pointed at the real network with no PDS behind it. A deployment that is
 * broken but looks healthy is worse than one that refuses to start, so the
 * zero-configuration case is now the demonstrable default rather than an
 * accident.
 */

export type Mode = 'demo' | 'live'

export type Config = {
  mode: Mode
  port: number
  hostname: string
  databaseUrl: string | null
  plcUrl: string | undefined
  /** True when the mode was chosen by default rather than stated. */
  modeInferred: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim() || null

  let mode: Mode
  let modeInferred = false

  if (env.F8130_MODE === 'live' || env.F8130_MODE === 'demo') {
    mode = env.F8130_MODE
  } else if (env.F8130_DEMO_MODE === '1') {
    // Retained so an already-deployed service keeps working across this change.
    mode = 'demo'
  } else if (databaseUrl) {
    // A database is only ever attached deliberately, so its presence is a
    // reliable signal that this deployment is meant to observe a real network.
    mode = 'live'
    modeInferred = true
  } else {
    mode = 'demo'
    modeInferred = true
  }

  return {
    mode,
    port: Number(env.PORT ?? 3000),
    // Railway's private network is IPv6-only, so :: is the right default there.
    hostname: env.HOST ?? '::',
    databaseUrl,
    plcUrl: env.PLC_URL,
    modeInferred,
  }
}

export function describeConfig(c: Config): string[] {
  const lines: string[] = []
  if (c.mode === 'demo') {
    lines.push(
      `DEMO MODE${c.modeInferred ? ' (defaulted: no DATABASE_URL and no F8130_MODE set)' : ''}: ` +
        'serving an in-memory network. No real repositories are consulted.',
    )
    lines.push('Sample bundles: GET /demo/bundles.json')
    lines.push('Set F8130_MODE=live to read the real AT Protocol network.')
  } else {
    lines.push(
      `LIVE MODE${c.modeInferred ? ' (inferred from DATABASE_URL)' : ''}: ` +
        'resolving real handles and reading real repositories.',
    )
  }
  if (!c.databaseUrl && c.mode === 'live') {
    lines.push('No DATABASE_URL: browsing is disabled, verification is unaffected.')
  }
  if (c.mode === 'demo') {
    lines.push('Browsing is served from an in-memory index, and dies with the process.')
    lines.push('Synthetic activity runs while the feed is being watched. F8130_ACTIVITY=0 disables it.')
  }
  return lines
}
