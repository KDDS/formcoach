import {
  FilesetResolver,
  PoseLandmarker,
  DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

const EXERCISES = {
  squat: {
    name: "Squat",
    tips: ["Feet about shoulder width", "Knees track over toes", "Hips drop below parallel if you can", "Chest tall, heels stay down"],
    count: "up-down"
  },
  lunge: {
    name: "Reverse lunge",
    tips: ["Long step back", "Front knee stacked over ankle", "Torso upright", "Back knee lowers with control"],
    count: "up-down"
  },
  pushup: {
    name: "Push-up",
    tips: ["Hands under shoulders", "Body in one line", "Elbows about 45 degrees", "Chest nearly to floor"],
    count: "up-down"
  },
  plank: {
    name: "Plank hold",
    tips: ["Elbows under shoulders", "Glutes tight", "Hips not sagging or piked", "Neck long"],
    count: "hold"
  },
  ohp: {
    name: "Bodyweight press pattern",
    tips: ["Ribs down", "Arms travel close to ears", "No lower-back flare", "Finish with biceps by ears"],
    count: "up-down"
  }
};

const video = document.getElementById("cam");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const refCanvas = document.getElementById("refCanvas");
const rctx = refCanvas.getContext("2d");
const el = (id) => document.getElementById(id);

let landmarker = null;
let running = false;
let sessionOn = false;
let voiceOn = true;
let lastSpeak = 0;
let lastSpoken = "";
let lastTs = 0;
let reps = 0;
let phase = "up";
let holdMs = 0;
let lastGood = 0;

function speak(text, force = false) {
  if (!voiceOn || !window.speechSynthesis) return;
  const now = performance.now();
  if (!force && (text === lastSpoken || now - lastSpeak < 2600)) return;
  lastSpoken = text;
  lastSpeak = now;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  u.pitch = 0.95;
  speechSynthesis.speak(u);
}

function setCue(title, body, kind = "") {
  el("cueTitle").textContent = title;
  el("cueBody").textContent = body;
  el("cueTitle").className = kind ? `cue-${kind}` : "";
}

function angle(a, b, c) {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const mag = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
  if (!mag) return 180;
  return Math.acos(Math.min(1, Math.max(-1, dot / mag))) * (180 / Math.PI);
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 };
}

function visOk(pts, min = 0.45) {
  return pts.every((p) => p && (p.visibility == null || p.visibility >= min));
}

function analyze(lms, key) {
  const L = {
    lSho: lms[11], rSho: lms[12],
    lElb: lms[13], rElb: lms[14],
    lWri: lms[15], rWri: lms[16],
    lHip: lms[23], rHip: lms[24],
    lKne: lms[25], rKne: lms[26],
    lAnk: lms[27], rAnk: lms[28]
  };
  const issues = [];
  let score = 100;
  let depth = 0;
  let inRepBottom = false;
  const lKnee = angle(L.lHip, L.lKne, L.lAnk);
  const rKnee = angle(L.rHip, L.rKne, L.rAnk);
  const knee = (lKnee + rKnee) / 2;
  const lElbA = angle(L.lSho, L.lElb, L.lWri);
  const rElbA = angle(L.rSho, L.rElb, L.rWri);
  const elbow = (lElbA + rElbA) / 2;
  const shoulder = mid(L.lSho, L.rSho);
  const hips = mid(L.lHip, L.rHip);
  const torsoLean = Math.abs(Math.atan2(shoulder.x - hips.x, hips.y - shoulder.y) * 180 / Math.PI);

  if (key === "squat") {
    depth = Math.max(0, Math.min(1, (170 - knee) / 90));
    inRepBottom = knee < 110;
    if (knee > 150 && phase === "up") issues.push("Drop the hips. Sit back and down.");
    if (torsoLean > 35) { issues.push("Chest is collapsing. Keep the torso taller."); score -= 18; }
    score -= Math.max(0, 20 - depth * 20);
  }
  if (key === "lunge") {
    const frontKnee = Math.min(lKnee, rKnee);
    depth = Math.max(0, Math.min(1, (170 - frontKnee) / 80));
    inRepBottom = frontKnee < 115;
    if (frontKnee > 145) issues.push("Step back farther and drop the back knee.");
    if (torsoLean > 28) { issues.push("Stand taller. Do not fold over the front leg."); score -= 15; }
  }
  if (key === "pushup") {
    const bodyLine = angle(shoulder, hips, mid(L.lKne, L.rKne));
    depth = Math.max(0, Math.min(1, (170 - elbow) / 90));
    inRepBottom = elbow < 100;
    if (bodyLine < 150) { issues.push("Hips sagging. Brace like a plank."); score -= 22; }
    if (elbow > 160 && phase === "up") issues.push("Bend the elbows and lower as one piece.");
  }
  if (key === "plank") {
    const bodyLine = angle(shoulder, hips, mid(L.lKne, L.rKne));
    depth = Math.max(0, Math.min(1, (bodyLine - 140) / 40));
    if (bodyLine < 155) { issues.push("Hips too low. Squeeze glutes and ribs."); score -= 25; }
    if (hips.y + 0.06 < shoulder.y) { issues.push("Hips too high. Lengthen the body."); score -= 18; }
  }
  if (key === "ohp") {
    const armsUp = (L.lWri.y + L.rWri.y) / 2 < shoulder.y - 0.12;
    depth = armsUp ? 1 : Math.max(0, (shoulder.y - (L.lWri.y + L.rWri.y) / 2 + 0.2) / 0.4);
    inRepBottom = !armsUp;
    if (torsoLean > 22) { issues.push("Ribs flaring. Squeeze glutes before you press."); score -= 20; }
    if (!armsUp && phase === "up") issues.push("Finish with hands stacked over the shoulders.");
  }
  if (!issues.length && score > 85) issues.push("Good. Stay tight and keep that line.");
  score = Math.max(35, Math.min(100, Math.round(score - issues.length * 4)));
  return { score, issues, depth, inRepBottom };
}

