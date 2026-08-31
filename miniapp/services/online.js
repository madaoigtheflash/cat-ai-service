const CLOUD_ENV = 'cloud1-d6gpjpxunc74669d7'
// Node.js 20 is required by the image-sanitizing pipeline used by this function.
// Keep this name in sync with cloudbaserc.json; the legacy catOnline function is
// retained remotely only so already-uploaded development builds keep working.
const FUNCTION_NAME = 'catOnlineV2'
const RETRY_STORAGE_KEY = 'catai_mini_online_retry_v1'
const UPLOAD_RETRY_TTL_MS = 8 * 60 * 1000
const RETRY_RECORD_TTL_MS = 24 * 60 * 60 * 1000
const SUBMIT_RECOVERY_WAIT_MS = 90 * 1000
const intentRetryMemory = new Map()
const uploadResumeMemory = new Map()

function makeToken(prefix) {
  return `${prefix || 'req'}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function fingerprintHash(value) {
  const text = String(value || '')
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193)
    right = Math.imul(right ^ (code + index), 0x85ebca6b)
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`
}

function readRetryStorage() {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return {}
  try {
    const value = wx.getStorageSync(RETRY_STORAGE_KEY)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch (error) {
    return {}
  }
}

function writeRetryStorage(value) {
  if (typeof wx === 'undefined' || typeof wx.setStorageSync !== 'function') return
  try {
    wx.setStorageSync(RETRY_STORAGE_KEY, value)
  } catch (error) {
    // In-memory recovery still protects retries during the current process.
  }
}

function retryIntentKey(scope, fingerprint, ttlMs) {
  const now = Date.now()
  const stored = readRetryStorage()
  const cached = intentRetryMemory.get(scope) || stored[scope]
  const digest = fingerprintHash(fingerprint)
  const unexpired = !Number.isFinite(ttlMs) || (Number(cached && cached.createdAt) + ttlMs > now)
  if (cached && cached.fingerprintHash === digest && unexpired &&
      /^[A-Za-z0-9._:-]{8,128}$/.test(String(cached.idempotencyKey || ''))) {
    intentRetryMemory.set(scope, cached)
    return cached.idempotencyKey
  }
  const entry = {
    fingerprintHash: digest,
    idempotencyKey: makeToken(scope).slice(0, 120),
    createdAt: now
  }
  intentRetryMemory.set(scope, entry)
  stored[scope] = entry
  writeRetryStorage(stored)
  return entry.idempotencyKey
}

function updateRetryIntent(scope, idempotencyKey, patch) {
  const stored = readRetryStorage()
  const cached = intentRetryMemory.get(scope) || stored[scope]
  if (!cached || cached.idempotencyKey !== idempotencyKey) return
  const next = Object.assign({}, cached, patch || {})
  intentRetryMemory.set(scope, next)
  stored[scope] = next
  writeRetryStorage(stored)
}

function clearRetryIntent(scope, idempotencyKey) {
  const stored = readRetryStorage()
  const cached = intentRetryMemory.get(scope) || stored[scope]
  if (!cached || cached.idempotencyKey !== idempotencyKey) return
  intentRetryMemory.delete(scope)
  delete stored[scope]
  writeRetryStorage(stored)
}

function rememberUpload(idempotencyKey, value) {
  uploadResumeMemory.set(idempotencyKey, value)
  while (uploadResumeMemory.size > 8) {
    uploadResumeMemory.delete(uploadResumeMemory.keys().next().value)
  }
}

function pruneRetryStorage() {
  const stored = readRetryStorage()
  const now = Date.now()
  let changed = false
  Object.keys(stored).forEach(scope => {
    const entry = stored[scope]
    if (!entry || !Number.isFinite(Number(entry.createdAt)) || now - Number(entry.createdAt) > RETRY_RECORD_TTL_MS) {
      delete stored[scope]
      intentRetryMemory.delete(scope)
      changed = true
    }
  })
  if (changed) writeRetryStorage(stored)
}

function normalizeResult(response, fallback) {
  const result = response && response.result
  if (!result) throw new Error(fallback || '云函数未返回结果')
  if (result.success === false || result.ok === false) {
    const detail = result.error && (result.error.message || result.error.code)
    throw new Error(detail || result.error || fallback || '云函数执行失败')
  }
  return result.data || result
}

function call(action, payload, options) {
  if (!wx.cloud) return Promise.reject(new Error('当前微信版本不支持云开发，请升级微信'))
  const opts = options || {}
  const requestId = opts.requestId || makeToken('request')
  const data = Object.assign({
    action,
    schemaVersion: 1,
    requestId
  }, payload || {})
  if (opts.write !== false && !data.idempotencyKey) data.idempotencyKey = makeToken(action)
  return wx.cloud.callFunction({
    name: FUNCTION_NAME,
    data,
    config: { env: CLOUD_ENV }
  }).then(response => normalizeResult(response, `${action} 调用失败`))
}

function getFileInfo(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileInfo({
      filePath,
      success: resolve,
      fail: reject
    })
  })
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: reject })
  })
}

