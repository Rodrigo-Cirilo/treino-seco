import cv2
import threading
import time
import json
import asyncio
import websockets
from flask import Flask, send_from_directory, request, jsonify
import os
import numpy as np

# ======================== CONFIG ========================
RTSP_URL = "rtsp://admin:123456@192.168.1.4:5554"

ROI_SIZE_MM = 100
MM_TO_PX_RATIO = 2.0
FRONTEND_PX_MM = 3.0
ROI_TO_TARGET_SCALE = 1.0

ALVO_REAL_MM = {
    "7": 80,
    "X": 10
}

ALVO_VIRTUAL_PX = {
    key: int(value * FRONTEND_PX_MM) for key, value in ALVO_REAL_MM.items()
}

# ======================== VARIÁVEIS ========================
latest_hits = []
calibration_point = None
calibrating = False
roi_w = roi_h = int(ROI_SIZE_MM * MM_TO_PX_RATIO)
roi_x = roi_y = 0

# ======================== FLASK ========================
app = Flask(__name__, static_folder="frontend")

@app.route("/")
def index():
    return send_from_directory("frontend", "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory("frontend", path)

@app.route("/modo_calibracao", methods=["POST"])
def toggle_calibracao():
    global calibrating, calibration_point, latest_hits
    data = request.json
    calibrating = data.get("calibrando", False)
    if calibrating:
        calibration_point = None
        latest_hits.clear()
    return jsonify({"status": "ok"})

@app.route("/config", methods=["GET"])
def get_config():
    return jsonify({
        "roi_size_mm": roi_w / MM_TO_PX_RATIO,
        "roi_size_px": roi_w,
        "mm_to_px_ratio": MM_TO_PX_RATIO,
        "frontend_px_mm": FRONTEND_PX_MM,
        "roi_to_target_scale": ROI_TO_TARGET_SCALE,
        "alvo_real_mm": ALVO_REAL_MM,
        "alvo_virtual_px": ALVO_VIRTUAL_PX
    })

# ======================== DETECÇÃO ========================



def detect_laser_point(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # Suaviza e destaca pontos muito brilhantes
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, mask = cv2.threshold(blurred, 240, 255, cv2.THRESH_BINARY)

    # Remover pequenos ruídos
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        largest = max(contours, key=cv2.contourArea)
        (x, y), radius = cv2.minEnclosingCircle(largest)
        if radius > 0.5:
            return int(x), int(y)
    return None

# ======================== SCORE ========================
def calculate_score(dx_mm, dy_mm):
    distance_mm = (dx_mm ** 2 + dy_mm ** 2) ** 0.5
    radii_mm = [(key, value / 2) for key, value in ALVO_REAL_MM.items()]
    radii_mm.sort(key=lambda x: x[1], reverse=True)
    for i, (ring, radius) in enumerate(radii_mm):
        if distance_mm <= radius:
            if ring == "X":
                return 10.9
            base_score = float(ring)
            if i < len(radii_mm) - 1:
                next_radius = radii_mm[i + 1][1]
                if next_radius < radius:
                    fraction = max(0, min(1.0, (radius - distance_mm) / (radius - next_radius)))
                    next_score = float(radii_mm[i + 1][0]) if radii_mm[i + 1][0] != "X" else 10.9
                    interpolated_score = base_score + fraction * (next_score - base_score)
                    return round(interpolated_score, 1)
            return round(base_score, 1)
    return 0.0

# ======================== LOOP VÍDEO ========================
def video_loop():
    global calibration_point, latest_hits, calibrating, roi_x, roi_y, roi_w, roi_h
    cap = cv2.VideoCapture(RTSP_URL)
    if not cap.isOpened():
        print("[ERRO] Não foi possível abrir o stream RTSP.")
        return
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    roi_x = (width - roi_w) // 2
    roi_y = (height - roi_h) // 2
    cv2.namedWindow("Camera - SCATT DIY", cv2.WINDOW_NORMAL)
    cv2.resizeWindow("Camera - SCATT DIY", 800, 450)

    last_detection_time = 0
    detection_cooldown = 1.0
    target_fps = 30
    frame_time = 1.0 / target_fps
    while True:
        start_time = time.time()
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.01)
            continue
        roi_frame = frame[roi_y:roi_y+roi_h, roi_x:roi_x+roi_w]
        point_in_roi = detect_laser_point(roi_frame)
        point = (roi_x + point_in_roi[0], roi_y + point_in_roi[1]) if point_in_roi else None
        current_time = time.time()
        if calibrating and point and (current_time - last_detection_time) > detection_cooldown:
            calibration_point = point
            calibrating = False
            latest_hits.clear()
            last_detection_time = current_time
        elif calibration_point and point and (current_time - last_detection_time) > detection_cooldown:
            dx_px = point[0] - calibration_point[0]
            dy_px = point[1] - calibration_point[1]
            dx_mm = dx_px / MM_TO_PX_RATIO
            dy_mm = dy_px / MM_TO_PX_RATIO
            frontend_x = 300 + (dx_mm * ROI_TO_TARGET_SCALE * FRONTEND_PX_MM)
            frontend_y = 300 + (dy_mm * ROI_TO_TARGET_SCALE * FRONTEND_PX_MM)
            score = calculate_score(dx_mm, dy_mm)
            latest_hits.append({"x": frontend_x, "y": frontend_y, "score": score})
            if len(latest_hits) > 50:
                latest_hits = latest_hits[-50:]
            last_detection_time = current_time

        preview = frame.copy()
        center = (roi_x + roi_w // 2, roi_y + roi_h // 2)
        radius = min(roi_w, roi_h) // 2
        cv2.circle(preview, center, radius, (255, 0, 0), 2)
        if calibration_point:
            cv2.circle(preview, calibration_point, 5, (255, 0, 255), -1)
        if point:
            cv2.circle(preview, point, 3, (0, 255, 0), -1)
        cv2.imshow("Camera - SCATT DIY", preview)
        key = cv2.waitKey(1) & 0xFF
        if key == 27:
            break
        elif key == ord('c'):
            calibrating = True
            calibration_point = None
            latest_hits.clear()
        elapsed = time.time() - start_time
        sleep_time = max(0, frame_time - elapsed)
        time.sleep(sleep_time)
    cap.release()
    cv2.destroyAllWindows()

# ======================== WEBSOCKET ========================
async def ws_handler(websocket):
    try:
        while True:
            await asyncio.sleep(0.05)
            if latest_hits:
                await websocket.send(json.dumps({"hits": latest_hits, "calibrando": calibrating}))
                latest_hits.clear()
    except websockets.exceptions.ConnectionClosed:
        pass

# ======================== FLASK EM THREAD ========================
def iniciar_flask():
    app.run(host="0.0.0.0", port=5000, debug=False)

# ======================== MAIN ========================
async def main_async():
    async with websockets.serve(ws_handler, "0.0.0.0", 8765):
        await asyncio.Future()

if __name__ == "__main__":
    threading.Thread(target=video_loop, daemon=True).start()
    threading.Thread(target=iniciar_flask, daemon=True).start()
    asyncio.run(main_async())
