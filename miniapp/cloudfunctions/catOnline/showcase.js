'use strict'

// Shared by production transactions and tests; same-target retries are no-ops.
function resolveLike(current, liked, expectedVersion) {
  const state = { liked: Boolean(current && current.liked), version: current ? current.version : 0 }
  if (state.liked === liked) return { ...state, conflict: false, changed: false }
  if (state.version !== expectedVersion) return { ...state, conflict: true, changed: false }
  return { liked, version: state.version + 1, conflict: false, changed: true }
}

function createShowcaseHandlers({ repository, media, catalog, likeId, DomainError }) {
  const assets = catalog && Array.isArray(catalog.assets) ? catalog.assets : []
  function assetById(id) {
    const asset = assets.find(item => item.id === id)
    if (!asset) throw new DomainError('INVALID_SHOWCASE_ASSET', '精选照片不存在或已下架')
    return asset
  }
  return {
    async listShowcase(event, actor) {
      if (!assets.length) throw new DomainError('SHOWCASE_NOT_READY', '精选图库正在准备，请稍后重试', true)
      const records = await repository.listShowcaseLikes(assets.map(a => likeId(actor.ownerKey, a.id)))
      const likes = new Map(records.filter(Boolean).map(r => [r.assetId, r]))
      // No client-supplied paths: only the operator-curated manifest is signed.
      const requests = assets.flatMap(a => ['thumb', 'detail'].map(kind => ({ key: `${a.id}:${kind}`, fileID: a[kind].fileID })))
      const urls = await media.getTempUrls(requests)
      return {
        version: catalog.version,
        assets: assets.map(a => {
          const record = likes.get(a.id)
          const thumb = urls[`${a.id}:thumb`]
          const detail = urls[`${a.id}:detail`]
          return {
            id: a.id, group: a.group, title: a.title, caption: a.caption,
            author: a.author, sourceUrl: a.sourceUrl, license: a.license, licenseUrl: a.licenseUrl,
            thumbUrl: thumb ? thumb.url : '', detailUrl: detail ? detail.url : '',
            expiresAt: thumb && detail ? (thumb.expiresAt < detail.expiresAt ? thumb.expiresAt : detail.expiresAt) : null,
            width: a.detail.width, height: a.detail.height,
            liked: Boolean(record && record.liked), likeVersion: record ? record.version : 0
          }
        })
      }
    },
    async setShowcaseLike(event, actor, now) {
      const asset = assetById(event.assetId)
      if (typeof event.liked !== 'boolean' || !Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 0) {
        throw new DomainError('VALIDATION_ERROR', '喜欢状态与版本格式不正确')
      }
      const state = await repository.setShowcaseLike({
        id: likeId(actor.ownerKey, asset.id), ownerKey: actor.ownerKey, assetId: asset.id,
        liked: event.liked, expectedVersion: event.expectedVersion, now
      })
      return { assetId: asset.id, liked: state.liked, version: state.version, conflict: Boolean(state.conflict) }
    }
  }
}

module.exports = { createShowcaseHandlers, resolveLike }
