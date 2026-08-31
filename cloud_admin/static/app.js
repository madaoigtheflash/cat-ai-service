'use strict'

const state = {
  snapshot: null,
  currentView: 'overview',
  communityId: '',
  query: '',
  loading: false,
  workflowBusy: false,
  selectedFeedback: new Set()
}

const titles = {
  overview: '云端数据总览',
  houses: '所有猫友小屋',
  cats: '云端猫咪身份',
  relations: '猫际有向关系',
  sightings: '目击与粗粒度分布',
  quality: '数据质量检查',
  feedback: '反馈审计与本地修改'
}

const choiceLabels = {
  bonded: '主动亲近',
  playmate: '发起玩耍',
  housemate: '平静共处',
  needs_space: '需要空间',
  unsure: '暂时看不准'
}

const MAX_RENDERED_ITEMS = 500
const SEARCH_DEBOUNCE_MS = 220

const $ = selector => document.querySelector(selector)
const $$ = selector => Array.from(document.querySelectorAll(selector))

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function shortId(value) {
  const text = String(value || '')
  if (text.length <= 20) return text || '—'
  return `${text.slice(0, 10)}…${text.slice(-7)}`
}

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date)
}

function communityName(id) {
  const item = state.snapshot && state.snapshot.communities.find(row => row.id === id)
  return item ? item.name : '未知小屋'
}

function showToast(message) {
  const toast = $('#toast')
  toast.textContent = message
  toast.hidden = false
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => { toast.hidden = true }, 2600)
}

function setLoading(loading) {
  state.loading = loading
  $('#refreshButton').disabled = loading
  $('#refreshButton span:last-child').textContent = loading ? '读取中…' : '刷新云端'
  if (!state.snapshot) {
    $('#loadingState').hidden = !loading
    $('#appContent').hidden = true
  }
}

function setConnection(type, text) {
  const badge = $('#connectionBadge')
  badge.className = `status-badge ${type ? `is-${type}` : ''}`.trim()
  badge.innerHTML = '<span></span>' + escapeHtml(text)
}