function compressForOnline(imagePath) {
  return new Promise(resolve => {
    wx.compressImage({
      src: imagePath,
      quality: 85,
      compressedWidth: 1600,
      compressedHeight: 1600,
      success: result => resolve(result.tempFilePath || imagePath),
      fail: () => resolve(imagePath)
    })
  })
}

function imageMime(imageInfo, filePath) {
  const type = String((imageInfo && imageInfo.type) || '').toLowerCase()
  if (type === 'png') return 'image/png'
  if (type === 'webp') return 'image/webp'
  const path = String(filePath || '').toLowerCase()
  if (/\.png(?:\?|$)/.test(path)) return 'image/png'
  if (/\.webp(?:\?|$)/.test(path)) return 'image/webp'
  return 'image/jpeg'
}

function petSyncPayload(pet) {
  return {
    localPetId: pet && pet.id,
    name: pet && pet.name,
    breed: pet && pet.breed,
    gender: pet && pet.gender,
    coatColor: pet && pet.coatColor,
    estimatedAge: pet && pet.estimatedAge
  }
}

function petSyncFingerprint(pet) {
  return fingerprintHash(JSON.stringify(petSyncPayload(pet)))
}

async function recoverPendingSighting() {
  const stored = readRetryStorage()
  const pending = intentRetryMemory.get('upload_sighting') || stored.upload_sighting
  if (!pending || !pending.idempotencyKey) return null
  const age = Date.now() - Number(pending.createdAt || 0)
  if (!Number.isFinite(age) || age > RETRY_RECORD_TTL_MS) {
    clearRetryIntent('upload_sighting', pending.idempotencyKey)
    uploadResumeMemory.delete(pending.idempotencyKey)
    return { found: false, state: 'RETRY_ALLOWED' }
  }
  const result = await call('recoverSighting', {
    idempotencyKey: pending.idempotencyKey,
    uploadId: pending.uploadId || ''
  }, { write: false })
  if (result.found) {
    clearRetryIntent('upload_sighting', pending.idempotencyKey)
    uploadResumeMemory.delete(pending.idempotencyKey)
    return result
  }
  const submitStartedAt = Number(pending.submitStartedAt || pending.createdAt || 0)
  if (Date.now() - submitStartedAt >= SUBMIT_RECOVERY_WAIT_MS) {
    clearRetryIntent('upload_sighting', pending.idempotencyKey)
    uploadResumeMemory.delete(pending.idempotencyKey)
    return { found: false, state: 'RETRY_ALLOWED' }
  }
  return Object.assign({}, result, { found: false, state: 'PENDING' })
}

async function bootstrap() {
  pruneRetryStorage()
  const result = await call('bootstrap', {}, { write: false })
  try {
    result.uploadRecovery = await recoverPendingSighting()
  } catch (error) {
    result.uploadRecovery = { found: false, state: 'UNKNOWN' }
  }
  return result
}

function createCommunity(name) {
  const normalizedName = String(name || '').trim()
  const fingerprint = JSON.stringify({ name: normalizedName })
  const idempotencyKey = retryIntentKey('create_community', fingerprint, RETRY_RECORD_TTL_MS)
  return call('createCommunity', { name: normalizedName, idempotencyKey }).then(result => {
    clearRetryIntent('create_community', idempotencyKey)
    return result
  })
}

function joinCommunity(inviteCode) {
  return call('joinCommunity', { inviteCode: String(inviteCode || '').trim().toUpperCase() })
}

function listWorkspace(communityId) {
  return call('listWorkspace', { communityId }, { write: false })
}

function listCommunityInsights(communityId) {
  return call('listCommunityInsights', { communityId }, { write: false })
}

function syncPet(communityId, pet) {
  const payload = petSyncPayload(pet)
  return call('syncPet', {
    communityId,
    pet: Object.assign({}, payload, { syncFingerprint: petSyncFingerprint(pet) })
  })
}

function castRelationshipVote(input) {
  const value = input || {}
  return call('castRelationshipVote', {
    communityId: value.communityId,
    relationshipContractId: 'cat-ai.relationship.directed',
    relationshipContractVersion: 2,
    directionVersion: 2,
    fromCatId: value.fromCatId,
    toCatId: value.toCatId,
    choice: value.choice,
    evidenceSightingIds: Array.isArray(value.evidenceSightingIds) ? value.evidenceSightingIds.slice(0, 3) : [],
    idempotencyKey: value.idempotencyKey || makeToken('relationship_vote')
  })
}

