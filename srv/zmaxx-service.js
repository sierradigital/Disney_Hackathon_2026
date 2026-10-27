import cds from '@sap/cds'
import { createHash } from 'node:crypto'
import { parseTemplate, readJournalTable } from './lib/template.js'
import { validateZmaxx, validateMasterData, groupBy } from './lib/rules.js'
import { splitDocuments } from './lib/split.js'
import { decideRouting } from './lib/routing.js'
import { getS4Client } from './lib/s4-client.js'
import { explain } from './lib/ai.js'
import { buildErrorReport, buildErrorLinesFile } from './lib/report.js'
import { dmsConfigured, dmsInfo, storeFile, listFiles, readFile } from './lib/dms.js'

const LOG = cds.log('zmaxx')
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_LINES = 16000 // same ceiling as F2548
const ACTIVE = ['STARTED', 'VALIDATING', 'VALIDATED', 'PARTIAL', 'SPLITTING', 'POSTING', 'COMPLETED', 'PARTIAL_DONE']

// Newer than the code list in some deployed versions: restored on start so status names never go missing
const PARTIAL_STATUSES = [
  { code: 'PARTIAL', name: 'Partly Valid', descr: 'Journals without errors are ready, journals with errors are held back', criticality: 2 },
  { code: 'PARTIAL_DONE', name: 'Partly Completed', descr: 'Journals without errors were sent to SAP, journals with errors were held back', criticality: 2 }
]

