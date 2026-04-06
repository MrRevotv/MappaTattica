window.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); }, { passive: false });

let user, socket, map, livelloSfondo;
let isUfficiale = false;
let possiedoComando = false;
const bounds = [[0, 0], [1080, 1920]];

let baseZoom = 0; // Verrà calcolato dopo fitBounds

let markerSquadre = {}; let markerPOI = {}; let datiSquadre = {};
let elementiSelezionati = []; let dragOffsets = {};
let drawItems = new L.FeatureGroup(); let archivioMappe = [];

let grigliaLayer = L.layerGroup(); let grigliaAttiva = false;
let matitaAttiva = false; let isDrawingFreehand = false; let freehandCoords = [];
let freehandPolyline = null;
let pingsAttivi = {};
let audioCtx = null;

async function startC2() {
    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            user = await res.json();
            isUfficiale = ['admin', 'responsabile'].includes(user.ruolo);

            document.getElementById('login-overlay').style.display = 'none';
            document.getElementById('pannello').style.display = 'flex';
            document.getElementById('sidebar').style.display = 'block';

            socket = io();
            initMap();
            setupSocket();

            // Richiesta permessi intelligente all'avvio
            socket.emit('richiedi_comando_iniziale');

            caricaListaMappe();
        }
    } catch (e) { console.error("Errore autenticazione:", e); }
}

