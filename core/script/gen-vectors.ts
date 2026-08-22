/**
 * Generates testdata/vectors.json — the cross-language contract.
 *
 * Any implementation of the commitment scheme must reproduce every byte in
 * this file from the inputs alone. It is the only thing keeping the Go and
 * TypeScript cores honest about each other.
 *
 * Nonces are derived deterministically from a label so the file regenerates
 * identically; production nonces are always CSPRNG.
 */

import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cidForLex } from '@atproto/lex-cbor'

import { canonicalizeForm } from '../src/canonical.js'
import { commitForm, proofForField, toHex } from '../src/commitment.js'
import {
  FIELD_ORDER,
  FIELD_SET_VERSION,
  PUBLIC_FIELDS,
  publicValues,
  type RawForm,
} from '../src/fields.js'

const NSID = 'dev.cldixon.f8130.release'

function derivedNonces(label: string): Uint8Array[] {
  return FIELD_ORDER.map(
    (_, i) =>
      new Uint8Array(createHash('sha256').update(`f8130/${label}/${i}`).digest()),
  )
}

type Case = {
  name: string
  description: string
  issuerDid: string
  form: RawForm
}

const cases: Case[] = [
  {
    name: 'birth',
    description:
      'OEM birth record, certified under Block 13. Every field populated, nothing null, plain ASCII.',
    issuerDid: 'did:plc:nw7hd3kq2xr5mabcdefghijk',
    form: {
      approvingAuthority: 'FAA/United States',
      formNumber: 'SYNTHETIC-8130-0001',
      organizationName: 'Northwind Turbine',
      organizationAddress: '1200 Industrial Loop, Wichita, KS 67209',
      workOrder: 'WO/2019/1180',
      item: 1,
      description: 'Fuel control unit',
      partNumber: 'NT-8821-04',
      quantity: 1,
      serialNumber: 'SN-000417',
      status: 'NEW',
      remarks: 'Production acceptance test complete.',
      certifyingBlock: 'CONFORMITY',
      approvalBasis: 'APPROVED_DESIGN_DATA',
      signerCert: 'SYNTHETIC-CERT-00081',
      signerName: 'R. Inspector',
      completedAt: '2019-03-11T14:02:00Z',
    },
  },
  {
    name: 'overhaul',
    description:
      'MRO shop visit, approved for return to service under Block 14. Chains to the birth record; Block 12 carries the commercially sensitive detail.',
    issuerDid: 'did:plc:cs4gk2mp7yv6nbcdefghijkl',
    form: {
      approvingAuthority: 'FAA/United States',
      formNumber: 'SYNTHETIC-8130-0002',
      organizationName: 'Cascadia MRO',
      organizationAddress: '4400 Airport Way, Everett, WA 98204',
      workOrder: 'WO/2026/0042',
      item: 1,
      description: 'Fuel control unit',
      partNumber: 'NT-8821-04',
      quantity: 1,
      serialNumber: 'SN-000417',
      status: 'OVERHAULED',
      remarks: 'Metering valve wear beyond limits. Full overhaul per CMM 73-21-05.',
      certifyingBlock: 'RETURN_TO_SERVICE',
      approvalBasis: 'PART_43_RETURN_TO_SERVICE',
      signerCert: 'SYNTHETIC-CERT-12345',
      signerName: 'A. Technician',
      completedAt: '2026-01-22T09:30:00Z',
    },
  },
  {
    name: 'sparse',
    description:
      'Only the fields that appear on the public record. Exercises the null path: absent fields still commit, and the tree shape is unchanged — a sparse form is not distinguishable from a full one by its structure.',
    issuerDid: 'did:plc:cs4gk2mp7yv6nbcdefghijkl',
    form: {
      approvingAuthority: 'FAA/United States',
      formNumber: 'SYNTHETIC-8130-0003',
      organizationName: 'Cascadia MRO',
      organizationAddress: '4400 Airport Way, Everett, WA 98204',
      description: 'Hydraulic actuator',
      partNumber: 'NT-9004-11',
      serialNumber: 'SN-551200',
      signerCert: 'SYNTHETIC-CERT-12345',
      completedAt: '2026-02-02T00:00:00Z',
    },
  },
  {
    name: 'normalization',
    description:
      'Sloppy input that must canonicalize to the same bytes as tidy input: separator noise, ragged whitespace, a non-UTC offset, decomposed Unicode, a lowercase enum, and an empty string that is NOT null.',
    issuerDid: 'did:plc:cs4gk2mp7yv6nbcdefghijkl',
    form: {
      approvingAuthority: '  FAA/United   States ',
      formNumber: '  SYNTHETIC-8130-0004 ',
      organizationName: 'Meridian   Aeroparts',
      organizationAddress: '90 Cargo Rd,\n  Miami,  FL 33122 ',
      workOrder: 'wo/2026/0099',
      item: 2,
      description: 'Vanne   de\tcarburant',
      partNumber: 'nt 9004/11',
      quantity: 2,
      serialNumber: 's.n_551201',
      status: 'repaired',
      remarks: '',
      certifyingBlock: 'return_to_service',
      approvalBasis: 'other_regulation',
      signerCert: 'synthetic cert 99999',
      signerName: '  J.  Doe  ',
      completedAt: '2026-02-03T19:45:30.812-05:00',
    },
  },
  {
    name: 'unicode-whitespace',
    description:
      "Whitespace that only JavaScript considers whitespace: NBSP, en space, narrow NBSP, and a leading BOM. This is what arrives when a form is pasted out of a spreadsheet or lifted from a PDF, and it is the case where a naive Go port silently disagrees — Go's \\s is ASCII-only.",
    issuerDid: 'did:plc:nw7hd3kq2xr5mabcdefghijk',
    form: {
      approvingAuthority: 'FAA/United\u00a0States',
      formNumber: '\ufeffSYNTHETIC-8130-0005',
      organizationName: 'Northwind\u2002Turbine',
      organizationAddress: '1200\u202fIndustrial Loop, Wichita, KS 67209',
      workOrder: 'WO 2026 0100',
      item: 1,
      description: 'Fuel control unit',
      partNumber: 'NT 8821 04',
      quantity: 1,
      serialNumber: 'SN 000418',
      status: 'MODIFIED',
      remarks: ' Housing cracked at flange.\u00a0Modification per SB 73-0042. ',
      certifyingBlock: 'RETURN_TO_SERVICE',
      approvalBasis: 'OTHER_REGULATION',
      signerCert: 'SYNTHETIC CERT 77777',
      signerName: 'K. Engineer',
      completedAt: '2026-03-04T11:15:00Z',
    },
  },
]

