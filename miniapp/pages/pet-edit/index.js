const storage = require('../../utils/storage')
const socialHandoff = require('../../utils/social-handoff')

const emptyForm = {
  name: '', breed: '', gender: '未知', weight: '', birthday: '', coatColor: '',
  estimatedAge: '', notes: '', healthStatus: '', imagePath: ''
}

Page({
  data: {
    id: '',
    form: emptyForm,
    genders: ['未知', '公', '母'],
    genderIndex: 0,
    saving: false,
    error: '',
    shareAllowed: true
  },

  onLoad(options) {
    this._editingExisting = Boolean(options.id)
    if (!options.id) return
    const pet = storage.getPet(options.id)
    if (!pet) return
    this.setData({
      id: options.id,
      form: Object.assign({}, emptyForm, pet),
      shareAllowed: socialHandoff.canSharePet(pet),
      genderIndex: Math.max(0, this.data.genders.indexOf(pet.gender))
    })
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: event.detail.value })
  },

  onGenderChange(event) {
    const genderIndex = Number(event.detail.value)
    this.setData({ genderIndex, 'form.gender': this.data.genders[genderIndex] })
  },

  onBirthdayChange(event) { this.setData({ 'form.birthday': event.detail.value }) },

  chooseImage() {
    if (this._saving) return
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: ({ tempFiles }) => {
        if (tempFiles && tempFiles[0]) this.setData({ 'form.imagePath': tempFiles[0].tempFilePath })
      }
    })
  },

  save() { return this.persistAndNavigate(false) },

  saveAndShare() { return this.persistAndNavigate(true) },

  finishSaving() {
    this._saving = false
    this.setData({ saving: false })
  },

  async persistAndNavigate(share) {
    if (this._saving) return
    const form = Object.assign({}, this.data.form)
    if (!form.name.trim()) {
      wx.showToast({ title: '请填写猫咪名字', icon: 'none' })
      return
    }
    if (share && (!this.data.shareAllowed || form.demo || (form.recognition && form.recognition.demo))) {
      wx.showToast({ title: '演示档案不可分享', icon: 'none' })
      return
    }
    this._saving = true
    this.setData({ saving: true, error: '' })
    try {
      const previous = this.data.id ? storage.getPet(this.data.id) : null
      if (this.data.id && !previous) throw new Error('档案不存在或已删除，请返回重新登记。')
      const imagePath = await storage.persistImage(form.imagePath)
      const pet = storage.savePet(Object.assign({}, previous || {}, form, { name: form.name.trim(), imagePath }, this.data.id ? { id: this.data.id } : {}))
      // Retain the id before navigating so a failed navigation cannot duplicate a new archive.
      this.setData({ id: pet.id, 'form.imagePath': imagePath })
      const navigation = {
        success: () => this.finishSaving(),
        fail: () => {
          this.finishSaving()
          this.setData({ error: '档案已保存在本机，但页面未能打开。可以再次点击继续，或返回「我的猫咪」查看。' })
        }
      }
      if (share) wx.redirectTo(Object.assign(navigation, { url: socialHandoff.composeUrl(pet.id) }))
      else if (this._editingExisting) wx.navigateBack(navigation)
      else wx.redirectTo(Object.assign(navigation, { url: `/pages/pet-detail/index?id=${encodeURIComponent(pet.id)}` }))
    } catch (error) {
      this.finishSaving()
      this.setData({ error: '档案未能保存，请检查本机存储空间后重试。没有发布任何内容。' })
    }
  }
})
