const storage = require('../../utils/storage')
const socialHandoff = require('../../utils/social-handoff')

Page({
  data: { id: '', pet: null, records: [], shareAllowed: false, openingShare: false },

  onLoad(options) { this.setData({ id: options.id || '' }) },
  onShow() { this.loadPet() },

  onPullDownRefresh() {
    this.loadPet()
    wx.stopPullDownRefresh()
  },

  onShareAppMessage() {
    return {
      title: '来猫猫小屋，聊聊猫咪的日常',
      path: '/pages/home/index',
      imageUrl: '/assets/showcase/cozy-nap.jpg'
    }
  },

  onShareTimeline() {
    return {
      title: '来猫猫小屋，聊聊猫咪的日常',
      query: 'from=share',
      imageUrl: '/assets/showcase/cozy-nap.jpg'
    }
  },

  loadPet() {
    const pet = storage.getPet(this.data.id)
    if (!pet) {
      this.setData({ pet: null, records: [], shareAllowed: false })
      wx.showToast({ title: '档案不存在', icon: 'none' })
      return
    }
    const records = []
    ;['weights', 'vaccines', 'deworming', 'medical'].forEach(type => {
      ;(pet[type] || []).forEach(item => records.push(Object.assign({ type }, item)))
    })
    records.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    this.setData({ pet, records, shareAllowed: socialHandoff.canSharePet(pet) })
    wx.setNavigationBarTitle({ title: pet.name || '猫咪详情' })
  },

  edit() { wx.navigateTo({ url: `/pages/pet-edit/index?id=${this.data.id}` }) },

  sharePet() {
    if (this._openingShare) return
    let pet
    try { pet = storage.getPet(this.data.id) } catch (error) {
      wx.showToast({ title: '档案暂时无法读取，请重试', icon: 'none' })
      return
    }
    if (!socialHandoff.canSharePet(pet)) {
      wx.showToast({ title: '当前档案不可分享', icon: 'none' })
      return
    }
    this._openingShare = true
    this.setData({ openingShare: true })
    wx.navigateTo({
      url: socialHandoff.composeUrl(pet.id),
      fail: () => wx.showToast({ title: '发布页未能打开，请重试', icon: 'none' }),
      complete: () => {
        this._openingShare = false
        this.setData({ openingShare: false })
      }
    })
  },

  openRelationships() {
    wx.navigateTo({ url: `/pages/relationships/index?id=${this.data.id}` })
  },

  addRecord() {
    const choices = ['记录体重', '记录疫苗', '记录驱虫', '记录就医']
    const types = ['weights', 'vaccines', 'deworming', 'medical']
    wx.showActionSheet({
      itemList: choices,
      success: ({ tapIndex }) => {
        wx.showModal({
          title: choices[tapIndex],
          editable: true,
          placeholderText: tapIndex === 0 ? '例如：4.2 kg' : '填写名称或简要说明',
          success: ({ confirm, content }) => {
            if (!confirm || !String(content || '').trim()) return
            const pet = storage.getPet(this.data.id)
            const key = types[tapIndex]
            pet[key] = pet[key] || []
            pet[key].push({ id: `record_${Date.now()}`, date: this.today(), content: String(content).trim() })
            if (key === 'weights') pet.weight = String(content).replace(/\s*kg\s*$/i, '')
            storage.savePet(pet)
            this.loadPet()
          }
        })
      }
    })
  },

  today() {
    const now = new Date()
    const pad = value => String(value).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  },

  deletePet() {
    wx.showModal({
      title: `删除${this.data.pet.name}？`,
      content: '所有本地健康记录也会删除，且无法恢复。',
      confirmText: '删除', confirmColor: '#d84343',
      success: ({ confirm }) => {
        if (!confirm) return
        storage.removePet(this.data.id)
        wx.switchTab({ url: '/pages/pets/index' })
      }
    })
  }
})