function updateReps(key, info, dt) {
  if (!sessionOn) return;
  const spec = EXERCISES[key];
  if (spec.count === "hold") {
    if (info.score >= 78) {
      holdMs += dt;
      if (Math.floor(holdMs / 1000) !== Math.floor((holdMs - dt) / 1000)) {
        reps = Math.floor(holdMs / 1000);
        if (reps > 0 && reps % 10 === 0) speak(`${reps} seconds. Hold the brace.`);
      }
    }
    el("phaseLabel").textContent = info.score >= 78 ? "hold" : "reset";
    return;
  }
  if (phase === "up" && info.inRepBottom && info.depth > 0.45) phase = "down";
  else if (phase === "down" && !info.inRepBottom && info.depth < 0.25) {
    phase = "up";
    reps += 1;
    speak(info.score >= 80 ? `${reps}. Clean.` : `${reps}. Tighten form.`);
  }
  el("phaseLabel").textContent = phase;
}

function drawLive(lms, good) {
  overlay.width = overlay.clientWidth;
  overlay.height = overlay.clientHeight;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const draw = new DrawingUtils(ctx);
  draw.drawConnectors(lms, PoseLandmarker.POSE_CONNECTIONS, { color: good ? "#5eead4" : "#f5c14a", lineWidth: 3 });
  draw.drawLandmarks(lms, { color: "#d5dbe3", radius: 3.2 });
}

function drawRef(key, depth) {
  const w = refCanvas.width = refCanvas.clientWidth;
  const h = refCanvas.height = refCanvas.clientHeight;
  rctx.clearRect(0, 0, w, h);
  const cx = w * 0.52;
  const ground = h * 0.86;
  const scale = Math.min(w, h) * 0.42;
  const t = Math.min(1, Math.max(0, depth ?? 0.15));
  function bone(x1, y1, x2, y2) {
    rctx.strokeStyle = "#8aa4b8";
    rctx.lineWidth = 8;
    rctx.lineCap = "round";
    rctx.beginPath();
    rctx.moveTo(x1, y1);
    rctx.lineTo(x2, y2);
    rctx.stroke();
  }
  function joint(x, y) {
    rctx.fillStyle = "#5eead4";
    rctx.beginPath();
    rctx.arc(x, y, 6, 0, Math.PI * 2);
    rctx.fill();
  }
  if (key === "squat") {
    const hipY = ground - scale * (0.42 - t * 0.18);
    const kneeY = ground - scale * 0.22;
    const shoulderY = hipY - scale * 0.34;
    const kneeX = 0.08 * scale;
    bone(cx, ground, cx - kneeX, kneeY);
    bone(cx, ground, cx + kneeX, kneeY);
    bone(cx - kneeX, kneeY, cx, hipY);
    bone(cx + kneeX, kneeY, cx, hipY);
    bone(cx, hipY, cx, shoulderY);
    bone(cx, shoulderY, cx - scale * 0.18, shoulderY + scale * 0.08);
    bone(cx, shoulderY, cx + scale * 0.18, shoulderY + scale * 0.08);
    joint(cx, hipY); joint(cx, shoulderY);
  } else if (key === "lunge") {
    bone(cx - scale * 0.22, ground, cx - scale * 0.08, ground - scale * 0.28);
    bone(cx - scale * 0.08, ground - scale * 0.28, cx, ground - scale * 0.4);
    bone(cx + scale * 0.2, ground, cx + scale * 0.06, ground - scale * 0.18);
    bone(cx + scale * 0.06, ground - scale * 0.18, cx, ground - scale * 0.4);
    bone(cx, ground - scale * 0.4, cx, ground - scale * 0.72);
    joint(cx, ground - scale * 0.4);
    joint(cx, ground - scale * 0.72);
  } else if (key === "pushup" || key === "plank") {
    const drop = key === "pushup" ? t * scale * 0.12 : 0;
    const y = ground - scale * 0.22 - drop;
    bone(cx - scale * 0.46, y, cx + scale * 0.38, y);
    bone(cx - scale * 0.46, y, cx - scale * 0.46, y + scale * 0.2);
    bone(cx + scale * 0.1, y, cx + scale * 0.1, ground);
    joint(cx - scale * 0.2, y);
  } else {
    const arms = 0.2 + t * 0.34;
    bone(cx, ground, cx, ground - scale * 0.72);
    bone(cx, ground - scale * 0.52, cx - scale * 0.08, ground - scale * arms);
    bone(cx, ground - scale * 0.52, cx + scale * 0.08, ground - scale * arms);
    joint(cx, ground - scale * 0.52);
  }
  rctx.fillStyle = "#1c2430";
  rctx.fillRect(w * 0.18, ground + 8, w * 0.64, 4);
}

