/* app.js
   Arquivo principal reorganizado.
   - Modal de conexão + sensibilidade
   - Preview proporcional (canvas 320x180 escalado)
   - Detecção ROI otimizada (detectLaserROI)
   - Main loop adaptado
   - Botões + / - com hold e aceleração
*/

/* ================== CONFIG / VARS ================== */
const CAMERA_URL_DEFAULT = ""; // vazio até o usuário conectar
let CAMERA_URL = CAMERA_URL_DEFAULT;

let THRESHOLD = parseFloat(localStorage.getItem("sensitivity") || "220");

const MM_TO_PX_RATIO = 0.3;
const FRONTEND_PX_MM = 3;
const DETECTION_COOLDOWN_MS = 300;

const ROI_RADIUS = 40;
const ROI_CENTER_X = 160;
const ROI_CENTER_Y = 90;

/* =========== DOM refs =========== */
const camPreview = document.getElementById("cameraPreview");
const camCtx = camPreview.getContext("2d", { willReadFrequently: true });
const modalCam = document.getElementById("modalCameraPreview");
const modalCam2 = document.getElementById("modalCameraPreview2");
const modalCamCtx = modalCam.getContext("2d", { willReadFrequently: true });
const modalCamCtx2 = modalCam2.getContext("2d", { willReadFrequently: true });

const modalOverlay = document.getElementById("modalOverlay");
const modalStep1 = document.getElementById("modalStep1");
const modalStep2 = document.getElementById("modalStep2");
const modalConnectBtn = document.getElementById("modalConnectBtn");
const modalNextBtn = document.getElementById("modalNextBtn");
const modalCameraIP = document.getElementById("modalCameraIP");
const modalConnectMsg = document.getElementById("modalConnectMsg");
const modalSaveSensBtn = document.getElementById("modalSaveSensBtn");
const modalSensMsg = document.getElementById("modalSensMsg");
const modalClose = document.getElementById("modalClose");

const sensInput = document.getElementById("sensInput");
const btnSensMais = document.getElementById("btnSensMais");
const btnSensMenos = document.getElementById("btnSensMenos");

const containerPreview = document.getElementById("containerPreview");
const statusDiv = document.getElementById("status");
const btnMenuCamera = document.getElementById("btnMenuCamera");
const btnMenuSens = document.getElementById("btnMenuSens");

const btnCalibrar = document.getElementById("btnCalibrar");
const btnLimpar = document.getElementById("btnLimpar");
const btnSalvar = document.getElementById("btnSalvar");
const btnZoom = document.getElementById("btnZoom");

const timerDisplay = document.getElementById("timerDisplay");
const btnStartPause = document.getElementById("btnStartPause");
const btnResetTimer = document.getElementById("btnResetTimer");

const scoreDisplay = document.getElementById("scoreDisplay");
const shotCount = document.getElementById("shotCount");
const avgScore = document.getElementById("avgScore");
const bestShot = document.getElementById("bestShot");
const shotHistory = document.getElementById("shotHistory");

/* =========== State =========== */
let camImg = new Image();
let cameraFrameOK = false;
let mjpegStarted = false;

let pontosDisparo = [];
let totalScore = 0;
let calibrationCamPoint = null;
let modoCalibracao = false;
let lastDetectionTime = 0;

let lastLaserX = null, lastLaserY = null;

/* ================== Utility UI helpers ================== */
function atualizarStatus(text, cls = "status-ready") {
  statusDiv.textContent = text;
  statusDiv.className = `status ${cls}`;
}

function showModal(step = 1) {
  modalOverlay.classList.remove("hidden");
  modalOverlay.setAttribute("aria-hidden", "false");
  if (step === 1) {
    modalStep1.classList.remove("hidden");
    modalStep2.classList.add("hidden");
  } else {
    modalStep1.classList.add("hidden");
    modalStep2.classList.remove("hidden");
  }
}

function hideModal() {
  modalOverlay.classList.add("hidden");
  modalOverlay.setAttribute("aria-hidden", "true");
}

/* ================== Preview drag (mobile + desktop) ================== */
let dragging = false, startX = 0, startY = 0, currentX = parseFloat(localStorage.getItem("divPreviewX")) || -50, currentY = parseFloat(localStorage.getItem("divPreviewY")) || -50;
if (isNaN(currentX)) currentX = -50; if (isNaN(currentY)) currentY = -50;
containerPreview.style.transform = `translate(${currentX}px, ${currentY}px)`;

