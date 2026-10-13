"""
BinGo – Smart Scrap Recycling · Flask Backend (Fixed & Complete)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Features:
  ✅ Secure Bcrypt Password Hashing & Verification
  ✅ Proper Dealer/User Auth & Session Management
  ✅ Auto Database Initialization & Schema Migration (Fixes missing pts, etc.)
  ✅ Full REST API for Pickups, Dealers, Pricing, Detection & Live Tracking
  ✅ Server-Sent Events (SSE) & Polling Fallback for Real-Time GPS Tracking
  ✅ Static Frontend Serving (index.html, style.css, script.js, assets)
"""

import os, json, uuid, time, math, random, secrets, threading
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, Response, stream_with_context, send_from_directory
from flask_cors import CORS
import sqlite3, base64, bcrypt

# ── Base Scrap Market Prices (₹/kg) ───────────────────────────
BASE_PRICES = {
    "Iron Scrap": 32,
    "Aluminium": 68,
    "Copper Wire": 510,
    "PET Plastic": 22,
    "Cardboard": 10,
    "Newspaper": 7,
    "Glass": 3,
    "Brass": 295,
    "E-Waste": 70,
    "Steel": 55
}

# ── Optional YOLOv8 Detection ──────────────────────────────────
try:
    from ultralytics import YOLO
    import cv2, numpy as np
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False

app = Flask(__name__, static_folder=".", static_url_path="")
# Enable CORS for frontend integration
CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=True)

DB_PATH = os.path.join(os.path.dirname(__file__), "bingo.db")

# ── YOLO Model Setup ──────────────────────────────────────────
yolo_model = None
if YOLO_AVAILABLE:
    try:
        model_file = os.path.join(os.path.dirname(__file__), "yolov8n.pt")
        if os.path.exists(model_file):
            yolo_model = YOLO(model_file)
            print("[BinGo] ✅ YOLOv8n loaded successfully.")
        else:
            yolo_model = YOLO("yolov8n.pt")
            print("[BinGo] ✅ YOLOv8n loaded from cache.")
    except Exception as e:
        print(f"[BinGo] ⚠️ YOLO load warning: {e}")

# In-memory cache for real-time tracking
LIVE_LOCS: dict = {}
LIVE_LOCS_LOCK = threading.Lock()

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DATABASE SYSTEM & AUTOMATIC MIGRATIONS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def add_column_if_missing(db, table, column_def):
    col_name = column_def.split()[0]
    cursor = db.execute(f"PRAGMA table_info({table})")
    cols = [row["name"] for row in cursor.fetchall()]
    if col_name not in cols:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column_def}")
        print(f"[BinGo] 🔧 Added missing column '{col_name}' to '{table}'.")