async function initPose() {
  const files = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  const opts = { runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: 0.45, minTrackingConfidence: 0.45 };
  const model = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
  try {
    landmarker = await PoseLandmarker.createFromOptions(files, { ...opts, baseOptions: { modelAssetPath: model, delegate: "GPU" } });
  } catch {
    landmarker = await PoseLandmarker.createFromOptions(files, { ...opts, baseOptions: { modelAssetPath: model, delegate: "CPU" } });
  }
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
  running = true;
  el("splash").classList.add("hidden");
  speak("Camera is live. Get your full body in frame, then start the set.", true);
  loop();
}

function loop() {
  requestAnimationFrame(loop);
  if (!running || !landmarker || video.readyState < 2) return;
  const now = performance.now();
  const dt = lastTs ? now - lastTs : 16;
  lastTs = now;
  const result = landmarker.detectForVideo(video, now);
  const key = el("exercise").value;
  const spec = EXERCISES[key];
  if (!result.landmarks || !result.landmarks[0]) {
    el("visibility").textContent = "No person in frame";
    setCue("I cannot see you", "Step back until head and feet are visible.", "warn");
    drawRef(key, 0.2);
    return;
  }
  const lms = result.landmarks[0];
  const needed = [lms[11], lms[12], lms[23], lms[24], lms[25], lms[26], lms[27], lms[28]];
  el("visibility").textContent = visOk(needed, 0.28) ? "Tracking" : "Partial view — step back";
  const info = analyze(lms, key);
  drawLive(lms, info.score >= 80);
  drawRef(key, info.depth);
  updateReps(key, info, dt);
  el("repCount").textContent = String(reps);
  el("formScore").textContent = `${info.score}%`;
  const circ = 97.4;
  el("ringArc").setAttribute("stroke-dasharray", `${(info.score / 100) * circ} ${circ}`);
  el("ringArc").setAttribute("stroke", info.score >= 80 ? "#3dd68c" : info.score >= 65 ? "#f5c14a" : "#ff6b6b");
  const mainIssue = info.issues[0] || "Hold position.";
  setCue(sessionOn ? spec.name : "Ready", mainIssue, info.score >= 80 ? "good" : "warn");
  if (sessionOn && now - lastGood > 3200) {
    if (info.score < 75) speak(mainIssue);
    lastGood = now;
  }
}

function fillExercises() {
  const sel = el("exercise");
  sel.innerHTML = Object.entries(EXERCISES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("");
  renderTips();
  sel.addEventListener("change", () => {
    reps = 0; phase = "up"; holdMs = 0; renderTips();
    speak(`${EXERCISES[sel.value].name}.`, true);
  });
}

function renderTips() {
  const spec = EXERCISES[el("exercise").value];
  el("refTitle").textContent = spec.name;
  el("refTips").innerHTML = spec.tips.map((t) => `<li>${t}</li>`).join("");
}

el("startCam").addEventListener("click", async () => {
  try {
    if (!landmarker) await initPose();
    await startCamera();
  } catch (err) {
    setCue("Camera blocked", String(err.message || err), "bad");
    alert("Allow the camera in Safari. If it stays blocked, open this page from the Home Screen icon.");
  }
});

el("toggleSession").addEventListener("click", () => {
  sessionOn = !sessionOn;
  el("toggleSession").textContent = sessionOn ? "Pause" : "Start set";
  el("toggleSession").className = sessionOn ? "btn btn-stop" : "btn btn-go";
  if (sessionOn) speak(`Starting ${EXERCISES[el("exercise").value].name}. I will count and correct you.`, true);
  else speak("Set paused.", true);
});

el("resetBtn").addEventListener("click", () => {
  reps = 0; phase = "up"; holdMs = 0;
  el("repCount").textContent = "0";
  speak("Counters reset.", true);
});

el("muteBtn").addEventListener("click", () => {
  voiceOn = !voiceOn;
  el("muteBtn").textContent = voiceOn ? "Voice on" : "Voice off";
  if (!voiceOn) speechSynthesis.cancel();
});

fillExercises();
drawRef("squat", 0.35);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
if (navigator.wakeLock) {
  document.addEventListener("click", () => { navigator.wakeLock.request("screen").catch(() => {}); }, { once: true });
}
