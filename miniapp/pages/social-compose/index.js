const community = require('../../services/community')
const storage = require('../../utils/storage')
const handoff = require('../../utils/social-handoff')

Page({
  data: { content: '', photos: [], cat: null, includeCat: false, offeredPhoto: '', consent: false,
    busy: false, choosing: false, error: '', saved: false, sent: false, postId: '', status: '',
    progressPhase: '', progressText: '', progressCompleted: 0, progressTotal: 0, progressPercent: null },
  onLoad(options = {}) {
    this._disposed = false
    this._session = (this._session || 0) + 1
    const session = this._session
    this._uploads = {}
    this._requestId = community.requestId()
    const draft = community.getDraft()
    if (draft) {
      this._requestId = draft.requestId || this._requestId
      this._uploads = draft.uploads || {}
      this.setData({ content: draft.content || '', photos: draft.photos || [], cat: draft.cat || null, includeCat: Boolean(draft.includeCat) })
    }
    if (options.petId) {
      const pet = storage.getPet(options.petId)
      if (pet && handoff.canSharePet(pet)) {
        const apply = () => {
          if (this._disposed || session !== this._session || this.data.busy) return
          this.setData({ cat: handoff.toPublicCat(pet), includeCat: true, offeredPhoto: handoff.getPhotoCandidate(pet) })
          this.changed()
        }
        if (draft && (draft.content || (draft.photos || []).length)) {
          wx.showModal({ title: '已有一份故事草稿', content: '是否将这只猫的基础名片关联到草稿？原文字和已选照片会保留。', confirmText: '关联名片', success: result => { if (result.confirm) apply() } })
        } else apply()
      } else this.setData({ error: '这份本地档案已不存在，可以不关联猫咪直接分享。' })
    }
  },
  onUnload() { this._disposed = true; this._session = (this._session || 0) + 1 },
  draft() { return { content: this.data.content, photos: this.data.photos, cat: this.data.cat, includeCat: this.data.includeCat, requestId: this._requestId, uploads: this._uploads } },
  persist() {
    if (this._disposed) return false
    try { community.saveDraft(this.draft()); this.setData({ saved: true }); return true }
    catch (_) { this.setData({ error: '草稿保存失败，请检查本机存储；本页内容仍保留。', saved: false }); return false }
  },
  changed() {
    if (this._disposed) return
    this._requestId = community.requestId()
    this.setData({ consent: false, error: '' })
    this.persist()
  },
  onInput(event) { if (this._disposed || this.data.busy) return; this.setData({ content: event.detail.value }); this.changed() },
  onCatChange(event) { if (this._disposed || this.data.busy) return; this.setData({ includeCat: event.detail.value.includes('cat') }); this.changed() },
  onConsent(event) { if (!this._disposed && !this.data.busy) this.setData({ consent: event.detail.value.includes('public') }) },
  useArchivePhoto() {
    if (this._disposed || this.data.busy || this.data.choosing || !this.data.offeredPhoto || this.data.photos.length >= 3) return
    if (!this.data.photos.includes(this.data.offeredPhoto)) {
      this.setData({ photos: this.data.photos.concat(this.data.offeredPhoto) }); this.changed()
    }
  },
  async choosePhotos() {
    if (this._disposed || this.data.busy || this.data.choosing || this.data.photos.length >= 3) return
    const session = this._session
    const current = () => !this._disposed && session === this._session
    this.setData({ choosing: true, error: '' })
    try {
      const paths = await community.choosePhotos(3 - this.data.photos.length)
      if (!current()) return
      if (paths.length) { this.setData({ photos: [...new Set(this.data.photos.concat(paths))].slice(0, 3) }); this.changed() }
    }
    catch (error) { if (current() && !/cancel/i.test(error.errMsg || error.message || '')) this.setData({ error: error.message || '没有选好照片，请重试。' }) }
    finally { if (current()) this.setData({ choosing: false }) }
  },
  removePhoto(event) {
    if (this._disposed || this.data.busy || this.data.choosing) return
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.photos.length) return
    this.setData({ photos: this.data.photos.filter((_, position) => position !== index) }); this.changed()
  },
  setCover(event) {
    if (this._disposed || this.data.busy || this.data.choosing) return
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index <= 0 || index >= this.data.photos.length) return
    const photos = this.data.photos.slice()
    const cover = photos.splice(index, 1)[0]
    this.setData({ photos: [cover, ...photos] }); this.changed()
  },
  previewPhoto(event) { if (!this._disposed) wx.previewImage({ current: event.currentTarget.dataset.src, urls: this.data.photos }) },
  updateProgress(progress) {
    if (this._disposed || !this.data.busy || !progress) return
    const phases = ['preparing', 'uploading', 'submitting']
    if (!phases.includes(progress.phase) || phases.indexOf(progress.phase) < phases.indexOf(this.data.progressPhase)) return
    const total = Number.isInteger(progress.total) && progress.total >= 0 ? Math.min(3, progress.total) : this.data.photos.length
    const completed = Number.isInteger(progress.completed) ? Math.max(0, Math.min(total, progress.completed)) : 0
    const percent = progress.phase === 'uploading' && typeof progress.percent === 'number' && Number.isFinite(progress.percent)
      ? Math.round(Math.max(0, Math.min(100, progress.percent))) : null
    const labels = { preparing: total ? '正在准备照片…' : '正在准备动态…', uploading: '正在上传照片…', submitting: '正在提交动态，等待服务端确认…' }
    this.setData({ progressPhase: progress.phase, progressText: labels[progress.phase], progressTotal: total, progressCompleted: completed, progressPercent: percent })
  },
  async publish() {
    if (this._disposed || this.data.busy || this.data.choosing || this.data.sent) return
    if (!this.data.content.trim() && !this.data.photos.length) { this.setData({ error: '请选择至少一张猫咪照片，或写下一句故事。' }); return }
    if (!this.data.consent) { this.setData({ error: '请勾选确认公开的内容。' }); return }
    if (!this.persist()) return
    const session = this._session
    let active = true
    const current = () => active && !this._disposed && session === this._session
    this.setData({ busy: true, error: '', progressPhase: '', progressText: '', progressPercent: null })
    this.updateProgress({ phase: 'preparing', completed: 0, total: this.data.photos.length })
    try {
      const result = await community.publishPost({ ...this.draft(), consent: true }, { onProgress: progress => { if (current()) this.updateProgress(progress) } })
      if (!current()) return
      const post = result.post || result
      this.setData({ sent: true, status: post.status, postId: post.id || '', saved: false })
    } catch (error) {
      if (!current()) return
      const draft = community.getDraft()
      if (draft) this._uploads = draft.uploads || {}
      this.setData({ error: error.message || '提交失败，草稿已保留，请重试。' })
    } finally { if (current()) this.setData({ busy: false }); active = false }
  },
  viewPost() { if (this.data.postId) wx.redirectTo({ url: `/pages/social-post/index?id=${encodeURIComponent(this.data.postId)}` }); else wx.switchTab({ url: '/pages/social/index' }) },
  goSocial() { wx.switchTab({ url: '/pages/social/index' }) },
  goIdentify() { wx.navigateTo({ url: '/pages/identify/index' }) }
})
