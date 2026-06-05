const API = "http://127.0.0.1:8000";

// ── Counters ──────────────────────────────────
let totalDogs   = 0;
let totalCattle = 0;
let allAlerts   = [];

// ── Tab switching ─────────────────────────────
function showTab(name) {
  document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  event.target.classList.add("active");
}

// ── Check backend health ──────────────────────
async function checkHealth() {
  try {
    const r    = await fetch(`${API}/health`);
    const data = await r.json();
    document.getElementById("statusDot").className  = "status-dot online";
    document.getElementById("statusText").textContent = "System Online";
  } catch {
    document.getElementById("statusDot").className  = "status-dot offline";
    document.getElementById("statusText").textContent = "Backend Offline";
  }
}

// ── Update dashboard counters ─────────────────
function updateCounters() {
  document.getElementById("totalDetections").textContent = totalDogs + totalCattle;
  document.getElementById("totalDogs").textContent       = totalDogs;
  document.getElementById("totalCattle").textContent     = totalCattle;
  document.getElementById("totalAlerts").textContent     = allAlerts.length;
  if (allAlerts.length > 0) {
    document.getElementById("alertsTab").classList.add("has-alert");
  }
}

// ── Add to history ────────────────────────────
function addHistory(dogs, cattle, source) {
  const list = document.getElementById("historyList");
  const empty = list.querySelector(".empty-msg");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = "history-item";
  item.innerHTML = `
    <span>${source}</span>
    <div class="history-badges">
      <span class="dog-badge">🐕 ${dogs}</span>
      <span class="cattle-badge">🐄 ${cattle}</span>
    </div>
    <span class="history-ts">${new Date().toLocaleTimeString()}</span>
  `;
  list.prepend(item);
}

// ── Demo ──────────────────────────────────────
async function runDemo() {
  try {
    const r    = await fetch(`${API}/demo/generate`, { method: "POST" });
    const data = await r.json();
    document.getElementById("demoResult").classList.remove("hidden");
    document.getElementById("demoImage").src   = "data:image/jpeg;base64," + data.annotated_image;
    document.getElementById("demoTotal").textContent  = data.total;
    document.getElementById("demoDogs").textContent   = "🐕 Dogs: "   + (data.counts?.dog    || 0);
    document.getElementById("demoCattle").textContent = "🐄 Cattle: " + (data.counts?.cattle || 0);
  } catch (e) {
    alert("Backend not running. Start with: uvicorn main:app --reload --port 8000");
  }
}

// ── IMAGE DETECTION ───────────────────────────
function handleImageDrop(e) {
  e.preventDefault();
  document.getElementById("imageDropZone").classList.remove("dragging");
  const file = e.dataTransfer.files[0];
  if (file) handleImageFile(file);
}

async function handleImageFile(file) {
  if (!file) return;

  // Show loading
  document.getElementById("imageLoading").classList.remove("hidden");
  document.getElementById("imageResults").classList.add("hidden");

  const fd = new FormData();
  fd.append("file", file);

  console.log("Calling URL:", `${API}/detect/image`);

  try {
    const r    = await fetch(`${API}/detect/image`, { method: "POST", body: fd });
    const data = await r.json();
    console.log("FULL RESPONSE:", data);
    console.log("IMAGE DATA:", data.image);
    
    // Hide loading, show results
    document.getElementById("imageLoading").classList.add("hidden");
    document.getElementById("imageResults").classList.remove("hidden");

    // Fill in results
    document.getElementById("resultImage").src      = "data:image/jpeg;base64," + data.image;
    document.getElementById("imgTotal").textContent =
        data.total || 0;

    document.getElementById("imgDogs").textContent =
        data.dog_count || 0;

    document.getElementById("imgCattle").textContent =
        data.cattle_count || 0;
    document.getElementById("imgSpeed").textContent  = data.speed_ms + " ms";
    document.getElementById("imgTime").textContent   = data.timestamp;

    // Detection list
    const list = document.getElementById("imgDetectionList");
    list.innerHTML = "";
    (data.detections || []).forEach(d => {
      list.innerHTML += `
        <div class="det-item">
          <span class="det-name ${d.class_name}">${d.class_name}</span>
          <div class="conf-track"><div class="conf-fill ${d.class_name}" style="width:${d.confidence*100}%"></div></div>
          <span class="det-conf">${(d.confidence*100).toFixed(0)}%</span>
        </div>`;
    });

    // Update global counters
    totalDogs   += data.dog_count;
    totalCattle += data.cattle_count;
    updateCounters();
    addHistory(data.dog_count, data.cattle_count, file.name);

    // Handle alert
    if (data.alert) addAlert(data.alert);

  } catch (e) {
    document.getElementById("imageLoading").classList.add("hidden");
    alert("Error: " + e.message);
  }
}

// ── VIDEO DETECTION ───────────────────────────
function handleVideoDrop(e) {
  e.preventDefault();
  document.getElementById("videoDropZone").classList.remove("dragging");
  const file = e.dataTransfer.files[0];
  if (file) handleVideoFile(file);
}

