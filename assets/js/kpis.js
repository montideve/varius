// assets/js/kpis.js
// Actualiza en tiempo real los KPIs: pedidos hoy y ventas diarias.
// Añade <script type="module" src="assets/js/kpis.js"></script> en administrador.html
// después de haber cargado firebase-config.js (es decir, después de inicializar Firebase).

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getFirestore,
    collection,
    query,
    onSnapshot,
    orderBy
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

// Inicializa la app (reusa instancias si ya están creadas)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

// Referencias a elementos KPI
const ordersTodayEl = document.getElementById('kpi-orders-today');
const salesEl = document.getElementById('kpi-sales');

// Util: formatea número de ventas (entero) a string local
function formatMoney(n) {
    try {
        return Number(n || 0).toLocaleString();
    } catch (e) {
        return String(n || 0);
    }
}

// Extrae fecha válida desde diferentes formatos que puedes tener en tus documentos
function parseOrderDate(docData) {
    // Prioriza createdAt Timestamp, luego orderDate (ISO string), luego timestamp legible
    if (!docData) return null;
    if (docData.createdAt && typeof docData.createdAt.toDate === 'function') {
        return docData.createdAt.toDate();
    }
    if (docData.orderDate) {
        // puede ser ISO string
        const d = new Date(docData.orderDate);
        if (!isNaN(d)) return d;
    }
    if (docData.timestamp) {
        // si guardaste un string legible, intenta parsearlo
        const d = new Date(docData.timestamp);
        if (!isNaN(d)) return d;
    }
    return null;
}

// Calcula inicio del día local (00:00:00) — ajusta si quieres UTC en su lugar
function startOfTodayLocal() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

// Subscribir en tiempo real a orders y actualizar KPIs
function subscribeKpisRealtime() {
    try {
        const ordersCol = collection(db, 'orders');
        const q = query(ordersCol, orderBy('orderDate', 'desc')); // orderBy es opcional; mejora lectura
        onSnapshot(q, snapshot => {
            const todayStart = startOfTodayLocal();
            let ordersToday = 0;
            let salesToday = 0;

            snapshot.docs.forEach(docSnap => {
                const data = docSnap.data();
                const date = parseOrderDate(data);

                // si la fecha no existe, omitimos del conteo diario
                if (date && date >= todayStart) {
                    ordersToday += 1;

                    // sumar total (intenta leer campos comunes: total, subtotal, amount)
                    let totalValue = 0;
                    if (typeof data.total === 'number') totalValue = data.total;
                    else if (typeof data.total === 'string' && !isNaN(Number(data.total))) totalValue = Number(data.total);
                    else if (typeof data.subtotal === 'number') totalValue = data.subtotal;
                    else if (data.items && Array.isArray(data.items)) {
                        // si no hay campo total, sumar subtotales de items si existen
                        totalValue = data.items.reduce((acc, it) => {
                            const s = (typeof it.subtotal === 'number') ? it.subtotal : (typeof it.price === 'number' && typeof it.quantity === 'number' ? it.price * it.quantity : 0);
                            return acc + (s || 0);
                        }, 0);
                    }

                    salesToday += (totalValue || 0);
                }
            });

            // Actualiza DOM (si existen los elementos)
            if (ordersTodayEl) ordersTodayEl.textContent = ordersToday;
            if (salesEl) salesEl.textContent = formatMoney(salesToday);

        }, err => {
            console.error('KPIs realtime snapshot error:', err);
            // mantiene valores en "-" si error
            if (ordersTodayEl) ordersTodayEl.textContent = '—';
            if (salesEl) salesEl.textContent = '—';
        });
    } catch (err) {
        console.error('subscribeKpisRealtime error:', err);
        if (ordersTodayEl) ordersTodayEl.textContent = '—';
        if (salesEl) salesEl.textContent = '—';
    }
}

// Ejecutar suscripción
subscribeKpisRealtime();