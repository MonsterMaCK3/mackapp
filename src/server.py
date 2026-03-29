import json
import time
import random
import os
import asyncio
import datetime
import warnings
import threading
import re
import requests
import socketio
from dotenv import load_dotenv
from camoufox.sync_api import Camoufox
from curl_cffi import requests as cffi_requests
from fastapi import FastAPI
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
active_monitors = {}

# --- TTL CACHE FOR TM DISCOVERY API ---
_explore_cache = {}
_search_cache = {}
EXPLORE_CACHE_TTL = 60
SEARCH_CACHE_TTL = 30

# --- CONNECTION POOL ---
tm_session = requests.Session()

# --- APP INITIALIZATION ---
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# --- DYNAMIC GEOMETRY & ID MAPPING ---

def extract_event_id(url_or_id):
    match = re.search(r'event/([A-Z0-9]{13,16})', str(url_or_id))
    if match: return match.group(1)
    if len(str(url_or_id)) >= 13 and str(url_or_id).isalnum(): return str(url_or_id)
    return None

class VenueMap:
    def __init__(self):
        self.lookup = {}  # seat_id -> {"sec": section_name, "row": row_name}
        self.current_event = None

    def _walk_segments(self, segment, section_name=None):
        """Walk the segment hierarchy to map seat IDs to section/row.

        The geometry JSON structure is:
            COMPOSITE (name="105")
              SECTION (name="105")
                ROW (name="A")
                  placesNoKeys: [[seat_id, seat#, x, y, pricecat, ...], ...]

        Section and row names come from the PARENT segments, NOT from the
        seat arrays themselves.  The old find_seats_recursive treated
        index 1 (seat number) as row and index 4 (price category) as
        section -- both wrong.
        """
        cat = segment.get('segmentCategory', '')
        name = segment.get('name', '')
        found = {}

        if cat == 'SECTION':
            section_name = name

        if cat == 'ROW':
            row_name = name
            for seat in segment.get('placesNoKeys', []):
                if seat and len(seat) >= 1:
                    seat_id = str(seat[0])
                    found[seat_id] = {"sec": section_name or "?", "row": row_name}
            return found

        for child in segment.get('segments', []):
            found.update(self._walk_segments(child, section_name))

        return found

    def fetch_geometry(self, event_id):
        if self.current_event == event_id and self.lookup:
            return

        systems = ["TM-US", "HOST"]
        self.current_event = event_id
        self.lookup = {}
        success = False

        for sys_id in systems:
            geom_url = (
                f"https://mapsapi.tmol.io/maps/geometry/3/event/{event_id}"
                f"/placeDetailNoKeys?useHostGrids=true&app=PRD2663_EDP_NA"
                f"&sectionLevel=true&systemId={sys_id}"
            )
            print(f"DEBUG: Fetching geometry from {sys_id}...")

            try:
                _, r_proxy = get_random_proxy()
                response = cffi_requests.get(
                    geom_url,
                    proxies=r_proxy,
                    impersonate="chrome110",
                    timeout=20,
                    verify=False
                )

                print(f"DEBUG: {sys_id} Response Code: {response.status_code}")

                if response.status_code == 200:
                    data = response.json()
                    new_lookup = {}
                    for page in data.get('pages', []):
                        for seg in page.get('segments', []):
                            new_lookup.update(self._walk_segments(seg))

                    if new_lookup:
                        self.lookup = new_lookup
                        print(f"SUCCESS: Mapped {len(new_lookup)} seats via {sys_id}")
                        success = True
                        break
                    else:
                        print(f"DEBUG: {sys_id} returned 200 but no seats found in hierarchy")

            except Exception as e:
                print(f"CRITICAL ERROR on {sys_id}: {e}")

        if not success:
            print(f"FAILED: No geometry for {event_id}. Falling back to offer metadata.")

    def get_real_location(self, place_ids):
        if not place_ids: return None, None
        pid = str(place_ids[0]).split('[')[0]
        match = self.lookup.get(pid)
        return (match["sec"], match["row"]) if match else (None, None)

