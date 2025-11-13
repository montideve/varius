// assets/js/orders.js
// Versión adaptada a tu estructura (customerData.Customname) y con restricción:
// Los botones "Marcar pagado", "Marcar enviado" y "Marcar entregado" están DESACTIVADOS
// hasta que el pedido tenga asignado al menos un vendedor y al menos un motorizado.
// Mantiene: modal único de asignación, filtros, roles (administrador/vendedor/motorizado),
// export CSV y vista en tiempo real.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getFirestore,
    collection,
    doc,
    onSnapshot,
    getDocs,
    query,
    where,
    orderBy,
    updateDoc,
    serverTimestamp,
    getDoc
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
    getAuth,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

/* ---------- UI helpers ---------- */
const toastEl = document.getElementById('toast');
function showToast(msg, isError = false, timeout = 3500) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.background = isError ? '#b91c1c' : '#111827';
    toastEl.classList.remove('hidden');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.add('hidden'), timeout);
}
function formatDate(ts) {
    if (!ts) return '-';
    try {
        if (ts?.toDate) ts = ts.toDate();
        return new Date(ts).toLocaleString();
    } catch (e) {
        return String(ts);
    }
}
function escapeHtml(s) {
    if (!s && s !== 0) return '';
    return String(s).replace(/[&<>"'`=\/]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;', '=': '&#x3D;', '`': '&#x60;' }[c];
    });
}

/* ---------- State ---------- */
let ordersCache = [];
let currentUser = null;
let currentUserRole = null;
let activeVendedores = [];
let activeMotorizados = [];
let activeFilter = {};

/* ---------- DOM refs ---------- */
const tbody = document.getElementById('ordersTbody');
const applyBtn = document.getElementById('applyFilters');
const resetBtn = document.getElementById('resetFilters');
const searchInput = document.getElementById('q');
const downloadCsvBtn = document.getElementById('downloadCsv');

const assignModal = document.getElementById('assignModal');
const assignClose = document.getElementById('assignModalClose');
const assignCancel = document.getElementById('assignCancel');
const assignConfirm = document.getElementById('assignConfirm');
const vendedoresTableBody = document.querySelector('#vendedoresList tbody');
const motorizadosTableBody = document.querySelector('#motorizadosList tbody');

const viewModal = document.getElementById('viewModal');
const viewClose = document.getElementById('viewModalClose');
const viewCloseBtn = document.getElementById('viewCloseBtn');
const orderTimeline = document.getElementById('orderTimeline');

let assignTargetOrderId = null;
let orderDocUnsubscribe = null;

/* ---------- Auth & role ---------- */
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (!user) return;
    try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        currentUserRole = userDoc.exists() ? (userDoc.data().role || 'vendedor') : 'vendedor';
        const nameEl = document.getElementById('sidebar-name');
        const emailEl = document.getElementById('sidebar-email');
        const avatarEl = document.getElementById('sidebar-avatar');
        if (nameEl) nameEl.textContent = (userDoc.exists() && (userDoc.data().displayName || userDoc.data().name)) || user.email || 'Usuario';
        if (emailEl) emailEl.textContent = (userDoc.exists() && userDoc.data().email) || user.email || '';
        if (avatarEl) avatarEl.textContent = (userDoc.exists() && (userDoc.data().displayName || userDoc.data().email) || 'U')[0].toUpperCase();
    } catch (err) {
        console.error('No se pudo obtener rol de usuario:', err);
    }
});

/* ---------- Load active users ---------- */
async function loadActiveUsers() {
    try {
        const usersCol = collection(db, 'users');
        const qV = query(usersCol, where('role', '==', 'vendedor'), where('active', '==', true), where('online', '==', true));
        const qM = query(usersCol, where('role', '==', 'motorizado'), where('active', '==', true), where('online', '==', true));
        const [snapV, snapM] = await Promise.all([getDocs(qV), getDocs(qM)]);
        activeVendedores = snapV.docs.map(d => ({ id: d.id, ...d.data() }));
        activeMotorizados = snapM.docs.map(d => ({ id: d.id, ...d.data() }));

        // Update motorizado filter options
        const motorizadoSelect = document.getElementById('motorizadoFiltro');
        if (motorizadoSelect) {
            motorizadoSelect.innerHTML = '<option value="">Todos</option><option value="sin-asignar">Sin asignar</option>';
            activeMotorizados.forEach(u => {
                const opt = document.createElement('option');
                opt.value = u.id;
                opt.textContent = u.displayName || u.name || u.email || u.id;
                motorizadoSelect.appendChild(opt);
            });
        }
    } catch (err) {
        console.error('Error cargando usuarios activos:', err);
        showToast('No se pudieron cargar usuarios activos.', true);
    }
}

