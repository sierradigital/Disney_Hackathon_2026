// The only place that talks to S/4HANA (destination S43). Everything goes through the
// service of Fiori app F2548, FAC_GL_DOCUMENT_POST_SRV, so journals are created by the same
// posting engine F2548 uses and land in the same tables (BKPF/BSEG/ACDOCA, VBKPF when parked).
// Entity, field and function names below were checked against the S43 $metadata.
//
//   getMasterData()   I_CompanyCode, I_BusinessAreaStdVH, I_GLAccountStdVH, I_CostCenterStdVH,
//                     I_AccountingDocumentTypeStdVH, I_CurrencyStdVH (or SAP__Currencies where it is
//                     missing, as in RD4), VL_SH_FAC_FIN_TRANSACTION_TYPE
//   checkDocument()   FinsPostingGLHeaders + Items, then Simulate (cds.zmaxx.s43.sapCheck); nothing is saved
//   createJournal()   FinsPostingGLHeaders + Items, then Post or ParkAsComplete (cds.zmaxx.s43.allowPosting)
//   attachFile()      API_CV_ATTACHMENT_SRV/AttachmentContentSet, business object BKPF
//   workflowStatus()  IsWorkflowActive: parked journals go to the standard Verify General Journal Entries workflow
import cds from '@sap/cds'
import { S43Session, S43Error, F2548, ATTACHMENTS, v2Date, v2Str } from './s43.js'

const LOG = cds.log('zmaxx-s43')
const CHUNK = 40 // values per $filter, keeps URLs short

export function getS4Client() {
  return new S4Client()
}

const objectKey = key => `${key.companyCode}${key.documentNumber}${key.fiscalYear}`

class S4Client {
  // -------------------------------------------------------------------------
  // Master data for the validation rules
  // -------------------------------------------------------------------------
  async getMasterData({ companyCodes, glAccounts, costCenters }) {
    const s = new S43Session()
    const [ccs, bas, docTypes, currencies, ttypes] = await Promise.all([
      companyCodes.length ? inChunks(companyCodes, part => s.get(`${F2548}/I_CompanyCode`, {
        $filter: part.map(c => `CompanyCode eq ${v2Str(c)}`).join(' or '),
        $select: 'CompanyCode,CompanyCodeName,Currency,ControllingArea'
      })) : [],
      s.getAll(`${F2548}/I_BusinessAreaStdVH`, { $select: 'BusinessArea' }),
      s.getAll(`${F2548}/I_AccountingDocumentTypeStdVH`, { $select: 'AccountingDocumentType' }),
      readCurrencies(s),
      s.getAll(`${F2548}/VL_SH_FAC_FIN_TRANSACTION_TYPE`, { $select: 'TRTYP,TXT' })
    ])
    const companies = new Map(ccs.map(c => [c.CompanyCode, { companyCode: c.CompanyCode, name: c.CompanyCodeName, currency: c.Currency, controllingArea: c.ControllingArea }]))

    // G/L accounts, per company code
    const glRows = []
    for (const [cc, accounts] of groupPairs(glAccounts)) {
      glRows.push(...await inChunks(accounts, part => s.get(`${F2548}/I_GLAccountStdVH`, {
        $filter: `CompanyCode eq ${v2Str(cc)} and (${part.map(a => `GLAccount eq ${v2Str(a)}`).join(' or ')})`,
        $select: 'GLAccount,CompanyCode,GLAccountType,GLAccount_Text'
      })))
    }

    // Cost centers, per controlling area of the company code
    const ccRows = []
    const byArea = new Map()
    for (const [cc, centers] of groupPairs(costCenters)) {
      const area = companies.get(cc)?.controllingArea
      if (!area) continue
      byArea.set(area, [...new Set([...(byArea.get(area) ?? []), ...centers])])
    }
    for (const [area, centers] of byArea) {
      ccRows.push(...await inChunks(centers, part => s.get(`${F2548}/I_CostCenterStdVH`, {
        $filter: `ControllingArea eq ${v2Str(area)} and (${part.map(c => `CostCenter eq ${v2Str(c)}`).join(' or ')})`,
        $select: 'ControllingArea,CostCenter,ValidityStartDate,ValidityEndDate'
      })))
    }

    // Tax codes per company code (value help of F2548's own tax code field)
    const taxRows = []
    for (const cc of companyCodes) {
      const rows = await s.getAll(`${F2548}/VL_SH_FOT_TXA_F4_TAX_CODE`, { $filter: `STBUK eq ${v2Str(cc)}`, $select: 'STBUK,MWSKZ,XINACT' })
      taxRows.push(...rows.filter(t => !t.XINACT))
    }

    return {
      companyCodes: companies,
      taxCodes: new Set(taxRows.map(t => `${t.STBUK}|${t.MWSKZ}`)),
      businessAreas: new Set(bas.map(b => b.BusinessArea)),
      documentTypes: new Set(docTypes.map(d => d.AccountingDocumentType)),
      currencies: new Set(currencies),
      transactionTypes: new Map(ttypes.map(t => [t.TRTYP, t.TXT])),
      glAccounts: new Map(glRows.map(g => [`${g.CompanyCode}|${alpha(g.GLAccount)}`, { glAccount: alpha(g.GLAccount), companyCode: g.CompanyCode, accountType: g.GLAccountType, name: g.GLAccount_Text }])),
      costCenters: new Map(ccRows.map(c => [`${c.ControllingArea}|${alpha(c.CostCenter)}`, { validFrom: fromV2Date(c.ValidityStartDate), validTo: fromV2Date(c.ValidityEndDate) }]))
    }
  }