function getPos(e) {
  if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  return { x: e.clientX, y: e.clientY };
}
function dragStart(e) {
  const p = getPos(e);
  dragging = true; startX = p.x; startY = p.y;
  e.preventDefault();
}
function dragMove(e) {
  if (!dragging) return;
  const p = getPos(e);
  const dx = p.x - startX, dy = p.y - startY;
  containerPreview.style.transform = `translate(${currentX + dx}px, ${currentY + dy}px)`;
  e.preventDefault();
}
function dragEnd(e) {
  if (!dragging) return;
  let pos;
  if (e.changedTouches && e.changedTouches.length > 0) pos = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
  else pos = getPos(e);
  const dx = pos.x - startX, dy = pos.y - startY;
  currentX += dx; currentY += dy;
  dragging = false;
  localStorage.setItem("divPreviewX", currentX);
  localStorage.setItem("divPreviewY", currentY);
}
containerPreview.addEventListener("mousedown", dragStart);
containerPreview.addEventListener("touchstart", dragStart, { passive:false });
document.addEventListener("mousemove", dragMove);
document.addEventListener("touchmove", dragMove, { passive:false });
document.addEventListener("mouseup", dragEnd);
document.addEventListener("touchend", dragEnd);

/* ================== MJPEG start/stop ================== */
function startMJPEG(url) {
  if (!url) return;
  try {
    camImg = new Image();
    camImg.crossOrigin = "anonymous";
    camImg.src = url;
    camImg.onload = () => {
      cameraFrameOK = true;
      mjpegStarted = true;
      atualizarStatus("Câmera conectada com sucesso.", "status-ready");
      modalConnectMsg.textContent = "Câmera conectada!";
      // enable next button in modal
      modalNextBtn.disabled = false;
    };
    camImg.onerror = (e) => {
      cameraFrameOK = false;
      atualizarStatus("Erro ao carregar câmera (verifique IP).", "status-error");
      modalConnectMsg.textContent = "Erro ao carregar MJPEG. Verifique IP e rede.";
    };
  } catch (err) {
    console.error("startMJPEG error", err);
    atualizarStatus("Erro ao iniciar MJPEG.", "status-error");
  }
}

/* ================== DETECTOR V3 (ROI real + centroide) ================== */
let lastLaserX_mem = null, lastLaserY_mem = null;
function detectLaserROI(imgData, roiX, roiY, roiW, roiH) {
  const data = imgData.data;
  let maxB = -1, peakX = -1, peakY = -1;

  for (let i = 0; i < data.length; i += 4) {
    const idx = i/4;
    const x = (idx % roiW) + roiX;
    const y = Math.floor(idx / roiW) + roiY;
    const dx = x - ROI_CENTER_X, dy = y - ROI_CENTER_Y;
    if (dx*dx + dy*dy > ROI_RADIUS*ROI_RADIUS) continue;
    const r = data[i], g = data[i+1], b = data[i+2];
    const bright = Math.max(r,g,b);
    if (bright > THRESHOLD && bright > maxB) { maxB = bright; peakX = x; peakY = y; }
  }
  if (maxB < 0) return null;

  let win = (maxB > 240) ? 2 : (maxB > 200) ? 3 : 4;
  let sumX=0, sumY=0, sumW=0;
  for (let dx=-win; dx<=win; dx++){
    for (let dy=-win; dy<=win; dy++){
      const xx = peakX + dx, yy = peakY + dy;
      if (xx < roiX || yy < roiY || xx >= roiX+roiW || yy >= roiY+roiH) continue;
      const rx = xx - ROI_CENTER_X, ry = yy - ROI_CENTER_Y;
      if (rx*rx + ry*ry > ROI_RADIUS*ROI_RADIUS) continue;
      const idx2 = ((yy-roiY)*roiW + (xx-roiX))*4;
      const r = data[idx2], g = data[idx2+1], b = data[idx2+2];
      const bright = Math.max(r,g,b);
      if (bright < maxB*0.70) continue;
      const w = bright*bright;
      sumX += xx*w; sumY += yy*w; sumW += w;
    }
  }
  if (sumW === 0) return { x:peakX, y:peakY };
  let cx = sumX / sumW, cy = sumY / sumW;
  if (lastLaserX_mem !== null) {
    cx = cx*0.6 + lastLaserX_mem*0.4;
    cy = cy*0.6 + lastLaserY_mem*0.4;
  }
  lastLaserX_mem = cx; lastLaserY_mem = cy;
  return { x:cx, y:cy };
}