export default class ZmaxxService extends cds.ApplicationService {
  init() {
    const db = cds.entities('zmaxx')
    cds.once('served', async () => {
      try { await UPSERT.into(db.UploadStatus).entries(PARTIAL_STATUSES) } catch (e) { LOG.warn('could not restore the partial upload statuses:', e.message) }
    })

    // ---------------------------------------------------------------------
    // Gap 2 + 8: one-call upload with duplicate check, processing in background
    // ---------------------------------------------------------------------
    this.on('postingEnabled', () => Boolean(cds.env.zmaxx.s43.allowPosting))

    this.on('transactionTypes', async req => {
      try {
        const { transactionTypes } = await getS4Client().getMasterData({ companyCodes: [], glAccounts: [], costCenters: [] })
        return [...transactionTypes].map(([code, text]) => ({ code, text })).sort((a, b) => a.code.localeCompare(b.code))
      } catch (e) {
        return req.reject(502, `Transaction Types could not be read from S/4: ${e.message}`)
      }
    })

    // ---------------------------------------------------------------------
    // Gap 4: files kept in Document Management
    // ---------------------------------------------------------------------
    this.on('dmsInfo', () => dmsInfo())

    // Files in the DMS folder, with the upload each one belongs to.
    // Every user sees every file.
    this.on('dmsFiles', async req => {
      if (!dmsConfigured()) return []
      let files
      try {
        files = await listFiles()
      } catch (e) {
        return req.reject(502, e.message)
      }
      const uploads = await SELECT.from(db.Uploads).columns('ID', 'createdBy', 'dmsObjectId', 'status_code', 'status.name as statusName', 'status.criticality as criticality')
        .where({ dmsObjectId: { '!=': null } })
      const byObject = new Map(uploads.map(u => [u.dmsObjectId, u]))
      return files
        .map(f => {
          const u = byObject.get(f.objectId)
          return { ...f, uploadID: u?.ID ?? null, uploadStatus: u?.status_code ?? null, uploadStatusName: u?.statusName ?? null, uploadCriticality: u?.criticality ?? null }
        })
    })

    this.on('dmsDownload', async req => {
      const { objectId } = req.data
      const upload = await SELECT.one.from(db.Uploads).columns('createdBy', 'fileName').where({ dmsObjectId: objectId })
      try {
        const files = upload ? [] : await listFiles()
        const name = upload?.fileName ?? files.find(f => f.objectId === objectId)?.name ?? 'file'
        const { content, mediaType } = await readFile(objectId)
        return { fileName: name, mediaType, content: content.toString('base64') }
      } catch (e) {
        return req.reject(502, e.message)
      }
    })

    this.on('upload', async req => {
      const { fileName, content, format = '1', mode = 'PARK', sortAndSplit = false, suppressValidations = false, dateFormat = 'MMDDYYYY', validateOnly = false } = req.data
      if (!fileName || !content) return req.reject(400, 'Send fileName and content (base64).')
      if (!/\.(xlsx|csv)$/i.test(fileName)) return req.reject(400, 'Only .xlsx and .csv files are supported.')
      if (!['1', '3'].includes(format)) return req.reject(400, 'format must be 1 or 3.')
      if (!['PARK', 'POST'].includes(mode)) return req.reject(400, 'mode must be PARK or POST.')
      if (suppressValidations && format !== '3') {
        return req.reject(400, 'Suppress Validations is only for the 3-Currency format.')
      }
      const buffer = Buffer.from(content, 'base64')
      if (buffer.length > MAX_FILE_BYTES) return req.reject(413, 'The file is larger than 25 MB.')

      // Same file already in process or done: block it (Gap 8)
      const fileHash = createHash('sha256').update(buffer).digest('hex')
      const existing = await SELECT.one.from(db.Uploads).columns('ID', 'status_code', 'createdAt', 'createdBy')
        .where({ fileHash, status_code: { in: ACTIVE } })
      if (existing) {
        return { ID: null, status: 'DUPLICATE', duplicateOf: existing.ID, message: `This file was already submitted by ${existing.createdBy} at ${existing.createdAt} (status ${existing.status_code}). It was not sent again.` }
      }

      // The file content goes to Document Management only; HANA keeps its metadata (Gap 4).
      // A DMS problem does not stop the upload.
      const ID = cds.utils.uuid()
      const file = { ID: cds.utils.uuid(), fileName, mediaType: mediaTypeOf(fileName), size: buffer.length, fileHash, dmsStatus: 'NOT_CONFIGURED' }
      let stored = '', dmsError = null
      if (dmsConfigured()) {
        try {
          const doc = await storeFile({ fileName, mediaType: file.mediaType, content: buffer })
          Object.assign(file, { dmsRepository: doc.repository, dmsFolder: doc.folder, dmsObjectId: doc.objectId, dmsFileName: doc.name, dmsStatus: 'STORED' })
          stored = ' · stored in Document Management'
        } catch (e) {
          LOG.warn('DMS store failed', e.message)
          file.dmsStatus = 'FAILED'
          dmsError = e.message
          stored = ' · not stored in Document Management'
        }
      }
      await INSERT.into(db.SourceFiles).entries(file)
      await INSERT.into(db.Uploads).entries({
        ID, fileName, fileHash, format, requestedMode: mode, sortAndSplit, suppressValidations,
        status_code: 'STARTED', progress: 5, sourceFileId: file.ID,
        dmsObjectId: file.dmsObjectId, dmsFileName: file.dmsFileName, dmsStatus: file.dmsStatus
      })
      if (dmsError) {
        await INSERT.into(db.Messages).entries({ upload_ID: ID, lineNo: 0, source: 'DMS', severity_code: 'W', code: 'DMS_NOT_STORED', text: `The file could not be stored in Document Management: ${dmsError}` })
      }
      await addStep(ID, 'Upload Started', `${fileName}, ${(buffer.length / 1024).toFixed(0)} KB${stored}`)

      // Run after this request commits, so the UI can start polling right away.
      // cds.spawn alone starts on setImmediate, before the commit: on HANA the background
      // transaction would not see the new Uploads row yet.
      req.on('succeeded', () => cds.spawn({ user: req.user, tenant: req.tenant }, async () => {
        const ok = await this.#validate(ID, { buffer, fileName, format, suppress: suppressValidations, sortAndSplit, dateFormat, keepOpen: validateOnly })
        if (ok && !validateOnly) await this.#splitAndPost(ID)
        else if (ok) await this.#preview(ID)
      }))
      return { ID, status: 'STARTED', duplicateOf: null, message: 'Upload started.' }
    })

    // Submit after a validate-only run (or retry)
    this.on('submit', 'Uploads', async req => {
      const { ID } = req.params[0]
      const upload = await SELECT.one.from(db.Uploads).where({ ID })
      if (!upload) return req.reject(404)
      if (!['VALIDATED', 'PARTIAL'].includes(upload.status_code)) return req.reject(409, `Only validated uploads can be submitted (status is ${upload.status_code}).`)
      await UPDATE(db.Uploads, ID).set({ status_code: 'SPLITTING', progress: 55 })
      req.on('succeeded', () => cds.spawn({ user: req.user, tenant: req.tenant }, () => this.#splitAndPost(ID)))
      return SELECT.one.from(db.Uploads).where({ ID })
    })

    // ---------------------------------------------------------------------
    // Gap 6: consolidated error report + AI explanation
    // ---------------------------------------------------------------------
    this.on('errorReport', 'Uploads', async req => {
      const { ID } = req.params[0]
      const upload = await SELECT.one.from(db.Uploads).where({ ID })
      if (!upload) return req.reject(404)
      const messages = await SELECT.from(db.Messages).where({ upload_ID: ID })
      const buffer = await buildErrorReport(upload, messages)
      return {
        fileName: `${upload.fileName.replace(/\.\w+$/, '')}_errors.xlsx`,
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: buffer.toString('base64')
      }
    })

    // The journals that were not sent, as an Excel file in the uploaded layout, ready to correct and upload again
    this.on('errorLinesFile', 'Uploads', async req => {
      const { ID } = req.params[0]
      const upload = await SELECT.one.from(db.Uploads).where({ ID })
      if (!upload) return req.reject(404)
      const [rows, messages, failed, source] = await Promise.all([
        SELECT.from(db.UploadLines).columns('lineNo', 'docRef').where({ upload_ID: ID }),
        SELECT.from(db.Messages).columns('lineNo', 'docRef', 'text').where({ upload_ID: ID, severity_code: 'E' }),
        SELECT.from(db.SubDocuments).columns('docRef').where({ upload_ID: ID, s4Status: 'FAILED' }),
        upload.sourceFileId ? SELECT.one.from(db.SourceFiles).columns('dmsObjectId').where({ ID: upload.sourceFileId }) : null
      ])
      const blocked = journalsWithErrors(rows, messages)
      const docRefs = blocked.all ? new Set(rows.map(r => r.docRef)) : new Set([...blocked.docs, ...failed.map(d => d.docRef)])
      if (!docRefs.size) return req.reject(404, 'Every journal of this upload passed: there are no lines with errors.')

      const objectId = upload.dmsObjectId || source?.dmsObjectId
      if (!objectId) return req.reject(404, 'The original file of this upload is not in Document Management, so its lines cannot be copied.')
      let content
      try {
        ({ content } = await readFile(objectId))
      } catch (e) {
        return req.reject(502, `The original file could not be read from Document Management: ${e.message}`)
      }
      const errors = new Map()
      for (const m of messages) if (m.lineNo > 0) errors.set(m.lineNo, [...(errors.get(m.lineNo) ?? []), m.text])
      const file = await readJournalTable(content, upload.fileName)
      const { buffer, lines } = await buildErrorLinesFile(file, docRefs, new Map(rows.map(r => [r.lineNo, r])), errors)
      LOG.info(`lines with errors for upload ${ID}: ${docRefs.size} journal(s), ${lines} line(s)`)
      return {
        fileName: `${upload.fileName.replace(/\.\w+$/, '')}_lines_with_errors.xlsx`,
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: buffer.toString('base64')
      }
    })

    this.on('explain', 'Messages', async req => {
      const { ID } = req.params[0]
      const message = await SELECT.one.from(db.Messages).where({ ID })
      if (!message) return req.reject(404)
      const aiExplanation = await explain(message)
      await UPDATE(db.Messages, ID).set({ aiExplanation })
      return { ...message, aiExplanation }
    })

    return super.init()
  }

  // -----------------------------------------------------------------------
  // Validation: template -> ZMAXX rules (Gap 7, 9) -> SAP standard check
  // -----------------------------------------------------------------------
  // keepOpen: the split preview runs next and sets the final status
  async #validate(ID, { buffer, fileName, format, suppress, dateFormat, keepOpen = false }) {
    const db = cds.entities('zmaxx')
    try {
      await UPDATE(db.Uploads, ID).set({ status_code: 'VALIDATING', progress: 10 })
      const { rows, messages } = await parseTemplate(buffer, fileName, { dateFormat })
      if (rows.length > MAX_LINES) messages.push({ lineNo: null, source: 'TEMPLATE', severity_code: 'E', code: 'TEMPLATE_TOO_MANY_LINES', text: `The file has ${rows.length} lines; the limit is ${MAX_LINES}.` })

      // Keep every line with its row number (Gap 10)
      for (const r of rows) Object.assign(r, { ID: cds.utils.uuid(), upload_ID: ID })
      if (rows.length) await INSERT.into(db.UploadLines).entries(rows.map(lineRecord))
      await UPDATE(db.Uploads, ID).set({ totalLines: rows.length, progress: 25 })

      // Real master data from S/4 (destination S43)
      const s4 = getS4Client()
      const [master, ttypeRules, rates] = await Promise.all([
        s4.getMasterData({
          companyCodes: [...new Set(rows.map(r => r.companyCode).filter(Boolean))],
          glAccounts: rows.map(r => [r.companyCode, r.glAccount]),
          costCenters: rows.map(r => [r.companyCode, r.costCenter])
        }),
        SELECT.from(db.TTypeRules),
        loadRates()
      ])
      messages.push(...validateMasterData(rows, master))
      messages.push(...validateZmaxx(rows, { format, suppress, ttypeRules, glAccounts: master.glAccounts, companyCodes: master.companyCodes, rates }))
      // The $1M approval rule needs a USD rate for every transaction currency
      for (const [currency, lines] of groupBy(rows.filter(r => r.currencyTC), r => r.currencyTC)) {
        if (!rates.has(currency)) messages.push({ lineNo: lines[0].lineNo, docRef: lines[0].docRef, field: 'currencyTC', source: 'ZMAXX_RULE', severity_code: 'E', code: 'ZMAXX_NO_FX_RATE', text: `No USD exchange rate is maintained for ${currency}. Ask the Journal Upload admin to add it (Admin service, ExchangeRates).` })
      }
      await UPDATE(db.Uploads, ID).set({ progress: 40 })

      // SAP's own posting simulation, when switched on: only for journals without errors so far
      if (cds.env.zmaxx.s43.sapCheck) {
        const blocked = journalsWithErrors(rows, messages)
        for (const [docRef, lines] of groupBy(rows, r => r.docRef)) {
          if (blocked.all || blocked.docs.has(docRef)) continue
          for (const [currencyTC, cl] of groupBy(lines, l => l.currencyTC)) {
            for (let i = 0; i < cl.length; i += 950) messages.push(...await s4.checkDocument({ docRef, currencyTC, lines: cl.slice(i, i + 950) }))
          }
        }
      }

      await saveMessages(ID, rows, messages)
      const errorCount = messages.filter(m => m.severity_code === 'E').length
      const warningCount = messages.filter(m => m.severity_code === 'W').length
      // A journal with any error is held back; journals without errors go ahead
      const blocked = journalsWithErrors(rows, messages)
      const journals = [...new Set(rows.map(r => r.docRef))]
      const ready = blocked.all ? [] : journals.filter(d => !blocked.docs.has(d))
      const held = journals.filter(d => !ready.includes(d))
      const readyLines = rows.filter(r => ready.includes(r.docRef)).length
      const ok = ready.length > 0
      const status = !ok ? 'HAS_ERRORS' : held.length ? 'PARTIAL' : 'VALIDATED'
      await UPDATE(db.Uploads, ID).set({ status_code: ok ? (keepOpen ? 'VALIDATING' : status) : 'HAS_ERRORS', progress: ok ? (keepOpen ? 80 : 50) : 100, errorCount, warningCount })
      const errorLines = new Set(messages.filter(m => m.severity_code === 'E').map(m => m.lineNo)).size
      await addStep(ID, 'Validation Complete',
        errorCount === 0 ? `${rows.length} lines, no errors${warningCount ? `, ${warningCount} warnings` : ''}`
          : ok ? `${errorCount} error${errorCount === 1 ? '' : 's'} on ${errorLines} line(s): ${held.length} journal(s) held back (${held.join(', ')}); ${ready.length} journal(s) with ${readyLines} lines are ready`
            : `${errorCount} error${errorCount === 1 ? '' : 's'} on ${errorLines} line(s); download the error report`)
      return ok
    } catch (e) {
      await this.#fail(ID, 'Validation', e)
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Split (Gap 1, 5) -> park/post (S/4) -> attach (Gap 4) -> workflow (Gap 3)
  // -----------------------------------------------------------------------
  // Split the validated lines and decide post/park per journal; saves the sub-documents
  async #split(ID, upload, s4Status = null) {
    const db = cds.entities('zmaxx')
    const [rows, config, bands, rates] = await Promise.all([
      SELECT.from(db.UploadLines).where({ upload_ID: ID }).orderBy('lineNo'),
      SELECT.one.from(db.SplitConfig).where({ id: 'DEFAULT' }),
      SELECT.from(db.AmountBands),
      loadRates()
    ])
    const all = rows.map(r => ({ ...r, amountTC: num(r.amountTC), amountLC: num(r.amountLC), amountGC: num(r.amountGC) }))
    // Journals with errors are held back; only the others are split and sent
    const errors = await SELECT.from(db.Messages).columns('lineNo', 'docRef').where({ upload_ID: ID, severity_code: 'E' })
    const blocked = journalsWithErrors(all, errors)
    const numeric = blocked.all ? [] : all.filter(r => !blocked.docs.has(r.docRef))
    const heldJournals = [...groupBy(all.filter(r => blocked.all || blocked.docs.has(r.docRef)), r => r.docRef)]
    const { documents, messages } = splitDocuments(numeric, { config, bands, sortAndSplit: upload.sortAndSplit, rates })

    // A preview may already exist from a validate-only run
    await UPDATE(db.UploadLines).set({ subDocument_ID: null }).where({ upload_ID: ID })
    await DELETE.from(db.SubDocuments).where({ upload_ID: ID })
    for (const doc of documents) {
      doc.ID = cds.utils.uuid()
      Object.assign(doc, decideRouting(doc, { requestedMode: upload.requestedMode, approvalUSD: Number(config.approvalUSD), rates }))
      await INSERT.into(db.SubDocuments).entries({
        ID: doc.ID, upload_ID: ID, seq: doc.seq, docRef: doc.docRef, companyCode: doc.companyCode, currencyTC: doc.currencyTC,
        amountBand: doc.amountBand, splitReason: doc.splitReason, lineCount: doc.lines.length + (doc.clearingLine ? 1 : 0),
        hasTax: doc.hasTax, totalDebitUSD: doc.totalDebitUSD, needsApproval: doc.needsApproval, approvalReason: doc.approvalReason,
        postingMode: doc.postingMode, s4Status
      })
      await UPDATE(db.UploadLines).set({ subDocument_ID: doc.ID, amountBand: doc.amountBand }).where({ ID: { in: doc.lines.map(l => l.ID) } })
    }
    let seq = documents.length
    for (const [docRef, lines] of heldJournals) {
      await INSERT.into(db.SubDocuments).entries({
        upload_ID: ID, seq: ++seq, docRef, companyCode: lines[0].companyCode, currencyTC: lines[0].currencyTC, splitReason: 'NONE',
        lineCount: lines.length, s4Status: 'HELD', needsApproval: false, approvalReason: 'Has errors: fix them and upload this journal again'
      })
    }
    await UPDATE(db.Uploads, ID).set({ documentCount: documents.length })
    return { rows: numeric, numeric, documents, messages, held: heldJournals.map(([d]) => d) }
  }

  // Validate only: show the journals that would be created, nothing is sent to S/4 (FR-01, FR-03, FR-05)
  async #preview(ID) {
    const db = cds.entities('zmaxx')
    try {
      const upload = await SELECT.one.from(db.Uploads).where({ ID })
      const { rows, numeric, documents, messages, held } = await this.#split(ID, upload, 'PREVIEW')
      if (messages.length) {
        await saveMessages(ID, numeric, messages.map(m => ({ ...m, severity_code: 'W', text: `${m.text} Sending to SAP will stop here until the clearing account is set.` })))
        await UPDATE(db.Uploads, ID).with({ warningCount: { '+=': messages.length } })
      }
      const parked = documents.filter(d => d.postingMode === 'PARK').length
      const reasons = [...new Set(documents.flatMap(d => d.splitReason.split(',')).filter(r => r !== 'NONE'))]
      await UPDATE(db.Uploads, ID).set({ status_code: held.length ? 'PARTIAL' : 'VALIDATED', progress: 100 })
      const routing = `${documents.length - parked} to post, ${parked} to park for approval.${held.length ? ` ${held.length} journal(s) with errors held back.` : ''} Nothing was sent to SAP.`
      if (reasons.length) {
        await addStep(ID, 'Split Preview', `${rows.length} lines would become ${documents.length} journal(s) (split by ${reasons.join(', ').toLowerCase().replace(/_/g, ' ')}): ${routing}`)
      } else {
        // Sort and split off (or nothing to split): the journals stay as in the file
        await addStep(ID, 'Journal Preview', `${rows.length} lines in ${documents.length} journal(s) as in the file, not split: ${routing}`)
      }
    } catch (e) {
      LOG.error(`Split preview failed for upload ${ID}`, e)
      const { errorCount } = await SELECT.one.from(db.Uploads).columns('errorCount').where({ ID })
      await UPDATE(db.Uploads, ID).set({ status_code: errorCount ? 'PARTIAL' : 'VALIDATED', progress: 100 })
    }
  }

  // Metadata from HANA plus the content from Document Management, for the S/4 attachment.
  // null (with a warning on the upload) when the file is not in DMS.
  async #sourceFile(ID, sourceFileId) {
    const db = cds.entities('zmaxx')
    const meta = await SELECT.one.from(db.SourceFiles).where({ ID: sourceFileId })
    let reason = 'it was not stored in Document Management'
    if (meta?.dmsObjectId) {
      try {
        const { content } = await readFile(meta.dmsObjectId)
        return { ...meta, content }
      } catch (e) {
        LOG.warn('DMS read failed', e.message)
        reason = `it could not be read from Document Management: ${e.message}`
      }
    }
    await INSERT.into(db.Messages).entries({ upload_ID: ID, lineNo: 0, source: 'DMS', severity_code: 'W', code: 'DMS_NO_ATTACHMENT', text: `The source file was not attached to the journals because ${reason}` })
    await UPDATE(db.Uploads, ID).with({ warningCount: { '+=': 1 } })
    return null
  }