function initMap() {
    map = L.map('map', { crs: L.CRS.Simple, minZoom: -4, maxZoom: 2, zoomControl: false, doubleClickZoom: false, attributionControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.fitBounds(bounds);
    baseZoom = map.getZoom(); // Registra lo zoom standard

    livelloSfondo = L.imageOverlay('mappe/avvio.png', bounds).addTo(map).bringToBack();
    map.addLayer(drawItems);

// --- GESTIONE MATITA (MOUSE + TOUCH NATIVO INFALLIBILE) ---
    
    // 1. Eventi Mouse (Funzionano su PC, ignorano il tocco per non fare doppioni)
    map.on('mousedown', (e) => {
        if (!matitaAttiva || (e.originalEvent && e.originalEvent.pointerType === 'touch')) return;
        iniziaDisegno(e.latlng);
    });
    map.on('mousemove', (e) => {
        if (!matitaAttiva || !isDrawingFreehand || (e.originalEvent && e.originalEvent.pointerType === 'touch')) return;
        continuaDisegno(e.latlng);
    });
    map.on('mouseup', () => {
        if (isDrawingFreehand) fineDisegno();
    });

    // 2. Eventi Touch Diretti dallo schermo (Per iPad/Tablet)
    const mapDiv = document.getElementById('map');
    
    mapDiv.addEventListener('touchstart', (e) => {
        if (!matitaAttiva) return;
        if (e.touches.length === 1) { // Solo se usi un dito o la Apple Pencil
            const latlng = map.mouseEventToLatLng(e.touches[0]);
            iniziaDisegno(latlng);
        }
    }, { passive: false });

    mapDiv.addEventListener('touchmove', (e) => {
        if (!matitaAttiva) return;
        e.preventDefault(); // Blocca fisicamente la pagina web per non farla scorrere
        if (isDrawingFreehand && e.touches.length === 1) {
            const latlng = map.mouseEventToLatLng(e.touches[0]);
            continuaDisegno(latlng);
        }
    }, { passive: false });

    mapDiv.addEventListener('touchend', () => {
        if (isDrawingFreehand) fineDisegno();
    }, { passive: false });
    // ----------------------------------------------------------

    // PING SONORO E VISIVO (Doppio click)
    map.on('dblclick', (e) => {
        eseguiSuonoPing(e.latlng.lat, e.latlng.lng, user.ruolo);
        socket.emit('invia_ping', { lat: e.latlng.lat, lng: e.latlng.lng, ruolo: user.ruolo });
    });
    map.on('click', () => { if (!matitaAttiva) deselezionaTutti(); });

    // Griglia dinamica basata sullo zoom standard
    map.on('zoomend', () => { if (grigliaAttiva) generaGrigliaTattica(); });

// Inizializza audio (sblocco browser silente permanente)
    document.body.addEventListener('click', () => { 
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); 
        if (audioCtx.state === 'suspended') audioCtx.resume(); 
    });
}

// Funzioni Touch/Matita
function iniziaDisegno(latlng) {
    isDrawingFreehand = true; freehandCoords = [latlng];
    freehandPolyline = L.polyline(freehandCoords, { color: '#ff4444', weight: 4, interactive: true }).addTo(drawItems);
}
function continuaDisegno(latlng) {
    if (isDrawingFreehand) {
        freehandCoords.push(latlng);
        freehandPolyline.setLatLngs(freehandCoords);
    }
}
function fineDisegno() {
    if (isDrawingFreehand) { isDrawingFreehand = false; socket.emit('salva_disegni', drawItems.toGeoJSON()); }
}

window.toggleMatita = () => {
    if (!possiedoComando) return; 
    matitaAttiva = !matitaAttiva;
    const btn = document.getElementById('btn-matita');
    
    if (matitaAttiva) {
        map.dragging.disable(); 
        map.touchZoom.disable();
        if (map.tap) map.tap.disable(); // Spegne ritardi Apple
        
        document.getElementById('map').style.cursor = 'crosshair';
        document.getElementById('map').classList.add('drawing-active');
        document.getElementById('map').style.touchAction = 'none'; // Sicurezza extra
        
        btn.style.background = '#daa520'; 
        btn.style.color = 'black';
    } else {
        map.dragging.enable(); 
        map.touchZoom.enable();
        if (map.tap) map.tap.enable();
        
        document.getElementById('map').style.cursor = '';
        document.getElementById('map').classList.remove('drawing-active');
        document.getElementById('map').style.touchAction = '';
        
        btn.style.background = '#333';
        btn.style.color = 'white';
    }
};

window.undoDisegno = () => {
    if (!possiedoComando) return; const layers = drawItems.getLayers();
    if (layers.length > 0) { drawItems.removeLayer(layers[layers.length - 1]); socket.emit('salva_disegni', drawItems.toGeoJSON()); }
};
window.clearDisegni = () => {
    if (!possiedoComando) return;
    if (confirm("Cancellare tutti i disegni a mano?")) { drawItems.clearLayers(); socket.emit('pulisci_lavagna'); }
};
window.toggleGriglia = () => { if (!possiedoComando) return; socket.emit('toggle_griglia_globale', !grigliaAttiva); };

// --- GRIGLIA TATTICA DINAMICA ---
function generaGrigliaTattica() {
    grigliaLayer.clearLayers();
    const SETTORI_X = 10;
    const SETTORI_Y = 6;
    const L_X = 1920 / SETTORI_X;
    const L_Y = 1080 / SETTORI_Y;

    // 1. LINEE PRINCIPALI (Sempre visibili)
    for (let x = 0; x <= 1920; x += L_X) { L.polyline([[0, x], [1080, x]], { color: 'rgba(255,255,255,0.4)', weight: 2, interactive: false }).addTo(grigliaLayer); }
    for (let y = 0; y <= 1080; y += L_Y) { L.polyline([[y, 0], [y, 1920]], { color: 'rgba(255,255,255,0.4)', weight: 2, interactive: false }).addTo(grigliaLayer); }

    // --- LOGICA ZOOM PER SOTTOQUADRANTI ---
    // Usiamo + 1.5 così al primo scatto (+1) non succede nulla, 
    // al secondo scatto (+2) i sottoquadranti appaiono.
    const mostraDettagli = map.getZoom() >= (baseZoom + 1.5);

    // 2. LINEE SOTTO-QUADRANTI (Solo dopo 2 scatti di zoom)
    if (mostraDettagli) {
        for (let x = 0; x <= 1920; x += L_X / 2) { L.polyline([[0, x], [1080, x]], { color: 'rgba(255,255,255,0.15)', weight: 1, dashArray: '5, 5', interactive: false }).addTo(grigliaLayer); }
        for (let y = 0; y <= 1080; y += L_Y / 2) { L.polyline([[y, 0], [y, 1920]], { color: 'rgba(255,255,255,0.15)', weight: 1, dashArray: '5, 5', interactive: false }).addTo(grigliaLayer); }
    }

    // 3. ETICHETTE
    for (let r = 0; r < SETTORI_Y; r++) {
        for (let c = 0; c < SETTORI_X; c++) {
            const x0 = c * L_X;
            const y0 = r * L_Y;

            // Lettera principale (Sempre visibile)
            const lettera = String.fromCharCode(65 + (SETTORI_Y - 1 - r));
            L.marker([y0 + L_Y / 2, x0 + L_X / 2], {
                icon: L.divIcon({ html: lettera + (c + 1), className: 'etichetta-coordinata', iconSize: [40, 20] }), interactive: false
            }).addTo(grigliaLayer);

            // Numeri sottoquadranti (Solo dopo 2 scatti di zoom)
            if (mostraDettagli) {
                const subs = [
                    { n: "1", pos: [y0 + (L_Y * 0.75), x0 + (L_X * 0.25)] },
                    { n: "2", pos: [y0 + (L_Y * 0.75), x0 + (L_X * 0.75)] },
                    { n: "3", pos: [y0 + (L_Y * 0.25), x0 + (L_X * 0.25)] },
                    { n: "4", pos: [y0 + (L_Y * 0.25), x0 + (L_X * 0.75)] }
                ];
                subs.forEach(s => {
                    L.marker(s.pos, {
                        icon: L.divIcon({ html: s.n, className: 'etichetta-coordinata-sub', iconSize: [20, 20] }), interactive: false
                    }).addTo(grigliaLayer);
                });
            }
        }
    }
}

function setupSocket() {
    socket.on('nuovo_log', (msg) => {
        const t = document.getElementById('terminal');
        t.innerHTML += `<div>${msg}</div>`;
        t.scrollTop = t.scrollHeight;
    });

socket.on('comandi_liberati', () => {
        // Se non sono un ufficiale, mi riprendo in automatico i poteri iniziali
        if (!isUfficiale) {
            socket.emit('richiedi_comando_iniziale');
            MostraNotifica("Ufficiale disconnesso: Comandi mappa sbloccati.");
        }
    });

    socket.on('comando_concesso', () => { possiedoComando = true; aggiornaPannelloPermessi(); MostraNotifica("Permessi di Comando Acquisiti"); });
    socket.on('comando_revocato', () => {
        // SICUREZZA: Se sono un ufficiale, ignoro questo segnale e mantengo i miei poteri
        if (isUfficiale) return; 
        
        possiedoComando = false;
        aggiornaPannelloPermessi();
        
        const btnRichiedi = document.getElementById('btn-richiedi');
        if (btnRichiedi) btnRichiedi.innerText = "Richiedi Comando";
        
        // Notifica visiva per l'operatore
        MostraNotifica("⚠️ Comando revocato: un Ufficiale è entrato online.");
    });

    socket.on('suono_richiesta_comando', () => {
        // Suona SOLO se chi ascolta è un admin o responsabile e ha già fatto un click nella pagina
        if (isUfficiale && audioCtx) {
            try {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                
                // Impostazioni del suono (Din dolce e rapido)
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, audioCtx.currentTime); 
                
                gain.gain.setValueAtTime(0, audioCtx.currentTime);
                gain.gain.linearRampToValueAtTime(0.15, audioCtx.currentTime + 0.05); 
                gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.4);     
                
                osc.start(audioCtx.currentTime);
                osc.stop(audioCtx.currentTime + 0.5);
            } catch(e) {}
        }
    });
    socket.on('aggiorna_richieste', (r) => { if (!isUfficiale) return; const t = document.getElementById('tendinaRichieste'); t.innerHTML = '<option value="">-- Richieste --</option>'; for (let id in r) t.innerHTML += `<option value="${id}">${r[id]}</option>`; });
    socket.on('aggiorna_autorizzati', (r) => { if (!isUfficiale) return; const t = document.getElementById('tendinaAutorizzati'); t.innerHTML = '<option value="">-- Operatori attivi --</option>'; for (let id in r) t.innerHTML += `<option value="${id}">${r[id]}</option>`; });
    socket.on('cambio_griglia_globale', (stato) => { grigliaAttiva = stato; if (stato) { generaGrigliaTattica(); map.addLayer(grigliaLayer); } else { map.removeLayer(grigliaLayer); } });
    socket.on('aggiorna_disegni', (disegni) => { drawItems.clearLayers(); if (disegni) L.geoJSON(disegni, { style: { color: '#ff4444', weight: 4 }, onEachFeature: (f, l) => drawItems.addLayer(l) }); });
    socket.on('stato_iniziale', (stato) => {
        if (map.hasLayer(livelloSfondo)) map.removeLayer(livelloSfondo);
        livelloSfondo = L.imageOverlay(stato.sfondo + '?t=' + Date.now(), bounds).addTo(map).bringToBack();
        if (stato.grigliaAttiva) { grigliaAttiva = true; generaGrigliaTattica(); map.addLayer(grigliaLayer); }

        // Pulisce tutto prima di caricare il nuovo stato
        for (let id in markerSquadre) map.removeLayer(markerSquadre[id]);
        for (let id in markerPOI) map.removeLayer(markerPOI[id]);

        markerSquadre = {}; markerPOI = {}; datiSquadre = {}; drawItems.clearLayers();

        if (stato.disegni) L.geoJSON(stato.disegni, { style: { color: '#ff4444', weight: 4 }, onEachFeature: (f, l) => drawItems.addLayer(l) });
        for (let id in stato.squadre) { creaMarker(stato.squadre[id]); if (stato.squadre[id].cerchioAttivo) aggiornaCerchioMarker(id, 'squadra', true); }
        for (let id in stato.poi) {
            creaMarker(stato.poi[id]);
            if (stato.poi[id].cerchioAttivo) aggiornaCerchioMarker(id, 'poi', true);
        }
        aggiornaSidebar();
    });
    socket.on('cambio_mappa', (url) => { if (map.hasLayer(livelloSfondo)) map.removeLayer(livelloSfondo); livelloSfondo = L.imageOverlay(url + '?t=' + Date.now(), bounds).addTo(map).bringToBack(); });
    socket.on('elemento_creato', (dati) => creaMarker(dati));
    socket.on('posizione_aggiornata', (dati) => { const m = dati.tipo === 'squadra' ? markerSquadre[dati.id] : markerPOI[dati.id]; if (m) m.setLatLng([dati.lat, dati.lng]); });
    socket.on('aggiorna_cerchio', (dati) => { if (dati.tipo === 'squadra' && datiSquadre[dati.id]) datiSquadre[dati.id].cerchioAttivo = dati.stato; aggiornaCerchioMarker(dati.id, dati.tipo, dati.stato); });
    socket.on('roster_aggiornato', (dati) => { if (datiSquadre[dati.id]) { datiSquadre[dati.id].roster = dati.roster; aggiornaSidebar(); } });
    socket.on('elemento_eliminato', (dati) => { if (dati.tipo === 'squadra' && markerSquadre[dati.id]) { map.removeLayer(markerSquadre[dati.id]); delete markerSquadre[dati.id]; delete datiSquadre[dati.id]; aggiornaSidebar(); } else if (markerPOI[dati.id]) { map.removeLayer(markerPOI[dati.id]); delete markerPOI[dati.id]; } });
    socket.on('ricevi_ping', (dati) => eseguiSuonoPing(dati.lat, dati.lng, dati.ruolo));
}