async function loadSnapshot(force = false) {
  if (state.loading) return
  setLoading(true)
  $('#errorBanner').hidden = true
  try {
    const response = await fetch(`/api/snapshot${force ? '?refresh=true' : ''}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.ok !== true || !payload.data) {
      const message = payload.error && payload.error.message
      throw new Error(message || `读取失败（HTTP ${response.status}）`)
    }
    state.snapshot = payload.data
    const availableFeedback = new Set((state.snapshot.feedback || [])
      .filter(item => ['OPEN', 'TRIAGED'].includes(item.status)).map(item => item.id))
    state.selectedFeedback = new Set([...state.selectedFeedback].filter(id => availableFeedback.has(id)))
    $('#loadingState').hidden = true
    $('#appContent').hidden = false
    $('#envLabel').textContent = state.snapshot.envId
    $('#updatedLabel').textContent = `更新于 ${formatTime(state.snapshot.generatedAt)}`
    $('#staleBanner').hidden = !state.snapshot.stale
    if (state.snapshot.warning) $('#staleMessage').textContent = state.snapshot.warning
    setConnection(state.snapshot.stale ? 'stale' : '', state.snapshot.stale ? '缓存可用' : '云端已连接')
    syncCommunityOptions()
    renderCurrentView()
    if (force) showToast('云端数据已刷新')
  } catch (error) {
    $('#errorMessage').textContent = error.message || '未知错误'
    $('#errorBanner').hidden = false
    setConnection('error', '连接失败')
    if (!state.snapshot) {
      $('#loadingState').hidden = true
      $('#appContent').hidden = true
    }
  } finally {
    setLoading(false)
  }
}

function syncCommunityOptions() {
  const select = $('#communityFilter')
  const current = state.communityId
  select.innerHTML = '<option value="">全部小屋</option>' + state.snapshot.communities
    .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.catCount}只猫</option>`)
    .join('')
  if (current && state.snapshot.communities.some(item => item.id === current)) {
    select.value = current
  } else {
    state.communityId = ''
    select.value = ''
  }
}

function filteredData() {
  const snapshot = state.snapshot
  const communityId = state.communityId
  const needle = state.query.trim().toLowerCase()
  const match = item => {
    if (!needle) return true
    return [item.displayName, item.breed, item.id, item.fromCatName, item.toCatName, item.caption]
      .some(value => String(value || '').toLowerCase().includes(needle))
  }
  return {
    communities: snapshot.communities.filter(item => !communityId || item.id === communityId),
    cats: snapshot.cats.filter(item => (!communityId || item.communityId === communityId) && match(item)),
    relationships: snapshot.relationships.filter(item => (!communityId || item.communityId === communityId) && match(item)),
    sightings: snapshot.sightings.filter(item => (!communityId || item.communityId === communityId) && match(item)),
    mapCells: snapshot.mapCells.filter(item => !communityId || item.communityId === communityId),
    issues: snapshot.issues.filter(item => !communityId || item.communityId === communityId),
    feedback: (snapshot.feedback || []).filter(item => {
      if (!needle) return true
      return [item.title, item.content, item.steps, item.category, item.id]
        .some(value => String(value || '').toLowerCase().includes(needle))
    }),
    changeProposals: (snapshot.changeProposals || []).filter(item => {
      if (!needle) return true
      return [item.title, item.summary, item.status, ...(item.affectedAreas || [])]
        .some(value => String(value || '').toLowerCase().includes(needle))
    })
  }
}

function renderCurrentView() {
  if (!state.snapshot) return
  clearInactiveRenderedViews()
  const data = filteredData()
  if (state.currentView === 'overview') {
    renderStats(data)
    renderHouseCards($('#overviewHouses'), data)
  } else if (state.currentView === 'houses') {
    renderHouseCards($('#houseCards'), data)
  } else if (state.currentView === 'cats') {
    renderCats(data)
  } else if (state.currentView === 'relations') {
    renderRelations(data)
  } else if (state.currentView === 'sightings') {
    renderSightings(data)
  } else if (state.currentView === 'quality') {
    renderQuality(data)
  } else if (state.currentView === 'feedback') {
    renderFeedback(data)
  }
}

function clearInactiveRenderedViews() {
  const containersByView = {
    overview: ['#statsGrid', '#recentSightings', '#overviewGraph', '#overviewHouses'],
    houses: ['#houseCards'],
    cats: ['#catsTable'],
    relations: ['#relationGraph', '#relationsTable'],
    sightings: ['#coarseMap', '#mapCellList', '#sightingsTable'],
    quality: ['#qualitySummary', '#issueList'],
    feedback: ['#feedbackTable', '#proposalList']
  }
  Object.entries(containersByView).forEach(([view, selectors]) => {
    if (view === state.currentView) return
    selectors.forEach(selector => { $(selector).replaceChildren() })
  })
}

function renderStats(data) {
  const stats = state.snapshot.stats
  const selected = Boolean(state.communityId)
  const cards = [
    ['⌗', selected ? data.communities.length : stats.activeCommunityCount, '活跃小屋', 'glow-pink'],
    ['🐱', selected ? data.cats.length : stats.catCount, '云端猫咪', 'glow-purple'],
    ['↗', selected ? data.relationships.length : stats.relationshipCount, '关系记录', 'glow-peach'],
    ['◎', selected ? data.sightings.length : stats.sightingCount, '审核目击', 'glow-green'],
    ['◈', stats.activeTemplateCount, '有效模板', 'glow-blue'],
    ['!', data.issues.length, '关联提醒', 'glow-gold']
  ]
  $('#statsGrid').innerHTML = cards.map(([icon, count, label, glowClass]) => `
    <article class="stat-card ${glowClass}">
      <span class="stat-icon">${icon}</span><strong>${Number(count).toLocaleString('zh-CN')}</strong><span>${label}</span>
    </article>`).join('')

  const recent = data.sightings.slice(0, 5)
  $('#recentSightings').innerHTML = recent.length ? recent.map(item => `
    <div class="activity-item">
      <div class="activity-top"><strong>${escapeHtml(item.catName)}</strong><time>${escapeHtml(formatTime(item.reviewedAt || item.submittedAt))}</time></div>
      <p>${escapeHtml(item.caption || (item.coarseLocation ? item.coarseLocation.cellId || '已记录粗略位置' : '无位置说明'))}</p>
    </div>`).join('') : emptyMarkup('尚无审核目击', '通过小屋审核的目击会出现在这里。')

  const graphCommunity = state.communityId || (data.communities[0] && data.communities[0].id) || ''
  const graphCats = state.snapshot.cats.filter(item => item.communityId === graphCommunity)
  const graphRelations = state.snapshot.relationships.filter(item => item.communityId === graphCommunity)
  const graphName = communityName(graphCommunity)
  $('#graphHint').textContent = graphCommunity ? `${graphName} · ${graphCats.length}只猫` : '暂无小屋'
  renderGraph($('#overviewGraph'), graphCats, graphRelations, graphName)
}

function houseCard(item) {
  const roles = Object.entries(item.roleCounts || {})
    .map(([role, count]) => `<span class="tag">${escapeHtml(role)} ${count}</span>`).join('')
  return `
    <a class="house-card" href="#cats" data-community-card="${escapeHtml(item.id)}" aria-label="查看小屋 ${escapeHtml(item.name)} 的云端猫咪">
      <div class="house-card-header">
        <div class="house-icon">🏠</div>
        <div><h3>${escapeHtml(item.name)}</h3><div class="id-text">${escapeHtml(shortId(item.id))}</div></div>
        <span class="state-pill ${item.status === 'active' ? '' : 'muted'}">${escapeHtml(item.status)}</span>
      </div>
      <div class="house-metrics">
        <div><strong>${item.memberCount}</strong><span>成员</span></div>
        <div><strong>${item.catCount}</strong><span>猫咪</span></div>
        <div><strong>${item.relationshipCount}</strong><span>关系</span></div>
        <div><strong>${item.sightingCount}</strong><span>目击</span></div>
      </div>
      <div class="role-row">${roles || '<span class="tag warning">暂无成员角色</span>'}</div>
    </a>`
}

function renderHouseCards(container, data) {
  const visible = data.communities.slice(0, MAX_RENDERED_ITEMS)
  const markup = visible.length
    ? visible.map(houseCard).join('') + renderLimitNotice(data.communities.length, '小屋')
    : emptyMarkup('没有符合条件的小屋', state.communityId ? '清除小屋筛选后查看全部数据。' : '当前云环境尚未创建猫友小屋。')
  container.innerHTML = markup
  container.querySelectorAll('[data-community-card]').forEach(card => card.addEventListener('click', event => {
    event.preventDefault()
    state.communityId = card.dataset.communityCard
    $('#communityFilter').value = state.communityId
    switchView('cats')
  }))
}

function sourceLabel(source) {
  const labels = {
    synced_user_pet: '本地档案同步',
    manual_new_cat: '人工新建身份',
    identity: '规范身份',
    reference_only: '仅被其他数据引用'
  }
  return labels[source] || source || '未知来源'
}

function relationVoteTotal(item) {
  if (Number.isFinite(item.calculatedVoteTotal)) return item.calculatedVoteTotal
  return Number.isFinite(item.totalVotes) ? item.totalVotes : 0
}

function renderCats(data) {
  if (!data.cats.length) {
    $('#catsTable').innerHTML = emptyMarkup('没有找到云端猫咪', '可以切换小屋或清除搜索条件。')
    return
  }
  const visible = data.cats.slice(0, MAX_RENDERED_ITEMS)
  const rows = visible.map(item => {
    const warnings = (item.warnings || []).map(value => `<span class="tag warning">${escapeHtml(value)}</span>`).join('')
    return `<tr>
      <td><div class="cell-title">${escapeHtml(item.displayName)}</div><div class="cell-sub">${escapeHtml(shortId(item.id))}</div></td>
      <td><div>${escapeHtml(communityName(item.communityId))}</div><div class="cell-sub">${escapeHtml(shortId(item.communityId))}</div></td>
      <td><span class="state-pill ${item.state === 'active' ? '' : 'warn'}">${escapeHtml(item.state)}</span><div class="cell-sub">${escapeHtml(sourceLabel(item.source))}</div></td>
      <td>${escapeHtml(item.breed || '未填写')}<div class="cell-sub">${escapeHtml([item.gender, item.coatColor].filter(Boolean).join(' · ') || '暂无外观')}</div></td>
      <td>${item.linkedProfileCount}<div class="cell-sub">云端档案映射</div></td>
      <td>${item.sightingCount}<div class="cell-sub">最近 ${escapeHtml(formatTime(item.lastSeenAt))}</div></td>
      <td>${item.outgoingRelationCount} 出 / ${item.incomingRelationCount} 入<div class="cell-sub">旧版 ${item.legacyRelationCount}</div></td>
      <td>${item.activeTemplateCount}<div class="cell-sub">任务 ${item.identityTaskCount}</div></td>
      <td><div class="tag-list">${warnings || '<span class="tag">关联正常</span>'}</div></td>
    </tr>`
  }).join('')
  $('#catsTable').innerHTML = `${renderLimitNotice(data.cats.length, '猫咪')}<table><thead><tr><th>猫咪</th><th>所属小屋</th><th>身份状态</th><th>外观</th><th>档案映射</th><th>目击</th><th>关系</th><th>识别模板</th><th>检查</th></tr></thead><tbody>${rows}</tbody></table>`
}

function renderRelations(data) {
  const communityId = state.communityId
  const graphTitle = $('#relationGraphTitle')
  if (!communityId) {
    graphTitle.textContent = '请在顶部选择一个小屋'
    $('#relationGraph').innerHTML = emptyMarkup('关系图按小屋隔离', '跨小屋不会建立猫际关系，请先选择一个小屋。')
  } else {
    graphTitle.textContent = `${communityName(communityId)} · ${data.relationships.length} 条关系`
    renderGraph($('#relationGraph'), data.cats, data.relationships, communityName(communityId))
  }
  if (!data.relationships.length) {
    $('#relationsTable').innerHTML = emptyMarkup('尚无关系投票', '没有记录不代表猫咪之间没有关系。')
    return
  }
  const visible = data.relationships.slice(0, MAX_RENDERED_ITEMS)
  const rows = visible.map(item => {
    const countRows = Object.entries(item.voteCounts || {})
    const breakdown = countRows.length ? countRows.map(([choice, count]) => `${choiceLabels[choice] || choice} ${count}`).join(' · ') : '旧版分布不映射'
    const needsReview = item.selfLoop === true || item.valid === false || item.directionState === 'self_loop_needs_review'
    const calculatedTotal = relationVoteTotal(item)
    const storedTotalHint = Number.isFinite(item.totalVotes) && item.totalVotes !== calculatedTotal ? ` · 云端记录 ${item.totalVotes}` : ''
    return `<tr>
      <td><div class="relation-summary"><b>${escapeHtml(item.fromCatName)}</b> ${escapeHtml(item.arrow)} <b>${escapeHtml(item.toCatName)}</b><div class="cell-sub">${escapeHtml(item.fromRole)} → ${escapeHtml(item.toRole)}</div></div></td>
      <td><span class="state-pill ${item.legacy ? 'warn' : ''}">${escapeHtml(item.dominantLabel)}</span></td>
      <td>${calculatedTotal}<div class="cell-sub">${escapeHtml(breakdown + storedTotalHint)}</div></td>
      <td><div class="state-stack"><span class="state-pill ${item.state === 'active' && !needsReview ? '' : 'warn'}">${escapeHtml(item.state)}</span>${needsReview ? '<span class="state-pill warn">合并后自环 / 待处理</span>' : ''}</div></td>
      <td>${escapeHtml(formatTime(item.updatedAt))}</td>
    </tr>`
  }).join('')
  $('#relationsTable').innerHTML = `${renderLimitNotice(data.relationships.length, '关系')}<table><thead><tr><th>双方身份与方向</th><th>主要观察</th><th>投票分布</th><th>状态</th><th>更新时间</th></tr></thead><tbody>${rows}</tbody></table>`
}

function renderGraph(container, cats, relationships, houseName) {
  if (!cats.length) {
    container.innerHTML = emptyMarkup('这个小屋还没有云端猫咪', '同步本地档案或人工确认新猫后会生成节点。')
    return
  }
  const visibleCats = cats.slice(0, 24)
  const visibleIds = new Set(visibleCats.map(item => item.id))
  const visibleRelations = relationships.filter(item => item.valid !== false && item.selfLoop !== true && visibleIds.has(item.fromCatId) && visibleIds.has(item.toCatId))
  const width = 900
  const height = container.classList.contains('large') ? 480 : 340
  const cx = width / 2
  const cy = height / 2
  const rx = Math.min(330, width * .37)
  const ry = Math.min(height * .33, 165)
  const positions = new Map()
  visibleCats.forEach((cat, index) => {
    const angle = -Math.PI / 2 + (index / visibleCats.length) * Math.PI * 2
    positions.set(cat.id, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry })
  })

  const paths = visibleRelations.map((item, index) => {
    const a = positions.get(item.fromCatId)
    const b = positions.get(item.toCatId)
    if (!a || !b) return ''
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.max(Math.hypot(dx, dy), 1)
    const ux = dx / length
    const uy = dy / length
    const startX = a.x + ux * 40
    const startY = a.y + uy * 40
    const endX = b.x - ux * 42
    const endY = b.y - uy * 42
    const opposite = visibleRelations.some(other => other !== item && other.fromCatId === item.toCatId && other.toCatId === item.fromCatId)
    const curve = opposite ? (index % 2 ? -24 : 24) : 0
    const mx = (startX + endX) / 2 - uy * curve
    const my = (startY + endY) / 2 + ux * curve
    const dash = item.legacy ? 'stroke-dasharray="7 6"' : ''
    const marker = item.legacy ? '' : 'marker-end="url(#arrow)"'
    return `<path d="M ${startX.toFixed(1)} ${startY.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}" fill="none" stroke="${item.legacy ? '#9b8992' : '#e7658a'}" stroke-width="${Math.min(2 + relationVoteTotal(item) * .45, 7)}" ${dash} ${marker}/>
      <text x="${mx.toFixed(1)}" y="${(my - 7).toFixed(1)}" text-anchor="middle" font-size="11" fill="#806b75">${escapeHtml(item.dominantLabel)}</text>`
  }).join('')

  let center = ''
  if (!visibleRelations.length) {
    center = `<circle cx="${cx}" cy="${cy}" r="49" fill="#fff0f5" stroke="#ffd0dc"/>
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="15" font-weight="700" fill="#d94f75">${escapeHtml((houseName || '猫友小屋').slice(0, 9))}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="10" fill="#806b75">尚无关系投票</text>`
    visibleCats.forEach(cat => {
      const p = positions.get(cat.id)
      center += `<line x1="${cx}" y1="${cy}" x2="${p.x}" y2="${p.y}" stroke="#eadce5" stroke-dasharray="4 7"/>`
    })
  }

  const nodes = visibleCats.map(cat => {
    const p = positions.get(cat.id)
    const stateColor = cat.state === 'active' ? '#ff6f91' : '#b29aa5'
    const label = cat.displayName.length > 7 ? `${cat.displayName.slice(0, 7)}…` : cat.displayName
    return `<g><circle cx="${p.x}" cy="${p.y}" r="34" fill="#fff" stroke="${stateColor}" stroke-width="2.5"/>
      <circle cx="${p.x}" cy="${p.y - 8}" r="10" fill="#fff0f5"/>
      <text x="${p.x}" y="${p.y - 4}" text-anchor="middle" font-size="13">🐱</text>
      <text x="${p.x}" y="${p.y + 16}" text-anchor="middle" font-size="12" font-weight="700" fill="#3e2d35">${escapeHtml(label)}</text></g>`
  }).join('')
  const truncated = cats.length > visibleCats.length
    ? `<text x="${width - 18}" y="${height - 15}" text-anchor="end" font-size="11" fill="#806b75">图中展示前 ${visibleCats.length}/${cats.length} 只，完整数据见表格</text>`
    : ''
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#e7658a"/></marker></defs>${center}${paths}${nodes}${truncated}</svg>`
}

