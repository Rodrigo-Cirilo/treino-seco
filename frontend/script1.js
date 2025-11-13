// Configuração inicial
const canvas = document.getElementById("alvo");
const ctx = canvas.getContext("2d");

let basePoint = null;
let pontosDisparo = [];
let totalScore = 0;
let zoomMode = false;
let zoomFactor = 1;
let zoomOffsetX = 0;
let zoomOffsetY = 0;
let timerRunning = false;
let timerSeconds = 0;
let timerInterval = null;

// Elementos da interface
const statusDiv = document.getElementById("status");
const btnCalibrar = document.getElementById("btnCalibrar");
// const btnSairCalibrar = document.getElementById("btnSairCalibrar");
const btnLimpar = document.getElementById("btnLimpar");
const btnSalvar = document.getElementById("btnSalvar");
const btnZoom = document.getElementById("btnZoom");
const scoreDisplay = document.getElementById("scoreDisplay");
const shotCount = document.getElementById("shotCount");
const avgScore = document.getElementById("avgScore");
const bestShot = document.getElementById("bestShot");
const shotHistory = document.getElementById("shotHistory");
const connectionStatus = document.getElementById("connectionStatus");
const timerDisplay = document.getElementById("timerDisplay");
const btnStartPause = document.getElementById("btnStartPause");
const btnResetTimer = document.getElementById("btnResetTimer");
const roiInfo = document.getElementById("roiInfo");

let modoCalibracao = false;
let config = null;

// Elemento para exibir pontuações individuais em tempo real
const liveScoreElement = document.createElement("div");
liveScoreElement.id = "liveScore";
liveScoreElement.style.position = "absolute";
liveScoreElement.style.top = "10px";
liveScoreElement.style.right = "10px";
liveScoreElement.style.color = "white";
document.body.appendChild(liveScoreElement);

// Valores padrão para o alvo
const DEFAULT_ALVO_PX = {
    "7": 600,  // 200mm * 3px/mm
    "8": 450,  // 150mm * 3px/mm
    "9": 300,  // 100mm * 3px/mm
    "10": 150, // 50mm * 3px/mm
    "X": 75    // 25mm * 3px/mm
};

// Carregar configuração
fetch("/config")
    .then(response => response.json())
    .then(data => {
        config = data;
        roiInfo.textContent = `ROI: ${data.roi_size_mm.toFixed(0)}mm x ${data.roi_size_mm.toFixed(0)}mm (${data.roi_size_px}x${data.roi_size_px}px) @ (${data.roi_x}, ${data.roi_y})`;
        desenharAlvo();
    })
    .catch(error => {
        console.error("[ERROR] Falha ao carregar config:", error);
        roiInfo.textContent = "ROI: Aguardando configuração...";
        desenharAlvo();
    });

