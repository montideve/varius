// assets/js/history-admin.js
// Página "Historial de Compras".
// - Lee params ?customerId, ?name, ?phone para prefiltrar.
// - Permite filtrar por rango de fechas y buscar por nombre/telefono.
// - Muestra lista de pedidos (cliente) y agrega "Movimiento de productos" agregando cantidades y revenue.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore, collection, query, orderBy, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const histFrom = document.getElementById('histFrom');
const histTo = document.getElementById('histTo');
const histSearch = document.getElementById('histSearch');
const applyHistFilters = document.getElementById('applyHistFilters');
const clearHistFilters = document.getElementById('clearHistFilters');
const histOrdersContainer = document.getElementById('histOrdersContainer');
const movementContainer = document.getElementById('movementContainer');
const exportCsvBtn = document.getElementById('exportCsv');
const toastEl = document.getElementById('toast');

let currentUser = null;
let currentUserRole = null;

function showToast(msg, ms = 3500) {
    if (!toastEl) { alert(msg); return; }
    toastEl.textContent = msg; toastEl.classList.remove('hidden'); toastEl.classList.add('show');
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => { toastEl.classList.remove('show'); toastEl.classList.add('hidden'); }, ms);
}
function qParam(name) { const p = new URLSearchParams(window.location.search); return p.get(name) || ''; }
function formatCurrency(amount) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: '' }).format(Number(amount || 0)); } catch (e) { return amount; } }
function escapeHtml(s) { if (!s) return ''; return String(s).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;' }[c] || c)); }

async function fetchHistory({ fromDate, toDate, searchTerm, customerIdParam }) {
    const ordersCol = collection(db, 'orders');
    const q = query(ordersCol, orderBy('orderDate', 'desc'));
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(s => items.push({ id: s.id, ...s.data() }));

    let filtered = items;
    if (currentUserRole === 'vendedor') filtered = filtered.filter(o => o.assignedSeller === currentUser.uid || (o.createdBy && o.createdBy === currentUser.uid));
    else if (currentUserRole === 'motorizado') filtered = filtered.filter(o => o.assignedMotor === currentUser.uid);

    if (customerIdParam) {
        filtered = filtered.filter(o => {
            const cid = (o.customerData && (o.customerData.uid || o.customerId || o.customerData.customerId)) || o.customerId || '';
            return (cid && cid === customerIdParam) || (o.customerData && (o.customerData.email === customerIdParam || o.customerData.phone === customerIdParam));
        });
    }

    if (fromDate || toDate) {
        const from = fromDate ? new Date(fromDate) : null;
        const to = toDate ? new Date(toDate) : null;
        filtered = filtered.filter(o => {
            if (!o.orderDate) return false;
            const od = o.orderDate.toDate ? o.orderDate.toDate() : new Date(o.orderDate);
            if (from && od < from) return false;
            if (to) {
                const end = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59);
                if (od > end) return false;
            }
            return true;
        });
    }

    if (searchTerm) {
        const s = searchTerm.toLowerCase();
        filtered = filtered.filter(o => {
            const name = (o.customerData && (o.customerData.name || o.customerData.Customname || '')) || '';
            const phone = (o.customerData && (o.customerData.phone || '')) || '';
            return (name && name.toLowerCase().includes(s)) || (phone && phone.toLowerCase().includes(s));
        });
    }

    return filtered;
}

