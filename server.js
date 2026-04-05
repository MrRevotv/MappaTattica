require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

const sessionMiddleware = session({ secret: process.env.SESSION_SECRET || 'tattico-segreto-123', resave: false, saveUninitialized: false });
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
io.engine.use(sessionMiddleware);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify', 'guilds', 'guilds.members.read']
}, async (accessToken, refreshToken, profile, done) => {
    try {
        const response = await axios.get(`https://discord.com/api/users/@me/guilds/${process.env.GUILD_ID}/member`, { headers: { Authorization: `Bearer ${accessToken}` } });
        const roles = response.data.roles;
        let assignedRole = 'operatore';
        if (profile.id === process.env.CREATOR_USER_ID || roles.includes(process.env.ADMIN_ROLE_ID)) assignedRole = 'admin';
        else if (roles.includes(process.env.RESPONSABILE_ROLE_ID)) assignedRole = 'responsabile';
        else if (roles.includes(process.env.PLSE_ROLE_ID)) assignedRole = 'p-lse';
        return done(null, { id: profile.id, nome: response.data.nick || profile.username, ruolo: assignedRole });
    } catch (e) { 
           console.error("ERRORE LOGIN DISCORD:", e.response ? e.response.data : e.message);
            return done(null, false); 
       }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/api/me', (req, res) => req.isAuthenticated() ? res.json(req.user) : res.status(401).send());
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

const storage = multer.diskStorage({
    destination: (req, file, cb) => { const dir = 'public/mappe/'; if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); cb(null, dir); },
    filename: (req, file, cb) => cb(null, file.originalname.replace(/\s+/g, '-'))
});
const upload = multer({ storage: storage });

app.get('/api/lista-mappe', (req, res) => { fs.readdir(path.join(__dirname, 'public/mappe'), (err, files) => res.json(err ? [] : files.filter(f => f.match(/\.(jpg|jpeg|png|webp)$/i)))); });

app.post('/upload-mappa', upload.single('nuovaMappa'), (req, res) => {
    if (!req.isAuthenticated() || !['admin', 'responsabile'].includes(req.user.ruolo)) return res.sendStatus(403);
    statoMappa.sfondo = 'mappe/' + req.file.filename; io.emit('cambio_mappa', statoMappa.sfondo);
    logEvento(`[SISTEMA] L'Ufficiale ${req.user.nome} ha caricato la mappa ${req.file.filename}`);
    res.sendStatus(200);
});

app.delete('/api/elimina-mappa', (req, res) => {
    if (!req.isAuthenticated() || !['admin', 'responsabile'].includes(req.user.ruolo)) return res.sendStatus(403);
    const nome = req.query.nome;
    if (nome && nome !== 'mappa.jpg') {
        fs.unlink(path.join(__dirname, 'public/mappe/', nome), (err) => {
            if (err) return res.sendStatus(500);
            logEvento(`[SISTEMA] L'Ufficiale ${req.user.nome} ha eliminato la mappa ${nome}`);
            res.sendStatus(200);
        });
    } else { res.sendStatus(400); }
});

// --- LOGICA DI STATO E PERMESSI ---
let statoMappa = { sfondo: 'mappe/avvio.png', squadre: {}, poi: {}, disegni: null, grigliaAttiva: false };
let ufficialiOnline = 0;
let operatoriAutorizzati = {};
let richiestePendenti = {};

function logEvento(msg) { io.emit('nuovo_log', `[${new Date().toLocaleTimeString()}] ${msg}`); }