async function handleVideoFile(file) {
  if (!file) return;

  document.getElementById("videoFileName").textContent = file.name;
  document.getElementById("videoLoading").classList.remove("hidden");
  document.getElementById("videoResults").classList.add("hidden");

  // Fake progress
  let pct = 5;
  const ticker = setInterval(() => {
    pct = Math.min(pct + 3, 90);
    document.getElementById("videoProgress").style.width = pct + "%";
  }, 400);

  const fd = new FormData();
  fd.append("file", file);

  try {
    const r    = await fetch(`${API}/detect/video`, { method: "POST", body: fd });
    const data = await r.json();

    clearInterval(ticker);
    document.getElementById("videoProgress").style.width = "100%";

    setTimeout(() => {
      document.getElementById("videoLoading").classList.add("hidden");
      document.getElementById("videoResults").classList.remove("hidden");

      document.getElementById("vidTotal").textContent   = data.grand_total;
      document.getElementById("vidDogs").textContent    = data.dog_total;
      document.getElementById("vidCattle").textContent  = data.cattle_total;
      document.getElementById("vidFrames").textContent  = data.frames_checked;

      // Draw timeline bars
      const tl = document.getElementById("videoTimeline");
      tl.innerHTML = "";
      (data.timeline || []).slice(0, 80).forEach(f => {
        const bar = document.createElement("div");
        bar.className = "tbar";
        bar.style.height = Math.min(100, f.total * 20 + 3) + "%";
        bar.title = `Frame ${f.frame}: ${f.total} animals`;
        tl.appendChild(bar);
      });

      totalDogs   += data.dog_total;
      totalCattle += data.cattle_total;
      updateCounters();
      addHistory(data.dog_total, data.cattle_total, file.name);
    }, 500);

  } catch (e) {
    clearInterval(ticker);
    document.getElementById("videoLoading").classList.add("hidden");
    alert("Error processing video: " + e.message);
  }
}

// ── LIVE STREAM ───────────────────────────────
let ws        = null;
let stream    = null;
let liveTimer = null;

async function startLive() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width:640, height:480 } });
    const video = document.getElementById("webcamVideo");
    video.srcObject = stream;
    await video.play();

    document.getElementById("camDot").classList.add("live");
    document.getElementById("startBtn").classList.add("hidden");
    document.getElementById("stopBtn").classList.remove("hidden");
    document.getElementById("liveStats").classList.remove("hidden");

    // Connect WebSocket
    const sessionId = "cam-" + Date.now();
    ws = new WebSocket(`ws://localhost:8000/ws/live/${sessionId}`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      document.getElementById("wsStatus").textContent  = "✅ Connected";
      document.getElementById("wsStatus").className    = "ws-status connected";
      document.getElementById("aiDot").classList.add("live");
    };

    ws.onclose = () => {
      document.getElementById("wsStatus").textContent = "Disconnected";
      document.getElementById("wsStatus").className   = "ws-status";
    };

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type !== "result") return;

      // Show annotated frame
      const img = document.getElementById("liveAnnotated");
      img.src = "data:image/jpeg;base64," + data.annotated_image;
      img.classList.remove("hidden");
      document.getElementById("livePlaceholder").classList.add("hidden");

      // Update live counts
      document.getElementById("liveDogCount").textContent    = data.dog_count;
      document.getElementById("liveCattleCount").textContent = data.cattle_count;
      document.getElementById("liveFps").textContent         = data.fps;
      document.getElementById("liveFrame").textContent       = data.frame;

      totalDogs   += data.dog_count;
      totalCattle += data.cattle_count;
      updateCounters();

      if (data.alert) addAlert(data.alert);
    };

    // Send frames every 200ms (~5fps)
    const canvas = document.getElementById("webcamCanvas");
    const ctx    = canvas.getContext("2d");
    liveTimer = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      ctx.drawImage(video, 0, 0, 640, 480);
      canvas.toBlob(blob => {
        blob?.arrayBuffer().then(buf => ws.send(buf));
      }, "image/jpeg", 0.7);
    }, 200);

  } catch (e) {
    alert("Cannot access camera: " + e.message);
  }
}

function stopLive() {
  clearInterval(liveTimer);
  ws?.close();
  stream?.getTracks().forEach(t => t.stop());

  document.getElementById("camDot").classList.remove("live");
  document.getElementById("aiDot").classList.remove("live");
  document.getElementById("startBtn").classList.remove("hidden");
  document.getElementById("stopBtn").classList.add("hidden");
  document.getElementById("wsStatus").textContent = "Not connected";
  document.getElementById("wsStatus").className   = "ws-status";
}

// ── ALERTS ────────────────────────────────────
function addAlert(alert) {
  allAlerts.unshift(alert);
  renderAlerts();
  updateCounters();
}

function renderAlerts() {
  const list = document.getElementById("alertsList");
  if (allAlerts.length === 0) {
    list.innerHTML = `
      <div class="empty-alerts">
        <div class="empty-icon">✅</div>
        <h3>No Active Alerts</h3>
        <p>Alerts appear here when animal density is high</p>
      </div>`;
    return;
  }
  list.innerHTML = allAlerts.map(a => `
    <div class="alert-item ${a.severity}">
      <div class="alert-top">
        <span class="alert-badge ${a.severity}">${a.severity.toUpperCase()}</span>
        <span class="alert-ts">${new Date(a.timestamp).toLocaleTimeString()}</span>
        <button class="dismiss-btn" onclick="dismissAlert('${a.id}')">✕</button>
      </div>
      <div class="alert-msg">${a.message}</div>
      <div class="alert-meta">
        <span>📍 ${a.location}</span>
        <span>🐾 ${a.total} animals</span>
      </div>
    </div>`).join("");
}

function dismissAlert(id) {
  fetch(`${API}/alerts/${id}`, { method: "DELETE" });
  allAlerts = allAlerts.filter(a => a.id !== id);
  renderAlerts();
  updateCounters();
}

// ── Init ──────────────────────────────────────
checkHealth();
setInterval(checkHealth, 8000);