/* ================== MAIN LOOP V3 ================== */
let frameSkip = 0, skipTarget = 1;
const ROI_X = ROI_CENTER_X - ROI_RADIUS, ROI_Y = ROI_CENTER_Y - ROI_RADIUS, ROI_W = ROI_RADIUS*2, ROI_H = ROI_RADIUS*2;

function drawROIMaskOnCanvas(context) {
  context.beginPath();
  context.strokeStyle = "rgba(255, 0, 0, 0.9)";
  context.lineWidth = 0.8;
  context.arc(ROI_CENTER_X, ROI_CENTER_Y, ROI_RADIUS, 0, Math.PI*2);
  context.stroke();
}

// Keep a separate copy of canvas action for modal previews (they mirror the same image)
function mirrorToModalCanvases() {
  // copy camPreview content to modal canvases
  try {
    const img = camCtx.getImageData(0,0,camPreview.width, camPreview.height);
    modalCamCtx.putImageData(img, 0, 0);
    modalCamCtx2.putImageData(img, 0, 0);
  } catch(e){}
}

function mainLoop() {
  // draw camera image
  try {
    camCtx.drawImage(camImg, 0, 0, camPreview.width, camPreview.height);
  } catch(e){
    requestAnimationFrame(mainLoop);
    return;
  }

  // draw static roi mask on preview and modals (once per frame is ok)
  drawROIMaskOnCanvas(camCtx);

  if (calibrationCamPoint) {
    camCtx.beginPath();
    camCtx.fillStyle = "yellow";
    camCtx.arc(
        ROI_CENTER_X + calibrationCamPoint.x,
        ROI_CENTER_Y + calibrationCamPoint.y,
        3,    // tamanho um pouco maior (2 px ficava difícil no mobile)
        0,
        Math.PI * 2
    );
    camCtx.fill();
  }

  // frame skip logic (adaptive)
  if ((frameSkip++ % skipTarget) !== 0) {
    mirrorToModalCanvases();
    requestAnimationFrame(mainLoop);
    return;
  }
  if (frameSkip > 200) { skipTarget = Math.max(1, skipTarget - 1); frameSkip = 0; }

  // capture ONLY ROI
  let imgData;
  try {
    imgData = camCtx.getImageData(ROI_X, ROI_Y, ROI_W, ROI_H);
  } catch(e){
    requestAnimationFrame(mainLoop);
    return;
  }

  const detected = detectLaserROI(imgData, ROI_X, ROI_Y, ROI_W, ROI_H);
  const now = performance.now();

  // show debug point on preview
  if (detected) {
    camCtx.beginPath();
    camCtx.fillStyle = "lime";
    camCtx.arc(detected.x, detected.y, 2, 0, Math.PI*2);
    camCtx.fill();
  }

  // process detection (cooldown)
  if (detected && now - lastDetectionTime > DETECTION_COOLDOWN_MS) {
    if (modoCalibracao) {
      calibrationCamPoint = { x: detected.x - ROI_CENTER_X, y: detected.y - ROI_CENTER_Y };
      modoCalibracao = false;
      atualizarStatus("Modo normal. Dispare para ver os impactos.", "status-ready");
    } else if (calibrationCamPoint) {
      const dx_cam_px = detected.x - (ROI_CENTER_X + calibrationCamPoint.x);
      const dy_cam_px = detected.y - (ROI_CENTER_Y + calibrationCamPoint.y);
      const dx_mm = dx_cam_px / MM_TO_PX_RATIO;
      const dy_mm = dy_cam_px / MM_TO_PX_RATIO;
      const dx_front_px = dx_mm * FRONTEND_PX_MM;
      const dy_front_px = dy_mm * FRONTEND_PX_MM;
      const dist_mm = Math.sqrt(dx_mm*dx_mm + dy_mm*dy_mm);
      const score = Math.max(0, 10 - (dist_mm/5));
      pontosDisparo.push({ dx:dx_front_px, dy:dy_front_px, score: Math.round(score*10)/10 });
      if (pontosDisparo.length > 200) pontosDisparo = pontosDisparo.slice(-200);
      plotarPontos(); atualizarEstatisticas();
    }
    lastDetectionTime = now;
  }

  // mirror preview to modal canvases for large preview experience
  mirrorToModalCanvases();

  requestAnimationFrame(mainLoop);
}

/* ================== UI: connect modal logic ================== */
modalConnectBtn.addEventListener("click", () => {
  const ip = modalCameraIP.value.trim();
  if (!ip) { modalConnectMsg.textContent = "Informe o IP da câmera."; return; }
  modalConnectMsg.textContent = "Conectando...";
  CAMERA_URL = `http://${ip}:8080/video`;
  startMJPEG(CAMERA_URL);
});

