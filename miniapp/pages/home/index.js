const storage = require('../../utils/storage')

Page({
  data: {
    pets: [],
    settings: {},
    greeting: '你好',
    configured: false
  },

  onShow() {
    const hour = new Date().getHours()
    const greeting = hour < 11 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
    const settings = storage.getSettings()
    const app = getApp()
    const configured = Boolean(wx.cloud && app && app.globalData && app.globalData.cloudReady)
    this.setData({
      pets: storage.listPets().slice(0, 3),
      settings,
      greeting,
      configured
    })
  },

  goIdentify() { wx.switchTab({ url: '/pages/identify/index' }) },
  goPets() { wx.switchTab({ url: '/pages/pets/index' }) },
  goKnowledge() { wx.switchTab({ url: '/pages/knowledge/index' }) },
  goRelationships() { wx.navigateTo({ url: '/pages/relationships/index' }) },
  goOnline() { wx.navigateTo({ url: '/pages/online/index' }) },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/index' }) },
  goSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },
  openPet(event) {
    wx.navigateTo({ url: `/pages/pet-detail/index?id=${event.currentTarget.dataset.id}` })
  }
})
