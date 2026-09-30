const companion = require('../../services/companion')
const remote = require('../../services/companion-remote')
const storage = require('../../utils/storage')
const api = require('../../services/api')
const handoff = require('../../utils/social-handoff')
const presence = require('../../utils/companion-presence')
const release = require('../../config/companion-release')
const roles = [
  { label: '母亲 → 孩子（需要你确认）', from: 'mother', to: 'child' },
  { label: '父亲 → 孩子（需要你确认）', from: 'father', to: 'child' },
  { label: '照护者 → 被照护者', from: 'caregiver', to: 'cared_for' },
  { label: '朋友 ↔ 朋友', from: 'friend', to: 'friend' },
  { label: '玩伴 ↔ 玩伴', from: 'playmate', to: 'playmate' }
]
Page({
  data: {
    input: '', messages: [], draft: null, pets: [], error: '', notice: '',
    busy: false, cloudMode: false, keyboardHeight: 0, scrollTarget: '',
    roleLabels: roles.map(item => item.label), roleIndex: 0,
    fromIndex: 0, toIndex: 0, petIndex: 0, pendingPhoto: '',
    savedPetId: '', retryText: '', truncated: false,
    greeting: '', catReply: '碰一下我的爪爪，打个招呼。', catReacting: false,
    reduceMotion: false, assetFailed: false, cloudAvailable: release.cloudDialogueEnabled === true
  },
  onLoad() {
    this._revision = 0
    this._touchCount = 0
    this.setData({ greeting: presence.greeting(new Date().getHours()) })
    try { this.setData({ input: companion.getComposerDraft() || '' }); this.refresh() }
    catch (error) { this.showError(error) }
  },
  onShow() {
    if (this.getTabBar && this.getTabBar()) this.getTabBar().setData({ selected: 0 })
    try { this.setData({ reduceMotion: wx.getStorageSync(presence.MOTION_KEY) === true }); this.refresh() } catch (error) { this.showError(error) }
  },
  onHide() { this.saveInput(); this.stopReaction(); this.setData({ keyboardHeight: 0 }) },
  onUnload() { this.saveInput(); this.stopReaction() },
  onPullDownRefresh() { try { this.refresh() } finally { wx.stopPullDownRefresh() } },
  showError(error) { this.setData({ error: error.message || '暂时未能完成，请保留当前内容后重试。' }) },
  saveInput() { try { companion.saveComposerDraft(this.data.input) } catch (error) { this.showError(error) } },
  refresh() {
    const state = companion.getState()
    const pets = storage.listPets()
    const draft = state.draft
    const fields = draft ? draft.fields : {}
    const foundRole = roles.findIndex(item => item.from === fields.fromRole && item.to === fields.toRole)
    this.setData({
      messages: state.messages.slice(-24), truncated: state.messages.length > 24,
      draft, pets, savedPetId: draft ? '' : this.data.savedPetId, roleIndex: Math.max(0, foundRole),
      fromIndex: Math.max(0, pets.findIndex(item => item.id === fields.fromPetId)),
      toIndex: Math.max(0, pets.findIndex(item => item.id === fields.toPetId)),
      petIndex: Math.max(0, pets.findIndex(item => item.id === fields.petId)),
      scrollTarget: draft ? 'draft-card' : state.messages.length ? 'conversation-end' : ''
    })
  },
  stopReaction() {
    if (this._reactionTimer) clearTimeout(this._reactionTimer)
    this._reactionTimer = null
    this.setData({ catReacting: false })
  },
  touchCat() {
    if (this.data.busy || this.data.catReacting) return
    this.setData({ catReply: presence.reaction(this._touchCount++), catReacting: !this.data.reduceMotion })
    if (!this.data.reduceMotion) this._reactionTimer = setTimeout(() => {
      this._reactionTimer = null
      this.setData({ catReacting: false })
    }, 360)
  },
  toggleMotion() {
    const next = !this.data.reduceMotion
    try {
      wx.setStorageSync(presence.MOTION_KEY, next)
      this.stopReaction()
      this.setData({ reduceMotion: next })
    } catch (error) { this.showError(error) }
  },
  onCatImageError() { this.setData({ assetFailed: true }) },
  showInteractionInfo() {
    wx.showModal({ title: '关于小桃的回应', content: '小桃是虚拟角色。当前使用本地固定规则和预设回应，不是自由生成对话，也不代表真实猫咪的想法。聊天留在本机；照片仅在你点击“上传并观察”后提交既有观察服务。档案、关系和地点都要由你确认保存。', showCancel: false, confirmText: '知道了', confirmColor: '#B94768' })
  },
  onInput(event) { this._revision += 1; this.setData({ input: event.detail.value }); this.saveInput() },
  onKeyboard(event) { this.setData({ keyboardHeight: Math.max(0, Number(event.detail.height) || 0) }) },
  usePrompt(event) {
    if (this.data.busy) return
    this._revision += 1
    this.setData({ input: event.currentTarget.dataset.text })
    this.saveInput()
  },
  async send() {
    if (this.data.busy) return
    const text = this.data.input.trim()
    if (!text) return
    if (this._pendingRemote) { this.setData({ error: '请重试或放弃上一条云端请求；新输入会保留。' }); return }
    if (this.data.cloudMode && release.cloudDialogueEnabled !== true) {
      this.setData({ cloudMode: false, error: '云端文字对话尚未开放。当前输入已保留，可使用本地引导。' }); return
    }
    if (this.data.cloudMode) {
      this._pendingRemote = {
        text, history: companion.listMessages().slice(-10).map(item => ({ role: item.role, content: item.text.slice(0, 1000) })),
        revision: this._revision, requestId: 'dialog_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
      }
      return this.retryRemote()
    }
    try {
      companion.send(text)
      this.setData({ input: '', error: '', notice: '' })
      companion.saveComposerDraft('')
      this.refresh()
    } catch (error) {
      // The draft can have persisted before appending the message failed.
      // Recover the actual state without resending or confirming anything.
      try { this.refresh() } catch (_) { /* Preserve the original failure and input. */ }
      this.showError(error)
    }
  },
  async retryRemote() {
    const request = this._pendingRemote
    if (!request || this.data.busy) return
    if (release.cloudDialogueEnabled !== true) { this.setData({ error: '云端文字对话尚未开放，输入与待处理内容已保留。' }); return }
    this.setData({ busy: true, error: '', retryText: request.text })
    try {
      if (!request.result) request.result = await remote.reply(request.text, request.history)
      companion.appendExchange(request.text, request.result.text, '云端回复', request.requestId)
      if (request.revision === this._revision) { this.setData({ input: '' }); companion.saveComposerDraft('') }
      this._pendingRemote = null
      this.setData({ retryText: '', notice: '回复已保存在本机；没有改动猫咪档案。' })
      this.refresh()
    } catch (error) { this.setData({ retryText: request.text }); this.showError(error) }
    finally { this.setData({ busy: false }) }
  },
  abandonRemote() {
    if (this.data.busy) return
    this._pendingRemote = null
    this.setData({ retryText: '', error: '', notice: '已放弃等待。输入保留，没有登记或分享。' })
  },
  changeMode() {
    if (this.data.busy || this._pendingRemote) return
    if (release.cloudDialogueEnabled !== true) { this.showInteractionInfo(); return }
    if (this.data.cloudMode) { this.setData({ cloudMode: false }); return }
    wx.showModal({
      title: '启用云端文字对话？',
      content: '将发送本次文字和最近最多 10 条对话给云端及第三方文字服务，超长历史会截短。不发送照片、档案、位置或社区内容。开发服务可能尚未部署；本地引导仍可使用。',
      confirmText: '同意并启用', confirmColor: '#B94768',
      success: result => { if (result.confirm) this.setData({ cloudMode: true, error: '' }) }
    })
  },
  makeDraft(event) {
    if (this.data.busy) return
    const kind = event.currentTarget.dataset.kind
    try {
      const pets = storage.listPets()
      if (kind !== 'pet' && !pets.length) throw Error('先登记一只猫，再为它记录关系或地点。')
      if (kind === 'relationship' && pets.length < 2) throw Error('关系需要两只已登记的猫。可以先登记另一只。')
      const fields = kind === 'pet' ? { name: '' } : kind === 'relationship'
        ? { fromPetId: pets[0].id, toPetId: pets[1].id, fromRole: 'friend', toRole: 'friend' }
        : { petId: pets[0].id, areaText: '' }
      companion.createDraft(kind, fields)
      this.setData({ error: '', notice: '', savedPetId: '' }); this.refresh()
    } catch (error) { this.showError(error) }
  },
  onDraftInput(event) {
    if (!this.data.draft || this.data.busy) return
    try {
      companion.updateDraft(this.data.draft.id, { [event.currentTarget.dataset.field]: event.detail.value })
      this.setData({ draft: companion.getDraft(), error: '' })
    } catch (error) { this.showError(error) }
  },
  onCatChange(event) {
    const pet = this.data.pets[Number(event.detail.value)]
    if (!pet || !this.data.draft || this.data.busy) return
    try { companion.updateDraft(this.data.draft.id, { [event.currentTarget.dataset.field]: pet.id }); this.refresh() }
    catch (error) { this.showError(error) }
  },
  onRoleChange(event) {
    const role = roles[Number(event.detail.value)]
    if (!role || !this.data.draft || this.data.busy) return
    try { companion.updateDraft(this.data.draft.id, { fromRole: role.from, toRole: role.to }); this.refresh() }
    catch (error) { this.showError(error) }
  },
  choosePlace() {
    const draft = this.data.draft
    if (!draft || draft.kind !== 'location' || this.data.busy) return
    wx.chooseLocation({
      success: result => {
        try {
          companion.updateDraft(draft.id, { latitude: result.latitude, longitude: result.longitude })
          this.setData({ notice: '已转成约 2 公里粗区域；请只填宽泛区域名称。', error: '' }); this.refresh()
        } catch (error) { this.showError(error) }
      },
      fail: error => { if (!/cancel/i.test(error.errMsg || '')) this.setData({ error: '未能选取地点。请检查位置权限后重试；不会自动定位。' }) }
    })
  },
  confirmDraft() {
    if (!this.data.draft || this.data.busy) return
    this.setData({ busy: true, error: '' })
    try {
      const result = companion.confirm(this.data.draft.id)
      this.setData({ savedPetId: result.kind === 'pet' ? result.targetId : '', notice: '已保存在本机。未同步到小屋，也未公开分享。' })
      this.refresh()
    } catch (error) { this.showError(error) }
    finally { this.setData({ busy: false }) }
  },
  cancelDraft() {
    if (!this.data.draft || this.data.busy) return
    try {
      const result = companion.cancel(this.data.draft.id)
      this.setData({ notice: result.message || '已取消登记，对话保留。', error: '' })
      this.refresh()
    }
    catch (error) { this.showError(error) }
  },
  choosePhoto() {
    if (this.data.busy || this.data.draft) { this.setData({ error: '请先确认或取消当前草稿，再选择照片。' }); return }
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'],
      success: result => {
        const file = result.tempFiles && result.tempFiles[0]
        if (file) this.setData({ pendingPhoto: file.tempFilePath, error: '', notice: '照片只在本机预览。点“上传并观察”后才提交云端。' })
      },
      fail: error => { if (!/cancel/i.test(error.errMsg || '')) this.setData({ error: '未能打开相册或相机，请检查权限后重试。' }) }
    })
  },
  removePhoto() { if (!this.data.busy) this.setData({ pendingPhoto: '', notice: '' }) },
  async identifyPhoto() {
    if (this.data.busy || !this.data.pendingPhoto) return
    if (this.data.draft) { this.setData({ error: '请先处理当前登记草稿。' }); return }
    this.setData({ busy: true, error: '' })
    try {
      if (!getApp().globalData.cloudReady) throw Error('照片观察服务未就绪，请在服务设置中检查连接。')
      const result = api.normalizeIdentifyResult(await api.identify(this.data.pendingPhoto))
      if (result.demo) throw Error('演示结果不能用于真实登记。')
      const imagePath = await storage.persistImage(this.data.pendingPhoto)
      companion.createDraft('pet', { name: '', breed: result.breed || '', coatColor: result.coat_color || '', imagePath })
      this.setData({ pendingPhoto: '', notice: '外观建议不确认同一只猫。请检查并命名，或取消后去档案关联已有猫。' }); this.refresh()
    } catch (error) { this.showError(error) }
    finally { this.setData({ busy: false }) }
  },
  shareSaved() {
    if (this.data.busy || this.data.draft || !this.data.savedPetId) return
    try {
      if (companion.getDraft()) { this.refresh(); return }
      wx.navigateTo({ url: handoff.composeUrl(this.data.savedPetId) })
    } catch (error) { this.showError(error) }
  },
  goData() { wx.navigateTo({ url: '/pages/companion-data/index?section=history' }) },
  goMap() { wx.navigateTo({ url: '/pages/companion-map/index' }) },
  goRelationships() { wx.navigateTo({ url: '/pages/relationships/index' }) },
  goOnline() { wx.navigateTo({ url: '/pages/online/index' }) },
  goSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },
  goPets() { wx.switchTab({ url: '/pages/pets/index' }) }
})