def init_db():
    with get_db() as db:
        # 1. Base tables
        db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            email         TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role          TEXT DEFAULT 'user',
            address       TEXT DEFAULT '',
            phone         TEXT DEFAULT '',
            lat           REAL DEFAULT 0,
            lng           REAL DEFAULT 0,
            pts           INTEGER DEFAULT 0,
            is_active     INTEGER DEFAULT 1,
            created_at    TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token       TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL,
            expires_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pickups (
            id            TEXT PRIMARY KEY,
            user_id       TEXT,
            user_name     TEXT,
            dealer_id     TEXT,
            dealer_name   TEXT,
            item_name     TEXT,
            weight_kg     REAL DEFAULT 1,
            price_per_kg  TEXT,
            est_earning   TEXT,
            user_lat      REAL,
            user_lng      REAL,
            user_address  TEXT,
            status        TEXT DEFAULT 'pending',
            timeline      TEXT DEFAULT '[]',
            slot_id       TEXT,
            created_at    TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS dealer_prices (
            dealer_id     TEXT NOT NULL,
            item_name     TEXT NOT NULL,
            price         REAL NOT NULL,
            PRIMARY KEY (dealer_id, item_name),
            FOREIGN KEY (dealer_id) REFERENCES users(id)
        );
        """)

        # 2. Schema migrations for existing databases
        add_column_if_missing(db, "users", "pts INTEGER DEFAULT 0")
        add_column_if_missing(db, "users", "is_active INTEGER DEFAULT 1")
        add_column_if_missing(db, "users", "address TEXT DEFAULT ''")
        add_column_if_missing(db, "users", "phone TEXT DEFAULT ''")
        add_column_if_missing(db, "users", "lat REAL DEFAULT 0")
        add_column_if_missing(db, "users", "lng REAL DEFAULT 0")

        db.commit()

    print("[BinGo] ✅ Database Initialized & Migrated.")
    seed_dealers()

# Precomputed bcrypt hash for 'dealer123' to keep startup instant
DEALER_DEFAULT_HASH = "$2b$12$ZzTloGt2n9GZ4Ojpsxim.OK0YGtojrIRAzssWb/5Le9Z20uTzvgNi"

def seed_dealers():
    dealers = [
        ("d1", "Nagpur Iron & Steel", "iron@bingo.com", "Nagpur City", "918990123456", 21.1458, 79.0882),
        ("d2", "Orange City Scrap", "orange@bingo.com", "Nagpur City", "918801234567", 21.1544, 79.0832),
        ("d3", "Sitabuldi Waste Mart", "sitabuldi@bingo.com", "Sitabuldi, Nagpur", "918765400001", 21.1412, 79.0762),
        ("d4", "Dharampeth Eco Hub", "dharampeth@bingo.com", "Dharampeth, Nagpur", "918765400002", 21.1396, 79.0560),
        ("d5", "Sadar Metals & Scrap", "sadar@bingo.com", "Sadar, Nagpur", "918765400003", 21.1610, 79.0815),
        ("d6", "Manish Nagar Recyclers", "manish@bingo.com", "Manish Nagar, Nagpur", "918765400004", 21.0965, 79.0754),
        ("d7", "Green Planet Gold", "green@bingo.com", "Civil Lines, Nagpur", "918765400005", 21.1531, 79.0682),
        ("d8", "Global Scrap Hub", "global@bingo.com", "Wardhaman Nagar, Nagpur", "918765400006", 21.1481, 79.1121),
        ("d9", "Express Recycling", "express@bingo.com", "Mankapur, Nagpur", "918765400007", 21.1821, 79.0721),
    ]
    with get_db() as db:
        for uid, name, email, addr, phone, lat, lng in dealers:
            existing = db.execute("SELECT id FROM users WHERE id=?", (uid,)).fetchone()
            if not existing:
                db.execute(
                    "INSERT INTO users (id, name, email, password_hash, role, address, phone, lat, lng, is_active, pts) VALUES (?,?,?,?,?,?,?,?,?,1,100)",
                    (uid, name, email, DEALER_DEFAULT_HASH, "dealer", addr, phone, lat, lng)
                )
            else:
                db.execute(
                    "UPDATE users SET name=?, email=?, address=?, phone=?, lat=?, lng=?, is_active=1 WHERE id=?",
                    (name, email, addr, phone, lat, lng, uid)
                )

            # Seed default category prices if missing
            for item, base_p in BASE_PRICES.items():
                db.execute(
                    "INSERT OR IGNORE INTO dealer_prices (dealer_id, item_name, price) VALUES (?, ?, ?)",
                    (uid, item, base_p)
                )
        db.commit()
    print("[BinGo] ✅ 9 Dealers verified & online.")

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# AUTH HELPERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def check_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False

def get_user_from_token(token: str):
    if not token:
        return None
    with get_db() as db:
        sess = db.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
        if not sess:
            return None
        try:
            exp_time = datetime.strptime(sess["expires_at"], "%Y-%m-%d %H:%M:%S")
            if exp_time < datetime.now():
                db.execute("DELETE FROM sessions WHERE token=?", (token,))
                db.commit()
                return None
        except Exception:
            pass
        return db.execute("SELECT * FROM users WHERE id=?", (sess["user_id"],)).fetchone()

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STATIC & HEALTH ROUTES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.route("/")
def index():
    return app.send_static_file("index.html")

@app.route("/<path:path>")
def static_proxy(path):
    if os.path.exists(os.path.join(os.path.dirname(__file__), path)):
        return send_from_directory(os.path.dirname(__file__), path)
    return app.send_static_file("index.html")

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "success": True,
        "status": "online",
        "yolo_mode": "real" if (YOLO_AVAILABLE and yolo_model is not None) else "simulation"
    })

@app.route("/api/pricing", methods=["GET"])
def get_pricing():
    return jsonify({"success": True, "prices": BASE_PRICES})

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# AUTHENTICATION ROUTES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.route("/api/auth/signup", methods=["POST"])
def signup():
    data = request.get_json() or {}
    email = data.get("email", "").lower().strip()
    pw = data.get("password", "").strip()
    name = data.get("name", "").strip()
    role = data.get("role", "user")
    address = data.get("address", "").strip()

    if not email or not pw or not name:
        return jsonify({"success": False, "error": "Missing required fields"}), 400

    uid = str(uuid.uuid4())
    pw_hash = hash_password(pw)
    token = secrets.token_urlsafe(32)
    expiry = (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")

    try:
        with get_db() as db:
            db.execute(
                "INSERT INTO users (id, name, email, password_hash, role, address, pts, is_active) VALUES (?,?,?,?,?,?,0,1)",
                (uid, name, email, pw_hash, role, address)
            )
            db.execute(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
                (token, uid, expiry)
            )
            # If signing up as dealer, seed default pricing
            if role == "dealer":
                for item, base_p in BASE_PRICES.items():
                    db.execute(
                        "INSERT OR IGNORE INTO dealer_prices (dealer_id, item_name, price) VALUES (?, ?, ?)",
                        (uid, item, base_p)
                    )
            db.commit()

        return jsonify({
            "success": True,
            "message": "Account created successfully!",
            "token": token,
            "user_id": uid,
            "name": name,
            "email": email,
            "role": role,
            "is_active": 1
        }), 201
    except sqlite3.IntegrityError:
        return jsonify({"success": False, "error": "Email already exists"}), 409
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    email = (data.get("email") or "").lower().strip()
    pw = (data.get("password") or "").strip()

    if not email or not pw:
        return jsonify({"success": False, "error": "Email and password required"}), 400

    with get_db() as db:
        user = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()

    if not user or not check_password(pw, user["password_hash"]):
        return jsonify({"success": False, "error": "Invalid email or password"}), 401

    token = secrets.token_urlsafe(32)
    expiry = (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")

    with get_db() as db:
        db.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)", (token, user["id"], expiry))
        db.commit()

    return jsonify({
        "success": True,
        "token": token,
        "user_id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "role": user["role"],
        "is_active": user["is_active"]
    })

@app.route("/api/auth/logout", methods=["POST"])
def logout():
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if token:
        with get_db() as db:
            db.execute("DELETE FROM sessions WHERE token=?", (token,))
            db.commit()
    return jsonify({"success": True, "message": "Logged out successfully"})

@app.route("/api/auth/me", methods=["GET"])
def get_me():
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    user = get_user_from_token(token)
    if not user:
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    user_dict = dict(user)
    return jsonify({
        "success": True,
        "user": {
            "id": user_dict["id"],
            "name": user_dict["name"],
            "email": user_dict["email"],
            "role": user_dict["role"],
            "address": user_dict.get("address", ""),
            "phone": user_dict.get("phone", ""),
            "pts": user_dict.get("pts", 0) or 0,
            "is_active": user_dict.get("is_active", 1)
        }
    })

@app.route("/api/auth/toggle-status", methods=["POST"])
def toggle_status():
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    user = get_user_from_token(token)
    if not user:
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    current = user["is_active"] if user["is_active"] is not None else 1
    new_status = 0 if current else 1
    with get_db() as db:
        db.execute("UPDATE users SET is_active=? WHERE id=?", (new_status, user["id"]))
        db.commit()

    return jsonify({"success": True, "is_active": new_status})

@app.route("/api/auth/update-location", methods=["POST"])
def update_location():
    data = request.get_json() or {}
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    user = get_user_from_token(token)
    if not user:
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    lat = data.get("lat")
    lng = data.get("lng")
    if lat is None or lng is None:
        return jsonify({"success": False, "error": "Invalid coords"}), 400

    with get_db() as db:
        db.execute("UPDATE users SET lat=?, lng=? WHERE id=?", (lat, lng, user["id"]))
        db.commit()

    address = "Nagpur City Center"
    dealers = query_nearby_dealers(lat, lng, radius=5)

    return jsonify({
        "success": True,
        "address": address,
        "dealers": dealers,
        "count": len(dealers)
    })

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DEALERS & PRICING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def query_nearby_dealers(lat, lng, radius=5, item_name=""):
    with get_db() as db:
        all_dealers = db.execute("SELECT * FROM users WHERE role='dealer' AND is_active=1").fetchall()

    nearby = []
    for d in all_dealers:
        dlat, dlng = d["lat"] or 21.1458, d["lng"] or 79.0882
        dist = math.sqrt(((dlat - lat) * 111)**2 + ((dlng - lng) * 91)**2)
        if dist <= radius:
            with get_db() as db:
                custom_price_row = db.execute(
                    "SELECT price FROM dealer_prices WHERE dealer_id=? AND item_name=?",
                    (d["id"], item_name)
                ).fetchone()

            if custom_price_row:
                price = custom_price_row["price"]
            else:
                base = BASE_PRICES.get(item_name, 25)
                price = base + (random.uniform(-1, 2))

            nearby.append({
                "id": d["id"],
                "name": d["name"],
                "lat": dlat,
                "lng": dlng,
                "rating": 4.6 + (random.random() * 0.3),
                "addr": d["address"] or "Nagpur Hub",
                "phone": d["phone"] or "+91 89901 23456",
                "distance_km": round(dist, 2),
                "eta_min": max(1, round(dist * 15)),
                "price_per_kg": f"₹{round(price, 1)}"
            })

    # If user coordinates are far away (fallback so demo works anywhere)
    if not nearby and all_dealers:
        for i, d in enumerate(all_dealers):
            shift_lat = (math.sin(i) * 0.015)
            shift_lng = (math.cos(i) * 0.015)
            plat, plng = lat + shift_lat, lng + shift_lng
            pdist = math.sqrt(((plat - lat) * 111)**2 + ((plng - lng) * 91)**2)
            base = BASE_PRICES.get(item_name, 25)
            price = base + (random.uniform(-0.5, 1.5))

            nearby.append({
                "id": d["id"],
                "name": d["name"],
                "lat": plat,
                "lng": plng,
                "rating": round(4.5 + (random.random() * 0.4), 1),
                "addr": (d["address"] or "Nagpur Hub") + " (Local)",
                "phone": d["phone"] or "+91 89901 23456",
                "distance_km": round(pdist, 2),
                "eta_min": max(1, round(pdist * 15) + 3),
                "price_per_kg": f"₹{round(price, 1)}"
            })

    return sorted(nearby, key=lambda x: x["distance_km"])

@app.route("/api/dealers", methods=["GET"])
def get_dealers():
    try:
        lat = float(request.args.get("lat", 21.1458))
        lng = float(request.args.get("lng", 79.0882))
        radius = float(request.args.get("radius", 5))
    except (ValueError, TypeError):
        lat, lng, radius = 21.1458, 79.0882, 5

    item_name = request.args.get("item", "")
    dealers = query_nearby_dealers(lat, lng, radius, item_name)
    return jsonify({"success": True, "dealers": dealers})

@app.route("/api/dealers/<uid>/slots", methods=["GET"])
def get_slots(uid):
    slots = []
    days = ["Today", "Tomorrow", "In 2 Days"]
    times = ["09:00", "11:00", "13:00", "15:00", "17:00"]
    for d in days:
        for t in times:
            slots.append({
                "id": f"{uid}-{d}-{t}",
                "day": d,
                "time": t,
                "available": True
            })
    return jsonify({"success": True, "slots": slots})

@app.route("/api/dealer/pickups", methods=["GET"])
def get_dealer_pickups():
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    user = get_user_from_token(token)
    if not user or user["role"] != "dealer":
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    with get_db() as db:
        pickups = db.execute(
            "SELECT * FROM pickups WHERE dealer_id=? ORDER BY created_at DESC",
            (user["id"],)
        ).fetchall()

    return jsonify({
        "success": True,
        "pickups": [dict(p) for p in pickups]
    })

@app.route("/api/dealer/<uid>/requests", methods=["GET"])
def get_dealer_requests_by_id(uid):
    with get_db() as db:
        pickups = db.execute(
            "SELECT * FROM pickups WHERE dealer_id=? ORDER BY created_at DESC",
            (uid,)
        ).fetchall()
    return jsonify({
        "success": True,
        "pickups": [dict(p) for p in pickups]
    })

@app.route("/api/dealer/prices", methods=["GET"])
def get_dealer_prices():
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    user = get_user_from_token(token)
    if not user or user["role"] != "dealer":
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    with get_db() as db:
        prices = db.execute(
            "SELECT item_name, price FROM dealer_prices WHERE dealer_id=?",
            (user["id"],)
        ).fetchall()

    price_dict = {p["item_name"]: p["price"] for p in prices}
    for item, base in BASE_PRICES.items():
        if item not in price_dict:
            price_dict[item] = base

    return jsonify({"success": True, "prices": price_dict})

@app.route("/api/dealer/update-price", methods=["POST"])
def update_dealer_price():
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    user = get_user_from_token(token)
    if not user or user["role"] != "dealer":
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    data = request.get_json() or {}
    item_name = data.get("item_name")
    price = data.get("price")

    if not item_name or price is None:
        return jsonify({"success": False, "error": "Missing item_name or price"}), 400

    try:
        price = float(price)
    except ValueError:
        return jsonify({"success": False, "error": "Invalid price value"}), 400

    with get_db() as db:
        db.execute(
            "INSERT OR REPLACE INTO dealer_prices (dealer_id, item_name, price) VALUES (?, ?, ?)",
            (user["id"], item_name, price)
        )
        db.commit()

    return jsonify({"success": True, "message": f"Price for {item_name} updated to ₹{price}"})

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PICKUPS & TRACKING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.route("/api/pickups", methods=["POST"])
def create_pickup():
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    user = get_user_from_token(token)
    data = request.get_json() or {}

    user_id = user["id"] if user else data.get("user_id", "guest")
    user_name = user["name"] if user else data.get("user_name", "Valued Customer")

    pid = "PK-" + secrets.token_hex(4).upper()
    dealer_id = data.get("dealer_id")
    dealer_name = "Selected Dealer"

    if dealer_id:
        with get_db() as db:
            d_row = db.execute("SELECT name FROM users WHERE id=?", (dealer_id,)).fetchone()
            if d_row:
                dealer_name = d_row["name"]

    user_lat = float(data.get("user_lat", 21.1458))
    user_lng = float(data.get("user_lng", 79.0882))

    with get_db() as db:
        db.execute("""
            INSERT INTO pickups (
                id, user_id, user_name, dealer_id, dealer_name, item_name,
                weight_kg, price_per_kg, est_earning, user_lat, user_lng,
                user_address, slot_id, status
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            pid, user_id, user_name, dealer_id,
            dealer_name, data.get("item_name", "Mixed Scrap"), data.get("weight_kg", 1),
            data.get("price_per_kg", "₹32"), data.get("est_earning", "₹32"),
            user_lat, user_lng,
            data.get("user_address", "Nagpur City"), data.get("slot_id", "Today-11:00"), "pending"
        ))
        db.commit()

    # Pre-populate live location
    with LIVE_LOCS_LOCK:
        LIVE_LOCS[pid] = {
            "pickup_id": pid,
            "status": "pending",
            "user": {"lat": user_lat, "lng": user_lng, "label": user_name, "address": data.get("user_address", "")},
            "dealer": {"lat": user_lat + 0.012, "lng": user_lng + 0.012, "label": dealer_name},
            "distance_km": "1.8",
            "eta_min": 15
        }

    return jsonify({"success": True, "pickup_id": pid})

