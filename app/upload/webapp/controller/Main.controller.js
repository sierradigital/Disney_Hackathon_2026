sap.ui.define([
  'sap/ui/core/mvc/Controller',
  'sap/ui/model/json/JSONModel',
  'sap/m/MessageBox',
  'sap/m/MessageToast'
], function (Controller, JSONModel, MessageBox, MessageToast) {
  'use strict'

  const SRV = '/odata/v4/zmaxx'
  const ADMIN = '/odata/v4/admin'
  const STAGES = ['Upload Started', 'Validation Complete', 'Upload Complete', 'Journal Created', 'Workflow Created']
  const FINAL = ['HAS_ERRORS', 'COMPLETED', 'FAILED', 'VALIDATED', 'PARTIAL', 'PARTIAL_DONE']
  const PREVIEW_STEPS = ['Split Preview', 'Journal Preview'] // last step of a Validate run
  const READY = ['VALIDATED', 'PARTIAL'] // validated, journals can still be posted
  const PAGE_SIZE = 50
  const BANDS = { UNDER_1: 'Under 1 USD', '1_TO_100': '1 to 100 USD', OVER_100: 'Over 100 USD' }

  return Controller.extend('zmaxx.upload.controller.Main', {

    onInit() {
      this.ui = new JSONModel({
        format: '1', mode: 'POST', dateFormat: 'MMDDYYYY', sortAndSplit: true, suppress: false,
        layout: 'OneColumn', view: 'none', postingEnabled: false, busy: false, upload: null, stages: [], messages: [], docs: [],
        lines: [], linesBusy: false, detailBusy: false, resultsBusy: false, page: 1, pageCount: 0, lineMode: 'all', lineSearch: '',
        recent: [], recentBusy: false, notice: {}, bar: { percent: 0, text: '' },
        historyView: 'uploads', dms: {}, dmsFiles: [], dmsBusy: false,
        rules: [], deletedRules: [], ttypes: [], rulesBusy: false
      })
      this.getView().setModel(this.ui, 'ui')
      // Remove the loading screen from index.html once the page is on screen
      this.getView().addEventDelegate({ onAfterRendering: () => document.getElementById('juSplash')?.remove() })
      this.csrf = null
      this.request('GET', `${SRV}/postingEnabled()`)
        .then(r => this.ui.setProperty('/postingEnabled', Boolean(r.value)))
        .catch(() => this.ui.setProperty('/postingEnabled', false))
      this.loadRecent()
      // Deep link from the Excel add-in: index.html?upload=<ID>
      const linked = new URLSearchParams(window.location.search).get('upload')
      if (linked) {
        this.showResults('inline')
        this.load(linked).catch(err => MessageBox.error(err.message))
      }
    },

    // ---------------------------------------------------------------- upload (FR-02)
    onFileChange(e) {
      this.file = e.getParameter('files') && e.getParameter('files')[0]
    },

    // Validate first; journals that pass are posted with Post Validated Journals
    onValidate() { this.send() },

    async send() {
      if (!this.file) return MessageToast.show('Choose a journal file first.')
      const m = this.ui.getData()
      this.ui.setProperty('/busy', true)
      // Open the results page right away with a busy indicator while the file is sent
      clearTimeout(this.timer)
      this.reset()
      this.uploadId = null
      this.ui.setProperty('/upload', null)
      this.ui.setProperty('/detailBusy', true)
      this.showResults('page')
      try {
        const content = await readAsBase64(this.file)
        const res = await this.request('POST', `${SRV}/upload`, {
          fileName: this.file.name, content, format: m.format, mode: m.mode, sortAndSplit: m.sortAndSplit,
          suppressValidations: m.suppress, dateFormat: m.dateFormat, validateOnly: true
        })
        if (res.status === 'DUPLICATE') {
          MessageBox.warning(res.message, { title: 'File already submitted' })
          return this.load(res.duplicateOf)
        }
        this.load(res.ID).catch(err => MessageBox.error(err.message))
        this.loadRecent()
        this.scrollTo(null)
      } catch (err) {
        // Nothing was uploaded: back to the upload page
        this.ui.setProperty('/detailBusy', false)
        this.showResults('none')
        MessageBox.error(err.message)
      } finally {
        this.ui.setProperty('/busy', false)
      }
    },

    onClear() {
      clearTimeout(this.timer)
      this.byId('file').clear()
      this.file = null
      this.reset()
      this.ui.setProperty('/upload', null)
      this.ui.setProperty('/stages', [])
      this.ui.setProperty('/notice', {})
      this.ui.setProperty('/bar', { percent: 0, text: '' })
      this.showResults('none')
      this.byId('page').setHeaderExpanded(true)
    },

    // Where the results show: 'page' = own full page after Validate (back arrow returns),
    // 'side' = mid column when opened from the list, 'inline' = between the upload section
    // and the recent uploads, 'none' = nothing open
    showResults(where) {
      const results = this.byId('results')
      if (where === 'side' || where === 'page') {
        if (results.getParent() !== this.byId('midHost')) this.byId('midHost').addItem(results)
        if (where === 'page') this.ui.setProperty('/layout', 'MidColumnFullScreen')
        else if (this.ui.getProperty('/layout') === 'OneColumn') this.ui.setProperty('/layout', 'TwoColumnsMidExpanded')
      } else {
        if (results.getParent() !== this.byId('beginHost')) this.byId('beginHost').insertItem(results, 0)
        this.ui.setProperty('/layout', 'OneColumn')
      }
      this.ui.setProperty('/view', where)
    },

    onToggleFullScreen() {
      const full = this.ui.getProperty('/layout') === 'MidColumnFullScreen'
      this.ui.setProperty('/layout', full ? 'TwoColumnsMidExpanded' : 'MidColumnFullScreen')
    },

    // Close the side column or go back from the results page: the same upload stays open, back on the main page
    // between the upload section and the recent uploads (Clear starts over)
    onCloseDetail() {
      this.showResults('inline')
      this.byId('page').setHeaderExpanded(true)
      this.scrollTo(null, 'page')
    },

    reset() {
      this.ui.setProperty('/messages', [])
      this.ui.setProperty('/docs', [])
      this.ui.setProperty('/lines', [])
      this.ui.setProperty('/lineMode', 'all')
    },

    // Poll the upload until it reaches a final status (FR-08)
    async load(ID) {
      clearTimeout(this.timer)
      const opening = ID !== this.uploadId
      if (opening) {
        // Show a busy indicator, not the previous upload, until this one arrives
        this.watching = false
        this.ui.setProperty('/upload', null)
        this.ui.setProperty('/detailBusy', true)
      }
      this.uploadId = ID
      let u
      try {
        u = await this.request('GET', `${SRV}/Uploads(${ID})?$expand=status,steps($orderby=seq)`)
      } finally {
        if (opening) this.ui.setProperty('/detailBusy', false)
      }
      if (ID !== this.uploadId) return // another upload was opened meanwhile
      this.ui.setProperty('/upload', u)
      this.ui.setProperty('/stages', this.buildStages(u.steps, u.status_code))
      this.ui.setProperty('/notice', this.buildNotice(u))
      this.ui.setProperty('/bar', this.buildBar(u))
      if (!FINAL.includes(u.status_code)) {
        this.watching = true
        this.timer = setTimeout(() => this.load(ID), 1200)
        return
      }
      if (this.ui.getProperty('/view') === 'inline') this.byId('page').setHeaderExpanded(false)
      this.ui.setProperty('/resultsBusy', true)
      try {
        await Promise.all([this.loadMessages(), this.loadDocs(), this.loadLines(1), this.loadRecent()])
      } finally {
        this.ui.setProperty('/resultsBusy', false)
      }
      if (this.ui.getProperty('/historyView') === 'dms') this.loadDms()
      // Open the tab that matters most for this result
      this.byId('tabs').setSelectedKey(['PARTIAL', 'PARTIAL_DONE'].includes(u.status_code) ? 'journals' : u.errorCount > 0 || u.status_code === 'FAILED' ? 'messages' : 'journals')
      // A validation that just finished: offer to post the journals that passed
      if (this.watching && READY.includes(u.status_code)) this.askToPost()
      this.watching = false
    },

    // ------------------------------------------------ post after Validate
    onPostValidated() { this.askToPost() },

    askToPost() {
      const u = this.ui.getProperty('/upload')
      if (!u || !READY.includes(u.status_code) || !this.ui.getProperty('/postingEnabled')) return
      const docs = this.ui.getProperty('/docs')
      const ready = docs.filter(d => d.s4Status === 'PREVIEW')
      const held = docs.filter(d => d.s4Status === 'HELD')
      if (!ready.length) return
      const parked = ready.filter(d => d.postingMode === 'PARK').length
      const lines = ready.reduce((s, d) => s + (d.lineCount || 0), 0)
      const refs = [...new Set(ready.map(d => d.docRef))]
      const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
      const text = [
        `${plural(ready.length, 'journal')} (${plural(lines, 'line')}) passed validation and can be sent to SAP.`,
        `From uploaded journal${refs.length === 1 ? '' : 's'} ${refs.join(', ')}.`,
        `${ready.length - parked} will be posted${parked ? `, ${parked} parked for approval` : ''}.`,
        held.length ? `${plural(held.length, 'journal')} with errors (${held.map(d => d.docRef).join(', ')}) are held back and will not be sent.` : '',
        '', 'Do you want to post the validated journals now?'
      ].filter((l, i, a) => l || a[i + 1]).join('\n')
      MessageBox.confirm(text, {
        title: 'Validated Journals Ready to Post',
        actions: ['Post to SAP', 'Not Now'],
        emphasizedAction: 'Post to SAP',
        onClose: action => action === 'Post to SAP' && this.postValidated(u.ID)
      })
    },

    async postValidated(ID) {
      this.ui.setProperty('/busy', true)
      try {
        await this.request('POST', `${SRV}/Uploads(${ID})/ZmaxxService.submit`, {})
        MessageToast.show('Sending the validated journals to SAP…')
        this.watching = false
        await this.load(ID)
      } catch (err) {
        MessageBox.error(err.message)
      } finally {
        this.ui.setProperty('/busy', false)
      }
    },

    buildStages(steps, statusCode) {
      const at = s => new Date(s.at).toLocaleTimeString()
      const byName = Object.fromEntries((steps || []).map(s => [s.step, s]))
      const stopped = (steps || []).find(s => /(Failed|Skipped)$/.test(s.step))
      const stages = STAGES.map(name => ({ name, done: !!byName[name], detail: byName[name] ? byName[name].detail : '', at: byName[name] ? at(byName[name]) : '' }))
      if (stopped) stages.push({ name: stopped.step, done: false, failed: true, detail: stopped.detail, at: at(stopped) })
      // Extra steps such as the Validate preview go right after validation
      const extras = (steps || []).filter(s => !STAGES.includes(s.step) && !/(Failed|Skipped)$/.test(s.step))
        .map(s => ({ name: s.step, done: true, detail: s.detail, at: at(s) }))
      stages.splice(2, 0, ...extras)
      // "Journal Created": nothing created = failed step; some journals failed = warning
      const journal = stages.find(s => s.name === 'Journal Created')
      const counts = journalCounts(journal?.detail)
      if (journal?.done && counts.created === 0) Object.assign(journal, { done: false, failed: true })
      else if (journal?.done && counts.failed > 0) journal.warn = true
      // Validation found errors: flag that step, and say why the later steps did not run
      if (statusCode === 'HAS_ERRORS') {
        for (const s of stages) {
          if (s.name === 'Validation Complete') s.warn = true
          else if (!s.done && !s.failed) s.detail = 'Not started: fix the errors first'
        }
      } else if (statusCode === 'FAILED') {
        for (const s of stages) if (!s.done && !s.failed) s.detail = 'Not started'
      }
      // After a Validate run the posting stages did not happen; leave them out
      if (extras.some(s => PREVIEW_STEPS.includes(s.name))) return stages.filter(s => s.done || s.failed)
      return stages
    },

    // Bar length = how far the process got. While running, the server's percentage;
    // once stopped by errors, the share of the five main steps that were reached.
    buildBar(u) {
      // A step counts only if it succeeded: "Journal Created" with 0 posted and 0 parked did not
      const step = name => (u.steps || []).find(s => s.step === name)
      const journalsOk = step('Journal Created') && journalCounts(step('Journal Created').detail).created > 0
      const reached = STAGES.filter(name => {
        if (!step(name)) return false
        if (name === 'Journal Created') return journalsOk
        if (name === 'Workflow Created') return journalsOk
        return true
      }).length
      const validateRun = (u.steps || []).some(s => PREVIEW_STEPS.includes(s.step))
      switch (u.status_code) {
        case 'HAS_ERRORS':
          return { percent: Math.round(reached / STAGES.length * 100), text: `Stopped at validation: ${reached} of ${STAGES.length} steps` }
        case 'FAILED':
          return { percent: Math.round(reached / STAGES.length * 100), text: `Stopped: ${reached} of ${STAGES.length} steps` }
        case 'VALIDATED':
          return { percent: 100, text: validateRun ? 'Validation finished' : 'Validated, ready to send' }
        case 'PARTIAL':
          return { percent: 100, text: 'Validation finished, some journals held back' }
        case 'PARTIAL_DONE':
          return { percent: 100, text: 'Finished, some journals held back' }
        case 'COMPLETED':
          return { percent: 100, text: 'All steps finished' }
        default:
          return { percent: u.progress || 0, text: `Processing… ${u.progress || 0}%` }
      }
    },

    // Notification above the progress bar once processing has finished
    buildNotice(u) {
      const n = u.errorCount
      switch (u.status_code) {
        case 'HAS_ERRORS':
          return { type: 'Warning', tab: 'messages', linkText: 'Show errors',
            text: `Validation found ${n} error${n === 1 ? '' : 's'}, so nothing was sent to SAP. Correct the file and upload it again.` }
        case 'FAILED':
          return { type: 'Error', tab: 'messages', linkText: 'Show messages',
            text: 'Processing stopped before the journals reached SAP. The messages explain why.' }
        case 'VALIDATED':
          return { type: 'Success', tab: 'journals', linkText: 'Show journals',
            text: `Validation passed: ${u.totalLines} lines, no errors. Nothing was sent to SAP yet; the Journals tab shows what would be created. Use Post Validated Journals to send them.` }
        case 'COMPLETED':
          return { type: 'Success', tab: 'journals', linkText: 'Show journals',
            text: `${u.documentCount} journal${u.documentCount === 1 ? '' : 's'} created in SAP.` }
        case 'PARTIAL':
          return { type: 'Warning', tab: 'journals', linkText: 'Show journals',
            text: `${n} error${n === 1 ? '' : 's'} found. Journals without errors are ready (${u.documentCount}); journals with errors are held back. Nothing was sent to SAP yet: use Post Validated Journals to send the ready ones, then fix the held journals and upload them again.` }
        case 'PARTIAL_DONE':
          return { type: 'Warning', tab: 'journals', linkText: 'Show journals',
            text: `Journals without errors were sent to SAP; journals with ${n} error${n === 1 ? '' : 's'} were held back. Fix them and upload those journals again.` }
        default:
          return {}
      }
    },

    onShowMessages() {
      const tabs = this.byId('tabs')
      tabs.setSelectedKey(this.ui.getProperty('/notice/tab') || 'messages')
      this.scrollTo(tabs)
    },

    // ------------------------------------------------------------- messages (FR-06)
    async loadMessages() {
      const r = await this.request('GET', `${SRV}/Messages?$filter=upload_ID eq ${this.uploadId}&$orderby=lineNo&$top=5000`)
      this.ui.setProperty('/messages', r.value)
    },

    async onExplain(e) {
      const button = e.getSource()
      const ctx = button.getBindingContext('ui')
      const msg = ctx.getObject()
      // The AI answer takes a few seconds
      button.setBusyIndicatorDelay(0).setBusy(true)
      try {
        const r = await this.request('POST', `${SRV}/Messages(${msg.ID})/ZmaxxService.explain`, {})
        this.ui.setProperty(ctx.getPath() + '/aiExplanation', r.aiExplanation)
      } finally {
        button.setBusy(false)
      }
    },

    onDownloadReport() { return this.download('errorReport') },

    // Held-back journals in the uploaded layout, ready to correct and upload again
    onDownloadErrorLines() { return this.download('errorLinesFile') },

    async download(fn) {
      let r
      try {
        r = await this.request('GET', `${SRV}/Uploads(${this.uploadId})/ZmaxxService.${fn}()`)
      } catch (err) {
        return MessageBox.error(err.message)
      }
      const bytes = Uint8Array.from(atob(r.content), c => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: r.mediaType }))
      const a = Object.assign(document.createElement('a'), { href: url, download: r.fileName })
      a.click()
      URL.revokeObjectURL(url)
    },

    // -------------------------------------------------------------- journals
    async loadDocs() {
      const r = await this.request('GET', `${SRV}/SubDocuments?$filter=upload_ID eq ${this.uploadId}&$orderby=seq`)
      this.ui.setProperty('/docs', r.value)
    },

    // ---------------------------------------------------- line review (FR-10)
    lineFilter(extra) {
      const parts = [`upload_ID eq ${this.uploadId}`]
      const mode = this.ui.getProperty('/lineMode')
      if (mode === 'errors') parts.push('hasError eq true')
      // validated = the line went into a split journal, i.e. its journal had no errors
      if (mode === 'valid') parts.push('subDocument_ID ne null')
      if (extra) parts.push(extra)
      return parts.join(' and ')
    },

    async loadLines(page) {
      this.ui.setProperty('/linesBusy', true)
      try {
        const skip = (page - 1) * PAGE_SIZE
        const r = await this.request('GET', `${SRV}/UploadLines?$filter=${encodeURIComponent(this.lineFilter())}&$orderby=lineNo&$top=${PAGE_SIZE}&$skip=${skip}&$count=true&$expand=subDocument($select=s4DocumentNumber)`)
        const count = r['@odata.count']
        this.ui.setProperty('/lines', r.value)
        this.ui.setProperty('/pageCount', Math.max(1, Math.ceil(count / PAGE_SIZE)))
        this.ui.setProperty('/page', page)
      } finally {
        this.ui.setProperty('/linesBusy', false)
      }
    },

    onLinesFilter(e) {
      this.ui.setProperty('/lineMode', e.getParameter('item').getKey())
      this.loadLines(1)
    },
    onFirstPage() { this.loadLines(1) },
    onPrevPage() { this.loadLines(this.ui.getProperty('/page') - 1) },
    onNextPage() { this.loadLines(this.ui.getProperty('/page') + 1) },
    onLastPage() { this.loadLines(this.ui.getProperty('/pageCount')) },
    onPageChange(e) {
      const p = Math.min(Math.max(1, Number(e.getParameter('value')) || 1), this.ui.getProperty('/pageCount'))
      this.loadLines(p)
    },

    // Jump to the page that holds a given spreadsheet line
    async onLineSearch(e) {
      const lineNo = parseInt(e.getParameter('query'), 10)
      if (!lineNo) return
      const r = await this.request('GET', `${SRV}/UploadLines/$count?$filter=${encodeURIComponent(this.lineFilter(`lineNo lt ${lineNo}`))}`)
      await this.loadLines(Math.floor(Number(r) / PAGE_SIZE) + 1)
      const hit = this.ui.getProperty('/lines').find(l => l.lineNo === lineNo)
      MessageToast.show(hit ? `Line ${lineNo} is on page ${this.ui.getProperty('/page')}.` : `Line ${lineNo} is not in this view.`)
    },

    // ---------------------------------------------------------------- upload history
    async loadRecent() {
      this.ui.setProperty('/recentBusy', true)
      try {
        const r = await this.request('GET', `${SRV}/Uploads?$orderby=createdAt desc&$top=200&$expand=status&$select=ID,fileName,createdAt,createdBy,format,requestedMode,totalLines,errorCount,documentCount,status_code,dmsStatus`)
        this.ui.setProperty('/recent', r.value)
      } catch (err) {
        MessageToast.show(`Recent uploads could not be loaded: ${err.message}`)
      } finally {
        this.ui.setProperty('/recentBusy', false)
      }
    },

    // ------------------------------------------------- files in Document Management (Gap 4)
    onHistoryView(e) {
      const key = e.getParameter('item').getKey()
      this.ui.setProperty('/historyView', key)
      if (key === 'dms') this.loadDms()
    },

    onRefreshHistory() {
      return this.ui.getProperty('/historyView') === 'dms' ? this.loadDms() : this.loadRecent()
    },

    async loadDms() {
      this.ui.setProperty('/dmsBusy', true)
      try {
        const info = await this.request('GET', `${SRV}/dmsInfo()`)
        this.ui.setProperty('/dms', info)
        const files = info.reachable ? await this.request('GET', `${SRV}/dmsFiles()`) : { value: [] }
        this.ui.setProperty('/dmsFiles', files.value)
      } catch (err) {
        this.ui.setProperty('/dms', { reachable: false, message: err.message })
        this.ui.setProperty('/dmsFiles', [])
      } finally {
        this.ui.setProperty('/dmsBusy', false)
      }
    },

    async onDmsDownload(e) {
      const { objectId } = e.getSource().getBindingContext('ui').getObject()
      try {
        const r = await this.request('GET', `${SRV}/dmsDownload(objectId='${encodeURIComponent(objectId.replace(/'/g, "''"))}')`)
        const bytes = Uint8Array.from(atob(r.content), c => c.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bytes], { type: r.mediaType }))
        Object.assign(document.createElement('a'), { href: url, download: r.fileName }).click()
        URL.revokeObjectURL(url)
      } catch (err) {
        MessageBox.error(err.message)
      }
    },

    onDmsOpenUpload(e) {
      const { uploadID } = e.getSource().getBindingContext('ui').getObject()
      this.reset()
      this.showResults('side')
      this.load(uploadID).catch(err => MessageBox.error(err.message))
      this.scrollTo(null)
    },

    onRecentPress(e) {
      const item = e.getParameter('listItem') || e.getSource()
      const { ID } = item.getBindingContext('ui').getObject()
      this.reset()
      this.showResults('side')
      this.load(ID).catch(err => MessageBox.error(err.message))
      this.scrollTo(null)
    },

    onOpenHistory() {
      this.byId('page').setHeaderExpanded(false)
      this.scrollTo(this.byId('recentSection'), 'page')
    },

    // Scroll a column's content to a control, or to the top (default: where the results are)
    scrollTo(control, pageId = ['side', 'page'].includes(this.ui.getProperty('/view')) ? 'detail' : 'page') {
      const scroller = this.byId(pageId).getDomRef()?.querySelector('.sapFDynamicPageContentWrapper')
      if (!scroller) return
      const target = control?.getDomRef()
      const top = target ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16 : 0
      scroller.scrollTo({ top, behavior: 'smooth' })
    },

    // ---------------------------------------------------------------- header actions

    // ------------------------------------------------- Transaction Type rules (Gap 7), admins only
    async onOpenRules() {
      this.byId('rulesDialog').open()
      await Promise.all([this.loadRules(), this.loadTTypes()])
    },

    async loadRules() {
      this.ui.setProperty('/rulesBusy', true)
      try {
        const r = await this.request('GET', `${ADMIN}/TTypeRules?$orderby=glAccount,companyCode`)
        this.ui.setProperty('/rules', r.value.map(x => ({ ...x, glAccount: x.glAccount.replace(/^0+(?=\d)/, ''), original: { glAccount: x.glAccount, companyCode: x.companyCode } })))
        this.ui.setProperty('/deletedRules', [])
      } catch (err) {
        MessageBox.error(err.message)
      } finally {
        this.ui.setProperty('/rulesBusy', false)
      }
    },

    async loadTTypes() {
      if (this.ui.getProperty('/ttypes').length) return
      try {
        const r = await this.request('GET', `${SRV}/transactionTypes()`)
        this.ui.setProperty('/ttypes', [{ code: '*', text: 'Any Transaction Type' }, ...r.value])
      } catch (err) {
        MessageToast.show(err.message)
        this.ui.setProperty('/ttypes', [{ code: '*', text: 'Any Transaction Type' }])
      }
    },

    onRuleAdd() {
      const rules = this.ui.getProperty('/rules')
      this.ui.setProperty('/rules', [{ glAccount: '', companyCode: '*', requiredTType: '*', description: '', isNew: true }, ...rules])
    },

    onRuleChange(e) {
      const path = e.getSource().getBindingContext('ui').getPath()
      this.ui.setProperty(`${path}/dirty`, true)
      this.ui.setProperty(`${path}/error`, '')
      this.ui.setProperty(`${path}/errorField`, '')
    },

    onRuleDelete(e) {
      const rule = e.getParameter('listItem').getBindingContext('ui').getObject()
      const rules = this.ui.getProperty('/rules').filter(r => r !== rule)
      if (!rule.isNew) this.ui.setProperty('/deletedRules', [...this.ui.getProperty('/deletedRules'), rule.original])
      this.ui.setProperty('/rules', rules)
    },

    // Deletes, new rules and changes go to the server one by one; errors stay on their row
    async onRulesSave() {
      const key = k => `${ADMIN}/TTypeRules(glAccount='${encodeURIComponent(k.glAccount)}',companyCode='${encodeURIComponent(k.companyCode)}')`
      const rules = this.ui.getProperty('/rules')
      this.ui.setProperty('/rulesBusy', true)
      let failed = 0
      try {
        for (const k of this.ui.getProperty('/deletedRules')) await this.request('DELETE', key(k))
        this.ui.setProperty('/deletedRules', [])
        for (const [i, r] of rules.entries()) {
          if (!r.isNew && !r.dirty) continue
          const body = { glAccount: r.glAccount, companyCode: r.companyCode || '*', requiredTType: r.requiredTType || '*', description: r.description || '' }
          try {
            const keyChanged = !r.isNew && (body.glAccount.padStart(10, '0') !== r.original.glAccount.padStart(10, '0') || body.companyCode !== r.original.companyCode)
            if (r.isNew || keyChanged) {
              await this.request('POST', `${ADMIN}/TTypeRules`, body)
              if (keyChanged) await this.request('DELETE', key(r.original))
            } else {
              await this.request('PATCH', key(r.original), { requiredTType: body.requiredTType, description: body.description })
            }
          } catch (err) {
            failed++
            const field = /G\/L/.test(err.message) ? 'glAccount' : /Company code/.test(err.message) ? 'companyCode' : /Transaction Type/.test(err.message) ? 'requiredTType' : ''
            this.ui.setProperty(`/rules/${i}/error`, err.message)
            this.ui.setProperty(`/rules/${i}/errorField`, field)
          }
        }
      } catch (err) {
        failed++
        MessageBox.error(err.message)
      } finally {
        this.ui.setProperty('/rulesBusy', false)
      }
      if (failed) {
        MessageToast.show(`${failed} rule(s) could not be saved. See the rows marked in red.`)
      } else {
        MessageToast.show('Rules saved')
        this.loadRules()
      }
    },

    onRulesClose() { this.byId('rulesDialog').close() },

    // Download Template: the empty F2548 upload template (header rows only)
    onDownloadTemplate() {
      this.downloadFile('Upload_General_Journal_Entries_Template_ZMAXX.xlsx')
    },

    async downloadFile(name) {
      try {
        const res = await fetch(name, { credentials: 'include' }) // next to index.html
        if (!res.ok) throw new Error(`${name} could not be downloaded (${res.status}).`)
        const url = URL.createObjectURL(await res.blob())
        Object.assign(document.createElement('a'), { href: url, download: name }).click()
        URL.revokeObjectURL(url)
        MessageToast.show(`${name} downloaded`)
      } catch (err) {
        MessageBox.error(err.message)
      }
    },

    // -------------------------------------------------------------- formatters
    // Bar colour by result: blue while running, orange for errors, red when stopped, green when done
    formatProgressState(code) {
      return { HAS_ERRORS: 'Warning', FAILED: 'Error', VALIDATED: 'Success', COMPLETED: 'Success', PARTIAL: 'Warning', PARTIAL_DONE: 'Warning' }[code] || 'Information'
    },

    formatCriticality(c) {
      return { 1: 'Error', 2: 'Warning', 3: 'Success' }[c] || 'Information'
    },

    formatSize(bytes) {
      if (!bytes && bytes !== 0) return ''
      return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
    },

    formatDateTime(at) {
      return at ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''
    },

    formatStatusIcon(code) {
      return {
        COMPLETED: 'sap-icon://sys-enter-2', VALIDATED: 'sap-icon://sys-enter-2', HAS_ERRORS: 'sap-icon://error',
        PARTIAL: 'sap-icon://alert', PARTIAL_DONE: 'sap-icon://alert',
        FAILED: 'sap-icon://error', STARTED: 'sap-icon://pending', VALIDATING: 'sap-icon://pending',
        SPLITTING: 'sap-icon://pending', POSTING: 'sap-icon://pending'
      }[code] || ''
    },

    // Upload time under the file name, only while the list is narrow (Uploaded column hidden)
    formatRecentDate(at, layout) {
      return layout === 'OneColumn' ? '' : this.formatDateTime(at)
    },

    formatUploadedBy(at, by) {
      return at ? `Uploaded ${this.formatDateTime(at)}${by ? ` by ${by}` : ''}` : ''
    },

    formatBand(currency, band) {
      return band ? `${currency} · ${BANDS[band] || band}` : currency
    },

    formatSplitReason(reason) {
      if (!reason || reason === 'NONE') return 'Not split'
      const words = { CURRENCY: 'currency', AMOUNT_BAND: 'amount band', LINE_LIMIT: '950-line limit', TAX_LIMIT: '300-line tax limit' }
      const text = reason.split(',').map(r => words[r] || r).join(', ')
      return text.charAt(0).toUpperCase() + text.slice(1)
    },

    // -------------------------------------------------------------- helpers
    async request(method, url, body) {
      if (method !== 'GET' && !this.csrf) {
        const t = await fetch(`${SRV}/`, { method: 'HEAD', headers: { 'X-CSRF-Token': 'Fetch' }, credentials: 'include' })
        this.csrf = t.headers.get('X-CSRF-Token') || 'unsafe'
      }
      const res = await fetch(url, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(method !== 'GET' ? { 'X-CSRF-Token': this.csrf } : {}) },
        body: body ? JSON.stringify(body) : undefined
      })
      const text = await res.text()
      if (!res.ok) {
        let message = text
        try { message = JSON.parse(text).error.message } catch { /* plain text */ }
        throw new Error(message)
      }
      try { return JSON.parse(text) } catch { return text }
    }
  })

  // "2 posted, 1 parked, 1 failed" -> { created: 3, failed: 1 }
  function journalCounts(detail) {
    const n = word => Number((String(detail || '').match(new RegExp(`(\\d+) ${word}`)) || [])[1] || 0)
    return { created: n('posted') + n('parked'), failed: n('failed') }
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }
})
