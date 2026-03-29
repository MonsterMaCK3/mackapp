import json
import time
import random
import os
import asyncio
import datetime
import warnings
import threading
import requests
import socketio
from dotenv import load_dotenv
from camoufox.sync_api import Camoufox
from curl_cffi import requests as cffi_requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()
warnings.filterwarnings("ignore")

# --- CONFIGURATION ---
API_KEY = os.getenv("TM_API_KEY", "5FEN5WBQJpnLaV6TbrtNCr0oyEjQn0Yo")
RAW_PROXIES = [
    "208.194.193.195:6503:OR393579809:tv299fea63",
    "208.194.195.22:5256:OR393579809:tv299fea63"
]

GENRES = {
    "All": "", "Rock": "KnvZfZ7vAeA", "Pop": "KnvZfZ7vAev", "Hip-Hop": "KnvZfZ7vAv1",
    "Electronic": "KnvZfZ7vAvF", "Country": "KnvZfZ7vAv6", "Metal": "KnvZfZ7vAvt"
}

REQUEST_CACHE = {} 
last_inventory = {} 
active_monitors = set() 

# --- TTL CACHE FOR TM DISCOVERY API ---
_explore_cache = {}  # key: genre -> (timestamp, data)
_search_cache = {}   # key: keyword -> (timestamp, data)
EXPLORE_CACHE_TTL = 60  # seconds
SEARCH_CACHE_TTL = 30   # seconds

# --- CONNECTION POOL ---
tm_session = requests.Session()

sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
app = FastAPI()
socket_app = socketio.ASGIApp(sio, app)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

def get_random_proxy():
    p = random.choice(RAW_PROXIES).split(':')
    c_proxy = {"server": f"http://{p[0]}:{p[1]}", "username": p[2], "password": p[3]}
    r_proxy = {"http": f"http://{p[2]}:{p[3]}@{p[0]}:{p[1]}", "https": f"http://{p[2]}:{p[3]}@{p[0]}:{p[1]}"}
    return c_proxy, r_proxy

async def send_sys_log(msg, log_type="SYS"):
    await sio.emit('log', {'msg': msg, 'type': log_type, 'time': datetime.datetime.now().strftime("%H:%M:%S")})

def parse_tm_data(raw_data):
    offers = raw_data.get('offers', []) or raw_data.get('_embedded', {}).get('offer', []) or raw_data.get('subset', [])
    parsed = []
    for o in offers:
        attr = o.get('attributes', {})
        oid = attr.get('checkoutOfferId') or o.get('offerId') or o.get('id')
        if not oid: continue
        oid = str(oid).split(':')[0]
        
        # Capture Seat View Image
        view_img = o.get('imageUrl') or attr.get('viewImage') or ""
        
        total = float(o.get('totalPrice', 0) or o.get('price', 0))
        face = float(o.get('faceValue', 0) or total)
        s_from, s_to = str(o.get('seatFrom', '')), str(o.get('seatTo', ''))
        seats = f"{s_from}-{s_to}" if s_from and s_to and s_from != s_to else (s_from or "Any")
        
        if total > 0:
            parsed.append({
                'SEC': str(o.get('section') or o.get('sectionName') or 'GA'),
                'ROW': str(o.get('row', '-')),
                'SEATS': seats,
                'FACE': face,
                'TOTAL': total,
                'TYPE': o.get('name', 'Standard'),
                'OFFER_ID': oid,
                'VIEW_IMG': view_img
            })
    return sorted(parsed, key=lambda x: x['TOTAL'])

def run_hybrid_discovery(event_id, url):
    if event_id in REQUEST_CACHE:
        try:
            ctx = REQUEST_CACHE[event_id]
            _, proxies = get_random_proxy()
            r = cffi_requests.get(ctx["url"], headers=ctx["headers"], cookies=ctx["cookies"], proxies=proxies, timeout=10, impersonate="chrome124")
            if r.status_code == 200: return parse_tm_data(r.json())
        except Exception: pass

    c_proxy, _ = get_random_proxy()
    ctx_new = {"url": None, "headers": {}, "cookies": {}}
    intercepted = threading.Event()
    try:
        with Camoufox(proxy=c_proxy, headless=True, humanize=True) as browser:
            page = browser.new_page()
            def handle_request(r):
                targets = ["offeradapter", "api/v3/offers", "api/v2/subset"]
                if any(t in r.url for t in targets) and not ctx_new["url"]:
                    ctx_new.update({"url": r.url, "headers": dict(r.headers)})
                    intercepted.set()
            
            page.on("request", handle_request)
            page.goto(url, wait_until="commit", timeout=40000)
            intercepted.wait(timeout=12)
            ctx_new["cookies"] = {c['name']: c['value'] for c in page.context.cookies()}
            if ctx_new["url"]:
                REQUEST_CACHE[event_id] = ctx_new
                _, proxies = get_random_proxy()
                r = cffi_requests.get(ctx_new["url"], headers=ctx_new["headers"], cookies=ctx_new["cookies"], proxies=proxies, impersonate="chrome124")
                return parse_tm_data(r.json())
    except Exception as e: print(f"DEBUG: Scraper Exception -> {e}")
    return []

