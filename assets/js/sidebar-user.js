// sidebar-user.js
// Muestra en el sidebar el nombre y rol del usuario conectado (lee desde Firestore)
// y enlaza el botón de cerrar sesión con la función logout() exportada desde auth.js

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { logout } from './auth.js'; // usamos la exportación logout() que ya tienes

// Inicializa Firebase si no está inicializado aún (misma lógica que en auth.js)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Selectores del DOM (se basan en la estructura actual en usuarios.html)
const nameEl = document.querySelector('.sidebar-user .name');
const metaEl = document.querySelector('.sidebar-user .email'); // aquí mostraremos el rol
const avatarEl = document.querySelector('.sidebar-user .avatar');
const logoutBtn = document.querySelector('.sidebar-user .logout-btn');

// Helper: obtener iniciales (2 letras)
function getInitials(name) {
    if (!name) return '';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Mostrar valores por defecto si faltan elementos
function setSidebar(name, role) {
    if (nameEl) nameEl.textContent = name || 'Invitado';
    if (metaEl) metaEl.textContent = role || '';
    if (avatarEl) {
        const initials = getInitials(name || role || 'U');
        avatarEl.textContent = initials;
    }
}

// Escucha cambios en autenticación
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        // No hay usuario: mostrar valores por defecto
        setSidebar('Invitado', '');
        return;
    }

    try {
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
            const data = userSnap.data();
            // Preferir nombre del documento; fallback a displayName o email
            const displayName = data.name || user.displayName || user.email || 'Usuario';
            const role = data.role || '';
            setSidebar(displayName, role);
        } else {
            // Si por alguna razón no existe el documento, usar datos del auth
            const displayName = user.displayName || user.email || 'Usuario';
            setSidebar(displayName, '');
        }
    } catch (err) {
        console.error('Error obteniendo user doc en sidebar:', err);
        // fallback
        const displayName = user.displayName || user.email || 'Usuario';
        setSidebar(displayName, '');
    }
});

// Vincular botón de cerrar sesión (si existe)
if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            await logout(); // función exportada desde auth.js
        } catch (err) {
            console.error('Error al cerrar sesión desde sidebar:', err);
        }
    });
}