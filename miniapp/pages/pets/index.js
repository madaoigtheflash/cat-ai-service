const storage = require('../../utils/storage')

Page({
  data: { pets: [] },

  onShow() {
    this.setData({ pets: storage.listPets() })
  },

  addPet() { wx.navigateTo({ url: '/pages/pet-edit/index' }) },
  openRelationships() { wx.navigateTo({ url: '/pages/relationships/index' }) },
  openPet(event) { wx.navigateTo({ url: `/pages/pet-detail/index?id=${event.currentTarget.dataset.id}` }) },
  deletePet(event) {
    const { id, name } = event.currentTarget.dataset
    wx.showModal({
      title: `删除${name || '这份档案'}？`,
      content: '本地健康记录也会一起删除，且无法恢复。',
      confirmText: '删除',
      confirmColor: '#d84343',
      success: ({ confirm }) => {
        if (!confirm) return
        storage.removePet(id)
        this.setData({ pets: storage.listPets() })
      }
    })
  }
})