/* ---------- Real-time orders listener ---------- */
function subscribeOrdersRealtime() {
    try {
        const ordersCol = collection(db, 'orders');
        // ordeno por orderDate si existe; si usas createdAt Timestamp, cambia aquí a createdAt
        const q = query(ordersCol, orderBy('orderDate', 'desc'));
        onSnapshot(q, (snapshot) => {
            ordersCache = snapshot.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
            renderOrders();
        }, (err) => {
            console.error('Orders realtime error:', err);
            showToast('Error escuchando pedidos en tiempo real.', true);
        });
    } catch (err) {
        console.error('subscribeOrdersRealtime error:', err);
    }
}

/* ---------- Normalize order (handles your DB structure) ---------- */
/*
  Key change: the customer name lives in customerData.Customname (per your screenshot).
  This function prefers that field, with fallbacks to older fields.
*/
function normalizeOrder(raw) {
    const o = { ...raw };

    // Cliente: primero customerData.Customname (exacto de tu base), luego otros campos legacy
    o.clientName =
        (raw.customerData && (raw.customerData.Customname || raw.customerData.customName)) ||
        raw.name ||
        (raw.customer && (raw.customer.name || raw.customer.fullName)) ||
        raw.email ||
        '';

    // producto representativo
    if (Array.isArray(o.items) && o.items.length) {
        o.productTitle = o.items.map(i => i.name).join(', ');
    } else {
        o.productTitle = o.productTitle || o.productName || '';
    }

    // fecha: prefer createdAt Timestamp, luego orderDate ISO string, luego timestamp
    if (o.createdAt && o.createdAt.toDate) {
        o._createdAt = o.createdAt.toDate();
    } else if (o.orderDate) {
        try { o._createdAt = new Date(o.orderDate); } catch (e) { o._createdAt = o.orderDate; }
    } else if (o.timestamp) {
        o._createdAt = o.timestamp;
    } else {
        o._createdAt = null;
    }

    // estados
    o.paymentStatus = (o.paymentStatus || o.payment || '').toString().toLowerCase() || '';
    o.shippingStatus = (o.shippingStatus || o.status || '').toString().toLowerCase() || '';

    // asignaciones: arrays o legacy single fields
    if (Array.isArray(o.vendedorIds)) o._vendedorIds = o.vendedorIds;
    else if (o.vendedor) o._vendedorIds = [o.vendedor];
    else if (o.vendedorId) o._vendedorIds = [o.vendedorId];
    else o._vendedorIds = [];

    if (Array.isArray(o.motorizadoIds)) o._motorizadoIds = o.motorizadoIds;
    else if (o.motorizado) o._motorizadoIds = [o.motorizado];
    else if (o.motorizadoId) o._motorizadoIds = [o.motorizadoId];
    else o._motorizadoIds = [];

    return o;
}

