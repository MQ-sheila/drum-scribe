(() => {
  'use strict';

  const core = window.DrumScopeCore;
  const pdf = window.DrumScopePdf;
  const measureOrder = window.DrumScribeMeasureOrder;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const API_BASE = window.DRUMSCRIBE_API_BASE || 'http://127.0.0.1:8767';

  const video = $('#sourceVideo');
  const preview = $('#previewCanvas');
  const previewContext = preview.getContext('2d', {
    willReadFrequently: true,
  });

  const DEFAULTS = { ...core.DEFAULTS };

  const state = {
    stream: null,
    crop: null,
    cropReference: null,
    cropNormalized: null,
    captureSourceInfo: null,
    dragging: null,
    recording: false,
    timer: null,
    frames: [],
    rows: [],
    rawSequences: [],
    captureMemoryCompacted: false,
    scrollingCapture: false,
    adjacentCapture: false,
    warnings: [],
    previewLoop: null,
    settings: { ...DEFAULTS },
    omrTools: null,
    captureGroups: [],
    captureSession: null,
    capturePath: '',
    persistQueue: Promise.resolve(),
    processing: false,
    captureAttempts: 0,
    horizontalLastSample: null,
    horizontalLastStep: null,
    horizontalAccumulatedShift: 0,
    horizontalLastCaptured: null,
    monitorWindow: null,
    lastMonitorSystems: [],
    omrDownloads: [],
    scoreMetadata: null,
    titleUserEdited: false,
    tempoUserEdited: false,
    sourceKind: null,
    videoObjectUrl: '',
    uploadedVideoName: '',
    videoSeekTimer: null,
    videoDownloadJob: null,
    detectionFallback: false,

  };

  function validMeasureNumber(value) {
    const text = String(value ?? '').trim();
    if (!text || !/^\d{1,4}$/.test(text)) return null;

    const number = Number(text);

    if (!Number.isInteger(number) || number < 1 || number > 9999) {
      return null;
    }

    return number;
  }

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');

    clearTimeout(toast.timer);
    toast.timer = setTimeout(
      () => element.classList.remove('show'),
      3200
    );
  }

  function showView(name) {
    $$('.view').forEach((view) => {
      view.classList.toggle('active', view.id === `${name}View`);
    });

    const order = ['source', 'capture', 'review'];
    const index = order.indexOf(name);

    $$('[data-step-nav]').forEach((button, buttonIndex) => {
      button.disabled = buttonIndex > index;
      button.classList.toggle('active', buttonIndex === index);
      button.classList.toggle('done', buttonIndex < index);
    });

    const stepper = $('.stepper');

    if (stepper) {
      window.scrollTo({
        top: Math.max(0, stepper.offsetTop - 88),
        behavior: 'smooth',
      });
    }
  }


  function hasVideoSource() {
    return (
      (state.sourceKind === 'display' && !!state.stream) ||
      (state.sourceKind === 'file' && !!state.videoObjectUrl)
    );
  }

  function clearVideoSource() {
    cancelAnimationFrame(state.previewLoop);
    clearTimeout(state.videoSeekTimer);
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    try { video.pause(); } catch (_error) {}
    video.srcObject = null;
    if (state.videoObjectUrl?.startsWith('blob:')) URL.revokeObjectURL(state.videoObjectUrl);
    state.videoObjectUrl = '';
    state.uploadedVideoName = '';
    state.sourceKind = null;
    video.removeAttribute('src');
    try { video.load(); } catch (_error) {}
  }

  function waitForVideoEvent(name, timeout = 15000) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener(name, done);
        video.removeEventListener('error', failed);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('无法读取这个视频，建议使用 MP4（H.264）或 WebM 格式'));
      };
      video.addEventListener(name, done, { once: true });
      video.addEventListener('error', failed, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('读取视频超时'));
      }, timeout);
    });
  }

  async function seekVideo(time) {
    const duration = Number(video.duration);
    const maximum = Number.isFinite(duration)
      ? Math.max(0, duration - 0.04)
      : Math.max(0, Number(time) || 0);
    const target = core.clamp(Number(time) || 0, 0, maximum);
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.025) return;
    const pending = waitForVideoEvent('seeked', 20000);
    video.currentTime = target;
    await pending;
  }

  function formatVideoTime(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function updateVideoSeekLabel(value = video.currentTime) {
    const output = $('#videoSeekValue');
    if (!output) return;
    output.textContent = `${formatVideoTime(value)} / ${formatVideoTime(video.duration)}`;
  }

  function updateVideoFramePicker() {
    const picker = $('#videoFramePicker');
    const input = $('#videoSeekInput');
    if (!picker || !input) return;
    const local = state.sourceKind === 'file' && Number.isFinite(video.duration);
    picker.classList.toggle('hidden', !local);
    if (!local) return;
    input.max = String(Math.max(0.1, video.duration - 0.04));
    input.value = String(core.clamp(video.currentTime || 0, 0, Number(input.max)));
    updateVideoSeekLabel(input.value);
  }

  function configureCaptureSourceUi() {
    const local = state.sourceKind === 'file';
    $('#captureTitle').textContent = local ? '自动提取视频画面' : '播放视频，程序自动收集';
    const description = $('#captureDescription');
    if (description) {
      description.textContent = local
        ? '程序会直接扫描视频时间轴、提取谱面画面并在到达结尾后自动整理。'
        : '开始后切回视频播放；程序会保留同一画面的多个候选，播完再回来停止。';
    }
    const recordButton = $('#recordButton');
    recordButton.innerHTML = local
      ? '<span></span>开始自动提取'
      : '<span></span>开始录取';
    $('#stopButton').textContent = local ? '停止提取并整理' : '停止并整理谱面';
    $('#captureHint').textContent = local
      ? `已选择 ${state.uploadedVideoName || '本地视频'}，点击开始后不需要播放视频。`
      : '点开始后，切回视频标签页，从头播放到尾。上滑几行都可以。';
    const notes = $('#captureNotes');
    if (notes) {
      notes.innerHTML = local
        ? '<span><b>1</b>开始提取</span><i></i><span><b>2</b>自动扫描时间轴</span><i></i><span><b>3</b>自动整理谱面</span>'
        : '<span><b>1</b>开始录取</span><i></i><span><b>2</b>切回视频并播放</span><i></i><span><b>3</b>播完回来停止</span>';
    }
  }

  async function activateVideoSource(url, name) {
    clearVideoSource();
    state.videoObjectUrl = url;
    state.uploadedVideoName = name;
    state.sourceKind = 'file';
    try {
      const loaded = waitForVideoEvent('loadedmetadata', 20000);
      video.crossOrigin = 'anonymous';
      video.src = state.videoObjectUrl;
      video.muted = true;
      video.preload = 'auto';
      video.load();
      await loaded;
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error('无法读取视频时长');
      }
      const previewTime = Math.min(
        Math.max(video.duration * 0.06, 0.1),
        Math.min(5, Math.max(0, video.duration - 0.04))
      );
      await seekVideo(previewTime);
      setupPreview();
      toast(`已载入视频：${formatVideoTime(video.duration)}，请选择截图范围`);
    } catch (error) {
      clearVideoSource();
      $('#sourceEmpty')?.classList.remove('hidden');
      $('#framingPanel')?.classList.add('hidden');
      throw error;
    }
  }

  async function importVideo(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const supportedName = /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(file.name);
    if (!String(file.type || '').startsWith('video/') && !supportedName) {
      toast('请选择视频文件');
      event.target.value = '';
      return;
    }
    try {
      await activateVideoSource(URL.createObjectURL(file), file.name);
    } catch (error) {
      toast(error.message || '视频读取失败');
    } finally {
      event.target.value = '';
    }
  }

  async function downloadVideoByUrl() {
    if (state.videoDownloadJob) return;
    const url = $('#videoUrlInput')?.value.trim() || '';
    const button = $('#videoUrlButton');
    const panel = $('#videoDownloadStatus');
    const label = $('#videoDownloadStatusText');
    const progress = $('#videoDownloadProgress');
    const cancel = $('#videoDownloadCancel');
    button.disabled = true;
    panel.classList.remove('hidden');
    label.textContent = '正在解析链接…';
    progress.removeAttribute('value');
    cancel.classList.remove('hidden');
    try {
      const started = await fetch(`${API_BASE}/api/video-download/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const startPayload = await started.json();
      if (!started.ok) throw new Error(startPayload.reason || '无法开始下载');
      const job = startPayload.id;
      state.videoDownloadJob = job;
      while (state.videoDownloadJob === job) {
        const response = await fetch(`${API_BASE}/api/video-download/status?job=${encodeURIComponent(job)}`,
          { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.reason || '无法读取下载状态');
        label.textContent = payload.detail || '正在下载视频';
        if (payload.percent > 0) progress.value = payload.percent;
        if (payload.state === 'done') {
          progress.value = 100;
          state.videoDownloadJob = null;
          cancel.classList.add('hidden');
          await activateVideoSource(`${API_BASE}${payload.fileUrl}`,
            payload.title || payload.filename || '已下载视频');
          label.textContent = '下载完成，已载入视频';
          return;
        }
        if (payload.state === 'error' || payload.state === 'cancelled') {
          throw new Error(payload.detail || '下载没有完成');
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    } catch (error) {
      label.textContent = error.message || '下载失败';
      toast(label.textContent);
    } finally {
      state.videoDownloadJob = null;
      button.disabled = false;
      cancel.classList.add('hidden');
    }
  }

  async function cancelVideoDownload() {
    const job = state.videoDownloadJob;
    if (!job) return;
    $('#videoDownloadStatusText').textContent = '正在取消下载…';
    try {
      await fetch(`${API_BASE}/api/video-download/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job }),
      });
    } catch (_error) {
      // Polling reports the final state or network failure.
    }
  }

  async function chooseVideo() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast('当前浏览器不支持画面共享，请使用最新版 Chrome 或 Edge');
      return;
    }

    try {
      clearVideoSource();

      state.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: {
            ideal: 12,
            max: 15,
          },
        },
        audio: false,
        preferCurrentTab: false,
      });

      state.sourceKind = 'display';
      video.srcObject = state.stream;
      await video.play();

      await new Promise((resolve) => {
        if (video.videoWidth) {
          resolve();
        } else {
          video.addEventListener('loadedmetadata', resolve, {
            once: true,
          });
        }
      });

      state.stream
        .getVideoTracks()[0]
        .addEventListener('ended', () => {
          if (state.recording) stopRecording();
        });

      setupPreview();
    } catch (error) {
      if (error.name !== 'NotAllowedError') {
        toast(`没有取得视频画面：${error.message}`);
      }
    }
  }

  function setupPreview() {
    cancelAnimationFrame(state.previewLoop);
    preview.width = video.videoWidth;
    preview.height = video.videoHeight;

    state.crop = {
      x: 0,
      y: 0,
      width: preview.width,
      height: preview.height,
    };
    updateRegionMeta();

    $('#sourceEmpty')?.classList.add('hidden');
    $('#framingPanel')?.classList.remove('hidden');
    fitPreviewCanvas();
    if (!state.previewResizeObserver && typeof ResizeObserver !== 'undefined') {
      state.previewResizeObserver = new ResizeObserver(fitPreviewCanvas);
      state.previewResizeObserver.observe(preview.parentElement);
    }
    updateVideoFramePicker();
    configureCaptureSourceUi();

    drawPreview();
    setTimeout(autoDetectRegion, 300);
  }

  function fitPreviewCanvas() {
    const shell = preview.parentElement;
    if (!shell || !preview.width || !preview.height ||
        shell.clientWidth < 4 || shell.clientHeight < 4) return;
    const scale = Math.min((shell.clientWidth - 2) / preview.width,
      (shell.clientHeight - 2) / preview.height);
    preview.style.width = `${Math.max(1, Math.floor(preview.width * scale))}px`;
    preview.style.height = `${Math.max(1, Math.floor(preview.height * scale))}px`;
  }

  function drawPreview() {
    if (!hasVideoSource() || !video.videoWidth) return;

    previewContext.drawImage(
      video,
      0,
      0,
      preview.width,
      preview.height
    );

    if (state.crop) {
      const {
        x,
        y,
        width,
        height,
      } = state.crop;

      previewContext.save();
      previewContext.fillStyle = 'rgba(0,0,0,.48)';

      previewContext.fillRect(
        0,
        0,
        preview.width,
        y
      );

      previewContext.fillRect(
        0,
        y + height,
        preview.width,
        preview.height - y - height
      );

      previewContext.fillRect(
        0,
        y,
        x,
        height
      );

      previewContext.fillRect(
        x + width,
        y,
        preview.width - x - width,
        height
      );

      previewContext.strokeStyle = '#caff5a';
      previewContext.lineWidth = Math.max(
        3,
        preview.width / 500
      );

      previewContext.strokeRect(
        x,
        y,
        width,
        height
      );

      previewContext.restore();
    }

    state.previewLoop = requestAnimationFrame(drawPreview);
  }

  function pointerPosition(event) {
    const rect = preview.getBoundingClientRect();

    return {
      x: Math.max(
        0,
        Math.min(
          preview.width,
          (event.clientX - rect.left) *
            preview.width /
            rect.width
        )
      ),

      y: Math.max(
        0,
        Math.min(
          preview.height,
          (event.clientY - rect.top) *
            preview.height /
            rect.height
        )
      ),
    };
  }

  preview.addEventListener('pointerdown', (event) => {
    state.dragging = pointerPosition(event);
    preview.setPointerCapture(event.pointerId);
  });

  preview.addEventListener('pointermove', (event) => {
    if (!state.dragging) return;

    const point = pointerPosition(event);

    state.crop = {
      x: Math.min(point.x, state.dragging.x),
      y: Math.min(point.y, state.dragging.y),
      width: Math.abs(point.x - state.dragging.x),
      height: Math.abs(point.y - state.dragging.y),
    };

    updateRegionMeta();
  });

  preview.addEventListener('pointerup', () => {
    state.dragging = null;
  });

  preview.addEventListener('pointercancel', () => {
    state.dragging = null;
  });

  function rememberNormalizedCrop() {
    if (!state.crop) return;
    const referenceWidth = preview.width || video.videoWidth;
    const referenceHeight = preview.height || video.videoHeight;
    if (!referenceWidth || !referenceHeight) return;
    state.cropReference = { width: referenceWidth, height: referenceHeight };
    state.cropNormalized = {
      x: core.clamp(state.crop.x / referenceWidth, 0, 1),
      y: core.clamp(state.crop.y / referenceHeight, 0, 1),
      width: core.clamp(state.crop.width / referenceWidth, 0, 1),
      height: core.clamp(state.crop.height / referenceHeight, 0, 1),
    };
  }

  function normalizedCaptureBounds(sourceWidth, sourceHeight) {
    const normalized = state.cropNormalized || {
      x: state.crop.x / Math.max(1, state.cropReference?.width || preview.width || sourceWidth),
      y: state.crop.y / Math.max(1, state.cropReference?.height || preview.height || sourceHeight),
      width: state.crop.width / Math.max(1, state.cropReference?.width || preview.width || sourceWidth),
      height: state.crop.height / Math.max(1, state.cropReference?.height || preview.height || sourceHeight),
    };
    const x = core.clamp(Math.round(normalized.x * sourceWidth), 0, sourceWidth - 1);
    const y = core.clamp(Math.round(normalized.y * sourceHeight), 0, sourceHeight - 1);
    const right = core.clamp(Math.round((normalized.x + normalized.width) * sourceWidth), x + 1, sourceWidth);
    const bottom = core.clamp(Math.round((normalized.y + normalized.height) * sourceHeight), y + 1, sourceHeight);
    return { x, y, width: right - x, height: bottom - y };
  }

  function updateRegionMeta() {
    if (!state.crop) return;
    rememberNormalizedCrop();
    $('#regionMeta').textContent =
      Math.round(state.crop.width) + ' × ' +
      Math.round(state.crop.height) + ' 像素';
  }

  function autoDetectRegion() {
    if (!video.videoWidth || !video.videoHeight) return;

    const sampleWidth = Math.min(560, video.videoWidth);
    const sampleHeight = Math.round(
      video.videoHeight *
      sampleWidth /
      video.videoWidth
    );

    const canvas = document.createElement('canvas');
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;

    canvas
      .getContext('2d')
      .drawImage(
        video,
        0,
        0,
        sampleWidth,
        sampleHeight
      );

    const region = core.suggestCaptureRegion(canvas);

    if (!region) {
      toast('当前预览帧未自动定位谱面；请拖动时间轴换一帧，或直接框选完整谱面');
      return;
    }

    const scale = video.videoWidth / sampleWidth;

    state.crop = {
      x: Math.round(region.x * scale),
      y: Math.round(region.y * scale),
      width: Math.round(region.width * scale),
      height: Math.round(region.height * scale),
    };

    updateRegionMeta();
    toast('已自动框出谱面，可以拖动重新调整');
  }

  function selectedMode() {
    return (
      $('#sourceModeInput')?.value ||
      state.settings.mode ||
      'auto'
    );
  }

  function confirmRegion() {
    if (
      !state.crop ||
      state.crop.width < 180 ||
      state.crop.height < 50
    ) {
      toast('截图范围太小，请框住完整谱面');
      return;
    }

    rememberNormalizedCrop();
    state.settings.mode = selectedMode();
    $('#modeInput').value = state.settings.mode;
    state.settings.sourceInk = $('#sourceInkInput')?.value || 'dark';

    cancelAnimationFrame(state.previewLoop);
    configureCaptureSourceUi();
    showView('capture');
  }

  function frameScore(frame) {
    const quality = frame.quality || core.frameQuality(frame.canvas);
    return (quality.score || 0) - (quality.cursorPenalty || 0) * 1.8;
  }

  function retainedFrames() {
    let index = 0;
    state.frames = state.captureGroups.flatMap((group) => group.items).map((frame) => {
      frame.index = index;
      index += 1;
      return frame;
    });
    return state.frames;
  }

  function updateCaptureCount() {
    $('#captureCount').textContent = state.captureAttempts;
    const unit = $('#captureUnit');
    if (unit) unit.textContent = `帧已检查 · ${state.captureGroups.length} 段保留`;
  }

  function canvasToJpeg(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('截图编码失败')),
      'image/jpeg',
      0.96
    ));
  }

  function archiveCanvas(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('原图暂存失败')),
      'image/png'
    ));
  }

  async function decodeArchivedFrame(frameIndex) {
    const frame = state.frames[frameIndex];
    if (!frame) return null;
    if (frame.canvas) return frame.canvas;
    if (!frame.archivedCanvasBlob) return null;
    if (!frame.archiveLoad) {
      frame.archiveLoad = (async () => {
        const bitmap = await createImageBitmap(frame.archivedCanvasBlob);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          frame.canvas = canvas;
          return canvas;
        } finally {
          bitmap.close();
        }
      })().finally(() => { frame.archiveLoad = null; });
    }
    return frame.archiveLoad;
  }

  async function restoreArchivedFrames() {
    for (let index = 0; index < state.frames.length; index += 1) {
      if (!state.frames[index].canvas && !(await decodeArchivedFrame(index))) {
        throw new Error('原始截图暂时无法恢复，请从已保存的录制重新载入');
      }
    }
  }

  function releaseInactiveFrameCanvases() {
    if (!state.captureMemoryCompacted) return;
    const active = new Set(state.rows.map((row) => row.sourceCanvas).filter(Boolean));
    state.rows.forEach((row) => (row.candidates || []).forEach((candidate) => {
      if (candidate.sourceCanvas && !active.has(candidate.sourceCanvas)) {
        candidate.sourceCanvas = null;
      }
      if (candidate !== row.candidates[row.selectedCandidateIndex] &&
          candidate.sourceBounds && Number.isInteger(candidate.sourceFrameIndex) &&
          state.frames[candidate.sourceFrameIndex]?.archivedCanvasBlob) {
        candidate.canvas = null;
        candidate.baseCanvas = null;
        candidate.candidateCanvas = null;
      }
    }));
    state.frames.forEach((frame) => {
      if (frame.canvas && !active.has(frame.canvas)) frame.canvas = null;
    });
  }

  async function compactCaptureMemory() {
    if (!state.captureGroups.length || !state.frames.length) return;
    try {
      // Retain exact pixels in compressed PNG blobs. Only the currently shown
      // candidates keep decoded full-frame canvases in memory.
      for (const frame of state.frames) {
        if (frame.canvas && !frame.archivedCanvasBlob) {
          frame.archivedCanvasBlob = await archiveCanvas(frame.canvas);
        }
      }
      const horizontalStreams = new Set(state.rows.map((row) => row.horizontalSource).filter(Boolean));
      horizontalStreams.forEach((stream) => (stream.frames || []).forEach((frame) => {
        const row = frame.row;
        if (!Number.isInteger(row?.sourceFrameIndex) ||
            !state.frames[row.sourceFrameIndex]?.archivedCanvasBlob) return;
        frame.row = {
          sourceFrameIndex: row.sourceFrameIndex,
          sourceStaffTop: row.sourceStaffTop,
          sourceBounds: row.sourceBounds,
          staffTop: row.staffTop,
          staffSpacing: row.staffSpacing,
          sourceInk: row.sourceInk,
        };
      }));
      state.rawSequences = [];
      state.captureMemoryCompacted = true;
      releaseInactiveFrameCanvases();
    } catch (error) {
      console.warn('capture memory compaction unavailable', error);
    }
  }

  function persistFrame(frame, groupIndex, candidateIndex) {
    if (!state.captureSession) return;
    const session = state.captureSession;
    state.persistQueue = state.persistQueue.then(async () => {
      const blob = await canvasToJpeg(frame.canvas);
      const url = `${API_BASE}/api/capture/frame?session=${encodeURIComponent(session)}&group=${groupIndex}&candidate=${candidateIndex}`;
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      if (!response.ok) throw new Error('截图保存失败');
    }).catch((error) => {
      console.warn(error);
      $('#captureHint').textContent = '录取仍在继续，但本地保存暂时失败；请不要刷新页面。';
    });
  }

  async function beginCaptureSession() {
    state.captureSession = null;
    state.capturePath = '';
    try {
      const response = await fetch(`${API_BASE}/api/capture/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: $('#titleInput')?.value || '鼓谱',
          mode: state.settings.mode }),
      });
      const payload = await response.json();
      if (response.ok && payload.sessionId) {
        state.captureSession = payload.sessionId;
        state.capturePath = payload.path || '';
      }
    } catch (error) {
      console.warn('capture persistence unavailable', error);
    }
  }

  function retainCapturedFrame(canvas, timestamp, options = {}) {
    const frame = {
      canvas,
      timestamp,
      quality: core.frameQuality(canvas),
      signature: core.structuralSignature(canvas, { width: 192, height: 108, maxWidth: 560 }),
    };
    let group = state.captureGroups[state.captureGroups.length - 1];
    const horizontal = state.settings.mode === 'horizontal';
    let changed = !group || core.signatureDistance(group.signature, frame.signature) > 0.012;
    if (horizontal) {
      const systems = state.lastMonitorSystems || [];
      const system = systems.reduce((best, item) =>
        !best || item.score > best.score ? item : best, null);
      const sample = system && core.horizontalCaptureSample(canvas,
        system.lines[0], system.spacing,
        { lightOverlay: state.settings.sourceInk === 'light-overlay' });
      const match = sample && state.horizontalLastSample
        ? core.matchHorizontalScroll(state.horizontalLastSample, sample,
          state.horizontalLastStep,
          { lightOverlay: state.settings.sourceInk === 'light-overlay' }) : null;
      if (match) {
        state.horizontalAccumulatedShift += match.shift;
        state.horizontalLastStep = match.shift;
      } else if (sample && state.horizontalLastSample) {
        state.horizontalLastStep = null;
      }
      if (sample) state.horizontalLastSample = sample;
      const elapsed = group ? timestamp - group.items[0].timestamp : Infinity;
      changed = !group || options.force === true ||
        state.horizontalAccumulatedShift >= canvas.width * 0.34 ||
        elapsed >= 1200 ||
        (state.settings.sourceInk !== 'light-overlay' &&
          core.signatureDistance(group.signature, frame.signature) > 0.08);
    }
    if (changed) {
      const maximumGroups = horizontal ? 360 : 180;
      if (state.captureGroups.length >= maximumGroups) {
        toast(`已保存 ${maximumGroups} 段画面，正在自动停止并整理`);
        return false;
      }
      group = { index: state.captureGroups.length, signature: frame.signature, items: [frame], stable: true };
      state.captureGroups.push(group);
      persistFrame(frame, group.index, 0);
      if (horizontal) state.horizontalAccumulatedShift = 0;
    } else if (!horizontal && group.items.length < 2) {
      group.items.push(frame);
      persistFrame(frame, group.index, group.items.length - 1);
    } else if (!horizontal) {
      let worstIndex = frameScore(group.items[0]) <= frameScore(group.items[1]) ? 0 : 1;
      if (frameScore(frame) > frameScore(group.items[worstIndex]) + 0.01) {
        group.items[worstIndex] = frame;
        persistFrame(frame, group.index, worstIndex);
      }
    }
    if (horizontal) state.horizontalLastCaptured = changed ? null : { canvas, timestamp };
    retainedFrames();
    updateCaptureCount();
    return true;
  }

  async function checkSavedCapture() {
    const bar = $('#savedCaptureBar');
    if (!bar) return;
    try {
      const response = await fetch(`${API_BASE}/api/capture/latest`, { cache: 'no-store' });
      const payload = await response.json();
      if (!payload.files?.length) return;
      bar.classList.remove('hidden');
      $('#savedCaptureText').textContent = `找到上次录制：${payload.files.length} 张已保存画面`;
      $('#savedCapturePath').textContent = payload.path || '';
    } catch (_error) {
      bar.classList.add('hidden');
    }
  }

  async function restoreSavedCapture() {
    const button = $('#restoreCaptureButton');
    button.disabled = true;
    try {
      const response = await fetch(`${API_BASE}/api/capture/latest`, { cache: 'no-store' });
      const payload = await response.json();
      if (!payload.files?.length) throw new Error('没有找到可恢复的录制');
      if (payload.mode) state.settings.mode = payload.mode;
      if (payload.sourceInk) state.settings.sourceInk = payload.sourceInk;
      writeSettingsToControls();
      state.captureGroups = [];
      state.frames = [];
      state.captureMemoryCompacted = false;
      state.captureSession = payload.sessionId;
      state.capturePath = payload.path || '';
      showView('review');
      $('#processingPanel').classList.remove('hidden');
      $('#reviewPanel').classList.add('hidden');
      for (let fileIndex = 0; fileIndex < payload.files.length; fileIndex += 1) {
        const file = payload.files[fileIndex];
        const match = file.name.match(/group-(\d+)-candidate-(\d+)\.jpg/);
        if (!match) continue;
        const groupIndex = Number(match[1]);
        const blob = await fetch(`${API_BASE}${file.url}`, { cache: 'no-store' }).then((item) => item.blob());
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        if (!state.captureGroups[groupIndex]) state.captureGroups[groupIndex] = { index: groupIndex, items: [], stable: true };
        state.captureGroups[groupIndex].items.push({ canvas, timestamp: groupIndex * 1000 + Number(match[2]) * 100, quality: core.frameQuality(canvas) });
        $('#reviewSummary').textContent = `正在恢复 ${fileIndex + 1} / ${payload.files.length}`;
        if (fileIndex % 3 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      state.captureGroups = state.captureGroups.filter(Boolean);
      const frames = retainedFrames();
      await processFrames(frames, state.captureGroups);
      toast(`已恢复上次录制，原图保存在 ${state.capturePath}`);
    } catch (error) {
      toast(error.message || '恢复录制失败');
      showView('source');
    } finally {
      button.disabled = false;
    }
  }

  function monitorDocumentHtml() {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DrumScribe · 实时截图</title><style>
      *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#111;color:#f4f7ee;font-family:"Microsoft YaHei","Segoe UI",sans-serif}
      body{display:grid;grid-template-rows:auto 1fr auto;padding:14px;gap:10px}
      header{display:flex;align-items:center;justify-content:space-between;gap:10px}strong{font-size:15px}small{color:#8f9988}
      .screen{min-height:0;display:grid;place-items:center;overflow:hidden;border:1px solid #343a31;border-radius:12px;background:#080808}
      canvas{display:block;width:auto;height:auto;max-width:100%;max-height:100%}
      #monitorStatus{padding:9px 12px;border-radius:10px;background:rgba(202,255,90,.1);color:#caff5a;font-size:13px}
      #monitorStatus.bad{background:rgba(255,177,72,.12);color:#ffbd58}
    </style></head><body><header><strong>实时截图监看</strong><small id="monitorCounter">等待第一帧</small></header>
      <div class="screen"><canvas id="monitorCanvas"></canvas></div>
      <div id="monitorStatus">开始后这里显示真正保存的截图</div></body></html>`;
  }

  function openCaptureMonitor() {
    $('#captureMonitor')?.classList.remove('hidden');
    try {
      if (state.monitorWindow && !state.monitorWindow.closed) state.monitorWindow.close();
      const monitor = window.open('', 'drumscope_capture_monitor', 'popup=yes,width=620,height=420,resizable=yes');
      if (!monitor) {
        state.monitorWindow = null;
        toast('浏览器阻止了小监看窗，已在主界面显示实时截图');
        return;
      }
      monitor.document.open();
      monitor.document.write(monitorDocumentHtml());
      monitor.document.close();
      state.monitorWindow = monitor;
    } catch (error) {
      state.monitorWindow = null;
      console.warn('capture monitor unavailable', error);
    }
  }

  function paintMonitorCanvas(target, source) {
    if (!target || !source) return;
    const scale = Math.min(1, 1100 / source.width);
    target.width = Math.max(1, Math.round(source.width * scale));
    target.height = Math.max(1, Math.round(source.height * scale));
    target.getContext('2d').drawImage(source, 0, 0, target.width, target.height);
  }

  function updateCaptureMonitor(canvas) {
    paintMonitorCanvas($('#captureMonitorCanvas'), canvas);
    let systems = state.lastMonitorSystems || [];
    if (state.captureAttempts === 1 || state.captureAttempts % 5 === 0) {
      const previous = systems[0];
      systems = core.detectStaffSystems(canvas, state.settings) || [];
      if (state.settings.mode === 'horizontal') {
        let best = systems.reduce((current, item) =>
          !current || item.score > current.score ? item : current, null);
        if (previous && core.horizontalStaffEvidence(canvas,
          previous.lines[0], previous.spacing) &&
          (!best || best.score < 0.5 ||
            Math.abs(best.lines[0] - previous.lines[0]) > 0.5 ||
            Math.abs(best.spacing - previous.spacing) > 0.5)) {
          best = previous;
        }
        systems = best ? [best] : [];
      }
      state.lastMonitorSystems = systems;
    }
    const bad = systems.length === 0;
    const sizeText = '实际截图 ' + canvas.width + ' × ' + canvas.height;
    const changed = state.captureSourceInfo?.referenceChanged ? ' · 已按当前窗口分辨率自动换算' : '';
    const message = bad
      ? '当前帧未检测到五线谱：请检查截图范围 · ' + sizeText
      : '截图正常：检测到 ' + systems.length + ' 行谱面 · ' + sizeText + changed;
    const inlineStatus = $('#captureMonitorStatus');
    if (inlineStatus) {
      inlineStatus.textContent = message;
      inlineStatus.classList.toggle('bad', bad);
    }
    if (state.monitorWindow && !state.monitorWindow.closed) {
      try {
        paintMonitorCanvas(state.monitorWindow.document.getElementById('monitorCanvas'), canvas);
        const status = state.monitorWindow.document.getElementById('monitorStatus');
        const counter = state.monitorWindow.document.getElementById('monitorCounter');
        if (status) {
          status.textContent = message;
          status.classList.toggle('bad', bad);
        }
        if (counter) counter.textContent = `已检查 ${state.captureAttempts} 帧 · 保留 ${state.captureGroups.length} 段`;
      } catch (error) {
        console.warn('capture monitor update failed', error);
      }
    }
  }

  function closeCaptureMonitor() {
    $('#captureMonitor')?.classList.add('hidden');
    if (state.monitorWindow && !state.monitorWindow.closed) {
      try { state.monitorWindow.close(); } catch (_error) {}
    }
    state.monitorWindow = null;
  }

  async function extractUploadedVideoFrames() {
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('无法读取视频时长');
    }
    const sampleInterval = Math.max(0.16, duration / 3000);
    const lastTime = Math.max(0, duration - 0.04);
    const total = Math.max(1, Math.floor(lastTime / sampleInterval) + 1);
    for (let index = 0; index < total && state.recording; index += 1) {
      const time = index === total - 1
        ? lastTime
        : Math.min(lastTime, index * sampleInterval);
      await seekVideo(time);
      if (!state.recording) break;
      const retained = captureFrame(time * 1000, { force: index === total - 1 });
      $('#captureHint').textContent =
        `正在提取 ${formatVideoTime(time)} / ${formatVideoTime(duration)}` +
        ` · 已保留 ${state.captureGroups.length} 段`;
      if (retained === false || !state.recording) break;
      if (index % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (state.recording) await stopRecording();
  }

  async function startRecording() {
    state.frames = [];
    state.captureGroups = [];
    state.captureMemoryCompacted = false;
    state.persistQueue = Promise.resolve();
    state.captureAttempts = 0;
    state.horizontalLastSample = null;
    state.horizontalLastStep = null;
    state.horizontalAccumulatedShift = 0;
    state.horizontalLastCaptured = null;
    state.lastMonitorSystems = [];
    if (state.sourceKind === 'file') {
      $('#captureMonitor')?.classList.remove('hidden');
    } else {
      openCaptureMonitor();
    }
    state.recording = true;
    await beginCaptureSession();

    $('#captureView').classList.add('recording');
    $('#captureState span').textContent = state.sourceKind === 'file'
      ? '正在自动提取并保存'
      : '正在录取并保存';
    $('#captureHint').textContent = state.sourceKind === 'file'
      ? '正在扫描视频时间轴，不需要播放视频或保持窗口在前台。'
      : state.capturePath
        ? `可以切到视频播放；画面实时保存在 ${state.capturePath}`
        : '可以切到视频播放。程序会边录边筛选相同画面。';
    $('#recordButton').classList.add('hidden');
    $('#stopButton').classList.remove('hidden');

    if (state.sourceKind === 'file') {
      toast('开始自动提取视频画面');
      try {
        await extractUploadedVideoFrames();
      } catch (error) {
        toast(error.message || '视频画面提取失败');
        if (state.recording) await stopRecording();
      }
      return;
    }

    captureFrame();
    // About eight checks per second gives scrolling scores enough overlap while
    // the stable-frame filter still avoids retaining every video frame.
    state.timer = setInterval(captureFrame, 120);
    toast('录取已开始，可以把 DrumScribe 放到后台');
  }

  function captureFrame(timestamp = performance.now(), options = {}) {
    if (!state.recording || !state.crop || video.readyState < 2) return;
    state.captureAttempts += 1;
    updateCaptureCount();
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const bounds = normalizedCaptureBounds(sourceWidth, sourceHeight);
    const { x, y, width, height } = bounds;
    state.captureSourceInfo = {
      width: sourceWidth,
      height: sourceHeight,
      referenceChanged:
        !!state.cropReference &&
        (state.cropReference.width !== sourceWidth || state.cropReference.height !== sourceHeight),
    };
    const scale = Math.min(1, 1600 / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
    const scoreCanvas = state.settings.sourceInk === 'light-overlay'
      ? core.normalizeLightNotation(canvas) : canvas;
    updateCaptureMonitor(scoreCanvas);
    const retained = retainCapturedFrame(
      scoreCanvas,
      Number.isFinite(Number(timestamp)) ? Number(timestamp) : performance.now(),
      options
    );
    if (retained === false) {
      void stopRecording();
      return false;
    }
    return true;
  }

  async function stopRecording() {
    if (!state.recording || state.processing) return;
    if (state.settings.mode === 'horizontal' && state.horizontalLastCaptured) {
      const last = state.horizontalLastCaptured;
      retainCapturedFrame(last.canvas, last.timestamp, { force: true });
    }
    state.horizontalLastCaptured = null;
    state.recording = false;
    state.processing = true;
    clearInterval(state.timer);
    closeCaptureMonitor();
    $('#captureView').classList.remove('recording');
    $('#captureState span').textContent = '正在保存并整理';
    if (state.sourceKind === 'file') video.pause();
    state.stream?.getTracks().forEach((track) => track.stop());
    await state.persistQueue;
    const frames = retainedFrames();
    showView('review');
    try {
      await processFrames(frames, state.captureGroups);
    } finally {
      state.processing = false;
      checkSavedCapture();
    }
  }

  async function importFolder(event) {
    const ignoredImageName = (name) =>
      /(?:^|[-_ ])(?:debug|contact[-_ ]?sheet|preview|page[-_ ]?preview)(?:[-_ .]|$)/i.test(name);
    const files = [...event.target.files]
      .filter(
        (file) =>
          !ignoredImageName(file.name) &&
          (
            file.type === 'image/png' ||
            file.type === 'image/jpeg' ||
            file.name.toLowerCase().endsWith('.png') ||
            file.name.toLowerCase().endsWith('.jpg') ||
            file.name.toLowerCase().endsWith('.jpeg')
          )
      )
      .sort((left, right) =>
        left.name.localeCompare(
          right.name,
          undefined,
          { numeric: true }
        )
      );

    if (!files.length) return;

    state.settings.mode = selectedMode();
    $('#modeInput').value = state.settings.mode;
    state.settings.sourceInk = $('#sourceInkInput')?.value || 'dark';
    showView('review');

    const canvases = [];

    for (const file of files) {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');

      canvas.width = bitmap.width;
      canvas.height = bitmap.height;

      canvas
        .getContext('2d')
        .drawImage(bitmap, 0, 0);

      bitmap.close();

      canvases.push({
        canvas,
        timestamp: canvases.length * 140,
        name: file.name,
      });
    }

    await processFrames(canvases);
  }

  function candidateFromRow(
    row,
    sourceFrameIndex,
    sequenceRowIndex
  ) {
    const measure = validMeasureNumber(
      row?.measure?.value ??
      row?.measure?.number ??
      row?.measureNumber
    );

    return {
      ...row,
      detectedMeasure: row?.measure || null,
      detectedMeasureNumber: measure,
      measure: null,
      measureNumber: null,
      measureSource: null,
      sourceFrameIndex,
      sequenceRowIndex,
      signature: core.structuralSignature(row.canvas),
      candidates: [],
    };
  }

  function buildSequence(group, modeOverride = state.settings.mode) {
    const slots = [];
    group.items.forEach((item) => {
      const detected = modeOverride === 'single' && state.settings.mode === 'horizontal'
        ? core.extractHorizontalCaptureRow(item.canvas, state.settings,
          state.rawSequences[state.rawSequences.length - 1]?.rows?.[0])
        : core.extractStaffRows(item.canvas, {
          ...state.settings,
          mode: modeOverride,
          removeColorArtifacts: state.settings.removeColorArtifacts,
        });
      const usedSlots = new Set();
      detected.forEach((row, rowIndex) => {
        const candidate = candidateFromRow(row, item.index, rowIndex);
        candidate.frameQuality = item.quality || core.frameQuality(item.canvas);
        candidate.quality = row.quality || core.frameQuality(row.canvas);
        const sourceCenter = Number.isFinite(row.system?.center)
          ? row.system.center
          : ((row.sourceBounds?.top || 0) + (row.sourceBounds?.bottom || 0)) / 2;
        const center = sourceCenter / Math.max(1, item.canvas.height);
        let selected = -1;
        let selectedScore = Infinity;
        slots.forEach((slot, slotIndex) => {
          if (usedSlots.has(slotIndex)) return;
          const delta = Math.abs(slot.center - center);
          if (delta > 0.055) return;
          const visual = slot.candidates.length
            ? core.rowMatchDistance(slot.candidates[0], candidate)
            : 1;
          if (visual > 0.36 && delta > 0.018) return;
          const score = delta * 4 + Math.min(visual, 0.5) * 0.12;
          if (score < selectedScore) {
            selected = slotIndex;
            selectedScore = score;
          }
        });
        if (selected < 0) {
          slots.push({ center, candidates: [candidate] });
          usedSlots.add(slots.length - 1);
        } else {
          const slot = slots[selected];
          slot.candidates.push(candidate);
          slot.center = (slot.center * (slot.candidates.length - 1) + center) / slot.candidates.length;
          usedSlots.add(selected);
        }
      });
    });
    const rows = slots
      .sort((left, right) => left.center - right.center)
      .map((slot, rowIndex) => {
        const candidates = slot.candidates;
        const best = core.chooseBestCandidate(candidates) || candidates[0];
        const alternatives = candidates.filter((candidate) => candidate !== best);
        return {
          ...best,
          sequenceIndex: group.index,
          sequenceRowIndex: rowIndex,
          baseCanvas: best.baseCanvas || best.canvas,
          candidates: [best, ...alternatives],
        };
      })
      .filter(Boolean);
    return {
      rows,
      groupIndex: group.index,
      stable: group.stable,
    };
  }

  function normalizeRows(rows, options = {}) {
    return rows.map((row, index) => {
      const measure = validMeasureNumber(row?.measureNumber);
      const reviewState = core.normalizeReviewState(row, {
        singleCapture: options.singleCapture === true,
        minCompleteness: state.settings.minCompleteness,
      });

      const normalized = {
        ...row,

        id:
          row.id ||
          `row-${index}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,

        index,

        included: reviewState.included,
        status: reviewState.status,
        completeness: reviewState.completeness,

        measureNumber: measure,
        baseCanvas: row.baseCanvas || row.canvas,
        selectedCandidateIndex: core.selectedCandidateIndex(
          row,
          row.candidates?.length ? row.candidates : [row]
        ),
      };

      if (normalized.horizontalSource) {
        const formatted = core.renderHorizontalRange(normalized.horizontalSource,
          normalized.horizontalStart, normalized.horizontalEnd);
        normalized.baseCanvas = formatted;
        normalized.candidates = [{ ...(normalized.candidates?.[0] || {}),
          canvas: formatted, baseCanvas: formatted },
          ...(normalized.candidates || []).slice(1)];
        normalized.selectedCandidateIndex = 0;
      }

      refreshRowCanvas(normalized);
      return normalized;
    });
  }

  const BASE_CROP_TOP = 2;
  const BASE_CROP_BOTTOM = 6;

  function rowTopCropPercent(bounds) {
    // The first staff can start at the very top of the original video frame.
    // Keep every available pixel there, including tempo and style annotations.
    const base = bounds && Number(bounds.top) <= 1 ? 0 : BASE_CROP_TOP;
    return base + state.settings.cropTop;
  }

  function cropCanvasNormalized(source, crop) {
    if (!source || !crop) return { canvas: source, left: 0, top: 0 };
    const left = Math.max(0, Math.min(source.width - 1, Math.round((Number(crop.x) || 0) * source.width)));
    const top = Math.max(0, Math.min(source.height - 1, Math.round((Number(crop.y) || 0) * source.height)));
    const right = Math.max(left + 1, Math.min(source.width, Math.round(((Number(crop.x) || 0) + (Number(crop.width) || 1)) * source.width)));
    const bottom = Math.max(top + 1, Math.min(source.height, Math.round(((Number(crop.y) || 0) + (Number(crop.height) || 1)) * source.height)));
    const canvas = document.createElement('canvas');
    canvas.width = right - left;
    canvas.height = bottom - top;
    canvas.getContext('2d').drawImage(source, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return { canvas, left, top };
  }

  function refreshRowCanvas(row, useDisplayBounds = false) {
    const hasOriginalFrame = !!(row.sourceCanvas && row.sourceBounds);
    const manualFromOriginal = !!(useDisplayBounds && row.manualCrop && hasOriginalFrame);
    const source = hasOriginalFrame
      ? row.sourceCanvas
      : (row.baseCanvas || row.canvas);
    const bounds = hasOriginalFrame
      ? (useDisplayBounds && row.displayBounds ? row.displayBounds : row.sourceBounds)
      : null;

    const topPercent = rowTopCropPercent(bounds);
    const bottomPercent = BASE_CROP_BOTTOM + state.settings.cropBottom;
    const appliedBounds = hasOriginalFrame && !manualFromOriginal
      ? core.resolveRowCropBounds(source.height, topPercent, bottomPercent, bounds)
      : null;
    const manualCrop = manualFromOriginal
      ? cropCanvasNormalized(source, row.manualCrop)
      : null;
    let canvas = manualCrop?.canvas || core.adjustRowCrop(
      source, topPercent, bottomPercent, bounds
    );

    let displayStaffTop = row.staffTop;
    let displayStaffBottom = row.staffBottom;
    if (useDisplayBounds && appliedBounds && Number.isFinite(row.sourceStaffTop) &&
        Number.isFinite(row.sourceStaffBottom)) {
      displayStaffTop = row.sourceStaffTop - appliedBounds.top;
      displayStaffBottom = row.sourceStaffBottom - appliedBounds.top;
    } else if (manualCrop && Number.isFinite(row.sourceStaffTop) &&
        Number.isFinite(row.sourceStaffBottom)) {
      displayStaffTop = row.sourceStaffTop - manualCrop.top;
      displayStaffBottom = row.sourceStaffBottom - manualCrop.top;
    }

    if (state.settings.removeColorArtifacts) {
      canvas = core.cleanColorArtifacts(canvas);
      if ((row.measureNumber === 1 || row.isUnnumberedOpening) && typeof core.cleanOpeningRestPlaceholder === 'function') {
        canvas = core.cleanOpeningRestPlaceholder(canvas, {
          staffTop: displayStaffTop,
          staffBottom: displayStaffBottom,
        });
      }
    }
    if (state.settings.sourceInk === 'light-overlay' &&
        !row.horizontalSource && typeof core.binarizeNotation === 'function') {
      canvas = core.binarizeNotation(canvas);
    }

    if (useDisplayBounds && row.manualCrop && !manualFromOriginal) {
      const cropped = cropCanvasNormalized(canvas, row.manualCrop);
      canvas = cropped.canvas;
      if (Number.isFinite(displayStaffTop)) displayStaffTop -= cropped.top;
      if (Number.isFinite(displayStaffBottom)) displayStaffBottom -= cropped.top;
    }

    if (useDisplayBounds) {
      if (Number.isFinite(displayStaffTop)) row.staffTop = displayStaffTop;
      if (Number.isFinite(displayStaffBottom)) row.staffBottom = displayStaffBottom;
    }

    row.canvas = canvas || source;
    row.url = row.canvas?.toDataURL
      ? row.canvas.toDataURL('image/png')
      : '';
  }

  function followingHorizontalRow(index) {
    const row = state.rows[index];
    const next = state.rows[index + 1];
    // A printed section box belongs at the beginning of its own row.
    // Do not offer a cut point or merge operation across that boundary.
    return row?.horizontalSource && next?.horizontalSource &&
      !next.autoSectionStart && !next.sectionMarker ? next : null;
  }

  function horizontalRowsConnected(row, next) {
    return row?.horizontalSource && next?.horizontalSource === row.horizontalSource &&
      row.horizontalEnd === next.horizontalStart;
  }

  function horizontalBoundaryLimits(index) {
    const row = state.rows[index];
    const next = followingHorizontalRow(index);
    if (!next || !horizontalRowsConnected(row, next)) return null;
    const firstWidth = row.horizontalEnd - row.horizontalStart;
    const secondWidth = next.horizontalEnd - next.horizontalStart;
    const origin = row.horizontalStart;
    const edge = origin + firstWidth + secondWidth;
    const minimumWidth = Math.max(20, Math.round(Math.max(row.staffSpacing, next.staffSpacing) * 3));
    const targetWidth = Math.max(
      row.horizontalSource.layoutWidth || row.horizontalSource.targetWidth,
      next.horizontalSource.layoutWidth || next.horizontalSource.targetWidth);
    return { min: Math.max(origin + minimumWidth, edge - targetWidth),
      max: Math.min(edge - minimumWidth, origin + targetWidth),
      value: origin + firstWidth };
  }

  function horizontalPairFits(index) {
    const row = state.rows[index];
    const next = followingHorizontalRow(index);
    return !!next && row.horizontalEnd - row.horizontalStart +
      next.horizontalEnd - next.horizontalStart <=
      Math.max(row.horizontalSource.layoutWidth || row.horizontalSource.targetWidth,
        next.horizontalSource.layoutWidth || next.horizontalSource.targetWidth);
  }

  function connectHorizontalRows(index) {
    const row = state.rows[index];
    const next = followingHorizontalRow(index);
    if (!next || horizontalRowsConnected(row, next)) return !!next;
    const firstWidth = row.horizontalEnd - row.horizontalStart;
    const secondWidth = next.horizontalEnd - next.horizontalStart;
    const first = core.renderHorizontalRange(row.horizontalSource,
      row.horizontalStart, row.horizontalEnd, true);
    const second = core.renderHorizontalRange(next.horizontalSource,
      next.horizontalStart, next.horizontalEnd, true);
    const firstStaff = row.horizontalSource.staffOffset || row.staffTop || 0;
    const secondStaff = next.horizontalSource.staffOffset || next.staffTop || 0;
    const staffOffset = Math.max(firstStaff, secondStaff);
    const targetHeight = Math.max(first.height + staffOffset - firstStaff,
      second.height + staffOffset - secondStaff);
    const normalized = (image, width, top) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = targetHeight;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, targetHeight);
      context.drawImage(image, 0, 0, width, image.height,
        0, Math.round(staffOffset - top), width, image.height);
      return canvas;
    };
    const firstCanvas = normalized(first, firstWidth, firstStaff);
    const secondCanvas = normalized(second, secondWidth, secondStaff);
    const source = {
      pieces: [
        { canvas: firstCanvas, left: 0, sourceX: 0, width: firstWidth },
        { canvas: secondCanvas, left: firstWidth, sourceX: 0, width: secondWidth },
      ],
      width: firstWidth + secondWidth,
      height: targetHeight,
      targetWidth: Math.max(row.horizontalSource.targetWidth,
        next.horizontalSource.targetWidth),
      layoutWidth: Math.max(row.horizontalSource.layoutWidth || 0,
        next.horizontalSource.layoutWidth || 0) || null,
      sourceInk: row.horizontalSource.sourceInk || 'dark',
      firstStart: 0,
      staffOffset,
      staffSpacing: Math.max(row.staffSpacing, next.staffSpacing),
      barlineCuts: [
        ...(row.horizontalSource.barlineCuts || [])
          .filter((x) => x > row.horizontalStart && x < row.horizontalEnd)
          .map((x) => x - row.horizontalStart),
        ...(next.horizontalSource.barlineCuts || [])
          .filter((x) => x > next.horizontalStart && x < next.horizontalEnd)
          .map((x) => firstWidth + x - next.horizontalStart),
      ],
      noteMeasures: [
        ...(row.horizontalSource.noteMeasures || [])
          .filter((x) => x >= row.horizontalStart && x < row.horizontalEnd)
          .map((x) => x - row.horizontalStart),
        ...(next.horizontalSource.noteMeasures || [])
          .filter((x) => x >= next.horizontalStart && x < next.horizontalEnd)
          .map((x) => firstWidth + x - next.horizontalStart),
      ],
      sectionMarkers: [
        ...(row.horizontalSource.sectionMarkers || [])
          .filter((x) => x >= row.horizontalStart && x < row.horizontalEnd)
          .map((x) => x - row.horizontalStart),
        ...(next.horizontalSource.sectionMarkers || [])
          .filter((x) => x >= next.horizontalStart && x < next.horizontalEnd)
          .map((x) => firstWidth + x - next.horizontalStart),
      ],
    };
    row.horizontalSource = source;
    row.horizontalStart = 0;
    row.horizontalEnd = firstWidth;
    next.horizontalSource = source;
    next.horizontalStart = firstWidth;
    next.horizontalEnd = source.width;
    row.staffTop = staffOffset;
    next.staffTop = staffOffset;
    row.staffBottom = staffOffset + row.staffSpacing * 4;
    next.staffBottom = staffOffset + next.staffSpacing * 4;
    redrawHorizontalRow(row);
    redrawHorizontalRow(next);
    return true;
  }

  function redrawHorizontalRow(row) {
    const canvas = core.renderHorizontalRange(row.horizontalSource,
      row.horizontalStart, row.horizontalEnd);
    row.baseCanvas = canvas;
    row.manualCrop = null;
    row.candidates = [{ ...(row.candidates?.[0] || {}), canvas, baseCanvas: canvas }];
    row.selectedCandidateIndex = 0;
    refreshRowCanvas(row);
  }

  function setHorizontalBoundary(index, value) {
    const row = state.rows[index];
    const next = followingHorizontalRow(index);
    if (!next) return false;
    const limits = horizontalBoundaryLimits(index);
    if (!limits || limits.max <= limits.min) return false;
    let boundary = Math.max(limits.min, Math.min(limits.max, Math.round(Number(value))));
    const spacing = row.horizontalSource.staffSpacing || row.staffSpacing || 6;
    for (const marker of row.horizontalSource.sectionMarkers || []) {
      const before = marker - spacing * 2;
      const after = marker + spacing * 6;
      if (boundary > before && boundary < after) {
        boundary = Math.abs(boundary - before) <= Math.abs(boundary - after)
          ? before : after;
        boundary = Math.max(limits.min, Math.min(limits.max, Math.round(boundary)));
        break;
      }
    }
    if (boundary === row.horizontalEnd) return true;
    row.horizontalEnd = boundary;
    next.horizontalStart = boundary;
    redrawHorizontalRow(row);
    redrawHorizontalRow(next);
    return true;
  }

  function mergeFollowingHorizontalRow(index) {
    const row = state.rows[index];
    const next = followingHorizontalRow(index);
    if (!next) return false;
    if (!horizontalRowsConnected(row, next)) {
      if (!connectHorizontalRows(index)) return false;
      renderReview();
      toast('画面已连接；请先核对拼接处，再调整两行切点');
      return true;
    }
    if (!horizontalPairFits(index)) {
      toast('两行内容超过单行宽度，不能合并；可调整切点');
      return false;
    }
    row.horizontalLastMerge = { boundary: row.horizontalEnd, next };
    row.horizontalEnd = next.horizontalEnd;
    redrawHorizontalRow(row);
    state.rows.splice(index + 1, 1);
    state.rows.forEach((item, itemIndex) => { item.index = itemIndex; });
    renderReview();
    return true;
  }

  function mergePreviousHorizontalRow(index) {
    if (index < 1) return false;
    return mergeFollowingHorizontalRow(index - 1);
  }

  function undoHorizontalMerge(index) {
    const row = state.rows[index];
    const saved = row?.horizontalLastMerge;
    if (!saved || saved.boundary <= row.horizontalStart || saved.boundary >= row.horizontalEnd) {
      return false;
    }
    const next = saved.next;
    next.horizontalSource = row.horizontalSource;
    next.horizontalStart = saved.boundary;
    next.horizontalEnd = row.horizontalEnd;
    row.horizontalEnd = saved.boundary;
    row.horizontalLastMerge = null;
    redrawHorizontalRow(row);
    redrawHorizontalRow(next);
    state.rows.splice(index + 1, 0, next);
    state.rows.forEach((item, itemIndex) => { item.index = itemIndex; });
    renderReview();
    return true;
  }

  function rebuildFromRaw() {
    if (!state.rawSequences.length) return;

    // Video frames can revisit the same printed row many times. Merge only
    // sequence overlaps that have visual evidence, keeping unmatched rows.
    const horizontal = state.settings.mode === 'horizontal';
    const singleCapture = horizontal || core.isSingleLineCapture(state.settings.mode, state.rawSequences);
    const capturedVideo = state.captureGroups.length > 0;
    const capturedPages = capturedVideo && !singleCapture;
    const horizontalMerge = horizontal
      ? core.mergeHorizontalSequences(state.rawSequences) : null;
    const scrollMerge = capturedPages
      ? core.mergeScrollingSequences(state.rawSequences) : null;
    const adjacentMerge = capturedVideo && !scrollMerge
      ? core.mergeAdjacentCaptureRows(state.rawSequences) : null;
    state.scrollingCapture = !!(scrollMerge || horizontalMerge);
    state.adjacentCapture = !!adjacentMerge;
    const merged = horizontalMerge || scrollMerge || adjacentMerge || core.mergeRowSequences(state.rawSequences, {
        dedupeStrength: state.settings.dedupeStrength,
        threshold: 0.36 - state.settings.dedupeStrength * 0.07,
      });
    const deduped = scrollMerge
      ? core.dedupeRows(merged.rows, { maxSequenceGap: 6 })
      : horizontal || capturedPages || adjacentMerge
      ? { rows: merged.rows }
      : core.dedupeRows(merged.rows, {
        strength: state.settings.dedupeStrength,
        threshold: 0.27 - state.settings.dedupeStrength * 0.06,
      });

    // A variable-height scroll often has no adjacent overlap; that alone is not a missing-page error.
    // Incomplete rows are already marked on their cards, so only keep actionable warnings here.
    state.warnings = horizontalMerge?.warnings || [];
    state.rows = normalizeRows(deduped.rows, { singleCapture });

    renderReview();
  }

  function canvasBlob(canvas, type = 'image/png', quality) {
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('图片编码失败')),
      type,
      quality
    ));
  }

  function mergeRowsWithSameMeasure(rows, options = {}) {
    const output = [];
    const seen = new Map();
    let removed = 0;
    rows.forEach((row) => {
      const number = validMeasureNumber(row.measureNumber);
      const existing = number == null || row.isUnnumberedOpening ? null : seen.get(number);
      const visualDistance = existing ? core.rowMatchDistance(existing, row) : 1;
      const nearbyConfirmed = existing &&
        measureOrder.sameMeasureNearbyDuplicate(existing, row);
      const frameGap = existing && Number.isInteger(existing.sourceFrameIndex) &&
        Number.isInteger(row.sourceFrameIndex)
        ? Math.abs(existing.sourceFrameIndex - row.sourceFrameIndex) : 0;
      const sequenceGap = existing && Number.isInteger(existing.sequenceIndex) &&
        Number.isInteger(row.sequenceIndex)
        ? Math.abs(existing.sequenceIndex - row.sequenceIndex) : 0;
      const printedNumberDistance = existing
        ? core.numberLabelDistance?.(existing, row) : null;
      const labelConfirmed = existing && frameGap <= 8 && sequenceGap <= 3 &&
        printedNumberDistance != null && printedNumberDistance <= 0.23;
      const selectedNeighborConfirmed = existing &&
        (existing.measureSource === 'selected-neighbor' || row.measureSource === 'selected-neighbor') &&
        frameGap <= 12 && sequenceGap <= 2 && visualDistance <= 0.16;
      const distantApproximation = (frameGap > 16 || sequenceGap > 8) &&
        visualDistance > 0.035 && !nearbyConfirmed;
      if (!existing || existing.sequenceIndex === row.sequenceIndex ||
          distantApproximation ||
          (visualDistance > 0.11 && !nearbyConfirmed && !selectedNeighborConfirmed && !labelConfirmed)) {
        output.push(row);
        if (number != null && !row.isUnnumberedOpening && !seen.has(number)) seen.set(number, row);
        return;
      }
      const candidates = [...(existing.candidates || []), ...(row.candidates || []), existing, row].filter(Boolean);
      const unique = [];
      candidates.forEach((candidate) => {
        if (!unique.some((item) => item.canvas === candidate.canvas)) unique.push(candidate);
      });
      existing.candidates = unique.slice(0, 8);
      const best = core.chooseBestCandidate(existing.candidates);
      if (best?.canvas && !options.preserveImage) {
        existing.baseCanvas = best.baseCanvas || best.canvas;
        existing.sourceCanvas = best.sourceCanvas || null;
        existing.sourceBounds = best.sourceBounds || null;
        existing.quality = best.quality || existing.quality;
        refreshRowCanvas(existing);
      }
      removed += 1;
    });
    return { rows: output, removed };
  }

  function sortRowsByMeasure(rows) {
    const anchors = rows.map((row, index) => ({ index, number: validMeasureNumber(row.measureNumber) })).filter((item) => item.number != null);
    if (anchors.length < 2) return rows;
    const minimumMeasure = Math.min(...anchors.map((item) => item.number));
    const keyed = rows.map((row, index) => {
      const own = validMeasureNumber(row.measureNumber);
      if (own != null) return { row, index, key: own };
      const previous = [...anchors].reverse().find((item) => item.index < index);
      const next = anchors.find((item) => item.index > index);
      let key;
      if (previous && next) key = previous.number + (next.number - previous.number) * (index - previous.index) / (next.index - previous.index);
      else if (next) key = minimumMeasure - 1 + index * 0.001;
      else key = previous.number + (index - previous.index) * 0.01;
      return { row, index, key };
    });
    return keyed.sort((left, right) => left.key - right.key || left.index - right.index).map((item) => item.row);
  }

  function inferMeasurePattern(results) {
    return measureOrder.inferSequentialPattern(results);
  }

  function selectMeasureCandidate(result, pattern, index) {
    return measureOrder.selectSequentialCandidate(result, pattern, index);
  }

  function removeHorizontalFragments(rows) {
    if (state.settings.mode === 'single') return { rows, removed: 0 };
    const references = rows
      .filter((row) => validMeasureNumber(row.measureNumber) != null)
      .map((row) => Number(row.horizontalCoverage))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (references.length < 2) return { rows, removed: 0 };
    const typical = core.median(references);
    const minimum = Math.max(0.28, typical * 0.72);
    const kept = rows.filter((row) => {
      if (validMeasureNumber(row.measureNumber) != null) return true;
      const coverage = Number(row.horizontalCoverage);
      return measureOrder.keepAfterCoverageFilter(row, coverage, minimum);
    });
    return { rows: kept, removed: rows.length - kept.length };
  }

  async function recheckSelectedRowMeasures(rows) {
    let changed = 0;
    const batchSize = 20;
    for (let start = 0; start < rows.length; start += batchSize) {
      const targets = rows.slice(start, start + batchSize)
        .map((row, offset) => ({ row, index: start + offset }))
        .filter(({ row }) => !row.isUnnumberedOpening && row.measureSource !== 'manual' &&
          row.measureSource !== 'group-sequence' &&
          (validMeasureNumber(row.measureNumber) >= 10 || row.measureNumber == null));
      if (!targets.length) continue;
      const images = targets.map(({ row }, index) => {
        const source = row.canvas || row.baseCanvas;
        const crop = document.createElement('canvas');
        crop.width = Math.min(140, source.width);
        const staffTop = Number.isFinite(row.staffTop) ? row.staffTop : source.height * 0.38;
        crop.height = Math.min(source.height, Math.max(42, Math.round(staffTop + 4)));
        const context = crop.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, crop.width, crop.height);
        context.drawImage(source, 0, 0, crop.width, crop.height, 0, 0, crop.width, crop.height);
        return { name: `selected-row-${start + index + 1}`, dataUrl: crop.toDataURL('image/png') };
      });
      try {
        const response = await fetch(`${API_BASE}/api/measure-ocr-rows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.reason || '最终画面 OCR 失败');
        (payload.numbers || []).forEach((result, index) => {
          const target = targets[index];
          if (!target) return;
          const { row } = target;
          row.selectedMeasureCandidates = result.candidates || [];
          const sameNumberElsewhere = rows.some((other) =>
            other !== row && validMeasureNumber(other.measureNumber) === validMeasureNumber(row.measureNumber));
          const previous = rows[targets[index].index - 1];
          const next = rows[targets[index].index + 1];
          const number = validMeasureNumber(row.measureNumber);
          const lockedByNeighbors = number != null &&
            validMeasureNumber(previous?.measureNumber) === number - 4 &&
            validMeasureNumber(next?.measureNumber) === number + 4;
          if (measureOrder.preferSelectedImageMeasure(row, result, {
            duplicateCurrent: sameNumberElsewhere,
            lockedByNeighbors,
          })) changed += 1;
        });
      } catch (error) {
        console.warn(error);
        return changed;
      }
      $('#reviewSummary').textContent =
        `正在核对最终画面 ${Math.min(start + batchSize, rows.length)} / ${rows.length}`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    rows.forEach((row, index) => {
      if (validMeasureNumber(row.measureNumber) != null || row.isUnnumberedOpening) return;
      const candidates = row.selectedMeasureCandidates || [];
      const nearby = rows.slice(Math.max(0, index - 2), Math.min(rows.length, index + 3));
      const match = nearby.find((other) => {
        if (other === row || validMeasureNumber(other.measureNumber) == null) return false;
        if (!Number.isInteger(row.sourceFrameIndex) ||
            !Number.isInteger(other.sourceFrameIndex) ||
            !Number.isInteger(row.sequenceIndex) ||
            !Number.isInteger(other.sequenceIndex)) return false;
        const frameGap = Math.abs(row.sourceFrameIndex - other.sourceFrameIndex);
        const sequenceGap = Math.abs(row.sequenceIndex - other.sequenceIndex);
        const labelDistance = core.numberLabelDistance?.(row, other);
        if (labelDistance != null && labelDistance <= 0.23 &&
            frameGap <= 8 && sequenceGap <= 3 &&
            core.rowMatchDistance(row, other) <= 0.45) return true;
        if (frameGap > 12 || sequenceGap > 2) return false;
        if (!candidates.some((candidate) =>
          validMeasureNumber(candidate.value) === other.measureNumber && Number(candidate.votes) >= 3)) return false;
        return core.rowMatchDistance(row, other) <= 0.28;
      });
      if (!match) return;
      const candidate = candidates.find((item) => validMeasureNumber(item.value) === match.measureNumber);
      const printedNumberDistance = core.numberLabelDistance?.(row, match);
      const labelSupported = printedNumberDistance != null && printedNumberDistance <= 0.23;
      row.measureNumber = match.measureNumber;
      row.measureSource = labelSupported ? 'label-match' : 'selected-neighbor';
      row.measureConfidence = labelSupported
        ? Math.max(25, Math.round(Number(match.measureConfidence || 0) * 0.8))
        : Number(candidate?.confidence) || 0;
      row.measureVotes = Number(candidate?.votes) || 0;
      changed += 1;
    });
    return changed;
  }

  async function recognizeAndSortRows() {
    if (!state.rows.length) return { detected: 0, removed: 0, opening: 0, pattern: null, raw: [] };
    measureOrder.resetAutomaticMeasures(state.rows);
    if (state.captureGroups.length || state.settings.mode === 'horizontal') {
      // Video groups already have a reliable capture order. Scrolling geometry
      // refines it when available; per-row OCR adds latency and unreliable labels.
      const ordering = state.scrollingCapture ? 'chronological-scroll' : 'chronological-video';
      state.rows = state.rows.map((row, index) => ({
        ...row, index, measureNumber: null, measureSource: ordering,
        measureConfidence: null, measureVotes: null, measureCandidates: [],
        isUnnumberedOpening: false,
      }));
      return { detected: 0, removed: 0, opening: 0, pattern: null,
        raw: [], ordering };
    }
    if (state.adjacentCapture || core.isSingleLineCapture(state.settings.mode, state.rawSequences)) {
      state.rows = state.rows.map((row, index) => ({
        ...row,
        index,
        measureNumber: null,
        measureSource: 'chronological',
        measureConfidence: null,
        measureVotes: null,
        measureCandidates: [],
        isUnnumberedOpening: false,
      }));
      $('#reviewSummary').textContent = '单行谱面正在按画面出现顺序整理…';
      return {
        detected: 0,
        removed: 0,
        opening: 0,
        pattern: null,
        raw: [],
        ordering: 'chronological',
      };
    }
    const batchSize = 20;
    const raw = [];
    $('#reviewSummary').textContent = '正在逐行识别左上角的小节号…';
    for (let start = 0; start < state.rows.length; start += batchSize) {
      const batch = state.rows.slice(start, start + batchSize);
      const images = [];
      const imageRows = [];
      batch.forEach((row, rowIndex) => {
        const allCandidates = [
          ...(row.candidates || []),
          row,
        ];
        const unique = [];
        allCandidates.forEach((candidate) => {
          const canvas = candidate?.canvas || candidate?.baseCanvas;
          if (canvas && !unique.some((item) => (item.canvas || item.baseCanvas) === canvas)) {
            unique.push(candidate);
          }
        });
        unique.slice(0, 3).forEach((candidate, candidateIndex) => {
          const source = candidate.canvas || candidate.baseCanvas;
          const staffTop = Number.isFinite(candidate.staffTop)
            ? candidate.staffTop
            : Number.isFinite(row.staffTop)
              ? row.staffTop
              : Math.round(source.height * 0.38);
          const crop = document.createElement('canvas');
          crop.width = Math.min(140, source.width);
          crop.height = Math.min(source.height, Math.max(42, Math.round(staffTop + 4)));
          const context = crop.getContext('2d');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, crop.width, crop.height);
          context.drawImage(source, 0, 0, crop.width, crop.height, 0, 0, crop.width, crop.height);
          images.push({
            name: 'row-' + (start + rowIndex + 1) + '-candidate-' + (candidateIndex + 1),
            dataUrl: crop.toDataURL('image/png'),
          });
          imageRows.push(rowIndex);
        });
      });
      try {
        const response = await fetch(`${API_BASE}/api/measure-ocr-rows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.reason || '小节号 OCR 失败');
        const aggregate = batch.map(() => ({ trials: 0, values: new Map(), candidateImages: 0 }));
        (payload.numbers || []).forEach((result, imageIndex) => {
          const rowIndex = imageRows[imageIndex];
          const target = aggregate[rowIndex];
          if (!target) return;
          target.candidateImages += 1;
          target.trials = Math.max(target.trials, Number(result.trials) || 0);
          (result.candidates || []).forEach((candidate) => {
            const value = validMeasureNumber(candidate.value);
            const votes = Number(candidate.votes) || 0;
            if (value == null) return;
            target.values.set(value, Math.max(target.values.get(value) || 0, votes));
          });
        });
        raw.push(...aggregate.map((item) => {
          const candidates = [...item.values.entries()]
            .map(([value, votes]) => ({
              value,
              votes,
              confidence: Math.round(votes * 1000 / Math.max(1, item.trials)) / 10,
            }))
            .sort((left, right) => right.votes - left.votes);
          return {
            value: candidates[0]?.value ?? null,
            votes: candidates[0]?.votes || 0,
            confidence: candidates[0]?.confidence || 0,
            trials: item.trials,
            candidateImages: item.candidateImages,
            candidates,
          };
        }));
      } catch (error) {
        console.warn(error);
        toast('小节号识别未完成：' + error.message);
        return { detected: 0, removed: 0, pattern: null, raw };
      }
      $('#reviewSummary').textContent =
        '正在识别小节号 ' + Math.min(start + batch.length, state.rows.length) + ' / ' + state.rows.length;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (state.scrollingCapture) {
      // Geometry has already established the order. OCR is useful as a label,
      // but a guessed measure number must never rearrange or merge staff rows.
      state.rows = state.rows.map((row, index) => {
        const result = raw[index] || {};
        const first = result.candidates?.[0];
        const second = result.candidates?.[1];
        const confirmed = first && first.votes >= 5 &&
          (!second || first.votes >= second.votes * 1.5);
        return {
          ...row,
          index,
          measureNumber: confirmed ? first.value : null,
          measureSource: confirmed ? 'ocr-consensus' : 'chronological-scroll',
          measureConfidence: confirmed ? first.confidence : null,
          measureVotes: confirmed ? first.votes : null,
          measureCandidates: result.candidates || [],
        };
      });
      return {
        detected: state.rows.filter((row) => row.measureNumber != null).length,
        removed: 0,
        opening: 0,
        pattern: null,
        raw,
        ordering: 'chronological-scroll',
      };
    }
    const pattern = inferMeasurePattern(raw);
    const groupedMeasures = measureOrder.selectCaptureGroupMeasures(state.rows, raw, pattern.step || 4);
    raw.forEach((result, index) => {
      const selected = groupedMeasures[index] || selectMeasureCandidate(result, { ...pattern, reliable: false }, index);
      if (!selected || !state.rows[index]) return;
      state.rows[index].measureNumber = selected.value;
      state.rows[index].measureSource = groupedMeasures[index]
        ? 'group-sequence'
        : selected.inferred ? 'sequence-inferred' : 'ocr-consensus';
      state.rows[index].measureConfidence = selected.confidence;
      state.rows[index].measureVotes = selected.votes;
      state.rows[index].measureCandidates = result.candidates || [];
    });
    measureOrder.refineBracketedMeasures(state.rows);
    measureOrder.refineDigitAndNeighborAlternatives(state.rows);
    measureOrder.refineRepeatedMeasureAlternatives(state.rows);
    const opening = measureOrder.protectUnnumberedOpening(state.rows, pattern);
    state.rows.forEach((row) => {
      if (row.isUnnumberedOpening) return;
      if (validMeasureNumber(row.measureNumber) != null) return;
      let nearest = null;
      state.rows.forEach((candidate) => {
        if (validMeasureNumber(candidate.measureNumber) == null || candidate === row) return;
        const distance = core.rowMatchDistance(row, candidate);
        if (!nearest || distance < nearest.distance) nearest = { candidate, distance };
      });
      if (nearest && nearest.distance <= 0.085) {
        row.measureNumber = nearest.candidate.measureNumber;
        row.measureSource = 'visual-match';
        row.measureConfidence = Math.round((1 - nearest.distance) * 100);
      }
    });
    const merged = mergeRowsWithSameMeasure(state.rows);
    const horizontal = removeHorizontalFragments(merged.rows);
    await recheckSelectedRowMeasures(horizontal.rows);
    const selectedMerge = mergeRowsWithSameMeasure(horizontal.rows, { preserveImage: true });
    const strongNumbers = selectedMerge.rows.filter((row) =>
      validMeasureNumber(row.measureNumber) >= 10 && Number(row.measureConfidence) >= 25).length;
    const enoughNumbers = strongNumbers >= Math.max(8, Math.ceil(selectedMerge.rows.length * 0.65));
    // Captured frames and imported image lists are chronological. OCR may have gaps
    // or repeated digits, so sorting by its guesses can scramble whole pages.
    const ordered = selectedMerge.rows;
    const recoveredGapRows = measureOrder.refineRepeatedUnnumberedGap(
      ordered, (left, right) => core.numberLabelDistance?.(left, right)
    );
    const finalMerge = recoveredGapRows
      ? mergeRowsWithSameMeasure(ordered)
      : { rows: ordered, removed: 0 };
    state.rows = finalMerge.rows.map((row, index) => ({ ...row, index }));
    return {
      detected: state.rows.filter((row) => validMeasureNumber(row.measureNumber) != null).length,
      removed: merged.removed + horizontal.removed + selectedMerge.removed + finalMerge.removed,
      opening,
      pattern,
      raw,
    };
  }

  async function saveProcessingDebug(frames, sourceGroups, measureResult) {
    if (!state.captureSession) return;
    const rowDebug = (row) => ({
      sequenceIndex: row.sequenceIndex ?? null,
      sequenceRowIndex: row.sequenceRowIndex ?? null,
      sourceFrameIndex: row.sourceFrameIndex ?? null,
      status: row.status || null,
      completeness: row.completeness ?? null,
      staffTop: row.staffTop ?? null,
      staffBottom: row.staffBottom ?? null,
      staffSpacing: row.staffSpacing ?? null,
      horizontalCoverage: row.horizontalCoverage ?? null,
      sourceBounds: row.sourceBounds || null,
      included: row.included !== false,
      measureNumber: validMeasureNumber(row.measureNumber),
      measureSource: row.measureSource || null,
      detectedMeasureNumber: validMeasureNumber(row.detectedMeasureNumber),
      isUnnumberedOpening: !!row.isUnnumberedOpening,
      measureConfidence: row.measureConfidence ?? null,
      measureVotes: row.measureVotes ?? null,
      measureCandidates: row.measureCandidates || [],
      selectedMeasureCandidates: row.selectedMeasureCandidates || [],
      candidateCount: row.candidates?.length || 0,
      sectionMarker: String(row.sectionMarker || ''),
      repeatMark: String(row.repeatMark || 'none'),
      repeatCount: Number.isFinite(Number(row.repeatCount)) ? Number(row.repeatCount) : null,
      cursorPenalty: row.quality?.cursorPenalty ?? null,
    });
    const debug = {
      version: '0.8.90',
      savedAt: new Date().toISOString(),
      mode: state.settings.mode,
      settings: { ...state.settings },
      crop: state.crop ? { ...state.crop } : null,
      cropReference: state.cropReference,
      cropNormalized: state.cropNormalized,
      captureSourceInfo: state.captureSourceInfo,
      captureAttempts: state.captureAttempts,
      detectionFallback: state.detectionFallback,
      retainedFrameCount: frames?.length || 0,
      sourceGroupCount: sourceGroups?.length || 0,
      rawSequenceCount: state.rawSequences.length,
      rawSequences: state.rawSequences.map((sequence) => ({
        groupIndex: sequence.groupIndex,
        stable: sequence.stable,
        rows: (sequence.rows || []).map(rowDebug),
      })),
      measurePattern: measureResult?.pattern || null,
      measureOcr: measureResult?.raw || [],
      scoreMetadata: state.scoreMetadata,
      finalRows: state.rows.map(rowDebug),
      warnings: state.warnings,
    };
    try {
      await fetch(`${API_BASE}/api/capture/debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.captureSession, debug }),
      });
    } catch (error) {
      console.warn('debug save failed', error);
    }
  }

  function canvasRegionDataUrl(source, widthRatio, heightRatio) {
    if (!source?.width || !source?.height) return '';
    const sourceWidth = Math.max(1, Math.round(source.width * Math.min(1, widthRatio)));
    const sourceHeight = Math.max(1, Math.round(source.height * Math.min(1, heightRatio)));
    const scale = Math.min(1, 1600 / sourceWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  function titleRegionDataUrl(source) {
    if (!source?.width || !source?.height) return '';
    const scale = Math.min(1, 760 / source.width);
    const detectedHeight = Math.max(1, source.height * scale);
    const systems = core.detectStaffSystems(source, { maxWidth: 760 });
    if (!systems.length) return '';
    const first = systems[0];
    const titleBottom = first.lines[0] - first.spacing * 2.4;
    const ratio = titleBottom / detectedHeight;
    if (ratio < 0.055) return '';
    return canvasRegionDataUrl(source, 1, core.clamp(ratio, 0.055, 0.28));
  }

  async function recognizeScoreMetadata(frames) {
    const frame = frames?.[0]?.canvas || frames?.[0] || null;
    const firstRow = state.rows?.[0]?.baseCanvas || state.rows?.[0]?.canvas || null;
    if (!frame && !firstRow) return null;
    try {
      const response = await fetch(`${API_BASE}/api/score-metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frame: frame ? titleRegionDataUrl(frame) : '',
          row: firstRow ? canvasRegionDataUrl(firstRow, 0.38, 1) : '',
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) return null;
      state.scoreMetadata = payload;
      const titleInput = $('#titleInput');
      if (payload.title && payload.titleConfidence >= 0.78 && !state.titleUserEdited && (!titleInput.value.trim() || titleInput.value.trim() === '鼓谱')) {
        titleInput.value = payload.title;
      }
      const tempoInput = $('#tempoInput');
      if (payload.tempo && !state.tempoUserEdited && !tempoInput.value.trim()) {
        tempoInput.value = String(payload.tempo);
      }
      return payload;
    } catch (error) {
      console.warn('score metadata OCR unavailable', error);
      return null;
    }
  }

  async function processFrames(frames, preparedGroups = null) {
    state.captureMemoryCompacted = false;
    $('#processingPanel').classList.remove('hidden');
    $('#reviewPanel').classList.add('hidden');

    await new Promise((resolve) =>
      setTimeout(resolve, 30)
    );

    if (!frames?.length) {
      toast('没有收到截图，请重新录取');
      restart();
      return;
    }

    const groups = preparedGroups?.length
      ? preparedGroups
      : state.settings.mode === 'horizontal'
        ? frames.map((frame, index) => ({ index, items: [frame], stable: true }))
        : core.groupStableFrames(frames, { threshold: 0.04, maxGap: 1000 });

    const sourceGroups = groups.length
      ? groups
      : [
          {
            index: 0,
            items: frames,
            stable: false,
          },
        ];

    state.rawSequences = [];
    for (let groupIndex = 0; groupIndex < sourceGroups.length; groupIndex += 1) {
      const sequence = buildSequence(sourceGroups[groupIndex],
        state.settings.mode === 'horizontal' ? 'single' : state.settings.mode);
      if (sequence.rows.length) state.rawSequences.push(sequence);
      $('#reviewSummary').textContent = `正在整理 ${groupIndex + 1} / ${sourceGroups.length}`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    state.detectionFallback = false;
    rebuildFromRaw();
    if (!state.rows.length && state.settings.mode === 'single') {
      state.rawSequences = [];
      for (let groupIndex = 0; groupIndex < sourceGroups.length; groupIndex += 1) {
        const sequence = buildSequence(sourceGroups[groupIndex], 'auto');
        if (sequence.rows.length) state.rawSequences.push(sequence);
      }
      rebuildFromRaw();
      state.detectionFallback = state.rows.length > 0;
      if (state.detectionFallback) toast('单行检测未找到完整谱行，已自动使用通用检测恢复');
    }
    await recognizeScoreMetadata(frames);
    const measureResult = await recognizeAndSortRows();
    state.rows.forEach((row) => refreshRowCanvas(row, true));
    renderReview();
    await saveProcessingDebug(frames, sourceGroups, measureResult);
    await compactCaptureMemory();

    $('#processingPanel').classList.add('hidden');
    $('#reviewPanel').classList.remove('hidden');

    const pending = state.rows.filter(
      (row) =>
        row.status &&
        row.status !== 'complete'
    ).length;

    const warningText = state.warnings.length
      ? `；${state.warnings.length} 个连接提示`
      : '';
    const measureText = measureResult.ordering === 'chronological'
      ? '，单行去重后按画面时间顺序排列'
      : measureResult.ordering === 'chronological-scroll'
        ? '，谱行已按画面去重并依次排列'
      : measureResult.ordering === 'chronological-video'
        ? '，谱行已按录制顺序整理'
      : `${measureResult.detected ? `，识别到 ${measureResult.detected} 个小节号` : '，小节号未识别'}` +
        `${measureResult.removed ? `，按小节号合并 ${measureResult.removed} 个重复行` : ''}` +
        `${measureResult.opening ? `，保留 ${measureResult.opening} 行无编号开头` : ''}`;

    $('#reviewSummary').textContent =
      `${frames.length} 张画面，分成 ` +
      `${sourceGroups.length} 个${state.settings.mode === 'horizontal' ? '横向采样' : '稳定画面'}，整理出 ` +
      `${state.rows.length} 行` +
      measureText +
      `${
        pending
          ? `，${pending} 行待确认`
          : ''
      }` +
      warningText;

    if (!state.rows.length) {
      toast(
        '没有识别到谱面，可以缩小截图范围或切换模式后再试'
      );
    } else if (pending) {
      toast(
        '边缘残缺行已放入列表并默认排除，请检查是否有后续完整版本'
      );
    }
  }

  function statusText(row) {
    if (row.status === 'top-partial') {
      return '顶部残缺';
    }

    if (row.status === 'bottom-partial') {
      return '底部残缺';
    }

    if (row.status === 'both-partial') {
      return '上下残缺';
    }

    if (row.status === 'unknown') {
      return '未确认';
    }

    return '完整';
  }

  function cursorText(row) {
    const penalty =
      row.quality?.cursorPenalty || 0;

    if (penalty >= 0.2) {
      return state.settings.removeColorArtifacts ? '已清理光标' : '可能有光标';
    }

    if ((row.candidates || []).length > 1) {
      return `${row.candidates.length} 个候选`;
    }

    return '';
  }

  const imageViewerState = {
    kind: null,
    rowIndex: -1,
    pageSources: [],
    pageIndex: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    cropMode: false,
    cropRect: null,
    cropSourceUrl: '',
    cropDirty: false,
    centerOnCrop: false,
    stitchMode: false,
    stitchIndex: null,
    stitchBusy: false,
    stitchPreviewRequest: 0,
    drag: null,
  };

  function visibleHorizontalStitches(row) {
    const stream = row?.horizontalSource;
    return (stream?.frames || []).map((frame, index) => ({ frame, index }))
      .filter(({ frame }) => Number.isFinite(frame.seamGlobal) &&
        frame.seamGlobal >= row.horizontalStart &&
        frame.seamGlobal <= row.horizontalEnd);
  }

  async function resolveHorizontalFrame(frame) {
    const row = frame.row;
    if (row?.sourceCanvas || row?.canvas) return row;
    const index = row?.sourceFrameIndex;
    if (!Number.isInteger(index)) return row;
    const canvas = await decodeArchivedFrame(index);
    // Keep only the cropped strip used by the compositor. The compressed
    // archive remains available for the next manual adjustment.
    if (state.captureMemoryCompacted && state.frames[index]) {
      state.frames[index].canvas = null;
    }
    return { ...row, sourceCanvas: canvas };
  }

  function selectedHorizontalStitch(row) {
    const visible = visibleHorizontalStitches(row);
    if (!visible.length) return null;
    return visible.find(({ index }) => index === imageViewerState.stitchIndex) || visible[0];
  }

  function renderHorizontalStitchTools(row) {
    const visible = visibleHorizontalStitches(row);
    const enabled = imageViewerState.stitchMode && visible.length > 0;
    $('#imageViewer')?.classList.toggle('stitching', enabled);
    $('#imageViewerStitchToggle')?.classList.toggle('hidden', !visible.length);
    $('#imageViewerStitchToggle')?.classList.toggle('active', enabled);
    $('#imageViewerStitchTools')?.classList.toggle('hidden', !enabled);
    if (!enabled) return;
    const selected = selectedHorizontalStitch(row);
    imageViewerState.stitchIndex = selected.index;
    const select = $('#imageViewerStitchSelect');
    if (select) {
      select.innerHTML = '';
      visible.forEach(({ frame, index }, position) => {
        const option = document.createElement('option');
        option.value = index;
        const difference = Number.isFinite(frame.matchScore)
          ? ` · 匹配分数 ${Math.round(frame.matchScore * 100)}（低较好）` : '';
        option.textContent = `拼接 ${position + 1} · 距行首 ${Math.round(frame.seamGlobal - row.horizontalStart)} px${difference}`;
        option.selected = index === selected.index;
        select.appendChild(option);
      });
    }
    const limits = core.horizontalStitchLimits(selected.frame.overlap);
    const slider = $('#imageViewerStitchBoundary');
    if (slider) {
      slider.min = limits.min;
      slider.max = limits.max;
      slider.value = selected.frame.seam;
    }
    const request = ++imageViewerState.stitchPreviewRequest;
    void core.horizontalStitchPreview(row.horizontalSource, selected.index,
      resolveHorizontalFrame).then((preview) => {
      if (!preview || request !== imageViewerState.stitchPreviewRequest ||
          row !== state.rows[imageViewerState.rowIndex] ||
          !imageViewerState.stitchMode) return;
      $('#imageViewerStitchPrevious').src = preview.previous.toDataURL('image/png');
      $('#imageViewerStitchCurrent').src = preview.current.toDataURL('image/png');
    }).catch((error) => console.warn('拼接原图预览失败', error));
    updateHorizontalStitchReadout(selected.frame);
  }

  function updateHorizontalStitchReadout(frame) {
    const changed = frame.seam !== frame.autoSeam;
    const output = $('#imageViewerStitchReadout');
    if (output) output.textContent = `${frame.seam} / ${frame.overlap} px${changed ? ' · 已调整' : ' · 自动'}`;
    $('#imageViewerStitchReset').disabled = !changed;
    const x = `${100 * frame.seam / Math.max(1, frame.overlap)}%`;
    $$('#imageViewerStitchTools .stitch-line').forEach((line) => { line.style.left = x; });
  }

  async function applyHorizontalStitch(value) {
    if (imageViewerState.stitchBusy) return false;
    const row = state.rows[imageViewerState.rowIndex];
    const selected = selectedHorizontalStitch(row);
    if (!selected) return false;
    imageViewerState.stitchBusy = true;
    let adjusted = false;
    try {
      adjusted = await core.adjustHorizontalStitch(row.horizontalSource,
        selected.index, Number(value), resolveHorizontalFrame);
    } finally {
      imageViewerState.stitchBusy = false;
    }
    if (!adjusted) return false;
    state.rows.filter((item) => item.horizontalSource === row.horizontalSource)
      .forEach((item) => {
        const canvas = core.renderHorizontalRange(item.horizontalSource,
          item.horizontalStart, item.horizontalEnd);
        item.baseCanvas = canvas;
        item.candidates = [{ ...(item.candidates?.[0] || {}), canvas, baseCanvas: canvas }];
        item.selectedCandidateIndex = 0;
        refreshRowCanvas(item, true);
      });
    const image = $('#imageViewerImage');
    if (image) image.src = row.url;
    updateHorizontalStitchReadout(selected.frame);
    renderPages();
    return true;
  }

  function viewerCandidates(row) {
    return row?.candidates?.length ? row.candidates : row ? [row] : [];
  }

  function candidateOptionLabel(candidate, index) {
    if (candidate?.label) return `候选 ${index + 1} · ${candidate.label}`;
    const quality = candidate?.quality || {};
    return `候选 ${index + 1} · ${(quality.cursorPenalty || 0) >= 0.2 ? '有光标风险' : '无明显光标'}`;
  }

  async function applyCandidateSelection(row, selectedIndex) {
    const candidates = viewerCandidates(row);
    const selected = candidates[selectedIndex];
    if (!selected) return false;
    const request = (row.candidateSelectionRequest || 0) + 1;
    row.candidateSelectionRequest = request;
    if (!selected.sourceCanvas && selected.sourceBounds && Number.isInteger(selected.sourceFrameIndex)) {
      selected.sourceCanvas = await decodeArchivedFrame(selected.sourceFrameIndex);
    }
    if (request !== row.candidateSelectionRequest || !state.rows.includes(row)) return null;
    if (!core.candidateCanvas(selected) && selected.sourceCanvas && selected.sourceBounds) {
      selected.canvas = core.adjustRowCrop(selected.sourceCanvas, 0, 0, selected.sourceBounds);
      selected.baseCanvas = selected.canvas;
    }
    const source = core.candidateCanvas(selected);
    if (!source || (selected.sourceBounds && !selected.sourceCanvas)) return false;
    row.selectedCandidateIndex = selectedIndex;
    row.baseCanvas = selected.baseCanvas || source;
    row.sourceCanvas = selected.sourceCanvas || null;
    row.sourceFrameIndex = selected.sourceFrameIndex ?? row.sourceFrameIndex;
    row.sourceBounds = selected.sourceBounds || null;
    row.displayBounds = selected.displayBounds || selected.sourceBounds || null;
    row.sourceStaffTop = selected.sourceStaffTop ?? row.sourceStaffTop;
    row.sourceStaffBottom = selected.sourceStaffBottom ?? row.sourceStaffBottom;
    row.quality = selected.quality || row.quality;
    row.status = selected.status || row.status;
    row.completeness = selected.completeness ?? row.completeness;
    row.manualCrop = null;
    refreshRowCanvas(row, true);
    releaseInactiveFrameCanvases();
    return true;
  }

  function buildImageViewerRowCanvas(row) {
    if (!row) return null;
    // Crop handles must be able to recover pixels outside the global crop.
    return row.sourceCanvas && row.sourceBounds
      ? row.sourceCanvas
      : (row.baseCanvas || row.canvas);
  }

  function viewerCropFromRow(row) {
    const crop = row?.manualCrop;
    if (crop) {
      const top = Math.max(0, Math.min(.95, Number(crop.y) || 0));
      const bottom = Math.max(top + .05, Math.min(1, top + (Number(crop.height) || 1)));
      return { x: 0, y: top, width: 1, height: bottom - top };
    }
    if (row?.sourceCanvas && row.sourceBounds) {
      const bounds = row.displayBounds || row.sourceBounds;
      const applied = core.resolveRowCropBounds(
        row.sourceCanvas.height,
        rowTopCropPercent(bounds),
        BASE_CROP_BOTTOM + state.settings.cropBottom,
        bounds
      );
      return { x: 0, y: applied.top / row.sourceCanvas.height, width: 1,
        height: applied.height / row.sourceCanvas.height };
    }
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  function fitImageViewerImage() {
    const image = $('#imageViewerImage');
    const stage = $('#imageViewerStage');
    if (!image || !stage || !image.naturalWidth || !image.naturalHeight) return;
    const horizontalPadding = imageViewerState.kind === 'page' ? 36 : 64;
    const verticalPadding = 36;
    const maximumWidth = Math.max(1, stage.clientWidth - horizontalPadding);
    const maximumHeight = Math.max(1, stage.clientHeight - verticalPadding);
    const fitScale = imageViewerState.kind === 'page'
      ? Math.min(maximumWidth / image.naturalWidth, maximumHeight / image.naturalHeight)
      : Math.min(maximumWidth / image.naturalWidth, maximumHeight / image.naturalHeight, 1);
    image.style.width = `${Math.max(1, image.naturalWidth * fitScale)}px`;
    image.style.height = `${Math.max(1, image.naturalHeight * fitScale)}px`;
  }

  function handleImageViewerImageLoad() {
    fitImageViewerImage();
    if (imageViewerState.centerOnCrop && imageViewerState.cropMode && imageViewerState.cropRect) {
      const image = $('#imageViewerImage');
      const cropCenter = imageViewerState.cropRect.y + imageViewerState.cropRect.height / 2;
      imageViewerState.panY = (0.5 - cropCenter) * image.clientHeight * imageViewerState.zoom;
      imageViewerState.centerOnCrop = false;
    }
    updateImageViewerTransform();
    requestAnimationFrame(updateViewerCropOverlay);
  }

  function resetImageViewerTransform() {
    imageViewerState.zoom = 1;
    imageViewerState.panX = 0;
    imageViewerState.panY = 0;
    imageViewerState.centerOnCrop = false;
    fitImageViewerImage();
    updateImageViewerTransform();
  }

  function updateViewerCropOverlay() {
    const overlay = $('#imageViewerCropSelection');
    const image = $('#imageViewerImage');
    const stage = $('#imageViewerStage');
    const crop = imageViewerState.cropRect;
    if (!overlay || !image || !stage || !crop) {
      overlay?.classList.add('hidden');
      return;
    }
    const imageRect = image.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    overlay.style.left = `${imageRect.left - stageRect.left}px`;
    overlay.style.top = `${imageRect.top - stageRect.top + crop.y * imageRect.height}px`;
    overlay.style.width = `${imageRect.width}px`;
    overlay.style.height = `${crop.height * imageRect.height}px`;
    overlay.classList.remove('hidden');
    const readout = $('#imageViewerCropReadout');
    if (readout) {
      const percent = (value) => (value * 100).toFixed(1).replace(/\.0$/, '');
      const top = percent(crop.y);
      const bottom = percent(1 - crop.y - crop.height);
      readout.textContent = `上裁 ${top}% · 下裁 ${bottom}%`;
    }
  }

  function updateImageViewerTransform() {
    const image = $('#imageViewerImage');
    if (image) {
      image.style.transform = `translate(${imageViewerState.panX}px, ${imageViewerState.panY}px) scale(${imageViewerState.zoom})`;
    }
    const value = $('#imageViewerZoomValue');
    if (value) value.textContent = `${Math.round(imageViewerState.zoom * 100)}%`;
    requestAnimationFrame(updateViewerCropOverlay);
  }

  function clearViewerCropSelection() {
    imageViewerState.cropRect = null;
    imageViewerState.cropDirty = false;
    $('#imageViewerCropSelection')?.classList.add('hidden');
  }

  function setViewerCropMode(enabled) {
    if (imageViewerState.kind !== 'row') enabled = false;
    if (!enabled && imageViewerState.cropMode && imageViewerState.cropDirty) applyImageViewerCrop(true);
    imageViewerState.cropMode = !!enabled;
    imageViewerState.drag = null;
    const row = imageViewerState.kind === 'row'
      ? state.rows[imageViewerState.rowIndex]
      : null;
    const image = $('#imageViewerImage');
    if (imageViewerState.cropMode && row) {
      const sourceCanvas = buildImageViewerRowCanvas(row);
      imageViewerState.cropSourceUrl = sourceCanvas?.toDataURL
        ? sourceCanvas.toDataURL('image/png')
        : row.url;
      imageViewerState.cropRect = viewerCropFromRow(row);
      imageViewerState.cropDirty = false;
      imageViewerState.centerOnCrop = true;
      if (image) {
        image.onload = handleImageViewerImageLoad;
        image.src = imageViewerState.cropSourceUrl;
      }
      requestAnimationFrame(updateViewerCropOverlay);
    } else {
      clearViewerCropSelection();
      imageViewerState.cropSourceUrl = '';
      imageViewerState.centerOnCrop = false;
      imageViewerState.panY = 0;
      if (image && row?.url) {
        image.onload = handleImageViewerImageLoad;
        image.src = row.url;
      }
    }
    const viewer = $('#imageViewer');
    viewer?.classList.toggle('cropping', imageViewerState.cropMode);
    const toggle = $('#imageViewerCropToggle');
    toggle?.classList.toggle('active', imageViewerState.cropMode);
    if (toggle) toggle.textContent = imageViewerState.cropMode ? '隐藏裁切线 C' : '原图裁切 C';
    $('#imageViewerCropActions')?.classList.toggle('hidden', !imageViewerState.cropMode);
    const help = $('#imageViewerHelp');
    if (help) help.textContent = imageViewerState.cropMode
      ? '← → 换行 · ↑ ↓ 换候选 · 拖边界自动应用 · Alt+↑↓ 微调上边 · Alt+Shift+↑↓ 微调下边'
      : '← → 换行 · ↑ ↓ 换候选 · C 显示原图裁切线 · 滚轮缩放';
  }

  function renderImageViewer(resetTransform = true) {
    const viewer = $('#imageViewer');
    const image = $('#imageViewerImage');
    if (!viewer || !image) return;
    const isRow = imageViewerState.kind === 'row';
    const row = isRow ? state.rows[imageViewerState.rowIndex] : null;
    const source = isRow
      ? row?.url
      : imageViewerState.pageSources[imageViewerState.pageIndex];
    if (!source) return;

    viewer.classList.toggle('row-view', isRow);
    viewer.classList.toggle('page-view', !isRow);
    const caption = isRow
      ? `第 ${imageViewerState.rowIndex + 1} / ${state.rows.length} 行${row.measureNumber == null ? '' : ` · 小节 ${row.measureNumber}`}`
      : `第 ${imageViewerState.pageIndex + 1} / ${imageViewerState.pageSources.length} 页`;
    $('#imageViewerCaption').textContent = caption;
    image.alt = caption;
    image.onload = handleImageViewerImageLoad;
    image.src = source;

    const position = isRow ? imageViewerState.rowIndex : imageViewerState.pageIndex;
    const total = isRow ? state.rows.length : imageViewerState.pageSources.length;
    $('#imageViewerPrevious').disabled = position <= 0;
    $('#imageViewerNext').disabled = position >= total - 1;
    $('#imageViewerPrevious').textContent = isRow ? '← 上一行' : '← 上一页';
    $('#imageViewerNext').textContent = isRow ? '下一行 →' : '下一页 →';

    const field = $('#imageViewerCandidateField');
    field?.classList.toggle('hidden', !isRow);
    const select = $('#imageViewerCandidate');
    if (select && isRow) {
      select.innerHTML = '';
      const candidates = viewerCandidates(row);
      const active = core.selectedCandidateIndex(row, candidates);
      candidates.forEach((candidate, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = candidateOptionLabel(candidate, index);
        option.selected = index === active;
        select.appendChild(option);
      });
      select.disabled = candidates.length < 2;
    }

    $('#imageViewerCropToggle')?.classList.toggle('hidden', !isRow);
    renderHorizontalStitchTools(row);
    const horizontalNext = isRow ? followingHorizontalRow(imageViewerState.rowIndex) : null;
    const horizontalPrevious = isRow && imageViewerState.rowIndex > 0 &&
      followingHorizontalRow(imageViewerState.rowIndex - 1) === row;
    const nextLimits = horizontalNext ? horizontalBoundaryLimits(imageViewerState.rowIndex) : null;
    const previousLimits = horizontalPrevious
      ? horizontalBoundaryLimits(imageViewerState.rowIndex - 1) : null;
    $('#imageViewerHorizontalTools')?.classList.toggle('hidden',
      (imageViewerState.stitchMode && visibleHorizontalStitches(row).length > 0) ||
      (!horizontalNext && !horizontalPrevious && !row?.horizontalLastMerge));
    $('#imageViewerHorizontalNextField')?.classList.toggle('hidden', !nextLimits);
    $('#imageViewerHorizontalPreviousField')?.classList.toggle('hidden', !previousLimits);
    $('#imageViewerHorizontalMerge')?.classList.toggle('hidden', !horizontalNext ||
      (nextLimits && !horizontalPairFits(imageViewerState.rowIndex)));
    $('#imageViewerHorizontalMergePrevious')?.classList.toggle('hidden', !horizontalPrevious ||
      (previousLimits && !horizontalPairFits(imageViewerState.rowIndex - 1)));
    $('#imageViewerHorizontalUndoMerge')?.classList.toggle('hidden', !row?.horizontalLastMerge);
    if (horizontalNext) $('#imageViewerHorizontalMerge').textContent =
      nextLimits ? '合并下一行' : '连接两张原图';
    if (horizontalPrevious) $('#imageViewerHorizontalMergePrevious').textContent =
      previousLimits ? '并入上一行' : '连接两张原图';
    const horizontalSlider = $('#imageViewerHorizontalBoundary');
    if (horizontalSlider && nextLimits) {
      horizontalSlider.min = nextLimits.min;
      horizontalSlider.max = nextLimits.max;
      horizontalSlider.value = nextLimits.value;
    }
    const previousSlider = $('#imageViewerHorizontalPreviousBoundary');
    if (previousSlider && previousLimits) {
      previousSlider.min = previousLimits.min;
      previousSlider.max = previousLimits.max;
      previousSlider.value = previousLimits.value;
    }
    const reset = $('#imageViewerResetCrop');
    if (reset) reset.disabled = !row?.manualCrop;
    setViewerCropMode(isRow && !imageViewerState.stitchMode);
    if (nextLimits || previousLimits) {
      $('#imageViewerHelp').textContent += ' · Alt+←→ 调下一行切点 · Alt+Shift+←→ 调上一行切点';
    }
    if (isRow && visibleHorizontalStitches(row).length) {
      $('#imageViewerHelp').textContent += ' · S 检查原图拼接 · [ ] 调拼接点';
    }
    if (resetTransform) {
      resetImageViewerTransform();
    }
  }

  function openRowImageViewer(index) {
    if (!state.rows[index]?.url) return;
    imageViewerState.kind = 'row';
    imageViewerState.rowIndex = index;
    imageViewerState.pageSources = [];
    renderImageViewer(true);
    $('#imageViewer').classList.remove('hidden');
    document.body.classList.add('viewer-open');
    requestAnimationFrame(updateViewerCropOverlay);
    $('#imageViewerClose')?.focus();
  }

  function openImageViewer(source, caption, options = {}) {
    if (!source) return;
    imageViewerState.kind = 'page';
    imageViewerState.pageSources = options.sources?.length ? options.sources : [source];
    imageViewerState.pageIndex = Math.max(0, Math.min(imageViewerState.pageSources.length - 1, options.index || 0));
    renderImageViewer(true);
    $('#imageViewer').classList.remove('hidden');
    document.body.classList.add('viewer-open');
    $('#imageViewerClose')?.focus();
  }

  function closeImageViewer() {
    const viewer = $('#imageViewer');
    if (!viewer) return;
    if (imageViewerState.cropMode && imageViewerState.cropDirty) applyImageViewerCrop(true);
    viewer.classList.add('hidden');
    viewer.classList.remove('cropping', 'row-view', 'page-view');
    document.body.classList.remove('viewer-open');
    imageViewerState.drag = null;
    imageViewerState.cropMode = false;
    imageViewerState.stitchMode = false;
    imageViewerState.stitchIndex = null;
    clearViewerCropSelection();
    const image = $('#imageViewerImage');
    if (image) image.removeAttribute('src');
  }

  function moveImageViewer(delta) {
    if (imageViewerState.cropMode && imageViewerState.cropDirty) applyImageViewerCrop(true);
    if (imageViewerState.kind === 'row') {
      imageViewerState.rowIndex = Math.max(0, Math.min(state.rows.length - 1, imageViewerState.rowIndex + delta));
    } else {
      imageViewerState.pageIndex = Math.max(0, Math.min(imageViewerState.pageSources.length - 1, imageViewerState.pageIndex + delta));
    }
    renderImageViewer(true);
  }

  async function cycleImageViewerCandidate(delta) {
    if (imageViewerState.kind !== 'row') return;
    const row = state.rows[imageViewerState.rowIndex];
    const candidates = viewerCandidates(row);
    if (candidates.length < 2) return;
    const select = $('#imageViewerCandidate');
    const shownIndex = Number(select?.value);
    const current = Number.isInteger(shownIndex) && shownIndex >= 0 && shownIndex < candidates.length
      ? shownIndex : core.selectedCandidateIndex(row, candidates);
    const next = (current + delta + candidates.length) % candidates.length;
    if (select) select.value = String(next);
    try {
      const applied = await applyCandidateSelection(row, next);
      if (applied) {
        renderReview();
        renderImageViewer(false);
      } else if (applied === false && select) {
        select.value = String(row.selectedCandidateIndex);
        toast('无法加载这张候选画面');
      }
    } catch (error) {
      console.warn('candidate restore failed', error);
      if (select) select.value = String(row.selectedCandidateIndex);
      toast('无法加载这张候选画面');
    }
  }

  function changeImageViewerZoom(factor) {
    imageViewerState.zoom = Math.max(0.5, Math.min(8, imageViewerState.zoom * factor));
    updateImageViewerTransform();
  }

  function viewerImagePoint(event, allowOutside = false) {
    const image = $('#imageViewerImage');
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (!allowOutside && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  function startImageViewerPointer(event) {
    if (event.button !== 0) return;
    const viewport = $('#imageViewerViewport');
    if (imageViewerState.cropMode) {
      const point = viewerImagePoint(event);
      const crop = imageViewerState.cropRect;
      const imageRect = $('#imageViewerImage')?.getBoundingClientRect();
      if (point && crop && imageRect) {
        const topDistance = Math.abs(event.clientY - (imageRect.top + crop.y * imageRect.height));
        const bottomDistance = Math.abs(event.clientY - (imageRect.top + (crop.y + crop.height) * imageRect.height));
        const hitArea = 24;
        if (Math.min(topDistance, bottomDistance) <= hitArea) {
          imageViewerState.drag = { type: 'crop-edge', edge: topDistance <= bottomDistance ? 'top' : 'bottom' };
        }
      }
    }
    if (!imageViewerState.drag) {
      imageViewerState.drag = {
        type: 'pan', x: event.clientX, y: event.clientY,
        panX: imageViewerState.panX, panY: imageViewerState.panY,
      };
    }
    viewport?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveImageViewerPointer(event) {
    const drag = imageViewerState.drag;
    if (!drag) return;
    if (drag.type === 'pan') {
      imageViewerState.panX = drag.panX + event.clientX - drag.x;
      imageViewerState.panY = drag.panY + event.clientY - drag.y;
      updateImageViewerTransform();
    } else if (drag.type === 'crop-edge') {
      const point = viewerImagePoint(event, true);
      const crop = imageViewerState.cropRect;
      if (!point || !crop) return;
      const minimumHeight = .05;
      const currentTop = crop.y;
      const currentBottom = crop.y + crop.height;
      if (drag.edge === 'top') {
        const nextTop = Math.max(0, Math.min(currentBottom - minimumHeight, point.y));
        imageViewerState.cropRect = { x: 0, y: nextTop, width: 1, height: currentBottom - nextTop };
      } else {
        const nextBottom = Math.min(1, Math.max(currentTop + minimumHeight, point.y));
        imageViewerState.cropRect = { x: 0, y: currentTop, width: 1, height: nextBottom - currentTop };
      }
      imageViewerState.cropDirty = true;
      updateViewerCropOverlay();
    }
    event.preventDefault();
  }

  function endImageViewerPointer(event) {
    const drag = imageViewerState.drag;
    if (!drag) return;
    imageViewerState.drag = null;
    const viewport = $('#imageViewerViewport');
    if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (drag.type === 'crop-edge' && imageViewerState.cropDirty) applyImageViewerCrop(true);
  }

  function applyImageViewerCrop(silent = false) {
    const row = state.rows[imageViewerState.rowIndex];
    const crop = imageViewerState.cropRect;
    if (!row || !crop || crop.height < 0.05) return;
    row.manualCrop = crop.y < 0.0001 && crop.height > 0.9999
      ? null
      : { x: 0, y: crop.y, width: 1, height: crop.height };
    imageViewerState.cropDirty = false;
    refreshRowCanvas(row, true);
    renderReview();
    const reset = $('#imageViewerResetCrop');
    if (reset) reset.disabled = !row.manualCrop;
    if (!silent) toast('已调整这一行的上下高度，并同步更新 A4 预览');
  }

  function nudgeImageViewerCrop(edge, direction) {
    if (imageViewerState.kind !== 'row') return;
    if (!imageViewerState.cropMode) setViewerCropMode(true);
    const crop = imageViewerState.cropRect;
    if (!crop) return;
    const step = 0.005;
    const top = crop.y;
    const bottom = crop.y + crop.height;
    if (edge === 'top') {
      const next = Math.max(0, Math.min(bottom - 0.05, top + direction * step));
      imageViewerState.cropRect = { x: 0, y: next, width: 1, height: bottom - next };
    } else {
      const next = Math.max(top + 0.05, Math.min(1, bottom + direction * step));
      imageViewerState.cropRect = { x: 0, y: top, width: 1, height: next - top };
    }
    imageViewerState.cropDirty = true;
    updateViewerCropOverlay();
  }

  function resetImageViewerCrop() {
    const row = state.rows[imageViewerState.rowIndex];
    if (!row) return;
    row.manualCrop = null;
    imageViewerState.cropRect = viewerCropFromRow(row);
    imageViewerState.cropDirty = false;
    refreshRowCanvas(row, true);
    renderReview();
    const reset = $('#imageViewerResetCrop');
    if (reset) reset.disabled = true;
    updateViewerCropOverlay();
    toast('已恢复外部设置的裁切范围');
  }

  function renderRows() {
    const list = $('#thumbnailList');
    list.innerHTML = '';

    $('#rowCountLabel').textContent =
      `${state.rows.length} 行 · ` +
      `${state.rows.filter((row) => row.included).length} 行保留`;

    if (!state.rows.length) {
      list.innerHTML =
        '<div class="empty-rows">还没有可预览的谱行</div>';
      return;
    }

    const chronological = state.captureGroups.length > 0 ||
      core.isSingleLineCapture(state.settings.mode, state.rawSequences);
    state.rows.forEach((row, index) => {
      const item = document.createElement('article');
      const followingHorizontal = followingHorizontalRow(index);
      const previousHorizontal = index > 0 && followingHorizontalRow(index - 1) === row;
      const horizontalLimits = horizontalBoundaryLimits(index);
      const previousHorizontalLimits = previousHorizontal
        ? horizontalBoundaryLimits(index - 1) : null;

      item.className =
        `row-card` +
        `${chronological ? ' sequential' : ''}` +
        `${row.included ? '' : ' excluded'}` +
        `${row.status !== 'complete' ? ' pending' : ''}`;

      const measureLabel = chronological
        ? ''
        : row.isUnnumberedOpening && row.measureNumber === 1
          ? '小节 1 · 开头推定'
          : row.measureNumber == null
            ? (row.isUnnumberedOpening ? '无编号开头 · 已保留' : '未识别小节号 · 按原顺序保留')
            : `小节 ${row.measureNumber}`;

      const cursor = chronological ? '' : cursorText(row);

      item.innerHTML = `
        <div class="row-card-head">
          <span class="row-index">
            ${String(index + 1).padStart(2, '0')}
          </span>
          <span class="row-status">
            ${statusText(row)}
          </span>
          ${row.autoSectionStart ? '<span class="row-section-start">段落起行</span>' : ''}
          <span class="row-confidence">
            ${Math.round((row.completeness || 0) * 100)}%
          </span>
        </div>

        <div class="row-card-body">
          <img alt="第 ${index + 1} 行谱面">
          ${chronological ? '' : `<div class="row-card-meta">
            <strong>${measureLabel}</strong>
            <small>${cursor || '结构已对齐'}</small>
          </div>`}
        </div>

        <div class="row-card-controls">
          <label class="section-marker-field">
            <span>段落标识</span>
            <input
              class="section-marker-input"
              maxlength="12"
              autocomplete="off"
              placeholder="如 A / B / Chorus"
            >
          </label>

          <label class="repeat-mark-field">
            <span>反复记号</span>
            <select class="repeat-mark-select">
              <option value="none">无</option>
              <option value="start">行首反复</option>
              <option value="end">行末反复</option>
              <option value="both">首尾反复</option>
            </select>
          </label>

          <label class="repeat-count-field">
            <span>反复次数</span>
            <input
              class="repeat-count-input"
              type="number"
              inputmode="numeric"
              min="2"
              max="99"
              step="1"
              placeholder="如 2"
            >
          </label>

          <label class="candidate-field">
            <span>画面候选</span>
            <select class="candidate-select"></select>
          </label>
        </div>

        ${row.horizontalSource && (followingHorizontal || previousHorizontal || row.horizontalLastMerge) ? `<div class="horizontal-row-tools">
          ${previousHorizontalLimits ? `<label>与上一行切点 <input class="horizontal-boundary-previous" type="range"
            min="${previousHorizontalLimits.min}" max="${previousHorizontalLimits.max}"
            value="${previousHorizontalLimits.value}" step="1"></label>` : ''}
          ${horizontalLimits ? `<label>与下一行切点 <input class="horizontal-boundary" type="range"
            min="${horizontalLimits.min}" max="${horizontalLimits.max}"
            value="${horizontalLimits.value}" step="1"></label>` : ''}
          ${previousHorizontal && (!previousHorizontalLimits || horizontalPairFits(index - 1)) ? `<button type="button" class="horizontal-merge-previous">${previousHorizontalLimits ? '并入上一行' : '连接两张原图'}</button>` : ''}
          ${followingHorizontal && (!horizontalLimits || horizontalPairFits(index)) ? `<button type="button" class="horizontal-merge">${horizontalLimits ? '合并下一行' : '连接两张原图'}</button>` : ''}
          ${row.horizontalLastMerge ? '<button type="button" class="horizontal-undo-merge">拆回两行</button>' : ''}
        </div>` : ''}

        <div class="row-card-actions">
          <button type="button" data-action="toggle">
            ${row.included ? '排除这一行' : '保留这一行'}
          </button>

          <button
            type="button"
            data-action="up"
            ${index === 0 ? 'disabled' : ''}
          >
            上移
          </button>

          <button
            type="button"
            data-action="down"
            ${
              index === state.rows.length - 1
                ? 'disabled'
                : ''
            }
          >
            下移
          </button>
        </div>
      `;

      const rowImage = item.querySelector('img');
      rowImage.src = row.url || '';
      rowImage.title = '点击查看原尺寸图片';
      rowImage.addEventListener('click', () => {
        openRowImageViewer(index);
      });

      const horizontalBoundary = item.querySelector('.horizontal-boundary');
      horizontalBoundary?.addEventListener('input', () => {
        if (!setHorizontalBoundary(index, horizontalBoundary.value)) {
          horizontalBoundary.value = horizontalBoundaryLimits(index)?.value ?? row.horizontalEnd;
          return;
        }
        horizontalBoundary.value = row.horizontalEnd;
        rowImage.src = row.url;
        const nextImage = list.children[index + 1]?.querySelector('.row-card-body img');
        if (nextImage) nextImage.src = followingHorizontal.url;
        renderPages();
      });
      horizontalBoundary?.addEventListener('change', renderReview);
      const previousBoundary = item.querySelector('.horizontal-boundary-previous');
      previousBoundary?.addEventListener('input', () => {
        if (!setHorizontalBoundary(index - 1, previousBoundary.value)) {
          previousBoundary.value = horizontalBoundaryLimits(index - 1)?.value ??
            state.rows[index - 1].horizontalEnd;
          return;
        }
        previousBoundary.value = state.rows[index - 1].horizontalEnd;
        rowImage.src = row.url;
        const previousImage = list.children[index - 1]?.querySelector('.row-card-body img');
        if (previousImage) previousImage.src = state.rows[index - 1].url;
        renderPages();
      });
      previousBoundary?.addEventListener('change', renderReview);
      item.querySelector('.horizontal-merge')?.addEventListener('click', () => {
        mergeFollowingHorizontalRow(index);
      });
      item.querySelector('.horizontal-merge-previous')?.addEventListener('click', () => {
        mergePreviousHorizontalRow(index);
      });
      item.querySelector('.horizontal-undo-merge')?.addEventListener('click', () => {
        undoHorizontalMerge(index);
      });

      const sectionMarkerInput = item.querySelector('.section-marker-input');
      sectionMarkerInput.value = row.sectionMarker || '';
      sectionMarkerInput.addEventListener('input', (event) => {
        row.sectionMarker = event.target.value.slice(0, 12);
        renderPages();
      });
      sectionMarkerInput.addEventListener('change', (event) => {
        row.sectionMarker = event.target.value.trim().slice(0, 12);
        event.target.value = row.sectionMarker;
        renderReview();
      });

      const repeatMarkSelect = item.querySelector('.repeat-mark-select');
      repeatMarkSelect.value = ['start', 'end', 'both'].includes(row.repeatMark)
        ? row.repeatMark : 'none';
      repeatMarkSelect.addEventListener('change', () => {
        row.repeatMark = repeatMarkSelect.value;
        renderPages();
      });

      const repeatCountInput = item.querySelector('.repeat-count-input');
      repeatCountInput.value = Number.isFinite(Number(row.repeatCount)) && Number(row.repeatCount) >= 2
        ? Math.round(Number(row.repeatCount)) : '';
      repeatCountInput.addEventListener('input', () => {
        const value = Math.round(Number(repeatCountInput.value));
        row.repeatCount = Number.isFinite(value) && value >= 2
          ? Math.min(99, value) : null;
        renderPages();
      });
      repeatCountInput.addEventListener('change', () => {
        if (row.repeatCount == null) {
          repeatCountInput.value = '';
        } else {
          row.repeatCount = Math.max(2, Math.min(99, Math.round(Number(row.repeatCount))));
          repeatCountInput.value = row.repeatCount;
        }
        renderPages();
      });

      const candidateSelect =
        item.querySelector('.candidate-select');

      const candidates = row.candidates?.length
        ? row.candidates
        : [row];

      const activeCandidateIndex = core.selectedCandidateIndex(row, candidates);
      row.selectedCandidateIndex = activeCandidateIndex;

      candidates.forEach(
        (candidate, candidateIndex) => {
          const option =
            document.createElement('option');

          option.value = candidateIndex;
          option.textContent = candidateOptionLabel(candidate, candidateIndex);

          option.selected = candidateIndex === activeCandidateIndex;

          candidateSelect.appendChild(option);
        }
      );

      candidateSelect.addEventListener(
        'change',
        async () => {
          try {
            const applied = await applyCandidateSelection(row, Number(candidateSelect.value));
            if (applied) {
              renderReview();
            } else if (applied === false) {
              candidateSelect.value = String(row.selectedCandidateIndex);
              toast('无法加载这张候选画面');
            }
          } catch (error) {
            console.warn('candidate restore failed', error);
            toast('无法加载这张候选画面');
          }
        }
      );

      item
        .querySelectorAll('[data-action]')
        .forEach((button) => {
          button.addEventListener('click', () => {
            const action = button.dataset.action;

            if (action === 'toggle') {
              row.included = !row.included;
            }

            if (action === 'up' && index > 0) {
              [
                state.rows[index - 1],
                state.rows[index],
              ] = [
                state.rows[index],
                state.rows[index - 1],
              ];
            }

            if (
              action === 'down' &&
              index < state.rows.length - 1
            ) {
              [
                state.rows[index + 1],
                state.rows[index],
              ] = [
                state.rows[index],
                state.rows[index + 1],
              ];
            }

            renderReview();
          });
        });

      list.appendChild(item);
    });
  }

  function renderWarnings() {
    const container = $('#rowWarnings');
    if (!state.warnings.length) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }
    const grouped = new Map();
    state.warnings.forEach((warning) => {
      const key = warning.type || warning.message;
      if (!grouped.has(key)) grouped.set(key, { ...warning, count: 0 });
      grouped.get(key).count += warning.count || 1;
    });
    container.classList.remove('hidden');
    container.innerHTML = [...grouped.values()].map((warning) => {
      const suffix = warning.count > 1 && !/\d+\s*(?:次|处)/.test(warning.message)
        ? `（${warning.count} 次）`
        : '';
      return `<div class="warning-line"><i></i><span>${warning.message}${suffix}</span></div>`;
    }).join('');
  }

  function renderPages() {
    const container = $('#pagePreview');
    container.innerHTML = '';

    const included =
      state.rows.filter((row) => row.included);

    if (!included.length) {
      $('#pageCountLabel').textContent = '0 页';

      container.innerHTML =
        '<div class="empty-pages">' +
        '保留至少一行后，这里会显示 A4 页面' +
        '</div>';

      return;
    }

    const title =
      $('#titleInput').value.trim() || '鼓谱';

    const rendered =
      pdf.renderPageCanvases(
        included,
        title,
        {
          scale: 1,
          rowGap: state.settings.rowGap,
          scoreScale: state.settings.scoreScale,
          titleSize: state.settings.titleSize,
          tempo: Number($('#tempoInput')?.value) || null,
        }
      );

    $('#pageCountLabel').textContent =
      `${rendered.canvases.length} 页`;

    const pageSources = rendered.canvases.map((canvas) => canvas.toDataURL('image/png'));

    rendered.canvases.forEach((canvas, index) => {
      const card = document.createElement('div');
      card.className = 'page-card';

      const label = document.createElement('span');
      label.textContent = `第 ${index + 1} 页`;

      canvas.title = '点击查看完整页面';
      canvas.addEventListener('click', () => {
        openImageViewer(pageSources[index], `第 ${index + 1} 页`, { sources: pageSources, index });
      });

      card.append(label, canvas);
      container.appendChild(card);
    });
  }

  function renderReview() {
    renderRows();
    renderWarnings();
    renderPages();
  }

  function selectAllRows() {
    state.rows.forEach((row) => {
      row.included = true;
    });

    renderReview();
  }

  function readSettingsFromControls() {
    state.settings.mode = $('#modeInput').value;

    state.settings.cropTop =
      Number($('#cropTopInput').value) || 0;

    state.settings.cropBottom =
      Number($('#cropBottomInput').value) || 0;

    state.settings.rowGap =
      Number($('#rowGapInput').value) || 0;

    state.settings.scoreScale =
      (Number($('#scoreScaleInput').value) || 100) / 100;

    state.settings.titleSize =
      Number($('#titleSizeInput').value) || 42;

    state.settings.dedupeStrength =
      (Number($('#dedupeInput').value) || 72) / 100;

    state.settings.removeColorArtifacts =
      $('#removeColorInput').checked;
  }

  function writeSettingsToControls() {
    $('#sourceModeInput').value = state.settings.mode;
    $('#sourceInkInput').value = state.settings.sourceInk || 'dark';
    $('#modeInput').value = state.settings.mode;
    $('#cropTopInput').value = state.settings.cropTop;
    $('#cropBottomInput').value = state.settings.cropBottom;
    $('#rowGapInput').value = state.settings.rowGap;
    $('#rowGapNumberInput').value = state.settings.rowGap;

    $('#scoreScaleInput').value =
      Math.round(state.settings.scoreScale * 100);

    $('#titleSizeInput').value = state.settings.titleSize || 42;

    $('#dedupeInput').value =
      Math.round(state.settings.dedupeStrength * 100);

    $('#removeColorInput').checked =
      state.settings.removeColorArtifacts;

    updateSettingLabels();
  }

  function formatCropAdjustment(value) {
    const number = Number(value) || 0;
    return `${number > 0 ? '+' : ''}${number}%`;
  }

  function updateSettingLabels() {
    $('#cropTopValue').textContent =
      formatCropAdjustment($('#cropTopInput').value);

    $('#cropBottomValue').textContent =
      formatCropAdjustment($('#cropBottomInput').value);

    $('#rowGapValue').textContent =
      `${$('#rowGapInput').value} px`;

    $('#scoreScaleValue').textContent =
      `${$('#scoreScaleInput').value}%`;

    $('#titleSizeValue').textContent =
      `${$('#titleSizeInput').value} px`;

    $('#dedupeValue').textContent =
      `${$('#dedupeInput').value}%`;
  }

  const liveSettingsPreview = {
    frame: 0,
    cropChanged: false,
    layoutChanged: false,
  };

  function readLivePreviewSettings() {
    state.settings.cropTop = Number($('#cropTopInput').value) || 0;
    state.settings.cropBottom = Number($('#cropBottomInput').value) || 0;
    state.settings.rowGap = Number($('#rowGapInput').value) || 0;
    state.settings.scoreScale = (Number($('#scoreScaleInput').value) || 100) / 100;
    state.settings.titleSize = Number($('#titleSizeInput').value) || 42;
  }

  function updateRowPreviewImages() {
    const images = $$('#thumbnailList .row-card-body img');
    state.rows.forEach((row, index) => {
      if (images[index] && row.url) images[index].src = row.url;
    });
  }

  function scheduleLiveSettingsPreview({ crop = false, layout = false } = {}) {
    updateSettingLabels();
    readLivePreviewSettings();
    liveSettingsPreview.cropChanged ||= crop;
    liveSettingsPreview.layoutChanged ||= layout || crop;
    if (liveSettingsPreview.frame) cancelAnimationFrame(liveSettingsPreview.frame);
    liveSettingsPreview.frame = requestAnimationFrame(() => {
      liveSettingsPreview.frame = 0;
      if (liveSettingsPreview.cropChanged) {
        state.rows.forEach((row) => refreshRowCanvas(row, true));
        updateRowPreviewImages();
      }
      if (liveSettingsPreview.layoutChanged) renderPages();
      liveSettingsPreview.cropChanged = false;
      liveSettingsPreview.layoutChanged = false;
    });
  }

  function setRowGapFromNumber() {
    const numberInput = $('#rowGapNumberInput');
    const value = Math.max(0, Math.min(160, Number(numberInput.value) || 0));
    numberInput.value = value;
    $('#rowGapInput').value = value;
    scheduleLiveSettingsPreview({ layout: true });
  }

  async function applySettings() {
    const previous = { ...state.settings };

    readSettingsFromControls();
    updateSettingLabels();

    const modeChanged = previous.mode !== state.settings.mode;
    const dedupeChanged = previous.dedupeStrength !== state.settings.dedupeStrength;
    const pixelsChanged = previous.cropTop !== state.settings.cropTop ||
      previous.cropBottom !== state.settings.cropBottom ||
      previous.removeColorArtifacts !== state.settings.removeColorArtifacts;
    const layoutChanged = previous.rowGap !== state.settings.rowGap ||
      previous.scoreScale !== state.settings.scoreScale ||
      previous.titleSize !== state.settings.titleSize;

    if (state.frames.length && (modeChanged || (dedupeChanged && state.captureMemoryCompacted))) {
      showView('review');
      await restoreArchivedFrames();
      await processFrames(state.frames);
      toast(modeChanged ? '已按新模式重新整理' : '已重新去重并整理');
      return;
    }

    if (state.rawSequences.length && dedupeChanged) {
      rebuildFromRaw();
      await recognizeAndSortRows();
      state.rows.forEach((row) => refreshRowCanvas(row, true));
      renderReview();
      toast(state.captureGroups.length || core.isSingleLineCapture(state.settings.mode, state.rawSequences)
        ? '已重新去重并保持画面时间顺序'
        : '已重新去重并恢复小节号排序');
      return;
    }

    if (pixelsChanged) {
      state.rows.forEach((row) => refreshRowCanvas(row, true));
      renderReview();
    } else if (layoutChanged) {
      renderPages();
    } else {
      renderReview();
    }
    toast('参数已应用，右侧页面预览已刷新');
  }

  async function resetSettings() {
    const previous = { ...state.settings };
    state.settings = { ...DEFAULTS };
    writeSettingsToControls();

    if (state.frames.length && (previous.mode !== state.settings.mode ||
      (previous.dedupeStrength !== state.settings.dedupeStrength && state.captureMemoryCompacted))) {
      await restoreArchivedFrames();
      await processFrames(state.frames);
    } else if (state.rawSequences.length && previous.dedupeStrength !== state.settings.dedupeStrength) {
      rebuildFromRaw();
      await recognizeAndSortRows();
      state.rows.forEach((row) => refreshRowCanvas(row, true));
      renderReview();
    } else {
      state.rows.forEach((row) => refreshRowCanvas(row, true));
      renderReview();
    }

    toast('已恢复默认参数');
  }

  async function exportPdf() {
    const rows =
      state.rows.filter((row) => row.included);

    if (!rows.length) {
      toast('至少保留一行谱面');
      return;
    }

    const title =
      $('#titleInput').value.trim() || '鼓谱';

    try {
      const rendered =
        pdf.renderPageCanvases(
          rows,
          title,
          {
            scale: 2,
            rowGap: state.settings.rowGap,
            scoreScale: state.settings.scoreScale,
            titleSize: state.settings.titleSize,
          tempo: Number($('#tempoInput')?.value) || null,
          }
        );

      const blob =
        await pdf.canvasesToPdf(
          rendered.canvases,
          { quality: 0.97 }
        );

      pdf.download(
        blob,
        `${safeName(title)}.pdf`
      );

      toast(
        `清晰图片 PDF 已生成，共 ${rendered.canvases.length} 页`
      );
    } catch (error) {
      toast(`PDF 生成失败：${error.message}`);
    }
  }

  function base64ToBlob(encoded, mime) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);

    for (
      let index = 0;
      index < binary.length;
      index += 1
    ) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new Blob(
      [bytes],
      {
        type: mime || 'application/octet-stream',
      }
    );
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result), { once: true });
      reader.addEventListener('error', () => reject(reader.error || new Error('无法读取 PDF')), { once: true });
      reader.readAsDataURL(blob);
    });
  }

  async function musescoreExport() {
    const rows = state.rows.filter((row) => row.included);
    if (!rows.length) {
      toast('至少保留一行谱面');
      return;
    }
    const button = $('#musescoreButton');
    button.disabled = true;
    state.omrDownloads = [];
    renderOmrDownloads();
    setOmrStatus('正在生成与 PDF 预览完全相同的整份文档…', 'busy');
    try {
      const title = $('#titleInput').value.trim() || '鼓谱';
      const rendered = pdf.renderPageCanvases(rows, title, {
        scale: 2,
        rowGap: state.settings.rowGap,
        scoreScale: state.settings.scoreScale,
        titleSize: state.settings.titleSize,
        tempo: Number($("#tempoInput")?.value) || null,
      });
      const documentBlob = await pdf.canvasesToPdf(rendered.canvases, { quality: 0.97 });
      const dataUrl = await blobToDataUrl(documentBlob);
      setOmrStatus(`正在把完整 ${rendered.canvases.length} 页 PDF 作为一个工程交给 Audiveris…`, 'busy');
      const response = await fetch(`${API_BASE}/api/omr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          document: {
            name: `${safeName(title)}.pdf`,
            dataUrl,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        const reason = payload.reason || 'Audiveris 未生成 MusicXML';
        setOmrStatus(reason, 'warn');
        toast(reason);
        return;
      }
      state.omrDownloads = payload.downloads || [];
      renderOmrDownloads();
      const message = state.omrDownloads.length
        ? `识别完成；Audiveris 收到的是完整 ${rendered.canvases.length} 页 PDF，请点击下方按钮下载`
        : (payload.message || '识别完成，但没有可下载文件');
      setOmrStatus(message, state.omrDownloads.length ? 'ok' : 'warn');
      toast(state.omrDownloads.length ? '识别完成，可以下载 MuseScore 文件' : message);
    } catch (error) {
      setOmrStatus('本地识别服务没有响应，请重新双击启动桌面窗口.cmd', 'warn');
      toast(`MuseScore 导出失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function renderOmrDownloads() {
    const container = $('#omrDownloads');
    if (!container) return;
    container.innerHTML = '';
    container.classList.toggle('hidden', !state.omrDownloads.length);
    state.omrDownloads.forEach((file, index) => {
      const link = document.createElement('a');
      link.className = index === 0 ? 'omr-download primary' : 'omr-download';
      link.href = `${API_BASE}${file.url}`;
      link.download = file.name || '';
      link.textContent = file.label || `下载 ${file.name}`;
      container.appendChild(link);
    });
  }

  function setOmrStatus(message, tone = '') {
    const element = $('#omrStatus');
    element.className = `omr-status ${tone}`;
    element.querySelector('span').textContent = message;
  }

  async function checkOmrStatus() {
    try {
      const response = await fetch(
        `${API_BASE}/api/tools`,
        {
          cache: 'no-store',
        }
      );

      const tools = await response.json();
      state.omrTools = tools;

      if (!tools.audiveris?.available) {
        setOmrStatus(
          '基础 PDF 可用；Audiveris 未安装，' +
          '实验性 MusicXML 暂不可用' +
          (
            tools.musescore?.available
              ? '（已找到 MuseScore）'
              : ''
          ),
          'warn'
        );
      } else {
        setOmrStatus(
          `已找到 Audiveris${
            tools.musescore?.available
              ? ' 和 MuseScore'
              : ''
          }，可尝试生成可编辑谱`,
          'ok'
        );
      }
    } catch (error) {
      setOmrStatus(
        '未连接本地 OMR 服务；基础图片 PDF 不受影响',
        ''
      );
    }
  }

  function safeName(name) {
    return (
      name
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 80) || '鼓谱'
    );
  }

  function restart() {
    clearInterval(state.timer);
    cancelAnimationFrame(state.previewLoop);

    if (state.videoDownloadJob) void cancelVideoDownload();
    state.videoDownloadJob = null;
    $('#videoUrlButton').disabled = false;
    $('#videoDownloadStatus').classList.add('hidden');

    clearVideoSource();

    state.stream = null;
    state.frames = [];
    state.captureGroups = [];
    state.rows = [];
    state.rawSequences = [];
    state.captureMemoryCompacted = false;
    state.scrollingCapture = false;
    state.adjacentCapture = false;
    state.warnings = [];
    state.scoreMetadata = null;
    state.titleUserEdited = false;
    state.tempoUserEdited = false;
    if ($('#titleInput')) $('#titleInput').value = '鼓谱';
    if ($('#tempoInput')) $('#tempoInput').value = '';
    state.recording = false;
    state.crop = null;
    state.cropReference = null;
    state.cropNormalized = null;
    state.captureSourceInfo = null;
    state.omrDownloads = [];
    renderOmrDownloads();
    closeImageViewer();

    $('#sourceEmpty')?.classList.remove('hidden');
    $('#framingPanel')?.classList.add('hidden');
    $('#processingPanel')?.classList.remove('hidden');
    $('#reviewPanel')?.classList.add('hidden');
    $('#captureView').classList.remove('recording');
    $('#recordButton').classList.remove('hidden');
    $('#stopButton').classList.add('hidden');
    $('#captureCount').textContent = '0';
    if ($('#captureUnit')) $('#captureUnit').textContent = '段画面';
    $('#captureState span').textContent = '等待开始';
    $('#folderInput').value = '';
    $('#videoInput').value = '';
    $('#videoFramePicker')?.classList.add('hidden');
    configureCaptureSourceUi();

    showView('source');
  }

  $('#restoreCaptureButton')?.addEventListener('click', restoreSavedCapture);

  $('#shareButton').addEventListener(
    'click',
    chooseVideo
  );

  $('#autoRegionButton').addEventListener(
    'click',
    autoDetectRegion
  );

  $('#confirmRegionButton').addEventListener(
    'click',
    confirmRegion
  );

  $('#recordButton').addEventListener(
    'click',
    startRecording
  );

  $('#stopButton').addEventListener(
    'click',
    stopRecording
  );

  $('#folderInput').addEventListener(
    'change',
    importFolder
  );

  $('#videoInput').addEventListener(
    'change',
    importVideo
  );

  $('#videoUrlButton').addEventListener('click', downloadVideoByUrl);
  $('#videoUrlInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') downloadVideoByUrl();
  });
  $('#videoDownloadCancel').addEventListener('click', cancelVideoDownload);

  $('#videoSeekInput')?.addEventListener('input', (event) => {
    const value = Number(event.target.value) || 0;
    updateVideoSeekLabel(value);
    clearTimeout(state.videoSeekTimer);
    state.videoSeekTimer = setTimeout(async () => {
      if (state.sourceKind !== 'file' || state.recording) return;
      try {
        await seekVideo(value);
      } catch (error) {
        toast(error.message || '无法定位视频画面');
      }
    }, 90);
  });

  $('#selectAllButton').addEventListener(
    'click',
    selectAllRows
  );

  $('#toggleAdvancedButton').addEventListener(
    'click',
    () => $('#advancedPanel').classList.toggle('hidden')
  );

  $('#applySettingsButton').addEventListener(
    'click',
    applySettings
  );

  $('#resetSettingsButton').addEventListener(
    'click',
    resetSettings
  );

  $('#exportButton').addEventListener(
    'click',
    exportPdf
  );

  $('#musescoreButton').addEventListener(
    'click',
    musescoreExport
  );

  $('#imageViewerClose')?.addEventListener('click', closeImageViewer);
  $('#imageViewerPrevious')?.addEventListener('click', () => moveImageViewer(-1));
  $('#imageViewerNext')?.addEventListener('click', () => moveImageViewer(1));
  $('#imageViewerZoomOut')?.addEventListener('click', () => changeImageViewerZoom(1 / 1.2));
  $('#imageViewerZoomIn')?.addEventListener('click', () => changeImageViewerZoom(1.2));
  $('#imageViewerFit')?.addEventListener('click', resetImageViewerTransform);
  $('#imageViewerCropToggle')?.addEventListener('click', () => {
    if (imageViewerState.stitchMode) {
      imageViewerState.stitchMode = false;
      renderImageViewer(false);
    } else setViewerCropMode(!imageViewerState.cropMode);
  });
  $('#imageViewerResetCrop')?.addEventListener('click', resetImageViewerCrop);
  $('#imageViewerStitchToggle')?.addEventListener('click', () => {
    imageViewerState.stitchMode = !imageViewerState.stitchMode;
    if (imageViewerState.stitchMode && imageViewerState.cropMode) setViewerCropMode(false);
    renderImageViewer(false);
  });
  $('#imageViewerStitchSelect')?.addEventListener('change', (event) => {
    imageViewerState.stitchIndex = Number(event.target.value);
    renderHorizontalStitchTools(state.rows[imageViewerState.rowIndex]);
  });
  $('#imageViewerStitchBoundary')?.addEventListener('input', (event) => {
    const selected = selectedHorizontalStitch(state.rows[imageViewerState.rowIndex]);
    if (!selected) return;
    const x = `${100 * Number(event.target.value) / Math.max(1, selected.frame.overlap)}%`;
    $$('#imageViewerStitchTools .stitch-line').forEach((line) => { line.style.left = x; });
    $('#imageViewerStitchReadout').textContent = `${event.target.value} / ${selected.frame.overlap} px · 待应用`;
  });
  $('#imageViewerStitchBoundary')?.addEventListener('change', async (event) => {
    try {
      if (await applyHorizontalStitch(event.target.value)) renderReview();
    } catch (error) {
      console.warn('调整拼接点失败', error);
      toast('无法调整这个拼接点，请恢复录制后重试');
    }
    renderImageViewer(false);
  });
  $('#imageViewerStitchReset')?.addEventListener('click', async () => {
    const selected = selectedHorizontalStitch(state.rows[imageViewerState.rowIndex]);
    if (!selected) return;
    if (await applyHorizontalStitch(selected.frame.autoSeam)) {
      renderReview();
      renderImageViewer(false);
    }
  });
  $('#imageViewerHorizontalBoundary')?.addEventListener('input', (event) => {
    const index = imageViewerState.rowIndex;
    if (!setHorizontalBoundary(index, event.target.value)) {
      event.target.value = horizontalBoundaryLimits(index)?.value ?? state.rows[index]?.horizontalEnd;
      return;
    }
    const row = state.rows[index];
    event.target.value = row.horizontalEnd;
    const image = $('#imageViewerImage');
    if (imageViewerState.cropMode) {
      imageViewerState.cropSourceUrl = row.baseCanvas.toDataURL('image/png');
      image.src = imageViewerState.cropSourceUrl;
    } else image.src = row.url;
    renderPages();
  });
  $('#imageViewerHorizontalBoundary')?.addEventListener('change', () => {
    renderReview();
    renderImageViewer(false);
  });
  $('#imageViewerHorizontalPreviousBoundary')?.addEventListener('input', (event) => {
    const index = imageViewerState.rowIndex;
    if (!setHorizontalBoundary(index - 1, event.target.value)) {
      event.target.value = horizontalBoundaryLimits(index - 1)?.value ??
        state.rows[index - 1]?.horizontalEnd;
      return;
    }
    const row = state.rows[index];
    event.target.value = state.rows[index - 1].horizontalEnd;
    const image = $('#imageViewerImage');
    if (imageViewerState.cropMode) {
      imageViewerState.cropSourceUrl = row.baseCanvas.toDataURL('image/png');
      image.src = imageViewerState.cropSourceUrl;
    } else image.src = row.url;
    renderPages();
  });
  $('#imageViewerHorizontalPreviousBoundary')?.addEventListener('change', () => {
    renderReview();
    renderImageViewer(false);
  });
  $('#imageViewerHorizontalMerge')?.addEventListener('click', () => {
    if (mergeFollowingHorizontalRow(imageViewerState.rowIndex)) renderImageViewer(false);
  });
  $('#imageViewerHorizontalMergePrevious')?.addEventListener('click', () => {
    const index = imageViewerState.rowIndex;
    const count = state.rows.length;
    if (mergePreviousHorizontalRow(index)) {
      if (state.rows.length < count) imageViewerState.rowIndex = index - 1;
      renderImageViewer(false);
    }
  });
  $('#imageViewerHorizontalUndoMerge')?.addEventListener('click', () => {
    if (undoHorizontalMerge(imageViewerState.rowIndex)) renderImageViewer(false);
  });
  $('#imageViewerCandidate')?.addEventListener('change', async (event) => {
    const row = state.rows[imageViewerState.rowIndex];
    try {
      const applied = row && await applyCandidateSelection(row, Number(event.target.value));
      if (applied) {
        renderReview();
        renderImageViewer(true);
        toast(`已切换到候选 ${Number(event.target.value) + 1}`);
      } else if (applied === false) {
        event.target.value = String(row.selectedCandidateIndex);
        toast('无法加载这张候选画面');
      }
    } catch (error) {
      console.warn('candidate restore failed', error);
      toast('无法加载这张候选画面');
    }
  });
  const imageViewerViewport = $('#imageViewerViewport');
  imageViewerViewport?.addEventListener('wheel', (event) => {
    event.preventDefault();
    changeImageViewerZoom(Math.exp(-event.deltaY * 0.0015));
  }, { passive: false });
  imageViewerViewport?.addEventListener('pointerdown', startImageViewerPointer);
  imageViewerViewport?.addEventListener('pointermove', moveImageViewerPointer);
  imageViewerViewport?.addEventListener('pointerup', endImageViewerPointer);
  imageViewerViewport?.addEventListener('pointercancel', endImageViewerPointer);
  window.addEventListener('resize', () => {
    if ($('#imageViewer')?.classList.contains('hidden')) return;
    fitImageViewerImage();
    updateImageViewerTransform();
  });
  document.addEventListener('keydown', async (event) => {
    if ($('#imageViewer')?.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeImageViewer(); return; }
    if (event.target?.closest?.('input, textarea')) return;
    if (event.code === 'KeyS' && imageViewerState.kind === 'row' &&
        visibleHorizontalStitches(state.rows[imageViewerState.rowIndex]).length) {
      event.preventDefault();
      imageViewerState.stitchMode = !imageViewerState.stitchMode;
      if (imageViewerState.stitchMode && imageViewerState.cropMode) setViewerCropMode(false);
      renderImageViewer(false);
      return;
    }
    if (imageViewerState.stitchMode && imageViewerState.kind === 'row' &&
        (event.key === '[' || event.key === ']')) {
      event.preventDefault();
      const selected = selectedHorizontalStitch(state.rows[imageViewerState.rowIndex]);
      if (!selected) return;
      const step = Math.max(1, Math.round(state.rows[imageViewerState.rowIndex].staffSpacing / 2));
      if (await applyHorizontalStitch(selected.frame.seam + (event.key === ']' ? step : -step))) {
        renderReview();
        renderImageViewer(false);
      }
      return;
    }
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        imageViewerState.kind === 'row') {
      event.preventDefault();
      const index = event.shiftKey || !followingHorizontalRow(imageViewerState.rowIndex)
        ? imageViewerState.rowIndex - 1 : imageViewerState.rowIndex;
      const row = state.rows[index];
      if (!row || !followingHorizontalRow(index)) return;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const step = Math.max(2, Math.round(row.staffSpacing));
      if (setHorizontalBoundary(index, row.horizontalEnd + direction * step)) {
        renderReview();
        renderImageViewer(false);
      }
      return;
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      nudgeImageViewerCrop(event.shiftKey ? 'bottom' : 'top', event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'ArrowLeft' || event.code === 'KeyA') {
      event.preventDefault(); moveImageViewer(-1); return;
    }
    if (event.key === 'ArrowRight' || event.code === 'KeyD') {
      event.preventDefault(); moveImageViewer(1); return;
    }
    if (event.key === 'ArrowUp' || event.code === 'KeyQ') {
      event.preventDefault(); void cycleImageViewerCandidate(-1); return;
    }
    if (event.key === 'ArrowDown' || event.code === 'KeyE') {
      event.preventDefault(); void cycleImageViewerCandidate(1); return;
    }
    if (event.code === 'KeyC' && imageViewerState.kind === 'row') {
      event.preventDefault();
      if (imageViewerState.stitchMode) {
        imageViewerState.stitchMode = false;
        renderImageViewer(false);
      } else setViewerCropMode(!imageViewerState.cropMode);
      return;
    }
    if (event.code === 'KeyR' && imageViewerState.kind === 'row') {
      event.preventDefault();
      if (imageViewerState.stitchMode) $('#imageViewerStitchReset')?.click();
      else resetImageViewerCrop();
      return;
    }
    if (event.key === 'Enter' && imageViewerState.cropDirty) {
      event.preventDefault(); applyImageViewerCrop(); return;
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); changeImageViewerZoom(1.2); }
    if (event.key === '-') { event.preventDefault(); changeImageViewerZoom(1 / 1.2); }
  });
  document.addEventListener('keyup', (event) => {
    if (imageViewerState.cropDirty && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      applyImageViewerCrop(true);
    }
  });

  $('#titleInput')?.addEventListener('input', () => { state.titleUserEdited = true; renderPages(); });
  $('#tempoInput')?.addEventListener('input', () => { state.tempoUserEdited = true; renderPages(); });

  $('#restartButton').addEventListener(
    'click',
    restart
  );

  ['cropTopInput', 'cropBottomInput'].forEach((id) => {
    $(`#${id}`).addEventListener('input', () => {
      scheduleLiveSettingsPreview({ crop: true });
    });
  });

  $('#rowGapInput').addEventListener('input', () => {
    $('#rowGapNumberInput').value = $('#rowGapInput').value;
    scheduleLiveSettingsPreview({ layout: true });
  });

  $('#rowGapNumberInput').addEventListener('input', setRowGapFromNumber);
  $('#rowGapNumberInput').addEventListener('change', setRowGapFromNumber);

  ['scoreScaleInput', 'titleSizeInput'].forEach((id) => {
    $(`#${id}`).addEventListener('input', () => {
      scheduleLiveSettingsPreview({ layout: true });
    });
  });

  $('#dedupeInput').addEventListener('input', updateSettingLabels);

  $('#sourceModeInput').addEventListener(
    'change',
    () => {
      state.settings.mode = selectedMode();
      $('#modeInput').value = state.settings.mode;
    }
  );

  window.addEventListener('beforeunload', clearVideoSource);

  writeSettingsToControls();
  checkOmrStatus();
  checkSavedCapture();
})();