function creaMarker(dati) {
    if (markerSquadre[dati.id] || markerPOI[dati.id]) return;
    if (!dati.hasOwnProperty('cerchioAttivo')) dati.cerchioAttivo = false;
    const html = `<div class="contenitore-icona"><img src="icone/${dati.icona}.png" class="immagine-custom" onerror="this.src='icone/fps.png'">${dati.tipo === 'squadra' ? `<div class="etichetta-nome">${dati.nome}</div>` : ''}</div>`;
    const icon = L.divIcon({ html: html, className: 'wrapper-icona', iconSize: [40, 40], iconAnchor: [20, 20] });
    const m = L.marker([dati.lat, dati.lng], { icon: icon, draggable: possiedoComando }).addTo(map);
    if (dati.tipo === 'squadra') {
        markerSquadre[dati.id] = m; datiSquadre[dati.id] = dati; aggiornaSidebar();
        const popupContent = `
            <div class="squadra-popup">
                <h3>${dati.nome}</h3>
                <label>Capo:</label><input id="c_${dati.id}" oninput="salvaRoster('${dati.id}')">
                <label>Vice:</label><input id="v_${dati.id}" oninput="salvaRoster('${dati.id}')">
                <label>Membri:</label><textarea id="m_${dati.id}" oninput="salvaRoster('${dati.id}')"></textarea>
            </div>`;
        m.bindPopup(popupContent);

        m.on('popupopen', () => {
            document.getElementById(`c_${dati.id}`).value = datiSquadre[dati.id].roster.capo || '';
            document.getElementById(`v_${dati.id}`).value = datiSquadre[dati.id].roster.vice || '';
            document.getElementById(`m_${dati.id}`).value = datiSquadre[dati.id].roster.membri || '';
        });
    } else { markerPOI[dati.id] = m; }

    m.on('mousedown', (e) => {
        disattivaMatitaSeAttiva();
        if (e.originalEvent.button === 1) {
            e.originalEvent.preventDefault(); m.closePopup(); toggleSelezione(dati.id, dati.tipo);
        } else if (e.originalEvent.button === 0 && !elementiSelezionati.some(el => el.id === dati.id)) {
            selezionaElementoUnico(dati.id, dati.tipo);
        }
    });
    m.on('contextmenu', (e) => {
        if (!possiedoComando) return; e.originalEvent.preventDefault();
        const nuovoStato = !dati.cerchioAttivo; dati.cerchioAttivo = nuovoStato;
        aggiornaCerchioMarker(dati.id, dati.tipo, nuovoStato);
        socket.emit('toggle_cerchio_tattico', { id: dati.id, tipo: dati.tipo, stato: nuovoStato });
    });
    m.on('dragstart', () => { disattivaMatitaSeAttiva(); dragOffsets = {}; if (elementiSelezionati.some(el => el.id === dati.id)) { elementiSelezionati.forEach(el => { const trgt = el.tipo === 'squadra' ? markerSquadre[el.id] : markerPOI[el.id]; dragOffsets[el.id] = { dLat: trgt.getLatLng().lat - m.getLatLng().lat, dLng: trgt.getLatLng().lng - m.getLatLng().lng }; }); } });
    m.on('drag', () => { if (elementiSelezionati.some(el => el.id === dati.id)) { elementiSelezionati.forEach(el => { if (el.id !== dati.id) { const trgt = el.tipo === 'squadra' ? markerSquadre[el.id] : markerPOI[el.id]; trgt.setLatLng([m.getLatLng().lat + dragOffsets[el.id].dLat, m.getLatLng().lng + dragOffsets[el.id].dLng]); } }); } });
    m.on('dragend', () => { if (elementiSelezionati.some(el => el.id === dati.id)) { elementiSelezionati.forEach(el => { const trgt = el.tipo === 'squadra' ? markerSquadre[el.id] : markerPOI[el.id]; socket.emit('aggiorna_posizione', { id: el.id, tipo: el.tipo, lat: trgt.getLatLng().lat, lng: trgt.getLatLng().lng }); }); } else { socket.emit('aggiorna_posizione', { id: dati.id, tipo: dati.tipo, lat: m.getLatLng().lat, lng: m.getLatLng().lng }); } });
}

