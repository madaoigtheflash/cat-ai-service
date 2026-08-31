const cloud = require('wx-server-sdk')
const https = require('https')
const {
  cleanText,
  makeOwnerKey,
  normalizeFile,
  makeUploadId,
  makeCloudPath,
  fileIdMatchesPath,
  validateActualFile
} = require('./core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const API_URL = 'https://api.minimaxi.com/v1/chat/completions'
const DEFAULT_MODEL = 'MiniMax-M3'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const UPLOAD_TTL_MS = 10 * 60 * 1000
const UPLOAD_COLLECTION = 'ci_identify_upload_sessions'
const db = cloud.database()

function postJson(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.setTimeout(55000, () => request.destroy(new Error('模型请求超时')))
    request.on('error', reject)
    request.end(JSON.stringify(payload))
  })
}

const BREED_REFERENCE = [
  '英国短毛猫：脸圆、骨量足、短而密的绒毛；常见蓝色、金渐层、银渐层。',
  '美国短毛猫：体格结实，常见银黑经典虎斑，脸型不像英短那样极圆。',
  '布偶猫：蓝眼、重点色、半长毛，常见双色/手套色/重点色。',
  '暹罗猫：蓝眼、重点色、楔形头、大耳，四肢和尾部颜色较深。',
  '缅因猫：大型长毛、耳尖毛簇、方形口鼻、尾巴蓬松。',
  '中华田园猫：应按外观描述为狸花、橘猫、三花、玳瑁、奶牛等类型，不把花色误当血统品种。'
].join('\n')

function parseJsonContent(content) {
  const text = String(content || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  try { return JSON.parse(text) } catch (error) { /* continue */ }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
  throw new Error('模型未返回有效 JSON')
}

function isMissingDocument(error) {
  const text = `${error && error.code || ''} ${error && error.message || ''}`.toLowerCase()
  return text.includes('not exist') || text.includes('not found') || text.includes('document_not_exist')
}

async function getSession(uploadId, transaction) {
  const source = transaction || db
  try {
    const response = await source.collection(UPLOAD_COLLECTION).doc(uploadId).get()
    const data = response && response.data
    if (!data || (Array.isArray(data) && !data.length)) return null
    return Array.isArray(data) ? data[0] : data
  } catch (error) {
    if (isMissingDocument(error)) return null
    throw error
  }
}

function withoutId(value) {
  const output = {}
  Object.keys(value || {}).forEach(key => {
    if (key !== '_id' && value[key] !== undefined) output[key] = value[key]
  })
  return output
}

function currentOwnerKey() {
  const context = cloud.getWXContext()
  const secret = process.env.IDENTIFY_UPLOAD_SECRET || process.env.ONLINE_OWNER_SECRET || ''
  return makeOwnerKey(secret, context && context.OPENID)
}

function requireProtocol(event) {
  if (Number(event && event.schemaVersion) !== 1) throw new Error('UNSUPPORTED_SCHEMA_VERSION')
  if (!cleanText(event && event.requestId, 100)) throw new Error('REQUEST_ID_REQUIRED')
}

function sessionResult(session) {
  return {
    success: true,
    identification: session.identification,
    model_used: session.modelUsed,
    knowledge: {}
  }
}

async function createUpload(event, ownerKey) {
  requireProtocol(event)
  const idempotencyKey = cleanText(event && event.idempotencyKey, 100)
  const file = normalizeFile(event && event.file, MAX_IMAGE_BYTES)
  const uploadId = makeUploadId(ownerKey, idempotencyKey)
  const cloudPath = makeCloudPath(ownerKey, uploadId, file.extension)
  const nowMs = Date.now()

  const session = await db.runTransaction(async transaction => {
    const existing = await getSession(uploadId, transaction)
    if (existing) {
      if (existing.ownerKey !== ownerKey || existing.idempotencyKey !== idempotencyKey ||
          existing.declaredMime !== file.mime || existing.declaredSizeBytes !== file.sizeBytes) {
        throw new Error('IDEMPOTENCY_CONFLICT')
      }
      return existing
    }
    const value = {
      _id: uploadId,
      ownerKey,
      idempotencyKey,
      expectedPath: cloudPath,
      declaredMime: file.mime,
      declaredSizeBytes: file.sizeBytes,
      state: 'CREATED',
      expiresAtMs: nowMs + UPLOAD_TTL_MS,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString()
    }
    await transaction.collection(UPLOAD_COLLECTION).doc(uploadId).set({ data: withoutId(value) })
    return value
  })

  if (session.state !== 'CREATED' || Number(session.expiresAtMs) <= nowMs) throw new Error('UPLOAD_SESSION_EXPIRED')
  return {
    success: true,
    uploadId,
    cloudPath: session.expectedPath,
    expiresAt: new Date(Number(session.expiresAtMs)).toISOString()
  }
}

async function claimUpload(uploadId, fileID, ownerKey) {
  const nowMs = Date.now()
  return db.runTransaction(async transaction => {
    const session = await getSession(uploadId, transaction)
    if (!session || session.ownerKey !== ownerKey) throw new Error('UPLOAD_SESSION_NOT_FOUND')
    if (!fileIdMatchesPath(
      fileID,
      session.expectedPath,
      process.env.CLOUDBASE_ENV_ID || 'cloud1-d6gpjpxunc74669d7'
    )) throw new Error('UPLOAD_FILE_MISMATCH')
    if (session.state === 'COMPLETED' && session.identification) return { completed: true, session }
    if (session.state !== 'CREATED') throw new Error('UPLOAD_SESSION_ALREADY_USED')
    if (Number(session.expiresAtMs) <= nowMs) throw new Error('UPLOAD_SESSION_EXPIRED')
    await transaction.collection(UPLOAD_COLLECTION).doc(uploadId).update({
      data: {
        state: 'PROCESSING',
        fileID,
        claimedAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString()
      }
    })
    return { completed: false, session }
  })
}

async function updateSession(uploadId, data) {
  await db.collection(UPLOAD_COLLECTION).doc(uploadId).update({
    data: Object.assign({}, data, { updatedAt: new Date().toISOString() })
  })
}

async function identify(buffer, mime) {
  const apiKey = process.env.MINIMAX_API_KEY
  const model = process.env.MINIMAX_MODEL || DEFAULT_MODEL
  if (!apiKey) throw new Error('云函数尚未配置 MINIMAX_API_KEY')

  const prompt = `你是谨慎的猫咪品种鉴定助手。只能根据图片可见信息作辅助判断，不要声称血统已获证实。\n${BREED_REFERENCE}\n严格返回一个 JSON 对象，不要 Markdown：{"breed":"最可能品种或田园猫类型","confidence":"高/中/低","description":"判断依据和不确定性","appearance":{"color":"毛色","pattern":"花纹","body_type":"体型","face_features":"面部特征"},"health_observation":"仅描述图片可见情况并注明不能替代兽医检查","estimated_age":"幼猫/青年/成年/老年","gender":"未知","notes":"补充说明"}`
  const payload = {
    model,
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
          { type: 'text', text: '请鉴定图片中的猫；看不清的项目请写未知。' }
        ]
      }
    ],
    max_tokens: 8192
  }
  const response = await postJson(API_URL, payload, { Authorization: `Bearer ${apiKey}` })
  const text = response.text
  let data
  try { data = JSON.parse(text) } catch (error) { throw new Error(`模型返回无法解析（HTTP ${response.status}）`) }
  if (response.status < 200 || response.status >= 300) {
    const message = data && (data.message || (data.error && data.error.message))
    throw new Error(`模型请求失败（HTTP ${response.status}）：${cleanText(message, 180) || '未知错误'}`)
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
  if (!content) throw new Error('模型返回了空内容，请重试')
  return { identification: parseJsonContent(content), model }
}