io.on('connection', (socket) => {
    const user = socket.request.session?.passport?.user;

    // 1. SICUREZZA: Se per qualche motivo la sessione non esiste, fermiamo l'esecuzione
    if (!user) return; 

    // 2. DICHIARAZIONE: Definiamo isUff PRIMA di usarlo
    const isUff = ['admin', 'responsabile'].includes(user.ruolo);

    // 3. LOGICA UFFICIALI: 
    if (isUff) {
        ufficialiOnline++;
        
        // Se c'è almeno un operatore con il comando, glielo toglie
        if (Object.keys(operatoriAutorizzati).length > 0) {
            operatoriAutorizzati = {}; // Azzera i permessi
            io.emit('comando_revocato'); // Avvisa tutti di togliere il comando
            io.emit('aggiorna_autorizzati', operatoriAutorizzati); // Aggiorna le tendine
            logEvento(`[SISTEMA] Ufficiale ${user.nome} online. Comandi operatori revocati.`);
        }
    }

    logEvento(`[CONNESSIONE] ${user.nome} (${user.ruolo}) collegato.`);
    socket.emit('stato_iniziale', statoMappa);

    // FUNZIONE DI CONTROLLO INTERNA
    const haPermessi = () => {
        return isUff || operatoriAutorizzati[socket.id];
    };

    // --- GESTIONE PERMESSI ---

    socket.on('richiedi_comando_iniziale', () => {
        if (isUff) {
            socket.emit('comando_concesso');
        } else if (ufficialiOnline === 0) {
            operatoriAutorizzati[socket.id] = user.nome;
            socket.emit('comando_concesso');
            io.emit('aggiorna_autorizzati', operatoriAutorizzati);
            logEvento(`[SISTEMA] ${user.nome} assume il comando tattico (Nessun Ufficiale Online).`);
        } else {
            socket.emit('comando_revocato'); // Forza lo stato visivo se c'è un admin
        }
    });

    socket.on('richiedi_comando', () => {
        if (isUff) return; // Gli ufficiali lo hanno già
        if (ufficialiOnline === 0) {
            operatoriAutorizzati[socket.id] = user.nome;
            socket.emit('comando_concesso');
            io.emit('aggiorna_autorizzati', operatoriAutorizzati);
            logEvento(`[SISTEMA] ${user.nome} ha preso il comando.`);
        } else {
            richiestePendenti[socket.id] = user.nome;
            io.emit('aggiorna_richieste', richiestePendenti);
            logEvento(`[RICHIESTA] L'operatore ${user.nome} chiede autorizzazione.`);
        }
    });

    socket.on('approva_richiesta', (id) => {
        if (!isUff) return;
        if (richiestePendenti[id]) {
            operatoriAutorizzati[id] = richiestePendenti[id];
            delete richiestePendenti[id];
            io.to(id).emit('comando_concesso');
            io.emit('aggiorna_autorizzati', operatoriAutorizzati);
            io.emit('aggiorna_richieste', richiestePendenti);
            logEvento(`[SISTEMA] Autorizzazione concessa a ${operatoriAutorizzati[id]} da ${user.nome}.`);
        }
    });

    socket.on('revoca_comando', (id) => {
        if (!isUff) return;
        const nome = operatoriAutorizzati[id];
        delete operatoriAutorizzati[id];
        io.to(id).emit('comando_revocato');
        io.emit('aggiorna_autorizzati', operatoriAutorizzati);
        logEvento(`[SISTEMA] Autorizzazione revocata a ${nome}.`);
    });

    socket.on('rilascia_comando', () => {
        delete operatoriAutorizzati[socket.id];
        socket.emit('comando_revocato');
        io.emit('aggiorna_autorizzati', operatoriAutorizzati);
        logEvento(`[SISTEMA] ${user.nome} ha rilasciato il comando.`);
    });

    // --- AZIONI MAPPA (TUTTE PROTETTE DA haPermessi()) ---

    socket.on('toggle_griglia_globale', (stato) => {
        if (!haPermessi()) return;
        statoMappa.grigliaAttiva = stato;
        io.emit('cambio_griglia_globale', stato);
    });

    socket.on('salva_disegni', (disegni) => {
        if (!haPermessi()) return;
        statoMappa.disegni = disegni;
        socket.broadcast.emit('aggiorna_disegni', disegni);
    });

    socket.on('pulisci_lavagna', () => {
        if (!haPermessi()) return;
        statoMappa.disegni = null;
        io.emit('aggiorna_disegni', null);
        logEvento(`[MAPPA] Disegni cancellati da ${user.nome}.`);
    });

    socket.on('nuke_mappa', () => {
        // Consenti se è un Ufficiale, OPPURE se è un Operatore autorizzato MA non ci sono Ufficiali online
        const canNuke = isUff || (operatoriAutorizzati[socket.id] && ufficialiOnline === 0);
        if (!canNuke) return; 

        statoMappa.squadre = {}; statoMappa.poi = {}; statoMappa.disegni = null;
        io.emit('stato_iniziale', statoMappa);
        logEvento(`[SISTEMA] Mappa resettata completamente da ${user.nome}.`);
    });

    socket.on('nuovo_elemento', (dati) => {
        if (!haPermessi()) return;
        if (dati.tipo === 'squadra') statoMappa.squadre[dati.id] = dati; else statoMappa.poi[dati.id] = dati;
        socket.broadcast.emit('elemento_creato', dati);
        logEvento(`[SCHIERAMENTO] ${user.nome} ha schierato: ${dati.nome || dati.tipo}`);
    });

    socket.on('aggiorna_posizione', (dati) => {
        if (!haPermessi()) return;
        const target = dati.tipo === 'squadra' ? statoMappa.squadre[dati.id] : statoMappa.poi[dati.id];
        if (target) { target.lat = dati.lat; target.lng = dati.lng; }
        socket.broadcast.emit('posizione_aggiornata', dati);
    });

    socket.on('toggle_cerchio_tattico', (dati) => {
        if (!haPermessi()) return;
        const target = dati.tipo === 'squadra' ? statoMappa.squadre[dati.id] : statoMappa.poi[dati.id];
        if (target) target.cerchioAttivo = dati.stato;
        socket.broadcast.emit('aggiorna_cerchio', dati);
    });

    socket.on('aggiorna_roster', (dati) => {
        if (!haPermessi()) return;
        if (statoMappa.squadre[dati.id]) {
            statoMappa.squadre[dati.id].roster = dati.roster;
            socket.broadcast.emit('roster_aggiornato', dati);
        }
    });

    socket.on('elimina_elemento', (dati) => {
        if (!haPermessi()) return;
        if (dati.tipo === 'squadra') delete statoMappa.squadre[dati.id]; else delete statoMappa.poi[dati.id];
        io.emit('elemento_eliminato', dati);
        logEvento(`[RIMOZIONE] Elemento rimosso da ${user.nome}.`);
    });

    socket.on('invia_ping', (dati) => {
        // Il ping è l'unica cosa che permettiamo a tutti? 
        // Se vuoi che solo chi ha il comando pinghi, aggiungi if(!haPermessi()) return;
        io.emit('ricevi_ping', { ...dati, utente: user.nome, ruolo: user.ruolo });
    });

    socket.on('richiedi_cambio_mappa', (url) => {
        if (!haPermessi()) return;
        statoMappa.sfondo = url;
        io.emit('cambio_mappa', url);
        logEvento(`[MAPPA] ${user.nome} ha cambiato la mappa.`);
    });

    socket.on('carica_snapshot', (snap) => {
        if (!isUff) return;
        statoMappa = snap;
        io.emit('stato_iniziale', snap);
        logEvento(`[SISTEMA] Missione caricata da ${user.nome}.`);
    });

    socket.on('disconnect', () => {
        logEvento(`[DISCONNESSIONE] ${user.nome} disconnesso.`);
        
        if (isUff) {
            ufficialiOnline--;
            // Se l'ultimo ufficiale esce (tramite logout o chiudendo il browser)
            if (ufficialiOnline <= 0) {
                ufficialiOnline = 0; // Sicurezza anti-bug
                io.emit('comandi_liberati'); // Avvisa gli operatori di riprendere il comando
                logEvento(`[SISTEMA] Ultimo Ufficiale disconnesso. Comandi sbloccati.`);
            }
        }
        
        delete operatoriAutorizzati[socket.id];
        delete richiestePendenti[socket.id];
        io.emit('aggiorna_autorizzati', operatoriAutorizzati);
        io.emit('aggiorna_richieste', richiestePendenti);
    });
});

server.listen(PORT, () => console.log(`C2 Server online`));