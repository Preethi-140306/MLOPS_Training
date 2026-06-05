import base64
import json
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False

app = FastAPI(title="Stray Animal Detector", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "models" / "best.pt"

print("MODEL PATH:", MODEL_PATH)
print("MODEL EXISTS:", MODEL_PATH.exists())

CONFIDENCE  = 0.50            
IOU         = 0.5
ALERT_AT    = 5               

COLORS = {
    "dog":    (0,   210, 20),   # green
    "cattle": (0,   140, 220),  # orange
}

model        = None
using_custom = False

detection_history = deque(maxlen=500)
total_detections  = 0
alerts            = []

@app.on_event("startup")
async def load_model():
    global model, using_custom

    if not YOLO_AVAILABLE:
        print("⚠️  ultralytics not installed — running in demo mode")
        return

    if Path(MODEL_PATH).exists():
        try:
            model        = YOLO(MODEL_PATH)
            using_custom = True
            print(f"✅ Custom model loaded: {MODEL_PATH}")
            print(f"   Model classes: {model.names}")
        except Exception as e:
            print(f"❌ Failed to load best.pt: {e}")
    else:
        print(f"❌ best.pt not found at {MODEL_PATH}")
        print("   Place best.pt in the backend folder")


def run_detection(frame: np.ndarray):
    """Run detection — returns (detections list, annotated frame)"""

    if model is None:
        return [], frame

    h, w   = frame.shape[:2]
    result = model(frame, conf=CONFIDENCE, iou=IOU, verbose=False)[0]

    detections = []
    annotated  = frame.copy()

    for box in result.boxes:
        cls_id     = int(box.cls[0])
        class_name = model.names.get(cls_id, "unknown")
        confidence = float(box.conf[0])

        if class_name not in ["dog", "cattle"]:
            continue

        x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]

        detections.append({
            "id":         str(uuid.uuid4())[:6],
            "class_name": class_name,
            "confidence": round(confidence, 2),
            "bbox":       [x1/w, y1/h, x2/w, y2/h],
            "timestamp":  datetime.utcnow().isoformat(),
        })

        color = COLORS.get(class_name, (200, 200, 0))
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)

        label = f"{class_name} {confidence:.0%}"
        (lw, lh), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(annotated, (x1, y1 - lh - 10), (x1 + lw + 6, y1), color, -1)

        cv2.putText(annotated, label, (x1 + 3, y1 - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    return detections, annotated


def to_base64(frame: np.ndarray) -> str:
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buf).decode()


def check_alert(counts: dict, session_id: str):
    total = sum(counts.values())
    if total >= ALERT_AT:
        alert = {
            "id":        str(uuid.uuid4())[:6],
            "message":   f"⚠️ {total} stray animals detected!",
            "counts":    counts,
            "total":     total,
            "location":  f"Camera {session_id[:4]}",
            "timestamp": datetime.utcnow().isoformat(),
            "severity":  "high" if total >= ALERT_AT * 2 else "medium",
        }
        alerts.insert(0, alert)
        if len(alerts) > 50:
            alerts.pop()
        return alert
    return None


@app.get("/health")
async def health():
    return {
        "status":      "ok",
        "model":       "custom (best.pt)" if using_custom else "not loaded",
        "classes":     ["dog", "cattle"],
        "ready":       model is not None,
        "detections":  total_detections,
        "timestamp":   datetime.utcnow().isoformat(),
    }


@app.post("/detect/image")
async def detect_image(file: UploadFile = File(...)):
    """Upload an image — get back detections + annotated image"""
    global total_detections

    data  = await file.read()
    arr   = np.frombuffer(data, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)

    if frame is None:
        raise HTTPException(400, "Could not read image. Upload a JPG or PNG file.")

    t0 = time.perf_counter()
    detections, annotated = run_detection(frame)
    elapsed = time.perf_counter() - t0

    # Count by class
    counts = defaultdict(int)
    for d in detections:
        counts[d["class_name"]] += 1

    session_id        = str(uuid.uuid4())[:6]
    total_detections += len(detections)

    detection_history.append({
        "session_id": session_id,
        "counts":     dict(counts),
        "total":      len(detections),
        "ts":         datetime.utcnow().isoformat(),
    })

    alert = check_alert(dict(counts), session_id)

    return {
        "session_id":  session_id,
        "total":       len(detections),
        "dog_count":   counts.get("dog", 0),
        "cattle_count": counts.get("cattle", 0),
        "detections":  detections,
        "image":       to_base64(annotated),
        "speed_ms":    round(elapsed * 1000),
        "timestamp":   datetime.utcnow().isoformat(),
        "alert":       alert,
    }


@app.post("/detect/video")
async def detect_video(file: UploadFile = File(...)):
    """Upload a video — get back per-frame animal counts"""
    global total_detections

    data = await file.read()
    tmp  = Path(f"temp_video_{uuid.uuid4()}.mp4")
    tmp.write_bytes(data)

    cap = cv2.VideoCapture(str(tmp))
    if not cap.isOpened():
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, "Could not open video file")

    fps_in     = cap.get(cv2.CAP_PROP_FPS) or 25
    frame_skip = max(1, int(fps_in // 4))  # process 4 frames per second
    session_id = str(uuid.uuid4())[:6]

    aggregated = defaultdict(int)
    timeline   = []
    frame_idx  = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % frame_skip == 0:
            dets, _ = run_detection(frame)
            counts  = defaultdict(int)
            for d in dets:
                counts[d["class_name"]] += 1
                aggregated[d["class_name"]] += 1
            timeline.append({
                "frame":  frame_idx,
                "dogs":   counts.get("dog", 0),
                "cattle": counts.get("cattle", 0),
                "total":  len(dets),
            })
            total_detections += len(dets)
        frame_idx += 1

    cap.release()
    tmp.unlink(missing_ok=True)

    return {
        "session_id":    session_id,
        "frames_checked": len(timeline),
        "dog_total":     aggregated.get("dog", 0),
        "cattle_total":  aggregated.get("cattle", 0),
        "grand_total":   sum(aggregated.values()),
        "timeline":      timeline[:100],
    }


@app.get("/stats")
async def get_stats():
    history = list(detection_history)[-50:]
    return {
        "total_detections": total_detections,
        "recent":           history,
        "alerts_pending":   len(alerts),
        "model_ready":      model is not None,
    }


@app.get("/alerts")
async def get_alerts():
    return alerts[:20]


@app.delete("/alerts/{alert_id}")
async def dismiss_alert(alert_id: str):
    global alerts
    alerts = [a for a in alerts if a["id"] != alert_id]
    return {"status": "dismissed"}


@app.websocket("/ws/live/{session_id}")
async def live_stream(websocket: WebSocket, session_id: str):
    """Receive frames from browser webcam, send back detections"""
    global total_detections

    await websocket.accept()
    frame_count = 0
    t_start     = time.perf_counter()

    try:
        while True:
            raw = await websocket.receive()

            if "bytes" in raw:
                arr   = np.frombuffer(raw["bytes"], np.uint8)
                frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                if frame is None:
                    continue
            elif "text" in raw:
                msg = json.loads(raw["text"])
                if msg.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
                continue
            else:
                continue

            dets, annotated = run_detection(frame)
            counts = defaultdict(int)
            for d in dets:
                counts[d["class_name"]] += 1

            frame_count      += 1
            elapsed           = time.perf_counter() - t_start
            fps               = round(frame_count / elapsed, 1) if elapsed > 0 else 0
            total_detections += len(dets)
            alert             = check_alert(dict(counts), session_id)

            await websocket.send_json({
                "type":            "result",
                "frame":           frame_count,
                "dog_count":       counts.get("dog", 0),
                "cattle_count":    counts.get("cattle", 0),
                "total":           len(dets),
                "fps":             fps,
                "annotated_image": to_base64(annotated),
                "alert":           alert,
            })

    except WebSocketDisconnect:
        pass

#backend = uvicorn main:app --host 127.0.0.1 --port 8000
#frontend = python -m http.server 5500 --bind 127.0.0.1