function renderSightings(data) {
  renderMap(data.mapCells)
  $('#mapCellList').innerHTML = data.mapCells.length ? data.mapCells.slice(0, 8).map(item => `
    <div class="activity-item"><div class="activity-top"><strong>${escapeHtml(item.cellId || '未命名网格')}</strong><time>${item.sightingCount} 条</time></div>
    <p>${escapeHtml(item.catNames.join('、') || '未关联猫咪')} · 精度约 ${item.precisionKm} km · ${escapeHtml(item.latestTimeBucket || '无时间')}</p></div>`).join('')
    : emptyMarkup('暂无可展示位置', '有目击记录也可能没有粗略经纬度。')

  if (!data.sightings.length) {
    $('#sightingsTable').innerHTML = emptyMarkup('尚无审核目击', '当前筛选范围内没有已公开目击。')
    return
  }
  const visible = data.sightings.slice(0, MAX_RENDERED_ITEMS)
  const rows = visible.map(item => `<tr>
    <td><div class="cell-title">${escapeHtml(item.catName)}</div><div class="cell-sub">${escapeHtml(shortId(item.id))}</div></td>
    <td>${escapeHtml(communityName(item.communityId))}</td>
    <td>${escapeHtml(item.observedTimeBucket || '未记录')}</td>
    <td>${item.coarseLocation ? `${escapeHtml(item.coarseLocation.cellId || '粗略网格')}<div class="cell-sub">约 ${item.coarseLocation.precisionKm} km · ${escapeHtml(item.coarseLocation.coordinateSystem)}</div>` : '<span class="cell-sub">无定位</span>'}</td>
    <td>${escapeHtml(item.caption || '—')}</td>
    <td><span class="state-pill ${item.identityTemplateReady ? '' : 'muted'}">${item.identityTemplateReady ? '已入识别库' : '未入识别库'}</span></td>
    <td>${escapeHtml(formatTime(item.reviewedAt))}</td>
  </tr>`).join('')
  $('#sightingsTable').innerHTML = `${renderLimitNotice(data.sightings.length, '目击')}<table><thead><tr><th>猫咪</th><th>小屋</th><th>观察时段</th><th>粗略位置</th><th>说明</th><th>身份模板</th><th>审核时间</th></tr></thead><tbody>${rows}</tbody></table>`
}

