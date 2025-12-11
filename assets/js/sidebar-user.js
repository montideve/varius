import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc as fsDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { logout } from './auth.js';
import { applyUiRestrictions } from './rbac.js';

// Asegura que el módulo de presence se  cargue (start presence listeners)
import './presence.js';

// init firebase app (re-use if already  initialized)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
 
// Helpers para esperar al sidebar inyectado
function whenReady(selector, timeout = 3000) {
    return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        const obs = new MutationObserver(() => {
            const found = document.querySelector(selector);
            if (found) {
                obs.disconnect();
                resolve(found);
            }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        // fallback timeout
        setTimeout(() => {
            obs.disconnect();
            resolve(document.querySelector(selector));
        }, timeout);
    });
} 

function getInitials(name) {
    if (!name) return '';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

async function init() {
    // Esperar que el sidebar exista (insertado por loader)
    await whenReady('.sidebar');

    // Selectores robustos: toleramos id o solo clase
    const nameEl = document.querySelector('.sidebar-user .name') || document.getElementById('sidebar-name');
    const metaEl = document.querySelector('.sidebar-user .email') || document.getElementById('sidebar-email');
    const avatarEl = document.querySelector('.sidebar-user .avatar') || document.getElementById('sidebar-avatar');
    const logoutBtn = document.querySelector('.sidebar-user .logout-btn, .sidebar-user #logout, #logout, .logout-btn');
    const topSearch = document.querySelector('.top-search');

    function getNavItemByHrefFragment(fragment) {
        const anchor = document.querySelector(`.nav-list a[href$="${fragment}"], .nav-list a[href*="/${fragment}"], .nav-list a[href*="${fragment}"]`);
        if (!anchor) return null;
        return anchor.closest('.nav-item') || null;
    }

    function setNavVisibilityByFragment(fragment, visible) {
        const item = getNavItemByHrefFragment(fragment);
        if (!item) return;
        item.style.display = visible ? '' : 'none';
    }

    function setRestrictedNavVisibility(role) {
        const isAdmin = role === 'administrador';
        setNavVisibilityByFragment('usuarios.html', isAdmin);
        setNavVisibilityByFragment('cxc.html', isAdmin);
    }

    function setSidebar(name, role) {
        if (nameEl) nameEl.textContent = name || 'Invitado';
        if (metaEl) metaEl.textContent = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
        if (avatarEl) avatarEl.textContent = getInitials(name || role || 'U');
    }

    /* PRESENCE UI: ensure presence indicator exists inside .top-search and wire events */
    function ensurePresenceIndicator() {
        if (!topSearch) return null;

        let indicator = topSearch.querySelector('.presence-indicator');
        if (!indicator) {
            indicator = document.createElement('span');
            indicator.className = 'presence-indicator offline';
            indicator.setAttribute('aria-hidden', 'true');
            indicator.setAttribute('title', 'Estado de conexión: offline');
            topSearch.appendChild(indicator);

            const label = document.createElement('span');
            label.className = 'presence-label';
            label.textContent = 'offline';
            topSearch.appendChild(label);
        }
        return topSearch.querySelector('.presence-indicator');
    }

    function updatePresenceIndicator(state) {
        const indicator = ensurePresenceIndicator();
        if (!indicator) return;
        const label = topSearch.querySelector('.presence-label');

        indicator.classList.remove('online', 'offline', 'error');
        if (state === 'online') {
            indicator.classList.add('online');
            indicator.setAttribute('title', 'Conectado (online)');
            if (label) label.textContent = 'Conectado';
        } else if (state === 'offline') {
            indicator.classList.add('offline');
            indicator.setAttribute('title', 'Desconectado (offline)');
            if (label) label.textContent = 'Desconectado';
        } else {
            indicator.classList.add('error');
            indicator.setAttribute('title', 'Estado desconocido');
            if (label) label.textContent = 'Desconocido';
        }
    }

    window.addEventListener('presence:me', (e) => {
        const { state } = e.detail || {};
        updatePresenceIndicator(state);
    });

    window.addEventListener('presence:change', (e) => {
        // e.detail => { uid, state } -- opcional: notificaciones
    });

    window.addEventListener('presence:list', (e) => {
        // e.detail.users => array -- opcional: renderizar popup de usuarios activos
    });

    /* Auth state handling (mantiene funcionalidad anterior) */
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            setSidebar('Invitado', '');
            applyUiRestrictions('');
            setRestrictedNavVisibility('');
            updatePresenceIndicator('offline');
            return;
        }

        try {
            const userRef = fsDoc(db, 'users', user.uid);
            const userSnap = await getDoc(userRef);
            let displayName = user.displayName || user.email || 'Usuario';
            let role = '';
            if (userSnap.exists()) {
                const data = userSnap.data();
                displayName = data.name || displayName;
                role = data.role || '';
            }
            setSidebar(displayName, role);
            applyUiRestrictions(role);
            setRestrictedNavVisibility(role);
            ensurePresenceIndicator();
        } catch (err) {
            console.error('Error obtaining user doc for sidebar:', err);
            const displayName = user.displayName || user.email || 'Usuario';
            setSidebar(displayName, '');
            applyUiRestrictions('');
            setRestrictedNavVisibility('');
            ensurePresenceIndicator();
        }
    });

    /* Bind logout UI in sidebar */
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                if (window.__presence && typeof window.__presence.setUserOfflineImmediately === 'function') {
                    const currentUser = auth.currentUser;
                    if (currentUser && currentUser.uid) {
                        await window.__presence.setUserOfflineImmediately(currentUser.uid);
                    }
                }
                await logout();
            } catch (err) {
                console.error('Error logging out from sidebar:', err);
            }
        });
    } else {
        console.debug('sidebar-user: logout button not found yet');
    }
}

// Arrancar cuando el módulo sea importado
init();