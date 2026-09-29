const catalog = require('../assets/showcase/catalog')
const online = require('./online')
const CACHE_KEY = 'catai_showcase_media_v1'

function mergeAssets(remote, now = Date.now()) {
  return catalog.assets.map(asset => {
    const item = (remote || []).find(row => row.id === asset.id) || {}
    const valid = Date.parse(item.expiresAt) > now + 15000
    return Object.assign({}, asset, {
      thumbUrl: valid ? item.thumbUrl || '' : '',
      detailUrl: valid ? item.detailUrl || '' : '',
      expiresAt: item.expiresAt || '',
      liked: item.liked === true,
      likeVersion: Number.isSafeInteger(item.likeVersion) ? item.likeVersion : 0
    })
  })
}

function initialAssets() {
  let cache = []
  try { cache = wx.getStorageSync(CACHE_KEY) || [] } catch (_) { /* bundled fallback */ }
  // Persist media only, never a previous account's private favorites.
  return mergeAssets(Array.isArray(cache) ? cache.map(a => ({ ...a, liked: false, likeVersion: 0 })) : [])
}

async function refresh() {
  const response = await online.listShowcase()
  if (!response || !Array.isArray(response.assets) || response.assets.length !== catalog.assets.length) {
    throw new Error('精选图库暂未就绪，请稍后重试')
  }
  const assets = mergeAssets(response.assets)
  try {
    wx.setStorageSync(CACHE_KEY, assets.map(a => ({ id: a.id, thumbUrl: a.thumbUrl, detailUrl: a.detailUrl, expiresAt: a.expiresAt })))
  } catch (_) { /* Storage quota does not prevent online use. */ }
  return assets
}

function groupAssets(assets, favorites, page) {
  const pool = favorites ? assets.filter(a => a.liked) : assets.slice().sort((a, b) => a.group - b.group)
  const pages = Math.max(1, Math.ceil(pool.length / 4))
  const index = Math.max(0, page % pages)
  return { items: pool.slice(index * 4, index * 4 + 4), page: index, pages }
}

module.exports = { initialAssets, refresh, groupAssets, mergeAssets, setLike: online.setShowcaseLike }
