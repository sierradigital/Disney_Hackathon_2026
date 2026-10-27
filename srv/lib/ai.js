// Plain-language explanation and suggested fix for an error (Gap 6, AI option).
//
// With cds.env.zmaxx.ai.enabled, the message is sent to an SAP AI Core deployment through the
// BTP destination cds.zmaxx.ai.destination (GENAICORE: OAuth2ClientCredentials with the AI Core
// service key, URL = AI_API_URL). The deployment is looked up once to see how to call it:
// an orchestration deployment, or a foundation model (OpenAI GPT or Anthropic Claude).
// Only the message text, code and field name are sent: no amounts, accounts or names.
// Without AI, or when the call fails, a built-in explanation per message code is returned.
import cds from '@sap/cds'
import { executeHttpRequest } from '@sap-cloud-sdk/http-client'

const LOG = cds.log('zmaxx-ai')

const FIXES = {
  ZMAXX_TTYPE_MISSING: 'Finance needs a Transaction Type on this G/L account so the line can be classified for consolidation. Fill the Transaction Type column with the value named in the message (or any valid TTYPE if none is named) and upload again.',
  ZMAXX_TTYPE_WRONG: 'This G/L account only accepts one Transaction Type. Replace the value in the Transaction Type column with the one named in the message.',
  ZMAXX_REQUIRED: 'A mandatory column is empty on this line. Fill it in; Business Area in particular is needed or consolidation fails.',
  ZMAXX_UNBALANCED: 'Debits and credits of this journal do not add up to zero in this currency. Find the missing or mistyped line (often a sign error) and correct it so the difference is 0.00.',
  ZMAXX_UNBALANCED_LC: 'In 3-Currency format SAP does not recalculate local currency, so the LC amounts must also net to zero. Adjust the LC amounts, or ask a user with Suppress Validations if the difference is intended.',
  ZMAXX_UNBALANCED_GC: 'In 3-Currency format SAP does not recalculate group currency (USD), so the GC amounts must also net to zero. Adjust the GC amounts, or use Suppress Validations if the difference is intended.',
  ZMAXX_3CURR_FX: 'The USD amount does not match the transaction amount at today\'s rate. Check that the GC column holds the USD value of this line, not the TC amount copied over.',
  ZMAXX_3CURR_GC_USD: 'TWDC reports group currency in US dollars. Set the GC currency key to USD and enter the USD amount.',
  ZMAXX_3CURR_LC: 'The LC currency must be the company code\'s own currency. Change the LC currency key, and the LC amount, to that currency.',
  ZMAXX_3CURR_AMOUNTS: 'You chose the 3-Currency format, so every line needs LC (type 10) and GC (type 30) amounts. Fill them in, or switch to 1-Currency and let SAP calculate them.',
  ZMAXX_3CURR_NO_COLUMNS: 'The file only has transaction-currency amounts, which is the 1-Currency format. Select 1-Currency on the upload page and upload the same file again; SAP then calculates the local and group currency amounts.',
  ZMAXX_OB28_COST_CENTER: 'Expense accounts need a Cost Center so the cost lands on the right department. Add the Cost Center for this line.',
  ZMAXX_HEADER_MISMATCH: 'All lines of one journal share the same header values. Make this line match the first line of the document, or give it its own Doc Ref.',
  ZMAXX_1CURR_MULTI: 'A 1-Currency journal can only have one currency. Split the lines into separate Doc Refs per currency, or use the 3-Currency format.',
  ZMAXX_LC_ONLY: 'This account is managed in local currency only. Enter the line in the company code currency.',
  SAP_CHECK_UNAVAILABLE: 'The data in this journal may be fine: SAP could not be reached for its check. Upload the journal again in a few minutes. If it keeps happening, the connection to S43 (destination or Cloud Connector) needs checking.',
  SAP_GL_BLOCKED: 'The G/L account is blocked for posting in this company code. Use the replacement account (ask GL master data), or have the block removed in FS00.',
  SAP_GL_NOT_FOUND: 'The G/L account does not exist in this company code. Check for a typo, and check FS00 that the account is created for the company code.',
  SAP_PERIOD_CLOSED: 'The posting period for this date is closed. Change the Posting Date to an open period, or ask the close team to open it.',
  SAP_BUSINESS_AREA: 'The business area code is not valid. Pick one from the business area list.',
  SAP_COMPANY_CODE: 'The company code is not valid. Check for a typo.',
  TEMPLATE_DATE: 'Dates must follow the date format in your SAP user settings (SU3), for example MMDDYYYY. Re-enter the date in that format.',
  TEMPLATE_AMOUNT_COMMA: 'Amounts must be plain numbers with no thousands separator, for example 1234.56. Remove the commas.',
  TEMPLATE_AMOUNT: 'Amounts must be numbers with at most two decimal places. Correct the value.',
  TEMPLATE_DECIMALS: 'Amounts can have at most two decimal places. Round the value.'
}