function renderMap(cells) {
  const container = $('#coarseMap')
  const located = cells.filter(item => Number.isFinite(item.longitude) && Number.isFinite(item.latitude))
  if (!located.length) {
    container.innerHTML = emptyMarkup('暂无位置热区', '位置为可选信息，未定位目击不会在图中显示。')
    return
  }
  const visible = located.slice(0, MAX_RENDERED_ITEMS)
  const longitudes = visible.map(item => item.longitude)
  const latitudes = visible.map(item => item.latitude)
  const minLng = Math.min(...longitudes)
  const maxLng = Math.max(...longitudes)
  const minLat = Math.min(...latitudes)
  const maxLat = Math.max(...latitudes)
  const lngRange = Math.max(maxLng - minLng, .04)
  const latRange = Math.max(maxLat - minLat, .04)
  const width = 1000
  const height = 560
  const padding = 72
  const points = visible.map(item => {
    const x = padding + ((item.longitude - minLng + (lngRange - (maxLng - minLng)) / 2) / lngRange) * (width - padding * 2)
    const y = height - padding - ((item.latitude - minLat + (latRange - (maxLat - minLat)) / 2) / latRange) * (height - padding * 2)
    const radius = Math.min(20 + Math.sqrt(item.sightingCount) * 8, 48)
    const title = `${communityName(item.communityId)}｜${item.cellId || '未命名网格'}｜${item.sightingCount}条目击`
    return `<g class="map-node"><title>${escapeHtml(title)}</title><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${item.sightingCount}</text></g>`
  }).join('')
  const limitText = located.length > MAX_RENDERED_ITEMS ? `｜地图仅显示前 ${MAX_RENDERED_ITEMS}/${located.length} 个网格` : ''
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="猫咪目击粗粒度分布图">${points}<text class="map-caption" x="24" y="${height - 20}">仅表示粗网格相对分布，不是实时定位${escapeHtml(limitText)}</text></svg>`
}

function renderQuality(data) {
  const truncated = state.snapshot.truncatedCollections || []
  $('#qualitySummary').innerHTML = `
    <div class="quality-card"><strong>${data.issues.length}</strong><span>当前筛选关联提醒</span></div>
    <div class="quality-card"><strong>${truncated.length}</strong><span>达到读取上限的集合</span></div>
    <div class="quality-card"><strong>${state.snapshot.primaryDataReadOnly ? '主体只读' : '未知'}</strong><span>小屋、猫与关系操作模式</span></div>`
  const rows = [...data.issues]
  truncated.forEach(name => rows.unshift({ kind: 'collection_truncated', message: `${name} 已达到读取上限，当前统计可能不完整`, communityId: '', referenceId: name }))
  const visible = rows.slice(0, MAX_RENDERED_ITEMS)
  $('#issueList').innerHTML = rows.length ? renderLimitNotice(rows.length, '数据质量提醒') + visible.map(item => `
    <div class="issue-item"><span class="issue-type">${escapeHtml(item.kind)}</span><p>${escapeHtml(item.message)}</p><span class="issue-ref">${escapeHtml(shortId(item.referenceId || item.communityId))}</span></div>`).join('')
    : emptyMarkup('关联检查通过', '当前读取范围内没有发现断链、旧版方向或票数异常。')
}

const feedbackCategoryLabels = {
  bug: '遇到故障', usability: '不好使用', feature: '功能建议',
  content: '内容问题', privacy: '隐私与安全', other: '其他想法'
}

const workflowStatusLabels = {
  OPEN: '待筛选', TRIAGED: '已筛选', INCLUDED_IN_PROPOSAL: '已纳入报告', CLOSED: '已处理',
  READY_FOR_LOCAL_REVIEW: '等待本机审阅',
  AWAITING_ADMIN_APPROVAL: '等待本机审阅（旧状态）',
  APPROVED_FOR_LOCAL_EXECUTION: '等待本机审阅（旧状态）', REJECTED: '暂不采用',
  EXECUTING: 'Codex 执行中', COMPLETED: '已完成', FAILED: '执行失败'
}

const feasibilityLabels = { high: '高', medium: '中等', low: '低' }

function updateSelectedFeedbackLabel() {
  const count = state.selectedFeedback.size
  $('#selectedFeedbackLabel').textContent = `已选 ${count} 条 · 单次最多 20 条`
  $('#auditFeedbackButton').disabled = state.workflowBusy || count < 1 || count > 20
}

function renderFeedback(data) {
  if (!data.feedback.length) {
    $('#feedbackTable').innerHTML = emptyMarkup('暂无用户反馈', '小程序提交的反馈会出现在这里。')
  } else {
    const visible = data.feedback.slice(0, MAX_RENDERED_ITEMS)
    const rows = visible.map(item => {
      const selectable = ['OPEN', 'TRIAGED'].includes(item.status)
      const checked = state.selectedFeedback.has(item.id)
      const client = item.client || {}
      return `<tr>
        <td><input class="feedback-checkbox" type="checkbox" data-feedback-id="${escapeHtml(item.id)}" ${checked ? 'checked' : ''} ${selectable ? '' : 'disabled'} aria-label="选择反馈 ${escapeHtml(item.title)}"></td>
        <td><div class="cell-title">${escapeHtml(item.title)}</div><div class="cell-sub">${escapeHtml(shortId(item.id))}</div></td>
        <td><span class="tag">${escapeHtml(feedbackCategoryLabels[item.category] || item.category)}</span></td>
        <td><div class="feedback-copy">${escapeHtml(item.content || '—')}</div>${item.steps ? `<div class="cell-sub feedback-steps">复现：${escapeHtml(item.steps)}</div>` : ''}</td>
        <td><span class="state-pill ${selectable ? '' : 'muted'}">${escapeHtml(workflowStatusLabels[item.status] || item.status)}</span></td>
        <td>${escapeHtml(client.version || '—')}<div class="cell-sub">${escapeHtml([client.platform, client.sourcePage].filter(Boolean).join(' · ') || '无客户端信息')}</div></td>
        <td>${escapeHtml(formatTime(item.createdAt))}</td>
      </tr>`
    }).join('')
    $('#feedbackTable').innerHTML = `${renderLimitNotice(data.feedback.length, '反馈')}<table><thead><tr><th>选择</th><th>标题</th><th>分类</th><th>反馈资料</th><th>状态</th><th>客户端</th><th>提交时间</th></tr></thead><tbody>${rows}</tbody></table>`
    $$('.feedback-checkbox').forEach(input => input.addEventListener('change', () => {
      if (input.checked) state.selectedFeedback.add(input.dataset.feedbackId)
      else state.selectedFeedback.delete(input.dataset.feedbackId)
      updateSelectedFeedbackLabel()
    }))
  }
  updateSelectedFeedbackLabel()
  renderProposals(data.changeProposals)
}

function renderProposals(proposals) {
  if (!proposals.length) {
    $('#proposalList').innerHTML = emptyMarkup('还没有可行性报告', '选择一组反馈并启动 Codex 只读审计。')
    return
  }
  $('#proposalList').innerHTML = proposals.map(item => {
    const feasibility = item.feasibility || {}
    const areas = (item.affectedAreas || []).map(value => `<span class="tag">${escapeHtml(value)}</span>`).join('')
    const changes = (item.draftChanges || []).map(value => `<div class="proposal-change"><strong>${escapeHtml(value.area || '修改项')}</strong><p>${escapeHtml(value.proposedChange)}</p><small>${escapeHtml((value.acceptanceCriteria || []).join('；'))}</small></div>`).join('')
    const risks = (item.risks || []).map(value => `<li><strong>${escapeHtml(value.level || '风险')}</strong> ${escapeHtml(value.description)}<span>缓解：${escapeHtml(value.mitigation || '需人工确认')}</span></li>`).join('')
    const executable = ['READY_FOR_LOCAL_REVIEW', 'AWAITING_ADMIN_APPROVAL', 'APPROVED_FOR_LOCAL_EXECUTION'].includes(item.status)
    return `<article class="proposal-report">
      <div class="proposal-report-top"><div><span class="section-kicker">CODEX READ-ONLY REPORT</span><h3>${escapeHtml(item.title)}</h3></div><span class="state-pill ${executable ? '' : item.status === 'REJECTED' || item.status === 'FAILED' ? 'warn' : 'muted'}">${escapeHtml(workflowStatusLabels[item.status] || item.status)}</span></div>
      <p class="proposal-report-summary">${escapeHtml(item.summary)}</p>
      <div class="proposal-score-row"><strong>${Number(feasibility.score || 0)} / 100</strong><span>${escapeHtml(feasibilityLabels[feasibility.level] || '待评估')}可行性</span><p>${escapeHtml(feasibility.reason || '')}</p></div>
      <div class="tag-list proposal-areas">${areas || '<span class="tag warning">影响范围待确认</span>'}</div>
      <div class="proposal-columns"><div><h4>修改稿</h4>${changes || '<p class="panel-copy">没有形成可执行修改稿。</p>'}</div><div><h4>风险与缓解</h4><ul class="risk-list">${risks || '<li>没有列出额外风险，执行前仍需检查差异。</li>'}</ul></div></div>
      <div class="proposal-test"><strong>测试计划</strong><p>${escapeHtml((item.testPlan || []).join('；') || '执行前需补充测试计划')}</p></div>
      ${item.executionSummary ? `<div class="execution-summary"><strong>执行摘要</strong><p>${escapeHtml(item.executionSummary)}</p></div>` : ''}
      <div class="proposal-footer"><span>汇总 ${Number(item.feedbackCount || 0)} 条 · ${escapeHtml(formatTime(item.generatedAt))}</span><button class="primary-button execute-proposal" data-proposal-id="${escapeHtml(item.id)}" data-version="${Number(item.version || 1)}" ${executable && !state.workflowBusy ? '' : 'disabled'}>确认并执行修改</button></div>
    </article>`
  }).join('')
  $$('.execute-proposal').forEach(button => button.addEventListener('click', () => executeProposal(
    button.dataset.proposalId, Number(button.dataset.version)
  )))
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(body || {})
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok !== true) {
    const detail = typeof payload.detail === 'string'
      ? payload.detail
      : payload.error && payload.error.message
    throw new Error(detail || `操作失败（HTTP ${response.status}）`)
  }
  return payload.data
}

async function auditSelectedFeedback() {
  if (state.workflowBusy || !state.selectedFeedback.size) return
  const selected = [...state.selectedFeedback]
  if (!window.confirm(`将 ${selected.length} 条反馈交给本地 Codex 进行只读审计并生成修改建议。继续吗？`)) return
  state.workflowBusy = true
  updateSelectedFeedbackLabel()
  $('#auditFeedbackButton').textContent = 'Codex 审计中…'
  try {
    const result = await postJson('/api/feedback/audit', { feedbackIds: selected })
    state.selectedFeedback.clear()
    showToast(`报告“${result.title}”已生成，请在本机审阅`)
    await loadSnapshot(true)
  } catch (error) {
    showToast(error.message || 'Codex 审计失败')
  } finally {
    state.workflowBusy = false
    $('#auditFeedbackButton').textContent = '用 Codex 只读审计'
    updateSelectedFeedbackLabel()
  }
}

async function executeProposal(proposalId, expectedVersion) {
  if (state.workflowBusy) return
  if (!window.confirm('请确认你已审阅修改稿、影响范围、风险和测试计划。Codex 将获得当前工作区写权限，但不会部署或推送。继续执行吗？')) return
  state.workflowBusy = true
  renderCurrentView()
  try {
    const result = await postJson(`/api/proposals/${encodeURIComponent(proposalId)}/execute`, { expectedVersion })
    showToast(result.summary || 'Codex 已完成本地修改')
    await loadSnapshot(true)
  } catch (error) {
    showToast(error.message || 'Codex 执行失败')
    await loadSnapshot(true)
  } finally {
    state.workflowBusy = false
    renderCurrentView()
  }
}

function emptyMarkup(title, text) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>`
}

