const showcase = require('../../services/showcase')
const MOTION_KEY = 'catai_showcase_reduce_motion_v1'

// Gentle "cat and life" lines that rotate slowly under the garden title.
// Five healing lines carry one mono-aware line — a 5:1 tension ratio.
const VALUE_LINES = [
  '点开一个小气泡，收藏片刻可爱',
  '猫把日子过成慢镜头',
  '生活里有一只猫，就有一段柔软的时间',
  '记录它的今天，也留住你的生活',
  '猫咪在打盹，世界就安静了一点',
  '花开一季，猫伴一生'
]

// Four-petal rosette orbit: 90° divergence with alternating inner/outer
// radius. A rigid slow spin keeps pairwise distances constant, so bubbles
// never overlap at any point of the revolution. `top` is compensated by the
// stage aspect ratio (padding-top 70%) so the orbit stays circular.
const ROSETTE_DIVERGENCE = 90
const ROSETTE_RADII = [15, 22]
const STAGE_ASPECT = 100 / 70
function spiralSlotStyle(index, total) {
  const angle = (index * ROSETTE_DIVERGENCE - 90) * Math.PI / 180
  const radius = ROSETTE_RADII[index % ROSETTE_RADII.length]
  const left = 50 + radius * Math.cos(angle)
  const top = 50 + radius * Math.sin(angle) * STAGE_ASPECT
  return `left: ${left.toFixed(1)}%; top: ${top.toFixed(1)}%;`
}