// next: go to sensitivity step (enabled when camImg.onload)
modalNextBtn.addEventListener("click", () => {
  showModal(2);
  // set sens input and focus
  sensInput.value = THRESHOLD.toFixed(1);
});

/* sens save -> close modal and enter main app */
modalSaveSensBtn.addEventListener("click", () => {
  const v = parseFloat(sensInput.value);
  if (!isFinite(v)) { modalSensMsg.textContent = "Valor inválido"; return; }
  THRESHOLD = v;
  localStorage.setItem("sensitivity", THRESHOLD);
  atualizarStatus("Sensibilidade ajustada.", "status-ready");
  hideModal();
});

/* modal close (allow user to close only after connected and saved) */
modalClose.addEventListener("click", () => {
  // if camera not started, do nothing
  if (!mjpegStarted) return;
  hideModal();
});

/* menu buttons to re-open modals */
btnMenuCamera.addEventListener("click", () => showModal(1));
btnMenuSens.addEventListener("click", () => { showModal(2); sensInput.value = THRESHOLD.toFixed(1); });

/* open modal on first load */
window.addEventListener("load", () => {
  // init sens input
  sensInput.value = THRESHOLD.toFixed(1);
  // ensure canvases show something - start loop but camImg empty
  requestAnimationFrame(mainLoop);
  showModal(1);
  atualizarStatus("Aguardando conexão da câmera...", "status-calibrating");
});

/* ================== Sensitivity controls: buttons + hold + acceleration ================== */
let holdInterval = null, holdStartTime = 0;
function getDynamicStep(baseStep) {
  const elapsed = performance.now() - holdStartTime;
  if (elapsed < 500) return baseStep;
  if (elapsed < 1500) return baseStep * 2;
  if (elapsed < 3000) return baseStep * 4;
  return baseStep * 10;
}
function atualizarSensibilidade(val) {
  val = Math.max(0, Math.min(255, parseFloat(val)));
  THRESHOLD = val;
  sensInput.value = THRESHOLD.toFixed(1);
  localStorage.setItem("sensitivity", THRESHOLD);
  modalSensMsg.textContent = "Sensibilidade: " + THRESHOLD.toFixed(1);
}
function startHold(baseStep) {
  holdStartTime = performance.now();
  atualizarSensibilidade(THRESHOLD + baseStep);
  holdInterval = setInterval(()=> {
    const step = getDynamicStep(baseStep);
    atualizarSensibilidade(THRESHOLD + step);
  }, 120);
}
function stopHold() { if (holdInterval) { clearInterval(holdInterval); holdInterval = null; } }

btnSensMais.addEventListener("mousedown", () => startHold(+0.5));
btnSensMais.addEventListener("touchstart", (e)=>{ e.preventDefault(); startHold(+0.5); }, {passive:false});
btnSensMais.addEventListener("mouseup", stopHold);
btnSensMais.addEventListener("mouseleave", stopHold);
btnSensMais.addEventListener("touchend", stopHold);
btnSensMais.addEventListener("touchcancel", stopHold);

btnSensMenos.addEventListener("mousedown", () => startHold(-0.5));
btnSensMenos.addEventListener("touchstart", (e)=>{ e.preventDefault(); startHold(-0.5); }, {passive:false});
btnSensMenos.addEventListener("mouseup", stopHold);
btnSensMenos.addEventListener("mouseleave", stopHold);
btnSensMenos.addEventListener("touchend", stopHold);
btnSensMenos.addEventListener("touchcancel", stopHold);

/* allow manual edit on input */
sensInput.addEventListener("change", () => {
  const v = parseFloat(sensInput.value);
  if (isFinite(v)) atualizarSensibilidade(v);
});

/* ========== Remaining UI stubs: timer, plotar pontos, stats ========== */
/* Minimal implementations to keep app working; you can replace by your full versions */

