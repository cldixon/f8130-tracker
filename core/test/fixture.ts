/**
 * Test-facing view of the in-memory network.
 *
 * The network itself is a first-class part of the library (see
 * src/verify/memory.ts) because it is also how the app runs without
 * infrastructure. Only the assertion helper is test-only.
 */

export {
  MemoryNetwork as FakeNetwork,
  RELEASE_NSID,
  birthForm,
  overhaulForm,
  standardNetwork,
  NORTHWIND,
  CASCADIA,
  MERIDIAN,
  type Issued,
} from '../src/verify/memory.js'

import type {
  Stage,
  StageName,
  VerificationReport,
} from '../src/verify/types.js'

export function stage(report: VerificationReport, name: StageName): Stage {
  const s = report.stages.find((x) => x.name === name)
  if (!s) throw new Error(`no ${name} stage in report`)
  return s
}
