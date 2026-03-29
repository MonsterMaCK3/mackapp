import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const API_BASE_URL = "http://localhost:8000";
const socket = io(API_BASE_URL);

export default function App() {
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState([]);
  const [exploreEvents, setExploreEvents] = useState([]); 
  const [tickets, setTickets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [exploreLoading, setExploreLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [selectedGenre, setSelectedGenre] = useState('All');
  const [isConnected, setIsConnected] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [revenue, setRevenue] = useState(0);

  const [proxyList] = useState([
    { ip: '192.168.1.44', location: 'US-East', latency: '42ms', status: 'Active' },
    { ip: '45.77.12.189', location: 'US-West', latency: '68ms', status: 'Active' },
    { ip: '104.248.5.11', location: 'CA-Central', latency: '51ms', status: 'Active' },
    { ip: '159.203.18.92', location: 'US-East', latency: '39ms', status: 'Active' },
  ]);

  const [users] = useState([
    { id: 'U-9921', name: 'Admin_Ink', role: 'Superuser', status: 'Active' },
    { id: 'U-4402', name: 'Dev_Node', role: 'Operator', status: 'Active' },
  ]);

  const [recentSearches, setRecentSearches] = useState(() => {
    const saved = localStorage.getItem('ink_recent');
    return saved ? JSON.parse(saved) : [];
  });
  const [trendingEvents, setTrendingEvents] = useState([]);

  const [activeTab, setActiveTab] = useState('explore'); 
  const [showSearchDrop, setShowSearchDrop] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const searchRef = useRef(null);

  const genres = ["All", "Rock", "Pop", "Hip-Hop", "Electronic", "Country", "Metal"];
  const gridLayout = "repeat(9, 1fr)";

  const theme = isDarkMode ? {
    bg: '#021831', panel: '#052a4e', sidebar: '#010f1f', border: '#113a62', text: '#ffffff', mute: '#94a3b8', accent: '#3b82f6', rowEven: '#032142', input: '#010c1a'
  } : {
    bg: '#ffffff', panel: '#f8fafc', sidebar: '#f1f5f9', border: '#cbd5e1', text: '#0f172a', mute: '#475569', accent: '#2563eb', rowEven: '#f1f5f9', input: '#ffffff'
  };

  useEffect(() => {
    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);
    const handleSync = (data) => {
      setSelectedEvent(current => {
        if (current?.id === data.event_id) {
          const sorted = [...data.tickets].sort((a, b) => 
            a.SEC.localeCompare(b.SEC, undefined, { numeric: true, sensitivity: 'base' })
          );
          setTickets(sorted);
        }
        return current;
      });
    };
    const handleLog = (data) => {
      setLogs(prev => [{ id: Date.now(), ...data, time: data.time || new Date().toLocaleTimeString('en-GB') }, ...prev].slice(0, 50));
      if (data.type === 'SOLD' || data.type === 'SUCCESS') {
        const match = data.msg.match(/\$(\d+\.?\d*)/);
        if (match) setRevenue(prev => prev + parseFloat(match[1]));
      }
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('inventory_sync', handleSync);
    socket.on('log', handleLog);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('inventory_sync', handleSync);
      socket.off('log', handleLog);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setExploreLoading(true);

    fetch(`${API_BASE_URL}/api/explore?genre=${selectedGenre}`, { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error("Network error");
        return res.json();
      })
      .then(data => { 
        setExploreEvents(data); 
        setTrendingEvents(data.slice(0, 5)); 
        setExploreLoading(false); 
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          console.error("Explore fetch failed", err);
          setExploreLoading(false);
        }
      });

    return () => controller.abort();
  }, [selectedGenre]);

  useEffect(() => {
    const handleClickOutside = (e) => { if (searchRef.current && !searchRef.current.contains(e.target)) setShowSearchDrop(false); };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelectEvent = (event) => {
    if (!event || !event.url) return;
    const updatedRecent = [event, ...recentSearches.filter(e => e.id !== event.id)].slice(0, 5);
    setRecentSearches(updatedRecent);
    localStorage.setItem('ink_recent', JSON.stringify(updatedRecent));
    setSelectedEvent(event);
    setShowSearchDrop(false);
    setTickets([]); 
    setActiveTab('inventory');
    fetch(`${API_BASE_URL}/api/scrape?event_id=${event.id}&url=${encodeURIComponent(event.url)}`)
      .catch(err => console.error("Scrape trigger failed", err));
  };

  const handleQuickCheckout = (ticket) => {
    if (!selectedEvent || !ticket.OFFER_ID) return;
    const cleanEdp = selectedEvent.url.split('?')[0];
    const encodedEdp = encodeURIComponent(cleanEdp);
    const checkoutUrl = `https://checkout.ticketmaster.com/${ticket.OFFER_ID}?ccp_src=2&ccp_channel=0&edp=${encodedEdp}&f_appview=false&f_appview_ln=false&f_appview_version=1&venue_owner=LN&f_layout=`;
    window.open(checkoutUrl, '_blank');
  };

  const searchEvents = async () => {
    if (!query) return;
    setEvents([]);
    setHasSearched(true);
    setSearchLoading(true);
    setShowSearchDrop(true); 
    try {
      const res = await fetch(`${API_BASE_URL}/api/search?keyword=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      setEvents(data);
    } catch (err) {
      console.error(err);
    } finally { 
      setSearchLoading(false); 
    }
  };

  return (
    <div style={{...styles.container, color: theme.text, background: theme.bg, transition: 'background 0.5s ease, color 0.5s ease'}}>
      <style>{`
        body, html, #root { margin: 0; padding: 0; height: 100vh; width: 100vw; overflow: hidden; background: ${theme.bg}; font-family: 'Inter', sans-serif; transition: background 0.5s ease; }
        * { box-sizing: border-box; }
        .pulse-dot { animation: pulse 2s infinite ease-in-out; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
        
        .loader { width: 18px; height: 18px; border: 2px solid ${theme.border}; border-bottom-color: ${theme.accent}; border-radius: 50%; display: inline-block; animation: rotation 0.8s linear infinite; transition: border 0.5s ease; }
        @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        .row-hover { transition: background 0.3s ease; cursor: pointer; }
        .row-hover:hover { background: ${isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'} !important; }
        
        .col-div { border-right: 1px solid ${theme.border}; padding: 0 15px; height: 100%; display: flex; align-items: center; overflow: hidden; font-size: 11px; transition: border 0.5s ease; }
        .col-div:last-child { border-right: none; }
        
        .explore-card { transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); cursor: pointer; border: 1px solid ${theme.border}; background: ${theme.panel}; border-radius: 8px; overflow: hidden; }
        .explore-card:hover { transform: translateY(-6px); border-color: ${theme.accent}; box-shadow: 0 10px 20px rgba(0,0,0,0.2); }
        
        .fade-in-slide { animation: fadeInSlide 0.4s ease forwards; }
        @keyframes fadeInSlide { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }

        .sidebar-item { transition: all 0.3s ease; }
        
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: ${theme.border}; border-radius: 10px; transition: background 0.5s ease; }
      `}</style>

      <header style={{...styles.topBar, background: theme.bg, borderBottom: `1px solid ${theme.border}`, transition: 'background 0.5s ease, border-bottom 0.5s ease'}}>
        <div style={styles.logoSection}>
          <span className="pulse-dot" style={{color: isConnected ? '#22c55e' : '#ef4444', marginRight: 10}}>●</span>
          <span style={{fontWeight: '900', letterSpacing: '1.5px', fontSize: 13}}>INK LLC.</span>
        </div>

        <div style={styles.searchWrapper} ref={searchRef}>
          <input
            placeholder="Artist, Event or Venue"
            style={{...styles.searchInput, background: theme.input, color: theme.text, borderColor: theme.border, transition: 'all 0.5s ease'}}
            value={query}
            onFocus={() => setShowSearchDrop(true)}
            onChange={(e) => { setQuery(e.target.value); setHasSearched(false); }}
            onKeyDown={(e) => e.key === 'Enter' && searchEvents()}
          />
          {showSearchDrop && (
            <div className="fade-in-slide" style={{...styles.dropdown, background: theme.panel, borderColor: theme.border, transition: 'background 0.5s ease, border 0.5s ease'}}>
              {query ? (
                searchLoading ? (
                  <div style={{padding: 25, textAlign: 'center', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12}}>
                    <span className="loader"></span>
                    <span style={{fontSize: 10, letterSpacing: 1, fontWeight: 'bold'}}>SYNCING DISCOVERY</span>
                  </div>
                ) :
                events.length > 0 ? events.map(e => (
                  <div key={e.id} className="row-hover" style={styles.dropItem} onClick={() => handleSelectEvent(e)}>
                    <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
                      <img src={e.image} style={{width: 35, height: 35, borderRadius: 4, objectFit: 'cover'}} alt="" />
                      <div style={{flex: 1}}>
                        <div style={{display: 'flex', justifyContent: 'space-between'}}>
                          <div style={{fontWeight: 'bold', fontSize: 11}}>{e.name}</div>
                          <div style={{fontSize: 10, color: theme.accent, fontWeight: 'bold'}}>{e.date}</div>
                        </div>
                        <div style={{fontSize: 10, color: theme.mute}}>{e.city}</div>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div style={{padding: 25, textAlign: 'center', fontSize: 11, color: theme.mute}}>
                    {hasSearched ? 'No results found' : 'Press Enter to search'}
                  </div>
                )
              ) : (
                <>
                  <div style={styles.sectionTitle}>Trending Searches</div>
                  {trendingEvents.map(e => (
                    <div key={e.id} className="row-hover" style={styles.dropItem} onClick={() => handleSelectEvent(e)}>
                       <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
                          <img src={e.image} style={{width: 35, height: 35, borderRadius: 4, objectFit: 'cover'}} alt="" />
                          <div>
                            <div style={{fontWeight: 'bold', fontSize: 11}}>{e.name}</div>
                            <div style={{fontSize: 9, color: theme.mute}}>{e.city} • {e.date}</div>
                          </div>
                       </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
        <button onClick={() => setIsDarkMode(!isDarkMode)} style={{...styles.themeToggle, color: theme.text, background: theme.panel, borderColor: theme.border, transition: 'all 0.3s ease'}}>{isDarkMode ? '☀️' : '🌙'}</button>
      </header>

      <div style={styles.body}>
        <aside style={{...styles.sidebar, background: theme.sidebar, borderRight: `1px solid ${theme.border}`, transition: 'background 0.5s ease, border-right 0.5s ease'}}>
          <div style={styles.navGroup}>
            <button onClick={() => setActiveTab('explore')} style={{...styles.navBtn, color: activeTab === 'explore' ? theme.accent : theme.mute, borderLeft: activeTab === 'explore' ? `4px solid ${theme.accent}` : '4px solid transparent', transition: 'all 0.3s ease'}}>🔥 EXPLORE</button>
            <button onClick={() => setActiveTab('inventory')} style={{...styles.navBtn, color: activeTab === 'inventory' ? theme.accent : theme.mute, borderLeft: activeTab === 'inventory' ? `4px solid ${theme.accent}` : '4px solid transparent', transition: 'all 0.3s ease'}}>📊 TM INVENTORY</button>
            <button onClick={() => setActiveTab('proxies')} style={{...styles.navBtn, color: activeTab === 'proxies' ? theme.accent : theme.mute, borderLeft: activeTab === 'proxies' ? `4px solid ${theme.accent}` : '4px solid transparent', transition: 'all 0.3s ease'}}>🌐 PROXIES</button>
            <button onClick={() => setActiveTab('users')} style={{...styles.navBtn, color: activeTab === 'users' ? theme.accent : theme.mute, borderLeft: activeTab === 'users' ? `4px solid ${theme.accent}` : '4px solid transparent', transition: 'all 0.3s ease'}}>👥 USERS</button>
          </div>
          
          {/* AUTO-HIDE SIDEBAR FOOTER */}
          {selectedEvent && (
            <div className="fade-in-slide" style={{marginTop: 'auto', padding: '20px', borderTop: `1px solid ${theme.border}`, transition: 'border-top 0.5s ease'}}>
              <div style={{fontSize: 9, color: theme.mute, fontWeight: '900', marginBottom: 10}}>SELECTED ASSET</div>
              <img src={selectedEvent.image} style={{width: '100%', height: 80, objectFit: 'cover', borderRadius: 6, marginBottom: 10}} alt="" />
              <div style={{fontSize: 11, fontWeight: 'bold'}}>{selectedEvent.name}</div>
              <div style={{fontSize: 10, color: theme.accent, marginTop: 4}}>{selectedEvent.city}</div>
            </div>
          )}
        </aside>

        <main style={{...styles.main, transition: 'all 0.5s ease'}}>
          {activeTab === 'explore' ? (
            <div style={{padding: '30px', overflowY: 'auto', flex: 1}}>
               {exploreLoading ? (
                 <div style={{display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px', gap: 12}}>
                   <span className="loader"></span>
                   <span style={{fontSize: 10, letterSpacing: 1, fontWeight: 'bold', color: theme.mute}}>LOADING EVENTS</span>
                 </div>
               ) : (
                 <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 20}}>
                    {exploreEvents.map(event => (
                      <div key={event.id} className="explore-card" onClick={() => handleSelectEvent(event)} style={{background: theme.panel, borderColor: theme.border, transition: 'all 0.4s ease'}}>
                        <img src={event.image} style={{width: '100%', height: 150, objectFit: 'cover'}} alt=""/>
                        <div style={{padding: 15}}><div style={{fontWeight: 'bold', fontSize: 12}}>{event.name}</div></div>
                      </div>
                    ))}
                 </div>
               )}
            </div>
          ) : activeTab === 'inventory' ? (
            <>
              <div style={{...styles.headerRow, gridTemplateColumns: gridLayout, background: theme.panel, color: theme.mute, borderBottom: `1px solid ${theme.border}`, transition: 'all 0.5s ease'}}>
                <div className="col-div">EVENT ID</div><div className="col-div">SECTION</div><div className="col-div">ROW</div><div className="col-div">SEATS</div><div className="col-div">FACE</div><div className="col-div">TOTAL</div><div className="col-div">TYPE</div><div className="col-div">STATUS</div><div className="col-div" style={{justifyContent: 'center'}}>ACTION</div>
              </div>
              <div style={{overflowY: 'auto', flex: 1}}>
                {tickets.map((t, i) => (
                  <div key={i} className="row-hover" style={{...styles.row, gridTemplateColumns: gridLayout, borderBottom: `1px solid ${theme.border}`, background: i % 2 === 0 ? theme.rowEven : 'transparent', transition: 'background 0.5s ease, border-bottom 0.5s ease'}}>
                    <div className="col-div" style={{fontSize: 9, opacity: 0.7, fontFamily: 'monospace', textTransform: 'uppercase'}}>{selectedEvent?.id?.toUpperCase()}</div>
                    <div className="col-div" style={{color: theme.accent, fontWeight: '800'}}>{t.SEC}</div><div className="col-div">{t.ROW}</div><div className="col-div">{t.SEATS}</div><div className="col-div" style={{color: theme.mute}}>${t.FACE}</div><div className="col-div" style={{color: '#22c55e', fontWeight: 'bold'}}>${t.TOTAL}</div><div className="col-div" style={{fontSize: 10}}>{t.TYPE}</div><div className="col-div"><span style={{fontSize: 9, fontWeight: '900', color: '#22c55e', background: 'rgba(34, 197, 94, 0.1)', padding: '2px 6px', borderRadius: 4}}>ACTIVE</span></div><div className="col-div" style={{justifyContent: 'center'}}><button onClick={() => handleQuickCheckout(t)} style={{...styles.syncBtn, background: theme.accent, transition: 'background 0.3s ease'}}>PURCHASE</button></div>
                  </div>
                ))}
              </div>
            </>
          ) : activeTab === 'users' ? (
            <div style={{padding: '30px', flex: 1}} className="fade-in-slide">
               <h2 style={{fontSize: 14, fontWeight: '900', letterSpacing: '1px', marginBottom: 20}}>ACCESS MANAGEMENT</h2>
               <div style={{background: theme.panel, border: `1px solid ${theme.border}`, borderRadius: 8, overflow: 'hidden', transition: 'all 0.5s ease'}}>
                  <div style={{display: 'grid', gridTemplateColumns: '150px 200px 150px 1fr', height: 45, alignItems: 'center', background: 'rgba(0,0,0,0.1)', borderBottom: `1px solid ${theme.border}`, color: theme.mute, fontSize: 10, fontWeight: '900', padding: '0 20px', transition: 'all 0.5s ease'}}>
                    <div>USER ID</div><div>DISPLAY NAME</div><div>ROLE</div><div>STATUS</div>
                  </div>
                  {users.map(u => (
                    <div key={u.id} style={{display: 'grid', gridTemplateColumns: '150px 200px 150px 1fr', height: 50, alignItems: 'center', borderBottom: `1px solid ${theme.border}`, padding: '0 20px', fontSize: 12, transition: 'border-bottom 0.5s ease'}}>
                      <div style={{fontFamily: 'monospace', color: theme.accent}}>{u.id}</div>
                      <div style={{fontWeight: '700'}}>{u.name}</div>
                      <div>{u.role}</div>
                      <div><span style={{color: '#22c55e'}}>●</span> {u.status}</div>
                    </div>
                  ))}
               </div>
            </div>
          ) : activeTab === 'proxies' ? (
            <div style={{padding: '30px', flex: 1}} className="fade-in-slide">
               <h2 style={{fontSize: 14, fontWeight: '900', letterSpacing: '1px', marginBottom: 20}}>NETWORK TOPOLOGY</h2>
               <div style={{background: theme.panel, border: `1px solid ${theme.border}`, borderRadius: 8, overflow: 'hidden', transition: 'all 0.5s ease'}}>
                  <div style={{display: 'grid', gridTemplateColumns: '200px 150px 150px 1fr', height: 45, alignItems: 'center', background: 'rgba(0,0,0,0.1)', borderBottom: `1px solid ${theme.border}`, color: theme.mute, fontSize: 10, fontWeight: '900', padding: '0 20px', transition: 'all 0.5s ease'}}>
                    <div>IP ADDRESS</div><div>GEO LOCATION</div><div>LATENCY</div><div>STATUS</div>
                  </div>
                  {proxyList.map((p, i) => (
                    <div key={i} style={{display: 'grid', gridTemplateColumns: '200px 150px 150px 1fr', height: 50, alignItems: 'center', borderBottom: `1px solid ${theme.border}`, padding: '0 20px', fontSize: 12, transition: 'border-bottom 0.5s ease'}}>
                      <div style={{fontFamily: 'monospace', color: theme.accent, fontWeight: 'bold'}}>{p.ip}</div>
                      <div>{p.location}</div>
                      <div style={{color: parseInt(p.latency) < 50 ? '#22c55e' : '#f59e0b'}}>{p.latency}</div>
                      <div><span style={{color: '#22c55e'}}>●</span> {p.status}</div>
                    </div>
                  ))}
               </div>
            </div>
          ) : null}
        </main>

        <aside style={{...styles.activity, background: theme.sidebar, borderLeft: `1px solid ${theme.border}`, transition: 'background 0.5s ease, border-left 0.5s ease'}}>
          <div style={{padding: 15, borderBottom: `1px solid ${theme.border}`, transition: 'border-bottom 0.5s ease'}}>
              <div style={{fontSize: 10, fontWeight: '900', color: theme.mute}}>SYSTEM LOGS</div>
              <div style={{color: '#22c55e', fontSize: 11, fontWeight: 'bold', marginTop: 5}}>SESSION PROFIT: ${revenue.toFixed(2)}</div>
          </div>
          <div style={{overflowY: 'auto', flex: 1, padding: '5px'}}>
            {logs.map(log => (
              <div key={log.id} style={{padding: '10px 12px', borderBottom: `1px solid ${theme.border}`, borderLeft: `3px solid ${log.type === 'SOLD' ? '#22c55e' : log.type === 'ERR' ? '#ef4444' : theme.accent}`, transition: 'all 0.3s ease'}}>
                <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 9}}>
                  <span style={{fontWeight: '900', color: log.type === 'SOLD' ? '#22c55e' : theme.accent}}>{log.type}</span>
                  <span style={{color: theme.mute}}>{log.time}</span>
                </div>
                <div style={{fontSize: 11, marginTop: 4, opacity: 0.9}}>{log.msg}</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

const styles = {
  container: { height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topBar: { height: '65px', display: 'flex', alignItems: 'center', padding: '0 25px', zIndex: 1000, flexShrink: 0 },
  logoSection: { width: '220px', display: 'flex', alignItems: 'center' },
  searchWrapper: { flex: 1, maxWidth: '550px', position: 'relative' },
  searchInput: { width: '100%', padding: '10px 15px', borderRadius: '6px', border: '1px solid', outline: 'none', fontSize: '12px' },
  dropdown: { position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '8px', borderRadius: '8px', border: '1px solid', boxShadow: '0 10px 25px rgba(0,0,0,0.3)', maxHeight: '450px', overflowY: 'auto', zIndex: 1100 },
  dropItem: { padding: '12px', cursor: 'pointer' },
  sectionTitle: { padding: '12px 15px 5px 15px', fontSize: '10px', fontWeight: '900', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' },
  themeToggle: { marginLeft: '20px', padding: '8px 12px', borderRadius: '6px', border: '1px solid', cursor: 'pointer', fontSize: '14px' },
  body: { flex: 1, display: 'flex', width: '100%', overflow: 'hidden' },
  sidebar: { width: '240px', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  navGroup: { padding: '20px 0' },
  navBtn: { width: '100%', padding: '15px 20px', background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', fontSize: '11px', fontWeight: '900', letterSpacing: '1px' },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  headerRow: { display: 'grid', height: '45px', alignItems: 'center' },
  row: { display: 'grid', height: '45px', alignItems: 'center' },
  syncBtn: { border: 'none', color: 'white', padding: '5px 12px', borderRadius: '4px', fontSize: '9px', fontWeight: '900', cursor: 'pointer' },
  activity: { width: '300px', display: 'flex', flexDirection: 'column', flexShrink: 0 }
};
