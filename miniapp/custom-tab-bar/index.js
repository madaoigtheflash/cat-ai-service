// 自定义 tabBar：首页 / 档案 / 中间凸起「识猫」/ 社交 / 我的。
// 中间凸起为非 tab 动作，直接打开识猫页（identify 已不在 tabBar list 中）。
// 图标复用 components/icon/icons.js 的矢量表，避免 PNG 闪烁与 emoji 跨端差异。
const { iconUri } = require('../components/icon/icons')

const COLOR_NORMAL = '#6F5A64'
const COLOR_ACTIVE = '#FF6F91'

const TABS = [
  { key: 'home', text: '聊聊', icon: 'message', path: '/pages/home/index' },
  { key: 'pets', text: '猫咪', icon: 'archive', path: '/pages/pets/index' },
  { key: 'social', text: '社区', icon: 'users', path: '/pages/social/index' },
  { key: 'mine', text: '我的', icon: 'user', path: '/pages/mine/index' }
]

Component({
  data: {
    selected: 0,
    leftTabs: [],
    rightTabs: [],
    identifyIcon: ''
  },
  lifetimes: {
    attached() {
      const tabs = TABS.map((tab, index) => ({
        key: tab.key,
        text: tab.text,
        path: tab.path,
        index,
        icon: iconUri(tab.icon, COLOR_NORMAL),
        activeIcon: iconUri(tab.icon, COLOR_ACTIVE, 2.2)
      }))
      this.setData({
        leftTabs: tabs.slice(0, 2),
        rightTabs: tabs.slice(2),
        identifyIcon: iconUri('camera', '#FFFFFF', 2)
      })
    }
  },
  methods: {
    onTab(event) {
      const index = Number(event.currentTarget.dataset.index)
      const tab = TABS[index]
      if (!tab || this.data.selected === index) return
      wx.switchTab({ url: tab.path })
    },
    onIdentify() {
      wx.navigateTo({ url: '/pages/identify/index' })
    }
  }
})
