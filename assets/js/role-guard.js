// assets/js/role-guard.js
// Reusable client-side role guard. Importa y llama requireRole([...allowedRoles])
// Ejemplo: import { requireRole } from './role-guard.js'; requireRole(['administrador','vendedor']);

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Map para redirigir según rol (ajusta rutas si están en otro subpath)
const ROLE_ROUTES = {
    vendedor: 'vendedor.html',
    motorizado: 'motorizado.html',
    administrador: 'administrador.html'
};

/**
 * getUserRole
 * Devuelve la role string del documento users/{uid} o '' si no existe
 */
export async function getUserRole(uid) {
    if (!uid) return '';
    try {
        const userRef = doc(db, 'users', uid);
        const snap = await getDoc(userRef);
        if (!snap.exists()) return '';
        return snap.data().role || '';
    } catch (err) {
        console.error('role-guard.getUserRole error', err);
        return '';
    }
}

/**
 * requireRole(allowedRoles[, opts])
 * - allowedRoles: array de strings (ej ['administrador','vendedor'])
 * - opts.redirectTo: ruta a donde enviar si no autenticado (por defecto '/index.html')
 *
 * Este método redirige inmediatamente si:
 *  - no hay usuario autenticado -> redirectTo
 *  - el role del usuario no está en allowedRoles -> redirige al home de su role
 *
 * Nota: es sólo una guardia UI; ADEMÁS debes aplicar reglas de seguridad en Firestore (se muestra abajo).
 */
export function requireRole(allowedRoles = [], opts = {}) {
    const redirectTo = opts.redirectTo || '/index.html';

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            // no autenticado
            window.location.href = redirectTo;
            return;
        }

        try {
            const role = await getUserRole(user.uid);
            if (!role) {
                // si no existe role en doc, opcionalmente crearlo o redirigir a login
                // por seguridad, redirigimos al index
                console.warn('Usuario sin role; redirigiendo.');
                window.location.href = redirectTo;
                return;
            }
            // si el role no está permitido, redirigir al home correspondiente
            if (!allowedRoles.includes(role)) {
                const dest = ROLE_ROUTES[role] || redirectTo;
                window.location.href = dest;
                return;
            }
            // Allowed -> simplemente devuelve control a la página (no hace nada visible).
            return;
        } catch (err) {
            console.error('requireRole error', err);
            window.location.href = redirectTo;
        }
    });
}