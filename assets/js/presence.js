/**
 * assets/js/presence.js
 *
 * Módulo responsable de:
 * - Registrar presencia online/offline del usuario en Firebase Realtime Database (uso de onDisconnect)
 * - Actualizar el documento del usuario en Firestore con online/lastSeen para usos de consulta
 * - Emitir eventos DOM custom para que el resto de la UI (sidebar-user.js, etc.) actualice indicadores
 *
 * Notas importantes:
 * - Para que onDisconnect funcione correctamente debes añadir `databaseURL` a tu firebase-config.js:
 *     databaseURL: "https://<TU-PROYECTO>.firebaseio.com"
 *   Revisa el archivo firebase-config.js incluido junto a este módulo.
 *
 * - Este módulo asume que otras páginas importan `sidebar-user.js`, el cual a su vez importa este módulo;
 *   así evitamos tener que añadir manualmente el <script> en todas las páginas.
 *
 * Eventos custom emitidos:
 * - window.dispatchEvent(new CustomEvent('presence:me', { detail: { uid, state } }))
 *     -> cuando cambia el estado del usuario autenticado (online|offline)
 *
 * - window.dispatchEvent(new CustomEvent('presence:list', { detail: { users: [{uid, state, last_changed}, ...] } }))
 *     -> envía la lista completa de estados leída desde Realtime Database (útil para ver "lista de usuarios activos")
 *
 * - window.dispatchEvent(new CustomEvent('presence:change', { detail: { uid, state } }))
 *     -> cuando un usuario cambia su estado
 *
 */

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getDatabase,
    ref as dbRef,
    onValue,
    set,
    onDisconnect,
    serverTimestamp as rtdbServerTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js";
import {
    getFirestore,
    doc as fsDoc,
    updateDoc,
    serverTimestamp as fsServerTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

/* Initialize Firebase app (re-usable if already initialized) */
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const dbRtdb = getDatabase(app);
const dbFs = getFirestore(app);

/* Path in Realtime Database where presence is stored */
const PRESENCE_BASE = 'presence'; // => /presence/{uid}

/* Helper: Dispatch custom events globaly so other modules can react */
function emitEvent(name, detail) {
    try {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (err) {
        console.warn('Cannot dispatch event', name, err);
    }
}

/* Leer lista completa de presencia (y emitir) */
function watchPresenceList() {
    const listRef = dbRef(dbRtdb, PRESENCE_BASE);
    onValue(listRef, (snap) => {
        const value = snap.val() || {};
        const users = Object.keys(value).map(uid => {
            const node = value[uid] || {};
            return {
                uid,
                state: node.state || 'offline',
                last_changed: node.last_changed || null
            };
        });
        emitEvent('presence:list', { users });
    });
}

/* Establecer own presence handlers al autenticarse */
async function startPresenceForUser(user) {
    if (!user || !user.uid) return;
    const uid = user.uid;

    const connectedRef = dbRef(dbRtdb, '.info/connected');

    // Listen to client connection status
    onValue(connectedRef, async (snap) => {
        const connected = snap.val() === true;
        const statusRef = dbRef(dbRtdb, `${PRESENCE_BASE}/${uid}`);

        if (connected) {
            // Set online state and prepare onDisconnect cleanup
            try {
                // Mark presence online in Realtime DB (with server timestamp)
                await set(statusRef, { state: 'online', last_changed: rtdbServerTimestamp() });

                // When connection is lost (tab closed, network lost), server will set offline
                await onDisconnect(statusRef).set({ state: 'offline', last_changed: rtdbServerTimestamp() });

                // Also update Firestore user's doc to reflect presence & lastSeen
                try {
                    const userDocRef = fsDoc(dbFs, 'users', uid);
                    await updateDoc(userDocRef, {
                        online: true,
                        lastSeen: fsServerTimestamp()
                    });
                } catch (err) {
                    // if update fails (maybe doc missing) log but continue
                    console.debug('Could not update Firestore user doc presence:', err);
                }

                // Notify UI
                emitEvent('presence:me', { uid, state: 'online' });

            } catch (err) {
                console.error('Error setting presence online:', err);
            }
        } else {
            // Not connected: set local UI to offline (onDisconnect will handle server-side change)
            emitEvent('presence:me', { uid, state: 'offline' });
            try {
                const userDocRef = fsDoc(dbFs, 'users', uid);
                await updateDoc(userDocRef, {
                    online: false,
                    lastSeen: fsServerTimestamp()
                });
            } catch (err) {
                console.debug('Could not update Firestore user doc on disconnect (non-critical):', err);
            }
        }
    });

    // Listen specifically for changes to this user's presence node and emit presence:change
    const myRef = dbRef(dbRtdb, `${PRESENCE_BASE}/${uid}`);
    onValue(myRef, (snap) => {
        const data = snap.val();
        const state = (data && data.state) ? data.state : 'offline';
        emitEvent('presence:change', { uid, state });
    });
}

/* When user signs out (intentionally), we should set them offline immediately.
   This helps when the app calls signOut() instead of relying solely on onDisconnect.
   We will attempt to update both RTDB and Firestore.
*/
async function setUserOfflineImmediately(uid) {
    if (!uid) return;
    try {
        const statusRef = dbRef(dbRtdb, `${PRESENCE_BASE}/${uid}`);
        // set offline (use server timestamp)
        await set(statusRef, { state: 'offline', last_changed: rtdbServerTimestamp() });

        // update Firestore user doc
        try {
            const userDocRef = fsDoc(dbFs, 'users', uid);
            await updateDoc(userDocRef, { online: false, lastSeen: fsServerTimestamp() });
        } catch (err) {
            console.debug('Could not update Firestore user doc immediately on signout:', err);
        }

        emitEvent('presence:me', { uid, state: 'offline' });
    } catch (err) {
        console.warn('Failed to set offline immediately for uid', uid, err);
    }
}

/* Observador global de auth. Cuando hay user, inicializamos presencia; cuando no hay user, emitimos offline. */
onAuthStateChanged(auth, (user) => {
    if (user) {
        // start presence handlers for the authenticated user
        startPresenceForUser(user);
        // also ensure we watch the full list (for admin UIs that show online users)
        watchPresenceList();
    } else {
        // no user: emit presence:me offline (UI can react)
        emitEvent('presence:me', { uid: null, state: 'offline' });
        // also populate empty list
        emitEvent('presence:list', { users: [] });
    }
});

/* Expose a small API on window so other modules can set user offline before signOut */
window.__presence = {
    setUserOfflineImmediately
};

export {
    startPresenceForUser,
    watchPresenceList,
    setUserOfflineImmediately
};