const companion = require('../../services/companion')

function timeLabel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '时间未记录'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未记录'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function locationRows(locations, pets) {
  const byId = new Map(pets.filter(pet => pet && typeof pet.id === 'string').map(pet => [pet.id, pet]))
  return locations.filter(item => item && typeof item.petId === 'string' && item.petId &&
    typeof item.latitude === 'number' && Number.isFinite(item.latitude) && item.latitude >= -90 && item.latitude <= 90 &&
    typeof item.longitude === 'number' && Number.isFinite(item.longitude) && item.longitude >= -180 && item.longitude <= 180)
    .map((item, index) => {
      const pet = byId.get(item.petId)
      return { markerId: index + 1, petId: item.petId, catName: pet ? String(pet.name || '未命名猫咪') : '猫咪档案已不存在',
        missing: !pet, areaText: typeof item.areaText === 'string' && item.areaText.trim() ? item.areaText : '约 2 公里粗区域',
        latitude: item.latitude, longitude: item.longitude, timeLabel: timeLabel(item.time) }
    })
}

Page({
  data: { loading: true, error: '', locations: [], markers: [], circles: [], mapPoints: [],
    latitude: 0, longitude: 0, selected: null, omittedCount: 0 },
  onShow() { this._disposed = false; return this.loadLocations() },
  onUnload() { this._disposed = true; this._loadToken = (this._loadToken || 0) + 1 },
  onPullDownRefresh() { return this.loadLocations().finally(() => wx.stopPullDownRefresh()) },
  async loadLocations() {
    const token = this._loadToken = (this._loadToken || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const [overview, stored] = await Promise.all([companion.getOverview(), companion.listLocations()])
      if (this._disposed || token !== this._loadToken) return false
      if (!overview || !Array.isArray(overview.pets) || !Array.isArray(stored)) throw new Error('本机粗位置暂时无法读取，请重试。')
      const locations = locationRows(stored, overview.pets)
      const previous = this.data.selected
      const selected = previous && locations.find(item => item.petId === previous.petId && item.latitude === previous.latitude && item.longitude === previous.longitude) || locations[0] || null
      const markers = locations.map(item => ({ id: item.markerId, latitude: item.latitude, longitude: item.longitude,
        iconPath: '/assets/tabbar/archive-selected.png', width: 32, height: 32, title: item.catName,
        callout: { content: `${item.catName}\n约 2 公里粗区域`, color: '#3E2D35', bgColor: '#FFF7FA', fontSize: 14, borderRadius: 12, padding: 10, display: 'BYCLICK' } }))
      this.setData({ locations, markers, selected, omittedCount: stored.length - locations.length,
        latitude: selected ? selected.latitude : 0, longitude: selected ? selected.longitude : 0,
        mapPoints: locations.length > 1 ? locations.map(item => ({ latitude: item.latitude, longitude: item.longitude })) : [],
        circles: locations.map(item => ({ latitude: item.latitude, longitude: item.longitude, radius: 1000, color: '#D94F7599', fillColor: '#FFD4DF66', strokeWidth: 1 })) })
      return true
    } catch (error) {
      if (!this._disposed && token === this._loadToken) this.setData({ error: error.message || '本机粗位置暂时无法读取，请重试。' })
      return false
    } finally { if (!this._disposed && token === this._loadToken) this.setData({ loading: false }) }
  },
  selectMarker(event) {
    const id = Number(event.detail && event.detail.markerId)
    this.selectLocation(id)
  },
  selectRow(event) { this.selectLocation(Number(event.currentTarget.dataset.id)) },
  selectLocation(markerId) {
    const selected = this.data.locations.find(item => item.markerId === markerId)
    if (selected) this.setData({ selected, latitude: selected.latitude, longitude: selected.longitude })
  },
  goChat() { wx.switchTab({ url: '/pages/home/index' }) },
  goData() { wx.navigateTo({ url: '/pages/companion-data/index' }) },
  goOnline() { wx.navigateTo({ url: '/pages/online/index' }) }
})