function renderHistoryOrders(orders) {
    histOrdersContainer.innerHTML = '';
    if (!orders.length) { histOrdersContainer.innerHTML = '<div class="small-muted">No hay pedidos que coincidan.</div>'; return; }
    const tbl = document.createElement('table'); tbl.className = 'history-table';
    const thead = document.createElement('thead'); thead.innerHTML = '<tr><th>Fecha</th><th>ID</th><th>Items</th><th>Total</th><th>Pago</th></tr>';
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    orders.forEach(o => {
        const tr = document.createElement('tr');
        const d = o.orderDate ? (o.orderDate.toDate ? o.orderDate.toDate() : new Date(o.orderDate)) : null;
        tr.innerHTML = `<td>${d ? d.toLocaleString() : '—'}</td><td>${escapeHtml(o.id)}</td><td>${(Array.isArray(o.items) ? o.items.length : 0)}</td><td>${o.total ? formatCurrency(o.total) : '—'}</td><td>${escapeHtml(o.paymentStatus || '—')}</td>`;
        tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    histOrdersContainer.appendChild(tbl);
}

function computeProductMovement(orders) {
    const map = {};
    for (const o of orders) {
        const items = Array.isArray(o.items) ? o.items : [];
        for (const it of items) {
            const pid = it.productId || it.product_id || it.id || it.product || '';
            const name = it.name || it.title || it.productName || (it.product && it.product.name) || 'Producto';
            const qty = Number(it.quantity || it.qty || it.count || 1) || 1;
            const price = Number(it.price || it.unitPrice || it.productPrice || 0) || 0;
            if (!map[pid]) map[pid] = { productId: pid, name, qty: 0, times: 0, revenue: 0 };
            map[pid].qty += qty;
            map[pid].times += 1;
            map[pid].revenue += price * qty;
        }
    }
    const arr = Object.keys(map).map(k => map[k]);
    arr.sort((a, b) => b.qty - a.qty);
    return arr;
}

function renderProductMovement(list) {
    movementContainer.innerHTML = '';
    if (!list.length) { movementContainer.innerHTML = '<div class="small-muted">No hay movimientos.</div>'; return; }
    const tbl = document.createElement('table'); tbl.className = 'history-table';
    const thead = document.createElement('thead'); thead.innerHTML = '<tr><th>Producto</th><th>Cantidad vendida</th><th>Veces vendido</th><th>Revenue</th></tr>';
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    list.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${escapeHtml(p.name)}</td><td>${p.qty}</td><td>${p.times}</td><td>${formatCurrency(p.revenue)}</td>`;
        tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    movementContainer.appendChild(tbl);
}

function exportOrdersToCsv(orders) {
    if (!orders || !orders.length) { showToast('No hay datos para exportar'); return; }
    const rows = [];
    rows.push(['orderId', 'date', 'customerName', 'customerPhone', 'itemsCount', 'total', 'paymentStatus', 'shippingStatus']);
    for (const o of orders) {
        const d = o.orderDate ? (o.orderDate.toDate ? o.orderDate.toDate().toISOString() : new Date(o.orderDate).toISOString()) : '';
        const name = o.customerData && (o.customerData.name || o.customerData.Customname || '') || '';
        const phone = o.customerData && (o.customerData.phone || '') || '';
        const itemsCount = Array.isArray(o.items) ? o.items.length : 0;
        rows.push([o.id, d, name, phone, String(itemsCount), String(o.total || 0), String(o.paymentStatus || ''), String(o.shippingStatus || '')]);
    }
    const csv = rows.map(r => r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `historial_${Date.now()}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

async function loadAndRender() {
    const from = histFrom.value || null;
    const to = histTo.value || null;
    const search = (histSearch.value || '').trim();
    const customerIdParam = qParam('customerId') || qParam('phone') || qParam('name') || '';

    try {
        const orders = await fetchHistory({ fromDate: from, toDate: to, searchTerm: search, customerIdParam });
        renderHistoryOrders(orders);
        const movement = computeProductMovement(orders);
        renderProductMovement(movement);
        exportCsvBtn.onclick = () => exportOrdersToCsv(orders);
    } catch (err) {
        console.error('Error loading history:', err);
        showToast('Error cargando historial (ver consola)');
    }
}

applyHistFilters.addEventListener('click', loadAndRender);
clearHistFilters.addEventListener('click', () => { histFrom.value = ''; histTo.value = ''; histSearch.value = ''; loadAndRender(); });

onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '/index.html'; return; }
    currentUser = user;
    try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        currentUserRole = userDoc.exists() ? (userDoc.data().role || 'vendedor') : 'vendedor';
    } catch (err) {
        console.error('Error fetching user role:', err);
        currentUserRole = 'vendedor';
    }
    const nameParam = qParam('name') || '';
    const phoneParam = qParam('phone') || '';
    if (nameParam && !histSearch.value) histSearch.value = nameParam;
    if (phoneParam && !histSearch.value) histSearch.value = phoneParam;
    await loadAndRender();
});