window.aggiornaCerchioMarker = (id, tipo, stato) => {
    const m = tipo === 'squadra' ? markerSquadre[id] : markerPOI[id];
    if (!m) return;
    const container = m.getElement().querySelector('.contenitore-icona');
    let cerchio = container.querySelector('.cerchio-tattico');
    if (stato) {
        if (!cerchio) {
            cerchio = document.createElement('div'); cerchio.className = 'cerchio-tattico';
            container.appendChild(cerchio);
        }
    }
    else { if (cerchio) cerchio.remove(); }
};
window.creaElemento = (icona, tipo) => {
    disattivaMatitaSeAttiva();
    if (!possiedoComando) return;
    const center = map.getCenter();
    const id = tipo + '_' + Date.now();
    const dati = {
        id: id, tipo: tipo, lat: center.lat, lng: center.lng, icona: icona, cerchioAttivo: false, nome: tipo === 'squadra' ?
            prompt("Nome Squadra:") : '', roster: { capo: '', vice: '', membri: '' }
    };
    if (tipo === 'squadra' && !dati.nome) return;
    creaMarker(dati); socket.emit('nuovo_elemento', dati);
};
window.salvaRoster = (id) => {
    if (!possiedoComando) return;
    datiSquadre[id].roster.capo = document.getElementById(`c_${id}`).value;
    datiSquadre[id].roster.vice = document.getElementById(`v_${id}`).value;
    datiSquadre[id].roster.membri = document.getElementById(`m_${id}`).value;
    socket.emit('aggiorna_roster', { id: id, roster: datiSquadre[id].roster });
    aggiornaSidebar();
};

