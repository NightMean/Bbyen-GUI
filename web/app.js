(async () => {
  const $ = id => document.getElementById(id)
  let text
  try { text = await (await fetch('/en.json')).json() } catch { return }
  document.querySelectorAll('[data-text]').forEach(el => { el.textContent = text[el.dataset.text] })
  const state = { page: 'videos', channel: null, offset: 0, total: 0, sequence: 0, previousRefresh: 'idle' }
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
  const setPage = page => {
    state.page = page; state.offset = 0
    $('videos-nav').classList.toggle('active', page === 'videos')
    $('channels-nav').classList.toggle('active', page === 'channels')
    $('heading').textContent = text[page]
    $('dates').hidden = page !== 'videos'
    $('filter-label').hidden = page !== 'videos' || !state.channel
    load()
  }
  const makeLink = (label, href) => {
    const link = element('a', '', label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link
  }
  const displayDate = value => {
    if (!value || !Number.isFinite(Date.parse(value))) return text.unknownDate
    return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }
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
    body.append(title, meta)
    const outcome = element('div', 'outcome', text[video.emailOutcome] || text.unknown)
    if (video.sentAt) outcome.append(element('div', '', displayDate(video.sentAt)))
    row.append(thumb, body, outcome); return row
  }
  const renderChannel = channel => {
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
    row.append(img, info)
    if (typeof channel.notify === 'boolean' && !channel.deleted) {
      const mute = element('button', 'outline channel-mute', channel.notify ? text.mute : text.unmute)
      mute.type = 'button'; mute.addEventListener('click', async () => {
        mute.disabled = true
        try { await post('/api/channels/notify', { channelId: channel.channelId, notify: !channel.notify }); showNotice(text.saved); load() }
        catch { showNotice(text.settingError) } finally { mute.disabled = false }
      }); row.append(mute)
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
      const all = await request('/api/channels')
      if (state.page === 'channels') {
        const term = $('search').value.toLocaleLowerCase()
        const found = all.channels.filter(c => (c.channelTitle || c.channelId).toLocaleLowerCase().includes(term))
        if (sequence !== state.sequence) return
        $('list-label').textContent = `${found.length} ${text.channels}`
        $('results').replaceChildren(...(found.length ? found.map(renderChannel) : [element('p', 'empty', text.emptyChannels)]))
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
      const data = await request(`/api/videos?${params}`)
      if (sequence !== state.sequence) return
      const channels = new Map(all.channels.map(c => [c.channelId, c]))
      state.total = data.total
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
    } catch { if (sequence === state.sequence) $('results').replaceChildren(element('p', 'empty', text.loadError)) }
  }
  $('videos-nav').addEventListener('click', () => setPage('videos'))
  $('channels-nav').addEventListener('click', () => setPage('channels'))
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
  $('confirm-add').addEventListener('click', async () => {
    $('confirm-add').disabled = true
    try { await post('/api/channels', { channelId: $('resolved-id').textContent }); $('add-panel').hidden = true; $('channel-input').value = ''; showNotice(text.added) }
    catch { showNotice(text.addError) } finally { $('confirm-add').disabled = false }
  })
  $('refresh').addEventListener('click', async () => {
    try { await post('/api/refresh', { kind: state.page === 'videos' ? 'videos' : 'subscriptions' }); showNotice(text.refreshRequested); poll() }
    catch { showNotice(text.refreshError) }
  })
  const poll = async () => {
    try {
      const data = await request('/api/refresh')
      const current = data[state.page === 'videos' ? 'videos' : 'subscriptions'].state
      $('refresh-state').textContent = text[current] || ''
      if (state.previousRefresh !== 'idle' && current === 'idle') load()
      state.previousRefresh = current
    } catch { $('refresh-state').textContent = '' }
  }
  setPage('videos'); poll(); setInterval(poll, 5000)
})()
