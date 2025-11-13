// assets/js/presence.js
// Manejo de presencia online/offline usando Realtime Database (conexiones por pestaña)
// y actualización de Firestore users/{uid}.online + lastSeen (con serverTimestamp).
// Este módulo NO se auto-inicia en onAuthStateChanged; exporta startPresenceForUser y stopPresence
// para que auth.js controle cuándo arrancar/detener presencia.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getDatabase,
    ref as rtdbRef,
    push,
    set,
    remove,
    onDisconnect,
    onValue
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js";
import {
    getFirestore,
    doc as fsDoc,
    setDoc,
    serverTimestamp,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

// Inicializar Firebase si no está inicializado (compatible con el init en auth.js)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const rtdb = getDatabase(app);
const firestore = getFirestore(app);

// RTDB base path
const RTDB_STATUS_BASE = 'status';

// Rate-limit para evitar escrituras repetidas en Firestore desde cliente
const FIRESTORE_MIN_WRITE_MS = 5000;

let currentConnectionRef = null;
let currentConnectionsUnsub = null;
let userFirestoreUnsub = null;
let lastFirestoreWrite = 0;

// Crea/inserta indicador dentro de .top-search sin modificar HTML existente
function ensurePresenceIndicator() {
    const topSearch = document.querySelector('.top-search');
    if (!topSearch) return null;

    let indicator = topSearch.querySelector('.presence-indicator');
    if (indicator) return indicator;

    indicator = document.createElement('span');
    indicator.className = 'presence-indicator offline';
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    indicator.title = 'Estado: Desconectado';
    // Texto accesible mínimo
    indicator.textContent = '●';
    topSearch.appendChild(indicator);
    return indicator;
}

function updateIndicatorVisual(isOnline) {
    const indicator = ensurePresenceIndicator();
    if (!indicator) return;
    indicator.classList.toggle('online', !!isOnline);
    indicator.classList.toggle('offline', !isOnline);
    indicator.title = isOnline ? 'Conectado' : 'Desconectado';
}

// Escribe a Firestore con merge para evitar errores si el doc no existe
async function writeFirestoreState(uid, isOnline) {
    try {
        const ref = fsDoc(firestore, 'users', uid);
        await setDoc(ref, {
            online: !!isOnline,
            lastSeen: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.warn('writeFirestoreState error:', err);
    }
}

function shouldWriteFirestore() {
    const now = Date.now();
    if (now - lastFirestoreWrite < FIRESTORE_MIN_WRITE_MS) return false;
    lastFirestoreWrite = now;
    return true;
}

// Inicia presencia para la pestaña del usuario uid
export async function startPresenceForUser(uid) {
    // limpiar si hay algo previo
    await stopPresence();

    try {
        const connectionsPath = `${RTDB_STATUS_BASE}/${uid}/connections`;
        const connectionsRef = rtdbRef(rtdb, connectionsPath);

        // push crea una referencia única por pestaña
        const connRef = push(connectionsRef);
        currentConnectionRef = connRef;

        // Escribir valor true en la referencia de conexión
        await set(connRef, true);

        // Asegurar que onDisconnect remueva este nodo si la pestaña muere inesperadamente
        await onDisconnect(connRef).remove();

        // Escuchar cambios en las conexiones para actualizar indicador local y (con rate-limit) Firestore
        currentConnectionsUnsub = onValue(connectionsRef, (snap) => {
            const val = snap.val();
            const hasConnections = snap.exists() && Object.keys(val || {}).length > 0;
            updateIndicatorVisual(hasConnections);
            if (shouldWriteFirestore()) {
                // preferimos que una Cloud Function sincronice RTDB -> Firestore (recomendado),
                // pero si no tienes funciones, cliente puede escribir como fallback.
                writeFirestoreState(uid, hasConnections);
            }
        }, (err) => {
            console.error('RTDB onValue error (connections):', err);
        });

        // Además, suscribirse al documento Firestore para preferir la verdad desde Firestore (si existe)
        const userDocRef = fsDoc(firestore, 'users', uid);
        userFirestoreUnsub = onSnapshot(userDocRef, (docSnap) => {
            if (!docSnap.exists()) return;
            const data = docSnap.data();
            if (typeof data.online === 'boolean') {
                updateIndicatorVisual(!!data.online);
            }
        }, (err) => {
            console.error('Firestore onSnapshot error (user):', err);
        });

    } catch (err) {
        console.error('startPresenceForUser error:', err);
    }
}

// Detener presencia (al hacer logout o cuando onAuthState cambia a null)
export async function stopPresence() {
    try {
        if (currentConnectionRef) {
            try { await remove(currentConnectionRef); } catch (e) { /* ignore */ }
            currentConnectionRef = null;
        }
    } catch (err) {
        console.warn('Error removing currentConnectionRef:', err);
    }

    if (typeof currentConnectionsUnsub === 'function') {
        try { currentConnectionsUnsub(); } catch (e) { /* ignore */ }
        currentConnectionsUnsub = null;
    }

    if (typeof userFirestoreUnsub === 'function') {
        try { userFirestoreUnsub(); } catch (e) { /* ignore */ }
        userFirestoreUnsub = null;
    }

    updateIndicatorVisual(false);
}