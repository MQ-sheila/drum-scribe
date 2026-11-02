(function () {
  const button = document.getElementById('updateButton');
  const dialog = document.getElementById('updateDialog');
  const message = document.getElementById('updateMessage');
  const notes = document.getElementById('updateNotes');
  const progress = document.getElementById('updateProgress');
  const checkButton = document.getElementById('updateCheck');
  const downloadButton = document.getElementById('updateDownload');
  const installButton = document.getElementById('updateInstall');
  let timer = null;

  function show(element, visible) { element.classList.toggle('hidden', !visible); }
  function render(status) {
    const state = status?.state || 'error';
    const available = ['available', 'downloading', 'ready', 'installing'].includes(state);
    button.textContent = state === 'ready' ? '更新已下载' : available ? '发现新版本' : '检查更新';
    button.classList.toggle('has-update', available);
    const version = status?.version ? ` v${status.version}` : '';
    const size = status?.size ? ` · ${(status.size / 1024 / 1024).toFixed(0)} MB` : '';
    message.textContent = `${status?.message || '更新状态未知'}${available ? version + size : ''}`;
    notes.textContent = status?.notes || '';
    show(notes, !!status?.notes && available);
    progress.value = status?.progress || 0;
    show(progress, state === 'downloading' || state === 'ready');
    show(downloadButton, state === 'available' || (state === 'error' && !!status?.version));
    show(installButton, state === 'ready');
    checkButton.disabled = state === 'downloading' || state === 'installing' || state === 'checking';
    if (status?.lastResult && !status.lastResult.ok) {
      message.textContent = status.lastResult.message;
      show(dialog, true);
    }
    if (state === 'downloading' && !timer) {
      timer = setInterval(async () => {
        try { render(await window.pywebview.api.update_status()); }
        catch (error) { message.textContent = `读取更新进度失败：${error}`; }
      }, 700);
    } else if (state !== 'downloading' && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function call(method) {
    try { render(await window.pywebview.api[method]()); }
    catch (error) { message.textContent = `更新操作失败：${error}`; show(dialog, true); }
  }
  button.addEventListener('click', async () => {
    show(dialog, true);
    try {
      const status = await window.pywebview.api.update_status();
      render(status);
      if (status.state === 'idle' || status.state === 'current' || status.state === 'error') call('check_for_updates');
    } catch (error) { message.textContent = `读取更新状态失败：${error}`; }
  });
  document.getElementById('updateClose').addEventListener('click', () => show(dialog, false));
  dialog.addEventListener('click', event => { if (event.target === dialog) show(dialog, false); });
  checkButton.addEventListener('click', () => call('check_for_updates'));
  downloadButton.addEventListener('click', () => call('download_update'));
  installButton.addEventListener('click', () => call('install_update'));
  window.addEventListener('pywebviewready', async () => {
    show(button, true);
    try {
      render(await window.pywebview.api.update_status());
      setTimeout(async () => {
        const status = await window.pywebview.api.update_status();
        if (status.state === 'idle') call('check_for_updates');
      }, 2500);
    } catch (error) {
      message.textContent = `无法启动更新检查：${error}`;
    }
  });
}());