  // -------------------------------------------------------------------------
  // SAP standard check: build the journal, then Simulate
  // -------------------------------------------------------------------------
  async checkDocument(doc) {
    // A timeout or server error on the way to S43 says nothing about the data: retry the
    // whole check (a new draft each time) before giving up.
    const attempts = 5
    for (let attempt = 1; ; attempt++) {
      const s = new S43Session()
      try {
        const key = await this.#createDraft(s, doc)
        // Simulate runs SAP's full posting checks and saves nothing. CheckAndDetermine does not
        // report errors such as missing account settings, so it is not used here.
        const res = await s.request('post', `${F2548}/Simulate`, { params: { TmpId: v2Str(key.TmpId), TmpIdType: v2Str(key.TmpIdType) } })
        return toMessages(doc, { sapMessages: sapErrors(res) }, 'SAP_CHECK', false)
      } catch (e) {
        if (!(e instanceof S43Error) && !e.sapMessages) throw e
        const technical = !e.status || e.status >= 500
        if (technical && attempt < attempts) {
          LOG.warn(`SAP check for journal ${doc.docRef} failed (${e.status ?? 'no answer'}), retry ${attempt} of ${attempts - 1}`)
          await new Promise(r => setTimeout(r, 3000 * attempt))
          continue
        }
        if (technical) {
          return [{
            lineNo: doc.lines[0].lineNo, docRef: doc.docRef, field: null, code: 'SAP_CHECK_UNAVAILABLE', source: 'SAP_CHECK', severity_code: 'E',
            text: `SAP's check could not run for this journal: S43 did not answer (${e.status ?? 'no connection'}) after ${attempts} tries. The journal is held back; upload it again later.`
          }]
        }
        return toMessages(doc, e, 'SAP_CHECK')
      }
    }
  }

  // -------------------------------------------------------------------------
  // Post or park through F2548's engine
  // -------------------------------------------------------------------------
  async createJournal(doc, mode) {
    if (!cds.env.zmaxx.s43.allowPosting) {
      throw new Error('Posting to S43 is switched off. Set cds.zmaxx.s43.allowPosting = true to create journals.')
    }
    const s = new S43Session()
    const key = await this.#createDraft(s, doc)
    const fn = mode === 'PARK' ? 'ParkAsComplete' : 'Post'
    const res = await s.request('post', `${F2548}/${fn}`, { params: { TmpId: v2Str(key.TmpId), TmpIdType: v2Str(key.TmpIdType) } })
    const r = res.data?.d?.[fn] ?? res.data?.d
    LOG.info(`${fn} ->`, r)
    // SAP answers HTTP 200 even when it refuses: the reason is in the sap-message header
    // and the returned key is empty. Only a document number means the journal exists.
    const errors = sapErrors(res)
    if (errors.length || !r?.AccountingDocument) {
      const err = new Error(errors.map(e => `${e.code}: ${e.text}`).join(' ') || `SAP returned no document number from ${fn}.`)
      err.sapMessages = errors
      throw err
    }
    return { companyCode: r.CompanyCode, documentNumber: r.AccountingDocument, fiscalYear: r.FiscalYear }
  }

