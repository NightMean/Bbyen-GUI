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
    $('setup-start').disabled = status.busy
    $('setup-start').addEventListener('click', async () => {
      $('setup-start').disabled = true; $('setup-status').textContent = text.setupStarting
      try {
        const response = await fetch('/api/setup/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        if (!response.ok) throw new Error('setup failed')
        window.location.reload()
      } catch { $('setup-status').textContent = text.setupFailed; $('setup-start').disabled = false }
    })
  } catch { $('setup-status').textContent = 'Setup is unavailable. Check the service logs.' }
})()
