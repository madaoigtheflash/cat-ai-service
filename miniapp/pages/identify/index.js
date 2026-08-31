const api = require('../../services/api')
const storage = require('../../utils/storage')

Page({
  data: {
    imagePath: '',
    loading: false,
    result: null,
    error: '',
    configured: false
  },

  onShow() {
    const app = getApp()
    this.setData({ configured: Boolean(wx.cloud && app && app.globalData && app.globalData.cloudReady) })
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: ({ tempFiles }) => {
        const imagePath = tempFiles[0] && tempFiles[0].tempFilePath
        if (imagePath) this.setData({ imagePath, result: null, error: '' })
      }
    })
  },

  async runIdentify() {
    if (!this.data.imagePath) {
      wx.showToast({ title: '请先选择照片', icon: 'none' })
      return
    }
    if (!this.data.configured) {
      this.setData({ error: '云端识别服务尚未就绪，请先到设置页检查 CloudBase 连接。' })
      return
    }
    this.setData({ loading: true, error: '', result: null })
    try {
      const result = await api.identify(this.data.imagePath)
      this.setData({ result: api.normalizeIdentifyResult(result) })
    } catch (error) {
      this.setData({ error: error.message || '识别失败，请稍后重试' })
    } finally {
      this.setData({ loading: false })
    }
  },

  showDemo() {
    this.setData({
      error: '',
      result: {
        breed: '中华田园猫', confidence: 86, coat_color: '橘白', coat_pattern: '双色',
        estimated_age: '约 1–3 岁', gender: '未知', features: ['白色胸腹', '橘色虎斑', '短毛'],
        description: '这是界面演示结果，不代表对当前照片进行了真实识别。', demo: true
      }
    })
  },

  goSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },

  saveToPet() {
    const result = this.data.result
    if (!result) return
    if (result.demo) {
      wx.showToast({ title: '演示结果不可保存', icon: 'none' })
      return
    }
    wx.showModal({
      title: '保存猫咪档案',
      editable: true,
      placeholderText: '给猫咪起个名字',
      confirmText: '保存',
      success: async ({ confirm, content }) => {
        if (!confirm) return
        const imagePath = await storage.persistImage(this.data.imagePath)
        const pet = storage.savePet({
          name: (content || '').trim() || '未命名猫咪',
          breed: result.breed,
          gender: result.gender,
          estimatedAge: result.estimated_age,
          coatColor: result.coat_color,
          coatPattern: result.coat_pattern,
          features: result.features || [],
          imagePath,
          recognition: result
        })
        wx.navigateTo({ url: `/pages/pet-detail/index?id=${pet.id}` })
      }
    })
  }
})
