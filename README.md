# 🗑️ BinGo – Smart Scrap Recycling Platform
### YOLOv8 AI Detection + Instant Pickup Booking + Live GPS Tracking

🌐 **Live Website:** [https://somya183.github.io/BinGo/](https://somya183.github.io/BinGo/)  
🚀 **Local Server:** [http://localhost:5000](http://localhost:5000)  
📦 **GitHub Repository:** [https://github.com/Somya183/BinGo](https://github.com/Somya183/BinGo)

---

## 🌟 Overview

**BinGo** is an end-to-end intelligent scrap recycling platform built for Indian households and commercial scrap dealers. It combines computer vision, real-time geolocation matching, dynamic scrap rate engines, and live tracking into a seamless web experience.

### Key Features
- 🔍 **AI Scrap Classification:** YOLOv8n object detection classifies scrap into categories (Iron, Aluminium, Copper, PET Plastic, Cardboard, E-Waste, Brass, Steel, Glass) with automatic fallback to Gemini Vision and local spectral analysis.
- 📍 **Smart Dealer Discovery:** Dynamic 5-km radius geospatial query matching scrap sellers with active local scrap dealers and real-time pricing.
- 🚛 **Live Location Tracking:** Server-Sent Events (SSE) and polling fallback for real-time truck tracking and live ETA updates.
- 🏢 **Partner Dealer Portal:** Dealers can manage pickup requests, set custom item pricing, and toggle online/offline availability.
- 💾 **SQLite Database with Auto-Migration:** Automated database initialization, session authentication with Bcrypt password hashing, and user reward points system.

---

## 📁 Project Structure

```
BinGo/
├── index.html          ← Frontend application (single-page dashboard)
├── style.css           ← Modern green/dark theme styling
├── script.js           ← Client-side application logic & API client
├── app.py              ← Unified Flask backend API & static server
├── bingo.db            ← SQLite database (users, sessions, pickups, prices)
├── requirements.txt    ← Python dependencies
├── yolov8n.pt          ← YOLOv8 neural network weights
├── logo.png            ← Official BinGo brand logo
└── assets/             ← Visual assets & scrap item illustrations
    ├── dealer-auth.png
    └── scrap/
        ├── iron.png
        ├── aluminium.png
        ├── copper.png
        ├── plastic.png
        ├── cardboard.png
        ├── glass.png
        ├── brass.png
        ├── ewaste.png
        └── stainless.png
```

---

## ⚡ Quick Start & Deployment

### 1. Install Dependencies

Ensure Python 3.10+ is installed:

```bash
pip install -r requirements.txt
```

### 2. Launch Backend & Frontend

Start the Flask server:

```bash
python app.py
```

The server automatically:
1. Initializes and migrates `bingo.db` (creates missing tables and columns).
2. Verifies and seeds 9 Nagpur partner dealers and sets up default scrap pricing.
3. Serves the REST API on `http://localhost:5000/api`.
4. Serves the full frontend website at `http://localhost:5000`.

### 3. Open Website

- **Local Web App:** Visit [http://localhost:5000](http://localhost:5000) in your web browser.
- **Hosted / GitHub Pages:** Visit [https://somya183.github.io/BinGo/](https://somya183.github.io/BinGo/).

---

## 🧠 REST API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| **GET** | `/api/health` | Health check and YOLO mode status |
| **GET** | `/api/pricing` | Current market rates for all scrap materials |
| **POST** | `/api/detect` | YOLOv8 scrap item detection and nearby dealer matching |
| **GET** | `/api/dealers?lat=&lng=&radius=` | Nearby dealers sorted by distance |
| **GET** | `/api/dealers/<uid>/slots` | Available pickup time slots |
| **POST** | `/api/auth/signup` | User & Dealer registration |
| **POST** | `/api/auth/login` | Secure login with Bcrypt & session tokens |
| **GET** | `/api/auth/me` | Current authenticated user profile & points |
| **POST** | `/api/auth/logout` | Invalidate active user session |
| **POST** | `/api/auth/toggle-status` | Toggle dealer online/offline status |
| **POST** | `/api/auth/update-location` | Push user GPS & receive nearby dealers |
| **POST** | `/api/pickups` | Schedule and create scrap pickup request |
| **GET** | `/api/pickups/<pid>` | Retrieve pickup status & details |
| **POST** | `/api/pickups/<pid>/advance` | Advance pickup lifecycle (pending → accepted → en route → completed) |
| **POST** | `/api/location` | Push live GPS updates for a pickup |
| **GET** | `/api/location/<pid>` | Get latest user & dealer locations for a pickup |
| **GET** | `/api/location/<pid>/stream` | Server-Sent Events (SSE) real-time location stream |
| **GET** | `/api/dealer/pickups` | Incoming pickup requests for authenticated dealer |
| **GET** | `/api/dealer/prices` | Custom pricing table for authenticated dealer |
| **POST** | `/api/dealer/update-price` | Update price per kg for a scrap category |

---

## 🛠️ Database Schema (`bingo.db`)

The SQLite database contains:
- `users`: Stores sellers and dealers (`id`, `name`, `email`, `password_hash`, `role`, `address`, `phone`, `lat`, `lng`, `pts`, `is_active`, `created_at`).
- `sessions`: Persistent 30-day bearer tokens (`token`, `user_id`, `expires_at`).
- `pickups`: Scrap pickup orders (`id`, `user_id`, `dealer_id`, `item_name`, `weight_kg`, `price_per_kg`, `est_earning`, `user_lat`, `user_lng`, `status`, `slot_id`, `created_at`).
- `dealer_prices`: Custom per-dealer rates per scrap material (`dealer_id`, `item_name`, `price`).

---

## 👥 Demo Accounts

| Role | Email | Password |
|------|-------|----------|
| **Dealer 1** | `iron@bingo.com` | `dealer123` |
| **Dealer 2** | `orange@bingo.com` | `dealer123` |
| **User** | `dubeysomya651@gmail.com` | *(Registered user)* |

---

*Built with 💚 for BinGo – India's Smart Scrap Recycling Platform*
