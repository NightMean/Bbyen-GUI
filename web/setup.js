(async () => {
  const $ = id => document.getElementById(id)
  try {
    const text = await (await fetch('/en.json')).json()
    document.querySelectorAll('[data-text]').forEach(el => { el.textContent = text[el.dataset.text] })
    const status = await fetch('/api/setup').then(response => {
      if (!response.ok) throw new Error('setup unavailable')
      return response.json()
    })
    $('setup-files').textContent = status.missing.config ? text.setupCreateConfig : text.setupPreserveConfig
    const choices = [['setup-start', ''], ['setup-api', 'connect-api'], ['setup-cookie', 'connect-cookie']]
    const setDisabled = disabled => choices.forEach(([id]) => { $(id).disabled = disabled })
    setDisabled(status.busy)
    choices.forEach(([id, destination]) => $(id).addEventListener('click', async () => {
      setDisabled(true); $('setup-status').textContent = text.setupStarting
      try {
        const response = await fetch('/api/setup/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        if (!response.ok) throw new Error('setup failed')
        window.location.hash = destination
        window.location.reload()
      } catch { $('setup-status').textContent = text.setupFailed; setDisabled(false) }
    }))
  } catch { $('setup-status').textContent = 'Setup is unavailable. Check the service logs.' }
})()
