// 零依赖矢量图标：内联 SVG data URI，避免 emoji 与汉字方块的跨端渲染差异。
// 图标表在 icons.js 中维护，custom-tab-bar 复用同一套。
const { iconUri } = require('./icons')

Component({
  properties: {
    name: { type: String, value: 'info' },
    // 单位 rpx
    size: { type: Number, value: 40 },
    color: { type: String, value: '#D94F75' },
    // stroke 线宽
    strokeWidth: { type: Number, value: 2 },
    // 实心填充（用于 heart 等）
    filled: { type: Boolean, value: false }
  },
  data: { src: '' },
  observers: {
    'name, size, color, strokeWidth, filled'() { this.render() }
  },
  lifetimes: {
    attached() { this.render() }
  },
  methods: {
    render() {
      this.setData({
        src: iconUri(this.data.name, this.data.color, this.data.strokeWidth, this.data.filled)
      })
    }
  }
})
