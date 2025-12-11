// assets/js/kpis.js
// KPIs en tiempo real con comparación entre "Pedidos hoy" y la última fecha previa que tuvo pedidos.
// Adaptado al esquema que mostraste (orderDate ISO string, items array, customerData, shippingStatus, total).
// Cambio solicitado: el KPI "Ventas" ahora suma únicamente los pedidos cuyo estado de pago sea "pagado".
// Si un pedido no tiene paymentStatus: "pagado" (o equivalente 'paid'), su total NO se incluirá en el KPI de ventas.
//
// Nota de rendimiento: este script hace un onSnapshot que recorre los documentos de 'orders' y agrupa por fecha.
// Si tienes muchísimos pedidos, considera crear agregados por fecha en backend (Cloud Function) y pedir solo esos agregados.

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

// Modal elements for low stock (existing)
const lowStockModal = document.getElementById('lowStockModal');
const lowStockModalBody = document.getElementById('lowStockModalBody');
const lowStockListEl = document.getElementById('lowStockList');
const lowStockModalClose = document.getElementById('lowStockModalClose');
const lowStockModalOk = document.getElementById('lowStockModalOk');

let lowStockProducts = []; // cached list of products with stock < 5

// Inject minimal styles for KPI comparison and modal (so you don't need to edit CSS files)
(function injectStyles() {
    const css = `
    /* small red comparative text beside KPI */
    .kpi-compare {
        display:block;
        font-size:12px;
        color:var(--muted, #9ca3af);
        margin-top:4px;
    }
    .kpi-compare .compare-number {
        color:#dc2626; /* red */
        font-weight:700;
        font-size:11px;
        margin-left:6px;
    }

    /* simple modal for orders comparison */
    #ordersCompareModal {
        position:fixed;
        inset:0;
        display:flex;
        align-items:center;
        justify-content:center;
        background:rgba(2,6,23,0.5);
        z-index:1200;
        padding:20px;
    }
    #ordersCompareModal .modal-panel {
        background:var(--surface, #fff);
        border-radius:8px;
        max-width:960px;
        width:100%;
        max-height:90vh;
        overflow:auto;
        box-shadow:0 10px 30px rgba(2,6,23,0.2);
        padding:18px;
    }
    #ordersCompareModal .modal-header {
        display:flex;
        justify-content:space-between;
        align-items:center;
        margin-bottom:12px;
    }
    #ordersCompareModal .compare-grid {
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:12px;
    }
    #ordersCompareModal .compare-card {
        border:1px solid rgba(2,6,23,0.06);
        padding:12px;
        border-radius:8px;
        background:var(--card-bg,#fff);
    }
    #ordersCompareModal .muted { color:var(--muted,#6b7280); font-size:13px; }
    #ordersCompareModal .stat { font-size:20px; font-weight:700; margin-top:6px; }
    #ordersCompareModal .small { font-size:12px; color:var(--muted,#6b7280); }
    `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
})();

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
    if (docData.timestamp && typeof docData.timestamp.toDate === 'function') {
        return docData.timestamp.toDate();
    }
    if (docData.orderDate) {
        const d = new Date(docData.orderDate);
        if (!isNaN(d)) return d;
    }
    return null;
}