function renderLimitNotice(total, label) {
  if (total <= MAX_RENDERED_ITEMS) return ''
  return `<div class="result-limit-note" role="status">为保持页面流畅，仅显示前 ${MAX_RENDERED_ITEMS} 条${escapeHtml(label)}；当前筛选共 ${Number(total).toLocaleString('zh-CN')} 条。</div>`
}

function switchView(view) {
  if (!titles[view]) return
  state.currentView = view
  $('#pageTitle').textContent = titles[view]
  $$('.nav-item').forEach(item => item.classList.toggle('is-active', item.dataset.view === view))
  $$('[data-view-panel]').forEach(item => item.classList.toggle('is-active', item.dataset.viewPanel === view))
  document.body.classList.remove('sidebar-open')
  $('#sidebarBackdrop').hidden = true
  window.location.hash = view
  renderCurrentView()
}

function bindEvents() {
  $$('.nav-item').forEach(item => item.addEventListener('click', () => switchView(item.dataset.view)))
  $('#refreshButton').addEventListener('click', () => loadSnapshot(true))
  $('#retryButton').addEventListener('click', () => loadSnapshot(true))
  $('#communityFilter').addEventListener('change', event => {
    state.communityId = event.target.value
    renderCurrentView()
  })
  $('#searchInput').addEventListener('input', event => {
    const query = event.target.value
    clearTimeout(bindEvents.searchTimer)
    bindEvents.searchTimer = setTimeout(() => {
      state.query = query
      renderCurrentView()
    }, SEARCH_DEBOUNCE_MS)
  })
  $('#menuButton').addEventListener('click', () => {
    document.body.classList.add('sidebar-open')
    $('#sidebarBackdrop').hidden = false
  })
  $('#sidebarBackdrop').addEventListener('click', () => {
    document.body.classList.remove('sidebar-open')
    $('#sidebarBackdrop').hidden = true
  })
  $('#auditFeedbackButton').addEventListener('click', auditSelectedFeedback)
}

bindEvents()
const initialView = window.location.hash.slice(1)
if (titles[initialView]) switchView(initialView)
loadSnapshot(false)