function desenharAlvo() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    if (zoomMode) {
        ctx.scale(zoomFactor, zoomFactor);
        ctx.translate(zoomOffsetX, zoomOffsetY);
    }
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    ctx.fillStyle = "white";
    ctx.fillRect(-centerX, -centerY, canvas.width * 2, canvas.height * 2);
    
    const alvo_px = config ? config.alvo_virtual_px : DEFAULT_ALVO_PX;
    const circulos = [
        { raio: alvo_px["7"] / 2, cor: "black", pontos: 7 },
        { raio: alvo_px["8"] / 2, cor: "black", pontos: 8 },
        { raio: alvo_px["9"] / 2, cor: "black", pontos: 9 },
        { raio: alvo_px["10"] / 2, cor: "black", pontos: 10 },
        { raio: alvo_px["X"] / 2, cor: "black", pontos: "X" }
    ];
    circulos.forEach((circulo, index) => {
        ctx.strokeStyle = circulo.cor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(centerX, centerY, circulo.raio, 0, 2 * Math.PI);
        ctx.stroke();
        if (index < circulos.length - 1) {
            ctx.fillStyle = "black";
            ctx.font = "16px Arial";
            ctx.textAlign = "center";
            ctx.fillText(circulo.pontos, centerX, centerY - circulo.raio - 10);
        }
    });
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(centerX, centerY, alvo_px["X"] / 2, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(centerX - alvo_px["7"] / 2, centerY);
    ctx.lineTo(centerX + alvo_px["7"] / 2, centerY);
    ctx.moveTo(centerX, centerY - alvo_px["7"] / 2);
    ctx.lineTo(centerX, centerY + alvo_px["7"] / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
}

function transformarCoord(dx, dy) {
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const scale_factor = config ? config.roi_to_target_scale * config.frontend_px_mm : 3.0; // Alinhar com backend
    return { x: centerX + dx, y: centerY + dy }; // Usar dx, dy diretamente do hit.x, hit.y
}

function plotarPontos() {
    desenharAlvo();
    ctx.save();
    if (zoomMode) {
        ctx.scale(zoomFactor, zoomFactor);
        ctx.translate(zoomOffsetX, zoomOffsetY);
    }
    if (basePoint) {
        const p = transformarCoord(0, 0);
        ctx.beginPath();
        ctx.fillStyle = "purple";
        ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = "white";
        ctx.lineWidth = 2;
        ctx.stroke();
    }
    pontosDisparo.forEach((pt, index) => {
        const p = transformarCoord(pt.dx, pt.dy);
        ctx.beginPath();
        ctx.fillStyle = "red";
        ctx.arc(p.x, p.y, 7.5, 0, 2 * Math.PI);  // 15 px de diâmetro
        ctx.fill();
        ctx.strokeStyle = "white";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "white";
        ctx.font = "10px Arial";
        ctx.textAlign = "center";
        ctx.fillText(index + 1, p.x, p.y + 3);
    });
    ctx.restore();
}

function atualizarEstatisticas() {
    const numTiros = pontosDisparo.length;
    shotCount.textContent = numTiros;
    if (numTiros > 0) {
        const pontuacoes = pontosDisparo.map(pt => pt.score);
        totalScore = pontuacoes.reduce((sum, score) => sum + score, 0);
        const media = totalScore / numTiros;
        const melhor = Math.max(...pontuacoes);
        scoreDisplay.textContent = `${totalScore.toFixed(1)} pts`;
        avgScore.textContent = media.toFixed(1);
        bestShot.textContent = melhor.toFixed(1);
        atualizarHistorico();
    } else {
        scoreDisplay.textContent = "0 pts";
        avgScore.textContent = "0.0";
        bestShot.textContent = "0";
        shotHistory.innerHTML = '<div style="text-align: center; color: #999;">Nenhum tiro registrado</div>';
    }
}

function atualizarHistorico() {
    const historico = pontosDisparo.map((pt, index) => {
        return `
            <div class="shot-item">
                <span>Tiro ${index + 1}:</span>
                <span>${pt.score.toFixed(1)} pts</span>
            </div>
        `;
    }).join('');
    shotHistory.innerHTML = historico;
    shotHistory.scrollTop = shotHistory.scrollHeight;
}

function atualizarStatus(texto, classe) {
    statusDiv.textContent = texto;
    statusDiv.className = classe;
}

function salvarSessao() {
    const sessao = {
        timestamp: new Date().toISOString(),
        tiros: pontosDisparo.map(pt => ({
            dx: pt.dx,
            dy: pt.dy,
            pontos: pt.score
        })),
        totalScore: totalScore,
        numTiros: pontosDisparo.length
    };
    const blob = new Blob([JSON.stringify(sessao, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scatt_session_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updateTimer() {
    timerSeconds++;
    timerDisplay.textContent = formatTime(timerSeconds);
}

// Event Listeners
btnCalibrar.onclick = () => {
    modoCalibracao = true;
    basePoint = null;
    pontosDisparo = [];
    atualizarStatus("Modo calibração: aponte o laser para o centro do alvo e aguarde.", "status-calibrating");
    btnCalibrar.disabled = true;
    // btnSairCalibrar.disabled = false;
    plotarPontos();
    atualizarEstatisticas();
    fetch("/modo_calibracao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calibrando: true })
    });
};

// btnSairCalibrar.onclick = () => {
//     modoCalibracao = false;
//     atualizarStatus("Modo normal. Dispare para ver os impactos.", "status-ready");
//     btnCalibrar.disabled = false;
//     btnSairCalibrar.disabled = true;
//     fetch("/modo_calibracao", {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ calibrando: false })
//     });
// };

btnLimpar.onclick = () => {
    pontosDisparo = [];
    totalScore = 0;
    plotarPontos();
    atualizarEstatisticas();
};

btnSalvar.onclick = salvarSessao;

btnZoom.onclick = () => {
    zoomMode = !zoomMode;
    if (zoomMode) {
        zoomFactor = 3;
        zoomOffsetX = -100;
        zoomOffsetY = -100;
        btnZoom.textContent = "Zoom Normal";
    } else {
        zoomFactor = 1;
        zoomOffsetX = 0;
        zoomOffsetY = 0;
        btnZoom.textContent = "Zoom Centro";
    }
    plotarPontos();
};

btnStartPause.onclick = () => {
    if (timerRunning) {
        clearInterval(timerInterval);
        timerRunning = false;
        btnStartPause.textContent = "Iniciar";
    } else {
        timerInterval = setInterval(updateTimer, 1000);
        timerRunning = true;
        btnStartPause.textContent = "Pausar";
    }
};

btnResetTimer.onclick = () => {
    clearInterval(timerInterval);
    timerRunning = false;
    timerSeconds = 0;
    timerDisplay.textContent = "00:00:00";
    btnStartPause.textContent = "Iniciar";
};

// WebSocket
const ws = new WebSocket("ws://" + location.hostname + ":8765");

ws.onopen = () => {
    console.log("[WS] Conectado");
    connectionStatus.textContent = "Conectado";
    connectionStatus.className = "connection-status connected";
};

ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (Array.isArray(data.hits)) {
        data.hits.forEach(hit => {
            if (hit.error) {
                atualizarStatus(hit.error, "status-error");
            } else if (!modoCalibracao) {
                console.log(`Received hit: x=${hit.x}, y=${hit.y}, score=${hit.score}`);
                liveScoreElement.innerHTML += `<p>Tiro: ${hit.score.toFixed(1)} pts</p>`; // Exibe pontuação em tempo real
                const dx = hit.x - 300; // Usar diretamente as coordenadas do backend
                const dy = hit.y - 300;
                pontosDisparo.push({ dx, dy, score: hit.score });
            }
        });
        if (pontosDisparo.length > 50) {
            pontosDisparo = pontosDisparo.slice(-50);
        }
        plotarPontos();
        atualizarEstatisticas();
    }
    if (data.calibrando === false && modoCalibracao) {
       btnCalibrar.disabled = false;
       modoCalibracao = false;
       atualizarStatus("Modo normal. Dispare para ver os impactos.", "status-ready");
    }
};

ws.onerror = (e) => {
    console.error("[WS] Erro:", e);
    connectionStatus.textContent = "Erro";
    connectionStatus.className = "connection-status disconnected";
};

ws.onclose = () => {
    console.log("[WS] Desconectado");
    connectionStatus.textContent = "Desconectado";
    connectionStatus.className = "connection-status disconnected";
};

// Inicialização
desenharAlvo();
atualizarEstatisticas();