venue_mapper = VenueMap()

# --- HELPERS ---

def get_random_proxy():
    p = random.choice(RAW_PROXIES).split(':')
    c_proxy = {"server": f"http://{p[0]}:{p[1]}", "username": p[2], "password": p[3]}
    r_proxy = {"http": f"http://{p[2]}:{p[3]}@{p[0]}:{p[1]}", "https": f"http://{p[2]}:{p[3]}@{p[0]}:{p[1]}"}
    return c_proxy, r_proxy

async def send_sys_log(msg, log_type="SYS"):
    await sio.emit('log', {'msg': msg, 'type': log_type, 'time': datetime.datetime.now().strftime("%H:%M:%S")})

# --- SCRAPER LOGIC ---

def parse_tm_data(raw_data, event_id):
    venue_mapper.fetch_geometry(event_id)
    try:
        tm_event_id = raw_data.get('eventId', event_id)
        offers = raw_data.get('offers', []) or raw_data.get('_embedded', {}).get('offer', []) or raw_data.get('subset', [])
        parsed = []

        print(f"DEBUG: Processing {len(offers)} offers from inventory.")

        for o in offers:
            if o.get('inventoryType') != 'primary': continue

            place_ids = o.get('places', [])
            real_sec, real_row = venue_mapper.get_real_location(place_ids)

            if not real_sec: real_sec = o.get('section') or o.get('priceLevelSecname')

            oid_raw = str(o.get('offerId') or o.get('id') or "")
            if (not real_sec or real_sec == "Standard") and "BP" in oid_raw:
                bp_match = re.search(r'BP(\d+)', oid_raw)
                if bp_match: real_sec = bp_match.group(1)

            if real_sec and str(real_sec).startswith('P'): real_sec = str(real_sec)[1:]
            if not real_row: real_row = o.get('row')

            ticket_type_name = str(o.get('ticketType', {}).get('name', '')).upper()
            if not real_row or real_row == "-" or "STANDING" in ticket_type_name: real_row = "SRO"

            face = float(o.get('faceValue') or o.get('price') or 0)
            fees = sum(float(cp.get('amount', 0)) for cp in o.get('priceComponents', []) if cp.get('type') == 'fee')
            total = face + fees

            attr = o.get('attributes', {})
            oid = attr.get('checkoutOfferId') or o.get('offerId') or o.get('id')
            if not oid: continue
            oid_clean = str(oid).split(':')[0]
            qty = o.get('sellableQuantities', [1])[0]

            if total > 0:
                parsed.append({
                    'SEC': str(real_sec), 'ROW': str(real_row), 'FACE': face, 'FEES': fees,
                    'TOTAL': round(total, 2), 'TYPE': "STANDARD", 'OFFER_ID': oid_clean,
                    'QUICK_BUY': f"https://checkout.ticketmaster.com/?id={tm_event_id}&offerid={oid_clean}&q={qty}"
                })
        return sorted(parsed, key=lambda x: x['TOTAL'])
    except Exception as e:
        print(f"DEBUG: Parser Exception -> {e}")
        return []

def run_hybrid_discovery(event_id, url):
    if event_id in REQUEST_CACHE:
        try:
            ctx = REQUEST_CACHE[event_id]
            _, proxies = get_random_proxy()
            r = cffi_requests.get(ctx["url"], headers=ctx["headers"], cookies=ctx["cookies"], proxies=proxies, timeout=10, impersonate="chrome124")
            if r.status_code == 200: return parse_tm_data(r.json(), event_id)
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
                return parse_tm_data(r.json(), event_id)
    except Exception as e:
        print(f"DEBUG: Scraper Exception -> {e}")
    return []