function aggiornaSidebar() {
    const cont = document.getElementById('lista-squadre');
    let html = '';
    for (let id in datiSquadre) {
        const sq = datiSquadre[id];
        html += `<div class="scheda-squadra" onclick="selezionaElementoUnico('${id}', 'squadra', true)">
                <h4>${sq.nome}</h4>
                <div class="roster-info"><span><b>C:</b> ${sq.roster.capo ||
            '-'}</span> | <span><b>V:</b> ${sq.roster.vice || '-'}</span></div>
                <div class="roster-membri">${sq.roster.membri ?
                sq.roster.membri.replace(/\n/g, ', ') : ''}</div>
            </div>`;
    }
    cont.innerHTML = html || '<i>Nessuna forza schierata.</i>';
}

function toggleSelezione(id, tipo) {
    const m = tipo === 'squadra' ? markerSquadre[id] : markerPOI[id];
    const index = elementiSelezionati.findIndex(el => el.id === id);
    if (index !== -1) {
        elementiSelezionati.splice(index, 1); m.getElement().querySelector('.contenitore-icona').classList.remove('squadra-selezionata');
    }
    else { elementiSelezionati.push({ id, tipo }); m.getElement().querySelector('.contenitore-icona').classList.add('squadra-selezionata'); }
}
window.selezionaElementoUnico = (id, tipo, pan) => {
    deselezionaTutti();
    const m = tipo === 'squadra' ? markerSquadre[id] : markerPOI[id]; if (!m) return; elementiSelezionati = [{ id: id, tipo: tipo }]; m.getElement().querySelector('.contenitore-icona').classList.add('squadra-selezionata');
    if (pan) map.panTo(m.getLatLng());
};
window.deselezionaTutti = () => { elementiSelezionati = []; document.querySelectorAll('.contenitore-icona').forEach(el => el.classList.remove('squadra-selezionata')); };
window.eliminaSelezionati = () => {
    if (!possiedoComando || elementiSelezionati.length === 0) return; if (confirm(`Eliminare ${elementiSelezionati.length} elementi?`)) {
        elementiSelezionati.forEach(el => socket.emit('elimina_elemento', el)); deselezionaTutti();
    }
};

