const PROFILE_FIELDS = [
  pet => pet && pet.name,
  pet => pet && pet.breed,
  pet => pet && pet.gender && pet.gender !== '未知',
  pet => pet && pet.coatColor,
  pet => pet && (pet.birthday || pet.estimatedAge),
  pet => pet && pet.imagePath
]

const RECORD_TYPES = Object.freeze({
  weights: { title: '记录了体重', fallback: '新的体重记录' },
  vaccines: { title: '更新了疫苗记录', fallback: '新的疫苗记录' },
  deworming: { title: '更新了驱虫记录', fallback: '新的驱虫记录' },
  medical: { title: '添加了就医记录', fallback: '新的就医记录' }
})

function text(value) {
  return String(value == null ? '' : value).trim()
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(text(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function dateKey(value) {
  const timestamp = timestampOf(value)
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function activityTimeLabel(value, nowMs) {
  const timestamp = timestampOf(value)
  if (!timestamp) return '时间未记录'
  const current = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const today = dateKey(current)
  const day = dateKey(timestamp)
  const date = new Date(timestamp)
  const hasClock = typeof value === 'number' || /T|\d{1,2}:\d{2}/.test(text(value))
  const clock = hasClock
    ? ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : ''
  if (day === today) return `今天${clock}`
  const yesterday = dateKey(current - 24 * 60 * 60 * 1000)
  if (day === yesterday) return `昨天${clock}`
  return `${day}${clock}`
}

function recordDetail(item, fallback) {
  return text(item && (item.content || item.name || item.value || item.note || item.title)) || fallback
}

function profileCompletion(pet) {
  const completed = PROFILE_FIELDS.reduce((count, resolve) => count + (resolve(pet) ? 1 : 0), 0)
  return {
    completed,
    total: PROFILE_FIELDS.length,
    percent: Math.round(completed / PROFILE_FIELDS.length * 100)
  }
}

function petRecords(pet) {
  if (!pet) return []
  const records = []
  Object.keys(RECORD_TYPES).forEach(type => {
    const meta = RECORD_TYPES[type]
    ;(Array.isArray(pet[type]) ? pet[type] : []).forEach(item => {
      records.push({
        id: `${type}_${text(item && item.id) || `${text(item && item.date)}_${records.length}`}`,
        kind: type,
        title: meta.title,
        detail: recordDetail(item, meta.fallback),
        time: item && (item.date || item.updatedAt || item.createdAt),
        timestamp: timestampOf(item && (item.date || item.updatedAt || item.createdAt)),
        tone: type === 'medical' ? 'cream' : type === 'weights' ? 'coral' : 'mint'
      })
    })
  })
  return records
}

function relationshipRows(pet, pets, relationships) {
  if (!pet) return []
  const names = new Map((pets || []).map(item => [item.id, item.name || '未命名猫咪']))
  return (relationships || [])
    .filter(item => item && (item.petAId === pet.id || item.petBId === pet.id))
    .map(item => {
      const otherId = item.petAId === pet.id ? item.petBId : item.petAId
      return {
        id: `relationship_${item.id || `${item.petAId}_${item.petBId}`}`,
        kind: 'relationship',
        title: `记录了与${names.get(otherId) || '另一只猫'}的关系`,
        detail: item.directionStatus === 'legacy_direction_pending' ? '方向和双方身份待补充' : '双方身份与相处线索已保存',
        time: item.updatedAt || item.createdAt,
        timestamp: timestampOf(item.updatedAt || item.createdAt),
        tone: 'lilac'
      }
    })
}

function sightingRows(sightings) {
  return (sightings || []).map((item, index) => {
    const status = text(item && (item.state || item.status)).toLowerCase()
    const cat = (item && item.cat) || {}
    const catName = text(cat.displayName || item.catName)
    const area = text((item.coarseLocation && item.coarseLocation.areaText) || item.areaText)
    return {
      id: `sighting_${text(item && (item.sightingId || item.id)) || index}`,
      kind: 'sighting',
      title: catName ? `${catName}有一条小屋目击` : '小屋有一条新目击',
      detail: area || (status === 'pending_review' ? '等待小屋管理员确认' : '已在小屋中可见'),
      time: item.observedTimeBucket || item.observedAt || item.updatedAt || item.createdAt,
      timestamp: timestampOf(item.observedTimeBucket || item.observedAt || item.updatedAt || item.createdAt),
      tone: status === 'pending_review' ? 'cream' : 'mint'
    }
  })
}

function buildRecentActivity(input) {
  const value = input || {}
  const pet = value.pet || null
  const rows = petRecords(pet)
    .concat(relationshipRows(pet, value.pets || [], value.relationships || []))
    .concat(sightingRows(value.sightings || []))

  if (pet && pet.updatedAt) {
    rows.push({
      id: `profile_${pet.id}`,
      kind: 'profile',
      title: `更新了${pet.name || '猫咪'}的档案`,
      detail: '基础资料保存在当前设备',
      time: pet.updatedAt,
      timestamp: timestampOf(pet.updatedAt),
      tone: 'coral'
    })
  }

  return rows
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 4)
    .map(item => Object.assign({}, item, { timeLabel: activityTimeLabel(item.time, value.nowMs) }))
}

function buildStatusCards(input) {
  const value = input || {}
  const pet = value.pet || null
  const completion = profileCompletion(pet)
  const records = petRecords(pet)
  const relationships = pet
    ? (value.relationships || []).filter(item => item && (item.petAId === pet.id || item.petBId === pet.id))
    : []
  const latestRecord = records.sort((left, right) => right.timestamp - left.timestamp)[0]
  const community = value.community || null
  const link = value.link || null
  const syncCurrent = Boolean(link && value.syncFingerprint && link.syncedFingerprint === value.syncFingerprint)
  let syncValue = '未加入'
  let syncDetail = '可在联机页加入邀请制小屋'
  let syncTone = 'neutral'
  if (community && !pet) {
    syncValue = '待选猫咪'
    syncDetail = community.name || '当前小屋'
  } else if (community && pet && !link) {
    syncValue = '待连接'
    syncDetail = community.name || '当前小屋'
    syncTone = 'cream'
  } else if (community && pet && link) {
    syncValue = syncCurrent ? '已同步' : '有更新'
    syncDetail = community.name || '当前小屋'
    syncTone = syncCurrent ? 'mint' : 'cream'
  }

  return [
    {
      id: 'profile',
      label: '档案资料',
      value: `${completion.completed}/${completion.total}`,
      detail: pet ? `基础资料已填写 ${completion.percent}%` : '识别或创建后开始记录',
      tone: 'coral',
      progress: completion.percent,
      progressStyle: `width: ${completion.percent}%;`
    },
    {
      id: 'records',
      label: '照护记录',
      value: `${records.length} 条`,
      detail: latestRecord ? `最近：${activityTimeLabel(latestRecord.time, value.nowMs)}` : '暂无体重、疫苗或就医记录',
      tone: 'mint',
      progress: 0,
      progressStyle: ''
    },
    {
      id: 'relationships',
      label: '猫际关系',
      value: `${relationships.length} 组`,
      detail: pet ? '按双方身份保存相处线索' : '选择猫咪后查看',
      tone: 'lilac',
      progress: 0,
      progressStyle: ''
    },
    {
      id: 'sync',
      label: '小屋连接',
      value: syncValue,
      detail: syncDetail,
      tone: syncTone,
      progress: 0,
      progressStyle: ''
    }
  ]
}

function chooseActivePet(pets, preferredId) {
  const list = Array.isArray(pets) ? pets : []
  return list.find(item => item.id === preferredId) || list[0] || null
}

function buildPetOptions(pets, activePetId) {
  return (pets || []).slice(0, 4).map(item => ({
    id: item.id,
    name: item.name || '未命名猫咪',
    breed: item.breed || '特征待补充',
    imagePath: item.imagePath || '',
    selected: item.id === activePetId
  }))
}

module.exports = {
  activityTimeLabel,
  buildPetOptions,
  buildRecentActivity,
  buildStatusCards,
  chooseActivePet,
  profileCompletion,
  timestampOf
}