async function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const outPath = resolve(here, '../../testdata/vectors.json')

  const vectors = []
  for (const c of cases) {
    const nonces = derivedNonces(c.name)
    const commitment = commitForm(c.form, nonces)

    // A release record built from this commitment, so the CID pins the
    // DAG-CBOR encoding of the record itself and not just the tree.
    const record: Record<string, unknown> = {
      $type: NSID,
      commitment: commitment.root,
      fieldSetVersion: FIELD_SET_VERSION,
      issuerDid: c.issuerDid,
      ...publicValues(commitment.values),
    }
    const cid = await cidForLex(record as any)

    vectors.push({
      name: c.name,
      description: c.description,
      issuerDid: c.issuerDid,
      input: c.form,
      canonical: commitment.values,
      nonces: nonces.map(toHex),
      leaves: commitment.leaves.map(toHex),
      root: toHex(commitment.root),
      recordCid: cid.toString(),
      // one worked selective-disclosure proof per case, over Block 12 —
      // the field an operator is least willing to publish and most often
      // asked to prove
      proof: (() => {
        const p = proofForField(commitment, 'remarks')
        return {
          field: p.field,
          value: p.value,
          index: p.index,
          nonce: toHex(p.nonce),
          path: p.path.map((s) => ({ hash: toHex(s.hash), side: s.side })),
        }
      })(),
    })
  }

  const doc = {
    $comment:
      'Cross-language test vectors for the f8130 field commitment scheme. ' +
      'SYNTHETIC DEMONSTRATION DATA. Generated by core/script/gen-vectors.ts — do not hand-edit.',
    fieldSetVersion: FIELD_SET_VERSION,
    fieldOrder: FIELD_ORDER,
    publicFields: PUBLIC_FIELDS,
    nonceLength: 32,
    prefixes: { leaf: 0, node: 1, pad: 2 },
    padLeaf: toHex(
      new Uint8Array(createHash('sha256').update(Buffer.from([0x02])).digest()),
    ),
    lexicon: NSID,
    vectors,
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n')
  console.log(`wrote ${outPath}`)
  for (const v of vectors) {
    console.log(`  ${v.name.padEnd(14)} root=${v.root.slice(0, 16)}…  cid=${v.recordCid}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
