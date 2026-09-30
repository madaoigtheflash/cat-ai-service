const companion = require('../../services/companion')

const ROLES = { friend: '朋友', playmate: '玩伴', housemate: '室友', observing: '观察中伙伴', mother: '母亲', father: '父亲', child: '孩子', older_littermate: '年长同窝', younger_littermate: '年幼同窝', caregiver: '照护者', cared_for: '被照护', needs_space: '需要空间' }
const RECEIPT_KINDS = { pet: '猫咪档案', relationship: '双方关系', location: '粗位置记录' }
const text = value => typeof value === 'string' ? value : ''
const rows = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []
function timeLabel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '时间未记录'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未记录'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function messageRow(item, index) {
  const mine = item.role === 'user'
  const source = text(item.source) || text(item.label)
  return { id: text(item.id) || `message_${index}`, mine, text: text(item.text), timeLabel: timeLabel(item.time),
    sourceLabel: mine ? '你 · 本机留存' : source === '本地引导' ? '本地引导 · 固定规则' : source === '云端回复' ? '云端回复 · 本机留存' : '来源未标注 · 本机留存' }
}
function relationshipRow(item, pets, index) {
  const byId = new Map(pets.map(pet => [pet.id, pet]))
  const name = id => byId.has(id) ? text(byId.get(id).name) || '未命名猫咪' : '档案已不存在'
  const pair = [item.petAId, item.petBId]
  const directed = item.directionStatus === 'confirmed' && ['directed', 'mutual'].includes(item.directionMode) &&
    item.fromPetId !== item.toPetId && pair.includes(item.fromPetId) && pair.includes(item.toPetId) && ROLES[item.fromRole] && ROLES[item.toRole]
  const first = directed ? `${name(item.fromPetId)}（${ROLES[item.fromRole]}）` : name(item.petAId)
  const second = directed ? `${name(item.toPetId)}（${ROLES[item.toRole]}）` : name(item.petBId)
  const arrow = item.directionMode === 'mutual' ? '↔' : '→'
  return { id: text(item.id) || `relationship_${index}`, forward: directed ? `${first} ${arrow} ${second}` : `${first} × ${second}`,
    reverse: directed ? `${second} ${arrow === '↔' ? '↔' : '←'} ${first}` : '旧记录未确认双方身份，不推断方向。',
    note: text(item.note), pending: !directed, missing: pair.some(id => !byId.has(id)), timeLabel: timeLabel(item.updatedAt) }
}

