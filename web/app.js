(async () => {
  const $ = id => document.getElementById(id)
  let text
  try { text = await (await fetch('/en.json')).json() } catch { return }
  document.querySelectorAll('[data-text]').forEach(el => { el.textContent = text[el.dataset.text] })
  const state = { page: 'videos', channel: null, offset: 0, total: 0, sequence: 0, previousRefresh: {}, duration: 0, unknownDurations: 0, importPreview: null, cookieCandidate: null, cookiePreview: null, manualPreview: null, cookieEpoch: 0 }
  const size = 30
  const localDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
  const today = new Date()
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate()-6)
  $('from').value = localDate(first)
  $('through').value = localDate(today)
  $('from').max = $('through').max = localDate(today)
  const savedTheme = localStorage.getItem('bbyen-theme')
  if (savedTheme === 'dark') document.documentElement.dataset.theme = 'dark'
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('bbyen-theme', next)
  })
  const element = (tag, className, value) => {
    const el = document.createElement(tag)
    if (className) el.className = className
    if (value !== undefined) el.textContent = value
    return el
  }
  const safeImage = url => {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'https:' && /(^|\.)(ytimg\.com|googleusercontent\.com|gstatic\.com)$/.test(parsed.hostname) ? parsed.href : ''
    } catch { return '' }
  }
  const request = async (url, options) => {
    const response = await fetch(url, options)
    if (!response.ok) throw new Error('request failed')
    return response.json()
  }
  const post = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const showNotice = message => { $('notice').textContent = message }
  const updateWatchTime = () => {
    const seconds = Math.round(state.duration / Number($('playback-speed').value))
    const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60)
    $('watch-time').textContent = `${text.watchTime}: ${hours}h ${minutes}m ${seconds % 60}s · ${state.unknownDurations} ${text.unknownDurations}`
  }
  const setLayout = layout => {
    $('results').classList.toggle('video-grid', layout === 'grid')
    $('list-layout').setAttribute('aria-pressed', String(layout === 'list'))
    $('grid-layout').setAttribute('aria-pressed', String(layout === 'grid'))
    localStorage.setItem('bbyen-layout', layout)
  }
  const setPage = page => {
    state.cookieEpoch++
    if (state.cookieCandidate) void post('/api/cookies/cancel', { candidateId: state.cookieCandidate }).catch(() => {})
    state.cookieCandidate = null; state.cookiePreview = null; state.manualPreview = null
    $('cookie-input').value = ''; $('cookie-file').value = ''
    $('cookie-profiles').hidden = true; $('cookie-review').hidden = true; $('manual-review').hidden = true
    state.page = page; state.offset = 0
    $('videos-nav').classList.toggle('active', page === 'videos')
    $('channels-nav').classList.toggle('active', page === 'channels')
    $('activity-nav').classList.toggle('active', page === 'activity')
    $('settings-nav').classList.toggle('active', page === 'settings')
    $('heading').textContent = text[page]
    $('refresh').hidden = page === 'activity' || page === 'settings'
    $('add').hidden = page === 'settings' || page === 'activity'
    $('add').disabled = true; $('add').textContent = text.add
    $('add-panel').hidden = true
    $('email-user').value = ''; $('email-password').value = ''
    $('import-file').value = ''; $('import-review').hidden = true; state.importPreview = null
    showNotice('')
    $('toolbar').hidden = page === 'activity' || page === 'settings'
    $('video-options').hidden = page !== 'videos'
    $('results').classList.toggle('video-grid', page === 'videos' && localStorage.getItem('bbyen-layout') === 'grid')
    $('settings-panel').hidden = page !== 'settings'
    $('list-heading').hidden = page === 'settings'
    $('results').hidden = page === 'settings'
    $('paging').hidden = true
    $('dates').hidden = page !== 'videos'
    $('filter-label').hidden = page !== 'videos' || !state.channel
    $('cookie-stale').hidden = true
    load(); poll()
  }
  const makeLink = (label, href) => {
    const link = element('a', '', label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link
  }
  const displayDate = value => {
    if (!value || !Number.isFinite(Date.parse(value))) return text.unknownDate
    return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }
  const renderConnection = connection => {
    const active = connection.mode === 'cookie'
    $('connection-status').textContent = active ? `${text.connectionCookie}: ${connection.connection?.name || ''}` : connection.mode === 'youtube' ? text.connectionApi : text.connectionManual
    const warnings = []
    if (connection.connection?.stale) warnings.push(text.connectionStale)
    if (connection.cleanupPending) warnings.push(text.cleanupPending)
    if (connection.environmentCookie) warnings.push(text.environmentCookie)
    $('connection-warning').textContent = warnings.join(' ')
    $('cookie-connect').hidden = connection.mode === 'youtube' || connection.cleanupPending
    $('manual-switch').hidden = !active
  }
  const describeChannels = (heading, channels) => `${heading} (${channels.length})\n${channels.map(channel => `  ${channel.title || channel.channelId}${channel.unconfirmed ? ` · ${text.cookieUnconfirmed}` : ''}`).join('\n')}`
  const renderVideo = (video, channels) => {
    const row = element('article', 'result')
    const videoId = /^[a-zA-Z0-9_-]+$/.test(video.videoId) ? video.videoId : ''
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    const thumb = videoId ? makeLink('', watchUrl) : element('div')
    thumb.className = 'thumbnail'
    const imageUrl = safeImage(video.thumbnailUrl)
    if (imageUrl) { const img = element('img'); img.src = imageUrl; img.alt = ''; img.loading = 'lazy'; thumb.append(img) }
    if (videoId) thumb.setAttribute('aria-label', text.openVideo)
    const body = element('div')
    const title = element('h3')
    const label = video.title || text.unknownTitle
    title.append(videoId ? makeLink(label, watchUrl) : document.createTextNode(label))
    const channel = channels.get(video.channelId)
    const meta = element('div', 'meta')
    meta.append(document.createTextNode(`${channel?.channelTitle || text.unknownChannel} · ${displayDate(video.publishedAt)}`))
    if (video.durationSeconds != null) meta.append(document.createTextNode(` · ${Math.floor(video.durationSeconds / 60)}:${String(video.durationSeconds % 60).padStart(2, '0')}`))
    if (text['type_' + video.contentType]) meta.append(document.createTextNode(` · ${text['type_' + video.contentType]}`))
    body.append(title, meta)
    const outcome = element('div', 'outcome', text[video.emailOutcome] || text.unknown)
    if (video.sentAt) outcome.append(element('div', '', displayDate(video.sentAt)))
    row.append(thumb, body, outcome); return row
  }
  const renderChannel = (channel, cookieMode) => {
    const row = element('article', 'channel-row')
    const img = element('img', 'avatar'); img.alt = ''; img.loading = 'lazy'
    const source = safeImage(channel.channelThumbnail); if (source) img.src = source
    img.addEventListener('error', () => { img.hidden = true })
    const info = element('div'); const name = element('button', 'channel-name', channel.channelTitle || channel.channelId)
    name.type = 'button'; name.addEventListener('click', () => {
      state.channel = channel; $('search').value = ''; setPage('videos')
    })
    info.append(name)
    if (channel.deleted) info.append(element('div', 'channel-detail', text.deleted))
    if (cookieMode && channel.deletedReason !== 'unsubscribed' && channel.deletedReason !== 'terminated' && text['bell_' + channel.bellState]) info.append(element('div', 'channel-detail', text['bell_' + channel.bellState]))
    row.append(img, info)
    if (typeof channel.notify === 'boolean' && !channel.deleted) {
      const mute = element('button', 'outline channel-mute', channel.notify ? text.mute : text.unmute)
      mute.type = 'button'; mute.addEventListener('click', async () => {
        mute.disabled = true
        try { await post('/api/channels/notify', { channelId: channel.channelId, notify: !channel.notify }); showNotice(text.saved); load() }
        catch { showNotice(text.settingError) } finally { mute.disabled = false }
      }); row.append(mute)
      const remove = element('button', 'quiet', text.remove)
      remove.type = 'button'; remove.addEventListener('click', async () => {
        if (!window.confirm(text.removeConfirm)) return
        remove.disabled = true
        try { await post('/api/channels/remove', { channelId: channel.channelId }); showNotice(text.removed); load() }
        catch { showNotice(text.removeError) } finally { remove.disabled = false }
      }); row.append(remove)
    }
    if (/^UC[\w-]{22}$/.test(channel.channelId)) {
      const link = makeLink(text.openChannel, `https://www.youtube.com/channel/${channel.channelId}`)
      link.className = 'channel-link'; row.append(link)
    }
    return row
  }
  const load = async () => {
    const sequence = ++state.sequence
    $('results').replaceChildren(element('p', 'empty', text.loading))
    try {
      if (state.page === 'settings') {
        const [data, history, schedule, general, connection] = await Promise.all([request('/api/email/settings'), request('/api/email/tests'), request('/api/schedule'), request('/api/settings'), request('/api/cookies/status')])
        if (sequence !== state.sequence) return
        renderConnection(connection)
        const email = data.settings
        $('smtp-host').value = email.host; $('smtp-port').value = email.port
        $('smtp-secure').checked = email.secure
        $('smtp-sender').value = email.sendingContact
        $('smtp-destination').value = email.destination
        $('schedule-channels').value = schedule.intervals.subscriptions
        $('schedule-videos').value = schedule.intervals.videos
        $('default-backlog').value = general.settings.initialBacklog.mode
        $('default-count-label').hidden = general.settings.initialBacklog.mode !== 'newest'
        $('default-count').disabled = general.settings.initialBacklog.mode !== 'newest'
        $('default-count').value = general.settings.initialBacklog.count || 5
        $('retention-days').value = general.settings.videoRetentionDays ?? ''
        $('failure-email').checked = general.settings.emailOnError
        $('email-user').disabled = data.userFromEnvironment
        $('email-password').disabled = data.passFromEnvironment
        $('user-source').textContent = data.userFromEnvironment ? text.environmentOwned : ''
        $('password-source').textContent = data.passFromEnvironment ? text.environmentOwned : ''
        $('save-credentials').disabled = data.userFromEnvironment && data.passFromEnvironment
        const latest = history.tests[0]
        $('test-email-result').textContent = latest ? `${text.testLast}: ${displayDate(latest.startedAt)} · ${latest.outcome === 'sent' ? text.testSent : text.testUncertain}` : ''
        return
      }
      if (state.page === 'activity') {
        const [data, changes] = await Promise.all([request('/api/incidents'), request('/api/channel-events')])
        if (sequence !== state.sequence) return
        const items = [...data.incidents.map(value => ({ kind: 'incident', date: value.lastObservedAt, value })), ...changes.events.map(value => ({ kind: 'bell', date: value.observedAt, value }))].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 100)
        $('list-label').textContent = `${items.length} ${text.recentActivity}`
        $('paging').hidden = true
        $('results').replaceChildren(...(items.length ? items.map(item => {
          if (item.kind === 'bell') {
            const change = item.value, row = element('article', 'incident-row')
            const title = element('h3', '', change.previousState === null ? text.bellObserved : text.bellActivity)
            const stateName = value => text['bell_' + value] || text.bell_unknown
            const detail = change.previousState === null ? stateName(change.currentState) : `${stateName(change.previousState)} → ${stateName(change.currentState)}`
            row.append(title, element('p', 'meta', `${change.channelTitle || change.channelId} · ${detail} · ${displayDate(change.observedAt)}`))
            return row
          }
          const incident = item.value
          const row = element('article', 'incident-row')
          const title = element('h3', '', text['incident_' + incident.category] || text.incident_other)
          const description = element('p', 'meta', `${text['source_' + incident.source] || text.source_service} · ${displayDate(incident.lastObservedAt)}`)
          const status = element('span', 'incident-state', incident.resolvedAt ? text.resolvedIncident : text.activeIncident)
          row.append(title, description, status)
          if (!incident.resolvedAt) {
            const guidance = incident.source === 'smtp' ? text.help_smtp : incident.source === 'cookie' ? text.help_cookie : text['help_' + incident.category] || text.help_other
            row.append(element('p', 'incident-help', guidance))
          }
          return row
        }) : [element('p', 'empty', text.emptyActivity)]))
        return
      }
      const all = await request('/api/channels')
      if (sequence !== state.sequence) return
      $('add').disabled = !all.manualMode
      $('add').textContent = all.manualMode ? text.add : text.addManualOnly
      if (state.page === 'channels') {
        const term = $('search').value.toLocaleLowerCase()
        const found = all.channels.filter(c => (c.channelTitle || c.channelId).toLocaleLowerCase().includes(term))
        if (sequence !== state.sequence) return
        $('list-label').textContent = `${found.length} ${text.channels}`
        $('cookie-stale').hidden = !all.cookieMode || !all.cookieStale
        $('results').replaceChildren(...(found.length ? found.map(channel => renderChannel(channel, all.cookieMode)) : [element('p', 'empty', text.emptyChannels)]))
        $('paging').hidden = true; return
      }
      const from = $('from').value, through = $('through').value
      if (!from || !through || from > through || through > localDate(new Date())) {
        if (sequence === state.sequence) { $('results').replaceChildren(element('p', 'empty', text.invalidDates)); $('paging').hidden = true }
        return
      }
      const start = new Date(`${from}T00:00:00`)
      const end = new Date(`${through}T00:00:00`); end.setDate(end.getDate()+1)
      const params = new URLSearchParams({ from: start.toISOString(), until: end.toISOString(), limit: String(size), offset: String(state.offset) })
      if (state.channel) params.set('channelId', state.channel.channelId)
      if ($('search').value.trim()) params.set('search', $('search').value.trim())
      if ($('content-type').value) params.set('contentType', $('content-type').value)
      const data = await request(`/api/videos?${params}`)
      if (sequence !== state.sequence) return
      const channels = new Map(all.channels.map(c => [c.channelId, c]))
      state.total = data.total
      state.duration = data.durationSeconds; state.unknownDurations = data.unknownDurationCount; updateWatchTime()
      $('list-label').textContent = `${data.total} ${text.videos}`
      $('results').replaceChildren(...(data.videos.length ? data.videos.map(v => renderVideo(v, channels)) : [element('p', 'empty', text.emptyVideos)]))
      $('paging').hidden = data.total <= size
      $('previous').disabled = state.offset === 0
      $('next').disabled = state.offset + size >= data.total
      $('page-label').textContent = `${state.offset + 1}–${Math.min(state.offset + size, data.total)} / ${data.total}`
      const filter = $('filter-label'); filter.hidden = !state.channel; filter.replaceChildren()
      if (state.channel) {
        filter.append(document.createTextNode(state.channel.channelTitle || state.channel.channelId))
        const clear = element('button', 'quiet', text.showAll); clear.type = 'button'
        clear.addEventListener('click', () => { state.channel = null; state.offset = 0; load() }); filter.append(clear)
      }
    } catch { if (sequence === state.sequence) { if (state.page === 'settings') showNotice(text.loadError); else $('results').replaceChildren(element('p', 'empty', text.loadError)) } }
  }
  $('videos-nav').addEventListener('click', () => setPage('videos'))
  $('channels-nav').addEventListener('click', () => setPage('channels'))
  $('activity-nav').addEventListener('click', () => setPage('activity'))
  $('settings-nav').addEventListener('click', () => setPage('settings'))
  $('list-layout').addEventListener('click', () => setLayout('list'))
  $('grid-layout').addEventListener('click', () => setLayout('grid'))
  $('playback-speed').addEventListener('change', updateWatchTime)
  $('content-type').addEventListener('change', () => { state.offset = 0; load() })
  for (const id of ['search','from','through']) $(id).addEventListener('input', () => { state.offset = 0; load() })
  $('previous').addEventListener('click', () => { state.offset = Math.max(0, state.offset-size); load() })
  $('next').addEventListener('click', () => { state.offset += size; load() })
  $('add').addEventListener('click', () => { $('add-panel').hidden = !$('add-panel').hidden; $('preview').hidden = true; if (!$('add-panel').hidden) $('channel-input').focus() })
  $('resolve-form').addEventListener('submit', async event => {
    event.preventDefault(); $('preview').hidden = true; showNotice(text.loading)
    try { const result = await post('/api/channels/resolve', { input: $('channel-input').value }); $('resolved-id').textContent = result.channelId; $('preview').hidden = false; showNotice('') }
    catch { showNotice(text.resolveError) }
  })
  $('channel-input').addEventListener('input', () => { $('preview').hidden = true })
  $('email-settings-form').addEventListener('submit', async event => {
    event.preventDefault()
    const settings = { host: $('smtp-host').value, port: Number($('smtp-port').value), secure: $('smtp-secure').checked, sendingContact: $('smtp-sender').value, destination: $('smtp-destination').value }
    try { await post('/api/email/settings', { settings }); showNotice(text.emailSaved) }
    catch { showNotice(text.emailSaveError) }
  })
  $('credentials-form').addEventListener('submit', async event => {
    event.preventDefault()
    const credentials = {}
    if (!$('email-user').disabled && $('email-user').value) credentials.user = $('email-user').value
    if (!$('email-password').disabled && $('email-password').value) credentials.pass = $('email-password').value
    try { await post('/api/email/credentials', { credentials }); $('email-user').value = ''; $('email-password').value = ''; showNotice(text.credentialsSaved) }
    catch { showNotice(text.credentialsError) }
  })
  $('schedule-form').addEventListener('submit', async event => {
    event.preventDefault()
    const intervals = { subscriptions: $('schedule-channels').value, videos: $('schedule-videos').value }
    try { const saved = await post('/api/schedule', { intervals }); $('schedule-channels').value = saved.intervals.subscriptions; $('schedule-videos').value = saved.intervals.videos; showNotice(text.scheduleSaved) }
    catch { showNotice(text.scheduleError) }
  })
  $('default-backlog').addEventListener('change', () => { $('default-count-label').hidden = $('default-backlog').value !== 'newest'; $('default-count').disabled = $('default-count-label').hidden })
  $('general-form').addEventListener('submit', async event => {
    event.preventDefault()
    const mode = $('default-backlog').value
    const count = Number($('default-count').value)
    if (mode === 'newest' && (!Number.isSafeInteger(count) || count < 1)) { showNotice(text.invalidCount); return }
    const initialBacklog = mode === 'newest' ? { mode, count } : { mode }
    const videoRetentionDays = $('retention-days').value ? Number($('retention-days').value) : null
    const settings = { initialBacklog, videoRetentionDays, emailOnError: $('failure-email').checked }
    try { await post('/api/settings', { settings }); showNotice(text.generalSaved) }
    catch { showNotice(text.generalError) }
  })
  $('test-email').addEventListener('click', async () => {
    $('test-email').disabled = true; $('test-email-result').textContent = text.testSending
    try { const result = await post('/api/email/test', {}); $('test-email-result').textContent = result.outcome === 'sent' ? text.testSent : text.testUncertain }
    catch { $('test-email-result').textContent = text.testUncertain }
    finally { $('test-email').disabled = false }
  })
  const safeImport = source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('invalid')
    const result = {}
    if ('formatVersion' in source) result.formatVersion = typeof source.formatVersion === 'number' ? source.formatVersion : 0
    const id = value => typeof value === 'string' && /^UC[\w-]{22}$/.test(value) ? value : null
    for (const key of ['whitelistedChannelIds', 'blacklistedChannelIds', 'manualChannelIds', 'savedChannelSettings']) {
      if (!(key in source)) continue
      const list = source[key]
      if (list === null) { result[key] = null; continue }
      if (!Array.isArray(list)) { result[key] = 0; continue }
      result[key] = list.map(item => {
        if (typeof item === 'string') return id(item)
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null
        const entry = { id: id(item.id) }
        for (const flag of ['notify', 'notifyOnFirstScan']) {
          if (flag in item) entry[flag] = typeof item[flag] === 'boolean' ? item[flag] : null
        }
        if ('initialBacklog' in item) {
          const policy = item.initialBacklog
          if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(k => k !== 'mode' && k !== 'count')) entry.initialBacklog = null
          else entry.initialBacklog = { mode: ['all', 'none', 'newest'].includes(policy.mode) ? policy.mode : null, ...('count' in policy ? { count: typeof policy.count === 'number' ? policy.count : null } : {}) }
        }
        return entry
      })
    }
    return result
  }
  const importValue = value => value === null ? text.valueDefault : typeof value === 'boolean' ? (value ? text.valueOn : text.valueOff) : JSON.stringify(value)
  $('import-file').addEventListener('change', () => { $('import-review').hidden = true; state.importPreview = null })
  $('import-preview').addEventListener('click', async () => {
    const file = $('import-file').files[0]
    if (!file || file.size > 2 * 1024 * 1024) { showNotice(text.importChooseFile); return }
    $('import-preview').disabled = true; $('import-review').hidden = true; state.importPreview = null
    try {
      const importData = safeImport(JSON.parse(await file.text()))
      const preview = await post('/api/subscriptions/import/preview', { importData })
      state.importPreview = preview
      $('import-summary').textContent = `${preview.added} ${text.importAdded} · ${preview.existing} ${text.importExisting} · ${preview.conflicts.length} ${text.importConflicts} · ${preview.problems.length} ${text.importInvalid}`
      const details = []
      if (preview.createdLists.length) details.push(`${text.importCreates} ${preview.createdLists.map(key => text['list_' + key] || key).join(', ')}`)
      for (const entry of preview.additions) details.push(`${text.importAddition}: ${text['list_' + entry.list] || entry.list} · ${entry.channelId}`)
      const conflictKeys = new Set(preview.conflicts.map(c => `${c.list}|${c.channelId}|${c.field}`))
      for (const change of preview.changes) {
        const isConflict = conflictKeys.has(`${change.list}|${change.channelId}|${change.field}`)
        details.push(`${isConflict ? text.importConflict : text.importChange}: ${text['list_' + change.list] || change.list} · ${change.channelId} · ${text['field_' + change.field] || change.field}: ${importValue(change.existing)} → ${importValue(change.incoming)}`)
      }
      for (const problem of preview.problems) details.push(`${text.importProblem}: ${text['list_' + problem.list] || problem.list} #${problem.index + 1}`)
      $('import-details').textContent = details.join('\n')
      $('partial-label').hidden = !preview.problems.length; $('accept-partial').checked = false
      $('import-review').hidden = false; showNotice('')
    } catch { showNotice(text.importSummaryError) } finally { $('import-preview').disabled = false }
  })
  $('import-apply').addEventListener('click', async () => {
    const preview = state.importPreview
    if (!preview) return
    if (preview.problems.length && !$('accept-partial').checked) { showNotice(text.importNeedsConsent); return }
    $('import-apply').disabled = true
    try {
      await post('/api/subscriptions/import/apply', { previewId: preview.id, conflictChoice: $('import-choice').value, acceptPartial: $('accept-partial').checked })
      $('import-review').hidden = true; $('import-file').value = ''; state.importPreview = null; showNotice(text.importSuccess)
    } catch { $('import-review').hidden = true; state.importPreview = null; showNotice(text.importApplyError) }
    finally { $('import-apply').disabled = false }
  })
  $('cookie-inspect').addEventListener('click', async () => {
    const button = $('cookie-inspect'); button.disabled = true
    const epoch = ++state.cookieEpoch
    if (state.cookieCandidate) void post('/api/cookies/cancel', { candidateId: state.cookieCandidate }).catch(() => {})
    state.cookieCandidate = null; state.cookiePreview = null
    $('cookie-profiles').hidden = true; $('cookie-review').hidden = true
    try {
      const file = $('cookie-file').files[0]
      if (file && file.size > 256 * 1024) throw new Error('file too large')
      const cookie = file ? await file.text() : $('cookie-input').value
      $('cookie-input').value = ''; $('cookie-file').value = ''
      const result = await post('/api/cookies/inspect', { cookie })
      if (epoch !== state.cookieEpoch || state.page !== 'settings') {
        void post('/api/cookies/cancel', { candidateId: result.candidateId }).catch(() => {}); return
      }
      state.cookieCandidate = result.candidateId
      $('cookie-profile').replaceChildren()
      for (const profile of result.profiles) {
        const option = element('option', '', `${profile.name}${profile.handle ? ` · ${profile.handle}` : ''}`)
        option.value = profile.profileId; option.disabled = !profile.selectable; option.selected = profile.selected && profile.selectable
        $('cookie-profile').append(option)
      }
      $('cookie-profiles').hidden = false; showNotice('')
    } catch { if (epoch === state.cookieEpoch) showNotice(text.cookieError) }
    finally { $('cookie-input').value = ''; $('cookie-file').value = ''; button.disabled = false }
  })
  $('cookie-profile').addEventListener('change', () => { state.cookieEpoch++; state.cookiePreview = null; $('cookie-review').hidden = true })
  $('cookie-compare').addEventListener('click', async () => {
    const candidateId = state.cookieCandidate, profileId = $('cookie-profile').value, epoch = state.cookieEpoch
    if (!candidateId || !profileId) return
    $('cookie-compare').disabled = true; $('cookie-review').hidden = true; state.cookiePreview = null
    try {
      const preview = await post('/api/cookies/compare', { candidateId, profileId })
      if (epoch !== state.cookieEpoch) return
      state.cookiePreview = preview.previewId
      $('cookie-details').textContent = [describeChannels(text.cookieStart, preview.start), describeChannels(text.cookieStop, preview.stop), describeChannels(text.cookieContinue, preview.continuing)].join('\n\n')
      $('cookie-review').hidden = false; showNotice('')
    } catch { if (epoch === state.cookieEpoch) showNotice(text.cookieError) }
    finally { $('cookie-compare').disabled = false }
  })
  $('cookie-activate').addEventListener('click', async () => {
    if (!state.cookieCandidate || !state.cookiePreview) return
    $('cookie-activate').disabled = true
    try {
      await post('/api/cookies/activate', { candidateId: state.cookieCandidate, previewId: state.cookiePreview })
      state.cookieCandidate = null; state.cookiePreview = null; $('cookie-profiles').hidden = true; $('cookie-review').hidden = true
      try { renderConnection(await request('/api/cookies/status')) } catch { showNotice(text.loadError); return }
      showNotice(text.cookieConnected)
    } catch { $('cookie-review').hidden = true; state.cookiePreview = null; showNotice(text.cookieError) }
    finally { $('cookie-activate').disabled = false }
  })
  $('manual-preview').addEventListener('click', async () => {
    const epoch = state.cookieEpoch
    $('manual-preview').disabled = true; $('manual-review').hidden = true
    try {
      const preview = await post('/api/cookies/manual/preview', {})
      if (epoch !== state.cookieEpoch) return
      state.manualPreview = preview.previewId
      $('manual-details').textContent = [text.manualHelp, preview.legacyCookieFile ? text.manualFileDelete : '', text.manualExternal, describeChannels(text.cookieContinue, preview.continuing)].filter(Boolean).join('\n\n')
      $('manual-review').hidden = false; showNotice('')
    } catch { showNotice(text.cookieError) }
    finally { $('manual-preview').disabled = false }
  })
  $('manual-apply').addEventListener('click', async () => {
    if (!state.manualPreview) return
    $('manual-apply').disabled = true
    try {
      const result = await post('/api/cookies/manual/apply', { previewId: state.manualPreview })
      state.manualPreview = null; $('manual-review').hidden = true
      try { renderConnection(await request('/api/cookies/status')) } catch { showNotice(text.loadError); return }
      showNotice(result.cleanupPending ? text.manualPending : text.manualDone)
    } catch { state.manualPreview = null; $('manual-review').hidden = true; showNotice(text.cookieError) }
    finally { $('manual-apply').disabled = false }
  })
  $('backlog').addEventListener('change', () => { $('backlog-count-label').hidden = $('backlog').value !== 'newest' })
  $('confirm-add').addEventListener('click', async () => {
    const body = { channelId: $('resolved-id').textContent }
    const mode = $('backlog').value
    if (mode === 'newest') {
      const count = Number($('backlog-count').value)
      if (!Number.isSafeInteger(count) || count < 1) { showNotice(text.invalidCount); return }
      body.initialBacklog = { mode, count }
    } else if (mode !== 'default') body.initialBacklog = { mode }
    $('confirm-add').disabled = true
    try { await post('/api/channels', body); $('add-panel').hidden = true; $('channel-input').value = ''; showNotice(text.added) }
    catch { showNotice(text.addError) } finally { $('confirm-add').disabled = false }
  })
  $('refresh').addEventListener('click', async () => {
    try { await post('/api/refresh', { kind: state.page === 'videos' ? 'videos' : 'subscriptions' }); showNotice(text.refreshRequested); poll() }
    catch { showNotice(text.refreshError) }
  })
  const poll = async () => {
    if (state.page === 'activity' || state.page === 'settings') { $('refresh-state').textContent = ''; return }
    try {
      const data = await request('/api/refresh')
      if (state.page === 'activity' || state.page === 'settings') return
      const kind = state.page === 'videos' ? 'videos' : 'subscriptions'
      const refresh = data[kind]
      const current = refresh.state
      const outcome = refresh.lastRun?.status === 'interrupted' ? 'interrupted' : refresh.lastRun?.result?.status
      $('refresh-state').textContent = current === 'idle' && outcome ? text['refresh_' + outcome] : (text[current] || '')
      if (state.previousRefresh[kind] && state.previousRefresh[kind] !== 'idle' && current === 'idle') load()
      state.previousRefresh[kind] = current
    } catch { $('refresh-state').textContent = text.refreshUnavailable }
  }
  setLayout(localStorage.getItem('bbyen-layout') === 'grid' ? 'grid' : 'list')
  setPage('videos'); setInterval(poll, 5000)
})()