exports.main = async event => {
  let uploadId = ''
  let fileID = ''
  let ownedUploadClaimed = false

  try {
    const ownerKey = currentOwnerKey()
    if (event && event.action === 'createUpload') return await createUpload(event, ownerKey)
    if (!event || event.action !== 'identify') throw new Error('UNSUPPORTED_ACTION')
    requireProtocol(event)
    uploadId = cleanText(event.uploadId, 80)
    fileID = cleanText(event.fileID, 1024)
    if (!uploadId || !fileID) throw new Error('UPLOAD_SESSION_REQUIRED')

    const claimed = await claimUpload(uploadId, fileID, ownerKey)
    if (claimed.completed) return sessionResult(claimed.session)
    ownedUploadClaimed = true

    const download = await cloud.downloadFile({ fileID })
    const buffer = download && download.fileContent
    const actual = validateActualFile(buffer, {
      mime: claimed.session.declaredMime,
      sizeBytes: claimed.session.declaredSizeBytes
    }, MAX_IMAGE_BYTES)
    const result = await identify(buffer, actual.mime)
    const response = {
      success: true,
      identification: result.identification,
      model_used: `minimax/${result.model}`,
      knowledge: {}
    }
    await updateSession(uploadId, {
      state: 'COMPLETED',
      identification: response.identification,
      modelUsed: response.model_used,
      completedAt: new Date().toISOString()
    })
    return response
  } catch (error) {
    console.error('identifyCat failed:', error && error.message)
    if (ownedUploadClaimed && uploadId) {
      try {
        await updateSession(uploadId, {
          state: 'FAILED',
          failureCode: cleanText(error && error.message, 80) || 'IDENTIFY_FAILED',
          failedAt: new Date().toISOString()
        })
      } catch (updateError) {
        console.warn('identify upload state update failed')
      }
    }
    return { success: false, error: cleanText(error && error.message, 240) || '图片识别失败' }
  } finally {
    if (ownedUploadClaimed && fileID) {
      try { await cloud.deleteFile({ fileList: [fileID] }) } catch (error) { console.warn('temporary image cleanup failed') }
    }
  }
}
