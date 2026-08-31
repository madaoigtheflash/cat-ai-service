const knowledge = require('../data/knowledge')

const CLOUD_ENV = 'cloud1-d6gpjpxunc74669d7'

function cloudResult(response, fallback) {
  const result = response && response.result
  if (!result) throw new Error(fallback || '云函数未返回结果')
  if (result.success === false) throw new Error(result.error || fallback || '云函数执行失败')
  return result
}

function callCloud(name, data) {
  if (!wx.cloud) return Promise.reject(new Error('当前微信版本不支持云开发，请升级微信'))
  return wx.cloud.callFunction({
    name,
    data: data || {},
    config: { env: CLOUD_ENV }
  }).then(response => cloudResult(response, `${name} 调用失败`))
}

function compressImage(imagePath) {
  return new Promise(resolve => {
    wx.compressImage({
      src: imagePath,
      quality: 72,
      compressedWidth: 1280,
      compressedHeight: 1280,
      success: result => resolve(result.tempFilePath || imagePath),
      fail: () => resolve(imagePath)
    })
  })
}

function makeRequestToken(prefix) {
  return `${prefix || 'request'}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function getFileInfo(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileInfo({ filePath, success: resolve, fail: reject })
  })
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: reject })
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

async function identify(imagePath) {
  const compressedPath = await compressImage(imagePath)
  const [fileInfo, imageInfo] = await Promise.all([
    getFileInfo(compressedPath),
    getImageInfo(compressedPath)
  ])
  const session = await callCloud('identifyCat', {
    action: 'createUpload',
    schemaVersion: 1,
    requestId: makeRequestToken('create_upload'),
    idempotencyKey: makeRequestToken('identify_upload'),
    file: {
      mime: imageMime(imageInfo, compressedPath),
      sizeBytes: fileInfo.size || 0
    }
  })

  let upload
  try {
    upload = await wx.cloud.uploadFile({ cloudPath: session.cloudPath, filePath: compressedPath })
    if (!upload || !upload.fileID) throw new Error('图片上传云端失败')
    return await callCloud('identifyCat', {
      action: 'identify',
      schemaVersion: 1,
      requestId: makeRequestToken('identify'),
      uploadId: session.uploadId,
      fileID: upload.fileID
    })
  } catch (error) {
    // 云函数只会清理它已认领的受控路径；上传或调用失败时由客户端再兜底清理自己的文件。
    if (upload && upload.fileID) wx.cloud.deleteFile({ fileList: [upload.fileID] }).catch(() => {})
    throw error
  }
}

function normalizeConfidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(100, Math.round(value)))
  const text = String(value || '').trim()
  const numeric = Number.parseFloat(text)
  if (Number.isFinite(numeric)) return Math.max(0, Math.min(100, Math.round(numeric)))
  return { '很高': 95, '高': 88, '中高': 78, '中': 65, '中低': 50, '低': 35 }[text] || 0
}

function normalizeIdentifyResult(payload) {
  const source = payload && (payload.identification || payload.result || payload.data || payload)
  const appearance = source.appearance || {}
  const features = []
  if (appearance.body_type) features.push(appearance.body_type)
  if (appearance.face_features) features.push(appearance.face_features)
  return {
    breed: source.breed || source.breed_name || '未知品种',
    confidence: normalizeConfidence(source.confidence || source.confidence_score),
    coat_color: source.coat_color || source.color || appearance.color || '未知',
    coat_pattern: source.coat_pattern || source.pattern || appearance.pattern || '未知',
    estimated_age: source.estimated_age || source.age || '未知',
    gender: source.gender || '未知',
    features: Array.isArray(source.features) ? source.features : features,
    description: source.description || source.summary || '',
    health_observation: source.health_observation || '',
    knowledge: source.knowledge || payload.knowledge || null,
    raw: payload
  }
}

function searchKnowledge(query) {
  const results = knowledge.search(query, '全部').slice(0, 5)
  return Promise.resolve({ query, results, count: results.length })
}

function askKnowledge(query, breed) {
  const sources = knowledge.search(`${breed || ''} ${query}`, '全部').slice(0, 5).map(item => ({
    id: item.id,
    title: item.title,
    content: item.content
  }))
  return callCloud('askKnowledge', { query, breed: breed || '', sources })
}

function health() {
  return callCloud('askKnowledge', { action: 'health' })
}

module.exports = { CLOUD_ENV, identify, normalizeIdentifyResult, searchKnowledge, askKnowledge, health }