Page({
  data: { loading: true, error: '', activeSection: 'cats', pets: [], relationships: [], messages: [], actionReceipts: [], receiptCount: 0, receiptsExpanded: false,
    counts: { pets: 0, relationships: 0, locations: 0, messages: 0 }, historyLimit: 30, hasEarlier: false, exporting: false },
  onLoad(options = {}) {
    this._disposed = false
    if (['cats', 'relationships', 'history'].includes(options.section)) this.setData({ activeSection: options.section })
  },
  onShow() { this._disposed = false; return this.loadData() },
  onUnload() { this._disposed = true; this._loadToken = (this._loadToken || 0) + 1 },
  onPullDownRefresh() { return this.loadData().finally(() => wx.stopPullDownRefresh()) },
  async loadData() {
    const token = this._loadToken = (this._loadToken || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const [overview, messages] = await Promise.all([companion.getOverview(), companion.listMessages()])
      if (this._disposed || token !== this._loadToken) return false
      if (!overview || !Array.isArray(overview.pets) || !Array.isArray(messages)) throw new Error('本机记录暂时无法读取，请重试。')
      const pets = rows(overview.pets).filter(pet => text(pet.id)).map(pet => ({ id: pet.id, name: text(pet.name) || '未命名猫咪', breed: text(pet.breed), coatColor: text(pet.coatColor), imagePath: text(pet.imagePath), timeLabel: timeLabel(pet.updatedAt) }))
      const relationships = rows(overview.relationships).map((item, index) => relationshipRow(item, pets, index))
      this._actionReceipts = rows(overview.actionReceipts).filter(item => text(item.id) && RECEIPT_KINDS[item.kind]).slice()
        .sort((left, right) => (Number(right.confirmedAt) || 0) - (Number(left.confirmedAt) || 0))
        .map(item => ({ id: item.id, kind: item.kind, kindLabel: RECEIPT_KINDS[item.kind], timeLabel: timeLabel(item.confirmedAt),
          statusLabel: '曾确认保存到本机（当前状态请查看档案）' }))
      this._messages = rows(messages).map((item, index) => ({ item, index })).sort((left, right) => (Number(right.item.time) || 0) - (Number(left.item.time) || 0) || right.index - left.index).map(({ item, index }) => messageRow(item, index))
      this.setData({ pets, relationships, counts: { pets: pets.length, relationships: relationships.length, locations: rows(overview.locations).length, messages: this._messages.length } })
      this.showHistory()
      this.showReceipts()
      return true
    } catch (error) {
      if (!this._disposed && token === this._loadToken) this.setData({ error: error.message || '本机记录暂时无法读取，请重试。' })
      return false
    } finally {
      if (!this._disposed && token === this._loadToken) this.setData({ loading: false })
    }
  },
  selectSection(event) {
    const section = event.currentTarget.dataset.section
    if (['cats', 'relationships', 'history'].includes(section)) this.setData({ activeSection: section })
  },
  showHistory() {
    const messages = this._messages || []
    this.setData({ messages: messages.slice(0, this.data.historyLimit), hasEarlier: messages.length > this.data.historyLimit })
  },
  showEarlier() { this.setData({ historyLimit: this.data.historyLimit + 30 }); this.showHistory() },
  showReceipts() {
    const receipts = this._actionReceipts || []
    this.setData({ actionReceipts: this.data.receiptsExpanded ? receipts : receipts.slice(0, 3), receiptCount: receipts.length })
  },
  toggleReceipts() { this.setData({ receiptsExpanded: !this.data.receiptsExpanded }); this.showReceipts() },
  openReceipt(event) {
    if (this._disposed) return
    const receipt = this.data.actionReceipts.find(item => item.id === event.currentTarget.dataset.id)
    if (!receipt) return
    // A receipt is historical evidence, not a claim that its target still exists.
    // Open the relevant current-data section; never recreate or open a stale id.
    if (receipt.kind === 'pet') this.goPets()
    else if (receipt.kind === 'relationship') this.goRelationships()
    else if (receipt.kind === 'location') this.goMap()
  },
  async openPet(event) {
    const id = text(event.currentTarget.dataset.id)
    if (!id || this._disposed) return false
    try {
      const overview = await companion.getOverview()
      if (this._disposed) return false
      if (!rows(overview && overview.pets).some(pet => pet.id === id)) {
        await this.loadData()
        if (!this._disposed) this.setData({ error: '这份猫咪档案已不存在，列表已更新。' })
        return false
      }
      wx.navigateTo({ url: `/pages/pet-detail/index?id=${encodeURIComponent(id)}` })
      return true
    } catch (_) { if (!this._disposed) this.setData({ error: '无法核对这份本机档案，请重试。' }); return false }
  },
  exportHistory() {
    if (this.data.exporting || this.data.loading || this._disposed) return
    this.setData({ exporting: true })
    const finish = () => { if (!this._disposed) this.setData({ exporting: false }) }
    wx.showModal({ title: '复制本机对话记录？', content: '导出内容含私人对话、未发送文字及待确认草稿。确认后复制 JSON 到系统剪贴板，其他应用可能读取；不会自动上传或发布到社区。请妥善保管。', confirmText: '确认复制', confirmColor: '#FF6F91',
      success: async result => {
        if (!result.confirm || this._disposed) { finish(); return }
        try {
          const exported = await companion.exportHistory()
          if (this._disposed) return
          if (typeof exported !== 'string' || !exported) throw new Error('本机记录未能导出，请重试。')
          wx.setClipboardData({ data: exported, success: () => { if (!this._disposed) wx.showToast({ title: '已复制，请妥善保管', icon: 'none' }) }, fail: () => { if (!this._disposed) this.setData({ error: '复制失败，记录仍保留在本机。' }) }, complete: finish })
        } catch (error) { if (!this._disposed) this.setData({ error: error.message || '本机记录未能导出。' }); finish() }
      }, fail: finish })
  },
  goChat() { wx.switchTab({ url: '/pages/home/index' }) },
  goPets() { wx.switchTab({ url: '/pages/pets/index' }) },
  goRelationships() { wx.navigateTo({ url: '/pages/relationships/index' }) },
  goMap() { wx.navigateTo({ url: '/pages/companion-map/index' }) },
  goOnline() { wx.navigateTo({ url: '/pages/online/index' }) },
  goSocial() { wx.switchTab({ url: '/pages/social/index' }) },
  goSettings() { wx.navigateTo({ url: '/pages/settings/index' }) }
})