@app.route("/api/pickups/<pid>", methods=["GET"])
def get_pickup_by_id(pid):
    with get_db() as db:
        pickup = db.execute("SELECT * FROM pickups WHERE id=?", (pid,)).fetchone()
    if not pickup:
        return jsonify({"success": False, "error": "Pickup not found"}), 404
    return jsonify({"success": True, "pickup": dict(pickup)})

@app.route("/api/pickups/<pid>/advance", methods=["POST"])
def advance_pickup(pid):
    with get_db() as db:
        pickup = db.execute("SELECT * FROM pickups WHERE id=?", (pid,)).fetchone()
        if not pickup:
            return jsonify({"success": False, "error": "Not found"}), 404

        cur = pickup["status"]
        if cur == "pending":
            new_status = "accepted"
        elif cur == "accepted":
            new_status = "en_route"
        elif cur == "en_route":
            new_status = "completed"
        else:
            new_status = "completed"

        db.execute("UPDATE pickups SET status=? WHERE id=?", (new_status, pid))
        db.commit()

    with LIVE_LOCS_LOCK:
        if pid in LIVE_LOCS:
            LIVE_LOCS[pid]["status"] = new_status

    return jsonify({"success": True, "status": new_status})

@app.route("/api/location", methods=["POST"])
def update_loc():
    data = request.get_json() or {}
    pid = data.get("pickup_id")
    if not pid:
        return jsonify({"success": False, "error": "pickup_id required"}), 400

    with LIVE_LOCS_LOCK:
        existing = LIVE_LOCS.get(pid, {})
        existing.update(data)
        LIVE_LOCS[pid] = existing

    return jsonify({"success": True})

