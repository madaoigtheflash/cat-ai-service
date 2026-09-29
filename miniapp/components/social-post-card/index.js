const { postOf } = require('./view-model')
const community = require('../../services/community')
const { createPhotoRecovery } = require('../../utils/community-photo-recovery')

Component({
  properties: {
    post: { type: Object, value: null }, detail: { type: Boolean, value: false }, showStatus: { type: Boolean, value: false }
  },
  data: { story: postOf(null), photoFailed: false, photoLoading: false, photoBlocked: false,
    photoMessage: '', photoCanRetry: false, photoSlot: false, photoRevision: 0 },
  observers: {
    post(value) {
      this._storyBase = postOf(value)
      const recovery = this.photoRecovery(), epoch = recovery.snapshot().epoch
      recovery.observe(this._storyBase)
      if (epoch !== recovery.snapshot().epoch) this._previewFlight = null
      if (this._photoAttached && this._photoVisible !== false) this.photoRecovery().resume()
    }
  },
  lifetimes: {
    attached() {
      this._photoAttached = true
      if (!this._storyBase) { this._storyBase = postOf(this.data.post); this.photoRecovery().observe(this._storyBase) }
      this.photoRecovery().resume()
    },
    detached() { this._photoAttached = false; if (this._photoRecovery) this._photoRecovery.dispose() }
  },
  pageLifetimes: {
    show() { this._photoVisible = true; if (this._photoAttached) this.photoRecovery().resume() },
    hide() { this._photoVisible = false }
  },
  methods: {
    photoRecovery() {
      if (!this._photoRecovery) this._photoRecovery = createPhotoRecovery({
        getPost: id => community.getPost(id),
        onChange: state => this.setData({ story: { ...(this._storyBase || postOf(null)), ...state.media },
          photoFailed: state.failed, photoLoading: state.loading, photoBlocked: state.blocked,
          photoMessage: state.message, photoCanRetry: state.canRetry, photoSlot: state.hasPhotos, photoRevision: state.revision })
      })
      return this._photoRecovery
    },
    openPost() { if (this.data.story.id) this.triggerEvent('open', { id: this.data.story.id }) },
    reply() { if (this.data.story.id) this.triggerEvent('reply', { id: this.data.story.id }) },
    previewPhoto() {
      if (this._previewFlight) return this._previewFlight
      const recovery = this.photoRecovery(), token = recovery.snapshot().epoch
      const operation = recovery.preview().then(urls => {
        if (!this._photoAttached || this._photoVisible === false || !recovery.current(token) || !urls.length) return false
        // Capture after renewal: a later native callback belongs to this exact image.
        const previewRevision = recovery.snapshot().revision
        return new Promise(resolve => {
          const fail = () => { recovery.previewError(token, previewRevision); resolve(false) }
          try { wx.previewImage({ current: urls[0], urls, success: () => resolve(true), fail }) }
          catch (_) { fail() }
        })
      }).finally(() => { if (this._previewFlight === operation) this._previewFlight = null })
      this._previewFlight = operation
      return operation
    },
    retryPhotos() { return this.photoRecovery().retry() },
    onPhotoError(event) {
      const dataset = event && event.currentTarget && event.currentTarget.dataset || {}
      return this.photoRecovery().imageError({ imageRevision: dataset.revision, src: dataset.src })
    }
  }
})
