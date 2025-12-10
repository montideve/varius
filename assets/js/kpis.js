// assets/js/kpis.js
// Actualiza en tiempo real los KPIs: pedidos hoy, ventas diarias y productos con bajo stock (<5).
// Añade comportamiento: al click sobre el KPI "Stock bajo" muestra un modal con la lista de productos con stock < 5.
// Requiere firebase-config.js y la colección "product" con campo 'stock' numérico.
//
// Nota: reemplaza el archivo existente assets/js/kpis.js por esta versión.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getFirestore,
    collection,
    query,
    onSnapshot,
    orderBy,
    where
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

// Inicializa la app (reusa instancias si ya están creadas)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

// Referencias a elementos KPI
const ordersTodayEl = document.getElementById('kpi-orders-today');
const salesEl = document.getElementById('kpi-sales');
const lowStockValueEl = document.getElementById('kpi-lowstock-value');
const lowStockArticle = document.getElementById('kpi-lowstock');

// Modal elements for low stock
const lowStockModal = document.getElementById('lowStockModal');
const lowStockModalBody = document.getElementById('lowStockModalBody');
const lowStockListEl = document.getElementById('lowStockList');
const lowStockModalClose = document.getElementById('lowStockModalClose');
const lowStockModalOk = document.getElementById('lowStockModalOk');

let lowStockProducts = []; // cached list of products with stock < 5

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
    if (!docData) return null;
    if (docData.createdAt && typeof docData.createdAt.toDate === 'function') {
        return docData.createdAt.toDate();
    }
    if (docData.orderDate) {
        const d = new Date(docData.orderDate);
        if (!isNaN(d)) return d;
    }
    if (docData.timestamp) {
        const d = new Date(docData.timestamp);
        if (!isNaN(d)) return d;
    }
    return null;
}

// Calcula inicio del día local (00:00:00)
function startOfTodayLocal() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

// Suscripción realtime para KPIs de pedidos/ventas
function subscribeKpisRealtime() {
    try {
        const ordersCol = collection(db, 'orders');
        const q = query(ordersCol, orderBy('orderDate', 'desc'));
        onSnapshot(q, snapshot => {
            const todayStart = startOfTodayLocal();
            let ordersToday = 0;
            let salesToday = 0;

            snapshot.docs.forEach(docSnap => {
                const data = docSnap.data();
                const date = parseOrderDate(data);

                if (date && date >= todayStart) {
                    ordersToday += 1;

                    let totalValue = 0;
                    if (typeof data.total === 'number') totalValue = data.total;
                    else if (typeof data.total === 'string' && !isNaN(Number(data.total))) totalValue = Number(data.total);
                    else if (typeof data.subtotal === 'number') totalValue = data.subtotal;
                    else if (data.items && Array.isArray(data.items)) {
                        totalValue = data.items.reduce((acc, it) => {
                            const s = (typeof it.subtotal === 'number') ? it.subtotal : (typeof it.price === 'number' && typeof it.quantity === 'number' ? it.price * it.quantity : 0);
                            return acc + (s || 0);
                        }, 0);
                    }

                    salesToday += (totalValue || 0);
                }
            });

            if (ordersTodayEl) ordersTodayEl.textContent = ordersToday;
            if (salesEl) salesEl.textContent = formatMoney(salesToday);

        }, err => {
            console.error('KPIs realtime snapshot error:', err);
            if (ordersTodayEl) ordersTodayEl.textContent = '—';
            if (salesEl) salesEl.textContent = '—';
        });
    } catch (err) {
        console.error('subscribeKpisRealtime error:', err);
        if (ordersTodayEl) ordersTodayEl.textContent = '—';
        if (salesEl) salesEl.textContent = '—';
    }
}

// Suscripción realtime para productos con stock < 5
function subscribeLowStockRealtime() {
    try {
        const productsCol = collection(db, 'product');
        const lowQuery = query(productsCol, where('stock', '<', 5), orderBy('stock', 'asc'));
        onSnapshot(lowQuery, snapshot => {
            const arr = [];
            snapshot.forEach(docSnap => {
                const d = docSnap.data();
                arr.push({
                    id: docSnap.id,
                    name: d.name || d.title || d.productName || 'Sin nombre',
                    stock: typeof d.stock === 'number' ? d.stock : (d.stock ? Number(d.stock) : 0),
                    sku: d.sku || d.code || ''
                });
            });
            lowStockProducts = arr;
            // Update KPI value
            if (lowStockValueEl) lowStockValueEl.textContent = String(arr.length);
            // Add visual indicator when there are low-stock items
            if (lowStockArticle) {
                if (arr.length > 0) {
                    lowStockArticle.classList.add('has-low-stock');
                    lowStockArticle.setAttribute('aria-pressed', 'false');
                } else {
                    lowStockArticle.classList.remove('has-low-stock');
                    lowStockArticle.setAttribute('aria-pressed', 'false');
                }
            }
        }, err => {
            console.error('Low stock onSnapshot error:', err);
            if (lowStockValueEl) lowStockValueEl.textContent = '—';
        });
    } catch (err) {
        console.error('subscribeLowStockRealtime error:', err);
        if (lowStockValueEl) lowStockValueEl.textContent = '—';
    }
}

// Open modal and show list
function openLowStockModal() {
    if (!lowStockModal) return;
    const list = lowStockProducts || [];
    lowStockListEl.innerHTML = '';
    if (!list.length) {
        const p = document.createElement('div');
        p.style.padding = '12px';
        p.style.color = 'var(--muted)';
        p.textContent = 'Ningún stock se encuentra por debajo de 5.';
        lowStockListEl.appendChild(p);
    } else {
        // Build list items
        list.forEach(p => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.padding = '8px';
            row.style.borderRadius = '8px';
            row.style.background = '#fff';
            row.style.boxShadow = 'inset 0 0 0 1px rgba(2,6,23,0.02)';
            row.innerHTML = `
              <div style="display:flex;flex-direction:column;">
                <div style="font-weight:700">${escapeHtml(p.name)}</div>
                <div style="font-size:12px;color:var(--muted)">${escapeHtml(p.sku || '')}</div>
              </div>
              <div style="font-weight:800;color:${p.stock <= 0 ? '#b91c1c' : '#dc2626'}">${p.stock}</div>
            `;
            lowStockListEl.appendChild(row);
        });
    }

    lowStockModal.classList.remove('hidden');
    lowStockModal.setAttribute('aria-hidden', 'false');
}

// Close modal helper
function closeLowStockModal() {
    if (!lowStockModal) return;
    lowStockModal.classList.add('hidden');
    lowStockModal.setAttribute('aria-hidden', 'true');
    lowStockListEl.innerHTML = '';
}

// Escape helper
function escapeHtml(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

// Attach click handlers for KPI article
if (lowStockArticle) {
    lowStockArticle.addEventListener('click', () => {
        openLowStockModal();
    });
    // keyboard accessibility
    lowStockArticle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openLowStockModal();
        }
    });
}

// Attach modal close handlers
if (lowStockModalClose) lowStockModalClose.addEventListener('click', closeLowStockModal);
if (lowStockModalOk) lowStockModalOk.addEventListener('click', closeLowStockModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLowStockModal(); });

// Start subscriptions
subscribeKpisRealtime();
subscribeLowStockRealtime();