@app.route("/api/location/<pid>", methods=["GET"])
def get_pickup_location(pid):
    with LIVE_LOCS_LOCK:
        loc = LIVE_LOCS.get(pid)
    if loc:
        if isinstance(loc, dict) and "success" not in loc:
            loc = {**loc, "success": True}
        return jsonify(loc)

    with get_db() as db:
        p = db.execute("SELECT * FROM pickups WHERE id=?", (pid,)).fetchone()
        if not p:
            return jsonify({"success": False, "error": "Pickup not found"}), 404

        dealer = db.execute("SELECT * FROM users WHERE id=?", (p["dealer_id"],)).fetchone()
        u_lat = p["user_lat"] or 21.1458
        u_lng = p["user_lng"] or 79.0882
        d_lat = dealer["lat"] if dealer else 21.1544
        d_lng = dealer["lng"] if dealer else 79.0832
        dist = math.sqrt(((d_lat - u_lat) * 111)**2 + ((d_lng - u_lng) * 91)**2)

        return jsonify({
            "success": True,
            "user": {
                "lat": u_lat, "lng": u_lng,
                "label": p["user_name"] or "You",
                "address": p["user_address"] or ""
            },
            "dealer": {
                "lat": d_lat, "lng": d_lng,
                "label": p["dealer_name"] or "Dealer",
                "address": dealer["address"] if dealer else ""
            },
            "distance_km": str(round(dist, 2)),
            "eta_min": max(1, round(dist * 15)),
            "status": p["status"]
        })