async def start_always_on_monitor(event_id, url):
    await send_sys_log(f"Monitor Started: {event_id}")
    try:
        while True:
            try:
                tickets = await asyncio.get_event_loop().run_in_executor(None, run_hybrid_discovery, event_id, url)
                if tickets:
                    await process_differential(event_id, tickets)
                    await sio.emit('inventory_sync', {'event_id': event_id, 'tickets': tickets})
                await asyncio.sleep(4)
            except asyncio.CancelledError: break
            except Exception as e:
                await send_sys_log(f"Monitor error [{event_id}]: {e}", "ERR")
                if event_id in REQUEST_CACHE: del REQUEST_CACHE[event_id]
                await asyncio.sleep(5)
    finally:
        active_monitors.pop(event_id, None)

async def process_differential(event_id, current_tickets):
    if event_id not in last_inventory:
        last_inventory[event_id] = {t['OFFER_ID']: t for t in current_tickets}
        return
    old_map = last_inventory[event_id]
    current_map = {t['OFFER_ID']: t for t in current_tickets}
    for oid, ticket in old_map.items():
        if oid not in current_map:
            await sio.emit('log', {'msg': f"SOLD: Sec {ticket['SEC']} Row {ticket['ROW']} ${ticket['TOTAL']:.2f}", 'type': 'SOLD', 'time': datetime.datetime.now().strftime("%H:%M:%S")})
    for oid, ticket in current_map.items():
        if oid not in old_map:
            await sio.emit('log', {'msg': f"NEW: Sec {ticket['SEC']} Row {ticket['ROW']} (${ticket['TOTAL']:.2f})", 'type': 'NEW', 'time': datetime.datetime.now().strftime("%H:%M:%S")})
    last_inventory[event_id] = current_map

# --- ENDPOINTS ---

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
        params = {
            "classificationName": "music",
            "apikey": API_KEY,
            "size": 24,
            "sort": "relevance,desc"
        }
        if GENRES.get(genre):
            params["genreId"] = GENRES[genre]
        r = tm_session.get("https://app.ticketmaster.com/discovery/v2/events.json", params=params, timeout=10)
        if r.status_code != 200:
            print(f"DEBUG: Explore API returned {r.status_code}")
            return []
        data = r.json()
        if "fault" in data:
            print(f"DEBUG: Explore API fault: {data['fault'].get('faultstring', 'unknown')}")
            return []
        events = data.get('_embedded', {}).get('events', [])
        result = _parse_events(events)
        if result:
            _explore_cache[genre] = (now, result)
        return result
    except Exception as e:
        print(f"DEBUG: Explore exception: {e}")
        return []

@app.get("/api/search")
def search(keyword: str):
    now = time.time()
    cache_key = keyword.lower().strip()
    if cache_key in _search_cache:
        cached_time, cached_data = _search_cache[cache_key]
        if now - cached_time < SEARCH_CACHE_TTL:
            return cached_data
    try:
        params = {
            "keyword": keyword,
            "apikey": API_KEY,
            "size": 15,
            "classificationName": "music"
        }
        r = tm_session.get("https://app.ticketmaster.com/discovery/v2/events.json", params=params, timeout=10)
        if r.status_code != 200:
            print(f"DEBUG: Search API returned {r.status_code} for '{keyword}'")
            return []
        data = r.json()
        if "fault" in data:
            print(f"DEBUG: Search API fault for '{keyword}': {data['fault'].get('faultstring', 'unknown')}")
            return []
        events = data.get('_embedded', {}).get('events', [])
        result = _parse_events(events)
        if result:
            _search_cache[cache_key] = (now, result)
        return result
    except Exception as e:
        print(f"DEBUG: Search exception for '{keyword}': {e}")
        return []

@app.get("/api/scrape")
async def scrape_trigger(url: str, event_id: str = None):
    target_id = event_id or extract_event_id(url)
    if not target_id: return {"error": "Invalid Event ID"}
    if target_id not in active_monitors:
        task = asyncio.create_task(start_always_on_monitor(target_id, url))
        active_monitors[target_id] = task
    return {"status": f"Monitoring active for {target_id}"}

# --- ASGI WRAPPER ---
combined_app = socketio.ASGIApp(sio, app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(combined_app, host="0.0.0.0", port=8000)