  async attachFile(key, file) {
    const s = new S43Session()
    const res = await s.request('post', `${ATTACHMENTS}/AttachmentContentSet`, {
      data: file.content,
      headers: {
        'Content-Type': file.mediaType,
        Slug: encodeURIComponent(file.fileName),
        BusinessObjectTypeName: 'BKPF',
        LinkedSAPObjectKey: objectKey(key)
      }
    })
    const d = res.data?.d ?? {}
    return d.DocumentInfoRecordDocNumber || d.ArchiveDocumentID || 'attached'
  }

  // Parked journals are approved in the standard Verify General Journal Entries apps when this workflow is active
  async workflowStatus() {
    const s = new S43Session()
    const d = await s.get(`${F2548}/IsWorkflowActive`)
    return Boolean(d?.IsWorkflowActive?.IsActive ?? d?.IsActive)
  }

  // Header first (S/4 assigns TmpId/TmpIdType), then the lines
  async #createDraft(s, doc) {
    const first = doc.lines[0]
    const lines = doc.clearingLine ? [...doc.lines, doc.clearingLine] : doc.lines
    const header = (await s.request('post', `${F2548}/FinsPostingGLHeaders`, {
      data: {
        CompanyCode: first.companyCode,
        AccountingDocumentType: first.documentType,
        DocumentDate: v2Date(first.documentDate),
        PostingDate: v2Date(first.postingDate),
        ...(first.fiscalPeriod && { FiscalPeriod: String(first.fiscalPeriod).padStart(2, '0') }),
        DocumentReferenceID: first.reference ?? '',
        AccountingDocumentHeaderText: first.headerText ?? '',
        TransactionCurrency: doc.currencyTC
      }
    })).data.d
    const key = { TmpId: header.TmpId, TmpIdType: header.TmpIdType }
    // which additional local currency field carries group currency (type 30) in this company code
    const gcField = [2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => [`LocalCurrency${n}Type`, `AmountInLocalCurrency${n}`]).find(([t]) => header[t] === '30')?.[1]
    // Lines go in OData $batch requests of BATCH_SIZE lines each: one call per line takes about
    // 1.2 s and long sequences run into gateway timeouts (504); a batch of 50 takes about 4 s.
    const itemsPath = `FinsPostingGLHeaders(TmpId=${v2Str(key.TmpId)},TmpIdType=${v2Str(key.TmpIdType)})/Items`
    const item = l => {
      const amount = Number(l.amountTC)
      return {
        CompanyCode: l.companyCode ?? first.companyCode,
        GLAccount: l.glAccount,
        BusinessArea: l.businessArea ?? '',
        CostCenter: l.costCenter ?? '',
        FinancialTransactionType: l.ttype ?? '',
        TaxCode: l.taxCode ?? '',
        DocumentItemText: l.itemText ?? '',
        TransactionCurrency: doc.currencyTC,
        ...(amount >= 0 ? { DebitAmountInTransCrcy: amount.toFixed(2) } : { CreditAmountInTransCrcy: (-amount).toFixed(2) }),
        ...(l.amountLC != null && { AmountInCoCodeCrcy: Number(l.amountLC).toFixed(2) }),
        ...(l.amountGC != null && gcField && { [gcField]: Number(l.amountGC).toFixed(2) })
      }
    }
    for (let i = 0; i < lines.length; i += BATCH_SIZE) {
      await postBatch(s, itemsPath, lines.slice(i, i + BATCH_SIZE).map(item), doc, i)
    }
    return key
  }
}

const BATCH_SIZE = 50