export async function explain(message) {
  if (cds.env.zmaxx?.ai?.enabled) {
    try {
      const text = (await explainWithAICore(message))?.trim()
      if (text) return text.slice(0, 2000)
    } catch (e) {
      LOG.warn('SAP AI Core call failed, using built-in explanation:', e.response?.status ?? '', e.response?.data?.error?.message ?? e.response?.data?.message ?? e.message)
    }
  }
  return FIXES[message.code] ?? `What it means: ${message.text} How to fix it: correct the ${message.field || 'value'} on line ${message.lineNo} and upload the file again.`
}

const SYSTEM = 'You help finance users fix errors in a journal entry upload file (Excel) before it is posted to SAP S/4HANA ' +
  'with the Upload General Journal Entries app (F2548). The file has 1-Currency format (transaction currency only; SAP ' +
  'calculates local and group currency) or 3-Currency format (the user also enters local currency, type 10, and group ' +
  'currency USD, type 30). Answer in two or three short sentences, plain text: what the error means, then exactly what to ' +
  'change in the spreadsheet. No jargon, no markdown.'

const userPrompt = m => [
  `Error code: ${m.code ?? ''}`,
  `Field: ${m.field ?? ''}`,
  `Line: ${m.lineNo > 0 ? m.lineNo : 'whole file'}`,
  `Message: ${m.text ?? ''}`,
  FIXES[m.code] && `Known guidance for this code: ${FIXES[m.code]}`
].filter(Boolean).join('\n')

async function explainWithAICore(message) {
  const ai = cds.env.zmaxx.ai
  const deploymentId = ai.deploymentId || process.env.AICORE_DEPLOYMENT_ID
  if (!deploymentId) throw new Error('No AI Core deployment ID: set cds.zmaxx.ai.deploymentId')
  const call = (method, url, data) => executeHttpRequest(
    { destinationName: ai.destination || process.env.AICORE_DESTINATION_NAME || 'GENAICORE' },
    { method, url, data, timeout: 30000, headers: { 'AI-Resource-Group': ai.resourceGroup || process.env.AICORE_RESOURCE_GROUP || 'default', 'Content-Type': 'application/json' } },
    { fetchCsrfToken: false }
  )
  const { scenario, model } = await deploymentInfo(call, deploymentId)
  const base = `/v2/inference/deployments/${deploymentId}`
  const prompt = userPrompt(message)

  if (scenario === 'orchestration') {
    const res = await call('post', `${base}/completion`, {
      orchestration_config: {
        module_configurations: {
          templating_module_config: { template: [{ role: 'system', content: SYSTEM }, { role: 'user', content: '{{?error}}' }] },
          llm_module_config: { model_name: ai.model, model_params: { max_tokens: 300, temperature: 0.2 } }
        }
      },
      input_params: { error: prompt }
    })
    return res.data?.orchestration_result?.choices?.[0]?.message?.content
  }
  if (/^anthropic/.test(model)) {
    const res = await call('post', `${base}/invoke`, {
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 300, system: SYSTEM,
      messages: [{ role: 'user', content: prompt }]
    })
    return res.data?.content?.find(c => c.type === 'text')?.text
  }
  if (/^(gpt|o\d)/.test(model)) {
    const res = await call('post', `${base}/chat/completions?api-version=2024-02-01`, {
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }]
    })
    return res.data?.choices?.[0]?.message?.content
  }
  throw new Error(`AI Core deployment ${deploymentId} runs ${model || scenario}, which this app does not call yet (use orchestration, GPT or Claude)`)
}

// Scenario and model of the deployment, read once per process (again after a failure)
let deployment = null
function deploymentInfo(call, deploymentId) {
  deployment ??= call('get', `/v2/lm/deployments/${deploymentId}`).then(({ data }) => {
    if (data.status && data.status !== 'RUNNING') throw new Error(`AI Core deployment ${deploymentId} is ${data.status}, not RUNNING`)
    const backend = data.details?.resources?.backend_details ?? data.details?.resources?.backendDetails
    const info = { scenario: data.scenarioId, model: backend?.model?.name ?? '' }
    LOG.info(`AI Core deployment ${deploymentId}: scenario ${info.scenario}, model ${info.model || '(set by orchestration)'}`)
    return info
  }).catch(e => { deployment = null; throw e })
  return deployment
}
