const storage = require('../../utils/storage')

const emptyForm = {
  name: '', breed: '', gender: '未知', weight: '', birthday: '', coatColor: '',
  estimatedAge: '', notes: '', healthStatus: '', imagePath: ''
}

Page({
  data: {
    id: '',
    form: emptyForm,
    genders: ['未知', '公', '母'],
    genderIndex: 0
  },

  onLoad(options) {
    if (!options.id) return
    const pet = storage.getPet(options.id)
    if (!pet) return
    this.setData({
      id: options.id,
      form: Object.assign({}, emptyForm, pet),
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
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: ({ tempFiles }) => this.setData({ 'form.imagePath': tempFiles[0].tempFilePath })
    })
  },

  async save() {
    const form = this.data.form
    if (!form.name.trim()) {
      wx.showToast({ title: '请填写猫咪名字', icon: 'none' })
      return
    }
    const previous = this.data.id ? storage.getPet(this.data.id) : null
    const imagePath = await storage.persistImage(form.imagePath)
    const pet = storage.savePet(Object.assign({}, previous || {}, form, { imagePath }, this.data.id ? { id: this.data.id } : {}))
    wx.showToast({ title: '已保存', icon: 'success' })
    setTimeout(() => {
      if (this.data.id) wx.navigateBack()
      else wx.redirectTo({ url: `/pages/pet-detail/index?id=${pet.id}` })
    }, 350)
  }
})