let timerRunning = false, timerSeconds = 0, timerInterval = null;
function formatTime(s){ const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`; }
function updateTimer(){ timerSeconds++; timerDisplay.textContent = formatTime(timerSeconds); }
btnStartPause.addEventListener("click", () => {
  if (timerRunning) { clearInterval(timerInterval); timerRunning=false; btnStartPause.textContent="Iniciar"; }
  else { timerInterval = setInterval(updateTimer,1000); timerRunning=true; btnStartPause.textContent="Pausar"; }
});
btnResetTimer.addEventListener("click", ()=>{ clearInterval(timerInterval); timerRunning=false; timerSeconds=0; timerDisplay.textContent="00:00:00"; btnStartPause.textContent="Iniciar"; });

btnLimpar.addEventListener("click", ()=>{ pontosDisparo=[]; plotarPontos(); atualizarEstatisticas(); });
btnSalvar.addEventListener("click", salvarSessao);
btnCalibrar.addEventListener("click", ()=> {
  calibrationCamPoint = null;
  pontosDisparo = [];
  plotarPontos(); 
  modoCalibracao = true; 
  atualizarStatus("Modo calibração: aponte o laser e aguarde.", "status-calibrating"); 
});

/* placeholder: plotarPontos e atualizarEstatisticas (integre suas funções existentes aqui) */
const canvasAlvo = document.getElementById("alvo"), ctxAlvo = canvasAlvo.getContext("2d");
function desenharAlvo() {
  ctxAlvo.clearRect(0,0,canvasAlvo.width,canvasAlvo.height);
  const centerX = canvasAlvo.width/2, centerY = canvasAlvo.height/2;
  ctxAlvo.fillStyle = "white"; ctxAlvo.fillRect(0,0,canvasAlvo.width,canvasAlvo.height);
  const alvo_px = { "7":600, "8":450, "9":300, "10":150, "X":75 };
  const circulos = [{raio:alvo_px["7"]/2},{raio:alvo_px["8"]/2},{raio:alvo_px["9"]/2},{raio:alvo_px["10"]/2},{raio:alvo_px["X"]/2}];
  ctxAlvo.save();
  ctxAlvo.translate(0,0);
  ctxAlvo.strokeStyle="black"; ctxAlvo.lineWidth=2;
  circulos.forEach((c,i)=>{ ctxAlvo.beginPath(); ctxAlvo.arc(centerX,centerY,c.raio,0,Math.PI*2); ctxAlvo.stroke(); });
  ctxAlvo.restore();
}
function plotarPontos() {
  desenharAlvo();
  ctxAlvo.save();
  pontosDisparo.forEach((pt, i) => {
    const pX = canvasAlvo.width / 2 + pt.dx;
    const pY = canvasAlvo.height / 2 + pt.dy;

    // círculo vermelho
    ctxAlvo.beginPath();
    ctxAlvo.fillStyle = "red";
    ctxAlvo.arc(pX, pY, 7.5, 0, Math.PI * 2);
    ctxAlvo.fill();

    ctxAlvo.strokeStyle = "white";
    ctxAlvo.lineWidth = 1;
    ctxAlvo.stroke();

    // 🔥 número do tiro
    ctxAlvo.fillStyle = "white";
    ctxAlvo.font = "10px Arial";
    ctxAlvo.textAlign = "center";
    ctxAlvo.textBaseline = "middle";
    ctxAlvo.fillText(i + 1, pX, pY);
  });
  ctxAlvo.restore();
}
function atualizarEstatisticas() {
  const numTiros = pontosDisparo.length;
  shotCount.textContent = numTiros;
  if (numTiros>0) {
    const pontuacoes = pontosDisparo.map(p=>p.score);
    totalScore = pontuacoes.reduce((s,v)=>s+v,0);
    const media = totalScore/numTiros;
    scoreDisplay.textContent = `${totalScore.toFixed(1)} pts`;
    avgScore.textContent = media.toFixed(1);
    bestShot.textContent = Math.max(...pontuacoes).toFixed(1);
    atualizarHistorico();
  } else {
    scoreDisplay.textContent="0 pts"; avgScore.textContent="0.0"; bestShot.textContent="0";
    shotHistory.innerHTML = '<div style="text-align:center;color:#999;">Nenhum tiro registrado</div>';
  }
}
function atualizarHistorico(){
  const html = pontosDisparo.map((pt,i)=>`<div class="shot-item"><span>Tiro ${i+1}:</span><span>${pt.score.toFixed(1)} pts</span></div>`).join('');
  shotHistory.innerHTML = html || '<div style="text-align:center;color:#999;">Nenhum tiro registrado</div>';
}

/* salvar sessao */
function salvarSessao(){
  const sessao = { timestamp:new Date().toISOString(), tiros:pontosDisparo, totalScore, numTiros:pontosDisparo.length };
  const blob = new Blob([JSON.stringify(sessao,null,2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `scatt_session_${new Date().toISOString().slice(0,10)}.json`; a.click();
}

/* final: initial drawing */
desenharAlvo();
atualizarEstatisticas();