async function uploadSighting(input) {
  if (!input || !input.communityId) throw new Error('请先选择一个猫友小屋')
  if (!input.imagePath) throw new Error('请先选择一张猫咪照片')

  const fingerprint = JSON.stringify({
    communityId: input.communityId,
    imagePath: input.imagePath,
    observedAt: input.observedAt || '',
    areaText: input.areaText || '',
    caption: input.caption || '',
    localPetId: input.localPetId || '',
    source: input.source || 'unknown'
  })
  const storedRetry = intentRetryMemory.get('upload_sighting') || readRetryStorage().upload_sighting
  const fingerprintDigest = fingerprintHash(fingerprint)
  const activeResume = storedRetry && uploadResumeMemory.get(storedRetry.idempotencyKey)
  const canResumeInProcess = activeResume && activeResume.fingerprint === fingerprint
  if (storedRetry && (!canResumeInProcess || storedRetry.fingerprintHash !== fingerprintDigest)) {
    const recovery = await recoverPendingSighting()
    if (recovery && recovery.found) {
      throw new Error('已找回上一条目击；如果这是新照片，请再点一次提交')
    }
    if (recovery && recovery.state === 'PENDING') {
      throw new Error('上一条上传仍在云端确认，请稍后再试')
    }
  }
  const idempotencyKey = input.idempotencyKey || retryIntentKey('upload_sighting', fingerprint, UPLOAD_RETRY_TTL_MS)
  let resume = uploadResumeMemory.get(idempotencyKey)
  if (!resume || resume.fingerprint !== fingerprint) {
    const filePath = await compressForOnline(input.imagePath)
    const [fileInfo, imageInfo] = await Promise.all([getFileInfo(filePath), getImageInfo(filePath)])
    resume = {
      fingerprint,
      filePath,
      mime: imageMime(imageInfo, filePath),
      sizeBytes: fileInfo.size || 0,
      width: imageInfo.width || 0,
      height: imageInfo.height || 0,
      session: null,
      fileID: ''
    }
    rememberUpload(idempotencyKey, resume)
  }
  if (!resume.session) {
    resume.session = await call('createUpload', {
      communityId: input.communityId,
      localPetId: input.localPetId || '',
      source: input.source || 'unknown',
      file: {
        mime: resume.mime,
        sizeBytes: resume.sizeBytes,
        width: resume.width,
        height: resume.height
      },
      idempotencyKey
    }, { requestId: makeToken('create_upload') })
    updateRetryIntent('upload_sighting', idempotencyKey, {
      uploadId: resume.session.uploadId,
      communityId: input.communityId
    })
  }
  if (!resume.fileID) {
    const upload = await wx.cloud.uploadFile({ cloudPath: resume.session.cloudPath, filePath: resume.filePath })
    if (!upload || !upload.fileID) throw new Error('照片上传失败，请重试')
    resume.fileID = upload.fileID
  }
  // 提交超时可能发生在云端事务已经成功之后。此处不能贸然删除文件，
  // 重试会复用同一会话、fileID 和幂等键，避免重复目击或覆盖已入库图片。
  updateRetryIntent('upload_sighting', idempotencyKey, { submitStartedAt: Date.now() })
  const result = await call('submitSighting', {
    uploadId: resume.session.uploadId,
    fileID: resume.fileID,
    observation: {
      observedAt: input.observedAt || '',
      location: input.location
        ? Object.assign({}, input.location, { areaText: input.areaText || input.location.areaText || '' })
        : input.areaText ? { areaText: input.areaText } : null
    },
    caption: input.caption || '',
    idempotencyKey
  }, {
    requestId: makeToken('submit_sighting'),
    write: true
  })
  uploadResumeMemory.delete(idempotencyKey)
  clearRetryIntent('upload_sighting', idempotencyKey)
  return result
}

function reviewSighting(sightingId, expectedVersion, decision) {
  return call('reviewSighting', {
    sightingId,
    expectedVersion,
    decision: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : decision
  })
}

function submitFeedback(input) {
  const value = input || {}
  const payload = {
    category: String(value.category || 'other'),
    title: String(value.title || '').trim(),
    content: String(value.content || '').trim(),
    steps: String(value.steps || '').trim(),
    client: value.client && typeof value.client === 'object' ? value.client : {}
  }
  const fingerprint = JSON.stringify(payload)
  const idempotencyKey = value.idempotencyKey || retryIntentKey(
    'submit_feedback', fingerprint, 24 * 60 * 60 * 1000
  )
  return call('submitFeedback', Object.assign({}, payload, { idempotencyKey }))
    .then(result => {
      clearRetryIntent('submit_feedback', idempotencyKey)
      return result
    })
}

function listFeedbackCenter() {
  return call('listFeedbackCenter', {}, { write: false })
}

function health() {
  return call('health', {}, { write: false })
}

module.exports = {
  CLOUD_ENV,
  FUNCTION_NAME,
  bootstrap,
  recoverPendingSighting,
  createCommunity,
  joinCommunity,
  listWorkspace,
  listCommunityInsights,
  syncPet,
  petSyncFingerprint,
  castRelationshipVote,
  uploadSighting,
  reviewSighting,
  submitFeedback,
  listFeedbackCenter,
  health,
  _test: {
    makeToken,
    normalizeResult,
    imageMime,
    petSyncPayload,
    petSyncFingerprint,
    fingerprintHash,
    retryIntentKey,
    clearRetryIntent,
    updateRetryIntent,
    pruneRetryStorage
  }
}
