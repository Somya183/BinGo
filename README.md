# 🗑️ BinGo – Flask API Backend
### YOLOv8 + Pickup System + Live Location Tracking

---

## 📁 Project Structure

```
your-project/
├── index.html          ← Your existing frontend (updated)
├── style.css           ← Your existing styles (unchanged)
├── script.js           ← ✅ REPLACE with new version
├── logo.png, etc.      ← Your existing assets
│
└── backend/            ← New Flask backend folder
    ├── app.py          ← Flask API server
    └── requirements.txt
```

---

## ⚡ Quick Start

### 1. Install Python dependencies

```bash
cd backend
pip install -r requirements.txt
```

> **Note:** YOLOv8 installs PyTorch (~500 MB). On first run it also downloads
> the `yolov8n.pt` model (~6 MB). If you want a faster install without GPU
> support, replace `ultralytics` with `ultralytics --no-deps` and install
> `torch torchvision --index-url https://download.pytorch.org/whl/cpu`.

### 2. Start the Flask server

```bash
python app.py
```

Server starts at **http://localhost:5000**

### 3. Open your frontend

Open `index.html` in a browser. The frontend auto-detects the backend.

---

## 🧠 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Backend status + YOLO mode |
| **POST** | **`/api/detect`** | **YOLOv8 image detection + pricing** |
| GET | `/api/pricing` | All scrap category prices |
| GET | `/api/dealers?lat=&lng=` | Dealers sorted by distance |
| GET | `/api/dealers/{id}/slots` | Available pickup time slots |
| **POST** | **`/api/pickups`** | **Create a pickup request** |
| GET | `/api/pickups/{id}` | Get pickup status |
| POST | `/api/pickups/{id}/advance` | Advance pickup status (dealer use) |
| POST | `/api/location` | Push GPS location (user/dealer) |
| GET | `/api/location/{pickup_id}` | Get live locations for a pickup |
| **GET** | **`/api/location/{id}/stream`** | **SSE live location stream** |
| GET | `/api/dealer/{id}/requests` | Dealer's incoming requests |
| POST | `/api/auth/login` | Mock login |
| POST | `/api/auth/signup` | Mock signup |

---

## 📸 Detection API Usage

```javascript
// Frontend automatically sends image to Flask
// POST /api/detect  (multipart/form-data)
// Fields: image (file), lat, lng, weight_kg (optional), condition

// Response:
{
  "success": true,
  "yolo_mode": "real",   // or "simulation" if YOLOv8 not installed
  "top_item": {
    "detected_class": "bottle",
    "confidence": 0.91,
    "scrap_category": "PET Plastic",
    "recyclable": true,
    "price_per_kg": "₹18–28",
    "estimated_value": "—",
    "description": "Clear PET plastic..."
  },
  "detections": [...],   // top 5 detected objects
  "dealers": [...]       // nearby dealers sorted by distance
}
```

---

## 📍 Live Location Tracking

The system uses **Server-Sent Events (SSE)** for real-time tracking:

```javascript
// Frontend connects automatically when pickup is confirmed
const source = new EventSource('http://localhost:5000/api/location/PICKUP_ID/stream');
source.onmessage = (e) => {
  const { user, dealer, distance_km, eta_min, status } = JSON.parse(e.data);
  // Update map markers
};
```

In **simulation mode**, the dealer marker moves toward the user over ~15 minutes.
In **production**, dealers push their GPS via `POST /api/location`.

---

## 💰 Pricing Engine

Prices are dynamically calculated with:
- **Condition multipliers**: excellent (+10%), good (0%), fair (-15%), poor (-30%)
- **Daily market variation**: ±6% based on date seed
- **COCO class mapping**: YOLOv8 classes automatically mapped to scrap categories

---

## 🔄 Detection Flow

```
User uploads image
       ↓
1. Flask /api/detect (YOLOv8)
       ↓ (if backend offline)
2. Gemini Vision API
       ↓ (if Gemini unavailable)
3. Local Color/Texture Analysis
```

---

## 🚀 Production Deployment

1. Replace `API_BASE` in `script.js` with your server URL
2. Add a real database (SQLite / PostgreSQL) to replace in-memory stores
3. Use gunicorn: `gunicorn -w 4 app:app`
4. Train custom YOLOv8 weights on scrap dataset for better accuracy:
   ```bash
   yolo train model=yolov8n.pt data=scrap_dataset.yaml epochs=50
   ```
5. Deploy with nginx for SSE support (disable buffering)

---

## 📦 Dependencies

```
flask           – Web framework
flask-cors      – CORS for frontend access
ultralytics     – YOLOv8 detection
opencv-python   – Image processing
Pillow          – Image loading
numpy           – Array operations
```

---

*Built for BinGo – India's Smart Scrap Recycling Platform 💚*
