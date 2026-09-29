const api = require('../../services/api')
const storage = require('../../utils/storage')
const socialHandoff = require('../../utils/social-handoff')

Page({
  data: {
    imagePath: '',
    loading: false,
    result: null,
    error: '',
    configured: false,
    saving: false,
    savedPetId: ''
  },

  onShow() {
    const app = getApp()
    this.setData({ configured: Boolean(wx.cloud && app && app.globalData && app.globalData.cloudReady) })
    // 自定义 tabBar 中间凸起按钮直出相机后，经 globalData 把照片带到这里。
    const pendingImage = app && app.globalData && app.globalData.pendingIdentifyImage
    if (pendingImage) {
      app.globalData.pendingIdentifyImage = ''
      this.setData({ imagePath: pendingImage, result: null, error: '', savedPetId: '' })
    }
  },

  chooseImage() {
    if (this.data.loading || this._saving) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: ({ tempFiles }) => {
        const imagePath = tempFiles[0] && tempFiles[0].tempFilePath
        if (imagePath) this.setData({ imagePath, result: null, error: '', savedPetId: '' })
      }
    })
  },

  async runIdentify() {
    if (this.data.loading || this._saving) return
    if (!this.data.imagePath) {
      wx.showToast({ title: '请先选择照片', icon: 'none' })
      return
    }
    if (!this.data.configured) {
      this.setData({ error: '照片观察服务尚未就绪，请先到设置页检查微信云开发连接。' })
      return
    }
    this.setData({ loading: true, error: '', result: null, savedPetId: '' })
    try {
      const result = await api.identify(this.data.imagePath)
      this.setData({ result: api.normalizeIdentifyResult(result) })
    } catch (error) {
      this.setData({ error: error.message || '照片观察失败，请稍后重试' })
    } finally {
      this.setData({ loading: false })
    }
  },

  showDemo() {
    if (this.data.loading || this._saving) return
    this.setData({
      error: '',
      savedPetId: '',
      result: {
        breed: '中华田园猫', confidence: 86, coat_color: '橘白', coat_pattern: '双色',
        estimated_age: '约 1–3 岁', gender: '未知', features: ['白色胸腹', '橘色虎斑', '短毛'],
        description: '这是界面演示结果，不代表对当前照片进行了真实观察。', demo: true
      }
    })
  },

  goSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },

  onShareAppMessage() {
    const result = this.data.result
    if (result && !result.demo) {
      return {
        title: `这只猫可能是${result.breed || '未知品种'}，相似度 ${result.confidence || 0}%`,
        path: '/pages/identify/index?from=identify'
      }
    }
    return {
      title: '拍张照片，观察猫咪的品种与外观特征',
      path: '/pages/identify/index?from=share'
    }
  },

  onShareTimeline() {
    const result = this.data.result
    if (result && !result.demo) {
      return {
        title: `这只猫可能是${result.breed || '未知品种'}，相似度 ${result.confidence || 0}%`,
        query: 'from=identify'
      }
    }
    return {
      title: '拍张照片，观察猫咪的品种与外观特征',
      query: 'from=timeline'
    }
  },

  saveToPet() { this.requestSave(false) },

  registerAndShare() { this.requestSave(true) },

  finishSaving() {
    this._saving = false
    this.setData({ saving: false })
  },

  openSavedPet(petId, share) {
    wx.navigateTo({
      url: share ? socialHandoff.composeUrl(petId) : `/pages/pet-detail/index?id=${encodeURIComponent(petId)}`,
      success: () => this.finishSaving(),
      fail: () => {
        this.finishSaving()
        this.setData({ error: '档案已保存在本机，但页面未能打开。请再次点击继续，或到「我的猫咪」查看。' })
      }
    })
  },

  requestSave(share) {
    if (this._saving || this.data.loading) return
    const result = this.data.result
    if (!result) return
    if (!socialHandoff.canRegisterResult(result)) {
      wx.showToast({ title: '演示结果不可登记或分享', icon: 'none' })
      return
    }
    this._saving = true
    this.setData({ saving: true, error: '' })
    const imagePath = this.data.imagePath
    try {
      const savedPet = this.data.savedPetId && storage.getPet(this.data.savedPetId)
      if (socialHandoff.canSharePet(savedPet)) {
        this.openSavedPet(savedPet.id, share)
        return
      }
    } catch (error) {
      this.finishSaving()
      this.setData({ error: '暂时无法读取本机档案，请稍后重试。' })
      return
    }
    wx.showModal({
      title: share ? '登记后分享' : '保存猫咪档案',
      content: share ? '先保存到本机，再填写动态。档案不会自动公开。' : '档案仅保存在本机，不会发布到广场。',
      editable: true,
      placeholderText: '给猫咪起个名字',
      confirmText: share ? '保存继续' : '保存',
      success: async ({ confirm, content }) => {
        if (!confirm) { this.finishSaving(); return }
        try {
          const persistedImagePath = await storage.persistImage(imagePath)
          const pet = storage.savePet({
            name: (content || '').trim().slice(0, 20) || '未命名猫咪',
            breed: result.breed,
            gender: result.gender,
            estimatedAge: result.estimated_age,
            coatColor: result.coat_color,
            coatPattern: result.coat_pattern,
            features: result.features || [],
            imagePath: persistedImagePath,
            recognition: result
          })
          this.setData({ savedPetId: pet.id })
          this.openSavedPet(pet.id, share)
        } catch (error) {
          this.finishSaving()
          this.setData({ error: '档案未能保存，请检查本机存储空间后重试。没有发布任何内容。' })
        }
      },
      fail: () => {
        this.finishSaving()
        this.setData({ error: '未能打开登记窗口，请重试。' })
      }
    })
  }
})