/* ---------- Rendering & filtering ---------- */
function matchesFilters(order, filters) {
    if (filters.fechaInicio) {
        const start = new Date(filters.fechaInicio); start.setHours(0, 0, 0, 0);
        const c = order._createdAt instanceof Date ? order._createdAt : (order.createdAt && order.createdAt.toDate ? order.createdAt.toDate() : null);
        if (!c || new Date(c) < start) return false;
    }
    if (filters.fechaFin) {
        const end = new Date(filters.fechaFin); end.setHours(23, 59, 59, 999);
        const c = order._createdAt instanceof Date ? order._createdAt : (order.createdAt && order.createdAt.toDate ? order.createdAt.toDate() : null);
        if (!c || new Date(c) > end) return false;
    }
    if (filters.productoFiltro) {
        if (!order.productTitle) return false;
        if (!order.productTitle.toLowerCase().includes(filters.productoFiltro.toLowerCase())) return false;
    }
    if (filters.estadoPago) {
        if ((order.paymentStatus || '') !== filters.estadoPago && filters.estadoPago !== '') return false;
    }
    if (filters.estadoEnvio) {
        if ((order.shippingStatus || '') !== filters.estadoEnvio && filters.estadoEnvio !== '') return false;
    }
    if (filters.motorizadoFiltro) {
        if (filters.motorizadoFiltro === 'sin-asignar') {
            if (order._motorizadoIds && order._motorizadoIds.length) return false;
        } else if (filters.motorizadoFiltro !== '') {
            if (!order._motorizadoIds || !order._motorizadoIds.includes(filters.motorizadoFiltro)) return false;
        }
    }
    if (filters.search) {
        const s = filters.search.toLowerCase();
        const checks = [
            order.clientName && order.clientName.toLowerCase(),
            order.productTitle && order.productTitle.toLowerCase(),
            (order.total || '').toString()
        ];
        const any = checks.find(c => c && c.includes(s));
        if (!any) return false;
    }
    return true;
}