async def start_always_on_monitor(event_id, url):
    if event_id in active_monitors: return
    active_monitors.add(event_id)
    await send_sys_log(f"Monitor Started: {event_id}")
    try:
        while event_id in active_monitors:
            try:
                tickets = await asyncio.get_event_loop().run_in_executor(None, run_hybrid_discovery, event_id, url)
                if tickets:
                    await process_differential(event_id, tickets)
                    await sio.emit('inventory_sync', {'event_id': event_id, 'tickets': tickets})
                await asyncio.sleep(4) 
            except Exception as e:
                await send_sys_log(f"Monitor error [{event_id}]: {e}", "ERR")
                if event_id in REQUEST_CACHE: del REQUEST_CACHE[event_id]
                await asyncio.sleep(5)
    finally:
        active_monitors.discard(event_id)

async def process_differential(event_id, current_tickets):
    if event_id not in last_inventory:
        last_inventory[event_id] = {t['OFFER_ID']: t for t in current_tickets}
        return
    old_map = last_inventory[event_id]
    current_map = {t['OFFER_ID']: t for t in current_tickets}
    for oid, ticket in old_map.items():
        if oid not in current_map:
            await sio.emit('log', {'msg': f"SOLD: Sec {ticket['SEC']} Row {ticket['ROW']} ${ticket['TOTAL']:.2f}", 'type': 'SOLD', 'time': datetime.datetime.now().strftime("%H:%M:%S")})
    last_inventory[event_id] = current_map

def _parse_events(events):
    return [{"id": e['id'], "name": e['name'], "url": e.get('url'), "image": next((i['url'] for i in e.get('images', []) if i.get('ratio') == '4_3'), ""), "city": e.get('_embedded', {}).get('venues', [{}])[0].get('city', {}).get('name', 'Unknown'), "date": e.get('dates', {}).get('start', {}).get('localDate', '9999-12-31')} for e in events]

@app.get("/api/explore")
def explore(genre: str = "All"):
    now = time.time()
    if genre in _explore_cache:
        cached_time, cached_data = _explore_cache[genre]
        if now - cached_time < EXPLORE_CACHE_TTL:
            return cached_data
    try:
        url = f"https://app.ticketmaster.com/discovery/v2/events.json?classificationName=music&apikey={API_KEY}&size=24&sort=relevance,desc"
        if GENRES.get(genre): url += f"&genreId={GENRES[genre]}"
        r = tm_session.get(url, timeout=10).json()
        events = r.get('_embedded', {}).get('events', [])
        result = _parse_events(events)
        _explore_cache[genre] = (now, result)
        return result
    except Exception: return []

@app.get("/api/search")
def search(keyword: str):
    now = time.time()
    cache_key = keyword.lower().strip()
    if cache_key in _search_cache:
        cached_time, cached_data = _search_cache[cache_key]
        if now - cached_time < SEARCH_CACHE_TTL:
            return cached_data
    try:
        r = tm_session.get(f"https://app.ticketmaster.com/discovery/v2/events.json?keyword={keyword}&apikey={API_KEY}&size=15", timeout=10).json()
        events = r.get('_embedded', {}).get('events', [])
        result = _parse_events(events)
        _search_cache[cache_key] = (now, result)
        return result
    except Exception: return []

@app.get("/api/scrape")
async def scrape_trigger(event_id: str, url: str):
    if event_id not in active_monitors:
        asyncio.create_task(start_always_on_monitor(event_id, url))
    return {"status": "Monitoring active"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(socket_app, host="0.0.0.0", port=8000)
