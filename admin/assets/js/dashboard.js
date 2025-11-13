// assets/js/dashboard.js
// Responsive dashboard utilities: mobile overlay, collapse, hash navigation, logout binding.
// Requires auth.js exports logout().

import { logout } from './auth.js';

export function initDashboard() {
    setupSidebar();
    setupHashNavigation();
    bindLogoutButtons();
    // ensure correct initial layout
    handleResize();
    window.addEventListener('resize', handleResize);
}

function setupSidebar() {
    const sidebar = document.getElementById('sidebar');
    const collapseBtn = document.getElementById('collapseBtn');
    const menuToggle = document.getElementById('menuToggle');

    // create overlay used on mobile
    let overlay = document.getElementById('appOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'appOverlay';
        overlay.className = 'overlay';
        document.body.appendChild(overlay);
    }

    // collapse to icon-only (desktop/tablet)
    if (collapseBtn && sidebar) {
        collapseBtn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
        });
    }

    // menuToggle opens sidebar on mobile
    if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', () => {
            const open = sidebar.classList.toggle('open');
            if (open) overlay.classList.add('show'); else overlay.classList.remove('show');
        });
    }

    // clicking overlay hides sidebar (mobile)
    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('show');
    });

    // close sidebar when navigation clicked (mobile)
    document.addEventListener('click', (ev) => {
        if (!ev.target.closest('.nav-item')) return;
        if (window.innerWidth <= 820 && sidebar) {
            sidebar.classList.remove('open');
            overlay.classList.remove('show');
        }
    });
}

function setupHashNavigation() {
    const links = Array.from(document.querySelectorAll('.sidebar-nav .nav-item'));
    const pages = Array.from(document.querySelectorAll('.page-content'));

    if (!links.length || !pages.length) return;

    function show(hash) {
        const id = hash ? hash.replace('#', '') : links[0].getAttribute('href').replace('#', '');
        pages.forEach(p => p.classList.add('hidden'));
        const active = document.getElementById(id);
        if (active) active.classList.remove('hidden');
        links.forEach(l => l.classList.toggle('active', l.getAttribute('href') === `#${id}`));
    }

    links.forEach(l => {
        l.addEventListener('click', (e) => {
            e.preventDefault();
            const href = l.getAttribute('href');
            history.pushState(null, '', href);
            show(href);
        });
    });

    // initial show
    show(location.hash || links[0].getAttribute('href'));

    window.addEventListener('popstate', () => show(location.hash));
}

function bindLogoutButtons() {
    const els = Array.from(document.querySelectorAll('.logout-btn'));
    els.forEach(el => {
        el.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!confirm('¿Cerrar sesión?')) return;
            try {
                await logout();
            } catch (err) {
                console.error('logout error', err);
                alert('No se pudo cerrar la sesión.');
            }
        });
    });
}

// Keep layout consistent on resize
function handleResize() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('appOverlay');
    if (!sidebar) return;
    if (window.innerWidth > 820) {
        sidebar.classList.remove('open');
        overlay?.classList.remove('show');
    }
}