// One OData $batch request with one change set: a POST per line to the draft's Items.
// The change set succeeds or fails as a whole; a failure is reported with SAP's message.
async function postBatch(s, itemsPath, items, doc, offset) {
  const b = `batch_${cds.utils.uuid()}`, c = `changeset_${cds.utils.uuid()}`
  let body = `--${b}\r\nContent-Type: multipart/mixed; boundary=${c}\r\n\r\n`
  for (const it of items) {
    body += `--${c}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n` +
      `POST ${itemsPath} HTTP/1.1\r\nContent-Type: application/json\r\nAccept: application/json\r\n\r\n${JSON.stringify(it)}\r\n`
  }
  body += `--${c}--\r\n--${b}--\r\n`
  const res = await s.request('post', `${F2548}/$batch`, { data: body, headers: { 'Content-Type': `multipart/mixed; boundary=${b}` } })
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  const codes = [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(m => Number(m[1]))
  if (codes.filter(code => code === 201).length !== items.length) {
    const msg = text.match(/"message"\s*:\s*\{[^}]*?"value"\s*:\s*"([^"]+)"/)?.[1] ?? `SAP did not accept lines ${offset + 1} to ${offset + items.length} of journal ${doc.docRef}.`
    const code = text.match(/"code"\s*:\s*"([^"]+)"/)?.[1] ?? 'S43_BATCH'
    const err = new Error(msg)
    err.status = codes.find(x => x >= 400) ?? 400
    err.sapMessages = [{ code, text: msg }]
    throw err
  }
}

// ---------------------------------------------------------------------------

// Errors from the sap-message header (main message plus details) of a successful HTTP response
function sapErrors(res) {
  const raw = res?.headers?.['sap-message']
  if (!raw) return []
  let main
  try { main = JSON.parse(raw) } catch { return [] }
  return [main, ...(main.details || [])]
    .filter(m => m.severity === 'error' || m.severity === 'abort')
    .map(m => ({ code: m.code, text: m.message, target: m.target }))
}

function toMessages(doc, e, source, fallback = true) {
  const list = e.sapMessages?.length ? e.sapMessages : fallback ? [{ code: 'S43', text: e.message }] : []
  return list.map(m => ({
    lineNo: lineOfTarget(doc, m.target) ?? doc.lines[0].lineNo,
    docRef: doc.docRef, field: null, code: sapCode(m.code), text: m.text, source, severity_code: 'E'
  }))
}

// Message class/number (GLT2/076) stays as is; Gateway exceptions such as
// /IWCOR/CX_DS_EDM_FACET_ERROR/<guid> are reduced to the exception name
function sapCode(code) {
  if (!code) return 'S43'
  const parts = code.split('/').filter(Boolean)
  return (parts.length > 2 ? parts[parts.length - 2] : code).slice(0, 30)
}

// Item targets look like Items(...AccountingDocumentItemRef='0000000003'...); map back to our line
function lineOfTarget(doc, target) {
  const n = Number(String(target ?? '').match(/AccountingDocumentItemRef='?0*(\d+)/)?.[1])
  return n ? doc.lines[n - 1]?.lineNo : null
}

// Currency codes. Not every release of F2548's service has I_CurrencyStdVH (RD4 answers 404);
// SAP__Currencies, which Gateway adds to services with currency fields, has the same codes.
// After the first 404 this process reads SAP__Currencies straight away.
let currencySet = 'I_CurrencyStdVH'
async function readCurrencies(s) {
  if (currencySet === 'I_CurrencyStdVH') {
    try {
      return (await s.getAll(`${F2548}/I_CurrencyStdVH`, { $select: 'Currency' })).map(c => c.Currency)
    } catch (e) {
      if (e.status !== 404) throw e
      LOG.info('I_CurrencyStdVH not found in this system, reading currencies from SAP__Currencies')
      currencySet = 'SAP__Currencies'
    }
  }
  return (await s.getAll(`${F2548}/SAP__Currencies`)).map(c => c.CurrencyCode)
}

async function inChunks(values, fn) {
  const out = []
  for (let i = 0; i < values.length; i += CHUNK) out.push(...await fn(values.slice(i, i + CHUNK)))
  return out
}

// [[companyCode, value], ...] -> Map(companyCode -> [unique values])
function groupPairs(pairs) {
  const map = new Map()
  for (const [cc, v] of pairs) {
    if (!cc || !v) continue
    if (!map.has(cc)) map.set(cc, new Set())
    map.get(cc).add(v)
  }
  return new Map([...map].map(([k, s]) => [k, [...s]]))
}

// S/4 Gateway returns numeric G/L accounts and cost centers without leading zeros; the app keeps them padded to 10
const alpha = v => (/^\d+$/.test(v ?? '') ? v.padStart(10, '0') : v)

const fromV2Date = v => {
  const ms = Number(String(v ?? '').match(/\/Date\((-?\d+)/)?.[1])
  return Number.isFinite(ms) && v ? new Date(ms).toISOString().slice(0, 10) : null
}