// Nuke Mappa
window.nukeMappa = () => {
    if (!possiedoComando) return;
    if (confirm("⚠️ ATTENZIONE ⚠️\nSei sicuro di voler eliminare TUTTE le forze, i bersagli e i disegni dalla mappa?")) {
        socket.emit('nuke_mappa');
        deselezionaTutti();
    }
}

// PING CON SUONO PROLUNGATO (5s) E ANIMAZIONE (10s)
function eseguiSuonoPing(lat, lng, ruoloMittente) {
    let colore = '#44ff44';
    if (ruoloMittente === 'admin') colore = '#ff4444';
    else if (ruoloMittente === 'responsabile') colore = '#4444ff';

    // Se esiste già un ping per questo ruolo, cancellalo visivamente
    if (pingsAttivi[ruoloMittente]) {
        map.removeLayer(pingsAttivi[ruoloMittente].marker);
        clearTimeout(pingsAttivi[ruoloMittente].timer);
    }

    const icon = L.divIcon({ html: `<div class="ping-animato" style="border-color: ${colore}; box-shadow: 0 0 15px ${colore}, inset 0 0 15px ${colore};"></div>`, className: '', iconSize: [80, 80], iconAnchor: [40, 40] });
    const p = L.marker([lat, lng], { icon: icon, interactive: false }).addTo(map);

    // Rimuove dopo 10s e ripulisce l'oggetto
    const timer = setTimeout(() => {
        map.removeLayer(p);
        delete pingsAttivi[ruoloMittente];
    }, 10000);

    pingsAttivi[ruoloMittente] = { marker: p, timer: timer };

    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        for (let i = 0; i < 3; i++) { // Cambiato da 5 a 3 secondi per evitare accavallamenti infiniti
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.setValueAtTime(700, ctx.currentTime + i);
            gain.gain.setValueAtTime(0, ctx.currentTime + i);
            gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + i + 0.1);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + i + 0.8);
            osc.start(ctx.currentTime + i); osc.stop(ctx.currentTime + i + 1);
        }
    } catch (e) { }
}