  async #splitAndPost(ID) {
    const db = cds.entities('zmaxx')
    try {
      const upload = await SELECT.one.from(db.Uploads).where({ ID })
      await UPDATE(db.Uploads, ID).set({ status_code: 'SPLITTING', progress: 55 })
      const { rows, numeric, documents, messages, held } = await this.#split(ID, upload)
      if (messages.length) {
        await saveMessages(ID, numeric, messages)
        throw new Error(messages[0].text)
      }
      await UPDATE(db.Uploads, ID).set({ status_code: 'POSTING', progress: 65 })
      const reasons = [...new Set(documents.flatMap(d => d.splitReason.split(',')).filter(r => r !== 'NONE'))]
      await addStep(ID, 'Upload Complete', `${rows.length} lines in ${documents.length} journals${reasons.length ? ` (split by ${reasons.join(', ').toLowerCase().replace(/_/g, ' ')})` : ''}${held.length ? `; ${held.length} journal(s) with errors held back` : ''}`)

      // Create journals in S/4 through F2548's posting engine (destination S43)
      const s4 = getS4Client()
      const file = await this.#sourceFile(ID, upload.sourceFileId)
      const verifyWorkflow = documents.some(d => d.needsApproval) ? await s4.workflowStatus() : false
      let parked = 0, posted = 0, failed = 0, workflows = 0, awaitingApproval = 0
      for (const [i, doc] of documents.entries()) {
        const result = {}
        let key = null
        try {
          key = await s4.createJournal(doc, doc.postingMode)
        } catch (e) {
          failed++
          result.s4Status = 'FAILED'
          await saveMessages(ID, numeric, [{ lineNo: doc.lines[0].lineNo, docRef: doc.docRef, source: 'POSTING', severity_code: 'E', code: e.sapMessages?.[0]?.code || 'POSTING_FAILED', text: `Journal ${doc.seq} was not created in SAP: ${e.message}` }], { append: true })
        }
        if (key) {
          // Only a document number from SAP counts as created
          Object.assign(result, { s4CompanyCode: key.companyCode, s4DocumentNumber: key.documentNumber, s4FiscalYear: key.fiscalYear, s4Status: doc.postingMode === 'PARK' ? 'PARKED' : 'POSTED' })
          doc.postingMode === 'PARK' ? parked++ : posted++
          // The journal exists; a missing or failed attachment is a warning, not a failed journal.
          // With DMS-only storage there is no file when Document Management could not store it.
          try {
            if (!file) throw new Error('the source file is not available from Document Management')
            result.attachmentId = await s4.attachFile(key, file)
          } catch (e) {
            await saveMessages(ID, numeric, [{ lineNo: doc.lines[0].lineNo, docRef: doc.docRef, source: 'POSTING', severity_code: 'W', code: 'ATTACH_FAILED', text: `Journal ${key.documentNumber} was created, but the source file could not be attached: ${e.message}` }])
          }
          // Parked journals are approved in the standard Verify General Journal Entries apps
          if (doc.needsApproval) {
            awaitingApproval++
            Object.assign(result, { workflowStatus: verifyWorkflow ? 'IN_VERIFY_GJE' : 'NO_WORKFLOW_ACTIVE' })
            if (verifyWorkflow) workflows++
          }
        }
        await UPDATE(db.SubDocuments, doc.ID).set(result)
        await UPDATE(db.Uploads, ID).set({ progress: 65 + Math.round(((i + 1) / documents.length) * 33) })
      }

      await addStep(ID, 'Journal Created', `${posted} posted, ${parked} parked${failed ? `, ${failed} failed` : ''}`)
      const workflowDetail = posted + parked === 0 ? 'Skipped: no journal reached SAP'
        : workflows ? `${workflows} sent for approval in Verify General Journal Entries`
          : awaitingApproval ? `${awaitingApproval} parked for approval; no approval workflow is active in SAP`
            : 'No approval needed'
      await addStep(ID, posted + parked === 0 ? 'Workflow Skipped' : 'Workflow Created', workflowDetail)
      await UPDATE(db.Uploads, ID).set({ status_code: failed === documents.length ? 'FAILED' : held.length ? 'PARTIAL_DONE' : 'COMPLETED', progress: 100 })
    } catch (e) {
      await this.#fail(ID, 'Posting', e)
    }
  }

  async #fail(ID, stage, e) {
    LOG.error(`${stage} failed for upload ${ID}`, e)
    const db = cds.entities('zmaxx')
    // Also as an error message, so the Messages tab and the error report say why the run stopped
    await INSERT.into(db.Messages).entries({
      upload_ID: ID, lineNo: 0, source: 'SYSTEM', severity_code: 'E', code: `${stage.toUpperCase()}_FAILED`,
      text: `${stage} stopped because of a technical problem${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message}`.slice(0, 500)
    })
    const { count } = await SELECT.one.from(db.Messages).columns('count(*) as count').where({ upload_ID: ID, severity_code: 'E' })
    await UPDATE(db.Uploads, ID).set({ status_code: 'FAILED', progress: 100, errorCount: count })
    await addStep(ID, `${stage} Failed`, String(e.message).slice(0, 250))
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Journals that have at least one error. A message without a journal (for example a file-level
// problem) blocks every journal.
function journalsWithErrors(rows, messages) {
  const byLine = new Map(rows.map(r => [r.lineNo, r.docRef]))
  const docs = new Set()
  let all = false
  for (const m of messages) {
    if ((m.severity_code ?? 'E') !== 'E') continue
    const doc = m.docRef ?? byLine.get(m.lineNo)
    if (doc) docs.add(doc)
    else all = true
  }
  return { docs, all }
}

async function addStep(uploadId, step, detail) {
  const db = cds.entities('zmaxx')
  const { count } = await SELECT.one.from(db.StatusSteps).columns('count(*) as count').where({ upload_ID: uploadId })
  await INSERT.into(db.StatusSteps).entries({ upload_ID: uploadId, seq: count + 1, step, at: new Date().toISOString(), detail })
}

async function saveMessages(uploadId, rows, messages, { append = false } = {}) {
  const db = cds.entities('zmaxx')
  if (!messages.length) return
  const byLine = new Map(rows.map(r => [r.lineNo, r]))
  await INSERT.into(db.Messages).entries(messages.map(m => ({
    upload_ID: uploadId,
    line_ID: byLine.get(m.lineNo)?.ID ?? null,
    lineNo: m.lineNo, docRef: m.docRef ?? byLine.get(m.lineNo)?.docRef ?? null,
    source: m.source, severity_code: m.severity_code, code: String(m.code ?? '').slice(0, 30), field: m.field ?? null, text: String(m.text).slice(0, 500)
  })))
  const errorLines = [...new Set(messages.filter(m => m.severity_code === 'E').map(m => byLine.get(m.lineNo)?.ID).filter(Boolean))]
  if (errorLines.length) await UPDATE(db.UploadLines).set({ hasError: true }).where({ ID: { in: errorLines } })
  if (append) {
    const errors = messages.filter(m => m.severity_code === 'E').length
    await UPDATE(db.Uploads, uploadId).with({ errorCount: { '+=': errors } })
  }
}

async function loadRates() {
  const rows = await SELECT.from(cds.entities('zmaxx').ExchangeRates)
  return new Map(rows.map(r => [r.currency, Number(r.toUSD)]))
}

const LINE_FIELDS = ['ID', 'upload_ID', 'lineNo', 'docRef', 'companyCode', 'documentType', 'documentDate', 'postingDate', 'fiscalPeriod', 'reference', 'headerText',
  'businessArea', 'glAccount', 'costCenter', 'ttype', 'taxCode', 'itemText', 'amountTC', 'currencyTC', 'amountLC', 'currencyLC', 'amountGC', 'currencyGC']

function lineRecord(r) {
  const rec = {}
  for (const f of LINE_FIELDS) rec[f] = r[f] ?? null
  // keep DB string lengths safe; overlong values were already reported by SAP check
  for (const [f, n] of [['reference', 16], ['headerText', 25], ['itemText', 50]]) if (rec[f]) rec[f] = String(rec[f]).slice(0, n)
  return rec
}

const num = v => (v === null || v === undefined ? null : Number(v))
const mediaTypeOf = f => (/\.csv$/i.test(f) ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