// Calcula inicio del día local (00:00:00)
function startOfDayLocal(d = new Date()) {
    const dt = new Date(d);
    dt.setHours(0, 0, 0, 0);
    return dt;
}
function dateKeyFromDate(d) {
    const dt = new Date(d);
    // Use local date yyyy-mm-dd
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// Heurística para saber si un pedido está entregado
function isDelivered(data) {
    if (!data) return false;
    const s = (data.shippingStatus || data.shipping_state || data.status || '').toString().toLowerCase();
    if (s.includes('deliver') || s.includes('entreg') || s.includes('delivered')) return true;
    if (data.isDelivered === true) return true;
    if (data.deliveredAt || data.delivered_at) return true;
    return false;
}

// Heurística para determinar si el pedido está pagado (busca paymentStatus / payment_status / payment.status)
function isPaymentStatusPaid(data) {
    if (!data) return false;
    const ps = (
        data.paymentStatus ||
        data.payment_status ||
        (data.payment && (data.payment.paymentStatus || data.payment.status)) ||
        (data.payment && data.payment.state) ||
        ''
    ).toString().toLowerCase();
    // Considera 'pagado' (español) y 'paid' (inglés). También aceptamos variantes que contengan 'pagad'.
    return ps === 'pagado' || ps === 'paid' || ps.includes('pagad') || ps.includes('paid');
}

// Suscripción realtime para KPIs de pedidos/ventas con comparación a la última fecha con pedidos
function subscribeKpisRealtime() {
    try {
        const ordersCol = collection(db, 'orders');
        // traer ordenes ordenadas descendente (recientes primero).
        const q = query(ordersCol, orderBy('orderDate', 'desc'));
        onSnapshot(q, snapshot => {
            // agrupamos por fecha local (yyyy-mm-dd)
            const byDate = new Map();

            snapshot.docs.forEach(docSnap => {
                const data = docSnap.data();
                const date = parseOrderDate(data);
                if (!date) return;
                const key = dateKeyFromDate(date);

                if (!byDate.has(key)) {
                    byDate.set(key, {
                        count: 0,
                        sales: 0,               // ahora acumulamos SOLO ventas pagadas
                        deliveredCount: 0,
                        customers: new Set(),
                        productCounts: new Map(), // productName => units
                        maxOrder: { id: null, total: 0, raw: null }
                    });
                }
                const bucket = byDate.get(key);
                bucket.count += 1;

                // total value (heurística)
                let totalValue = 0;
                if (typeof data.total === 'number') totalValue = data.total;
                else if (typeof data.total === 'string' && !isNaN(Number(data.total))) totalValue = Number(data.total);
                else if (typeof data.totalUSD === 'number') totalValue = data.totalUSD;
                else if (typeof data.subtotal === 'number') totalValue = data.subtotal;
                else if (data.items && Array.isArray(data.items)) {
                    totalValue = data.items.reduce((acc, it) => {
                        if (!it) return acc;
                        const s = (typeof it.subtotal === 'number') ? it.subtotal : ((typeof it.price === 'number' && typeof it.quantity === 'number') ? it.price * it.quantity : 0);
                        return acc + (s || 0);
                    }, 0);
                }

                // Añadir al total de ventas SOLO si el pedido está marcado como pagado
                if (isPaymentStatusPaid(data)) {
                    bucket.sales += (totalValue || 0);
                }

                // delivered
                if (isDelivered(data)) bucket.deliveredCount += 1;

                // customers unique - try customerData.email/phone/Customname or userId
                let customerId = null;
                if (data.customerData) {
                    if (data.customerData.email) customerId = data.customerData.email;
                    else if (data.customerData.phone) customerId = data.customerData.phone;
                    else if (data.customerData.Customname) customerId = data.customerData.Customname;
                }
                if (!customerId) {
                    customerId = data.customerId || data.userId || data.user_id || data.email || null;
                }
                if (customerId) bucket.customers.add(String(customerId));

                // product counts
                if (data.items && Array.isArray(data.items)) {
                    data.items.forEach(it => {
                        if (!it) return;
                        const name = it.name || it.productName || it.title || (it.productId ? String(it.productId) : 'Sin nombre');
                        const qty = (typeof it.quantity === 'number') ? it.quantity : (it.qty ? Number(it.qty) : 0);
                        const prev = bucket.productCounts.get(name) || 0;
                        bucket.productCounts.set(name, prev + (qty || 0));
                    });
                }

                // max order (comparamos por totalValue independientemente de si está pagado)
                if (totalValue > (bucket.maxOrder.total || 0)) {
                    bucket.maxOrder = { id: docSnap.id, total: totalValue, raw: data };
                }
            });

            // find today's key and the last key before today with orders
            const todayKey = dateKeyFromDate(startOfDayLocal());
            const keys = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a)); // desc
            // Determine "previous" => first key < todayKey in sorted order
            let prevKey = null;
            for (const k of keys) {
                if (k < todayKey) {
                    prevKey = k;
                    break;
                }
            }

            const todayBucket = byDate.get(todayKey) || { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 } };
            const prevBucket = prevKey ? byDate.get(prevKey) : { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 } };

            // Update KPI numbers
            const ordersToday = todayBucket.count || 0;
            if (ordersTodayEl) {
                const prevCount = prevBucket.count || 0;
                const display = `${escapeHtml(String(ordersToday))}
                    <span class="kpi-compare"><span class="small muted">última fecha: ${prevKey || '—'}</span>
                    <span class="compare-number">${escapeHtml(String(prevCount))}</span></span>`;
                ordersTodayEl.innerHTML = display;
            }

            // Mostrar en KPI de Ventas SOLO la suma de pedidos pagados (todayBucket.sales)
            if (salesEl) salesEl.textContent = formatMoney(todayBucket.sales);

            // store aggregated data for modal usage
            window.__kpis_cache = window.__kpis_cache || {};
            window.__kpis_cache.ordersByDate = byDate;
            window.__kpis_cache.todayKey = todayKey;
            window.__kpis_cache.prevKey = prevKey;
            window.__kpis_cache.todayBucket = todayBucket;
            window.__kpis_cache.prevBucket = prevBucket;

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

// Attach click handlers for low-stock KPI article
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

// Create and manage orders comparison modal (created dynamically)
function createOrdersCompareModal() {
    // If already exists, return it
    let existing = document.getElementById('ordersCompareModal');
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.id = 'ordersCompareModal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = `
      <div class="modal-panel" role="document">
        <div class="modal-header">
          <h2>Comparativa de pedidos</h2>
          <button id="ordersCompareClose" aria-label="Cerrar" class="close-btn" style="font-size:20px;background:none;border:none;cursor:pointer;">&times;</button>
        </div>
        <div id="ordersCompareContent"></div>
      </div>
    `;

    // close handlers
    overlay.querySelector('#ordersCompareClose').addEventListener('click', () => {
        overlay.remove();
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
    document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape') {
            const el = document.getElementById('ordersCompareModal');
            if (el) el.remove();
            document.removeEventListener('keydown', onEsc);
        }
    });

    document.body.appendChild(overlay);
    return overlay;
}

// Helper to compute top product from productCounts map
function topProductFromMap(productCounts) {
    if (!productCounts || productCounts.size === 0) return null;
    let topName = null;
    let topQty = 0;
    for (const [name, qty] of productCounts.entries()) {
        if (qty > topQty) {
            topQty = qty;
            topName = name;
        }
    }
    return topName ? { name: topName, qty: topQty } : null;
}

// Build and fill compare modal content from cache
function openOrdersCompareModal() {
    const cache = window.__kpis_cache || {};
    const todayKey = cache.todayKey;
    const prevKey = cache.prevKey;
    const today = cache.todayBucket || { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 } };
    const prev = cache.prevBucket || { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 } };

    const modal = createOrdersCompareModal();
    const content = modal.querySelector('#ordersCompareContent');

    // Top products
    const topToday = topProductFromMap(today.productCounts);
    const topPrev = topProductFromMap(prev.productCounts);

    // Build HTML
    content.innerHTML = `
      <div class="compare-grid" style="margin-bottom:12px;">
        <div class="compare-card">
          <div class="muted">Fecha</div>
          <div class="stat">${escapeHtml(todayKey)}</div>
        </div>
        <div class="compare-card">
          <div class="muted">Fecha comparativa</div>
          <div class="stat">${escapeHtml(prevKey || '—')}</div>
        </div>

        <div class="compare-card">
          <div class="muted">Pedidos</div>
          <div class="stat">${escapeHtml(String(today.count || 0))}</div>
          <div class="small">vs ${escapeHtml(String(prev.count || 0))}</div>
        </div>

        <div class="compare-card">
          <div class="muted">Ventas totales (solo "pagado")</div>
          <div class="stat">$ ${escapeHtml(formatMoney(today.sales || 0))}</div>
          <div class="small">vs $ ${escapeHtml(formatMoney(prev.sales || 0))}</div>
        </div>

        <div class="compare-card">
          <div class="muted">Clientes únicos</div>
          <div class="stat">${escapeHtml(String((today.customers && today.customers.size) || 0))}</div>
          <div class="small">vs ${escapeHtml(String((prev.customers && prev.customers.size) || 0))}</div>
        </div>

        <div class="compare-card">
          <div class="muted">Entregas</div>
          <div class="stat">${escapeHtml(String(today.deliveredCount || 0))}</div>
          <div class="small">vs ${escapeHtml(String(prev.deliveredCount || 0))}</div>
        </div>

        <div class="compare-card" style="grid-column:1 / -1;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div class="muted">Producto más vendido</div>
              <div class="stat">${topToday ? escapeHtml(topToday.name) + ' (' + escapeHtml(String(topToday.qty)) + ')' : '—'}</div>
            </div>
            <div>
              <div class="muted">Vs</div>
              <div class="stat">${topPrev ? escapeHtml(topPrev.name) + ' (' + escapeHtml(String(topPrev.qty)) + ')' : '—'}</div>
            </div>
          </div>
        </div>

        <div class="compare-card" style="grid-column:1 / -1;">
          <div class="muted">Pedido más grande</div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div class="small">ID</div>
              <div class="stat">${today.maxOrder && today.maxOrder.id ? escapeHtml(today.maxOrder.id) : '—'}</div>
            </div>
            <div>
              <div class="small">Total</div>
              <div class="stat">$ ${escapeHtml(formatMoney(today.maxOrder && today.maxOrder.total || 0))}</div>
            </div>
            <div style="text-align:right;">
              <div class="small">Vs</div>
              <div class="small">ID: ${prev.maxOrder && prev.maxOrder.id ? escapeHtml(prev.maxOrder.id) : '—'}</div>
              <div class="stat">$ ${escapeHtml(formatMoney(prev.maxOrder && prev.maxOrder.total || 0))}</div>
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button id="ordersCompareCloseBtn" class="btn-secondary">Cerrar</button>
      </div>
    `;

    // attach close
    const closeBtn = modal.querySelector('#ordersCompareCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', () => modal.remove());
    // ensure focus
    modal.querySelector('.modal-panel').focus();
}

// Attach click to the "Pedidos hoy" KPI card to open compare modal
(function attachOrdersKpiClick() {
    if (!ordersTodayEl) return;
    // find closest article.kpi-card
    let parent = ordersTodayEl;
    while (parent && parent.tagName && parent.tagName.toLowerCase() !== 'article') {
        parent = parent.parentElement;
    }
    const kpiArticle = parent;
    if (!kpiArticle) return;

    kpiArticle.style.cursor = 'pointer';
    kpiArticle.setAttribute('tabindex', '0');
    kpiArticle.addEventListener('click', () => {
        openOrdersCompareModal();
    });
    kpiArticle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openOrdersCompareModal();
        }
    });
})();

// Attach modal close handlers (low stock)
if (lowStockModalClose) lowStockModalClose.addEventListener('click', closeLowStockModal);
if (lowStockModalOk) lowStockModalOk.addEventListener('click', closeLowStockModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLowStockModal(); });

// Start subscriptions
subscribeKpisRealtime();
subscribeLowStockRealtime();