window.resetZoom = () => map.fitBounds(bounds);
window.richiediComando = () => {
    socket.emit('richiedi_comando');
    document.getElementById('btn-richiedi').innerText = "⏳ In attesa...";
};
window.rilasciaComando = () => socket.emit('rilascia_comando');
window.approvaRichiesta = () => {
    const v = document.getElementById('tendinaRichieste').value;
    if (v) socket.emit('approva_richiesta', v);
};
window.revocaSingolo = () => { const v = document.getElementById('tendinaAutorizzati').value; if (v) socket.emit('revoca_comando', v); };
// UI Toggles
window.togglePannello = () => {
    const p = document.getElementById('pannello');
    const b = document.getElementById('btn-toggle-pannello');
    p.classList.toggle('nascosto');
    b.innerText = p.classList.contains('nascosto') ? "👁️ Mostra Pannello" : "👁️ Nascondi Pannello";
}

window.toggleRoster = () => {
    const s = document.getElementById('sidebar');
    const b = document.getElementById('btn-toggle-roster');
    s.classList.toggle('nascosto');
    b.innerText = s.classList.contains('nascosto') ? "👁️ Mostra Roster" : "👁️ Nascondi Roster";
}

window.toggleTerminal = (e) => {
    const t = document.getElementById('terminal-wrapper');
    t.classList.toggle('minimizzato');
    document.getElementById('terminal-status').innerText = t.classList.contains('minimizzato') ?
        "(Clicca per espandere)" : "(Clicca per nascondere)";
}

