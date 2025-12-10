import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Mapear rutas por rol para redirección; ajusta rutas si usas distintas
const ROLE_ROUTES = {
    vendedor: 'vendedor.html',
    motorizado: 'motorizado.html',
    administrador: '' // administrador se queda en la página actual (no redirigir)
};

let resolved = false;

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        // No autenticado => redirigir al index (file at root)
        const redirectUrl = new URL('index.html', window.location.href).toString();
        window.location.href = redirectUrl;
        return;
    }

    // Si autenticado, comprobar rol en la colección 'users'
    try {
        const userRef = doc(db, 'users', user.uid);
        const snap = await getDoc(userRef);
        const role = (snap.exists() && snap.data().role) ? snap.data().role : 'vendedor';
        if (role !== 'administrador') {
            const route = ROLE_ROUTES[role] || 'index.html';
            // redirigir a la ruta correspondiente
            window.location.href = new URL(route, window.location.href).toString();
            return;
        }
        // si es administrador, dejamos continuar
        resolved = true;
    } catch (err) {
        console.error('auth-guard: error verificando rol', err);
        // En caso de error al verificar rol, redirigir al index por seguridad
        window.location.href = new URL('index.html', window.location.href).toString();
    }
});

// Export para que otras partes puedan comprobar (opcional)
export function isGuardResolved() {
    return resolved;
}