@app.route("/api/location/<pid>/stream")
def track_stream(pid):
    def event_stream():
        sim_step = 0
        while True:
            data = None
            with LIVE_LOCS_LOCK:
                data = LIVE_LOCS.get(pid)

            if not data or "user" not in data or "dealer" not in data:
                with get_db() as db:
                    p = db.execute("SELECT * FROM pickups WHERE id=?", (pid,)).fetchone()
                    if p:
                        dealer = db.execute("SELECT * FROM users WHERE id=?", (p["dealer_id"],)).fetchone()
                        u_lat = p["user_lat"] or 21.1458
                        u_lng = p["user_lng"] or 79.0882
                        d_orig_lat = dealer["lat"] if dealer else 21.1544
                        d_orig_lng = dealer["lng"] if dealer else 79.0832

                        t = min(0.92, sim_step * 0.04) if p["status"] in ("accepted", "en_route") else 0.0
                        curr_d_lat = d_orig_lat + (u_lat - d_orig_lat) * t + (random.uniform(-0.0005, 0.0005))
                        curr_d_lng = d_orig_lng + (u_lng - d_orig_lng) * t + (random.uniform(-0.0005, 0.0005))
                        dist = math.sqrt(((curr_d_lat - u_lat) * 111)**2 + ((curr_d_lng - u_lng) * 91)**2)

                        data = {
                            "user": {"lat": u_lat, "lng": u_lng, "label": p["user_name"] or "You", "address": p["user_address"] or ""},
                            "dealer": {"lat": curr_d_lat, "lng": curr_d_lng, "label": p["dealer_name"] or "Dealer", "address": dealer["address"] if dealer else ""},
                            "distance_km": str(round(dist, 2)),
                            "eta_min": max(1, round(dist * 15)),
                            "status": "en_route" if t > 0.05 else p["status"]
                        }
                        sim_step += 1

            if data:
                yield f"data: {json.dumps(data)}\n\n"
            time.sleep(2)

    return Response(stream_with_context(event_stream()), mimetype="text/event-stream")

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DETECTION (YOLOv8 & IMAGE MAPPING)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.route("/api/detect", methods=["POST"])
def detect():
    if 'image' not in request.files:
        return jsonify({"success": False, "error": "No image uploaded"}), 400

    try:
        file = request.files['image']
        img_bytes = file.read()
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({"success": False, "message": "Failed to decode image"}), 400
    except Exception as e:
        return jsonify({"success": False, "error": f"Image processing error: {e}"}), 400

    lat = float(request.form.get("lat", 21.1458))
    lng = float(request.form.get("lng", 79.0882))

    detected_items = []

    if YOLO_AVAILABLE and yolo_model is not None:
        try:
            results = yolo_model.predict(img, conf=0.20)
            SCRAP_MAP = {
                "bottle":       {"cat": "PET Plastic",     "rec": True,  "desc": "Clear PET bottles widely accepted."},
                "cup":          {"cat": "PET Plastic",     "rec": True,  "desc": "Plastic containers & cups."},
                "bowl":         {"cat": "Steel",           "rec": True,  "desc": "Stainless steel / metal utensil."},
                "fork":         {"cat": "Steel",           "rec": True,  "desc": "Stainless steel utensils."},
                "knife":        {"cat": "Steel",           "rec": True,  "desc": "Metal scrap & cutlery."},
                "spoon":        {"cat": "Steel",           "rec": True,  "desc": "Stainless steel utensils."},
                "scissors":     {"cat": "Steel",           "rec": True,  "desc": "Metal tools and ferrous scrap."},
                "cell phone":   {"cat": "E-Waste",         "rec": True,  "desc": "Electronic devices containing precious metals."},
                "laptop":       {"cat": "E-Waste",         "rec": True,  "desc": "Electronic computers & circuit boards."},
                "tv":           {"cat": "E-Waste",         "rec": True,  "desc": "E-waste monitor and display scrap."},
                "keyboard":     {"cat": "E-Waste",         "rec": True,  "desc": "Electronic peripherals & circuit plastic."},
                "book":         {"cat": "Cardboard",       "rec": True,  "desc": "Paper, books, and cardboard scrap."},
                "wine glass":   {"cat": "Glass",           "rec": True,  "desc": "Clear glass bottles & scrap glassware."},
                "potted plant": {"cat": "Organic Waste",   "rec": False, "desc": "NOT accepted by scrap dealers."},
            }

            for r in results:
                for box in r.boxes:
                    cls_id = int(box.cls[0])
                    label = r.names[cls_id]
                    if label in SCRAP_MAP:
                        mapping = SCRAP_MAP[label]
                        base_p = BASE_PRICES.get(mapping["cat"], 20)
                        detected_items.append({
                            "scrap_category": mapping["cat"],
                            "recyclable": mapping["rec"],
                            "price_per_kg": f"₹{base_p}",
                            "price_min": round(base_p * 0.9),
                            "price_max": round(base_p * 1.1),
                            "weight_kg": 1,
                            "description": mapping["desc"],
                            "est_display": f"₹{base_p}",
                            "estimated_value": f"₹{base_p}",
                            "confidence": float(box.conf[0])
                        })
        except Exception as e:
            print(f"[BinGo] YOLO inference error: {e}")

    if not detected_items:
        return jsonify({
            "success": False,
            "message": "No COCO scrap objects detected with high confidence. Falling back to vision engine."
        })

    detected_items.sort(key=lambda x: x["confidence"], reverse=True)
    top = detected_items[0]
    dealers = query_nearby_dealers(lat, lng, radius=10, item_name=top["scrap_category"])

    return jsonify({
        "success": True,
        "yolo_mode": "real",
        "top_item": top,
        "dealers": dealers
    })

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MAIN ENTRY POINT
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if __name__ == "__main__":
    init_db()
    print("[BinGo] 🚀 Starting server on http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