function aggiornaPannelloPermessi() {
    document.getElementById('overlay-operatore').style.display = (!isUfficiale && !possiedoComando) ?
        'flex' : 'none';
    document.getElementById('pannello-admin').style.display = isUfficiale ? 'block' : 'none';
    aggiornaInterazioneMappa();
}
function aggiornaInterazioneMappa() {
    for (let id in markerSquadre) {
        if (possiedoComando) markerSquadre[id].dragging.enable(); else markerSquadre[id].dragging.disable();
    }
    for (let id in markerPOI) {
        if (possiedoComando) markerPOI[id].dragging.enable(); else markerPOI[id].dragging.disable();
    }
}

function MostraNotifica(testo) {
    const b = document.getElementById('banner-notifiche');
    b.innerText = testo; b.style.top = "0";
    setTimeout(() => b.style.top = "-50px", 4000);
}

function disattivaMatitaSeAttiva() {
    if (matitaAttiva) window.toggleMatita();
}

// Mappe
async function caricaListaMappe() {
    try {
        const res = await fetch('/api/lista-mappe');
        archivioMappe = await res.json(); renderizzaTendinaMappe();
    } catch (e) { }
}
window.renderizzaTendinaMappe = (filtro = "") => {
    const t = document.getElementById('tendinaMappe');
    t.innerHTML = '<option value="">-- Scegli mappa --</option>'; archivioMappe.forEach(m => { if (m.toLowerCase().includes(filtro.toLowerCase())) t.innerHTML += `<option value="mappe/${m}">${m}</option>`; });
};
window.selezionaDaTendina = () => { if (!possiedoComando) return; const url = document.getElementById('tendinaMappe').value; if (url) socket.emit('richiedi_cambio_mappa', url); };
window.inviaNuovoSfondo = async () => {
    const f = document.getElementById('fileSfondo').files[0]; if (!f || !possiedoComando) return; const fd = new FormData();
    fd.append('nuovaMappa', f); await fetch('/upload-mappa', { method: 'POST', body: fd }); caricaListaMappe();
};
window.eliminaMappaCorrente = async () => {
    if (!possiedoComando) return;
    const url = document.getElementById('tendinaMappe').value; if (!url || url === "mappe/mappa.jpg") return;
    if (confirm("Eliminare fisicamente la mappa dal server?")) { await fetch(`/api/elimina-mappa?nome=${url.replace('mappe/', '')}`, { method: 'DELETE' }); caricaListaMappe(); }
};
window.saveMission = () => {
    // Aggiorna le coordinate delle squadre leggendole dai marker prima di salvare
    for (let id in markerSquadre) {
        if (datiSquadre[id]) {
            datiSquadre[id].lat = markerSquadre[id].getLatLng().lat;
            datiSquadre[id].lng = markerSquadre[id].getLatLng().lng;
        }
    }

    const data = { sfondo: livelloSfondo._url.split('?')[0], squadre: datiSquadre, poi: {}, disegni: drawItems.toGeoJSON(), grigliaAttiva: grigliaAttiva };
    
    for (let id in markerPOI) {
        data.poi[id] = { 
            id: id, 
            lat: markerPOI[id].getLatLng().lat, 
            lng: markerPOI[id].getLatLng().lng, 
            icona: markerPOI[id].options.icon.options.html.match(/icone\/(.*)\.png/)[1], 
            tipo: 'poi', 
            cerchioAttivo: markerPOI[id].cerchioAttivo || false 
        };
    }
    
    const b = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `Missione_${Date.now()}.json`;
    a.click();
};

window.loadMission = (e) => { 
    const reader = new FileReader(); 
    reader.onload = (ev) => socket.emit('carica_snapshot', JSON.parse(ev.target.result)); 
    reader.readAsText(e.target.files[0]); 
};

startC2();