Component({
  data: {
    assets: [], bubbles: [], detail: null, favorites: false, page: 0, pages: 2,
    loading: false, synced: false, error: '', busy: false, heart: false,
    reducedMotion: false, visible: true, notice: '',
    valueLine: VALUE_LINES[0], lineFading: false, rotorEpoch: 0, pollenFor: ''
  },
  lifetimes: {
    attached() {
      this._alive = true
      let reducedMotion = false
      try { reducedMotion = wx.getStorageSync(MOTION_KEY) === true } catch (_) {}
      this.setData({ assets: showcase.initialAssets(), reducedMotion })
      this.renderGroup()
      this.refresh()
      this._startValueLines()
    },
    detached() {
      this._alive = false
      clearTimeout(this._heartTimer)
      clearTimeout(this._expiryTimer)
      clearTimeout(this._pollenTimer)
      this._stopValueLines()
    }
  },
  pageLifetimes: {
    show() {
      this.setData({ visible: true })
      if (this._alive && !this.data.loading) this.refresh()
      this._startValueLines()
    },
    hide() {
      this.setData({ visible: false, heart: false, pollenFor: '' })
      clearTimeout(this._heartTimer)
      clearTimeout(this._expiryTimer)
      clearTimeout(this._pollenTimer)
      this._stopValueLines()
    }
  },
  methods: {
    renderGroup() {
      const group = showcase.groupAssets(this.data.assets, this.data.favorites, this.data.page)
      const detail = this.data.detail && this.data.assets.find(a => a.id === this.data.detail.id)
      const bubbles = group.items.map((item, index) => ({ ...item, spiralStyle: spiralSlotStyle(index, group.items.length) }))
      // A new set of photo ids recreates the slot nodes, restarting their
      // counter-rotation from 0deg. Bump the rotor epoch so the rotor node is
      // recreated too and both animations stay phase-locked (no tilted text).
      const groupKey = group.items.map(item => item.id).join('|')
      const rotorEpoch = groupKey === this._lastGroupKey ? this.data.rotorEpoch : this.data.rotorEpoch + 1
      this._lastGroupKey = groupKey
      this.setData({ bubbles, page: group.page, pages: group.pages, detail: detail || null, rotorEpoch })
    },
    _startValueLines() {
      this._stopValueLines()
      if (!this._alive || this.data.reducedMotion || !this.data.visible) return
      this._valueTimer = setTimeout(() => this._cycleValueLine(), 12000)
    },
    _stopValueLines() {
      clearTimeout(this._valueTimer)
      clearTimeout(this._valueSwapTimer)
    },
    _cycleValueLine() {
      if (!this._alive || this.data.reducedMotion || !this.data.visible) return
      this.setData({ lineFading: true })
      this._valueSwapTimer = setTimeout(() => {
        if (!this._alive) return
        this._valueIndex = ((this._valueIndex || 0) + 1) % VALUE_LINES.length
        this.setData({ valueLine: VALUE_LINES[this._valueIndex], lineFading: false })
        this._startValueLines()
      }, 280)
    },
    async refresh() {
      if (this.data.loading || this.data.busy) return false
      this.setData({ loading: true, error: '' })
      clearTimeout(this._expiryTimer)
      try {
        const assets = await showcase.refresh()
        if (!this._alive) return false
        this.setData({ assets, synced: true })
        this.renderGroup()
        if (this.data.visible) this._expiryTimer = setTimeout(() => this.refresh(), 240000)
        return true
      } catch (error) {
        if (this._alive) this.setData({ synced: false, error: '云端暂不可用，正在展示精选缓存。喜欢尚未确认。' })
        return false
      } finally {
        if (this._alive) this.setData({ loading: false })
      }
    },
    showAll() { this.setData({ favorites: false, page: 0 }); this.renderGroup() },
    showFavorites() { this.setData({ favorites: true, page: 0 }); this.renderGroup() },
    nextGroup() { this.setData({ page: this.data.page + 1 }); this.renderGroup() },
    async openPhoto(event) {
      const detail = this.data.assets.find(a => a.id === event.currentTarget.dataset.id)
      if (!detail) return
      this.setData({ detail, heart: false, notice: '' })
      // A brief pollen shimmer answers the tap, then dissolves on its own.
      if (!this.data.reducedMotion && this.data.visible) {
        this.setData({ pollenFor: detail.id })
        clearTimeout(this._pollenTimer)
        this._pollenTimer = setTimeout(() => { if (this._alive) this.setData({ pollenFor: '' }) }, 420)
      }
      if (Date.parse(detail.expiresAt) <= Date.now() + 15000 || !detail.detailUrl) await this.refresh()
    },
    closePhoto() { this.setData({ detail: null, heart: false, notice: '' }); clearTimeout(this._heartTimer) },
    stopTap() {},
    async likePhoto() {
      if (this.data.busy || this.data.loading || !this.data.detail) return
      if (!this.data.synced) { this.setData({ notice: '连接云端后才能同步喜欢，请先重试。' }); return }
      const photo = this.data.detail
      this.setData({ busy: true, notice: '', heart: false })
      try {
        const result = await showcase.setLike(photo.id, !photo.liked, photo.likeVersion)
        if (!this._alive) return
        const assets = this.data.assets.map(a => a.id === photo.id ? { ...a, liked: result.liked, likeVersion: result.version } : a)
        const stillViewing = this.data.detail && this.data.detail.id === photo.id
        this.setData({ assets, notice: stillViewing ? (result.conflict ? '另一台设备已更新，已取回最新状态。请确认后再操作。' : '已同步到云端') : '' })
        this.renderGroup()
        if (stillViewing && !result.conflict && !photo.liked && result.liked && !this.data.reducedMotion && this.data.visible) {
          this.setData({ heart: true })
          this._heartTimer = setTimeout(() => { if (this._alive) this.setData({ heart: false }) }, 400)
        }
      } catch (error) {
        if (this._alive) this.setData({ synced: false, notice: '未能确认喜欢状态，请重试刷新。不会自动重复提交。' })
      } finally {
        if (this._alive) this.setData({ busy: false })
      }
    },
    imageError(event) {
      const id = event.currentTarget.dataset.id
      const kind = event.currentTarget.dataset.kind
      const asset = this.data.assets.find(a => a.id === id)
      if (!asset) return
      const oldUrl = asset[kind === 'detail' ? 'detailUrl' : 'thumbUrl']
      if (!oldUrl) return
      this.setData({ assets: this.data.assets.map(a => a.id === id ? { ...a, [kind === 'detail' ? 'detailUrl' : 'thumbUrl']: '' } : a) })
      this.renderGroup()
      // One automatic recovery per five minutes avoids a CDN-error refresh loop.
      if (!this._lastImageRetry || Date.now() - this._lastImageRetry > 300000) {
        this._lastImageRetry = Date.now()
        this.refresh()
      }
    },
    toggleMotion(event) {
      const reducedMotion = Boolean(event.detail.value)
      this.setData({ reducedMotion, heart: false, lineFading: false })
      if (reducedMotion) {
        this._stopValueLines()
        this._valueIndex = 0
        this.setData({ valueLine: VALUE_LINES[0] })
      } else {
        this._startValueLines()
      }
      try { wx.setStorageSync(MOTION_KEY, reducedMotion) } catch (_) {}
    },
    copySource() {
      if (!this.data.detail) return
      wx.setClipboardData({ data: this.data.detail.sourceUrl })
    }
  }
})