function renderOrders() {
    if (!tbody) return;
    tbody.innerHTML = '';
    const visible = ordersCache.map(normalizeOrder).filter(o => matchesFilters(o, activeFilter));
    if (!visible.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="10" style="text-align:center; padding:18px;">No hay pedidos que coincidan con los filtros.</td>`;
        tbody.appendChild(tr);
        return;
    }

    visible.forEach(o => {
        const tr = document.createElement('tr');

        const idTd = `<td>${escapeHtml(o.id)}</td>`;
        const clientTd = `<td>${escapeHtml(o.clientName || o.email || '-')}</td>`;
        const productTd = `<td>${escapeHtml(o.productTitle || '-')}</td>`;
        const dateTd = `<td>${formatDate(o._createdAt || o.orderDate || o.timestamp)}</td>`;
        const totalTd = `<td>$${(o.total || 0).toLocaleString()}</td>`;

        const payment = (o.paymentStatus || 'pendiente').toLowerCase();
        const shipping = (o.shippingStatus || 'pendiente').toLowerCase();

        const paymentBadge = `<td><span class="badge ${payment === 'pagado' ? 'paid' : 'pending'}">${payment === 'pagado' ? 'Pagado' : 'Pendiente'}</span></td>`;
        const shippingBadge = `<td><span class="badge ${shipping === 'enviado' ? 'shipped' : (shipping === 'entregado' ? 'delivered' : 'pending')}">${shipping === 'enviado' ? 'Enviado' : (shipping === 'entregado' ? 'Entregado' : 'Pendiente')}</span></td>`;

        const sellerDisplay = (o._vendedorIds && o._vendedorIds.length) ? o._vendedorIds.map(id => `<span class="badge-state">${escapeHtml(id)}</span>`).join(' ') : '-';
        const motoDisplay = (o._motorizadoIds && o._motorizadoIds.length) ? o._motorizadoIds.map(id => `<span class="badge-state">${escapeHtml(id)}</span>`).join(' ') : '-';

        // nueva regla: los botones de acción solo se habilitan si hay al menos un vendedor y un motorizado asignados
        const isFullyAssigned = (o._vendedorIds && o._vendedorIds.length > 0) && (o._motorizadoIds && o._motorizadoIds.length > 0);
        const assignBtn = ((!o._vendedorIds.length) || (!o._motorizadoIds.length)) ? `<button class="icon-btn open-assign" data-order="${o.id}">Asignar</button>` : '';

        // permisos por rol + requisito de asignación completa
        const canMarkPaid = isFullyAssigned && (currentUserRole === 'motorizado' || currentUserRole === 'administrador');
        const canMarkSent = isFullyAssigned && (currentUserRole === 'vendedor' || currentUserRole === 'administrador');
        const canMarkDelivered = isFullyAssigned && (currentUserRole === 'motorizado' || currentUserRole === 'administrador');

        // si no están permitidos, desactivar con title explicativo
        const titleDisabled = 'Desactivado: requiere vendedor y motorizado asignados';

        const btnView = `<button class="icon-btn view-btn" data-order="${o.id}">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-eye" viewBox="0 0 16 16">
                <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13 13 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5s3.879 1.168 5.168 2.457A13 13 0 0 1 14.828 8q-.086.13-.195.288c-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5s-3.879-1.168-5.168-2.457A13 13 0 0 1 1.172 8z"/>
                <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/>
            </svg>
        </button>`;
        
        const btnMarkPaid = `<button class="icon-btn mark-paid" data-order="${o.id}" ${canMarkPaid ? '' : 'disabled'} ${canMarkPaid ? '' : `title="${titleDisabled}"`}>Marcar pagado</button>`;
        const btnMarkSent = `<button class="icon-btn mark-sent" data-order="${o.id}" ${canMarkSent ? '' : 'disabled'} ${canMarkSent ? '' : `title="${titleDisabled}"`}>Marcar enviado</button>`;
        const btnMarkDelivered = `<button class="icon-btn mark-delivered" data-order="${o.id}" ${canMarkDelivered ? '' : 'disabled'} ${canMarkDelivered ? '' : `title="${titleDisabled}"`}>Marcar entregado</button>`;

        const actionsTd = `<td class="actions">${assignBtn} ${btnView} ${btnMarkPaid} ${btnMarkSent} ${btnMarkDelivered}</td>`;

        tr.innerHTML = `${idTd}${clientTd}${productTd}${dateTd}${totalTd}${paymentBadge}${shippingBadge}<td>${sellerDisplay}</td><td>${motoDisplay}</td>${actionsTd}`;
        tbody.appendChild(tr);
    });

    // attach handlers
    document.querySelectorAll('.open-assign').forEach(btn => { btn.onclick = () => openAssignModal(btn.dataset.order); });
    document.querySelectorAll('.view-btn').forEach(btn => { btn.onclick = () => openViewModal(btn.dataset.order); });
    document.querySelectorAll('.mark-paid').forEach(btn => {
        btn.onclick = async (e) => {
            if (btnIsDisabled(e.target)) return;
            await updateOrderPayment(e.target.dataset.order, 'pagado');
        }
    });
    document.querySelectorAll('.mark-sent').forEach(btn => {
        btn.onclick = async (e) => {
            if (btnIsDisabled(e.target)) return;
            await updateOrderShipping(e.target.dataset.order, 'enviado');
        }
    });
    document.querySelectorAll('.mark-delivered').forEach(btn => {
        btn.onclick = async (e) => {
            if (btnIsDisabled(e.target)) return;
            await updateOrderShipping(e.target.dataset.order, 'entregado');
        }
    });
}

// helper para prevenir clicks en botones desactivados (por si el atributo disabled no evitara la callback)
function btnIsDisabled(el) {
    if (!el) return true;
    return el.hasAttribute('disabled');
}

/* ---------- Assign modal flow ---------- */
async function openAssignModal(orderId) {
    assignTargetOrderId = orderId;
    await loadActiveUsers();

    // Populate vendedores table: checkbox + name (phone under name)
    vendedoresTableBody.innerHTML = '';
    activeVendedores.forEach(u => {
        const tr = document.createElement('tr');
        const nameHtml = `<div class="user-cell"><div class="user-name">${escapeHtml(u.displayName || u.name || u.email || u.id)}</div><div class="user-phone">${escapeHtml(u.phone || '')}</div></div>`;
        tr.innerHTML = `<td><input type="checkbox" data-uid="${u.id}" class="sel-vendedor"></td><td>${nameHtml}</td>`;
        vendedoresTableBody.appendChild(tr);
    });

    // Populate motorizados table
    motorizadosTableBody.innerHTML = '';
    activeMotorizados.forEach(u => {
        const tr = document.createElement('tr');
        const nameHtml = `<div class="user-cell"><div class="user-name">${escapeHtml(u.displayName || u.name || u.email || u.id)}</div><div class="user-phone">${escapeHtml(u.phone || '')}</div></div>`;
        tr.innerHTML = `<td><input type="checkbox" data-uid="${u.id}" class="sel-motorizado"></td><td>${nameHtml}</td>`;
        motorizadosTableBody.appendChild(tr);
    });

    assignModal.classList.remove('hidden');
    assignModal.setAttribute('aria-hidden', 'false');
}

function closeAssignModal() {
    assignModal.classList.add('hidden');
    assignModal.setAttribute('aria-hidden', 'true');
    assignTargetOrderId = null;
}
assignClose?.addEventListener('click', closeAssignModal);
assignCancel?.addEventListener('click', closeAssignModal);

assignConfirm?.addEventListener('click', async () => {
    try {
        if (!assignTargetOrderId) { showToast('Pedido no definido', true); closeAssignModal(); return; }
        if (currentUserRole !== 'administrador') { showToast('Solo administradores pueden asignar.', true); closeAssignModal(); return; }

        const selectedV = Array.from(document.querySelectorAll('.sel-vendedor:checked')).map(i => i.dataset.uid);
        const selectedM = Array.from(document.querySelectorAll('.sel-motorizado:checked')).map(i => i.dataset.uid);

        const updatePayload = {};
        if (selectedV.length) updatePayload.vendedorIds = selectedV;
        if (selectedM.length) updatePayload.motorizadoIds = selectedM;
        if (selectedV.length === 1) updatePayload.vendedor = selectedV[0];
        if (selectedM.length === 1) updatePayload.motorizado = selectedM[0];
        updatePayload.lastAssignedAt = serverTimestamp();

        const orderRef = doc(db, 'orders', assignTargetOrderId);
        await updateDoc(orderRef, updatePayload);
        showToast('Asignación guardada.');
        closeAssignModal();
    } catch (err) {
        console.error('Assign error:', err);
        showToast('Error asignando personal.', true);
    }
});

/* ---------- Update states (role-based) ---------- */
async function updateOrderPayment(orderId, newStatus) {
    try {
        if (!(currentUserRole === 'motorizado' || currentUserRole === 'administrador')) {
            showToast('No tienes permiso para marcar pago.', true);
            return;
        }
        const orderRef = doc(db, 'orders', orderId);
        await updateDoc(orderRef, {
            paymentStatus: newStatus,
            paymentUpdatedAt: serverTimestamp()
        });
        showToast('Pago actualizado.');
    } catch (err) {
        console.error('updateOrderPayment error:', err);
        showToast('No se pudo actualizar pago.', true);
    }
}

async function updateOrderShipping(orderId, newStatus) {
    try {
        if (newStatus === 'enviado' && !(currentUserRole === 'vendedor' || currentUserRole === 'administrador')) {
            showToast('Solo vendedores pueden marcar enviado.', true);
            return;
        }
        if (newStatus === 'entregado' && !(currentUserRole === 'motorizado' || currentUserRole === 'administrador')) {
            showToast('Solo motorizados pueden marcar entregado.', true);
            return;
        }
        const orderRef = doc(db, 'orders', orderId);
        await updateDoc(orderRef, {
            shippingStatus: newStatus,
            shippingUpdatedAt: serverTimestamp(),
            status: newStatus
        });
        showToast('Estado de envío actualizado.');
    } catch (err) {
        console.error('updateOrderShipping error:', err);
        showToast('No se pudo actualizar estado de envío.', true);
    }
}

/* ---------- View modal (real-time timeline) ---------- */
async function openViewModal(orderId) {
    try {
        if (orderDocUnsubscribe) { orderDocUnsubscribe(); orderDocUnsubscribe = null; }
        viewModal.classList.remove('hidden'); viewModal.setAttribute('aria-hidden', 'false');
        orderTimeline.innerHTML = '<p>Cargando estado...</p>';
        const orderRef = doc(db, 'orders', orderId);
        orderDocUnsubscribe = onSnapshot(orderRef, (snap) => {
            if (!snap.exists()) { orderTimeline.innerHTML = '<p>Pedido no encontrado.</p>'; return; }
            const o = normalizeOrder({ id: snap.id, ...snap.data() });
            renderOrderTimeline(o);
        }, (err) => {
            console.error('order onSnapshot error:', err);
            showToast('Error obteniendo estado en tiempo real.', true);
        });
    } catch (err) {
        console.error('openViewModal error:', err);
        showToast('No se pudo abrir vista del pedido.', true);
    }
}
function closeViewModal() {
    viewModal.classList.add('hidden'); viewModal.setAttribute('aria-hidden', 'true');
    if (orderDocUnsubscribe) { orderDocUnsubscribe(); orderDocUnsubscribe = null; }
}
viewClose?.addEventListener('click', closeViewModal);
viewCloseBtn?.addEventListener('click', closeViewModal);

function renderOrderTimeline(o) {
    const entries = [];
    entries.push({ title: 'Creado', time: o._createdAt || o.orderDate || o.timestamp });
    if (o._vendedorIds && o._vendedorIds.length) entries.push({ title: `Vendedor(s) asignado(s): ${o._vendedorIds.join(', ')}`, time: o.lastAssignedAt || null });
    if (o._motorizadoIds && o._motorizadoIds.length) entries.push({ title: `Motorizado(s) asignado(s): ${o._motorizadoIds.join(', ')}`, time: o.lastAssignedAt || null });
    if (o.paymentStatus) entries.push({ title: `Pago: ${o.paymentStatus}`, time: o.paymentUpdatedAt || null });
    if (o.shippingStatus) entries.push({ title: `Envío: ${o.shippingStatus}`, time: o.shippingUpdatedAt || null });

    orderTimeline.innerHTML = '';
    const ul = document.createElement('ul'); ul.className = 'timeline';
    entries.forEach(en => {
        const li = document.createElement('li');
        li.innerHTML = `<div class="timeline-item"><div class="timeline-title">${escapeHtml(en.title)}</div><div class="timeline-time">${formatDate(en.time)}</div></div>`;
        ul.appendChild(li);
    });
    orderTimeline.appendChild(ul);
}

/* ---------- Filters & CSV ---------- */
function readFiltersFromForm() {
    return {
        fechaInicio: document.getElementById('fechaInicio')?.value || '',
        fechaFin: document.getElementById('fechaFin')?.value || '',
        productoFiltro: document.getElementById('productoFiltro')?.value || '',
        estadoPago: document.getElementById('estadoPago')?.value || '',
        estadoEnvio: document.getElementById('estadoEnvio')?.value || '',
        motorizadoFiltro: document.getElementById('motorizadoFiltro')?.value || '',
        search: (searchInput?.value || '').trim()
    };
}
applyBtn?.addEventListener('click', () => { activeFilter = readFiltersFromForm(); renderOrders(); });
resetBtn?.addEventListener('click', () => { document.getElementById('ordersFilters')?.reset(); searchInput.value = ''; activeFilter = {}; renderOrders(); });

downloadCsvBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    const visible = ordersCache.map(normalizeOrder).filter(o => matchesFilters(o, activeFilter));
    if (!visible.length) { showToast('No hay datos para exportar.'); return; }
    const headers = ['id', 'clientName', 'productTitle', 'createdAt', 'total', 'paymentStatus', 'shippingStatus', 'vendedor', 'motorizado'];
    const rows = visible.map(o => headers.map(h => {
        if (h === 'createdAt') return formatDate(o._createdAt);
        if (h === 'vendedor') return (o._vendedorIds && o._vendedorIds.join(',')) || (o.vendedor || '');
        if (h === 'motorizado') return (o._motorizadoIds && o._motorizadoIds.join(',')) || (o.motorizado || '');
        const v = o[h] || o[h] === 0 ? o[h] : '';
        return String(v).replace(/,/g, '');
    }).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `orders_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
});

/* ---------- Init ---------- */
(async function init() {
    try {
        await loadActiveUsers();
        subscribeOrdersRealtime();
        setInterval(loadActiveUsers, 30000);
        showToast('Conectado a pedidos en tiempo real.');
    } catch (err) {
        console.error('Init error:', err);
        showToast('Error inicializando módulo de pedidos.', true);
    }
})();