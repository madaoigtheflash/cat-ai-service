const FUNCTION_NAME = 'catCompanion'
const CLOUD_ENV = 'cloud1-d6gpjpxunc74669d7'
const SOURCE = 'cloud'
const MAX_TEXT_LENGTH = 500
const MAX_HISTORY_LENGTH = 12
const MAX_HISTORY_CONTENT_LENGTH = 1000
const MAX_HISTORY_TOTAL_LENGTH = 6000
const CALL_TIMEOUT_MS = 22000
const ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: '请重新进入小程序后再试。',
  COMPANION_DISABLED: '云端陪伴暂未开放，可以继续使用本机互动。',
  ACCESS_DENIED: '当前账号尚未开放云端陪伴，可以继续使用本机互动。',
  NOT_CONFIGURED: '云端陪伴尚未开通，可以继续使用本机互动。',
  INVALID_REQUEST: '这段文字暂时无法发送，请缩短后再试。',
  TIMEOUT: '云端回应等待超时，请稍后重试。',
  PROVIDER_UNAVAILABLE: '云端暂时没有回应，请稍后重试。',
  INVALID_REPLY: '这次没有收到可显示的回应，请重试。',
  CLOUD_UNAVAILABLE: '当前无法连接云端陪伴，可以继续使用本机互动。'
})

function makeError(code) {
  const safeCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ? code : 'PROVIDER_UNAVAILABLE'
  const error = new Error(ERROR_MESSAGES[safeCode])
  error.code = safeCode
  return error
}

function contentText(value, limit) {
  if (typeof value !== 'string' || value.length > limit || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw makeError('INVALID_REQUEST')
  }
  return value.trim()
}

function prepare(text, history) {
  const normalizedText = contentText(text, MAX_TEXT_LENGTH)
  const items = history === undefined ? [] : history
  if (!Array.isArray(items)) throw makeError('INVALID_REQUEST')
  let total = 0
  const selected = []
  const recent = items.slice(-MAX_HISTORY_LENGTH)
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index]
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) throw makeError('INVALID_REQUEST')
    const content = contentText(item.content, MAX_HISTORY_CONTENT_LENGTH)
    if (total + content.length > MAX_HISTORY_TOTAL_LENGTH) break
    total += content.length
    selected.unshift({ role: item.role, content })
  }
  return { text: normalizedText, history: selected }
}

async function reply(text, history) {
  const data = prepare(text, history)
  if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.callFunction !== 'function') throw makeError('CLOUD_UNAVAILABLE')
  let timer
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => wx.cloud.callFunction({ name: FUNCTION_NAME, config: { env: CLOUD_ENV }, data })),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(makeError('TIMEOUT')), CALL_TIMEOUT_MS) })
    ])
    const result = response && response.result
    if (!result || result.success !== true) throw makeError(result && result.code)
    if (result.source !== SOURCE || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 800) {
      throw makeError('INVALID_REPLY')
    }
    return { text: result.text.trim(), source: SOURCE }
  } catch (error) {
    throw makeError(error && error.code)
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { reply, SOURCE, MAX_TEXT_LENGTH }
