// sidebar-loader.js
// Carga dinámica del fragmento HTML del sidebar y luego importa el módulo que lo controla.
// Usa import.meta.url para construir rutas   relativas robustas.

const SIDEBAR_URL = new URL('../components/sidebar.html', import.meta.url).href;
const SIDEBAR_MODULE = new URL('./sidebar-user.js', import.meta.url).href;
const SIDEBAR_CONTAINER_ID = 'app-sidebar';

async function loadSidebar() {
    const placeholder = document.getElementById(SIDEBAR_CONTAINER_ID);
    if (!placeholder) {
        console.warn('sidebar-loader: no se encontró placeholder #' + SIDEBAR_CONTAINER_ID);
        return;
    }

    try {
        const res = await fetch(SIDEBAR_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Error ${res.status} al cargar ${SIDEBAR_URL}`);
        const html = await res.text();
        // Insertar HTML
        placeholder.innerHTML = html;

        // Permitir reflow y luego importar el módulo que controla la lógica del sidebar
        await import(SIDEBAR_MODULE);

    } catch (err) {
        console.error('sidebar-loader: fallo cargando sidebar:', err);
    }
}

// Ejecutar inmediatamente (es módulo, por lo que import.meta.url funciona)
loadSidebar();